import { h, mount, installStyles, components as C } from 'anentrypoint-design';
import * as B from './backend.js';

installStyles().catch(() => {});

const { AppShell, Topbar, Crumb, Side, Status, Chat, ChatComposer, Row, Panel, PageHeader, SearchInput, TextField, Select, Btn, EventList } = C;

const CWD_KEY = 'agentgui.cwd';

const state = {
  backend: B.getBackend(),
  backendDraft: B.getBackend(),
  health: { status: 'unknown' },
  cwd: localStorage.getItem(CWD_KEY) || '',
  cwdDraft: localStorage.getItem(CWD_KEY) || '',
  tab: 'chat',
  models: [],
  selectedModel: '',
  chat: { messages: [], busy: false, abort: null, draft: '', resumeSid: null },
  sessions: [],
  selectedSid: null,
  events: [],
  searchQ: '',
  searchHits: null,
  historyError: null,
  showSubagents: false,
  sessionsLimit: 60,
  projectFilter: '',
  live: { es: null, connected: false, lastEventTs: 0, error: null, eventCount: 0, reconnects: 0 },
};

function readHash() {
  const m = (location.hash || '').match(/sid=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
function writeHash(sid) {
  const h = sid ? '#sid=' + encodeURIComponent(sid) : '';
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}
function fmtRelTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
}

let render;
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

function timeNow() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function navTo(tab) {
  const prev = state.tab;
  state.tab = tab;
  if (tab === 'history') {
    refreshHistory();
    openLiveStream();
  } else if (prev === 'history') {
    closeLiveStream();
  }
  render();
}

function openLiveStream() {
  if (state.live.es) return;
  state.live.error = null;
  state.live.connected = false;
  try {
    state.live.es = B.streamHistory(state.backend, (kind, data) => {
      state.live.lastEventTs = Date.now();
      state.live.eventCount++;
      if (kind === 'hello') {
        if (!state.live.connected) state.live.connected = true;
        if (state.live.error) { state.live.error = null; state.live.reconnects++; }
      } else if (kind === 'event' && data) {
        if (state.selectedSid && data.sid === state.selectedSid) {
          state.events.push(data);
        }
        const arr = Array.isArray(state.sessions) ? state.sessions : [];
        const sess = arr.find(s => s.sid === data.sid);
        if (sess) {
          sess.events = (sess.events || 0) + 1;
          sess.last = data.ts || Date.now();
          if (data.type === 'tool_use') sess.tools = (sess.tools || 0) + 1;
          if (data.isError) sess.errors = (sess.errors || 0) + 1;
        } else {
          refreshHistory();
          return;
        }
      } else if (kind === 'conversation') {
        refreshHistory();
        return;
      } else if (kind === 'error' && data) {
        state.live.error = data.error || 'stream error';
      }
      scheduleRender();
    });
    state.live.es.addEventListener('error', () => {
      // EventSource auto-reconnects; only flap state once per disconnect.
      if (!state.live.error) {
        state.live.connected = false;
        state.live.error = 'connection lost (auto-retry)';
        scheduleRender();
      }
    });
  } catch (e) {
    state.live.error = e.message;
    state.live.es = null;
  }
}

function closeLiveStream() {
  if (!state.live.es) return;
  try { state.live.es.close(); } catch {}
  state.live.es = null;
  state.live.connected = false;
}

function view() {
  const ok = state.health.status === 'ok';
  const liveActive = state.tab === 'history' && state.live.connected && (Date.now() - state.live.lastEventTs < 30000);
  const dotText = state.tab === 'history'
    ? (state.live.error
        ? '◌ ' + state.live.error + (state.live.reconnects ? ' · ' + state.live.reconnects + ' reconnects' : '')
        : (liveActive ? '● live · ' + state.live.eventCount : (state.live.connected ? '● live' : '◌ connecting…')))
    : (ok ? (state.health.ws === 'reconnecting' ? '◌ ws reconnecting' : '● connected') : '○ offline');
  const dot = h('span', { key: 'dot' }, dotText);

  const topbar = Topbar({
    brand: 'agentgui',
    leaf: state.tab,
    items: [['chat', '#'], ['history', '#'], ['settings', '#']],
    active: state.tab,
    onNav: (label) => navTo(label),
  });

  const crumbRight = state.tab === 'chat'
    ? [
        Select({
          key: 'modelsel',
          value: state.selectedModel,
          placeholder: '— model —',
          options: state.models.map(m => ({ value: m.id, label: m.id })),
          onChange: (v) => { state.selectedModel = v; render(); },
        }),
        state.chat.busy
          ? Btn({ key: 'stop', onClick: cancelChat, children: '◼ stop' })
          : Btn({ key: 'new',  onClick: newChat,    children: '+ new' }),
        dot,
      ]
    : [dot];

  const crumb = Crumb({
    trail: ['agentgui'],
    leaf: state.tab,
    right: crumbRight,
  });

  const navSide = Side({
    sections: [
      {
        group: 'navigate',
        items: [
          { glyph: '▣', label: 'chat',     key: 'chat',     active: state.tab === 'chat',
            onClick: (e) => { e.preventDefault(); navTo('chat'); } },
          { glyph: '§', label: 'history',  key: 'history',  active: state.tab === 'history',
            onClick: (e) => { e.preventDefault(); navTo('history'); } },
          { glyph: '⌘', label: 'settings', key: 'settings', active: state.tab === 'settings',
            onClick: (e) => { e.preventDefault(); navTo('settings'); } },
        ],
      },
    ],
  });
  const side = state.tab === 'history' ? historySide() : navSide;

  const status = Status({
    left: [state.backend, ok ? '● live' : '○ offline', state.cwd || state.health.cwd || ''],
    right: [state.selectedModel ? '⌘ ' + state.selectedModel : '○ no model'],
  });

  return AppShell({ topbar, crumb, side, main: mainContent(), status });
}

function mainContent() {
  if (state.tab === 'chat')    return chatMain();
  if (state.tab === 'history') return historyMain();
  return settingsMain();
}

// ── chat ───────────────────────────────────────────────────────────────────
function chatMain() {
  const lastIdx = state.chat.messages.length - 1;
  const msgs = state.chat.messages.map((m, i) => {
    const isAssistant = m.role === 'assistant';
    const isStreaming = state.chat.busy && i === lastIdx && isAssistant;
    const isEmptyStreaming = isStreaming && !m.content;
    return {
      key: String(i),
      who: isAssistant ? 'them' : 'you',
      name: isAssistant ? (state.selectedModel || 'agent') : 'you',
      time: m.time || '',
      typing: isEmptyStreaming,
      parts: isEmptyStreaming
        ? undefined
        : [{ kind: isAssistant ? 'md' : 'text', text: m.content || '' }],
    };
  });

  const composer = ChatComposer({
    value: state.chat.draft,
    disabled: state.chat.busy,
    placeholder: state.selectedModel ? 'message…' : 'choose a model first',
    onInput: (v) => { state.chat.draft = v; render(); },
    onSend: (v) => { state.chat.draft = v; sendChat(); },
  });

  const resumeBanner = state.chat.resumeSid
    ? h('div', { key: 'rb', style: 'padding:.5em .75em;background:rgba(80,200,120,.1);border-radius:4px;display:flex;justify-content:space-between;align-items:center;margin-bottom:.5em' },
        h('span', { class: 'lede' }, '▶ resuming session ' + state.chat.resumeSid.slice(0, 8) + '… via claude --resume'),
        Btn({ key: 'rclr', onClick: () => { state.chat.resumeSid = null; render(); }, children: '× clear' }))
    : null;
  return [
    resumeBanner,
    Chat({
      title: (state.selectedModel || 'agent') + (state.chat.resumeSid ? ' · resume' : ''),
      sub: state.chat.busy ? 'streaming…' : (state.chat.messages.length + ' messages'),
      messages: msgs,
      composer,
    }),
  ].filter(Boolean);
}

function newChat() {
  state.chat.abort?.abort();
  state.chat = { messages: [], busy: false, abort: null, draft: '', resumeSid: null };
  render();
}

function cancelChat() { state.chat.abort?.abort(); }

async function sendChat() {
  const text = (state.chat.draft || '').trim();
  if (!text || !state.selectedModel || state.chat.busy) return;
  const t = timeNow();
  state.chat.messages.push({ role: 'user', content: text, time: t });
  state.chat.messages.push({ role: 'assistant', content: '', time: t });
  state.chat.draft = '';
  state.chat.busy = true;
  const ctrl = new AbortController();
  state.chat.abort = ctrl;
  render();
  const cur = state.chat.messages[state.chat.messages.length - 1];
  try {
    for await (const ev of B.streamChat(state.backend, {
      model: state.selectedModel,
      messages: state.chat.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
      signal: ctrl.signal,
      resumeSid: state.chat.resumeSid || undefined,
      cwd: state.cwd || undefined,
    })) {
      if (ev.type === 'text')  { cur.content += ev.text; render(); }
      if (ev.type === 'error') { cur.content += '\n[error] ' + JSON.stringify(ev.error); render(); }
    }
  } catch (e) {
    if (e.name !== 'AbortError') cur.content += '\n[error] ' + e.message;
  } finally {
    state.chat.busy = false;
    state.chat.abort = null;
    render();
  }
}

// ── history ────────────────────────────────────────────────────────────────
function historyMain() {
  if (!state.selectedSid) {
    return [PageHeader({
      title: '§ history',
      lede: 'pick a session from the sidebar — events stream live from ccsniff /v1/history.',
    })];
  }

  const sess = (Array.isArray(state.sessions) ? state.sessions : []).find(s => s.sid === state.selectedSid);
  const lede = sess
    ? (sess.project || sess.cwd || '?') + ' · ' + (sess.events || 0) + ' events · ' + (sess.userTurns || 0) + ' turns · ' + fmtRelTime(sess.last)
    : state.selectedSid;

  const head = PageHeader({
    title: '§ ' + (sess?.title || state.selectedSid).slice(0, 80),
    lede,
  });

  const actions = h('div', { key: 'acts', style: 'display:flex;gap:.5em;padding:0 0 .75em 0' },
    Btn({ key: 'resume', primary: true, onClick: () => resumeInChat(sess || { sid: state.selectedSid }), children: '▶ open in chat' }),
    Btn({ key: 'copy', onClick: () => { try { navigator.clipboard.writeText(state.selectedSid); } catch {} }, children: '⎘ copy sid' }),
  );

  if (state.events.length === 0) {
    return [head, actions, Panel({ title: 'events', children: h('p', { class: 'lede' }, '◌ loading…') })];
  }

  return [
    head,
    actions,
    Panel({
      title: state.events.length + ' events',
      children: EventList({
        items: state.events.slice(-300).map((e, i) => {
          const role = e.role || '?';
          const type = e.type || '?';
          const tool = e.tool ? ' · ⌘ ' + e.tool : '';
          const errMark = e.isError ? ' · ⚠' : '';
          const text = (e.text || '').replace(/\s+/g, ' ').trim();
          return {
            key: 'ev' + (e.i ?? i),
            code: String((e.i ?? i) + 1).padStart(4, '0'),
            title: text.slice(0, 220) || '(' + type + ')',
            sub: new Date(e.ts).toLocaleString() + ' · ' + role + ' · ' + type + tool + errMark,
          };
        }),
      }),
    }),
  ];
}

function resumeInChat(sess) {
  state.tab = 'chat';
  closeLiveStream();
  state.chat.resumeSid = sess?.sid || state.selectedSid;
  state.chat.messages = [];
  state.chat.draft = '';
  // Default to claude-code if no model yet (only claude supports --resume by sid here).
  if (!state.selectedModel || state.selectedModel !== 'claude-code') state.selectedModel = 'claude-code';
  render();
}

function visibleSessions() {
  const arr = Array.isArray(state.sessions) ? state.sessions : [];
  let filtered = state.showSubagents ? arr : arr.filter(s => !s.isSubagent);
  if (state.projectFilter) {
    const pf = state.projectFilter.toLowerCase();
    filtered = filtered.filter(s => (s.project || '').toLowerCase().includes(pf));
  }
  return filtered.slice().sort((a, b) => (b.last || 0) - (a.last || 0));
}

function uniqueProjects() {
  const arr = Array.isArray(state.sessions) ? state.sessions : [];
  const seen = new Map();
  for (const s of arr) {
    if (!s.project) continue;
    seen.set(s.project, (seen.get(s.project) || 0) + 1);
  }
  return Array.from(seen.entries()).sort((a, b) => b[1] - a[1]);
}

function historySide() {
  const searching = !!state.searchHits;
  const sessionsView = visibleSessions();
  const limit = state.sessionsLimit;
  const visible = searching ? state.searchHits.results.slice(0, 60) : sessionsView.slice(0, limit);
  const truncatedBy = searching ? Math.max(0, state.searchHits.results.length - 60) : Math.max(0, sessionsView.length - limit);
  const rows = searching
    ? visible.map((r, i) =>
        Row({
          key: 'sr' + i,
          rank: String(i + 1).padStart(3, '0'),
          title: r.snippet || '(no snippet)',
          sub: (r.project || '?') + ' · ' + (r.role || '?') + (r.tool ? ' · ' + r.tool : ''),
          rail: 'purple',
          onClick: () => loadSession(r.sid),
        })
      )
    : visible.map((s, i) =>
        Row({
          key: 'sess' + s.sid,
          rank: String(i + 1).padStart(3, '0'),
          title: (s.isSubagent ? '↳ ' : '') + (s.title || s.project || s.sid),
          sub: fmtRelTime(s.last) + ' · ' + (s.events || 0) + ' ev · ' + (s.tools || 0) + ' tools' + (s.errors ? ' · ' + s.errors + ' err' : ''),
          rail: s.errors ? 'flame' : (s.isSubagent ? 'purple' : 'green'),
          active: s.sid === state.selectedSid,
          onClick: () => loadSession(s.sid),
        })
      );
  const subagentCount = (Array.isArray(state.sessions) ? state.sessions : []).filter(s => s.isSubagent).length;
  const projects = uniqueProjects();

  return [
    Side({
      sections: [
        {
          group: 'navigate',
          items: [
            { glyph: '▣', label: 'chat',     key: 'chat',     onClick: (e) => { e.preventDefault(); navTo('chat'); } },
            { glyph: '§', label: 'history',  key: 'history',  active: true },
            { glyph: '⌘', label: 'settings', key: 'settings', onClick: (e) => { e.preventDefault(); navTo('settings'); } },
          ],
        },
      ],
    }),
    Panel({
      title: searching ? 'matches' : ('sessions · ' + sessionsView.length + (subagentCount && !state.showSubagents ? ' (+'+subagentCount+' sub)' : '')),
      children: [
        SearchInput({
          key: 'searchInput',
          placeholder: 'search sessions…',
          value: state.searchQ,
          onInput: (v) => { state.searchQ = v; runSearch(); },
        }),
        state.searchQ && searching
          ? Btn({ key: 'clearq', onClick: () => { state.searchQ = ''; state.searchHits = null; render(); }, children: '× clear search' })
          : null,
        !searching && projects.length > 1
          ? h('div', { key: 'projfilter', style: 'display:flex;flex-wrap:wrap;gap:.25em;padding:.25em 0' },
              h('span', { key: 'allp', class: 'lede', style: 'cursor:pointer;padding:.15em .5em;border-radius:3px;' + (!state.projectFilter ? 'background:rgba(80,200,120,.15)' : ''), onClick: () => { state.projectFilter = ''; render(); } }, 'all'),
              ...projects.slice(0, 8).map(([name, count]) =>
                h('span', { key: 'p'+name, class: 'lede', style: 'cursor:pointer;padding:.15em .5em;border-radius:3px;' + (state.projectFilter === name ? 'background:rgba(80,200,120,.15)' : ''), title: name, onClick: () => { state.projectFilter = state.projectFilter === name ? '' : name; render(); } }, (name.length > 20 ? name.slice(0, 20) + '…' : name) + ' (' + count + ')')))
          : null,
        !searching && subagentCount
          ? h('label', { key: 'subtog', class: 'lede', style: 'display:flex;gap:.5em;align-items:center;padding:.25em 0' },
              h('input', { type: 'checkbox', checked: state.showSubagents, onChange: (e) => { state.showSubagents = e.target.checked; render(); } }),
              'show subagents (' + subagentCount + ')')
          : null,
        state.historyError
          ? h('p', { key: 'err', class: 'lede' }, '⚠ ' + state.historyError)
          : (rows.length ? h('div', { key: 'rows' }, ...rows) : h('p', { key: 'empty', class: 'lede' }, 'no sessions yet')),
        !searching && truncatedBy > 0
          ? Btn({ key: 'more', onClick: () => { state.sessionsLimit += 60; render(); }, children: '↓ show '+Math.min(60, truncatedBy)+' more ('+truncatedBy+' hidden)' })
          : null,
      ],
    }),
  ];
}

// ── settings ───────────────────────────────────────────────────────────────
function settingsMain() {
  const ok = state.health.status === 'ok';
  return [
    PageHeader({
      title: '⌘ settings',
      lede: 'point agentgui at any backend and choose where agents are spawned.',
    }),
    Panel({
      title: 'agent working directory',
      children: [
        TextField({
          key: 'cwdField',
          label: 'spawn cwd',
          value: state.cwdDraft,
          placeholder: state.health.cwd || '/home/pi/Documents',
          onInput: (v) => { state.cwdDraft = v; render(); },
        }),
        h('p', { key: 'cwdHelp', class: 'lede' }, 'Current: ' + (state.cwd || state.health.cwd || '(server default)')),
        Btn({
          key: 'cwdSave',
          primary: true,
          onClick: (e) => {
            e.preventDefault();
            state.cwd = (state.cwdDraft || '').trim();
            if (state.cwd) localStorage.setItem(CWD_KEY, state.cwd);
            else localStorage.removeItem(CWD_KEY);
            render();
          },
          children: 'save cwd',
        }),
      ],
    }),
    Panel({
      title: 'backend',
      children: [
        TextField({
          key: 'backendField',
          label: 'backend url',
          value: state.backendDraft,
          placeholder: '(blank = same origin)',
          onInput: (v) => { state.backendDraft = v; render(); },
        }),
        h('p', { key: 'hp', class: 'lede' }, (ok ? '● ' : '○ ') + JSON.stringify(state.health)),
        Btn({
          key: 'savebtn',
          primary: true,
          onClick: (e) => {
            e.preventDefault();
            B.setBackend(state.backendDraft);
            state.backend = state.backendDraft;
            state.health = { status: 'unknown' };
            render();
            init();
          },
          children: 'save + reconnect',
        }),
      ],
    }),
    Panel({
      title: 'models',
      children: state.models.length
        ? state.models.slice(0, 40).map((m, i) =>
            Row({
              key: 'm' + i,
              rank: String(i + 1).padStart(3, '0'),
              title: m.id,
              sub: m.name ? (m.name + ' · ' + (m.protocol || 'agent')) : (m.protocol || 'agent'),
              rail: m.id === state.selectedModel ? 'green' : 'purple',
              onClick: () => { state.selectedModel = m.id; render(); },
            })
          )
        : h('p', { key: 'none', class: 'lede' }, 'no models loaded'),
    }),
  ];
}

// ── data ──────────────────────────────────────────────────────────────────
async function refreshHistory() {
  try {
    state.sessions = await B.listSessions(state.backend);
    state.historyError = null;
    render();
  } catch (e) {
    state.historyError = e.message;
    console.warn('history fetch failed:', e.message);
    render();
  }
}

async function runSearch() {
  if (!state.searchQ.trim()) { state.searchHits = null; render(); return; }
  try {
    state.searchHits = await B.searchHistory(state.backend, state.searchQ, 50);
    render();
  } catch (e) {
    state.searchHits = { query: state.searchQ, results: [], error: e.message };
    render();
  }
}

async function loadSession(sid) {
  state.selectedSid = sid;
  state.events = [];
  writeHash(sid);
  render();
  try { state.events = await B.getSessionEvents(state.backend, sid); render(); }
  catch (e) {
    state.events = [{ ts: Date.now(), role: 'error', type: 'fetch', text: e.message }];
    render();
  }
}

async function init() {
  try {
    const r = await B.probeBackend(state.backend);
    state.health = r.ok ? { status: 'ok', ...r.info } : { status: 'down', ...r };
    if (r.ok && !state.cwd && !state.cwdDraft && r.info?.cwd) state.cwdDraft = r.info.cwd;
  } catch (e) {
    state.health = { status: 'error', error: e.message };
  }
  render();
  try {
    state.models = await B.listModels(state.backend);
    if (!state.selectedModel && state.models[0]) state.selectedModel = state.models[0].id;
    render();
  } catch (e) { console.warn('models fetch failed:', e.message); }

  const initialSid = readHash();
  if (initialSid) {
    navTo('history');
    await refreshHistory();
    await loadSession(initialSid);
  }

  B.onWsStatus?.((s) => {
    if (s === 'closed' || s === 'error') {
      if (state.health.status === 'ok') { state.health = { ...state.health, ws: 'reconnecting' }; render(); }
    } else if (s === 'open') {
      if (state.health.ws) { delete state.health.ws; render(); }
    }
  });
}

render = mount(document.getElementById('app'), view);
window.__agentgui = { state, render };
init();
