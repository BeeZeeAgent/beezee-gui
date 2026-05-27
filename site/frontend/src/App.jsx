import React, { useState, useEffect, useRef, useCallback, useReducer } from 'react';
import * as B from './backend.js';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { Sheet, SheetContent, SheetTrigger, SheetTitle } from '@/components/ui/sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  MessageSquare, History, Settings, Menu, Square, Plus, Search, X,
  Wifi, WifiOff, Loader2, SendHorizontal, AlertTriangle, RefreshCw,
  Copy, Play, Bot,
} from 'lucide-react';
import { cn } from '@/lib/utils';

const BeeZeeLogo = ({ className }) => (
  <svg className={className} viewBox="0 0 37 37.4" xmlns="http://www.w3.org/2000/svg">
    <g transform="translate(-49.89,-134.66)">
      <path style={{fill:'#2b2200',stroke:'#000',strokeWidth:0.26}} d="m 50.04,150.86 9.09,-15.68 17.86,-0.4 9.72,16.06 -9,15.67 -15.9,-0.15 -5.67,5.26 1.58,-7.61 z"/>
      <path style={{fill:'#ff0',stroke:'#000',strokeWidth:0.26}} d="m 60.52,164.14 15.7,0.35 1.57,-2.93 -15.41,-0.35 -7.95,-13.19 -1.95,2.88 z"/>
      <path style={{fill:'#ff0',stroke:'#000',strokeWidth:0.26}} d="m 81.12,155.89 -1.98,3.17 -15.32,-0.23 -7.93,-13.43 1.69,-2.95 7.79,13.12 z"/>
      <path style={{fill:'#ff0',stroke:'#000',strokeWidth:0.26}} d="m 59.19,139.81 1.32,-2.49 15.64,-0.15 7.8,13.53 -1.47,2.62 -15.74,-0.2 -7.54,-13.3"/>
      <ellipse style={{fill:'#000',strokeWidth:0.26}} cx="85.19" cy="-132.79" rx="1.49" ry="2.54" transform="rotate(121.61)"/>
      <ellipse style={{fill:'#000',strokeWidth:0.26}} cx="81.59" cy="-139.09" rx="1.49" ry="2.54" transform="rotate(121.61)"/>
      <path style={{fill:'#000',strokeWidth:0.26}} d="m 72.18,146.82 a 2.54,1.49 31.61 0 0 1.25,1.23 2.54,1.49 31.61 0 0 2.94,0.07 2.54,1.49 31.61 0 0 -0.09,-1.29 z"/>
      <path style={{fill:'#aef',stroke:'#000',strokeWidth:0.18}} d="m 57.13,169.88 1.09,-5.24 0.91,1.52 1.91,0.1 -3.91,3.63"/>
    </g>
  </svg>
);

const CWD_KEY = 'agentgui.cwd';

function fmtRelTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s / 60) + 'm ago';
  if (s < 86400) return Math.round(s / 3600) + 'h ago';
  return Math.round(s / 86400) + 'd ago';
}

function timeNow() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function readHash() {
  const m = (location.hash || '').match(/sid=([^&]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function writeHash(sid) {
  const h = sid ? '#sid=' + encodeURIComponent(sid) : '';
  if (location.hash !== h) history.replaceState(null, '', location.pathname + location.search + h);
}

// Simple markdown renderer (no deps)
function renderMarkdown(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br/>');
}

// ─── Nav items ─────────────────────────────────────────────────────────────
const NAV_ITEMS = [
  { id: 'chat', label: 'Chat', Icon: MessageSquare },
  { id: 'history', label: 'History', Icon: History },
  { id: 'settings', label: 'Settings', Icon: Settings },
];

// ─── Sidebar nav list ──────────────────────────────────────────────────────
function NavList({ tab, onNav, onClose }) {
  return (
    <nav className="flex flex-col gap-1 p-2">
      {NAV_ITEMS.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => { onNav(id); onClose?.(); }}
          className={cn(
            'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors text-left w-full',
            tab === id
              ? 'bg-sidebar-accent text-sidebar-accent-foreground'
              : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
          )}
        >
          <Icon className="h-4 w-4 shrink-0" />
          {label}
        </button>
      ))}
    </nav>
  );
}

// ─── Desktop sidebar ───────────────────────────────────────────────────────
function DesktopSidebar({ tab, onNav, health, live }) {
  const ok = health.status === 'ok';
  return (
    <aside className="hidden lg:flex w-56 shrink-0 flex-col border-r border-sidebar-border bg-sidebar h-screen sticky top-0">
      <div className="flex items-center gap-2 px-4 py-4 border-b border-sidebar-border">
        <BeeZeeLogo className="h-7 w-7" />
        <span className="font-semibold text-sidebar-foreground tracking-tight">BeeZee</span>
      </div>
      <ScrollArea className="flex-1">
        <NavList tab={tab} onNav={onNav} />
      </ScrollArea>
      <div className="px-4 py-3 border-t border-sidebar-border">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {ok
            ? <Wifi className="h-3 w-3 text-green-500" />
            : <WifiOff className="h-3 w-3 text-red-500" />}
          <span className="truncate">{ok ? (health.ws === 'reconnecting' ? 'ws reconnecting…' : 'connected') : 'offline'}</span>
        </div>
        {tab === 'history' && live.connected && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground mt-1">
            <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
            <span>live · {live.eventCount} events</span>
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── Mobile header ─────────────────────────────────────────────────────────
function MobileHeader({ tab, onNav, health }) {
  const [open, setOpen] = useState(false);
  const ok = health.status === 'ok';
  const current = NAV_ITEMS.find(n => n.id === tab);
  return (
    <header className="lg:hidden flex items-center gap-3 px-4 py-3 border-b border-border bg-background sticky top-0 z-40">
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>
          <Button variant="ghost" size="icon" className="shrink-0">
            <Menu className="h-5 w-5" />
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-64 p-0 bg-sidebar border-sidebar-border">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex items-center gap-2 px-4 py-4 border-b border-sidebar-border">
            <BeeZeeLogo className="h-7 w-7" />
            <span className="font-semibold text-sidebar-foreground">BeeZee</span>
          </div>
          <NavList tab={tab} onNav={onNav} onClose={() => setOpen(false)} />
        </SheetContent>
      </Sheet>
      <span className="font-medium text-sm flex-1">{current?.label ?? tab}</span>
      <div className="flex items-center gap-1.5">
        {ok
          ? <Wifi className="h-3.5 w-3.5 text-green-500" />
          : <WifiOff className="h-3.5 w-3.5 text-red-500" />}
      </div>
    </header>
  );
}

// ─── Chat tab ──────────────────────────────────────────────────────────────
function ChatTab({ state, dispatch, models, selectedModel, setSelectedModel }) {
  const bottomRef = useRef(null);
  const textareaRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages]);

  const handleSend = () => {
    const text = (state.draft || '').trim();
    if (!text || !selectedModel || state.busy) return;
    dispatch({ type: 'SEND', text });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <div className="flex-1 min-w-0">
          <Select value={selectedModel} onValueChange={setSelectedModel}>
            <SelectTrigger className="h-8 text-xs w-full max-w-xs">
              <SelectValue placeholder="— select model —" />
            </SelectTrigger>
            <SelectContent>
              {models.map(m => (
                <SelectItem key={m.id} value={m.id} className="text-xs">{m.id}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {state.resumeSid && (
          <Badge variant="outline" className="text-xs gap-1 shrink-0">
            <Play className="h-3 w-3" />
            resuming {state.resumeSid.slice(0, 8)}…
            <button onClick={() => dispatch({ type: 'CLEAR_RESUME' })} className="ml-1 hover:text-destructive">
              <X className="h-3 w-3" />
            </button>
          </Badge>
        )}
        {state.busy
          ? <Button size="sm" variant="outline" onClick={() => dispatch({ type: 'CANCEL' })} className="shrink-0 h-8 gap-1.5">
              <Square className="h-3.5 w-3.5" /> Stop
            </Button>
          : <Button size="sm" onClick={() => dispatch({ type: 'NEW' })} className="shrink-0 h-8 gap-1.5 bg-yellow-400 text-black hover:bg-yellow-500">
              <Plus className="h-3.5 w-3.5" /> New
            </Button>
        }
      </div>

      {/* messages */}
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-4 p-4 pb-2">
          {state.messages.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
              <Bot className="h-12 w-12 opacity-30" />
              <p className="text-sm">{selectedModel ? 'Start a conversation' : 'Select a model to begin'}</p>
            </div>
          )}
          {state.messages.map((msg, i) => {
            const isAssistant = msg.role === 'assistant';
            const isStreaming = state.busy && i === state.messages.length - 1 && isAssistant;
            return (
              <div key={i} className={cn('flex gap-3', isAssistant ? 'justify-start' : 'justify-end')}>
                {isAssistant && (
                  <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                    <Bot className="h-4 w-4 text-primary" />
                  </div>
                )}
                <div className={cn(
                  'max-w-[80%] rounded-xl px-4 py-2.5 text-sm',
                  isAssistant
                    ? 'bg-muted text-foreground rounded-tl-sm'
                    : 'bg-primary text-primary-foreground rounded-tr-sm'
                )}>
                  {isStreaming && !msg.content
                    ? <Loader2 className="h-4 w-4 animate-spin" />
                    : isAssistant
                      ? <div className="prose-chat" dangerouslySetInnerHTML={{ __html: renderMarkdown(msg.content) }} />
                      : <p className="whitespace-pre-wrap">{msg.content}</p>
                  }
                  {msg.time && <p className="text-[10px] opacity-50 mt-1 text-right">{msg.time}</p>}
                </div>
              </div>
            );
          })}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* composer */}
      <div className="px-4 py-3 border-t border-border shrink-0">
        <div className="flex gap-2 items-end">
          <Textarea
            ref={textareaRef}
            value={state.draft}
            onChange={e => dispatch({ type: 'DRAFT', text: e.target.value })}
            onKeyDown={handleKeyDown}
            placeholder={selectedModel ? 'Message… (Enter to send, Shift+Enter for newline)' : 'Choose a model first'}
            disabled={state.busy || !selectedModel}
            rows={1}
            className="resize-none min-h-[40px] max-h-[200px] py-2.5 flex-1"
            style={{ height: 'auto' }}
            onInput={e => {
              e.target.style.height = 'auto';
              e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px';
            }}
          />
          <Button
            onClick={handleSend}
            disabled={!state.draft.trim() || !selectedModel || state.busy}
            size="icon"
            className="h-10 w-10 shrink-0"
          >
            <SendHorizontal className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── History tab ───────────────────────────────────────────────────────────
function HistoryTab({ sessions, selectedSid, events, historyError, searchQ, setSearchQ,
  searchHits, showSubagents, setShowSubagents, sessionsLimit, setSessionsLimit,
  projectFilter, setProjectFilter, live, onSelectSession, onResumeInChat }) {

  const [localQ, setLocalQ] = useState(searchQ);
  const debounceRef = useRef(null);

  const handleSearch = (v) => {
    setLocalQ(v);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearchQ(v), 300);
  };

  const visibleSessions = (() => {
    let arr = Array.isArray(sessions) ? sessions : [];
    if (!showSubagents) arr = arr.filter(s => !s.isSubagent);
    if (projectFilter) {
      const pf = projectFilter.toLowerCase();
      arr = arr.filter(s => (s.project || '').toLowerCase().includes(pf));
    }
    return arr.slice().sort((a, b) => (b.last || 0) - (a.last || 0));
  })();

  const uniqueProjects = (() => {
    const arr = Array.isArray(sessions) ? sessions : [];
    const seen = new Map();
    for (const s of arr) {
      if (!s.project) continue;
      seen.set(s.project, (seen.get(s.project) || 0) + 1);
    }
    return Array.from(seen.entries()).sort((a, b) => b[1] - a[1]);
  })();

  const subagentCount = (Array.isArray(sessions) ? sessions : []).filter(s => s.isSubagent).length;
  const searching = !!searchHits;
  const visible = searching ? (searchHits.results || []).slice(0, 60) : visibleSessions.slice(0, sessionsLimit);
  const truncatedBy = searching
    ? Math.max(0, (searchHits.results || []).length - 60)
    : Math.max(0, visibleSessions.length - sessionsLimit);

  const sess = (Array.isArray(sessions) ? sessions : []).find(s => s.sid === selectedSid);

  return (
    <div className="flex h-full overflow-hidden">
      {/* session list panel */}
      <div className="w-full lg:w-72 xl:w-80 shrink-0 flex flex-col border-r border-border h-full overflow-hidden">
        <div className="p-3 border-b border-border space-y-2 shrink-0">
          <div className="flex items-center gap-2">
            {live.connected
              ? <span className="h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse shrink-0" />
              : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground shrink-0" />}
            <span className="text-xs text-muted-foreground truncate">
              {live.error ? live.error : (live.connected ? `live · ${live.eventCount}` : 'connecting…')}
            </span>
          </div>
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={localQ}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Search sessions…"
              className="pl-8 h-8 text-xs"
            />
            {localQ && (
              <button onClick={() => { setLocalQ(''); setSearchQ(''); }} className="absolute right-2 top-1/2 -translate-y-1/2">
                <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
              </button>
            )}
          </div>

          {!searching && uniqueProjects.length > 1 && (
            <div className="flex flex-wrap gap-1">
              <button
                onClick={() => setProjectFilter('')}
                className={cn('text-xs px-2 py-0.5 rounded-full border transition-colors',
                  !projectFilter ? 'bg-primary/10 border-primary/30 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
              >
                all
              </button>
              {uniqueProjects.slice(0, 6).map(([name, count]) => (
                <button
                  key={name}
                  onClick={() => setProjectFilter(projectFilter === name ? '' : name)}
                  title={name}
                  className={cn('text-xs px-2 py-0.5 rounded-full border transition-colors truncate max-w-[100px]',
                    projectFilter === name ? 'bg-primary/10 border-primary/30 text-primary' : 'border-border text-muted-foreground hover:text-foreground')}
                >
                  {name.length > 16 ? name.slice(0, 16) + '…' : name} ({count})
                </button>
              ))}
            </div>
          )}

          {!searching && subagentCount > 0 && (
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showSubagents}
                onChange={e => setShowSubagents(e.target.checked)}
                className="rounded"
              />
              Show subagents ({subagentCount})
            </label>
          )}

          <p className="text-xs text-muted-foreground">
            {searching ? `${(searchHits.results || []).length} match${(searchHits.results || []).length !== 1 ? 'es' : ''}` : `${visibleSessions.length} session${visibleSessions.length !== 1 ? 's' : ''}`}
            {subagentCount && !showSubagents ? ` (+${subagentCount} sub)` : ''}
          </p>
        </div>

        <ScrollArea className="flex-1">
          <div className="p-2 flex flex-col gap-0.5">
            {historyError && (
              <div className="flex items-center gap-2 text-xs text-destructive p-2">
                <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                {historyError}
              </div>
            )}
            {visible.length === 0 && !historyError && (
              <p className="text-xs text-muted-foreground p-2">No sessions yet</p>
            )}
            {visible.map((s, i) => {
              const isSearch = searching;
              const sid = s.sid;
              const title = isSearch ? (s.snippet || '(no snippet)') : ((s.isSubagent ? '↳ ' : '') + (s.title || s.project || s.sid));
              const sub = isSearch
                ? (s.project || '?') + ' · ' + (s.role || '?') + (s.tool ? ' · ' + s.tool : '')
                : fmtRelTime(s.last) + ' · ' + (s.events || 0) + ' ev · ' + (s.tools || 0) + ' tools' + (s.errors ? ' · ' + s.errors + ' err' : '');
              const rail = s.errors ? 'flame' : (s.isSubagent ? 'purple' : 'green');

              return (
                <button
                  key={sid + i}
                  onClick={() => onSelectSession(sid)}
                  className={cn(
                    'flex items-start gap-2.5 rounded-md px-2.5 py-2 text-left w-full transition-colors group',
                    selectedSid === sid
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50 text-muted-foreground hover:text-foreground'
                  )}
                >
                  <span className={cn('h-1.5 w-1.5 rounded-full shrink-0 mt-1.5',
                    rail === 'flame' ? 'bg-orange-400' : rail === 'purple' ? 'bg-purple-400' : 'bg-green-400'
                  )} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate leading-tight">{title}</p>
                    <p className="text-[10px] text-muted-foreground truncate mt-0.5">{sub}</p>
                  </div>
                  <span className="text-[10px] text-muted-foreground opacity-0 group-hover:opacity-100 shrink-0">
                    {String(i + 1).padStart(3, '0')}
                  </span>
                </button>
              );
            })}
            {truncatedBy > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs w-full mt-1"
                onClick={() => setSessionsLimit(l => l + 60)}
              >
                ↓ Show {Math.min(60, truncatedBy)} more ({truncatedBy} hidden)
              </Button>
            )}
          </div>
        </ScrollArea>
      </div>

      {/* event detail panel — hidden on mobile when session list is showing */}
      {selectedSid && (
        <div className="hidden lg:flex flex-col flex-1 min-w-0 h-full overflow-hidden">
          <div className="px-5 py-4 border-b border-border shrink-0">
            <h2 className="font-semibold text-sm truncate">
              {(sess?.title || selectedSid).slice(0, 80)}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {sess
                ? (sess.project || sess.cwd || '?') + ' · ' + (sess.events || 0) + ' events · ' + (sess.userTurns || 0) + ' turns · ' + fmtRelTime(sess.last)
                : selectedSid}
            </p>
            <div className="flex gap-2 mt-3">
              <Button size="sm" onClick={() => onResumeInChat(sess || { sid: selectedSid })} className="h-8 gap-1.5 text-xs">
                <Play className="h-3.5 w-3.5" /> Open in chat
              </Button>
              <Button size="sm" variant="outline" onClick={() => { try { navigator.clipboard.writeText(selectedSid); } catch {} }} className="h-8 gap-1.5 text-xs">
                <Copy className="h-3.5 w-3.5" /> Copy SID
              </Button>
            </div>
          </div>
          <ScrollArea className="flex-1">
            {events.length === 0
              ? <div className="flex items-center gap-2 p-5 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading events…
                </div>
              : <div className="p-3 flex flex-col gap-0.5">
                  {events.slice(-300).map((e, i) => {
                    const role = e.role || '?';
                    const type = e.type || '?';
                    const tool = e.tool ? ' · ' + e.tool : '';
                    const text = (e.text || '').replace(/\s+/g, ' ').trim();
                    return (
                      <div key={'ev' + (e.i ?? i)} className={cn(
                        'flex gap-3 rounded-md px-3 py-2 text-xs',
                        e.isError ? 'bg-destructive/10' : 'hover:bg-muted/50'
                      )}>
                        <span className="text-muted-foreground font-mono shrink-0 select-none">
                          {String((e.i ?? i) + 1).padStart(4, '0')}
                        </span>
                        <div className="flex-1 min-w-0">
                          <p className="truncate text-foreground">{text.slice(0, 220) || '(' + type + ')'}</p>
                          <p className="text-muted-foreground mt-0.5">
                            {new Date(e.ts).toLocaleString()} · {role} · {type}{tool}
                            {e.isError && <span className="text-destructive ml-1">⚠ error</span>}
                          </p>
                        </div>
                      </div>
                    );
                  })}
                </div>
            }
          </ScrollArea>
        </div>
      )}

      {!selectedSid && (
        <div className="hidden lg:flex flex-col flex-1 items-center justify-center text-muted-foreground gap-3">
          <History className="h-12 w-12 opacity-20" />
          <p className="text-sm">Select a session from the list</p>
        </div>
      )}
    </div>
  );
}

// ─── Settings tab ──────────────────────────────────────────────────────────
function SettingsTab({ backend, setBackend, health, cwd, setCwd, models, selectedModel, setSelectedModel, onReconnect }) {
  const [backendDraft, setBackendDraft] = useState(backend);
  const [cwdDraft, setCwdDraft] = useState(cwd);
  const ok = health.status === 'ok';

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-8 max-w-2xl">
        <div>
          <h1 className="text-lg font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground mt-1">Configure backend and agent defaults.</p>
        </div>

        <div className="space-y-4">
          <h2 className="text-sm font-medium">Backend</h2>
          <div className="space-y-2">
            <Label htmlFor="backend-url">Backend URL</Label>
            <Input
              id="backend-url"
              value={backendDraft}
              onChange={e => setBackendDraft(e.target.value)}
              placeholder="(blank = same origin)"
            />
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {ok
              ? <Wifi className="h-3.5 w-3.5 text-green-500" />
              : <WifiOff className="h-3.5 w-3.5 text-red-500" />}
            <code className="font-mono">{JSON.stringify(health)}</code>
          </div>
          <Button
            onClick={() => {
              B.setBackend(backendDraft);
              setBackend(backendDraft);
              onReconnect(backendDraft);
            }}
            className="gap-1.5"
          >
            <RefreshCw className="h-4 w-4" /> Save + reconnect
          </Button>
        </div>

        <Separator />

        <div className="space-y-4">
          <h2 className="text-sm font-medium">Agent working directory</h2>
          <div className="space-y-2">
            <Label htmlFor="cwd">Spawn CWD</Label>
            <Input
              id="cwd"
              value={cwdDraft}
              onChange={e => setCwdDraft(e.target.value)}
              placeholder={health.cwd || '/home/pi/Documents'}
            />
            <p className="text-xs text-muted-foreground">Current: {cwd || health.cwd || '(server default)'}</p>
          </div>
          <Button
            onClick={() => {
              const v = cwdDraft.trim();
              setCwd(v);
              if (v) localStorage.setItem(CWD_KEY, v);
              else localStorage.removeItem(CWD_KEY);
            }}
          >
            Save CWD
          </Button>
        </div>

        <Separator />

        <div className="space-y-4">
          <h2 className="text-sm font-medium">Models / Agents</h2>
          {models.length === 0
            ? <p className="text-sm text-muted-foreground">No models loaded</p>
            : (
              <div className="space-y-1">
                {models.slice(0, 40).map((m, i) => (
                  <button
                    key={m.id}
                    onClick={() => setSelectedModel(m.id)}
                    className={cn(
                      'flex items-center gap-3 w-full rounded-md px-3 py-2 text-sm text-left transition-colors',
                      m.id === selectedModel
                        ? 'bg-primary/10 text-primary'
                        : 'hover:bg-muted text-foreground'
                    )}
                  >
                    <span className="font-mono text-xs text-muted-foreground w-8 shrink-0">
                      {String(i + 1).padStart(3, '0')}
                    </span>
                    <span className="flex-1 font-medium">{m.id}</span>
                    {m.name && <span className="text-xs text-muted-foreground">{m.name}</span>}
                    {m.id === selectedModel && <Badge variant="green" className="text-xs">active</Badge>}
                  </button>
                ))}
              </div>
            )
          }
        </div>
      </div>
    </ScrollArea>
  );
}

// ─── Chat state reducer ─────────────────────────────────────────────────────
function chatReducer(state, action) {
  switch (action.type) {
    case 'NEW':
      state._abort?.abort();
      return { messages: [], busy: false, _abort: null, draft: '', resumeSid: null };
    case 'CANCEL':
      state._abort?.abort();
      return { ...state };
    case 'DRAFT':
      return { ...state, draft: action.text };
    case 'SEND':
      return {
        ...state,
        messages: [
          ...state.messages,
          { role: 'user', content: action.text, time: timeNow() },
          { role: 'assistant', content: '', time: timeNow() },
        ],
        draft: '',
        busy: true,
        _abort: action.ctrl,
      };
    case 'APPEND':
      return {
        ...state,
        messages: state.messages.map((m, i) =>
          i === state.messages.length - 1 ? { ...m, content: m.content + action.text } : m
        ),
      };
    case 'DONE':
      return { ...state, busy: false, _abort: null };
    case 'RESUME':
      return { ...state, resumeSid: action.sid, messages: [], draft: '' };
    case 'CLEAR_RESUME':
      return { ...state, resumeSid: null };
    default:
      return state;
  }
}

// ─── Root App ───────────────────────────────────────────────────────────────
export default function App() {
  const [tab, setTab] = useState('chat');
  const [backend, setBackend] = useState(() => B.getBackend());
  const [health, setHealth] = useState({ status: 'unknown' });
  const [cwd, setCwd] = useState(() => localStorage.getItem(CWD_KEY) || '');
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState('');

  const [chat, dispatchChat] = useReducer(chatReducer, {
    messages: [], busy: false, _abort: null, draft: '', resumeSid: null,
  });

  const [sessions, setSessions] = useState([]);
  const [selectedSid, setSelectedSid] = useState(null);
  const [events, setEvents] = useState([]);
  const [historyError, setHistoryError] = useState(null);
  const [searchQ, setSearchQ] = useState('');
  const [searchHits, setSearchHits] = useState(null);
  const [showSubagents, setShowSubagents] = useState(false);
  const [sessionsLimit, setSessionsLimit] = useState(60);
  const [projectFilter, setProjectFilter] = useState('');
  const [live, setLive] = useState({ es: null, connected: false, lastEventTs: 0, error: null, eventCount: 0, reconnects: 0 });
  const liveRef = useRef(live);
  liveRef.current = live;

  // Streaming chat
  const sendChat = useCallback(async (text) => {
    if (!text || !selectedModel || chat.busy) return;
    const ctrl = new AbortController();
    dispatchChat({ type: 'SEND', text, ctrl });
    const lastMessages = chat.messages;
    try {
      for await (const ev of B.streamChat(backend, {
        model: selectedModel,
        messages: [...lastMessages, { role: 'user', content: text }].map(m => ({ role: m.role, content: m.content })),
        signal: ctrl.signal,
        resumeSid: chat.resumeSid || undefined,
        cwd: cwd || undefined,
      })) {
        if (ev.type === 'text') dispatchChat({ type: 'APPEND', text: ev.text });
        if (ev.type === 'error') dispatchChat({ type: 'APPEND', text: '\n[error] ' + JSON.stringify(ev.error) });
      }
    } catch (e) {
      if (e.name !== 'AbortError') dispatchChat({ type: 'APPEND', text: '\n[error] ' + e.message });
    } finally {
      dispatchChat({ type: 'DONE' });
    }
  }, [backend, selectedModel, cwd, chat.busy, chat.resumeSid, chat.messages]);

  // Intercept SEND to kick off async streaming
  const handleChatDispatch = useCallback((action) => {
    if (action.type === 'SEND') {
      sendChat(action.text);
    } else if (action.type === 'CANCEL') {
      chat._abort?.abort();
      dispatchChat({ type: 'DONE' });
    } else {
      dispatchChat(action);
    }
  }, [sendChat, chat._abort]);

  // History
  const refreshHistory = useCallback(async () => {
    try {
      const s = await B.listSessions(backend);
      setSessions(s);
      setHistoryError(null);
    } catch (e) {
      setHistoryError(e.message);
    }
  }, [backend]);

  const loadSession = useCallback(async (sid) => {
    setSelectedSid(sid);
    setEvents([]);
    writeHash(sid);
    try {
      const evs = await B.getSessionEvents(backend, sid);
      setEvents(evs);
    } catch (e) {
      setEvents([{ ts: Date.now(), role: 'error', type: 'fetch', text: e.message }]);
    }
  }, [backend]);

  // Live stream
  const openLiveStream = useCallback(() => {
    if (liveRef.current.es) return;
    setLive(l => ({ ...l, error: null, connected: false }));
    try {
      const es = B.streamHistory(backend, (kind, data) => {
        setLive(l => ({ ...l, lastEventTs: Date.now(), eventCount: l.eventCount + 1 }));
        if (kind === 'hello') {
          setLive(l => ({ ...l, connected: true, error: null }));
        } else if (kind === 'event' && data) {
          setSelectedSid(sid => {
            if (sid && data.sid === sid) setEvents(evs => [...evs, data]);
            return sid;
          });
          setSessions(arr => {
            const copy = (Array.isArray(arr) ? arr : []).map(s => s.sid === data.sid
              ? { ...s, events: (s.events || 0) + 1, last: data.ts || Date.now(), tools: data.type === 'tool_use' ? (s.tools || 0) + 1 : s.tools, errors: data.isError ? (s.errors || 0) + 1 : s.errors }
              : s);
            const found = copy.find(s => s.sid === data.sid);
            if (!found) { refreshHistory(); }
            return copy;
          });
        } else if (kind === 'conversation') {
          refreshHistory();
        } else if (kind === 'error' && data) {
          setLive(l => ({ ...l, error: data.error || 'stream error' }));
        }
      });
      es.addEventListener('error', () => {
        setLive(l => ({ ...l, connected: false, error: l.error || 'connection lost (auto-retry)' }));
      });
      setLive(l => ({ ...l, es }));
    } catch (e) {
      setLive(l => ({ ...l, error: e.message, es: null }));
    }
  }, [backend, refreshHistory]);

  const closeLiveStream = useCallback(() => {
    setLive(l => {
      if (l.es) { try { l.es.close(); } catch {} }
      return { ...l, es: null, connected: false };
    });
  }, []);

  const navTo = useCallback((t) => {
    const prev = tab;
    setTab(t);
    if (t === 'history') {
      refreshHistory();
      openLiveStream();
    } else if (prev === 'history') {
      closeLiveStream();
    }
  }, [tab, refreshHistory, openLiveStream, closeLiveStream]);

  const resumeInChat = useCallback((sess) => {
    navTo('chat');
    dispatchChat({ type: 'RESUME', sid: sess?.sid || selectedSid });
    setSelectedModel(m => (!m || m !== 'claude-code') ? 'claude-code' : m);
  }, [navTo, selectedSid]);

  // Search
  useEffect(() => {
    if (!searchQ.trim()) { setSearchHits(null); return; }
    B.searchHistory(backend, searchQ, 50)
      .then(h => setSearchHits(h))
      .catch(e => setSearchHits({ query: searchQ, results: [], error: e.message }));
  }, [searchQ, backend]);

  // Init
  useEffect(() => {
    async function init() {
      try {
        const r = await B.probeBackend(backend);
        const newHealth = r.ok ? { status: 'ok', ...r.info } : { status: 'down', ...r };
        setHealth(newHealth);
        if (r.ok && !cwd && r.info?.cwd) setCwd(r.info.cwd);
      } catch (e) {
        setHealth({ status: 'error', error: e.message });
      }
      try {
        const ms = await B.listModels(backend);
        setModels(ms);
        if (ms[0]) setSelectedModel(m => m || ms[0].id);
      } catch (e) {
        console.warn('models fetch failed:', e.message);
      }

      const initialSid = readHash();
      if (initialSid) {
        setTab('history');
        await refreshHistory();
        await loadSession(initialSid);
        openLiveStream();
      }
    }
    init();

    B.onWsStatus?.((s) => {
      setHealth(h => {
        if (s === 'closed' || s === 'error') return h.status === 'ok' ? { ...h, ws: 'reconnecting' } : h;
        if (s === 'open') { const { ws, ...rest } = h; return rest; }
        return h;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleReconnect = useCallback((newBackend) => {
    setHealth({ status: 'unknown' });
    B.probeBackend(newBackend).then(r => {
      setHealth(r.ok ? { status: 'ok', ...r.info } : { status: 'down', ...r });
    }).catch(e => setHealth({ status: 'error', error: e.message }));
    B.listModels(newBackend).then(ms => {
      setModels(ms);
      if (ms[0]) setSelectedModel(m => m || ms[0].id);
    }).catch(() => {});
  }, []);

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <DesktopSidebar tab={tab} onNav={navTo} health={health} live={live} />

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <MobileHeader tab={tab} onNav={navTo} health={health} />

        <main className="flex-1 overflow-hidden">
          {tab === 'chat' && (
            <ChatTab
              state={chat}
              dispatch={handleChatDispatch}
              models={models}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
            />
          )}
          {tab === 'history' && (
            <HistoryTab
              sessions={sessions}
              selectedSid={selectedSid}
              events={events}
              historyError={historyError}
              searchQ={searchQ}
              setSearchQ={setSearchQ}
              searchHits={searchHits}
              showSubagents={showSubagents}
              setShowSubagents={setShowSubagents}
              sessionsLimit={sessionsLimit}
              setSessionsLimit={setSessionsLimit}
              projectFilter={projectFilter}
              setProjectFilter={setProjectFilter}
              live={live}
              onSelectSession={loadSession}
              onResumeInChat={resumeInChat}
            />
          )}
          {tab === 'settings' && (
            <SettingsTab
              backend={backend}
              setBackend={setBackend}
              health={health}
              cwd={cwd}
              setCwd={setCwd}
              models={models}
              selectedModel={selectedModel}
              setSelectedModel={setSelectedModel}
              onReconnect={handleReconnect}
            />
          )}
        </main>
      </div>
    </div>
  );
}
