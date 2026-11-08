// Outline beside the dialogue: a vertical flow of call-name pills per run.
// A "You" node marks each prompt; consecutive subagent calls fork into parallel
// columns (one per subagent, holding that subagent's own calls) and merge back.
import { isSubagentTool, toolSummary, type RunView, type ToolNode, type TrajNode } from '../model.ts';

function jump(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

type FlowItem = { kind: 'tool'; node: ToolNode } | { kind: 'fork'; branches: ToolNode[] };

/** Tool calls in order; runs of consecutive subagent calls become one fork. */
export function toFlow(nodes: TrajNode[]): FlowItem[] {
  const out: FlowItem[] = [];
  for (const n of nodes) {
    if (n.kind !== 'tool') continue;
    if (isSubagentTool(n.name)) {
      const last = out[out.length - 1];
      if (last?.kind === 'fork') last.branches.push(n);
      else out.push({ kind: 'fork', branches: [n] });
    } else out.push({ kind: 'tool', node: n });
  }
  return out;
}

function Pill({ node }: { node: ToolNode }) {
  const sub = isSubagentTool(node.name);
  return (
    <button
      className={`fpill ${sub ? 'fpill--task' : ''} fpill--${node.status}`}
      onClick={() => jump(`tool-${node.id}`)}
      title={`${node.name}: ${toolSummary(node.name, node.input)}`}
    >
      {node.name}
    </button>
  );
}

function Flow({ nodes }: { nodes: TrajNode[] }) {
  return (
    <>
      {toFlow(nodes).map((item, i) =>
        item.kind === 'tool' ? (
          <Pill key={item.node.key} node={item.node} />
        ) : (
          <div key={i} className={`fork ${item.branches.length === 1 ? 'fork--single' : ''}`}>
            {item.branches.map((b) => (
              <div key={b.key} className="fork__branch">
                <div className={`lane lane--${b.status}`}>
                  <div className="lane__label" title={b.sub?.description}>
                    {b.sub?.type ?? 'subagent'}
                  </div>
                  <div className="flow flow--lane">
                    <Pill node={b} />
                    <Flow nodes={b.children} />
                    {b.children.length === 0 && <span className="lane__empty">…</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        ),
      )}
    </>
  );
}

export function Outline({ runs }: { runs: { prompt: string; view: RunView }[] }) {
  return (
    <nav className="outline" aria-label="Outline of tool calls">
      <div className="outline__title">outline</div>
      {runs.length === 0 && <div className="muted outline__empty">Call names appear here as the run streams.</div>}
      {runs.length > 0 && (
        <div className="outline__legend"><span className="lg lg--main" /> main agent <span className="lg lg--sub" /> subagent</div>
      )}
      {runs.length > 0 && (
        <div className="flow flow--main">
          {runs.map((r, i) => (
            <FlowRun key={i} index={i} prompt={r.prompt} view={r.view} />
          ))}
        </div>
      )}
    </nav>
  );
}

function FlowRun({ index, prompt, view }: { index: number; prompt: string; view: RunView }) {
  return (
    <>
      <button className={`fpill fpill--you fpill--run-${view.status}`} onClick={() => jump(`run-${index}`)} title={prompt}>
        You
      </button>
      <Flow nodes={view.nodes} />
    </>
  );
}
