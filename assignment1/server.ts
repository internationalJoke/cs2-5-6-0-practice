// Minimal backend: spawns `claude -p ... --output-format stream-json --verbose`
// in a chosen working directory and relays each stdout JSON line to the browser
// over Server-Sent Events. No agent framework, no SDK — just the CLI.
// Runs directly with `node server.ts` (Node >= 23.6 strips the type annotations).
import http from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { StreamEvent, ViewerConfig, StartRunRequest } from './src/types.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const AUTH_TOKEN = process.env.AUTH_TOKEN || ''; // when set, require ?token= or Bearer
const REPLAY_DIR = path.join(__dirname, 'replays');
const DIST_DIR = path.join(__dirname, 'dist');
const DEFAULT_CWD = process.env.DEFAULT_CWD || path.resolve(__dirname, '..');

// Headless -p runs deny anything that needs approval, so pass explicit permissions.
// Override with CLAUDE_PERMISSION_ARGS (JSON array), e.g.
//   CLAUDE_PERMISSION_ARGS='["--dangerously-skip-permissions"]'
const PERMISSION_ARGS: string[] = process.env.CLAUDE_PERMISSION_ARGS
  ? JSON.parse(process.env.CLAUDE_PERMISSION_ARGS)
  : ['--permission-mode', 'acceptEdits',
     '--allowedTools', 'Bash Read Edit Write Glob Grep Agent Task TodoWrite WebFetch WebSearch'];

interface Run {
  id: string;
  proc: ChildProcess | null;
  events: StreamEvent[];
  clients: Set<http.ServerResponse>;
  done: boolean;
}

const runs = new Map<string, Run>();

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function authorized(req: http.IncomingMessage, url: URL): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers.authorization || '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c: Buffer) => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve((data ? JSON.parse(data) : {}) as T); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function emit(run: Run, event: StreamEvent): void {
  run.events.push(event);
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const c of run.clients) c.write(frame);
}

function finish(run: Run, event: StreamEvent): void {
  if (run.done) return;
  emit(run, event);
  run.done = true;
  for (const c of run.clients) c.end();
  run.clients.clear();
}

function startRun({ prompt, cwd, resume }: StartRunRequest): Run {
  const run: Run = { id: crypto.randomUUID(), proc: null, events: [], clients: new Set(), done: false };
  runs.set(run.id, run);

  const dir = path.resolve(expandHome(cwd || DEFAULT_CWD));
  // Validate the directory ourselves so a bad path yields a clear, visible error.
  let isDir = false;
  try { isDir = fs.statSync(dir).isDirectory(); } catch { /* handled below */ }
  if (!isDir) {
    finish(run, { type: 'viewer_error', message: `Working directory does not exist or is not a directory: ${dir}` });
    return run;
  }

  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...PERMISSION_ARGS];
  if (resume) args.push('--resume', resume);
  emit(run, { type: 'viewer_start', cwd: dir, resume: resume || null, args: [CLAUDE_BIN, ...args] });

  const proc = spawn(CLAUDE_BIN, args, { cwd: dir, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  run.proc = proc;

  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try { emit(run, JSON.parse(line) as StreamEvent); }
      catch { emit(run, { type: 'viewer_stderr', text: line }); }
    }
  });

  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk: string) => {
    stderr += chunk;
    emit(run, { type: 'viewer_stderr', text: chunk });
  });

  proc.on('error', (err) => {
    finish(run, { type: 'viewer_error', message: `Failed to start ${CLAUDE_BIN}: ${err.message}` });
  });
  proc.on('close', (code, signal) => {
    if (buf.trim()) { try { emit(run, JSON.parse(buf) as StreamEvent); } catch { /* partial line */ } }
    finish(run, { type: 'viewer_exit', code, signal, stderr: stderr.slice(-4000) });
  });

  return run;
}

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json',
};

function serveStatic(res: http.ServerResponse, url: URL): void {
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Frontend not built. Use `npm run dev` (open :5173) or `npm start`.');
    return;
  }
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  let file = path.join(DIST_DIR, rel);
  if (!file.startsWith(DIST_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    file = path.join(DIST_DIR, 'index.html');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`);
  if (!url.pathname.startsWith('/api/')) return serveStatic(res, url);
  if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized: missing or wrong token' });

  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const cfg: ViewerConfig = { defaultCwd: DEFAULT_CWD, permissionArgs: PERMISSION_ARGS, authRequired: !!AUTH_TOKEN };
      return json(res, 200, cfg);
    }

    // POST /api/runs { prompt, cwd, resume? } -> { id }
    if (req.method === 'POST' && url.pathname === '/api/runs') {
      const body = await readBody<StartRunRequest>(req);
      if (!body.prompt || typeof body.prompt !== 'string') return json(res, 400, { error: 'prompt is required' });
      if ([...runs.values()].some((r) => !r.done)) {
        return json(res, 409, { error: 'A run is already in progress; wait for it to finish.' });
      }
      return json(res, 200, { id: startRun(body).id });
    }

    // GET /api/runs/:id/events — SSE; buffered events are replayed first
    let m = url.pathname.match(/^\/api\/runs\/([\w-]+)\/events$/);
    if (req.method === 'GET' && m) {
      const run = runs.get(m[1]);
      if (!run) return json(res, 404, { error: 'no such run' });
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const e of run.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (run.done) { res.end(); return; }
      run.clients.add(res);
      req.on('close', () => run.clients.delete(res));
      return;
    }

    // POST /api/runs/:id/stop — SIGINT ends the turn cleanly (SIGTERM leaves it unrecorded)
    m = url.pathname.match(/^\/api\/runs\/([\w-]+)\/stop$/);
    if (req.method === 'POST' && m) {
      const run = runs.get(m[1]);
      if (!run?.proc || run.done) return json(res, 404, { error: 'no active run' });
      run.proc.kill('SIGINT');
      return json(res, 200, { ok: true });
    }

    // Bundled recordings for replay mode
    if (req.method === 'GET' && url.pathname === '/api/replays') {
      const files = fs.existsSync(REPLAY_DIR) ? fs.readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.jsonl')) : [];
      return json(res, 200, { files });
    }
    m = url.pathname.match(/^\/api\/replays\/([\w.-]+\.jsonl)$/);
    if (req.method === 'GET' && m) {
      const file = path.join(REPLAY_DIR, m[1]);
      if (!fs.existsSync(file)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    json(res, 404, { error: 'not found' });
  } catch (err) {
    json(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`server on http://${HOST}:${PORT}  (claude: ${CLAUDE_BIN}; ${PERMISSION_ARGS.join(' ')})`);
  if (AUTH_TOKEN) console.log('token auth enabled');
  else if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !process.env.IN_CONTAINER) {
    console.warn('WARNING: listening on a non-local interface without AUTH_TOKEN.');
  }
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    for (const r of runs.values()) if (!r.done) r.proc?.kill('SIGINT');
    process.exit(0);
  });
}
