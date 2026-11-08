import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { RunCard } from './components/Trajectory.tsx';
import { Outline } from './components/Outline.tsx';
import { buildRunView, formatCost } from './model.ts';
import * as api from './api.ts';
import type { StreamEvent, ViewerConfig } from './types.ts';

interface RunEntry {
  localId: number;
  prompt: string;
  source: 'live' | 'replay';
  serverId?: string;
  events: StreamEvent[];
}

const CWD_KEY = 'ctv.cwd';
const readCwd = () => { try { return localStorage.getItem(CWD_KEY) ?? ''; } catch { return ''; } };
const saveCwd = (v: string) => { try { localStorage.setItem(CWD_KEY, v); } catch { /* ignore */ } };

let nextId = 1;

export default function App() {
  const [config, setConfig] = useState<ViewerConfig | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [tokenDraft, setTokenDraft] = useState('');
  const [banner, setBanner] = useState<string | null>(null);

  const [entries, setEntries] = useState<RunEntry[]>([]);
  const [cwd, setCwd] = useState(readCwd);
  const [prompt, setPrompt] = useState('');
  const [continueSession, setContinueSession] = useState(true);

  const [replays, setReplays] = useState<string[]>([]);
  const [replaySpeed, setReplaySpeed] = useState(150);
  const replayTimer = useRef<number | null>(null);
  const unsub = useRef<(() => void) | null>(null);

  const mainRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // ---- bootstrap ----
  const loadConfig = useCallback(async () => {
    try {
      const c = await api.getConfig();
      setConfig(c);
      setNeedsToken(false);
      setCwd((cur) => cur || c.defaultCwd);
      api.listReplays().then((r) => setReplays(r.files)).catch(() => {});
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 401) setNeedsToken(true);
      else setBanner(`Cannot reach the server: ${(e as Error).message}. Is \`npm run dev\` running?`);
    }
  }, []);
  useEffect(() => { loadConfig(); }, [loadConfig]);

  // Deep link: ?replay=<file in replays/>&speed=<ms per event, 0 = instant>
  const autoReplay = useRef(false);
  useEffect(() => {
    const q = new URLSearchParams(location.search);
    const names = (q.get('replay') ?? '').split(',').filter(Boolean);
    if (!config || !names.length || autoReplay.current) return;
    autoReplay.current = true;
    // Several comma-separated files play back to back (instantly when more than one).
    const speed = names.length > 1 ? 0 : Number(q.get('speed') ?? 150);
    (async () => {
      for (const name of names) {
        try { startReplay(name, api.parseJsonl(await api.fetchReplay(name)), speed); }
        catch (e) { setBanner(`Could not load ${name}: ${(e as Error).message}`); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config]);
  useEffect(() => () => { unsub.current?.(); if (replayTimer.current) clearInterval(replayTimer.current); }, []);

  // ---- derived ----
  const views = useMemo(() => entries.map((e) => buildRunView(e.events)), [entries]);
  const busy = views.some((v) => v.status === 'running');
  const lastLive = [...entries].map((e, i) => ({ e, v: views[i] })).reverse().find((x) => x.e.source === 'live' && x.v.sessionId);
  const sessionId = lastLive?.v.sessionId ?? null;
  const totalCost = views.reduce((s, v) => s + (v.result?.total_cost_usd ?? 0), 0);

  // ---- auto-scroll while streaming (unless the user scrolled up) ----
  useEffect(() => {
    const onScroll = () => {
      const el = document.scrollingElement!;
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (busy && stickToBottom.current) window.scrollTo({ top: document.body.scrollHeight });
  }, [entries, busy]);

  const appendEvent = (localId: number, ev: StreamEvent) =>
    setEntries((prev) => prev.map((e) => (e.localId === localId ? { ...e, events: [...e.events, ev] } : e)));

  // ---- actions ----
  async function submit() {
    const text = prompt.trim();
    if (!text || busy) return;
    const localId = nextId++;
    const resume = continueSession && sessionId ? sessionId : undefined;
    setEntries((prev) => [...prev, { localId, prompt: text, source: 'live', events: [] }]);
    setPrompt('');
    saveCwd(cwd);
    stickToBottom.current = true;
    try {
      const { id } = await api.startRun({ prompt: text, cwd: cwd.trim() || undefined, resume });
      setEntries((prev) => prev.map((e) => (e.localId === localId ? { ...e, serverId: id } : e)));
      unsub.current = api.subscribe(
        id,
        (ev) => appendEvent(localId, ev),
        (msg) => appendEvent(localId, { type: 'viewer_error', message: msg }),
      );
    } catch (e) {
      appendEvent(localId, { type: 'viewer_error', message: (e as Error).message });
    }
  }

  async function stop() {
    const running = entries.find((e, i) => views[i].status === 'running');
    if (!running) return;
    if (running.source === 'replay') {
      if (replayTimer.current) clearInterval(replayTimer.current);
      appendEvent(running.localId, { type: 'viewer_replay_end' });
    } else if (running.serverId) {
      await api.stopRun(running.serverId).catch((e) => setBanner((e as Error).message));
    }
  }

  function startReplay(label: string, events: StreamEvent[], speed = replaySpeed) {
    if (busy) return;
    const localId = nextId++;
    const firstPrompt = `▶ Replay of ${label}`;
    setEntries((prev) => [...prev, { localId, prompt: firstPrompt, source: 'replay', events: [] }]);
    stickToBottom.current = true;
    let i = 0;
    const tick = () => {
      if (i >= events.length) {
        if (replayTimer.current) clearInterval(replayTimer.current);
        replayTimer.current = null;
        appendEvent(localId, { type: 'viewer_replay_end' });
        return;
      }
      appendEvent(localId, events[i++]);
    };
    if (speed === 0) {
      setEntries((prev) => prev.map((e) => (e.localId === localId
        ? { ...e, events: [...events, { type: 'viewer_replay_end' }] } : e)));
      return;
    }
    replayTimer.current = window.setInterval(tick, speed);
  }

  async function replayServerFile(name: string) {
    try { startReplay(name, api.parseJsonl(await api.fetchReplay(name))); }
    catch (e) { setBanner(`Could not load ${name}: ${(e as Error).message}`); }
  }

  async function replayUpload(file: File) {
    startReplay(file.name, api.parseJsonl(await file.text()));
  }

  function newSession() {
    if (busy) return;
    setEntries([]);
    setContinueSession(true);
  }

  function onKey(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  }

  const willResume = continueSession && !!sessionId;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark" aria-hidden>◆</span>
          <span className="brand__name">Trajectory</span>
          <span className="brand__sub">Claude Code run viewer</span>
        </div>
        <div className="topbar__right">
          {sessionId && <span className="pill" title={sessionId}>session {sessionId.slice(0, 8)}</span>}
          {totalCost > 0 && <span className="pill">total {formatCost(totalCost)}</span>}
          <ReplayMenu replays={replays} disabled={busy} speed={replaySpeed} setSpeed={setReplaySpeed}
            onPick={replayServerFile} onUpload={replayUpload} />
          <button className="btn btn--ghost" onClick={newSession} disabled={busy || entries.length === 0}>New session</button>
        </div>
      </header>

      {banner && <div className="banner" role="alert">{banner}<button onClick={() => setBanner(null)}>×</button></div>}
      {needsToken && (
        <form className="banner banner--info" onSubmit={(e) => { e.preventDefault(); api.setToken(tokenDraft); loadConfig(); }}>
          This server requires an access token.
          <input value={tokenDraft} onChange={(e) => setTokenDraft(e.target.value)} placeholder="token" />
          <button className="btn">Unlock</button>
        </form>
      )}

      <div className="layout">
        <main className="main" ref={mainRef}>
          {entries.length === 0 && <EmptyState onPick={setPrompt} />}
          {entries.map((e, i) => (
            <RunCard key={e.localId} index={i} prompt={e.prompt} view={views[i]} source={e.source}
              foldByDefault={i < entries.length - 1} />
          ))}
        </main>
        <aside className="side">
          <Outline runs={entries.map((e, i) => ({ prompt: e.prompt, view: views[i] }))} />
        </aside>
      </div>

      <footer className="composer">
        <div className="composer__inner">
          <div className="composer__row">
            <label className="field field--cwd">
              <span>Working directory</span>
              <input value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={config?.defaultCwd}
                spellCheck={false} disabled={busy || willResume} title={willResume ? 'Resumed sessions keep their directory' : ''} />
            </label>
            {sessionId && (
              <label className="toggle">
                <input type="checkbox" checked={continueSession} onChange={(e) => setContinueSession(e.target.checked)} disabled={busy} />
                <span>Continue session <code>{sessionId.slice(0, 8)}</code></span>
              </label>
            )}
          </div>
          <div className="composer__row composer__row--input">
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} onKeyDown={onKey} rows={2}
              placeholder={willResume ? 'Follow-up (resumes the session)…' : 'Ask Claude Code to do something in that directory…'} />
            {busy
              ? <button className="btn btn--stop" onClick={stop}>Stop</button>
              : <button className="btn btn--primary" onClick={submit} disabled={!prompt.trim() || !config}>
                  {willResume ? 'Continue' : 'Run'} <kbd>⌘↵</kbd>
                </button>}
          </div>
          {config && (
            <div className="composer__hint">
              claude -p … --output-format stream-json --verbose {config.permissionArgs.join(' ')}
              {willResume && ` --resume ${sessionId}`}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}

function ReplayMenu({ replays, disabled, speed, setSpeed, onPick, onUpload }: {
  replays: string[]; disabled: boolean; speed: number; setSpeed: (n: number) => void;
  onPick: (name: string) => void; onUpload: (f: File) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu">
      <button className="btn btn--ghost" onClick={() => setOpen(!open)} disabled={disabled} aria-expanded={open}>Replay ▾</button>
      {open && (
        <div className="menu__pop" onMouseLeave={() => setOpen(false)}>
          <div className="menu__label">Recorded runs</div>
          {replays.length === 0 && <div className="muted menu__empty">No files in replays/</div>}
          {replays.map((f) => (
            <button key={f} className="menu__item" onClick={() => { setOpen(false); onPick(f); }}>{f}</button>
          ))}
          <label className="menu__item menu__upload">
            Open .jsonl file…
            <input type="file" accept=".jsonl,.json,.txt" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) { setOpen(false); onUpload(f); } e.target.value = ''; }} />
          </label>
          <div className="menu__label">Speed</div>
          <div className="seg">
            {[[400, 'Slow'], [150, 'Normal'], [40, 'Fast'], [0, 'Instant']].map(([v, l]) => (
              <button key={v} className={speed === v ? 'seg--on' : ''} onClick={() => setSpeed(v as number)}>{l}</button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EmptyState({ onPick }: { onPick: (p: string) => void }) {
  const examples = [
    'List the files here and summarize what this project does.',
    'Use a subagent to survey this directory.',
    'Add a --shout flag to main.py that uppercases the greeting, then run it to check.',
  ];
  return (
    <div className="empty">
      <h1>Watch Claude Code work.</h1>
      <p>Pick a working directory, send a request, and every message, tool call and result streams in below as it happens. Subagent work nests under the call that started it.</p>
      <div className="examples">
        {examples.map((e) => <button key={e} className="example" onClick={() => onPick(e)}>{e}</button>)}
      </div>
    </div>
  );
}
