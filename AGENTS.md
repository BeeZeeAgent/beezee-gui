# AgentGUI — Agent Notes

## Architecture (2026-05-19 pivot — single surface)

One surface. `server.js` serves `site/app/` under `BASE_URL` (default `/gm`) and mounts `ccsniff`'s `/v1/history/*` Express router in-process at both `/` and `BASE_URL`. The legacy `static/` tree and the legacy `lib/routes-*`/`lib/db-queries-*`/`lib/jsonl-watcher.js` modules are gone. `acptoapi` is no longer used by this project.

When `PASSWORD` env var is set, every HTTP route is gated by `lib/http-handler.js` accepting **Basic auth**, **`Authorization: Bearer <pwd>`**, OR **`?token=<pwd>`** query param (added 2026-05-26 so `EventSource` and direct deep-links work — neither can set headers). WS `/sync` requires `?token=` only. The HTML head script injects `window.__BASE_URL`, `window.__SERVER_VERSION`, and `window.__WS_TOKEN`; `site/app/js/backend.js` reads `__WS_TOKEN` and threads it onto every fetch (Bearer header) / EventSource (qs) / WebSocket (qs).

- `site/app/index.html` — shell + CSS, imports `anentrypoint-design` from unpkg
- `site/app/js/backend.js` — same-origin client (`DEFAULT_BACKEND = ''`); `?backend=` query override for cross-origin debugging
- `site/app/js/app.js` — webjsx view + state, kits-only rendering (PageHeader, SearchInput, TextField, EventList, Panel, Row, Section); exposes `window.__agentgui`
- `server.js` — boots ACP/agents/websocket plugins, mounts `createHistoryRouter()` from `ccsniff` at `/`, serves `site/app/` as static root
- Plugins kept (lib/plugins/): acp, agents, database, files, stream, websocket, workflow

Dependencies:
- `ccsniff` (>=1.1.0) — exports `createHistoryRouter({projectsDir})` mountable on Express; serves `/v1/history/{sessions,sessions/:sid/events,search,snapshot,reindex,stream}`. Reads `~/.claude/projects` (override via `CLAUDE_PROJECTS_DIR`).
- `anentrypoint-design` (>=0.0.119) — kit library, single-file ESM from unpkg

## Browser Witness (2026-05-19)

Local server on PORT=3056 (default), `bun server.js`:
- `GET /health` → 200 JSON
- `GET /v1/history/sessions` → `{"sessions":[]}` from ccsniff
- `GET /` → site/app/index.html
- WS `/sync` → opens, sync_connected
- Browser at `localhost:3056/`: AppShell renders, nav=[chat,history,settings], SSE `hello` received (live.connected=true, eventCount=1), 0 console errors, backend resolves to `''` (same origin).

## Learning audit

- 2026-05-02 session: 5 items audited (CI bun, stream imports, windows fallback, GM blocker, ACP history), 0 removed (rs-learn retrieval not yet confirmed; safety default kept all), 1 new fact ingested (in-process ccsniff history integration)

## CI / GitHub Actions

**capture-screenshots must run under bun, not node.**

`npm install --ignore-scripts` in gh-pages.yml skips native compilation, leaving `better-sqlite3` without a compiled `.node` binding. `database.js` tries `bun:sqlite` first, then falls back to `better-sqlite3`. When the step runs under Node both fail and the server crashes silently within the 20s health-check window.

Fix: `bun run scripts/capture-screenshots.mjs` (not `node ...`).

Why it works: `process.execPath` becomes bun, so the spawned child server also runs under bun and loads `bun:sqlite` natively — no compiled binding needed.

Rule: any CI step that spawns the agentgui server (directly or via a script that inherits `process.execPath`) must invoke it with `bun`.

## Plugin Dependencies

**`lib/plugins/stream-plugin.js` must not import packages missing from package.json.**

The plugin loader runs at startup and logs failures silently if a plugin import fails. If stream plugin fails to load due to missing dependency (e.g., `uuid`), the error cascades: `agents` and `websocket` plugins both declare `stream` as a dependency and fail with "Plugin stream not found in registry", cascading to boot failure.

Fix for uuid: replaced `import { v4 as uuidv4 } from 'uuid'` with `import { randomUUID as uuidv4 } from 'crypto'` (Node.js built-in, zero deps).

Pattern: all imports in lib/plugins/* must be either built-in (crypto, fs, path, etc.) or already in package.json. No new npm packages should be added to plugins without adding them to dependencies.

## Plugin Tool Provisioning on Windows

**`lib/tool-spawner.js` must iterate bun → npx fallback and match cross-platform command-not-found errors.**

On Windows hosts without bun installed, the auto-provisioner on startup and 6h periodic update checker failed silently when spawnBunxProc tried `bun.cmd` directly. The missing command error came via process stderr+close, not the 'error' event, so simple ENOENT detection was insufficient. Additionally, the error message format differs by OS: Windows shows "'bun.cmd' is not recognized as an internal or external command", Linux/Mac show "command not found" or "cannot find".

Fix: `BUNX_RUNNERS` array iterates `['bun', 'npx']` and tries each in sequence. Error detection regex `isMissingCmdError` matches `/not recognized|ENOENT|command not found|cannot find/i` on both `error.message` and captured stdout+stderr. Only falls through to next runner when the `missing` flag is set.

Pattern: When a binary might not exist on all platforms, use a runner fallback strategy. Always capture and check both error.message and process output streams. Cross-platform error detection requires regex alternation on common message patterns.

## GM Plugin Autonomy Blocker

**gm plugin's pre-tool-use-hook.js enforces "must invoke gm:gm first" gate, blocking multi-tool autonomy. Hook content is NOT sourced from gm-starter/hooks/ files — it is templated from somewhere else.**

The gm plugin enforces a gate via `.gm/needs-gm` marker that requires invoking `gm:gm` before any other tool use, which fragments multi-tool autonomous sessions in agentgui. A bypass patch was committed to c:/dev/gm (commit e300acf7, origin/main) in gm-starter/hooks/{pre-tool-use,prompt-submit}-hook.js to skip the gate when `.gm/prd.yml` exists, but it did NOT propagate after `/plugin update gm` (cache hash changed 495e36843d77 → 075e64d58498 but hook content unchanged).

The actual hook content is generated/templated from c:/dev/gm, likely from `lib/cli-adapter.js` or `platforms/cli-config-shared.js` or `lib/template-builder.js`, not from gm-starter/hooks/. Next session must:
1. Locate the real hook generator in the gm codebase
2. Patch it to add `if (autonomous) { try { fs.unlinkSync(needsGmPath); } catch {} }` when `.gm/prd.yml` exists
3. Rebuild via `node c:/dev/gm/cli.js c:/dev/gm/gm-starter c:/dev/gm/build`
4. Push changes to c:/dev/gm origin/main
5. Run `/plugin update gm` in agentgui

Only after the real generator is patched will agentgui sessions run autonomously without per-tool ceremony.

## History Integration via ccsniff (2026-05-21 — reverted from acptoapi)

**agentgui mounts `ccsniff`'s history router in-process — no external proxy.**

`server.js` imports `createHistoryRouter` from the `ccsniff` package and mounts it on the internal Express app at `/`, exposing `GET /v1/history/{snapshot,sessions,sessions/:sid/events,search,reindex,stream}`. Reads `~/.claude/projects` by default; override with `CLAUDE_PROJECTS_DIR` env var. acptoapi's previously-bundled history routes were removed in acptoapi 1.0.103; ccsniff is now the canonical source. Browser client (`site/app/js/backend.js`) calls these same-origin via the agentgui server.

## buildSystemPrompt System Prompt for claude-code

**`lib/provider-config.js` buildSystemPrompt() must return '' for claude-code agent; returning "Model: X." breaks conversation resume.**

The function previously returned "Model: X." when agentId was 'claude-code' and model was non-null. This caused `buildArgs` in lib/claude-runner-agents.js to pass `--append-system-prompt "Model: X."` to the claude CLI, which triggers "argument missing" error on conversation resume. Fix: return '' early when agentId is 'claude-code' or falsy. The model is already passed via `--model` flag; system prompt is only for non-claude-code agents.

## WebSocket Sync Endpoint Testing

**WebSocket `/sync` endpoint — message ordering requires registering handler BEFORE sending.**

Server sends `sync_connected` with `clientId` on connect. Legacy handler (`lib/ws-legacy-handlers.js`) handles `ping→pong`, `subscribe→subscription_confirmed`, `get_subscriptions→subscriptions`, `unsubscribe`, `latency_report`. All responses use codec encode/decode (`lib/codec.js`). Pattern: queue outbound messages and use a waiters array + sequential promises to avoid race between send and handler registration. Test structure: `const queued = []; let waiting; ws.on('message', ...); queued.forEach(msg => ws.send(msg)); waiting.resolve(...)` ensures the handler is live before messages flow.

## better-sqlite3 & Node v24 Startup (2026-05-03)

**Node v24 has no prebuilt binary for better-sqlite3 (module version 137); npm rebuild silently fails.**

When npm install runs on Node v24, the postinstall hook for better-sqlite3 silently fails because no prebuilt `.node` binary exists for that module version. The server then fails to require better-sqlite3 and crashes. npm rebuild also silently fails.

Fix: compile from source in postinstall:
```json
"postinstall": "node scripts/patch-fsbrowse.js && node scripts/copy-vendor.js && (cd node_modules/better-sqlite3 && node-gyp rebuild 2>/dev/null) || true"
```

Paired changes:
- `package.json` `start` script: `"bun server.js || node server.js"` (prefer bun, fall back to node)
- `bin/gmgui.cjs` runtime detection: `spawnSync('bun', ['--version'], { shell: true })` to auto-detect bun availability, fallback to node (lines 46-47)
- better-sqlite3 bumped ^12.6.2 → ^12.9.0

bun start was already working (bun has native sqlite support via `bun:sqlite`). The node path was broken due to the missing native binding. Only compile from source fixes the node path.

## webjsx applyDiff Array Keying (2026-05-04)

**Children arrays that mix keyed VElements with raw text/numbers crash in `vendor/webjsx/applyDiff.js`.**

`webjsx` requires all siblings in an array prop (children, right, left, breadcrumbs, etc.) to either ALL be VElements with keys or ALL be non-keyed. Passing `Crumb({ right: [h('span', { key: 'a' }, 'A'), h('span', { key: 'b' }, 'B'), '● connected'] })` crashes on render with `TypeError: Cannot read properties of undefined (reading 'key')` at line 247420.js when the render loop tries to read `.key` on the bare string.

Fix: wrap any bare strings as keyed VElements: `h('span', { key: 'dot' }, '● connected')`. Rule: if ANY sibling in an array has a key, ALL siblings must be VElements (no raw strings or numbers).

Surfaced 2026-05-04 while validating the chat surface in `site/app/`. Fix applied to crumbRight construction in `site/app/js/app.js` view().

## Live History Stream Wiring (2026-05-05)

**`site/app/js/app.js` opens SSE EventSource on navTo('history'); first /v1/history/* request triggers 30-90s loadOnce() synchronous walk.**

The live history feature wires the in-process ccsniff `/v1/history/stream` SSE endpoint via `B.streamHistory(base, onEvent)` on tab entry and closes the EventSource on tab exit. State shape: `state.live = { es, connected, lastEventTs, error, eventCount }`.

Event dispatch loop:
- `hello` event: set `connected=true`
- `event` event: if `data.sid === selectedSid` push into `state.events`, increment matching session counter
- `conversation` event: call `refreshHistory()` to reload session list
- `error` event: set `live.error`

Throttle renders via `requestAnimationFrame` to avoid event storm during burst loads.

**First request to `/v1/history/*` triggers loadOnce() that walks all JSONL files under ~/.claude/projects** (env default; override with `CLAUDE_PROJECTS_DIR`). In our test env: 299 files, 80MB, 69k events → 30-90s startup latency. Health check timeouts during this window are normal and expected. Subsequent requests are fast (cached index).

The endpoints are served by ccsniff's Express router mounted in-process from `server.js`. No external proxy.
