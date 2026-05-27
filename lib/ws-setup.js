import fs from 'fs';
import path from 'path';
import { WebSocketServer } from 'ws';
import * as term from './terminal.js';
// Legacy WS handlers removed; no-op shim kept for callsite compatibility.
const registerLegacyHandler = () => {};

export function createWsSetup(server, { BASE_URL, watch, staticDir, _assetCache, htmlState, sendWs, wsRouter, debugLog, subscriptionIndex, syncClients, wsOptimizer, legacyDeps }) {
  const hotReloadClients = [];

  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  wss.on('error', (err) => { console.error('[WSS] WebSocket server error (contained):', err.message); });

  wss.on('connection', (ws, req) => {
    const _pwd = process.env.PASSWORD;
    if (_pwd) {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      if (token !== _pwd) { ws.close(4001, 'Unauthorized'); return; }
    }
    const wsPath = req.url.split('?')[0];
    const wsRoute = wsPath.startsWith(BASE_URL) ? wsPath.slice(BASE_URL.length) : wsPath;
    if (wsRoute === '/hot-reload') {
      hotReloadClients.push(ws);
      ws.on('close', () => { const i = hotReloadClients.indexOf(ws); if (i > -1) hotReloadClients.splice(i, 1); });
    } else if (wsRoute.startsWith('/api/terminal/sessions/')) {
      // Terminal session WS — auth was already enforced by wss-level PASSWORD
      // check at the top of this connection callback. attach to existing session.
      const m = wsRoute.match(/^\/api\/terminal\/sessions\/([0-9a-f]+)$/);
      if (!m) { ws.close(4400, 'bad-terminal-path'); return; }
      term.attachWs(m[1], ws);
    } else if (wsRoute === '/sync') {
      syncClients.add(ws);
      ws.isAlive = true;
      ws.subscriptions = new Set();
      ws.clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      sendWs(ws, { type: 'sync_connected', clientId: ws.clientId, timestamp: Date.now() });
      ws.on('error', (err) => { console.error('[WS] Client error (contained):', ws.clientId, err.message); });
      ws.on('message', (msg) => { try { wsRouter.onMessage(ws, msg); } catch (e) { console.error('[WS] Message handler error (contained):', e.message); } });
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => {
        syncClients.delete(ws);
        wsOptimizer.removeClient(ws);
        for (const sub of ws.subscriptions) {
          const idx = subscriptionIndex.get(sub);
          if (idx) { idx.delete(ws); if (idx.size === 0) subscriptionIndex.delete(sub); }
        }
        debugLog(`[WebSocket] Client ${ws.clientId} disconnected`);
      });
    }
  });

  registerLegacyHandler(wsRouter, legacyDeps);

  setInterval(() => {
    syncClients.forEach(ws => {
      if (!ws.isAlive) { syncClients.delete(ws); wsOptimizer.removeClient(ws); return ws.terminate(); }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  if (watch) {
    const watchedFiles = new Map();
    try {
      fs.readdirSync(staticDir).forEach(file => {
        const fp = path.join(staticDir, file);
        if (watchedFiles.has(fp)) return;
        fs.watchFile(fp, { interval: 100 }, (curr, prev) => {
          if (curr.mtime > prev.mtime) {
            _assetCache.clear();
            htmlState.cache = null;
            htmlState.etag = null;
            hotReloadClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'reload' })); });
          }
        });
        watchedFiles.set(fp, true);
      });
    } catch (e) { console.error('Watch error:', e.message); }
  }

  return { wss, hotReloadClients };
}
