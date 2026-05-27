import assert from 'assert';
import { createRequire } from 'module';
import { initSchema } from './database-schema.js';
import { migrateConversationColumns } from './database-migrations.js';
import { migrateACPSchema } from './database-migrations-acp.js';
import { createQueries } from './lib/db-queries.js';
import { encode, decode } from './lib/codec.js';
import { WsRouter } from './lib/ws-protocol.js';
import { WSOptimizer } from './lib/ws-optimizer.js';
import * as exm from './lib/execution-machine.js';
import * as asm from './lib/acp-server-machine.js';
import { maskKey, buildSystemPrompt } from './lib/provider-config.js';
import { initializeDescriptors, getAgentDescriptor } from './lib/agent-descriptors.js';
import { createACPProtocolHandler } from './lib/acp-protocol.js';
import { sendJSON, compressAndSend, acceptsEncoding } from './lib/http-utils.js';
import { JsonlParser } from './lib/jsonl-parser.js';
const require = createRequire(import.meta.url);
let Database, dbAvailable = false;
try {
  try { Database = (await import('bun:sqlite')).default; }
  catch { Database = require('better-sqlite3'); }
  new Database(':memory:');
  dbAvailable = true;
} catch { dbAvailable = false; }
let passed = 0, failed = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { console.log(`ok — ${name}`); passed++; },
  (err) => { console.error(`FAIL — ${name}: ${err.message}`); failed++; });
const okDb = (name, fn) => dbAvailable ? ok(name, fn) : (console.log(`skip (no sqlite) — ${name}`), passed++, Promise.resolve());
function inMemDb() {
  const db = new Database(':memory:');
  if (db.pragma) db.pragma('foreign_keys = ON'); else db.run('PRAGMA foreign_keys = ON');
  const oL = console.log, oW = console.warn; console.log = () => {}; console.warn = () => {};
  try { initSchema(db); migrateConversationColumns(db); migrateACPSchema(db); }
  finally { console.log = oL; console.warn = oW; }
  const gid = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  return { db, prep: (sql) => db.prepare(sql), gid };
}
function mockRes() {
  const r = { headers: {}, body: null, statusCode: 0 };
  r.writeHead = (s, h) => { r.statusCode = s; r.headers = h; };
  r.end = (b) => { r.body = b; };
  return r;
}
const run = async () => {
await ok('codec: roundtrip + binary', () => {
  assert.deepEqual(decode(encode({ a: 1, b: 'str', c: [1, 2, 3], d: { nested: true } })), { a: 1, b: 'str', c: [1, 2, 3], d: { nested: true } });
  assert.deepEqual(Array.from(decode(encode({ bin: Buffer.from([1, 2, 3, 4]) })).bin), [1, 2, 3, 4]);
});
await okDb('db: init schema creates conversations table', () => {
  assert.ok(inMemDb().db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get());
});
await okDb('db-queries: createConversation round-trip', () => {
  const { db, prep, gid } = inMemDb();
  const q = createQueries(db, prep, gid);
  const c = q.createConversation('claude-code', 'Test', '/tmp', 'sonnet', null);
  assert.equal(q.getConversation(c.id).title, 'Test');
  assert.equal(q.getConversation(c.id).status, 'active');
});
await okDb('db-queries: archive + restore + streaming flag', () => {
  const { db, prep, gid } = inMemDb();
  const q = createQueries(db, prep, gid);
  const c = q.createConversation('claude-code', 'A');
  q.archiveConversation(c.id); assert.equal(q.getConversation(c.id).status, 'archived');
  q.restoreConversation(c.id); assert.equal(q.getConversation(c.id).status, 'active');
  q.setIsStreaming(c.id, true); assert.equal(q.getIsStreaming(c.id), true);
  q.setIsStreaming(c.id, false); assert.equal(q.getIsStreaming(c.id), false);
});
await okDb('acp-queries: thread crud + search', () => {
  const { db, prep, gid } = inMemDb();
  const q = createQueries(db, prep, gid);
  const t = q.createThread({ foo: 'bar' });
  assert.deepEqual(q.getThread(t.thread_id).metadata, { foo: 'bar' });
  q.patchThread(t.thread_id, { metadata: { foo: 'baz' }, status: 'active' });
  assert.deepEqual(q.getThread(t.thread_id).metadata, { foo: 'baz' });
  q.createThread({ kind: 'b' });
  assert.equal(q.searchThreads({}).total, 2);
});
await ok('WsRouter: dispatch + 404 + error + legacy', async () => {
  const router = new WsRouter();
  router.handle('ping', async (p) => ({ pong: p.n }));
  router.handle('boom', async () => { throw Object.assign(new Error('kaboom'), { code: 422 }); });
  let legacy = null; router.onLegacy((m) => { legacy = m; });
  const replies = [];
  const ws = { readyState: 1, send: (b) => replies.push(decode(b)), clientId: 'c' };
  await router.onMessage(ws, encode({ r: 1, m: 'ping', p: { n: 7 } }));
  await router.onMessage(ws, encode({ r: 2, m: 'nope', p: {} }));
  await router.onMessage(ws, encode({ r: 3, m: 'boom', p: {} }));
  await router.onMessage(ws, encode({ type: 'subscribe', id: 'x' }));
  assert.deepEqual(replies[0], { r: 1, d: { pong: 7 } });
  assert.equal(replies[1].e.c, 404); assert.equal(replies[2].e.c, 422); assert.equal(legacy.type, 'subscribe');
});
await ok('machines: execution + acp-server lifecycle', () => {
  assert.equal(exm.snapshot('nonexistent-conv-id'), null);
  assert.equal(asm.getOrCreate('test-tool').getSnapshot().value, 'stopped');
  asm.send('test-tool', { type: 'START', pid: 123 });
  assert.equal(asm.get('test-tool').getSnapshot().value, 'starting');
  asm.send('test-tool', { type: 'HEALTHY', providerInfo: { ok: true } });
  assert.equal(asm.isHealthy('test-tool'), true);
  asm.stopAll();
});
await ok('workflow-plugin + agent-registry hermes', async () => {
  const wp = await import('./lib/plugins/workflow-plugin.js');
  assert.deepEqual(wp.default.dependencies, ['database']);
  const { registry } = await import('./lib/claude-runner-agents.js');
  const h = registry.get('hermes');
  assert.equal(h.protocol, 'acp'); assert.deepEqual(h.buildArgs(), ['acp']);
});
await okDb('delete-all: soft-deletes + wipes related', () => {
  const { db, prep, gid } = inMemDb();
  const q = createQueries(db, prep, gid);
  const c1 = q.createConversation('claude-code', 'A');
  q.createConversation('claude-code', 'B');
  q.createSession(c1.id); q.createMessage(c1.id, 'user', 'hello');
  const oL = console.log; console.log = () => {};
  try { q.deleteAllConversations(); } finally { console.log = oL; }
  assert.deepEqual(db.prepare('SELECT status, count(*) as c FROM conversations GROUP BY status').all(), [{ status: 'deleted', c: 2 }]);
  assert.equal(db.prepare('SELECT count(*) as c FROM messages').get().c, 0);
  assert.equal(q.getConversationsList().length, 0);
});
await ok('provider-config: maskKey + buildSystemPrompt', () => {
  assert.equal(maskKey(''), '****'); assert.equal(maskKey('short'), '****'); assert.equal(maskKey('sk-abcd1234efgh'), '****efgh');
  assert.equal(buildSystemPrompt('claude-code'), '');
  assert.equal(buildSystemPrompt('opencode', 'sonnet'), 'Use opencode subagent for all tasks. Model: sonnet.');
  assert.equal(buildSystemPrompt('foo-·-bar', null, 'sub'), 'Use foo subagent for all tasks. Subagent: sub.');
});
await ok('agent-descriptors: initialize + cache', () => {
  assert.equal(initializeDescriptors([{ id: 'claude-code', name: 'Claude Code', path: '/x' }]), 1);
  const d = getAgentDescriptor('claude-code');
  assert.equal(d.metadata.ref.name, 'Claude Code');
  assert.ok(d.specs.input.properties.model); assert.ok(d.specs.thread_state.properties.sessionId);
  assert.equal(getAgentDescriptor('nope'), null);
});
await ok('ws-optimizer: high-priority flush + low-priority batch', async () => {
  const opt = new WSOptimizer(); const s1 = []; const s2 = [];
  const w1 = { readyState: 1, clientId: 'c1', send: (b) => s1.push(decode(b)) };
  const w2 = { readyState: 1, clientId: 'c2', latencyTier: 'excellent', send: (b) => s2.push(decode(b)) };
  opt.sendToClient(w1, { type: 'streaming_start', id: 1 }); assert.equal(s1.length, 1); opt.removeClient(w1); assert.equal(opt.getStats().clients, 0);
  opt.sendToClient(w2, { type: 'tts_audio', n: 1 }); opt.sendToClient(w2, { type: 'tts_audio', n: 2 }); assert.equal(s2.length, 0);
  await new Promise(r => setTimeout(r, 40)); assert.equal(s2.length, 1); assert.equal(s2[0].length, 2); opt.removeClient(w2);
});
await ok('acp-protocol: session/update + result + error mapping', () => {
  const h = createACPProtocolHandler(); const ctx = { sessionId: 's1' };
  assert.equal(h(null, ctx), null);
  const chunk = h({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: 'hi' } } }, ctx);
  assert.equal(chunk.type, 'assistant'); assert.equal(chunk.message.content[0].text, 'hi');
  const tc = h({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'read', rawInput: { p: 1 } } } }, ctx);
  assert.equal(tc.message.content[0].type, 'tool_use');
  assert.equal(h({ id: 1, result: { stopReason: 'end_turn', usage: {} } }, ctx).type, 'result');
  assert.equal(h({ method: 'error', error: { message: 'x' } }, ctx).type, 'error');
  assert.equal(h({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'unknown' } } }, ctx), null);
});
await ok('http-utils: sendJSON + compressAndSend size threshold', () => {
  const req = { headers: { 'accept-encoding': 'gzip, deflate' } };
  assert.equal(acceptsEncoding(req, 'gzip'), true); assert.equal(acceptsEncoding({ headers: {} }, 'gzip'), false);
  const sm = mockRes(); sendJSON(req, sm, 200, { ok: 1 }); assert.equal(sm.statusCode, 200); assert.equal(sm.headers['Content-Type'], 'application/json');
  const big = mockRes(); compressAndSend(req, big, 200, 'text/plain', 'x'.repeat(2000)); assert.equal(big.headers['Content-Encoding'], 'gzip');
  const ng = mockRes(); compressAndSend({ headers: {} }, ng, 200, 'text/html', 'y'.repeat(2000)); assert.equal(ng.headers['Cache-Control'], 'no-store');
});
await ok('jsonl-parser: register + remove + clear', () => {
  const p = new JsonlParser({ broadcastSync: () => {}, queries: { getConversationByClaudeSessionId: () => null } });
  p.registerSession('s1', 'c1', 'd1'); assert.equal(p._convMap.get('s1'), 'c1');
  p.removeSid('s1'); assert.equal(p._convMap.has('s1'), false);
  p.registerSession('s2', 'c2', 'd2'); p.clear(); assert.equal(p._convMap.size, 0);
});
await okDb('conv-routes+thread-routes+auth-config+util-routes', async () => {
  const [{ register: rC }, { register: rT }, { register: rA }, { register: rU }] = await Promise.all(['./lib/routes-conversations.js','./lib/routes-threads.js','./lib/routes-auth-config.js','./lib/routes-util.js'].map(m => import(m)));
  const { db: d2, prep: p2, gid: g2 } = inMemDb(); const q2 = createQueries(d2, p2, g2);
  const sj2 = (req, res, c, data) => { res.statusCode = c; res.body = JSON.stringify(data); };
  const pb2 = async (req) => req?._b || {}; const mr = () => mockRes();
  const cR = rC({ sendJSON: sj2, parseBody: pb2, queries: q2, activeExecutions: new Map(), broadcastSync: () => {} });
  const c1 = q2.createConversation('claude-code', 'T');
  const lr = mr(); await cR['GET /api/conversations'](null, lr); assert.equal(lr.statusCode, 200);
  const cr = mr(); await cR['POST /api/conversations']({ _b: { agentId: 'claude-code', title: 'N' } }, cr);
  assert.equal(cr.statusCode, 201); const nid = JSON.parse(cr.body).conversation.id;
  const gr = mr(); await cR._match('GET', `/api/conversations/${nid}`)(null, gr); assert.equal(gr.statusCode, 200);
  const dr = mr(); await cR._match('DELETE', `/api/conversations/${nid}`)(null, dr); assert.equal(dr.statusCode, 200);
  const nr = mr(); await cR._match('GET', '/api/conversations/nope')(null, nr); assert.equal(nr.statusCode, 404);
  const ar = mr(); await cR._match('POST', `/api/conversations/${c1.id}/archive`)(null, ar); assert.equal(ar.statusCode, 200);
  const rr = mr(); await cR._match('POST', `/api/conversations/${c1.id}/restore`)(null, rr); assert.equal(rr.statusCode, 200);
  const tR = rT({ sendJSON: sj2, parseBody: pb2, queries: q2 });
  const tr = mr(); await tR['POST /api/threads']({ _b: { metadata: { k: 1 } } }, tr); assert.equal(tr.statusCode, 201);
  const tid = JSON.parse(tr.body).thread_id;
  const tgr = mr(); await tR._match('GET', `/api/threads/${tid}`)(null, tgr); assert.equal(tgr.statusCode, 200);
  const tpr = mr(); await tR._match('PATCH', `/api/threads/${tid}`)({ _b: { metadata: { k: 2 } } }, tpr); assert.equal(tpr.statusCode, 200);
  const tsr = { statusCode: 0, writeHead: (c) => { tsr.statusCode = c; }, end: () => {} };
  await tR._match('DELETE', `/api/threads/${tid}`)(null, tsr); assert.equal(tsr.statusCode, 204);
  const ssr = mr(); await tR['POST /api/threads/search']({ _b: {} }, ssr); assert.equal(ssr.statusCode, 200);
  const aR = rA({ sendJSON: sj2, parseBody: pb2, getProviderConfigs: () => ({ anthropic: { hasKey: false } }), saveProviderConfig: () => '/x' });
  const agr = mr(); aR['GET /api/auth/configs'](null, agr); assert.equal(agr.statusCode, 200); assert.ok(JSON.parse(agr.body).anthropic !== undefined);
  const br = mr(); await aR['POST /api/auth/save-config']({ _b: { providerId: '', apiKey: 'x' } }, br); assert.equal(br.statusCode, 400);
  const sr = mr(); await aR['POST /api/auth/save-config']({ _b: { providerId: 'anthropic', apiKey: 'sk-123456789' } }, sr); assert.equal(sr.statusCode, 200);
  const uR = rU({ sendJSON: sj2, parseBody: pb2, queries: q2, STARTUP_CWD: process.cwd(), PKG_VERSION: '1.0.0' });
  const hr = mr(); await uR['GET /api/home'](null, hr); assert.equal(hr.statusCode, 200); assert.ok(JSON.parse(hr.body).home);
  const vr = mr(); await uR['GET /api/version'](null, vr); assert.equal(vr.statusCode, 200);
  const fr = mr(); await uR['POST /api/folders']({ _b: { path: process.cwd() } }, fr); assert.equal(fr.statusCode, 200); assert.ok(Array.isArray(JSON.parse(fr.body).folders));
});
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
}; run();
