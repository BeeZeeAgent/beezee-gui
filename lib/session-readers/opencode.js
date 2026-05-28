import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const DATA_DIR = process.env.OPENCODE_DATA || path.join(os.homedir(), '.local', 'share', 'opencode');
const DB_PATH = path.join(DATA_DIR, 'opencode.db');

let _db = null;
if (fs.existsSync(DB_PATH)) {
  try {
    const { default: Database } = await import('bun:sqlite');
    _db = new Database(DB_PATH, { readonly: true });
  } catch {
    try {
      const require = createRequire(import.meta.url);
      const Database = require('better-sqlite3');
      _db = new Database(DB_PATH, { readonly: true });
    } catch {
      _db = null;
    }
  }
}

function db() { return _db; }

export const agentId = 'opencode';
export const label = 'OpenCode';

export function listSessions() {
  const d = db();
  if (!d) return [];
  try {
    const rows = d.prepare(
      `SELECT id, directory, title, time_created, time_updated, agent, model
       FROM session
       WHERE time_archived IS NULL
       ORDER BY time_updated DESC`
    ).all();
    return rows.map(r => ({
      sid: r.id,
      agentId,
      cwd: r.directory || '',
      last: r.time_updated || r.time_created || 0,
      events: 0,
      title: r.title || r.id,
      tools: 0,
      errors: 0,
      isSubagent: false,
      _model: r.model,
      _agent: r.agent,
    }));
  } catch {
    return [];
  }
}

export function getSessionEvents(sid) {
  const d = db();
  if (!d) return [];
  try {
    const msgs = d.prepare(
      `SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created ASC`
    ).all(sid);
    return msgs.map((m, i) => {
      let data = {};
      try { data = JSON.parse(m.data); } catch {}
      const role = data.role || '?';
      const text = extractMessageText(data);
      return { i, ts: m.time_created || 0, role, type: 'text', text, isError: false };
    });
  } catch {
    return [];
  }
}

function extractMessageText(data) {
  if (typeof data.content === 'string') return data.content.slice(0, 300);
  if (Array.isArray(data.content)) {
    return data.content
      .filter(c => c.type === 'text')
      .map(c => c.text || '')
      .join(' ')
      .slice(0, 300);
  }
  if (data.summary?.title) return data.summary.title;
  return '';
}
