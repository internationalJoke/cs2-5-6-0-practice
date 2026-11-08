import type { StartRunRequest, StreamEvent, ViewerConfig } from './types.ts';

// Optional token auth: open the page once with ?token=XYZ and it is remembered.
const TOKEN_KEY = 'ctv.token';
function safeGet(k: string): string { try { return localStorage.getItem(k) ?? ''; } catch { return ''; } }
function safeSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } }

const fromUrl = new URLSearchParams(location.search).get('token');
if (fromUrl) {
  safeSet(TOKEN_KEY, fromUrl);
  history.replaceState(null, '', location.pathname);
}
export const getToken = () => safeGet(TOKEN_KEY);
export const setToken = (t: string) => safeSet(TOKEN_KEY, t);

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(path, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error ?? msg; } catch { /* not json */ }
    throw new ApiError(res.status, msg);
  }
  const ct = res.headers.get('content-type') ?? '';
  return (ct.includes('json') ? res.json() : res.text()) as Promise<T>;
}

export const getConfig = () => api<ViewerConfig>('/api/config');
export const startRun = (req: StartRunRequest) =>
  api<{ id: string }>('/api/runs', { method: 'POST', body: JSON.stringify(req) });
export const stopRun = (id: string) => api<{ ok: true }>(`/api/runs/${id}/stop`, { method: 'POST' });
export const listReplays = () => api<{ files: string[] }>('/api/replays');
export const fetchReplay = (name: string) => api<string>(`/api/replays/${encodeURIComponent(name)}`);

const TERMINAL = new Set(['viewer_exit', 'viewer_error']);

/** Subscribes to a run's SSE stream. Returns an unsubscribe function. */
export function subscribe(
  id: string,
  onEvent: (e: StreamEvent) => void,
  onLost: (msg: string) => void,
): () => void {
  const token = getToken();
  const es = new EventSource(`/api/runs/${id}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`);
  let ended = false;
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data) as StreamEvent;
    onEvent(ev);
    if (TERMINAL.has(ev.type)) { ended = true; es.close(); }
  };
  // EventSource auto-reconnects (which would replay buffered events and duplicate them),
  // so treat any error before a terminal event as a lost connection.
  es.onerror = () => {
    es.close();
    if (!ended) onLost('Lost connection to the server while the run was in progress.');
  };
  return () => { ended = true; es.close(); };
}

export function parseJsonl(text: string): StreamEvent[] {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as StreamEvent]; } catch { return []; }
  });
}
