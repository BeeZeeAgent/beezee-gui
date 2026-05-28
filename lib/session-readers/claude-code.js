import fs from 'fs';
import path from 'path';
import os from 'os';

export const agentId = 'claude-code';
export const label = 'Claude';

const PROJECTS_ROOT = process.env.CLAUDE_PROJECTS_DIR
  || path.join(os.homedir(), '.claude', 'projects');

// mtime-based cache: filePath → { mtime, events, title, last }
const cache = new Map();

function cwdToProjectDir(cwd) {
  const slug = cwd.replace(/\//g, '-');
  const dir = path.join(PROJECTS_ROOT, slug);
  return fs.existsSync(dir) ? dir : null;
}

function parseFile(filePath) {
  let mtime;
  try { mtime = fs.statSync(filePath).mtimeMs; } catch { return null; }
  const hit = cache.get(filePath);
  if (hit && hit.mtime === mtime) return hit;

  const events = [];
  let title = '';
  let lastTs = 0;

  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }

      const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : 0;
      if (ts > lastTs) lastTs = ts;

      if (obj.type === 'user' && obj.message) {
        const raw = obj.message.content;
        const text = typeof raw === 'string' ? raw
          : Array.isArray(raw) ? raw.filter(b => b.type === 'text').map(b => b.text || '').join(' ')
          : '';
        const trimmed = text.trim();
        if (!title && trimmed.length >= 4 && !trimmed.startsWith('<') && !trimmed.startsWith('#') && !/^[A-Z_\s]{4,}$/.test(trimmed)) {
          title = trimmed.slice(0, 80);
        }
        if (trimmed) events.push({ role: 'user', type: 'text', text: trimmed, ts, isError: false });

      } else if (obj.type === 'assistant' && obj.message?.content) {
        for (const block of obj.message.content) {
          if (block.type === 'text' && block.text) {
            events.push({ role: 'assistant', type: 'text', text: block.text, ts, isError: false });
          } else if (block.type === 'tool_use') {
            const input = block.input ? JSON.stringify(block.input).slice(0, 300) : '';
            events.push({ role: 'assistant', type: 'tool_use', tool: block.name, text: input, ts, isError: false });
          }
        }
      }
    }
  } catch { return null; }

  const result = { mtime, events, title, last: lastTs || mtime };
  cache.set(filePath, result);
  return result;
}

const UUID_JSONL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export function listSessionsForCwd(cwd) {
  const projectDir = cwdToProjectDir(cwd);
  if (!projectDir) return [];
  const sessions = [];
  let entries;
  try { entries = fs.readdirSync(projectDir); } catch { return []; }
  for (const name of entries) {
    if (!UUID_JSONL.test(name)) continue; // skip launchpad-sync-codex-* etc.
    const sid = name.slice(0, -6);
    const filePath = path.join(projectDir, name);
    const parsed = parseFile(filePath);
    if (!parsed) continue;
    sessions.push({
      sid, agentId, cwd,
      last: parsed.last,
      events: parsed.events.length,
      title: parsed.title || sid,
      tools: parsed.events.filter(e => e.type === 'tool_use').length,
      errors: 0,
      isSubagent: false,
      _file: filePath,
    });
  }
  return sessions.sort((a, b) => b.last - a.last);
}

export function getSessionEvents(sid, cwd) {
  // If cwd given, look in that project dir first
  if (cwd) {
    const projectDir = cwdToProjectDir(cwd);
    if (projectDir) {
      const filePath = path.join(projectDir, sid + '.jsonl');
      if (fs.existsSync(filePath)) {
        const parsed = parseFile(filePath);
        return (parsed?.events || []).map((e, i) => ({ ...e, i }));
      }
    }
  }
  // Fallback: scan all project dirs
  try {
    for (const entry of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const filePath = path.join(PROJECTS_ROOT, entry.name, sid + '.jsonl');
      if (fs.existsSync(filePath)) {
        const parsed = parseFile(filePath);
        return (parsed?.events || []).map((e, i) => ({ ...e, i }));
      }
    }
  } catch {}
  return [];
}

// For the global all-sessions listing (history tab)
export function listSessions() {
  const sessions = [];
  try {
    for (const entry of fs.readdirSync(PROJECTS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const projectDir = path.join(PROJECTS_ROOT, entry.name);
      // Reconstruct cwd from slug: -home-pi-Documents → /home/pi/Documents
      const cwd = entry.name.replace(/^-/, '/').replace(/-/g, '/');
      let files;
      try { files = fs.readdirSync(projectDir); } catch { continue; }
      for (const name of files) {
        if (!UUID_JSONL.test(name)) continue;
        const sid = name.slice(0, -6);
        const filePath = path.join(projectDir, name);
        const parsed = parseFile(filePath);
        if (!parsed) continue;
        sessions.push({
          sid, agentId, cwd,
          last: parsed.last,
          events: parsed.events.length,
          title: parsed.title || sid,
          tools: parsed.events.filter(e => e.type === 'tool_use').length,
          errors: 0,
          isSubagent: false,
        });
      }
    }
  } catch {}
  return sessions.sort((a, b) => b.last - a.last);
}
