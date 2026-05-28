import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execSync, spawnSync } from 'child_process';
import { runClaudeWithStreaming } from './claude-runner-run.js';
import { registry } from './claude-runner-agents.js';
import * as sessionReaders from './session-readers/index.js';
import * as claudeCodeReader from './session-readers/claude-code.js';

function err(code, message) { const e = new Error(message); e.code = code; throw e; }

const SUB_AGENT_MAP = {
  'opencode': [{ id: 'gm-oc', name: 'GM OpenCode' }], 'cli-opencode': [{ id: 'gm-oc', name: 'GM OpenCode' }],
  'gemini': [{ id: 'gm-gc', name: 'GM Gemini' }], 'cli-gemini': [{ id: 'gm-gc', name: 'GM Gemini' }],
  'kilo': [{ id: 'gm-kilo', name: 'GM Kilo' }], 'cli-kilo': [{ id: 'gm-kilo', name: 'GM Kilo' }],
  'codex': []
};

export function register(router, deps) {
  const { queries, wsOptimizer, broadcastSync, getProviderConfigs, saveProviderConfig, STARTUP_CWD, discoveredAgents, subscriptionIndex, activeChats } = deps;

  // --- agents.list: enumerate registered ACP agents + claude-code ---
  router.handle('agents.list', () => {
    const agents = registry.list().map(a => ({
      id: a.id,
      name: a.name,
      protocol: a.protocol,
      supportsStdin: !!a.supportsStdin,
      features: a.supportedFeatures || [],
    }));
    return { agents };
  });

  // --- conversation.subscribe: register this ws for sessionId broadcasts ---
  router.handle('conversation.subscribe', (p, ws) => {
    const sid = p?.sessionId;
    if (!sid || typeof sid !== 'string') err(400, 'sessionId required');
    if (!subscriptionIndex.has(sid)) subscriptionIndex.set(sid, new Set());
    subscriptionIndex.get(sid).add(ws);
    ws.subscriptions = ws.subscriptions || new Set();
    ws.subscriptions.add(sid);
    return { subscribed: true, sessionId: sid };
  });

  // --- chat.sendMessage: start a one-shot streaming chat with an agent.
  // Bypasses the gutted db-queries layer entirely; calls runClaudeWithStreaming
  // directly and broadcasts streaming_* events scoped to an ephemeral sessionId.
  router.handle('chat.sendMessage', async (p, ws) => {
    const content = (p?.content || '').toString();
    if (!content) err(400, 'content required');
    const agentId = p?.agentId || 'claude-code';
    const model = p?.model || undefined;
    const subAgent = p?.subAgent || undefined;
    const requestedCwd = p?.cwd || STARTUP_CWD;
    const cwd = path.resolve(String(requestedCwd).replace(/^~(?=$|\/)/, os.homedir()));
    try {
      const st = fs.statSync(cwd);
      if (!st.isDirectory()) err(400, `cwd is not a directory: ${cwd}`);
    } catch (e) {
      err(400, `cwd is not accessible: ${cwd}`);
    }
    const resumeSessionId = p?.resumeSid || p?.resumeSessionId || undefined;
    if (!registry.has(agentId)) err(404, `Unknown agentId: ${agentId}`);

    const sessionId = 'chat-' + crypto.randomBytes(8).toString('hex');
    // Auto-subscribe the originating ws so it receives its own broadcasts.
    if (!subscriptionIndex.has(sessionId)) subscriptionIndex.set(sessionId, new Set());
    subscriptionIndex.get(sessionId).add(ws);
    ws.subscriptions = ws.subscriptions || new Set();
    ws.subscriptions.add(sessionId);

    const ctrl = { aborted: false, proc: null };
    activeChats.set(sessionId, ctrl);

    // Fire-and-forget after the response is sent, giving clients time to attach
    // their session listener before fast agents emit output.
    const startChat = async () => {
      let eventCount = 0;
      broadcastSync({ type: 'streaming_start', sessionId, agentId, timestamp: Date.now() });
      const onEvent = (parsed) => {
        eventCount++;
        if (parsed?.type === 'assistant' && parsed.message?.content) {
          for (const block of parsed.message.content) {
            broadcastSync({ type: 'streaming_progress', sessionId, block, blockRole: 'assistant', seq: eventCount, timestamp: Date.now() });
          }
        } else if (parsed?.type === 'user' && parsed.message?.content) {
          const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];
          for (const block of blocks) {
            if (block?.type === 'tool_result') {
              broadcastSync({ type: 'streaming_progress', sessionId, block, blockRole: 'tool_result', seq: eventCount, timestamp: Date.now() });
            }
          }
        } else if (parsed?.type === 'result') {
          const block = { type: 'result', result: parsed.result, subtype: parsed.subtype, duration_ms: parsed.duration_ms, total_cost_usd: parsed.total_cost_usd, is_error: !!parsed.is_error, errors: parsed.errors || [] };
          broadcastSync({ type: 'streaming_progress', sessionId, block, blockRole: 'result', seq: eventCount, isResult: true, timestamp: Date.now() });
          if (parsed.is_error) broadcastSync({ type: 'streaming_error', sessionId, agentId, error: (parsed.errors?.[0]) || parsed.subtype || 'agent error', timestamp: Date.now() });
        } else if (parsed?.type === 'available_commands') {
          const block = { type: 'available_commands', commands: parsed.commands || [] };
          broadcastSync({ type: 'streaming_progress', sessionId, block, blockRole: 'system', seq: eventCount, timestamp: Date.now() });
        }
      };
      try {
        const config = {
          verbose: true, outputFormat: 'stream-json', timeout: 1800000, print: true,
          model, subAgent, onEvent, resumeSessionId,
          onPid: () => {}, onProcess: (proc) => { ctrl.proc = proc; },
        };
        await runClaudeWithStreaming(content, cwd, agentId, config);
        broadcastSync({ type: 'streaming_complete', sessionId, agentId, eventCount, timestamp: Date.now() });
      } catch (e) {
        broadcastSync({ type: 'streaming_error', sessionId, agentId, error: e.message || String(e), recoverable: false, timestamp: Date.now() });
      } finally {
        activeChats.delete(sessionId);
      }
    };
    setTimeout(() => { startChat().catch(() => {}); }, 0);

    return { sessionId, started: true };
  });

  // --- chat.cancel: abort an in-flight chat ---
  router.handle('chat.cancel', (p) => {
    const sid = p?.sessionId;
    if (!sid) err(400, 'sessionId required');
    const ctrl = activeChats.get(sid);
    if (!ctrl) return { cancelled: false, reason: 'not-found' };
    ctrl.aborted = true;
    try { ctrl.proc?.kill?.(); } catch {}
    activeChats.delete(sid);
    return { cancelled: true };
  });



  router.handle('home', () => ({ home: os.homedir(), cwd: STARTUP_CWD }));

  router.handle('folders', (p) => {
    const folderPath = p.path || STARTUP_CWD;
    try {
      const raw = folderPath.startsWith('~') ? folderPath.replace('~', os.homedir()) : folderPath;
      const entries = fs.readdirSync(path.resolve(raw), { withFileTypes: true });
      return { folders: entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ name: e.name })).sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (e) { err(400, e.message); }
  });

  router.handle('history.sessionsForCwd', (p) => {
    if (!p?.cwd) err(400, 'cwd required');
    const cwd = path.resolve(String(p.cwd).replace(/^~(?=$|\/)/, os.homedir()));
    const sessions = claudeCodeReader.listSessionsForCwd(cwd);
    return { cwd, sessions };
  });

  router.handle('history.sessionEventsForCwd', (p) => {
    if (!p?.sid) err(400, 'sid required');
    if (!p?.cwd) err(400, 'cwd required');
    const cwd = path.resolve(String(p.cwd).replace(/^~(?=$|\/)/, os.homedir()));
    const events = claudeCodeReader.getSessionEvents(p.sid, cwd);
    return { sid: p.sid, cwd, events };
  });

  // Multi-agent session readers (codex, opencode, pi-agent, ...)
  router.handle('history.agents', () => {
    return { agents: sessionReaders.knownAgents() };
  });

  router.handle('history.agentSessions', () => {
    return { sessions: sessionReaders.listAllSessions() };
  });

  router.handle('history.agentSessionEvents', (p) => {
    if (!p?.sid) err(400, 'sid required');
    return { sid: p.sid, events: sessionReaders.getSessionEvents(p.sid) };
  });

  router.handle('clone', (p) => {
    const repo = (p.repo || '').trim();
    if (!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
      err(400, 'Invalid repo format. Use org/repo or user/repo');
    }
    const cloneDir = STARTUP_CWD || os.homedir();
    const repoName = repo.split('/')[1];
    const targetPath = path.join(cloneDir, repoName);
    if (fs.existsSync(targetPath)) err(409, `Directory already exists: ${repoName}`);
    try {
      const isWindows = os.platform() === 'win32';
      execSync('git clone https://github.com/' + repo + '.git', {
        cwd: cloneDir, encoding: 'utf-8', timeout: 120000,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        shell: isWindows
      });
      return { ok: true, repo, path: targetPath, name: repoName };
    } catch (e) { err(500, (e.stderr || e.message || 'Clone failed').trim()); }
  });

  router.handle('git.check', () => {
    try {
      const isWindows = os.platform() === 'win32';
      const devnull = isWindows ? '' : ' 2>/dev/null';
      const remoteUrl = execSync('git remote get-url origin' + devnull, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows }).trim();
      const statusResult = execSync('git status --porcelain' + devnull, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
      const hasChanges = statusResult.trim().length > 0;
      const unpushedResult = execSync('git rev-list --count --not --remotes' + devnull, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
      const hasUnpushed = parseInt(unpushedResult.trim() || '0', 10) > 0;
      const githubUser = process.env.GITHUB_USER;
      const ownsRemote = !remoteUrl.includes('github.com/') || (!!githubUser && remoteUrl.includes(githubUser));
      return { ownsRemote, hasChanges, hasUnpushed, remoteUrl };
    } catch {
      return { ownsRemote: false, hasChanges: false, hasUnpushed: false, remoteUrl: '' };
    }
  });

  router.handle('git.push', () => {
    try {
      const isWindows = os.platform() === 'win32';
      const cmd = isWindows
        ? 'git add -A & git commit -m "Auto-commit" & git push'
        : 'git add -A && git commit -m "Auto-commit" && git push';
      execSync(cmd, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
      return { success: true };
    } catch (e) { err(500, e.message); }
  });

  router.handle('auth.configs', () => getProviderConfigs());

  router.handle('auth.save', (p) => {
    const { providerId, apiKey, defaultModel } = p;
    if (typeof providerId !== 'string' || !providerId.length || providerId.length > 100) err(400, 'Invalid providerId');
    if (typeof apiKey !== 'string' || !apiKey.length || apiKey.length > 10000) err(400, 'Invalid apiKey');
    if (defaultModel !== undefined && (typeof defaultModel !== 'string' || defaultModel.length > 200)) err(400, 'Invalid defaultModel');
    const configPath = saveProviderConfig(providerId, apiKey, defaultModel || '');
    return { success: true, path: configPath };
  });

  router.handle('import.claude', () => ({ imported: queries.importClaudeCodeConversations() }));

  router.handle('discover.claude', () => ({ discovered: queries.discoverClaudeCodeConversations() }));

  router.handle('ws.stats', () => wsOptimizer.getStats());

  router.handle('agent.subagents', async (p) => {
    if (!p.id) err(400, 'Missing agent id');
    if (p.id === 'claude-code' || p.id === 'cli-claude') {
      const spawnEnv = { ...process.env }; delete spawnEnv.CLAUDECODE;
      const result = spawnSync('claude', ['agents', 'list'], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });
      if (result.status !== 0 || !result.stdout) return { subAgents: [] };
      const agents = result.stdout.trim().split('\n').filter(l => l.trim()).map(l => l.match(/^  (\S+)\s+·/)).filter(Boolean).map(m => ({ id: m[1], name: m[1] }));
      return { subAgents: agents };
    }
    return { subAgents: SUB_AGENT_MAP[p.id] || [] };
  });
}
