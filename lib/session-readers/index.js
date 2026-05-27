import * as codex from './codex.js';
import * as opencode from './opencode.js';
import * as piAgent from './pi-agent.js';

// Readers must implement: agentId, label, listSessions(), getSessionEvents(sid)
const readers = [codex, opencode, piAgent];

export function knownAgents() {
  return readers.map(r => ({ id: r.agentId, label: r.label }));
}

export function listAllSessions() {
  const all = [];
  for (const r of readers) {
    try { all.push(...r.listSessions()); } catch {}
  }
  return all;
}

export function getSessionEvents(sid) {
  for (const r of readers) {
    try {
      const evs = r.getSessionEvents(sid);
      if (evs.length) return evs;
    } catch {}
  }
  return [];
}

export function getReaderForAgent(id) {
  return readers.find(r => r.agentId === id) || null;
}
