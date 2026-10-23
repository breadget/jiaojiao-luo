export const studioNodeTypes = [
  'trigger',
  'aiAgent',
  'llmModel',
  'memory',
  'tool',
  'condition',
  'httpRequest',
  'database',
  'transform',
  'robotAction',
  'subworkflow',
  'output',
  'legacyStep',
  'externalN8nWorkflow',
] as const;

export type StudioNodeType = (typeof studioNodeTypes)[number];

export type ConnectionKind =
  | 'main'
  | 'model'
  | 'memory'
  | 'tool'
  | 'branch'
  | 'subworkflow';

export type RuntimeNodeState =
  | 'idle'
  | 'waiting'
  | 'running'
  | 'success'
  | 'error'
  | 'skipped';

export type WorkflowPort = {
  id: string;
  label: string;
  kind: ConnectionKind;
  direction: 'input' | 'output';
  required: boolean;
  maxConnections: number | null;
};

export type WorkflowGraphNode = {
  id: string;
  type: StudioNodeType;
  name: string;
  description: string;
  position: { x: number; y: number };
  ports: WorkflowPort[];
  config: Record<string, unknown>;
  disabled?: boolean;
};

export type WorkflowGraphEdge = {
  id: string;
  kind: ConnectionKind;
  source: { nodeId: string; portId: string };
  target: { nodeId: string; portId: string };
  label?: string;
  condition?: { branch: string };
};

export type WorkflowGraphV1 = {
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  revision: number;
  nodes: WorkflowGraphNode[];
  edges: WorkflowGraphEdge[];
  entryNodeIds: string[];
  runtime: {
    engine: 'n8n';
    adapter: 'n8n-v1';
    executionMode: 'webhook';
    binding: 'external' | 'draft';
  };
  viewport: { x: number; y: number; zoom: number };
  metadata: {
    source: 'legacy-steps' | 'urtoris';
    updatedAt: number;
  };
};

export type NodeRuntimeSnapshot = {
  state: RuntimeNodeState;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  /** 失败原因（人类可读的一句话）。只有真的失败过才有值。 */
  error?: string;
  /** 机器可读的失败码，例如 NODE_ERROR / LLM_TIMEOUT。 */
  errorCode?: string;
  /** 更长的堆栈/细节，默认折叠在 Inspector 里。 */
  errorDetail?: string;
};
