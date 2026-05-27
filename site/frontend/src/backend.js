// agentgui backend client. Same-origin by default. Talks to:
//  - HTTP: /health, /v1/history/* (served by ccsniff)
//  - WS  : /sync   (JSON envelope: requests {m, r, p}; replies {r, d|e};
//          broadcasts {type, sessionId, ...})
// No external acptoapi dependency. Chat + agent listing flow over the WS.

import { encode, decode } from './codec.js';

const KEY = 'agentgui.backend';
const DEFAULT_BACKEND = '';

function authToken() {
  try { return (typeof window !== 'undefined' && window.__WS_TOKEN) || ''; } catch { return ''; }
}

function authedFetch(url, opts = {}) {
  const tok = authToken();
  if (!tok) return fetch(url, opts);
  const h = new Headers(opts.headers || {});
  h.set('Authorization', 'Bearer ' + tok);
  return fetch(url, { ...opts, headers: h });
}

function withToken(url) {
  const tok = authToken();
  if (!tok) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok);
}

export function getBackend() {
  const u = new URL(location.href);
  const fromQs = u.searchParams.get('backend');
  if (fromQs) { localStorage.setItem(KEY, fromQs); return fromQs; }
  return localStorage.getItem(KEY) || DEFAULT_BACKEND;
}

export function setBackend(url) { localStorage.setItem(KEY, url); }

export async function probeBackend(base) {
  try {
    const r = await authedFetch(base + '/health', { method: 'GET' });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, info: await r.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- History (HTTP, served by ccsniff) ----------

export async function listSessions(base) {
  const r = await authedFetch(base + '/v1/history/sessions');
  if (!r.ok) throw new Error('sessions: ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.sessions || []);
}

export async function getSessionEvents(base, sid) {
  const r = await authedFetch(base + '/v1/history/sessions/' + encodeURIComponent(sid) + '/events');
  if (!r.ok) throw new Error('events: ' + r.status);
  const j = await r.json();
  return j.events || [];
}

export async function searchHistory(base, q, limit = 50) {
  const r = await authedFetch(base + '/v1/history/search?q=' + encodeURIComponent(q) + '&limit=' + limit);
  if (!r.ok) throw new Error('search: ' + r.status);
  return r.json();
}

export function streamHistory(base, onEvent) {
  const es = new EventSource(withToken(base + '/v1/history/stream'));
  for (const k of ['hello', 'event', 'error', 'start', 'complete', 'conversation']) {
    es.addEventListener(k, ev => {
      let data; try { data = JSON.parse(ev.data); } catch { data = null; }
      onEvent(k, data);
    });
  }
  return es;
}

// ---------- WebSocket client (/sync) ----------

const SYNC_PATH = '/sync';
let _ws = null;
let _wsReady = null;       // Promise that resolves when ws is OPEN
let _nextReqId = 1;
const _pending = new Map();          // requestId → { resolve, reject }
const _sessionListeners = new Map(); // sessionId → Set<(event)=>void>
const _statusListeners = new Set();  // fn(state) where state in 'open'|'closed'|'error'|'reconnecting'
let _reconnectAttempts = 0;
let _reconnectTimer = null;
let _wsBaseHint = '';                 // base remembered for reconnect

export function onWsStatus(fn) { _statusListeners.add(fn); return () => _statusListeners.delete(fn); }
function emitStatus(s) { for (const fn of _statusListeners) { try { fn(s); } catch {} } }

function scheduleReconnect() {
  if (_reconnectTimer) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // Wait for online before retrying.
    const onOnline = () => { window.removeEventListener('online', onOnline); _reconnectAttempts = 0; ensureWs(_wsBaseHint).catch(() => {}); };
    window.addEventListener('online', onOnline);
    return;
  }
  const delay = Math.min(30000, 500 * Math.pow(2, _reconnectAttempts));
  _reconnectAttempts++;
  emitStatus('reconnecting');
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    ensureWs(_wsBaseHint).catch(() => {});
  }, delay);
}

function wsUrl(base) {
  let proto, host;
  if (base) {
    try {
      const u = new URL(base);
      proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      host = u.host;
    } catch {}
  }
  if (!host) {
    proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    host = location.host;
  }
  const tok = authToken();
  return proto + '//' + host + SYNC_PATH + (tok ? '?token=' + encodeURIComponent(tok) : '');
}

function ensureWs(base) {
  _wsBaseHint = base || _wsBaseHint;
  if (_ws && _ws.readyState === 1) return _wsReady;
  if (_ws && _ws.readyState === 0) return _wsReady;
  _ws = new WebSocket(wsUrl(_wsBaseHint));
  _wsReady = new Promise((resolve, reject) => {
    _ws.addEventListener('open', () => {
      _reconnectAttempts = 0;
      emitStatus('open');
      // Re-subscribe any session listeners that survived the disconnect.
      for (const sid of _sessionListeners.keys()) {
        try { _ws.send(encode({ m: 'conversation.subscribe', r: _nextReqId++, p: { sessionId: sid } })); } catch {}
      }
      resolve(_ws);
    });
    _ws.addEventListener('error', (e) => { emitStatus('error'); reject(e); });
    _ws.addEventListener('close', () => {
      emitStatus('closed');
      for (const [, p] of _pending) p.reject(new Error('ws closed'));
      _pending.clear();
      _ws = null;
      _wsReady = null;
      // Auto-reconnect if there are listeners or callers will retry.
      if (_sessionListeners.size > 0 || _statusListeners.size > 0) scheduleReconnect();
    });
    _ws.addEventListener('message', (ev) => {
      let msg;
      try {
        // Server sends text frames (JSON via codec). ev.data is string.
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : decode(ev.data);
      } catch { return; }
      // Reply to a prior request?
      if (msg && msg.r !== undefined && (msg.d !== undefined || msg.e !== undefined)) {
        const p = _pending.get(msg.r);
        if (!p) return;
        _pending.delete(msg.r);
        if (msg.e) p.reject(new Error(msg.e.m || ('ws error ' + msg.e.c)));
        else p.resolve(msg.d);
        return;
      }
      // Unsolicited broadcast — route by sessionId to subscribers.
      // Server may send a single event or a batch (array) per ws-optimizer.
      const items = Array.isArray(msg) ? msg : [msg];
      for (const item of items) {
        const sid = item?.sessionId;
        if (!sid) continue;
        const subs = _sessionListeners.get(sid);
        if (!subs) continue;
        for (const fn of subs) { try { fn(item); } catch {} }
      }
    });
  });
  return _wsReady;
}

function wsCall(base, method, params) {
  return ensureWs(base).then(() => new Promise((resolve, reject) => {
    const r = _nextReqId++;
    _pending.set(r, { resolve, reject });
    _ws.send(encode({ m: method, r, p: params || {} }));
  }));
}

function addSessionListener(sessionId, fn) {
  if (!_sessionListeners.has(sessionId)) _sessionListeners.set(sessionId, new Set());
  _sessionListeners.get(sessionId).add(fn);
  return () => {
    const s = _sessionListeners.get(sessionId);
    if (s) { s.delete(fn); if (s.size === 0) _sessionListeners.delete(sessionId); }
  };
}

// ---------- Agents / models (WS) ----------

export async function listModels(base) {
  const { agents } = await wsCall(base, 'agents.list', {});
  // Compatibility shape: app.js expects an array of {id, name?, ...}
  return agents || [];
}

export async function listHistoryAgents(base) {
  const { agents } = await wsCall(base, 'history.agents', {});
  return agents || [];
}

export async function listAgentSessions(base) {
  const { sessions } = await wsCall(base, 'history.agentSessions', {});
  return sessions || [];
}

export async function getAgentSessionEvents(base, sid) {
  const { events } = await wsCall(base, 'history.agentSessionEvents', { sid });
  return events || [];
}

export async function getHome(base) {
  return wsCall(base, 'home', {});
}

export async function listFolders(base, path) {
  return wsCall(base, 'folders', { path });
}

export async function listSessionsForCwd(base, cwd) {
  const { sessions } = await wsCall(base, 'history.sessionsForCwd', { cwd });
  return sessions || [];
}

export async function getSessionEventsForCwd(base, sid, cwd) {
  const { events } = await wsCall(base, 'history.sessionEventsForCwd', { sid, cwd });
  return events || [];
}

// ---------- Streaming chat (WS) ----------
//
// Yields events of shape:
//   { type: 'text',  text: '...' }    — assistant text deltas
//   { type: 'tool',  block: {...} }   — tool_use blocks
//   { type: 'result', block: {...} }  — terminal result block
//   { type: 'error', error: '...' }
//
// Caller signature kept compatible with the previous HTTP/SSE impl.
export async function* streamChat(base, { model, messages, signal, agentId, resumeSid, cwd }) {
  // The last user message is the prompt; agentgui's claude-runner doesn't
  // accept a full message list — it spawns the agent for a single prompt.
  // For multi-turn, the agent's own session/resume handles continuity.
  const last = messages[messages.length - 1];
  const content = last?.content || '';
  if (!content) return;

  // app.js treats the "model" picker as the agent picker (selects from
  // agents.list ids). If no explicit agentId is given, model IS the agent.
  // If `model` looks like a real model id (has a slash), keep it as model
  // and default agent to claude-code.
  let resolvedAgentId = agentId;
  let resolvedModel = model;
  if (!resolvedAgentId) {
    if (!model || /^[a-z][a-z0-9-]*$/.test(model)) {
      // Bare slug — treat as agentId.
      resolvedAgentId = model || 'claude-code';
      resolvedModel = undefined;
    } else {
      resolvedAgentId = 'claude-code';
    }
  }

  // Queue events here; the async iterator pulls from it.
  const queue = [];
  let resolveWait = null;
  let done = false;
  let errored = null;
  const push = (ev) => { queue.push(ev); if (resolveWait) { resolveWait(); resolveWait = null; } };

  // Kick off the chat on the server.
  let started;
  try {
    started = await wsCall(base, 'chat.sendMessage', { content, agentId: resolvedAgentId, model: resolvedModel, resumeSid, cwd });
  } catch (e) {
    yield { type: 'error', error: e.message };
    return;
  }
  const sessionId = started?.sessionId;
  if (!sessionId) { yield { type: 'error', error: 'no sessionId from server' }; return; }

  const unsub = addSessionListener(sessionId, (ev) => {
    if (ev.type === 'streaming_progress') {
      const block = ev.block;
      if (block?.type === 'text' && block.text) push({ type: 'text', text: block.text });
      else if (block?.type === 'tool_use') push({ type: 'tool', block });
      else if (block?.type === 'tool_result') push({ type: 'tool', block });
      else if (block?.type === 'result') push({ type: 'result', block });
      else if (block?.type === 'available_commands') push({ type: 'commands', commands: block.commands || [] });
    } else if (ev.type === 'streaming_complete') {
      done = true;
      if (resolveWait) { resolveWait(); resolveWait = null; }
    } else if (ev.type === 'streaming_error') {
      errored = ev.error || 'streaming error';
      done = true;
      if (resolveWait) { resolveWait(); resolveWait = null; }
    }
  });

  // Wire AbortSignal to chat.cancel.
  const onAbort = () => { wsCall(base, 'chat.cancel', { sessionId }).catch(() => {}); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise(r => { resolveWait = r; });
        continue;
      }
      yield queue.shift();
    }
    if (errored) yield { type: 'error', error: errored };
  } finally {
    unsub();
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }
}
