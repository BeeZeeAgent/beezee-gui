import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as term from './terminal.js';

export function createHttpHandler({ BASE_URL, expressApp, queries, sendJSON, serveFile, staticDir, messageQueues, getWss, activeExecutions, getACPStatus, discoveredAgents, PKG_VERSION, RATE_LIMIT_MAX, rateLimitMap, routes, PORT, STARTUP_CWD }) {
  return async function httpHandler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') return;

    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
    const hits = (rateLimitMap.get(clientIp) || 0) + 1;
    rateLimitMap.set(clientIp, hits);
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - hits));
    if (hits > RATE_LIMIT_MAX) { res.writeHead(429, { 'Retry-After': '60' }); res.end('Too Many Requests'); return; }

    const _pwd = process.env.PASSWORD;
    // Optional: exempt /health from auth so container/k8s probes work
    // without distributing the password to monitoring infra.
    const _bareEarly = req.url.split('?')[0];
    const _healthExempt = process.env.HEALTH_NO_AUTH === '1' && (_bareEarly === '/health' || _bareEarly === '/api/health' || _bareEarly === (BASE_URL + '/health') || _bareEarly === (BASE_URL + '/api/health'));
    if (_pwd && !_healthExempt) {
      const _auth = req.headers['authorization'] || '';
      let _ok = false;
      const _checkToken = (tok) => {
        try { return tok.length === _pwd.length && crypto.timingSafeEqual(Buffer.from(tok), Buffer.from(_pwd)); }
        catch { return false; }
      };
      if (_auth.startsWith('Basic ')) {
        try {
          const _decoded = Buffer.from(_auth.slice(6), 'base64').toString('utf8');
          const _ci = _decoded.indexOf(':');
          if (_ci !== -1) _ok = _checkToken(_decoded.slice(_ci + 1));
        } catch (_) {}
      } else if (_auth.startsWith('Bearer ')) {
        _ok = _checkToken(_auth.slice(7));
      }
      // EventSource and same-origin links can't set headers — accept ?token= as fallback.
      if (!_ok) {
        try {
          const _qsTok = new URL(req.url, 'http://localhost').searchParams.get('token');
          if (_qsTok) _ok = _checkToken(_qsTok);
        } catch (_) {}
      }
      if (!_ok) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="agentgui"' }); res.end('Unauthorized'); return; }
    }

    const pathOnly = req.url.split('?')[0];
    if (pathOnly.startsWith(BASE_URL + '/api/upload/') || pathOnly.startsWith(BASE_URL + '/files/') || pathOnly.startsWith('/v1/history') || (BASE_URL && pathOnly.startsWith(BASE_URL + '/v1/history'))) return expressApp(req, res);

    if (req.url === '/favicon.ico' || req.url === BASE_URL + '/favicon.ico') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#3b82f6"/><text x="50" y="68" font-size="50" font-family="sans-serif" font-weight="bold" fill="white" text-anchor="middle">G</text></svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(svg); return;
    }

    // serve index.html at root directly (no redirect)

    let routePath = req.url;
    const _bareUrl = req.url.split('?')[0];
    if (_bareUrl.startsWith(BASE_URL + '/')) { routePath = req.url.slice(BASE_URL.length); }
    else if (_bareUrl === BASE_URL) { routePath = '/'; }
    else if (_bareUrl.startsWith('/api/') || _bareUrl.startsWith('/js/') || _bareUrl.startsWith('/css/') ||
             _bareUrl.startsWith('/vendor/') || _bareUrl.startsWith('/sync') || _bareUrl === '/' ||
             _bareUrl === '/health' || _bareUrl.startsWith('/v1/') ||
             _bareUrl.startsWith('/api/terminal/') ||
             _bareUrl.startsWith('/conversations/')) { routePath = req.url; }
    else { res.writeHead(404); res.end('Not found'); return; }

    routePath = routePath || '/';

    try {
      const pathOnly = routePath.split('?')[0];

      if ((pathOnly === '/api/health' || pathOnly === '/health') && req.method === 'GET') {
        let dbStatus = { ok: true };
        try { queries._db.prepare('SELECT 1').get(); } catch (e) { dbStatus = { ok: false, error: e.message }; }
        const queueSizes = {};
        for (const [k, v] of messageQueues) queueSizes[k] = v.length;
        sendJSON(req, res, 200, { status: 'ok', version: PKG_VERSION, uptime: process.uptime(), cwd: STARTUP_CWD, agents: discoveredAgents.length, activeExecutions: activeExecutions.size, wsClients: getWss()?.clients?.size ?? 0, memory: process.memoryUsage(), acp: getACPStatus(), db: dbStatus, queueSizes });
        return;
      }

      // Terminal sessions — gated by the Basic-auth check at the top of this handler.
      // Never expose these routes without PASSWORD set.
      if (pathOnly === '/api/terminal/sessions' && req.method === 'GET') {
        sendJSON(req, res, 200, term.listSessions()); return;
      }
      if (pathOnly === '/api/terminal/sessions' && req.method === 'POST') {
        let body = ''; for await (const c of req) body += c;
        let p = {}; try { p = body ? JSON.parse(body) : {}; } catch {}
        const s = term.createSession({ shell: p.shell, cwd: p.cwd, cols: p.cols, rows: p.rows, env: p.env });
        sendJSON(req, res, 200, { sid: s.sid, kind: s.kind, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.proc.pid });
        return;
      }
      const termMatch = pathOnly.match(/^\/api\/terminal\/sessions\/([0-9a-f]+)$/);
      if (termMatch && req.method === 'GET') {
        const s = term.getSession(termMatch[1]);
        if (!s) { sendJSON(req, res, 404, { error: 'session not found' }); return; }
        sendJSON(req, res, 200, { sid: s.sid, kind: s.kind, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.proc.pid, clients: s.clients.size });
        return;
      }
      if (termMatch && req.method === 'DELETE') {
        const ok = term.closeSession(termMatch[1]);
        sendJSON(req, res, ok ? 200 : 404, { ok }); return;
      }

      // Legacy REST handlers removed. History served by ccsniff at /v1/history/*.
      for (const key of Object.keys(routes)) {
        try {
          const h = routes[key]?._match?.(req.method, pathOnly);
          if (h) { await h(req, res); return; }
        } catch (_) {}
      }
      if (routePath.startsWith('/api/image/')) {
        const imagePath = routePath.slice('/api/image/'.length);
        const decodedPath = decodeURIComponent(imagePath);
        const expandedPath = decodedPath.startsWith('~') ? decodedPath.replace('~', os.homedir()) : decodedPath;
        const normalizedPath = path.normalize(expandedPath);
        const isWindows = os.platform() === 'win32';
        const isAbsolute = isWindows ? /^[A-Za-z]:[\\\/]/.test(normalizedPath) : normalizedPath.startsWith('/');
        if (!isAbsolute || normalizedPath.includes('..')) { res.writeHead(403); res.end('Forbidden'); return; }
        try {
          if (!fs.existsSync(normalizedPath)) { res.writeHead(404); res.end('Not found'); return; }
          const ext = path.extname(normalizedPath).toLowerCase();
          const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
          const contentType = mimeTypes[ext] || 'application/octet-stream';
          res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
          res.end(fs.readFileSync(normalizedPath));
        } catch (err) { sendJSON(req, res, 400, { error: err.message }); }
        return;
      }

      if (pathOnly.match(/^\/conversations\/[^\/]+$/)) { serveFile(path.join(staticDir, 'index.html'), res, req); return; }

      const routePathBare = routePath.split('?')[0];
      let filePath = routePathBare === '/' ? '/index.html' : routePathBare;
      filePath = path.join(staticDir, filePath);
      const normalizedPath = path.normalize(filePath);
      if (!normalizedPath.startsWith(staticDir)) { res.writeHead(403); res.end('Forbidden'); return; }

      fs.stat(filePath, (err, stats) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        if (stats.isDirectory()) {
          filePath = path.join(filePath, 'index.html');
          fs.stat(filePath, (err2) => { if (err2) { res.writeHead(404); res.end('Not found'); return; } serveFile(filePath, res, req); });
        } else { serveFile(filePath, res, req); }
      });
    } catch (e) {
      console.error('Server error:', e.message);
      sendJSON(req, res, 500, { error: e.message });
    }
  };
}
