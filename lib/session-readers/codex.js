import fs from 'fs';
import path from 'path';
import os from 'os';

const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_HOME, 'sessions');

// Cache: sid → { session, events, mtime }
const cache = new Map();

function allJsonlFiles(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...allJsonlFiles(full));
      else if (entry.name.endsWith('.jsonl')) results.push(full);
    }
  } catch {}
  return results;
}

function parseFile(file) {
  const mtime = fs.statSync(file).mtimeMs;
  const cached = cache.get(file);
  if (cached && cached.mtime === mtime) return cached;

  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let meta = null;
  const events = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'session_meta') {
      meta = obj.payload;
      continue;
    }
    if (obj.type === 'response_item' && obj.payload?.type === 'message') {
      const { role, content } = obj.payload;
      const text = Array.isArray(content)
        ? content.filter(c => c.type === 'input_text' || c.type === 'output_text').map(c => c.text || '').join(' ')
        : '';
      events.push({ ts: new Date(obj.timestamp || 0).getTime(), role, type: 'text', text: text.trim() });
    }
  }

  if (!meta) return null;
  const result = { meta, events, mtime };
  cache.set(file, result);
  return result;
}

function extractTitle(events) {
  for (const ev of events) {
    if (ev.role !== 'user') continue;
    const t = (ev.text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // Skip injected context blocks (AGENTS.md, permissions, environment_context)
    if (t.startsWith('<') || t.startsWith('#') || t.length < 4) continue;
    return t.slice(0, 80);
  }
  return '';
}

export const agentId = 'codex';
export const label = 'Codex';

export function listSessions() {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const sessions = [];
  for (const file of allJsonlFiles(SESSIONS_DIR)) {
    try {
      const parsed = parseFile(file);
      if (!parsed) continue;
      const { meta, events } = parsed;
      const last = events.length ? Math.max(...events.map(e => e.ts)) : new Date(meta.timestamp || 0).getTime();
      sessions.push({
        sid: meta.id,
        agentId,
        cwd: meta.cwd || '',
        last,
        events: events.length,
        title: extractTitle(events) || path.basename(file, '.jsonl'),
        tools: 0,
        errors: 0,
        isSubagent: false,
        _file: file,
      });
    } catch {}
  }
  return sessions;
}

export function getSessionEvents(sid) {
  for (const file of allJsonlFiles(SESSIONS_DIR)) {
    try {
      const parsed = parseFile(file);
      if (!parsed || parsed.meta.id !== sid) continue;
      return parsed.events.map((e, i) => ({ ...e, i }));
    } catch {}
  }
  return [];
}
