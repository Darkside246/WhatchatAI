import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ShieldAlert, Bot, Play, Clock } from 'lucide-react';
import { api, ADVICE_RESTRICTED_CATEGORIES, type AiAgentSummary, type RoutingPreviewResult } from '../lib/api.js';

/**
 * Two handle ids, because there are two genuinely different relationships
 * and collapsing them into one generic line would misrepresent what happens
 * at runtime:
 *
 *  - escalation: real behaviour. If the routed agent cannot answer, this is
 *    the agent tried next (exactly one hop, enforced server-side).
 *  - reports-to: organisational structure only. It records how the operator
 *    thinks about their setup; it does NOT change which agent replies today.
 *    Drawn dashed and labelled so nobody mistakes it for routing.
 */
const ESCALATION_HANDLE = 'escalation';
const REPORTS_HANDLE = 'reports';

export interface AgentNodeData extends Record<string, unknown> {
  agent: AiAgentSummary;
  highlight: 'none' | 'routed' | 'blocked';
}

function AgentNode({ data }: NodeProps<Node<AgentNodeData>>) {
  const { agent, highlight } = data;
  const restricted = ADVICE_RESTRICTED_CATEGORIES.includes(agent.category);

  const ring =
    highlight === 'routed'
      ? 'border-accent ring-2 ring-accent'
      : highlight === 'blocked'
        ? 'border-warning ring-2 ring-warning'
        : 'border-border-subtle';

  return (
    <div className={`w-56 rounded-xl border bg-surface-1 p-3 shadow-md transition-colors ${ring}`}>
      <Handle type="target" position={Position.Left} className="!h-2.5 !w-2.5 !bg-fg-muted" />

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg">{agent.name}</p>
          <p className="mt-0.5 truncate text-[11px] text-fg-muted">{agent.category.replace('_', ' ')}</p>
        </div>
        <span
          title={agent.status === 'ACTIVE' ? 'Active' : agent.status}
          className={`mt-1 h-2 w-2 shrink-0 rounded-full ${agent.status === 'ACTIVE' ? 'bg-success' : 'bg-fg-muted/50'}`}
        />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[10px] text-fg-muted">
        {restricted && (
          <span className="flex items-center gap-0.5 text-warning">
            <ShieldAlert size={10} aria-hidden />
            Ops only
          </span>
        )}
        {agent.responseDelaySeconds > 0 && (
          <span className="flex items-center gap-0.5">
            <Clock size={10} aria-hidden />
            {agent.responseDelaySeconds}s
          </span>
        )}
        {agent.triggerKeywords.length > 0 && <span>{agent.triggerKeywords.length} triggers</span>}
        {agent.blockedKeywords.length > 0 && <span className="text-warning">{agent.blockedKeywords.length} blocked</span>}
        {agent.priority > 0 && <span>P{agent.priority}</span>}
      </div>

      <Handle
        id={ESCALATION_HANDLE}
        type="source"
        position={Position.Right}
        title="Escalates to"
        className="!h-2.5 !w-2.5 !bg-accent"
      />
      <Handle
        id={REPORTS_HANDLE}
        type="source"
        position={Position.Bottom}
        title="Reports to"
        className="!h-2.5 !w-2.5 !bg-fg-muted"
      />
    </div>
  );
}

const nodeTypes = { agent: AgentNode };

/** Laid out on a simple grid only until the operator actually drags it somewhere real. */
function fallbackPosition(index: number): { x: number; y: number } {
  return { x: (index % 3) * 280 + 40, y: Math.floor(index / 3) * 190 + 40 };
}

function buildEdges(agents: AiAgentSummary[]): Edge[] {
  const edges: Edge[] = [];
  for (const agent of agents) {
    if (agent.escalateToAgentId) {
      edges.push({
        id: `esc-${agent.id}`,
        source: agent.id,
        sourceHandle: ESCALATION_HANDLE,
        target: agent.escalateToAgentId,
        label: 'escalates to',
        animated: true,
        style: { stroke: 'var(--color-accent)' },
        labelStyle: { fontSize: 10 },
      });
    }
    if (agent.parentAgentId) {
      edges.push({
        id: `rep-${agent.id}`,
        source: agent.id,
        sourceHandle: REPORTS_HANDLE,
        target: agent.parentAgentId,
        label: 'reports to',
        style: { stroke: 'var(--color-fg-muted)', strokeDasharray: '5 5' },
        labelStyle: { fontSize: 10 },
      });
    }
  }
  return edges;
}

/**
 * A drag-and-drop view of the real agent structure. Every node position is
 * persisted, and every connection writes a real foreign key that the routing
 * engine actually reads - pulling a line here changes behaviour, it does not
 * draw a picture of intent.
 */
export function AgentCanvas({ agents, onChanged }: { agents: AiAgentSummary[]; onChanged: () => void }) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node<AgentNodeData>>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [preview, setPreview] = useState<RoutingPreviewResult | null>(null);
  const [previewText, setPreviewText] = useState('');
  const [previewing, setPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const highlightFor = useCallback(
    (agentId: string): AgentNodeData['highlight'] => {
      if (!preview || preview.agentId !== agentId) return 'none';
      return preview.outcome === 'escalate_to_human' ? 'blocked' : 'routed';
    },
    [preview],
  );

  useEffect(() => {
    setNodes(
      agents.map((agent, index) => ({
        id: agent.id,
        type: 'agent',
        position:
          agent.canvasX !== null && agent.canvasY !== null
            ? { x: agent.canvasX, y: agent.canvasY }
            : fallbackPosition(index),
        data: { agent, highlight: highlightFor(agent.id) },
      })),
    );
    setEdges(buildEdges(agents));
  }, [agents, highlightFor, setNodes, setEdges]);

  const onConnect = useCallback(
    async (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const agent = agents.find((candidate) => candidate.id === connection.source);
      if (!agent) return;

      const isEscalation = connection.sourceHandle === ESCALATION_HANDLE;
      setError(null);
      setEdges((current) => addEdge({ ...connection, animated: isEscalation }, current));

      try {
        await api.updateAgent(agent.id, {
          name: agent.name,
          category: agent.category,
          specialization: agent.specialization,
          description: agent.description,
          persona: agent.persona,
          tone: agent.tone,
          language: agent.language,
          greeting: agent.greeting,
          businessContext: agent.businessContext,
          responseStyle: agent.responseStyle,
          systemInstruction: agent.systemInstruction,
          humanTakeoverPolicy: agent.humanTakeoverPolicy,
          triggerKeywords: agent.triggerKeywords,
          blockedKeywords: agent.blockedKeywords,
          responseDelaySeconds: agent.responseDelaySeconds,
          priority: agent.priority,
          parentAgentId: isEscalation ? agent.parentAgentId : connection.target,
          escalateToAgentId: isEscalation ? connection.target : agent.escalateToAgentId,
        });
        onChanged();
      } catch {
        setError('Could not save that link. It may create a loop or point outside this workspace.');
        onChanged();
      }
    },
    [agents, onChanged, setEdges],
  );

  const onNodeDragStop = useCallback(
    async (_event: unknown, node: Node) => {
      try {
        await api.updateAgentPosition(node.id, node.position.x, node.position.y);
      } catch {
        setError('Could not save that position.');
      }
    },
    [],
  );

  async function handlePreview() {
    if (!previewText.trim()) return;
    setPreviewing(true);
    setError(null);
    try {
      setPreview(await api.previewAgentRouting(previewText.trim()));
    } catch {
      setError('Could not run that routing preview.');
    } finally {
      setPreviewing(false);
    }
  }

  const previewTone = useMemo(() => {
    if (!preview) return '';
    if (preview.outcome === 'route') return 'text-accent';
    if (preview.outcome === 'escalate_to_human') return 'text-warning';
    return 'text-fg-muted';
  }, [preview]);

  if (agents.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
        <Bot size={22} className="text-fg-muted" aria-hidden />
        <p className="text-sm text-fg-secondary">No agents to arrange yet.</p>
        <p className="text-xs text-fg-muted">Create an agent first, then drag it into place here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col">
      <div className="shrink-0 border-b border-border-subtle bg-surface-1 px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={previewText}
            onChange={(event) => setPreviewText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void handlePreview();
            }}
            placeholder="Test a real customer message to see which agent would handle it…"
            className="min-w-0 flex-1 rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-accent focus:outline-none"
          />
          <button
            type="button"
            onClick={() => void handlePreview()}
            disabled={previewing || !previewText.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-dim disabled:opacity-50"
          >
            <Play size={13} aria-hidden />
            {previewing ? 'Routing…' : 'Preview'}
          </button>
        </div>

        {preview && <p className={`mt-2 text-xs ${previewTone}`}>{preview.reason}</p>}
        {error && <p className="mt-2 text-xs text-error">{error}</p>}

        <p className="mt-2 text-[11px] text-fg-muted">
          Drag tiles to arrange. Pull from the <span className="text-accent">right socket</span> to set escalation (real
          runtime behaviour), or the bottom socket to record who an agent reports to (structure only — it does not change
          which agent replies).
        </p>
      </div>

      <div className="min-h-0 flex-1">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={(connection) => void onConnect(connection)}
          onNodeDragStop={(event, node) => void onNodeDragStop(event, node)}
          nodeTypes={nodeTypes}
          snapToGrid
          snapGrid={[16, 16]}
          fitView
          proOptions={{ hideAttribution: false }}
        >
          <Background gap={16} />
          <Controls />
        </ReactFlow>
      </div>
    </div>
  );
}
