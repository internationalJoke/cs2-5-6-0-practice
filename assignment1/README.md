# Trajectory: a web viewer for Claude Code runs

A local web page that drives the Claude Code CLI. You type a request, Claude Code works in a working directory you choose, and the page streams the trajectory live: assistant messages (rendered as markdown), each tool call with its input and result, per-call and per-run status, cost, duration and turns. Subagent work nests under the call that spawned it.

The backend is ~250 lines of TypeScript (`server.ts`) that runs `claude -p "<prompt>" --output-format stream-json --verbose [--resume <id>]` and relays each JSON line to the browser over Server-Sent Events. There is no agent framework or SDK, and the agent loop is not reimplemented.

## Run with Docker (macOS / Linux / Windows)

Requires Docker Desktop (or Docker Engine with compose).

```bash
cd assignment1
cp .env.example .env
```

Log the container in to your Claude account with **one** of these:

- **A: token (easiest on macOS).** On the host run `claude setup-token` and paste the token into `.env` as `CLAUDE_CODE_OAUTH_TOKEN=...`. (On macOS your normal login lives in the Keychain, so mounting `~/.claude` would not work.)
- **B: log in inside the container once.** `docker compose run --rm viewer claude /login`. The login is kept in the `claude-home` volume.

Then:

```bash
docker compose up --build
```

Open **http://localhost:8787**. Claude works in `/workspace`, which is the folder set by `WORKSPACE` in `.env` (default `./workspace`). Use a scratch folder, not your home directory. The port is published on `127.0.0.1` only.

## Run without Docker

Requires Node ≥ 23.6 (it runs `server.ts` directly by stripping the types) and a logged-in `claude` CLI.

```bash
cd assignment1
npm install
npm run dev        # API on :8787 + Vite on :5173, open http://localhost:5173
# or
npm start          # builds the frontend, serves everything on http://localhost:8787
```

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | `8787` / `127.0.0.1` | Where the server listens |
| `DEFAULT_CWD` | parent of `assignment1/` (`/workspace` in Docker) | Prefilled working directory |
| `CLAUDE_PERMISSION_ARGS` | `["--permission-mode","acceptEdits","--allowedTools","Bash Read Edit Write Glob Grep Agent Task TodoWrite WebFetch WebSearch"]` | Permission flags for each `claude -p` run. Headless runs deny anything needing approval, so tools must be allowed explicitly |
| `AUTH_TOKEN` | *(off)* | When set, every API call needs it. Open the page once as `http://host:8787/?token=…` and it is remembered |
| `CLAUDE_BIN` | `claude` | Path to the CLI |

## Using it

- **Run:** set the working directory, type a prompt, press **Run** (⌘/Ctrl+Enter). Only one run at a time; the next can start when it finishes. **Stop** sends SIGINT so the turn is recorded cleanly.
- **Continue:** after a run, *Continue session* is checked and the next prompt is sent with `--resume <session_id>`, so context carries over. Uncheck it (or press **New session**) to start fresh.
- **Status:** each tool call is *Running* until its `tool_result` (matched by `tool_use_id`) arrives, then *Done* or *Error*. Each run is *In progress / Finished / Failed / Stopped*; failures (bad directory, not logged in, non-zero exit, error result) show a red error box.
- **Numbers:** cost, duration and turns from the final `result` event appear under every finished run, with a session total in the top bar.
- **Subagents:** events with a non-null `parent_tool_use_id` nest under the `Agent`/`Task` call that spawned them, in a collapsible "Subagent trajectory". Try *"use a subagent to survey this directory"*.
- **Outline:** on wide windows, a sidebar lists every tool call as a tree. Click one to jump to it. It is hidden on narrow windows.
- **Replay:** *Replay ▾* plays a recorded `events.jsonl` from `replays/` (or a file you pick) at a chosen speed. Deep link: `/?replay=subagent-run.jsonl&speed=0`.

Record a new replay from the terminal:

```bash
claude -p "use a subagent to survey this directory" --output-format stream-json --verbose \
  --permission-mode acceptEdits --allowedTools "Bash Read Glob Grep Agent" > replays/my-run.jsonl
```

## Layout

```
server.ts                 HTTP + SSE server, spawns claude
src/types.ts              stream-json event types (shared by server and client)
src/model.ts              events -> tree (subagent nesting, status, summaries)
src/api.ts                fetch/SSE client, token handling, jsonl parsing
src/App.tsx               state, composer, replay
src/components/           RunCard / ToolCard / Fold / Outline
replays/                  recorded runs (simple, edit, subagent)
Dockerfile, docker-compose.yml
```
