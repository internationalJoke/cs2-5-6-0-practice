// Turns a flat list of stream events into a render tree.
// Subagent events carry parent_tool_use_id = the Agent/Task tool_use that spawned them;
// we nest them as children of that call. Main-agent events have parent null.
import type {
  AssistantEvent, ContentBlock, ResultEvent, StreamEvent, SystemInitEvent, ToolResultBlock,
  ToolUseBlock, UserEvent, ViewerErrorEvent, ViewerExitEvent, ViewerStartEvent,
} from './types.ts';

export type ToolStatus = 'pending' | 'done' | 'error' | 'interrupted';
export type RunStatus = 'running' | 'finished' | 'failed' | 'stopped';

export interface TextNode { kind: 'text'; key: string; text: string }
export interface ThinkingNode { kind: 'thinking'; key: string; text: string }
export interface NoticeNode { kind: 'notice'; key: string; level: 'warn' | 'error'; text: string }
export interface ToolNode {
  kind: 'tool';
  key: string;
  id: string;
  name: string;
  input: Record<string, unknown>;
  result: { text: string; isError: boolean } | null;
  status: ToolStatus;
  children: TrajNode[];
  /** Only for Agent/Task calls: what the stream tells us about the subagent. */
  sub?: SubagentInfo;
}

export interface SubagentInfo {
  agentId?: string;
  type?: string;          // subagent_type, e.g. Explore
  description?: string;
  prompt?: string;        // the only context the subagent receives
  model?: string;
  backgrounded?: boolean;
  depth?: number;
  turns: number;          // assistant messages the subagent produced
  progress?: { text: string; tokens?: number; toolUses?: number; durationMs?: number; lastTool?: string };
  final?: { tokens?: number; durationMs?: number; toolUses?: number; toolsUsed?: string[]; outputTokens?: number };
  state?: string;         // started / completed / failed (from task_* events)
}
export type TrajNode = TextNode | ThinkingNode | NoticeNode | ToolNode;

export interface RunView {
  nodes: TrajNode[];
  status: RunStatus;
  init: SystemInitEvent | null;
  start: ViewerStartEvent | null;
  result: ResultEvent | null;
  sessionId: string | null;
  error: string | null; // human-readable failure reason
  stderr: string;
  toolCount: number;
}

const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
export const isSubagentTool = (name: string) => SUBAGENT_TOOLS.has(name);

export function resultText(content: ToolResultBlock['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.map((c) => (c.type === 'text' ? c.text ?? '' : `[${c.type}]`)).join('\n');
}

export function buildRunView(events: StreamEvent[]): RunView {
  const root: TrajNode[] = [];
  const tools = new Map<string, ToolNode>();
  let init: SystemInitEvent | null = null;
  let start: ViewerStartEvent | null = null;
  let result: ResultEvent | null = null;
  let viewerError: ViewerErrorEvent | null = null;
  let exit: ViewerExitEvent | null = null;
  let replayEnded = false;
  let sessionId: string | null = null;
  let stderr = '';

  const containerFor = (parentId: string | null | undefined): TrajNode[] =>
    (parentId && tools.get(parentId)?.children) || root;
  const subOf = (toolUseId: unknown): SubagentInfo | undefined => {
    const node = typeof toolUseId === 'string' ? tools.get(toolUseId) : undefined;
    if (!node) return undefined;
    return (node.sub ??= { turns: 0 });
  };

  events.forEach((ev, i) => {
    if ('session_id' in ev && ev.session_id) sessionId = ev.session_id;
    switch (ev.type) {
      case 'viewer_start': start = ev as ViewerStartEvent; break;
      case 'viewer_error': viewerError = ev as ViewerErrorEvent; break;
      case 'viewer_exit': exit = ev as ViewerExitEvent; break;
      case 'viewer_stderr': stderr += (ev as { text: string }).text; break;
      case 'viewer_replay_end': replayEnded = true; break;
      case 'result': result = ev as ResultEvent; break;
      case 'system': {
        const s = ev as Record<string, any>;
        if (s.subtype === 'init') init = ev as SystemInitEvent;
        else if (s.subtype === 'task_started') {
          const sub = subOf(s.tool_use_id);
          if (sub) Object.assign(sub, {
            agentId: s.task_id, type: s.subagent_type, description: s.description, prompt: s.prompt,
            backgrounded: s.is_backgrounded, depth: s.spawn_depth, state: 'running',
          });
        } else if (s.subtype === 'task_progress') {
          const sub = subOf(s.tool_use_id);
          if (sub) sub.progress = {
            text: s.description, tokens: s.usage?.total_tokens, toolUses: s.usage?.tool_uses,
            durationMs: s.usage?.duration_ms, lastTool: s.last_tool_name,
          };
        } else if (s.subtype === 'task_notification') {
          const sub = subOf(s.tool_use_id);
          if (sub) sub.state = s.status;
        }
        else if (s.subtype === 'api_retry') {
          root.push({
            kind: 'notice', key: `n${i}`, level: 'warn',
            text: `API retry ${s.attempt ?? '?'}/${s.max_retries ?? '?'}${s.error ? `: ${String(s.error)}` : ''}`,
          });
        }
        break;
      }
      case 'assistant': {
        const a = ev as AssistantEvent;
        const into = containerFor(a.parent_tool_use_id);
        if (a.parent_tool_use_id) {
          const sub = subOf(a.parent_tool_use_id);
          if (sub) { sub.turns++; sub.model ??= (a.message as { model?: string }).model; }
        }
        a.message.content.forEach((b: ContentBlock, j) => {
          const key = `${i}.${j}`;
          if (b.type === 'text') {
            const text = (b as { text: string }).text;
            if (text.trim()) into.push({ kind: 'text', key, text });
          } else if (b.type === 'thinking') {
            const text = (b as { thinking: string }).thinking;
            if (text?.trim()) into.push({ kind: 'thinking', key, text });
          } else if (b.type === 'tool_use') {
            const t = b as ToolUseBlock;
            const node: ToolNode = {
              kind: 'tool', key, id: t.id, name: t.name, input: t.input ?? {},
              result: null, status: 'pending', children: [],
            };
            tools.set(t.id, node);
            into.push(node);
          }
        });
        break;
      }
      case 'user': {
        const u = ev as UserEvent;
        if (typeof u.message.content === 'string') break; // subagent's prompt echo
        for (const b of u.message.content) {
          if (b.type !== 'tool_result') continue;
          const r = b as ToolResultBlock;
          const node = tools.get(r.tool_use_id);
          if (!node) continue;
          node.result = { text: resultText(r.content), isError: !!r.is_error };
          // Agent results carry a summary of the subagent's whole run.
          const meta = (u as { tool_use_result?: Record<string, any> }).tool_use_result;
          if (isSubagentTool(node.name) && meta && typeof meta === 'object' && 'totalTokens' in meta) {
            const sub = (node.sub ??= { turns: 0 });
            sub.agentId ??= meta.agentId;
            sub.type ??= meta.agentType;
            sub.prompt ??= meta.prompt;
            sub.model = meta.resolvedModel ?? sub.model;
            sub.state = meta.status ?? sub.state;
            sub.final = {
              tokens: meta.totalTokens, durationMs: meta.totalDurationMs, toolUses: meta.totalToolUseCount,
              toolsUsed: meta.toolsUsed, outputTokens: meta.usage?.output_tokens,
            };
          }
        }
        break;
      }
    }
  });

  // Run status
  let status: RunStatus = 'running';
  let error: string | null = null;
  const r = result as ResultEvent | null;
  const x = exit as ViewerExitEvent | null;
  const ve = viewerError as ViewerErrorEvent | null;
  if (ve) { status = 'failed'; error = ve.message; }
  else if (r) {
    status = r.is_error || r.subtype !== 'success' ? 'failed' : 'finished';
    if (status === 'failed') error = r.errors?.join('\n') || r.result || `Run ended with ${r.subtype}`;
  } else if (x) {
    if (x.signal === 'SIGINT' || x.code === 130) { status = 'stopped'; error = 'Stopped by user'; }
    else { status = 'failed'; error = `claude exited with code ${x.code ?? x.signal}${x.stderr ? `:\n${x.stderr.trim()}` : ''}`; }
  } else if (replayEnded) status = 'finished';

  // Tool statuses: pending until the matching tool_result arrives
  const live = status === 'running';
  for (const t of tools.values()) {
    t.status = t.result ? (t.result.isError ? 'error' : 'done') : live ? 'pending' : 'interrupted';
  }

  return {
    nodes: root, status, init, start, result: r, sessionId, error, stderr, toolCount: tools.size,
  };
}

/** One-line summary of a tool's input for headers and the outline. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Bash': return s('command').split('\n')[0] || s('description');
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': return shortPath(s('file_path') || s('notebook_path'));
    case 'Glob': return s('pattern');
    case 'Grep': return `"${s('pattern')}"${s('path') ? ` in ${shortPath(s('path'))}` : ''}`;
    case 'Agent': case 'Task': return s('description') || s('subagent_type');
    case 'WebFetch': return s('url');
    case 'WebSearch': return s('query');
    case 'TodoWrite': return `${Array.isArray(input.todos) ? input.todos.length : 0} todos`;
    default: {
      const first = Object.values(input).find((v) => typeof v === 'string') as string | undefined;
      return first ?? '';
    }
  }
}

function shortPath(p: string): string {
  const parts = p.split('/');
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : p;
}

export function formatDuration(ms?: number): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;
}

export const formatCost = (usd?: number) => (usd == null ? '—' : `$${usd.toFixed(usd < 1 ? 4 : 2)}`);
