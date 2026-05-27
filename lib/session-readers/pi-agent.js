import fs from 'fs';
import path from 'path';
import os from 'os';

// pi-agent stores sessions under ~/.pi/agent/sessions/PROJECT_SLUG/TIMESTAMP_UUID.jsonl
// First line: {type:"session", version:3, id, timestamp, cwd}
// Subsequent: {type:"model_change"|"user"|"assistant"|..., id, parentId, timestamp, ...}
const SESSIONS_ROOT = path.join(os.homedir(), '.pi', 'agent', 'sessions');

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
  let header = null;
  const events = [];

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (!header && obj.type === 'session') {
      header = obj;
      continue;
    }
    const ts = new Date(obj.timestamp || 0).getTime();
    if (obj.type === 'user' || obj.type === 'assistant') {
      const text = extractText(obj);
      events.push({ ts, role: obj.type, type: 'text', text });
    } else if (obj.type === 'tool_use') {
      events.push({ ts, role: 'assistant', type: 'tool_use', text: obj.name || '', tool: obj.name });
    } else if (obj.type === 'tool_result') {
      events.push({ ts, role: 'tool', type: 'tool_result', text: extractText(obj) });
    }
  }

  if (!header) return null;
  const result = { header, events, mtime };
  cache.set(file, result);
  return result;
}

function extractText(obj) {
  if (typeof obj.content === 'string') return obj.content.slice(0, 300);
  if (Array.isArray(obj.content)) {
    return obj.content.filter(c => c.type === 'text').map(c => c.text || '').join(' ').slice(0, 300);
  }
  return '';
}

function extractTitle(events) {
  for (const ev of events) {
    if (ev.role !== 'user') continue;
    const t = ev.text.replace(/\s+/g, ' ').trim();
    if (t.length > 3) return t.slice(0, 80);
  }
  return '';
}

export const agentId = 'pi-agent';
export const label = 'Pi Agent';

export function listSessions() {
  if (!fs.existsSync(SESSIONS_ROOT)) return [];
  const sessions = [];
  for (const file of allJsonlFiles(SESSIONS_ROOT)) {
    try {
      const parsed = parseFile(file);
      if (!parsed) continue;
      const { header, events } = parsed;
      const last = events.length
        ? Math.max(...events.map(e => e.ts))
        : new Date(header.timestamp || 0).getTime();
      sessions.push({
        sid: header.id,
        agentId,
        cwd: header.cwd || '',
        last,
        events: events.length,
        title: extractTitle(events) || path.basename(file, '.jsonl'),
        tools: events.filter(e => e.type === 'tool_use').length,
        errors: 0,
        isSubagent: false,
        _file: file,
      });
    } catch {}
  }
  return sessions;
}

export function getSessionEvents(sid) {
  for (const file of allJsonlFiles(SESSIONS_ROOT)) {
    try {
      const parsed = parseFile(file);
      if (!parsed || parsed.header.id !== sid) continue;
      return parsed.events.map((e, i) => ({ ...e, i }));
    } catch {}
  }
  return [];
}
