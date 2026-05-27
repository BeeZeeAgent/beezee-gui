#!/usr/bin/env node
// Build fixtures/demo.sqlite from ~/.claude/projects/*.jsonl.
// Output is deterministic (seeded timestamps, sorted inserts) so the same source
// JSONL produces byte-identical DB output.
//
// Anonymisation: absolute paths -> /home/demo/..., emails redacted, API-key-looking
// strings redacted, real session IDs replaced with deterministic uuids per-conv.
//
// If ~/.claude/projects is missing or has no usable JSONL, the script still produces
// a valid DB using six synthesized reference conversations.

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { initSchema } from '../database-schema.js';
import { migrateFromJson, migrateToACP, migrateConversationColumns } from '../database-migrations.js';
import { migrateACPSchema, migrateBackfillMessages, migrateFTS, migrateAutoVacuum } from '../database-migrations-acp.js';

const require = createRequire(import.meta.url);

let Database;
try {
    Database = (await import('bun:sqlite')).default;
} catch {
    Database = require('better-sqlite3');
}

function openDb(path) {
    try {
        const db = new Database(path);
        db.run('PRAGMA journal_mode = WAL');
        db.run('PRAGMA foreign_keys = ON');
        return db;
    } catch {
        const db = new Database(path);
        db.pragma('journal_mode = WAL');
        db.pragma('foreign_keys = ON');
        return db;
    }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'fixtures');
const OUT_DB = path.join(OUT_DIR, 'data.db');
const SRC_DIR = path.join(os.homedir(), '.claude', 'projects');

// Fixed base timestamp so the DB is reproducible
const BASE_TS = Date.parse('2026-03-15T10:00:00Z');

// Titles we want in the demo sidebar
const DEMO_TITLES = [
    'Fix failing tests in db-queries',
    'Refactor auth middleware',
    'Add dark mode toggle',
    'Write migration for user schema',
    'Debug WebSocket reconnect loop',
    'Generate API docs from handlers',
];

function det(prefix, ...seeds) {
    const h = crypto.createHash('sha256').update(prefix + '::' + seeds.join('|')).digest('hex');
    return `${prefix}-${h.slice(0, 16)}`;
}

// Anonymise — returns cleaned text
function scrub(text) {
    if (typeof text !== 'string') return text;
    return text
        .replace(/\/(?:config|home|root|Users)\/[A-Za-z0-9_\-./]+/g, '/home/demo/workspace')
        .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, 'dev@example.com')
        .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-REDACTED')
        .replace(/ghp_[A-Za-z0-9]{20,}/g, 'ghp_REDACTED')
        .replace(/Bearer\s+[A-Za-z0-9._-]{20,}/gi, 'Bearer REDACTED');
}

// Synthesize a realistic assistant reply given a user prompt theme
function synthAssistant(title) {
    const lookup = {
        'Fix failing tests in db-queries':
            `I'll run the test suite first to see which specs are failing, then trace the errors.\n\n` +
            `After running \`bun test\`, I can see three assertions in \`createConversation\` are failing ` +
            `because the \`agentId\` column was renamed. I'll update the query builder in ` +
            `\`lib/db-queries.js\` to use the new column and patch the associated tests.\n\n` +
            `The fix is a one-line change to the INSERT statement. All 19 tests pass now.`,
        'Refactor auth middleware':
            `The current auth middleware has three responsibilities — rate limiting, basic-auth check, ` +
            `and CORS — packed into a single 80-line function. I'll split them into three small ` +
            `middlewares in \`lib/http-middlewares/\` and compose them in \`http-handler.js\`. ` +
            `No behaviour change, just readability.`,
        'Add dark mode toggle':
            `Dark mode is already wired through CSS custom properties in \`main.css\` (\`:root\` + \`html.dark\`). ` +
            `We just need a toggle button in the header and a listener that flips the class on \`<html>\` ` +
            `and persists the choice in \`localStorage\`. I'll also respect \`prefers-color-scheme\` for the ` +
            `first visit.`,
        'Write migration for user schema':
            `Adding \`last_login_at INTEGER\` and \`preferences JSON\` to the users table. I'll write the ` +
            `migration as \`database-migrations-user.js\`, gate it on a schema-version row, and backfill ` +
            `\`last_login_at\` from the \`sessions\` table's most-recent entry per user. Safe under concurrent writes.`,
        'Debug WebSocket reconnect loop':
            `Found it. The ws-machine transitions to \`reconnecting\` on \`close\`, but the timer was never ` +
            `cleared when a message arrived mid-wait, so two sockets were briefly open. I added a guard in ` +
            `\`static/js/ws-machine.js\` and the duplicate connection disappears.`,
        'Generate API docs from handlers':
            `Scanning \`lib/routes-*.js\` for \`router.handle\` / \`app.<method>\` declarations and producing a ` +
            `markdown doc grouped by module. Output goes to \`docs/api.md\`. I'll add a JSDoc-style comment ` +
            `parser so handler descriptions can live inline with the route.`,
    };
    return lookup[title] || 'Done — see the diff for details.';
}

function synthUser(title) {
    const lookup = {
        'Fix failing tests in db-queries':
            'Hey — the test suite has been flaky since yesterday. Can you figure out which specs are failing and fix them? Start with `bun test` and work from there.',
        'Refactor auth middleware':
            `The auth middleware in lib/http-handler.js has grown into a monster. Please split it into single-responsibility pieces.`,
        'Add dark mode toggle':
            `Can we add a theme toggle button in the header? It should remember the user's choice and default to the system preference.`,
        'Write migration for user schema':
            `Add last_login_at and a preferences JSON column to the users table. Include a backfill for existing rows.`,
        'Debug WebSocket reconnect loop':
            `Clients are getting stuck in a reconnect loop — the network tab shows two sockets opening before one closes. Can you trace it in ws-machine and fix?`,
        'Generate API docs from handlers':
            `We need API docs. Generate them from the route handler declarations and dump to docs/api.md.`,
    };
    return lookup[title] || 'Please take a look.';
}

// If we can harvest a user message that looks natural from real JSONL, use it,
// otherwise fall back to the synthesized one.
function harvestPrompts() {
    const pool = [];
    if (!fs.existsSync(SRC_DIR)) return pool;
    try {
        for (const projDir of fs.readdirSync(SRC_DIR)) {
            const full = path.join(SRC_DIR, projDir);
            if (!fs.statSync(full).isDirectory()) continue;
            for (const f of fs.readdirSync(full)) {
                if (!f.endsWith('.jsonl')) continue;
                const lines = fs.readFileSync(path.join(full, f), 'utf8').split('\n').filter(Boolean);
                for (const l of lines) {
                    try {
                        const e = JSON.parse(l);
                        if (e.type !== 'user') continue;
                        const msg = e.message?.content;
                        if (!msg) continue;
                        const text = Array.isArray(msg)
                            ? msg.find(c => c.type === 'text')?.text
                            : typeof msg === 'string' ? msg : null;
                        if (!text) continue;
                        // Keep only naturally-phrased (no tool_use_id etc.) prompts, 40-400 chars
                        if (text.length < 40 || text.length > 400) continue;
                        if (/tool_use|tool_result|<function_calls/.test(text)) continue;
                        pool.push(scrub(text));
                        if (pool.length > 50) return pool;
                    } catch {}
                }
            }
        }
    } catch {}
    return pool;
}

function build() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    if (fs.existsSync(OUT_DB)) fs.unlinkSync(OUT_DB);

    const db = openDb(OUT_DB);

    // Use the real schema pipeline — same as database.js — so fixture DB always matches production.
    initSchema(db);
    migrateFromJson(db, path.join(OUT_DIR, 'nonexistent.json'));
    migrateToACP(db);
    migrateConversationColumns(db);
    migrateACPSchema(db);
    migrateBackfillMessages(db);
    migrateFTS(db);
    migrateAutoVacuum(db);

    const insConv = db.prepare(`INSERT INTO conversations (id, agentId, agentType, title, created_at, updated_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const insMsg = db.prepare(`INSERT INTO messages (id, conversationId, role, content, created_at)
        VALUES (?, ?, ?, ?, ?)`);
    const insSess = db.prepare(`INSERT INTO sessions (id, conversationId, status, started_at, completed_at, response, error)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);

    const realPrompts = harvestPrompts();
    const tx = db.transaction(() => {
        DEMO_TITLES.forEach((title, idx) => {
            const convId = det('conv', title);
            const ts = BASE_TS - idx * 3600 * 1000;            // newest first
            insConv.run(convId, 'claude-code', 'direct', title, ts, ts, 'active');

            const userText = realPrompts[idx] || synthUser(title);
            const assistantText = synthAssistant(title);
            const userMsgId = det('msg', convId, 'user');
            const asstMsgId = det('msg', convId, 'asst');
            const sessId = det('sess', convId);

            insMsg.run(userMsgId, convId, 'user', userText, ts);
            insSess.run(sessId, convId, 'completed', ts + 1000, ts + 12000, assistantText, null);
            insMsg.run(asstMsgId, convId, 'assistant', assistantText, ts + 12000);
        });
    });
    tx();

    const count = db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n;
    const msgCount = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    db.close();
    const sz = fs.statSync(OUT_DB).size;
    console.log(`[harvest] wrote ${OUT_DB} (${(sz/1024).toFixed(1)}KB, ${count} conversations, ${msgCount} messages)`);
    console.log(`[harvest] harvested ${realPrompts.length} real prompt(s) from ${SRC_DIR}`);
}

build();
