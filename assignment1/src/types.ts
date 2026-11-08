// Shapes of the `claude -p --output-format stream-json --verbose` event stream,
// plus a few `viewer_*` events the server injects. Only fields we use are typed;
// everything else passes through untouched.

export interface TextBlock { type: 'text'; text: string }
export interface ThinkingBlock { type: 'thinking'; thinking: string }
export interface ToolUseBlock { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<{ type: string; text?: string }>;
  is_error?: boolean;
}
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | { type: string };

interface Base { session_id?: string; uuid?: string }

export interface SystemInitEvent extends Base {
  type: 'system'; subtype: 'init'; cwd: string; model?: string; tools?: string[]; permissionMode?: string;
}
export interface SystemOtherEvent extends Base {
  type: 'system'; subtype: string; attempt?: number; max_retries?: number; error?: unknown; retry_delay_ms?: number;
}
export interface AssistantEvent extends Base {
  type: 'assistant';
  message: { id?: string; content: ContentBlock[] };
  parent_tool_use_id: string | null;
}
export interface UserEvent extends Base {
  type: 'user';
  message: { content: string | ContentBlock[] };
  parent_tool_use_id: string | null;
}
export interface ResultEvent extends Base {
  type: 'result';
  subtype: string; // 'success' | 'error_max_turns' | 'error_during_execution' ...
  is_error: boolean;
  result?: string;
  total_cost_usd?: number;
  duration_ms?: number;
  num_turns?: number;
  errors?: string[];
}
export interface ViewerStartEvent { type: 'viewer_start'; cwd: string; resume: string | null; args: string[] }
export interface ViewerErrorEvent { type: 'viewer_error'; message: string }
export interface ViewerExitEvent { type: 'viewer_exit'; code: number | null; signal: string | null; stderr: string }
export interface ViewerStderrEvent { type: 'viewer_stderr'; text: string }
export interface ViewerReplayEndEvent { type: 'viewer_replay_end' }
export interface UnknownEvent extends Base { type: string; subtype?: string }

export type StreamEvent =
  | SystemInitEvent | SystemOtherEvent | AssistantEvent | UserEvent | ResultEvent
  | ViewerStartEvent | ViewerErrorEvent | ViewerExitEvent | ViewerStderrEvent | ViewerReplayEndEvent
  | UnknownEvent;

export interface StartRunRequest { prompt: string; cwd?: string; resume?: string }
export interface ViewerConfig { defaultCwd: string; permissionArgs: string[]; authRequired: boolean }
