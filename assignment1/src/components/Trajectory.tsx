import { memo, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  formatCost, formatDuration, isSubagentTool, toolSummary,
  type RunStatus, type RunView, type ToolNode, type ToolStatus, type TrajNode,
} from '../model.ts';

// ---------- small building blocks ----------

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}

/** Long text folded to `maxLines`; the toggle states how much is hidden. */
export function Fold({ text, maxLines = 10, className = '' }: { text: string; maxLines?: number; className?: string }) {
  const [open, setOpen] = useState(false);
  const lines = text.replace(/\n+$/, '').split('\n');
  const tooLong = lines.length > maxLines + 1 || text.length > 3000;
  const shown = !tooLong || open ? text : lines.slice(0, maxLines).join('\n').slice(0, 3000);
  const hidden = lines.length - maxLines;
  return (
    <div className={`fold ${className}`}>
      <pre>
        {shown || <span className="muted">(empty)</span>}
        {tooLong && (
          <button className="fold__toggle" onClick={() => setOpen(!open)}>
            {open
              ? '▾ collapse'
              : hidden > 0
                ? `▸ ${hidden} more line${hidden === 1 ? '' : 's'}, folded`
                : `▸ ${text.length.toLocaleString()} chars, folded`}
          </button>
        )}
      </pre>
    </div>
  );
}

/** Markdown clamped to a few hundred pixels until expanded. */
function MarkdownFold({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const n = text.split('\n').length;
  const long = text.length > 700 || n > 14;
  return (
    <div className="mdfold">
      <div className={long && !open ? 'mdfold--clamped' : ''}><Markdown text={text} /></div>
      {long && (
        <button className="fold__toggle" onClick={() => setOpen(!open)}>
          {open ? '▾ collapse' : `▸ ${n} lines, folded`}
        </button>
      )}
    </div>
  );
}

const TOOL_MARK: Record<ToolStatus, { icon: string; label: string }> = {
  pending: { icon: '●', label: 'pending' },
  done: { icon: '✓', label: '' },
  error: { icon: '✗', label: 'error' },
  interrupted: { icon: '–', label: 'no result' },
};

function ToolMark({ status }: { status: ToolStatus }) {
  const m = TOOL_MARK[status];
  return (
    <span className={`mark mark--${status}`} title={status}>
      {m.icon}{m.label && <span className="mark__label">{m.label}</span>}
    </span>
  );
}

const RUN_MARK: Record<RunStatus, { icon: string; label: string }> = {
  running: { icon: '●', label: 'running' },
  finished: { icon: '✓', label: 'finished' },
  failed: { icon: '✗', label: 'failed' },
  stopped: { icon: '■', label: 'stopped' },
};

function RunMark({ status }: { status: RunStatus }) {
  const m = RUN_MARK[status];
  return <span className={`runmark runmark--${status}`}>{m.icon} {m.label}</span>;
}

export function Pill({ name, kind = 'tool', children }: { name?: string; kind?: 'tool' | 'task' | 'you' | 'group'; children?: ReactNode }) {
  return <span className={`pill-tag pill-tag--${kind}`}>{children ?? name}</span>;
}

// ---------- tool input details ----------

function ToolInput({ name, input }: { name: string; input: Record<string, unknown> }) {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
  if (name === 'Bash' && str('command')) {
    return (
      <>
        {str('description') && <div className="path">{str('description')}</div>}
        <Fold className="code" text={`$ ${str('command')}`} maxLines={8} />
      </>
    );
  }
  if (name === 'Edit' && str('file_path')) {
    const diff = [
      ...(str('old_string') ?? '').split('\n').map((l) => `- ${l}`),
      ...(str('new_string') ?? '').split('\n').map((l) => `+ ${l}`),
    ].join('\n');
    return <><div className="path">{str('file_path')}</div><Fold className="code" text={diff} maxLines={14} /></>;
  }
  if (name === 'Write' && str('file_path')) {
    return <><div className="path">{str('file_path')}</div><Fold className="code" text={str('content') ?? ''} maxLines={10} /></>;
  }
  if (isSubagentTool(name) && str('prompt')) {
    return (
      <>
        {str('subagent_type') && <div className="path">subagent_type: {str('subagent_type')}</div>}
        <Fold className="code code--prose" text={str('prompt')!} maxLines={4} />
      </>
    );
  }
  return <Fold className="code" text={JSON.stringify(input, null, 2)} maxLines={10} />;
}

// ---------- tool row: [Name] summary ............ ✓ ----------

function ToolRow({ node }: { node: ToolNode }) {
  const [open, setOpen] = useState(false);
  const summary = toolSummary(node.name, node.input);
  return (
    <div className={`trow trow--${node.status}`} id={`tool-${node.id}`}>
      <button className="trow__head" onClick={() => setOpen(!open)} aria-expanded={open} title="Show full input">
        <Pill name={node.name} />
        <span className="trow__sum">{summary}</span>
        <ToolMark status={node.status} />
      </button>
      {open && <div className="trow__detail"><div className="label">input</div><ToolInput name={node.name} input={node.input} /></div>}
      {node.result && (
        <div className={`trow__result ${node.result.isError ? 'trow__result--error' : ''}`}>
          <Fold className="code" text={node.result.text} maxLines={node.result.isError ? 12 : 3} />
        </div>
      )}
    </div>
  );
}

// ---------- subagents: a "Tasks" node with one collapsible branch per Task ----------

function countItems(nodes: TrajNode[]): number {
  return nodes.reduce((n, x) => n + 1 + (x.kind === 'tool' ? countItems(x.children) : 0), 0);
}

/** Strips the harness wrapper some Claude Code builds put around a subagent's report. */
function cleanReport(text: string): string {
  let t = text.replace(/^\s*<tools-used-before-summary>.*?<\/tools-used-before-summary>\s*/s, '');
  const k = t.indexOf('The report follows:');
  if (t.startsWith('[Subagent hand-back]') && k >= 0) t = t.slice(k + 'The report follows:'.length);
  // The harness indents every report line by two spaces; undo that so markdown renders.
  const lines = t.split('\n');
  if (lines.filter((l) => l.trim()).every((l, i) => i === 0 || l.startsWith('  '))) {
    t = lines.map((l) => l.replace(/^ {2}/, '')).join('\n');
  }
  return t.trim();
}

const fmtTokens = (n?: number) => (n == null ? undefined : n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`);

function TaskBranch({ node }: { node: ToolNode }) {
  const [open, setOpen] = useState(true);
  const sub = node.sub;
  const summary = toolSummary(node.name, node.input);
  const n = countItems(node.children);
  const prompt = sub?.prompt ?? (typeof node.input.prompt === 'string' ? node.input.prompt : '');
  const type = sub?.type ?? (typeof node.input.subagent_type === 'string' ? node.input.subagent_type : 'general-purpose');
  const fin = sub?.final;
  const live = node.status === 'pending' ? sub?.progress : undefined;
  const toolNames = [...new Set(node.children.filter((c): c is ToolNode => c.kind === 'tool').map((c) => c.name))];

  const facts: [string, string | undefined][] = [
    ['type', type],
    ['model', sub?.model],
    ['agent id', sub?.agentId?.slice(0, 10)],
    ['turns', sub?.turns ? String(sub.turns) : undefined],
    ['tool calls', String(fin?.toolUses ?? live?.toolUses ?? node.children.filter((c) => c.kind === 'tool').length)],
    ['tools used', (fin?.toolsUsed ?? toolNames).join(', ') || undefined],
    ['tokens', fmtTokens(fin?.tokens ?? live?.tokens)],
    ['duration', fin?.durationMs != null || live?.durationMs != null ? formatDuration(fin?.durationMs ?? live?.durationMs) : undefined],
    ['mode', sub?.backgrounded ? 'background' : sub ? 'foreground (main agent waits)' : undefined],
  ];

  return (
    <div className={`task task--${node.status}`} id={`tool-${node.id}`}>
      <div className="task__head">
        <button className="tri" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={open ? 'Collapse' : 'Expand'}>
          {open ? '▾' : '▸'}
        </button>
        <button className="task__title" onClick={() => setOpen(!open)}>
          <Pill kind="task" name={node.name} />
          <span className="trow__sum trow__sum--prose">{summary}</span>
          <span className="chip chip--type">{type}</span>
          {!open && <span className="muted task__collapsed">· {n} event{n === 1 ? '' : 's'} collapsed</span>}
        </button>
        <ToolMark status={node.status} />
      </div>
      {open && (
        <div className="task__body">
          <dl className="facts">
            {facts.filter(([, v]) => v).map(([k, v]) => (
              <div key={k} className="fact"><dt>{k}</dt><dd>{v}</dd></div>
            ))}
          </dl>

          {live && (
            <div className="progress"><span className="spinner" /> {live.text}{live.lastTool && <span className="muted"> · last tool {live.lastTool}</span>}</div>
          )}

          <section className="step">
            <div className="step__label"><span className="step__n">1</span> Prompt sent to the subagent <span className="muted">· its only context (it does not see the main chat)</span></div>
            {prompt ? <Fold className="code code--prose" text={prompt} maxLines={4} /> : <div className="muted">—</div>}
          </section>

          <section className="step">
            <div className="step__label"><span className="step__n">2</span> Subagent works on its own <span className="muted">· {n} step{n === 1 ? '' : 's'}, fresh context</span></div>
            <div className="step__lane">
              {node.children.length
                ? <NodeList nodes={node.children} />
                : node.status === 'pending' && <div className="muted pending-line"><span className="spinner" /> subagent starting…</div>}
            </div>
          </section>

          <section className="step">
            <div className="step__label"><span className="step__n">3</span> Report returned to the main agent <span className="muted">· arrives as this call's tool_result</span></div>
            {node.result ? (node.result.isError
              ? <div className="trow__result trow__result--error"><Fold className="code" text={node.result.text} maxLines={12} /></div>
              : <div className="task__result"><MarkdownFold text={cleanReport(node.result.text)} /></div>)
              : <div className="muted pending-line">{node.status === 'pending' ? <><span className="spinner" /> waiting for the subagent to finish…</> : 'No report (run ended first).'}</div>}
          </section>
        </div>
      )}
    </div>
  );
}

function TasksGroup({ tasks }: { tasks: ToolNode[] }) {
  return (
    <div className="tasks">
      <Pill kind="group">{tasks.length > 1 ? 'Tasks' : 'Task'}</Pill>
      <div className="tasks__branches">
        {tasks.map((t) => <TaskBranch key={t.key} node={t} />)}
      </div>
    </div>
  );
}

// ---------- node list ----------

type Block = { kind: 'node'; node: TrajNode } | { kind: 'tasks'; tasks: ToolNode[] };

function toBlocks(nodes: TrajNode[]): Block[] {
  const out: Block[] = [];
  for (const n of nodes) {
    if (n.kind === 'tool' && isSubagentTool(n.name)) {
      const last = out[out.length - 1];
      if (last?.kind === 'tasks') last.tasks.push(n);
      else out.push({ kind: 'tasks', tasks: [n] });
    } else out.push({ kind: 'node', node: n });
  }
  return out;
}

function NodeList({ nodes }: { nodes: TrajNode[] }) {
  return (
    <div className="nodes">
      {toBlocks(nodes).map((b, i) => {
        if (b.kind === 'tasks') return <TasksGroup key={`t${i}`} tasks={b.tasks} />;
        const n = b.node;
        switch (n.kind) {
          case 'text': return <div key={n.key} className="msg"><Markdown text={n.text} /></div>;
          case 'thinking':
            return (
              <details key={n.key} className="thinking">
                <summary>thinking</summary>
                <Fold text={n.text} maxLines={12} />
              </details>
            );
          case 'notice': return <div key={n.key} className={`notice notice--${n.level}`}>{n.text}</div>;
          case 'tool': return <ToolRow key={n.key} node={n} />;
        }
      })}
    </div>
  );
}

// ---------- one run: You prompt, trajectory, numbers ----------

export const RunCard = memo(function RunCard({
  index, prompt, view, source, foldByDefault,
}: { index: number; prompt: string; view: RunView; source: 'live' | 'replay'; foldByDefault: boolean }) {
  const [userFold, setUserFold] = useState<boolean | null>(null);
  const folded = view.status !== 'running' && (userFold ?? foldByDefault);
  const cwd = view.init?.cwd ?? view.start?.cwd;

  // When folded, keep the final answer visible below the fold line.
  const lastText = [...view.nodes].reverse().find((n) => n.kind === 'text');
  const total = countItems(view.nodes);
  const hiddenCount = total - (lastText ? 1 : 0);

  return (
    <article className={`run run--${view.status}`} id={`run-${index}`}>
      <header className="run__head">
        <Pill kind="you">You</Pill>
        <div className="prompt">{prompt}</div>
        <RunMark status={view.status} />
      </header>
      <div className="run__sub">
        {source === 'replay' && <span className="chip chip--replay">replay</span>}
        {view.start?.resume && <span>resumed session <code className="sid">{view.start.resume.slice(0, 8)}-…</code></span>}
        {cwd && <span className="run__cwd" title={cwd}>{cwd}</span>}
      </div>

      <div className="run__body">
        {view.nodes.length === 0 && view.status === 'running' && (
          <div className="muted pending-line"><span className="spinner" /> starting Claude Code…</div>
        )}

        {folded ? (
          <>
            {hiddenCount > 0 && (
              <button className="fold__toggle fold__toggle--run" onClick={() => setUserFold(false)}>
                ▸ {hiddenCount} event{hiddenCount === 1 ? '' : 's'}, folded
              </button>
            )}
            {lastText && lastText.kind === 'text' && <div className="msg"><Markdown text={lastText.text} /></div>}
          </>
        ) : (
          <>
            {view.status !== 'running' && total > 0 && (
              <button className="fold__toggle fold__toggle--run" onClick={() => setUserFold(true)}>▾ fold this run</button>
            )}
            <NodeList nodes={view.nodes} />
          </>
        )}

        {view.error && (
          <div className="run-error" role="alert">
            <strong>{view.status === 'stopped' ? 'Stopped' : 'Run failed'}</strong>
            <pre>{view.error}</pre>
          </div>
        )}
        {view.status === 'failed' && view.stderr && !view.error?.includes(view.stderr.trim()) && (
          <details className="stderr"><summary>stderr</summary><pre>{view.stderr}</pre></details>
        )}
      </div>

      {view.result && (
        <footer className="numbers">
          <span title="total_cost_usd">{formatCost(view.result.total_cost_usd)}</span>
          <span>·</span><span title="duration_ms">{formatDuration(view.result.duration_ms)}</span>
          <span>·</span><span title="num_turns">{view.result.num_turns ?? '—'} turn{view.result.num_turns === 1 ? '' : 's'}</span>
          <span>·</span><span>{view.toolCount} tool call{view.toolCount === 1 ? '' : 's'}</span>
          {view.sessionId && <><span>·</span><span title={view.sessionId}>session_id <code className="sid">{view.sessionId.slice(0, 8)}-…</code></span></>}
        </footer>
      )}
    </article>
  );
});
