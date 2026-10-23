'use client';

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  applyNodeChanges,
  type Connection,
  type Edge,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance,
} from '@xyflow/react';
import {
  Activity,
  ArrowLeft,
  Bot,
  Box,
  Braces,
  BrainCircuit,
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Clock3,
  CloudCog,
  Code2,
  Database,
  Download,
  GitBranch,
  Globe2,
  KeyRound,
  Layers3,
  Loader2,
  LockKeyhole,
  MemoryStick,
  MousePointer2,
  PackageCheck,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCcw,
  RotateCcw,
  Save,
  ScanSearch,
  Search,
  ServerCog,
  Settings2,
  ShieldAlert,
  TerminalSquare,
  Trash2,
  Unplug,
  Webhook,
  Workflow,
  X,
  XCircle,
  Zap,
} from 'lucide-react';
import { LocalDatabaseFields } from '@/components/studio/local-database-fields';
import { readDatabasePairingLink } from '@/lib/local-database-client';
import { hasLocalDatabaseNodes } from '@/lib/workflow-graph/local-database';
import { AgentConstraintsFields } from '@/components/studio/agent-constraints-fields';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from 'react';

import {
  createGraphNode,
  nodeRegistry,
  paletteNodeTypes,
  type NodeCategory,
} from '@/lib/workflow-graph/registry';
import { projectLegacyWorkflow } from '@/lib/workflow-graph/project-legacy';
import {
  DEFAULT_LLM_PROVIDER_ID,
  isLlmReasoningEffort,
  providerDefaults,
  providerOptions,
  type LlmReasoningEffort,
} from '@/lib/llm/providers';
import type {
  ConnectionKind,
  NodeRuntimeSnapshot,
  RuntimeNodeState,
  StudioNodeType,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';
import type {
  WorkflowAgentMode,
  WorkflowAgentProposal,
} from '@/lib/workflow-graph/agent';
import { checkConnection } from '@/lib/workflow-graph/connections';
import { randomId } from '@/lib/random-id';
import {
  connectionKindLabel,
  deriveEdgeRunState,
  describeEdgeEndpoints,
  edgeDisplayLabel,
  summarizeEdgeRunStates,
  type EdgeRunState,
} from '@/lib/workflow-graph/edge-runtime';
import {
  applyRunTelemetry,
  decideTelemetryPoll,
  mergeRuntimeState,
  summarizeTelemetry,
  type RunTelemetryPayload,
  type RunTelemetryNode,
  type TelemetrySummary,
} from '@/lib/workflow-graph/telemetry';
import {
  describeStudioRunResult,
  planStudioRun,
  type StudioRunTrace,
} from '@/lib/workflow-graph/studio-run';
import { validateGraph } from '@/lib/workflow-graph/validate';
import {
  parseStudioRunInput,
  studioNodeRole,
  type StudioRunInput,
} from '@/lib/workflow-graph/studio-input';
import { WorkflowTerminal } from './workflow-terminal';
import type {
  StateResponse,
  WorkflowRecord,
  WorkflowRun,
  WorkflowStep,
} from '@/lib/workflow-types';

const GRAPH_STORAGE_PREFIX = 'urtoris.studio.graph.v1';
const ADMIN_TOKEN_STORAGE_KEY = 'urtoris.admin.token.v1';
const CREATOR_AGENT_STORAGE_KEY = 'urtoris.studio.creator-agent.v1';
const DRAG_MIME = 'application/x-urtoris-node';

type CreatorAgentConfig = {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  reasoningEffort: LlmReasoningEffort;
};

const defaultCreatorAgentConfig: CreatorAgentConfig = {
  provider: DEFAULT_LLM_PROVIDER_ID,
  apiKey: '',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-plus',
  reasoningEffort: 'auto',
};

const fallbackWorkflow: WorkflowRecord = {
  id: 'wf_demo_triage',
  name: '客户请求分流',
  description: '接收请求、判断优先级，由 Agent 生成处理摘要并调用机器人动作。',
  draftSteps: [
    {
      id: 'step_intake',
      title: '读取客户请求',
      detail: '接收主题、正文和来源渠道',
      kind: 'input',
    },
    {
      id: 'step_priority',
      title: '判断优先级',
      detail: '根据影响范围和紧急程度分级',
      kind: 'decision',
    },
    {
      id: 'step_summary',
      title: '生成处理摘要',
      detail: '由 Agent 整理问题、优先级和建议动作',
      kind: 'compose',
    },
    {
      id: 'step_return',
      title: '回传到使用端',
      detail: '输出结构化结果与运行记录',
      kind: 'output',
    },
  ],
  publishedSteps: null,
  version: 0,
  hasUnpublishedChanges: true,
  createdAt: 0,
  updatedAt: 0,
  publishedAt: null,
  n8nWebhookUrl: null,
};

const iconByType: Record<StudioNodeType, typeof Workflow> = {
  trigger: Webhook,
  aiAgent: Bot,
  llmModel: BrainCircuit,
  memory: MemoryStick,
  tool: ServerCog,
  condition: GitBranch,
  httpRequest: Globe2,
  database: Database,
  transform: Braces,
  robotAction: Radio,
  subworkflow: Layers3,
  output: TerminalSquare,
  legacyStep: Box,
  externalN8nWorkflow: CloudCog,
};

const kindColor: Record<ConnectionKind, string> = {
  main: '#aebcc8',
  branch: '#62d69c',
  model: '#ad8cff',
  memory: '#66a7ff',
  tool: '#35c6c4',
  subworkflow: '#e5b95f',
};

/** 连接运行态 → 颜色；null = 沿用连接类型自己的颜色。 */
const edgeRunColor: Record<EdgeRunState, string | null> = {
  idle: null,
  waiting: null,
  carrying: '#62d69c',
  taken: '#62d69c',
  untaken: '#66757f',
  error: '#ff6b6b',
};

const edgeRunText: Record<EdgeRunState, string> = {
  idle: '未运行',
  waiting: '未观测到',
  carrying: '数据流动中',
  taken: '这条路径走了',
  untaken: '这条路径没走',
  error: '下游节点失败',
};

const categoryOrder: NodeCategory[] = [
  'Trigger',
  'Agent',
  'Logic',
  'Data',
  'Actions',
  'Resources',
];

type CanvasNodeData = {
  graphNode: WorkflowGraphNode;
  runtime: NodeRuntimeSnapshot;
};

type CanvasNode = Node<CanvasNodeData, 'urtorisNode'>;

type ExecutionEntry = {
  id: string;
  at: number;
  nodeId?: string;
  level: 'info' | 'success' | 'error';
  message: string;
};

/**
 * 一次运行的真实节点遥测状态。
 *
 * `done` 只代表"轮询按停止规则收工"，不代表节点全部成功 —— 每个节点的生死
 * 以 `summary` 里的计数为准。
 */
type TelemetryMeta = {
  status: 'polling' | 'done' | 'timeout' | 'unavailable' | 'error';
  binding: 'prebound' | 'legacy' | null;
  boundVersion: number | null;
  bindingCount: number;
  eventCount: number;
  summary: TelemetrySummary | null;
  unmappedNodes: string[];
  message?: string;
};

/** 发布版本列表项（来自 /graph/versions）。 */
type ReleaseVersion = {
  id: string;
  version: number;
  graphRevision: number;
  graphHash: string;
  compiledHash: string | null;
  adapter: string;
  adapterVersion: string;
  nodeCount: number;
  connectionCount: number;
  publishedAt: number;
  publishedBy: string | null;
  active: boolean;
};

/** 编译预览结果（来自 /graph/preview），只读、不写库。 */
type CompilePreview = {
  adapter?: string;
  nextVersion: number;
  ok: boolean;
  graphHash: string;
  compiledHash: string | null;
  compiledJson: string | null;
  issues: { level: 'error' | 'warning'; message: string; nodeId?: string }[];
  requiredCredentialRefs: string[];
  stats: {
    internalNodes: number;
    externalNodes: number;
    connections: number;
    unsupportedNodes: number;
  };
};

type CreatorAgentProposal = WorkflowAgentProposal & {
  model: string;
  compile: {
    ready: boolean;
    adapter: string;
    adapterVersion: string;
    issues: {
      level: 'error' | 'warning';
      message: string;
      nodeId?: string;
    }[];
    requiredCredentialRefs: string[];
    stats: {
      internalNodes: number;
      externalNodes: number;
      connections: number;
      unsupportedNodes: number;
    };
  };
};

type CreatorAgentUndo = {
  workflowId: string;
  graph: WorkflowGraphV1;
  appliedFingerprint: string;
};

function delay(milliseconds: number) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

/** 可中断的等待：abort 后立即返回，避免卸载后还在轮询。 */
function waitFor(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    function onAbort() {
      window.clearTimeout(timer);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function formatDuration(duration?: number) {
  if (duration === undefined) return null;
  return duration >= 1000
    ? `${(duration / 1000).toFixed(2)} s`
    : `${duration} ms`;
}

function formatWorkflowDate(timestamp: number) {
  if (!timestamp) return '演示数据';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp));
}

function isGraph(value: unknown): value is WorkflowGraphV1 {
  if (!value || typeof value !== 'object') return false;
  const graph = value as Partial<WorkflowGraphV1>;
  return (
    graph.schemaVersion === 1 &&
    Array.isArray(graph.nodes) &&
    Array.isArray(graph.edges) &&
    Array.isArray(graph.entryNodeIds)
  );
}

function configString(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

/**
 * Model 节点的服务选择：供应商下拉 + 模型名（可手填）+ Base URL。
 * 下拉只列注册表里认识的模型服务；老草稿里的历史值原样显示，不会被悄悄改掉。
 */
function ModelServiceFields({
  node,
  onChange,
}: {
  node: WorkflowGraphNode;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const options = providerOptions();
  const currentId = configString(node.config.provider, DEFAULT_LLM_PROVIDER_ID);
  const known = options.some((option) => option.id === currentId);
  const current = options.find((option) => option.id === currentId);

  return (
    <>
      <label>
        <span>模型服务</span>
        <select
          value={currentId}
          onChange={(event) => {
            const next = providerDefaults(event.target.value);
            if (!next) return;
            onChange({
              ...node.config,
              provider: next.id,
              baseUrl: next.baseUrl,
              model: next.model,
            });
          }}
        >
          {known ? null : (
            <option value={currentId}>{currentId}（历史值）</option>
          )}
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.vendor} · {option.label}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>Model</span>
        <input
          list={`studio-node-model-${node.id}`}
          value={configString(node.config.model, current?.defaultModel ?? '')}
          placeholder={current?.defaultModel || '例如 gpt-4o-mini'}
          onChange={(event) =>
            onChange({ ...node.config, model: event.target.value })
          }
        />
        <datalist id={`studio-node-model-${node.id}`}>
          {(current?.models ?? []).map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </datalist>
      </label>
      <label>
        <span>Base URL</span>
        <input
          value={configString(node.config.baseUrl)}
          placeholder={current?.defaultBaseUrl || 'https://你的网关/v1'}
          inputMode="url"
          onChange={(event) =>
            onChange({ ...node.config, baseUrl: event.target.value })
          }
        />
      </label>
      {current?.requiresBaseUrl ? (
        <p className="studio-agent-privacy">
          这个服务没有默认端点，Base URL 必填；填了才会带上 Key 发出去。
        </p>
      ) : null}
    </>
  );
}

function StatusGlyph({ state }: { state: RuntimeNodeState }) {
  if (state === 'running') return <Loader2 className="studio-spin" />;
  if (state === 'success') return <CheckCircle2 />;
  if (state === 'error') return <XCircle />;
  if (state === 'waiting') return <Clock3 />;
  if (state === 'skipped') return <Unplug />;
  return <CircleDashed />;
}

function PortHandle({
  portId,
  kind,
  direction,
  position,
  style,
}: {
  portId: string;
  kind: ConnectionKind;
  direction: 'input' | 'output';
  position: Position;
  style?: React.CSSProperties;
}) {
  return (
    <Handle
      id={portId}
      type={direction === 'input' ? 'target' : 'source'}
      position={position}
      className={`studio-handle studio-handle-${kind}`}
      title={`${direction === 'input' ? '输入接口' : '输出接口'} · ${connectionKindLabel(kind)}`}
      aria-label={`${direction === 'input' ? '输入接口' : '输出接口'} · ${connectionKindLabel(kind)}`}
      style={style}
    />
  );
}

function StudioCanvasNode({ data, selected }: NodeProps<CanvasNode>) {
  const { graphNode: node, runtime } = data;
  const Icon = iconByType[node.type];
  const isResource = ['llmModel', 'memory', 'tool', 'subworkflow'].includes(
    node.type,
  );
  const databaseToolPort =
    node.type === 'database'
      ? node.ports.find((port) => port.id === 'tool.provider')
      : undefined;
  const hasMainInput = node.ports.some((port) => port.id === 'main.in');
  const hasMainOutput = node.ports.some((port) => port.id === 'main.out');

  return (
    <article
      className={`studio-node studio-node-${node.type} studio-node-state-${runtime.state}${
        selected ? ' studio-node-selected' : ''
      }`}
      aria-label={`${node.name}，${runtime.state}`}
      title={runtime.error ?? undefined}
    >
      {hasMainInput ? (
        <PortHandle
          portId="main.in"
          kind="main"
          direction="input"
          position={Position.Left}
        />
      ) : null}
      {hasMainOutput ? (
        <PortHandle
          portId="main.out"
          kind="main"
          direction="output"
          position={Position.Right}
        />
      ) : null}
      {isResource || databaseToolPort ? (
        <PortHandle
          portId={databaseToolPort?.id ?? node.ports[0]?.id ?? 'provider'}
          kind={databaseToolPort?.kind ?? node.ports[0]?.kind ?? 'tool'}
          direction="input"
          position={Position.Top}
        />
      ) : null}
      {node.type === 'condition' ? (
        <>
          <PortHandle
            portId="branch.true"
            kind="branch"
            direction="output"
            position={Position.Right}
            style={{ top: '37%' }}
          />
          <PortHandle
            portId="branch.false"
            kind="branch"
            direction="output"
            position={Position.Right}
            style={{ top: '73%' }}
          />
          <span className="studio-branch-label studio-branch-label-true">
            true
          </span>
          <span className="studio-branch-label studio-branch-label-false">
            false
          </span>
        </>
      ) : null}
      {node.type === 'aiAgent' ? (
        <>
          <PortHandle
            portId="resource.model"
            kind="model"
            direction="output"
            position={Position.Bottom}
            style={{ left: '22%' }}
          />
          <PortHandle
            portId="resource.memory"
            kind="memory"
            direction="output"
            position={Position.Bottom}
            style={{ left: '50%' }}
          />
          <PortHandle
            portId="resource.tools"
            kind="tool"
            direction="output"
            position={Position.Bottom}
            style={{ left: '78%' }}
          />
          <div className="studio-agent-port-labels" aria-hidden="true">
            <span>Model</span>
            <span>Memory</span>
            <span>Tools</span>
          </div>
        </>
      ) : null}

      <div className="studio-node-heading">
        <span className={`studio-node-icon studio-node-icon-${node.type}`}>
          <Icon />
        </span>
        <span className="studio-node-title">
          <strong>{node.name}</strong>
          <small>
            {studioNodeRole(node.type)}
            {node.type === 'aiAgent' &&
            configString(node.config.constraints).trim()
              ? ' · 有行为限制'
              : ''}
          </small>
        </span>
        <span
          className={`studio-node-status studio-node-status-${runtime.state}`}
          title={runtime.state}
        >
          <StatusGlyph state={runtime.state} />
        </span>
      </div>
      <p>{node.description}</p>
      <div className="studio-node-meta">
        <span>
          {isResource
            ? nodeRegistry[node.type].capability
            : node.type === 'trigger'
              ? '接收输入 → 传入处理节点'
              : node.type === 'output'
                ? '接收处理结果 → 返回输出'
                : node.type === 'condition'
                  ? '输入 → 条件处理 → 分支输出'
                  : '输入 → 处理 → 输出'}
        </span>
        {formatDuration(runtime.durationMs) ? (
          <b>{formatDuration(runtime.durationMs)}</b>
        ) : null}
      </div>
      {runtime.error ? (
        // 失败原因直接贴到卡片上：画布上就该看得出"为什么红"，
        // 完整堆栈留给 Inspector（这里只放错误码 + 一句话）。
        <div className="studio-node-error" title={runtime.error}>
          <CircleAlert />
          <span>{runtime.errorCode ?? 'ERROR'}</span>
          <em>{runtime.error}</em>
        </div>
      ) : null}
    </article>
  );
}

const nodeTypes = { urtorisNode: StudioCanvasNode };

function graphStorageKey(workflowId: string) {
  return `${GRAPH_STORAGE_PREFIX}.${workflowId}`;
}

function canvasNodeSize(node: WorkflowGraphNode) {
  if (node.type === 'aiAgent') return { width: 286, height: 132 };
  if (['llmModel', 'memory', 'tool', 'subworkflow'].includes(node.type)) {
    return { width: 210, height: 98 };
  }
  return { width: 238, height: 112 };
}

function canvasNodeHandles(
  node: WorkflowGraphNode,
): NonNullable<CanvasNode['handles']> {
  const { width, height } = canvasNodeSize(node);
  const size = 12;
  const handles: NonNullable<CanvasNode['handles']> = [];
  const add = (
    id: string,
    type: 'source' | 'target',
    position: Position,
    x: number,
    y: number,
  ) => handles.push({ id, type, position, x, y, width: size, height: size });

  if (node.ports.some((port) => port.id === 'main.in')) {
    add('main.in', 'target', Position.Left, -size / 2, height / 2 - size / 2);
  }
  if (node.ports.some((port) => port.id === 'main.out')) {
    add(
      'main.out',
      'source',
      Position.Right,
      width - size / 2,
      height / 2 - size / 2,
    );
  }
  if (node.type === 'condition') {
    add(
      'branch.true',
      'source',
      Position.Right,
      width - size / 2,
      height * 0.37 - size / 2,
    );
    add(
      'branch.false',
      'source',
      Position.Right,
      width - size / 2,
      height * 0.73 - size / 2,
    );
  }
  if (node.type === 'aiAgent') {
    add(
      'resource.model',
      'source',
      Position.Bottom,
      width * 0.22 - size / 2,
      height - size / 2,
    );
    add(
      'resource.memory',
      'source',
      Position.Bottom,
      width * 0.5 - size / 2,
      height - size / 2,
    );
    add(
      'resource.tools',
      'source',
      Position.Bottom,
      width * 0.78 - size / 2,
      height - size / 2,
    );
  }
  if (
    node.type === 'database' &&
    node.ports.some((port) => port.id === 'tool.provider')
  ) {
    add(
      'tool.provider',
      'target',
      Position.Top,
      width / 2 - size / 2,
      -size / 2,
    );
  }
  if (['llmModel', 'memory', 'tool', 'subworkflow'].includes(node.type)) {
    add(
      node.ports[0]?.id ?? 'provider',
      'target',
      Position.Top,
      width / 2 - size / 2,
      -size / 2,
    );
  }
  return handles;
}

function legacyStepsFromGraph(
  workflow: WorkflowRecord,
  graph: WorkflowGraphV1,
): WorkflowStep[] {
  const nodesByLegacyId = new Map(
    graph.nodes
      .filter((node) => typeof node.config.legacyStepId === 'string')
      .map((node) => [node.config.legacyStepId as string, node]),
  );
  return workflow.draftSteps.map((step) => {
    const node = nodesByLegacyId.get(step.id);
    return node
      ? { ...step, title: node.name, detail: node.description }
      : step;
  });
}

function StudioSurface() {
  useEffect(() => {
    readDatabasePairingLink();
  }, []);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([
    fallbackWorkflow,
  ]);
  const [workflowId, setWorkflowId] = useState(fallbackWorkflow.id);
  const workflow =
    workflows.find((item) => item.id === workflowId) ?? workflows[0];
  const [graph, setGraph] = useState<WorkflowGraphV1>(() =>
    projectLegacyWorkflow(fallbackWorkflow),
  );
  const usesLocalDatabase = hasLocalDatabaseNodes(graph);
  const databaseAgent = graph.nodes.filter(
    (node) => node.type === 'aiAgent' && !node.disabled,
  );
  const [runtime, setRuntime] = useState<Record<string, NodeRuntimeSnapshot>>(
    {},
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(
    'node_step_summary',
  );
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [reactFlow, setReactFlow] = useState<ReactFlowInstance<
    CanvasNode,
    Edge
  > | null>(null);
  const [fitRequest, setFitRequest] = useState(0);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [compactMode, setCompactMode] = useState(false);
  const [query, setQuery] = useState('');
  const [saveState, setSaveState] = useState<
    'idle' | 'saving' | 'saved' | 'error'
  >('idle');
  const [releaseState, setReleaseState] = useState<
    'idle' | 'working' | 'published' | 'error'
  >('idle');
  const [releaseMessage, setReleaseMessage] = useState<string | null>(null);
  const [compilePreview, setCompilePreview] = useState<CompilePreview | null>(
    null,
  );
  const [compilePreviewBase, setCompilePreviewBase] = useState<string | null>(
    null,
  );
  const [releaseVersions, setReleaseVersions] = useState<
    ReleaseVersion[] | null
  >(null);
  const [activeVersionId, setActiveVersionId] = useState<string | null>(null);
  const [serviceState, setServiceState] = useState<
    'loading' | 'connected' | 'demo'
  >('loading');
  const [graphPersistence, setGraphPersistence] = useState<
    'projected' | 'local' | 'server'
  >('projected');
  const [adminToken, setAdminToken] = useState(() => {
    if (typeof window === 'undefined') return '';
    try {
      return window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  /** 服务端判定"本机/内网访问"时为 true：这时不需要 Admin token。 */
  const [adminTrusted, setAdminTrusted] = useState(false);
  /** 有令牌，或本机/内网访问被服务端当成管理员会话。 */
  const adminAuthorized = Boolean(adminToken.trim()) || adminTrusted;
  const [workflowLibraryOpen, setWorkflowLibraryOpen] = useState(false);
  const [workflowLibraryQuery, setWorkflowLibraryQuery] = useState('');
  const [workflowLibraryMessage, setWorkflowLibraryMessage] = useState<
    string | null
  >(null);
  const [workflowMutation, setWorkflowMutation] = useState<string | null>(null);
  const [pendingWorkflowDelete, setPendingWorkflowDelete] = useState<
    string | null
  >(null);
  const [creatorAgentOpen, setCreatorAgentOpen] = useState(false);
  const [creatorAgentMode, setCreatorAgentMode] =
    useState<WorkflowAgentMode>('edit');
  const [creatorAgentPrompt, setCreatorAgentPrompt] = useState('');
  const [creatorAgentConfig, setCreatorAgentConfig] =
    useState<CreatorAgentConfig>(() => {
      if (typeof window === 'undefined') return defaultCreatorAgentConfig;
      try {
        const stored = window.sessionStorage.getItem(CREATOR_AGENT_STORAGE_KEY);
        if (!stored) return defaultCreatorAgentConfig;
        const parsed = JSON.parse(stored) as Partial<CreatorAgentConfig>;
        const storedProvider =
          typeof parsed.provider === 'string' &&
          providerDefaults(parsed.provider)
            ? parsed.provider
            : defaultCreatorAgentConfig.provider;
        return {
          provider: storedProvider,
          apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
          baseUrl:
            typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
              ? parsed.baseUrl
              : defaultCreatorAgentConfig.baseUrl,
          model:
            typeof parsed.model === 'string' && parsed.model.trim()
              ? parsed.model
              : defaultCreatorAgentConfig.model,
          reasoningEffort: isLlmReasoningEffort(parsed.reasoningEffort)
            ? parsed.reasoningEffort
            : 'auto',
        };
      } catch {
        return defaultCreatorAgentConfig;
      }
    });
  const [creatorAgentState, setCreatorAgentState] = useState<
    'idle' | 'working' | 'applying' | 'applied' | 'error'
  >('idle');
  const [creatorAgentError, setCreatorAgentError] = useState<string | null>(
    null,
  );
  const [creatorDiscoveredModels, setCreatorDiscoveredModels] = useState<
    string[]
  >([]);
  const [creatorModelDiscovery, setCreatorModelDiscovery] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error';
    message: string;
  }>({ status: 'idle', message: '' });
  const [creatorAgentProposal, setCreatorAgentProposal] =
    useState<CreatorAgentProposal | null>(null);
  const [creatorAgentProposalBase, setCreatorAgentProposalBase] = useState<
    string | null
  >(null);
  const [creatorAgentUndo, setCreatorAgentUndo] =
    useState<CreatorAgentUndo | null>(null);
  const [creatorAgentAppliedMode, setCreatorAgentAppliedMode] =
    useState<WorkflowAgentMode | null>(null);
  const [running, setRunning] = useState(false);
  const [connectionMessage, setConnectionMessage] = useState<string | null>(
    null,
  );
  const [executionEntries, setExecutionEntries] = useState<ExecutionEntry[]>(
    [],
  );
  const [executionTab, setExecutionTab] = useState<
    'terminal' | 'timeline' | 'input' | 'output' | 'log' | 'error'
  >('terminal');
  const [terminalInput, setTerminalInput] = useState('');
  const [terminalInputError, setTerminalInputError] = useState<string | null>(
    null,
  );
  const [terminalSubmittedInput, setTerminalSubmittedInput] = useState<
    string | null
  >(null);
  const [terminalResponse, setTerminalResponse] = useState<{
    data: unknown;
  } | null>(null);
  const [lastRunInput, setLastRunInput] = useState<StudioRunInput | null>(null);
  const terminalInputRef = useRef<HTMLTextAreaElement>(null);
  const terminalSessionRef = useRef('');
  const [runMeta, setRunMeta] = useState<{
    runId: string;
    requestId?: string;
    engine: string;
    mode: string;
    degraded: boolean;
    durationMs?: number;
    trace: StudioRunTrace;
    output?: WorkflowRun['output'];
    error?: string;
  } | null>(null);
  const [telemetryMeta, setTelemetryMeta] = useState<TelemetryMeta | null>(
    null,
  );
  const firstHydration = useRef(true);
  const graphRef = useRef(graph);
  const pendingCreatorAgentGraphRef = useRef<WorkflowGraphV1 | null>(null);
  const workflowMetadataTargetRef = useRef<string | null>(null);
  const telemetryAbortRef = useRef<AbortController | null>(null);
  const workflowNameInputRef = useRef<HTMLInputElement>(null);
  const workflowLibraryRef = useRef<HTMLDialogElement>(null);
  const workflowLibraryTriggerRef = useRef<HTMLButtonElement>(null);
  const workflowLibraryCloseRef = useRef<HTMLButtonElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorCloseRef = useRef<HTMLButtonElement>(null);
  const creatorAgentRef = useRef<HTMLDialogElement>(null);
  const creatorAgentTriggerRef = useRef<HTMLButtonElement>(null);
  const creatorAgentCloseRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

  useEffect(() => {
    return () => telemetryAbortRef.current?.abort();
  }, []);

  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get('panel') === 'workflows'
    ) {
      queueMicrotask(() => setWorkflowLibraryOpen(true));
    }
  }, []);

  useEffect(() => {
    const media = window.matchMedia('(max-width: 900px)');
    const syncCompactMode = () => {
      setCompactMode(media.matches);
      if (!media.matches) setInspectorOpen(false);
    };
    syncCompactMode();
    media.addEventListener('change', syncCompactMode);
    return () => media.removeEventListener('change', syncCompactMode);
  }, []);

  useEffect(() => {
    if (!compactMode || !inspectorOpen) return;
    const panel = inspectorRef.current;
    const fallbackTrigger = inspectorTriggerRef.current;
    const closeButton = inspectorCloseRef.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : fallbackTrigger;
    const selector =
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusable = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(selector) ?? []).filter(
        (element) => element.getClientRects().length > 0,
      );
    const focusTimer = window.setTimeout(
      () => (closeButton ?? focusable()[0])?.focus(),
      0,
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setInspectorOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      window.requestAnimationFrame(() => {
        const target = previous?.isConnected ? previous : fallbackTrigger;
        target?.focus();
      });
    };
  }, [compactMode, inspectorOpen]);

  useEffect(() => {
    if (!creatorAgentOpen) return;
    const panel = creatorAgentRef.current;
    const fallbackTrigger = creatorAgentTriggerRef.current;
    const closeButton = creatorAgentCloseRef.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : fallbackTrigger;
    const selector =
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [href], [tabindex]:not([tabindex="-1"])';
    const focusable = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(selector) ?? []).filter(
        (element) => element.getClientRects().length > 0,
      );
    const focusTimer = window.setTimeout(
      () => (closeButton ?? focusable()[0])?.focus(),
      0,
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setCreatorAgentOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      window.requestAnimationFrame(() => {
        const target = previous?.isConnected ? previous : fallbackTrigger;
        target?.focus();
      });
    };
  }, [creatorAgentOpen]);

  useEffect(() => {
    if (!workflowLibraryOpen) return;
    const panel = workflowLibraryRef.current;
    const fallbackTrigger = workflowLibraryTriggerRef.current;
    const closeButton = workflowLibraryCloseRef.current;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : fallbackTrigger;
    const selector =
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';
    const focusable = () =>
      Array.from(panel?.querySelectorAll<HTMLElement>(selector) ?? []).filter(
        (element) => element.getClientRects().length > 0,
      );
    const focusTimer = window.setTimeout(
      () => (closeButton ?? focusable()[0])?.focus(),
      0,
    );

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPendingWorkflowDelete(null);
        setWorkflowLibraryOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
      window.requestAnimationFrame(() => {
        const target = previous?.isConnected ? previous : fallbackTrigger;
        target?.focus();
      });
    };
  }, [workflowLibraryOpen]);

  useEffect(() => {
    void fetch('/api/state', { cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error('state unavailable');
        return (await response.json()) as StateResponse;
      })
      .then((state) => {
        setAdminTrusted(state.adminTrusted === true);
        if (state.workflows.length) {
          setWorkflows(state.workflows);
          setWorkflowId(state.workflows[0].id);
          setServiceState('connected');
        } else {
          setServiceState('demo');
        }
      })
      .catch(() => setServiceState('demo'));
  }, []);

  useEffect(() => {
    if (!workflow) return;
    const editMetadata = workflowMetadataTargetRef.current === workflow.id;
    let nextGraph = projectLegacyWorkflow(workflow);
    let nextPersistence: 'projected' | 'local' | 'server' = 'projected';
    const pendingGraph = pendingCreatorAgentGraphRef.current;
    if (pendingGraph?.id === workflow.id) {
      nextGraph = pendingGraph;
      nextPersistence = 'server';
      pendingCreatorAgentGraphRef.current = null;
    } else {
      try {
        const stored = window.localStorage.getItem(
          graphStorageKey(workflow.id),
        );
        if (stored) {
          const parsed: unknown = JSON.parse(stored);
          if (isGraph(parsed)) {
            nextGraph = parsed;
            nextPersistence = 'local';
          }
        }
      } catch {
        // A bad local draft must never block opening the server workflow.
      }
    }
    const preferredAgent = nextGraph.nodes.find(
      (node) => node.type === 'aiAgent',
    );
    queueMicrotask(() => {
      setGraphPersistence(nextPersistence);
      setGraph(nextGraph);
      setSelectedNodeId(
        editMetadata
          ? null
          : (preferredAgent?.id ?? nextGraph.nodes[0]?.id ?? null),
      );
      setRuntime({});
      setExecutionEntries([]);
      setTerminalInput('');
      setTerminalInputError(null);
      setTerminalSubmittedInput(null);
      setTerminalResponse(null);
      setLastRunInput(null);
      terminalSessionRef.current = `studio_${randomId().slice(0, 16)}`;
      setRunMeta(null);
      setTelemetryMeta(null);
      setSaveState('idle');
      setCompilePreview(null);
      setCompilePreviewBase(null);
      setReleaseMessage(null);
      setCreatorAgentProposal(null);
      setCreatorAgentProposalBase(null);
      setCreatorAgentUndo(null);
      setCreatorAgentAppliedMode(null);
      setCreatorAgentState('idle');
      setCreatorAgentError(null);
      setFitRequest((current) => current + 1);
      firstHydration.current = false;
      if (editMetadata) {
        workflowMetadataTargetRef.current = null;
        window.requestAnimationFrame(() =>
          workflowNameInputRef.current?.focus(),
        );
      }
    });
  }, [workflow]);

  useEffect(() => {
    if (
      serviceState !== 'connected' ||
      !adminAuthorized ||
      !workflow ||
      graphPersistence === 'local'
    ) {
      return;
    }
    const controller = new AbortController();
    void fetch(`/api/workflows/${encodeURIComponent(workflow.id)}/graph`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: adminToken.trim()
        ? { Authorization: `Bearer ${adminToken.trim()}` }
        : {},
    })
      .then(async (response) => {
        const data = (await response.json()) as {
          graph?: WorkflowGraphV1;
          error?: string;
        };
        if (!response.ok || !data.graph) {
          throw new Error(data.error ?? 'Graph 读取失败');
        }
        return data.graph;
      })
      .then((serverGraph) => {
        setGraph(serverGraph);
        setGraphPersistence('server');
        setSaveState('saved');
        setFitRequest((current) => current + 1);
      })
      .catch((cause) => {
        if (cause instanceof DOMException && cause.name === 'AbortError')
          return;
        setConnectionMessage(
          cause instanceof Error ? cause.message : 'Graph 读取失败',
        );
      });
    return () => controller.abort();
  }, [adminAuthorized, adminToken, graphPersistence, serviceState, workflow]);

  useEffect(() => {
    if (!reactFlow || fitRequest === 0) return;
    const timer = window.setTimeout(() => {
      const currentGraph = graphRef.current;
      const focus =
        currentGraph.nodes.find((node) => node.type === 'aiAgent') ??
        currentGraph.nodes[0];
      if (focus) {
        const size = canvasNodeSize(focus);
        void reactFlow.setCenter(
          focus.position.x + size.width / 2,
          focus.position.y + size.height / 2,
          {
            zoom: window.matchMedia('(max-width: 900px)').matches ? 0.76 : 0.72,
            duration: 280,
          },
        );
        return;
      }
      void reactFlow.fitView({ padding: 0.24, maxZoom: 0.86, duration: 280 });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [fitRequest, reactFlow]);

  useEffect(() => {
    if (firstHydration.current) return;
    setSaveState('idle');
  }, [graph.nodes, graph.edges, graph.name, graph.description]);

  useEffect(() => {
    try {
      if (adminToken.trim()) {
        window.sessionStorage.setItem(
          ADMIN_TOKEN_STORAGE_KEY,
          adminToken.trim(),
        );
      } else {
        window.sessionStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
      }
    } catch {
      // Private browsing can block session storage.
    }
  }, [adminToken]);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(
        CREATOR_AGENT_STORAGE_KEY,
        JSON.stringify(creatorAgentConfig),
      );
    } catch {
      // 隐私模式下仍可在当前 React 会话中使用。
    }
  }, [creatorAgentConfig]);

  const issues = useMemo(() => validateGraph(graph), [graph]);
  const errorCount = issues.filter((issue) => issue.level === 'error').length;
  const selectedNode = graph.nodes.find((node) => node.id === selectedNodeId);
  const selectedEdge = graph.edges.find((edge) => edge.id === selectedEdgeId);

  /**
   * 这次运行是否已经定稿。
   *
   * 只有定稿之后才允许把"下游从未开始"判成"这条路没走"；运行中一律保守处理，
   * 否则跑一半的画布会先把没轮到的分支画成虚线，看起来像已经结束。
   */
  const runFinished =
    Boolean(runMeta) &&
    !running &&
    (runMeta?.trace !== 'run-envelope' || telemetryMeta?.status !== 'polling');

  /**
   * 这次运行到底有没有**节点级观测**。
   *
   * 光有 runMeta 不算：模拟运行、遥测不可用、或还没收到任何事件时，runtime 里
   * 全是 idle/waiting。那种情况下把整张图刷成"未观测到"的灰虚线，看起来像画布
   * 坏了，而且暗示"这些连接没走"——我们其实什么都没看见。保持默认态最诚实。
   */
  const hasNodeTelemetry = useMemo(
    () =>
      Object.values(runtime).some(
        (snapshot) => snapshot.state !== 'idle' && snapshot.state !== 'waiting',
      ),
    [runtime],
  );

  const edgeRunStates = useMemo(() => {
    const states = new Map<string, EdgeRunState>();
    for (const edge of graph.edges) {
      states.set(
        edge.id,
        deriveEdgeRunState({
          kind: edge.kind,
          sourceState: runtime[edge.source.nodeId]?.state ?? 'idle',
          targetState: runtime[edge.target.nodeId]?.state ?? 'idle',
          hasRun: hasNodeTelemetry,
          runFinished,
        }),
      );
    }
    return states;
  }, [graph.edges, hasNodeTelemetry, runFinished, runtime]);

  const edgeRunSummary = useMemo(
    () => summarizeEdgeRunStates(edgeRunStates.values()),
    [edgeRunStates],
  );

  const selectedEdgeEndpoints = selectedEdge
    ? describeEdgeEndpoints(graph, selectedEdge)
    : null;
  const selectedEdgeIssues = selectedEdge
    ? issues.filter((issue) => issue.edgeId === selectedEdge.id)
    : [];
  const selectedEdgeRunState: EdgeRunState = selectedEdge
    ? (edgeRunStates.get(selectedEdge.id) ?? 'idle')
    : 'idle';
  const edgeRunSummaryText = !hasNodeTelemetry
    ? '—'
    : `taken ${edgeRunSummary.taken} · untaken ${edgeRunSummary.untaken} · error ${edgeRunSummary.error} · carrying ${edgeRunSummary.carrying}`;

  const canvasNodes = useMemo<CanvasNode[]>(
    () =>
      graph.nodes.map((node) => ({
        ...canvasNodeSize(node),
        id: node.id,
        type: 'urtorisNode',
        position: node.position,
        handles: canvasNodeHandles(node),
        data: {
          graphNode: node,
          runtime: runtime[node.id] ?? { state: 'idle' },
        },
        selected: node.id === selectedNodeId,
      })),
    [graph.nodes, runtime, selectedNodeId],
  );

  const canvasEdges = useMemo<Edge[]>(
    () =>
      graph.edges.map((edge) => {
        const runState = edgeRunStates.get(edge.id) ?? 'idle';
        const stroke = edgeRunColor[runState] ?? kindColor[edge.kind];
        // 没走的分支和没观测到的连接一律虚线：线型本身就是"这条边没送数据"的
        // 证据，颜色之外再给一层不依赖色觉的编码。
        const dashed = runState === 'untaken' || runState === 'waiting';
        const opacity =
          runState === 'untaken' ? 0.5 : runState === 'waiting' ? 0.72 : 1;
        return {
          id: edge.id,
          source: edge.source.nodeId,
          sourceHandle: edge.source.portId,
          target: edge.target.nodeId,
          targetHandle: edge.target.portId,
          // React Flow's built-in bezier edge is named "default". Passing
          // "bezier" makes it fall back while emitting a warning each render.
          type: 'default',
          label: edgeDisplayLabel(graph, edge),
          animated: runState === 'carrying',
          selected: edge.id === selectedEdgeId,
          className: `studio-edge studio-edge-${edge.kind} studio-edge-run-${runState}`,
          style: {
            stroke,
            strokeWidth:
              runState === 'carrying' ? 3 : runState === 'idle' ? 1.7 : 2.2,
            opacity,
            ...(dashed ? { strokeDasharray: '6 5' } : {}),
          },
          labelStyle: { fill: '#c7d3dc', fontSize: 10, fontWeight: 700 },
          labelBgStyle: { fill: '#111b25', fillOpacity: 0.94 },
          labelBgPadding: [5, 3] as [number, number],
          labelBgBorderRadius: 4,
          markerEnd:
            edge.kind === 'main' || edge.kind === 'branch'
              ? {
                  type: MarkerType.ArrowClosed,
                  color: stroke,
                  width: 15,
                  height: 15,
                }
              : undefined,
        };
      }),
    [edgeRunStates, graph, selectedEdgeId],
  );

  const updateNode = useCallback(
    (nodeId: string, change: Partial<WorkflowGraphNode>) => {
      setGraph((current) => ({
        ...current,
        metadata: { ...current.metadata, updatedAt: Date.now() },
        nodes: current.nodes.map((node) =>
          node.id === nodeId ? { ...node, ...change } : node,
        ),
      }));
    },
    [],
  );

  /** 连接本身也是可编辑对象：改标签、删连线都要走同一条写路径。 */
  const updateEdge = useCallback(
    (edgeId: string, change: Partial<WorkflowGraphEdge>) => {
      setGraph((current) => ({
        ...current,
        metadata: { ...current.metadata, updatedAt: Date.now() },
        edges: current.edges.map((edge) =>
          edge.id === edgeId ? { ...edge, ...change } : edge,
        ),
      }));
    },
    [],
  );

  const removeEdge = useCallback((edgeId: string) => {
    setGraph((current) => ({
      ...current,
      metadata: { ...current.metadata, updatedAt: Date.now() },
      edges: current.edges.filter((edge) => edge.id !== edgeId),
    }));
    setSelectedEdgeId((current) => (current === edgeId ? null : current));
  }, []);

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const selectedChange = changes.find(
        (change) => change.type === 'select' && change.selected,
      );
      if (selectedChange?.type === 'select') {
        setSelectedNodeId(selectedChange.id);
      }

      // React Flow also emits selection and dimension-measurement changes.
      // Those are view state, not draft edits, and must not invalidate the
      // Agent proposal fingerprint or its one-step undo guard.
      const persistedChanges = changes.filter(
        (change) => change.type === 'position' || change.type === 'remove',
      );
      if (!persistedChanges.length) return;

      const nextCanvas = applyNodeChanges(persistedChanges, canvasNodes);
      const nextById = new Map(nextCanvas.map((node) => [node.id, node]));
      setGraph((current) => ({
        ...current,
        metadata: { ...current.metadata, updatedAt: Date.now() },
        nodes: current.nodes
          .filter((node) => nextById.has(node.id))
          .map((node) => ({
            ...node,
            position: nextById.get(node.id)?.position ?? node.position,
          })),
        edges: current.edges.filter(
          (edge) =>
            nextById.has(edge.source.nodeId) &&
            nextById.has(edge.target.nodeId),
        ),
        entryNodeIds: current.entryNodeIds.filter((id) => nextById.has(id)),
      }));
    },
    [canvasNodes],
  );

  const buildConnection = useCallback(
    (connection: Connection): WorkflowGraphEdge | null => {
      if (
        !connection.source ||
        !connection.target ||
        !connection.sourceHandle ||
        !connection.targetHandle
      ) {
        return null;
      }
      // 规则集中在 lib/workflow-graph/connections.ts，与服务端校验和测试同源。
      const result = checkConnection(graph, {
        sourceNodeId: connection.source,
        sourcePortId: connection.sourceHandle,
        targetNodeId: connection.target,
        targetPortId: connection.targetHandle,
      });
      if (!result.ok) {
        setConnectionMessage(result.reason);
        return null;
      }
      return result.edge;
    },
    [graph],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      const next = buildConnection(connection);
      if (!next) return;
      setGraph((current) => ({
        ...current,
        edges: [...current.edges, next],
        metadata: { ...current.metadata, updatedAt: Date.now() },
      }));
      setConnectionMessage('连接已建立。');
      window.setTimeout(() => setConnectionMessage(null), 1600);
    },
    [buildConnection],
  );

  const addNode = useCallback(
    (type: StudioNodeType, position?: { x: number; y: number }) => {
      const node = createGraphNode(
        type,
        position ??
          reactFlow?.screenToFlowPosition({
            x: window.innerWidth * 0.5,
            y: window.innerHeight * 0.45,
          }) ?? { x: 420, y: 280 },
      );
      setGraph((current) => ({
        ...current,
        nodes: [...current.nodes, node],
        entryNodeIds:
          type === 'trigger' && current.entryNodeIds.length === 0
            ? [node.id]
            : current.entryNodeIds,
        metadata: {
          ...current.metadata,
          source: 'urtoris',
          updatedAt: Date.now(),
        },
      }));
      setSelectedNodeId(node.id);
      if (compactMode) {
        setInspectorOpen(true);
      }
    },
    [compactMode, reactFlow],
  );

  const onDrop = useCallback(
    (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      const type = event.dataTransfer.getData(DRAG_MIME) as StudioNodeType;
      if (!paletteNodeTypes.includes(type) || !reactFlow) return;
      addNode(
        type,
        reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      );
    },
    [addNode, reactFlow],
  );

  const removeSelected = useCallback(() => {
    if (!selectedNodeId) return;
    setGraph((current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== selectedNodeId),
      edges: current.edges.filter(
        (edge) =>
          edge.source.nodeId !== selectedNodeId &&
          edge.target.nodeId !== selectedNodeId,
      ),
      entryNodeIds: current.entryNodeIds.filter((id) => id !== selectedNodeId),
      metadata: { ...current.metadata, updatedAt: Date.now() },
    }));
    setSelectedNodeId(null);
  }, [selectedNodeId]);

  const saveGraph = useCallback(async (): Promise<WorkflowGraphV1 | null> => {
    setSaveState('saving');
    const nextGraph: WorkflowGraphV1 = {
      ...graph,
      name: graph.name.trim() || '未命名工作流',
      metadata: { ...graph.metadata, updatedAt: Date.now() },
    };
    let serverSavedGraph: WorkflowGraphV1 | null = null;
    try {
      let savedGraph = nextGraph;

      if (serviceState === 'connected' && adminAuthorized) {
        const graphResponse = await fetch(
          `/api/workflows/${encodeURIComponent(workflow.id)}/graph`,
          {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${adminToken.trim()}`,
            },
            body: JSON.stringify({
              graph: nextGraph,
              expectedRevision: graph.revision,
            }),
          },
        );
        const graphData = (await graphResponse.json()) as {
          graph?: WorkflowGraphV1;
          error?: string;
        };
        if (!graphResponse.ok || !graphData.graph) {
          throw new Error(graphData.error ?? 'Graph 保存失败');
        }
        savedGraph = graphData.graph;
        serverSavedGraph = savedGraph;

        const response = await fetch('/api/workflows', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${adminToken.trim()}`,
          },
          body: JSON.stringify({
            id: workflow.id,
            name: savedGraph.name,
            description: savedGraph.description,
            steps: legacyStepsFromGraph(workflow, savedGraph),
            action: 'save',
            n8nWebhookUrl: workflow.n8nWebhookUrl ?? '',
          }),
        });
        const data = (await response.json()) as {
          workflow?: WorkflowRecord;
          error?: string;
        };
        if (!response.ok || !data.workflow) {
          throw new Error(data.error ?? '服务器保存失败');
        }
        setWorkflows((current) =>
          current.map((item) =>
            item.id === data.workflow?.id
              ? (data.workflow as WorkflowRecord)
              : item,
          ),
        );
        setGraphPersistence('server');
      } else {
        setGraphPersistence('local');
      }

      window.localStorage.setItem(
        graphStorageKey(workflow.id),
        JSON.stringify(savedGraph),
      );
      setGraph(savedGraph);
      setCreatorAgentUndo(null);
      setSaveState('saved');
      setConnectionMessage(
        serviceState === 'connected' && adminAuthorized
          ? hasLocalDatabaseNodes(graph)
            ? '本机数据库草稿已保存，发布后可在使用端查询。'
            : 'Graph 草稿与兼容元数据已保存，尚未部署到 n8n。'
          : 'Graph 草稿已保存在此浏览器。',
      );
      return savedGraph;
    } catch (cause) {
      const message =
        cause instanceof Error ? cause.message : '保存失败，请重试。';
      if (serverSavedGraph) {
        const persistedGraph = serverSavedGraph;
        window.localStorage.setItem(
          graphStorageKey(workflow.id),
          JSON.stringify(persistedGraph),
        );
        setGraph(persistedGraph);
        setGraphPersistence('server');
        setCreatorAgentUndo((current) =>
          current?.workflowId === workflow.id
            ? {
                ...current,
                graph: { ...current.graph, revision: persistedGraph.revision },
                appliedFingerprint: JSON.stringify(persistedGraph),
              }
            : current,
        );
        setSaveState('error');
        setConnectionMessage(
          `Graph 已保存到 D1（rev ${persistedGraph.revision}），但兼容元数据未同步：${message}。已更新本地 revision，可直接重试。`,
        );
        return null;
      }
      setSaveState('error');
      setConnectionMessage(message);
      return null;
    }
  }, [adminAuthorized, adminToken, graph, serviceState, workflow]);

  const authorizedFetch = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      if (init.body) headers.set('Content-Type', 'application/json');
      // 本机/内网访问免令牌时不要发一个空的 Authorization 头。
      if (adminToken.trim()) {
        headers.set('Authorization', `Bearer ${adminToken.trim()}`);
      }
      return fetch(path, { ...init, headers });
    },
    [adminToken],
  );

  const openWorkflowFromLibrary = useCallback(
    (targetId: string, editMetadata = false) => {
      setWorkflowLibraryMessage(null);
      setPendingWorkflowDelete(null);
      if (editMetadata) {
        workflowMetadataTargetRef.current = targetId;
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
      }
      setWorkflowId(targetId);
      setWorkflowLibraryOpen(false);
      if (editMetadata && compactMode) setInspectorOpen(true);
      if (editMetadata && targetId === workflowId) {
        workflowMetadataTargetRef.current = null;
        window.requestAnimationFrame(() =>
          workflowNameInputRef.current?.focus(),
        );
      }
    },
    [compactMode, workflowId],
  );

  const createWorkflowFromLibrary = useCallback(async () => {
    if (!adminAuthorized || serviceState !== 'connected') {
      setWorkflowLibraryMessage(
        adminTrusted
          ? '工作流服务暂时不可用，请稍后重试。'
          : '请先在 Inspector 填写管理员令牌，再新建工作流。',
      );
      return;
    }

    setWorkflowMutation('create');
    setWorkflowLibraryMessage(null);
    try {
      const response = await authorizedFetch('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ action: 'create' }),
      });
      const data = (await response.json()) as {
        workflow?: WorkflowRecord;
        error?: string;
      };
      if (!response.ok || !data.workflow) {
        throw new Error(data.error ?? '新建工作流失败。');
      }
      const created = data.workflow;
      setWorkflows((current) => [
        created,
        ...current.filter((item) => item.id !== created.id),
      ]);
      workflowMetadataTargetRef.current = created.id;
      setWorkflowId(created.id);
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      setWorkflowLibraryOpen(false);
      if (compactMode) setInspectorOpen(true);
      setConnectionMessage('工作流已新建；填写名称和用途后点 Save。');
    } catch (cause) {
      setWorkflowLibraryMessage(
        cause instanceof Error ? cause.message : '新建工作流失败。',
      );
    } finally {
      setWorkflowMutation(null);
    }
  }, [
    adminAuthorized,
    adminTrusted,
    authorizedFetch,
    compactMode,
    serviceState,
  ]);

  const deleteWorkflowFromLibrary = useCallback(
    async (targetId: string) => {
      if (!adminAuthorized || serviceState !== 'connected') {
        setWorkflowLibraryMessage(
          adminTrusted
            ? '工作流服务暂时不可用，请稍后重试。'
            : '请先在 Inspector 填写管理员令牌，再删除工作流。',
        );
        return;
      }

      setWorkflowMutation(targetId);
      setWorkflowLibraryMessage(null);
      try {
        const response = await authorizedFetch(
          `/api/workflows/${encodeURIComponent(targetId)}`,
          { method: 'DELETE' },
        );
        const data = (await response.json()) as {
          deleted?: boolean;
          error?: string;
        };
        if (!response.ok || !data.deleted) {
          throw new Error(data.error ?? '删除工作流失败。');
        }

        const remaining = workflows.filter((item) => item.id !== targetId);
        setWorkflows(remaining);
        setPendingWorkflowDelete(null);
        try {
          window.localStorage.removeItem(graphStorageKey(targetId));
        } catch {
          // 浏览器禁用本地存储时，服务端删除仍然有效。
        }
        if (workflowId === targetId && remaining[0]) {
          setWorkflowId(remaining[0].id);
        }
      } catch (cause) {
        setWorkflowLibraryMessage(
          cause instanceof Error ? cause.message : '删除工作流失败。',
        );
      } finally {
        setWorkflowMutation(null);
      }
    },
    [
      adminAuthorized,
      adminTrusted,
      authorizedFetch,
      serviceState,
      workflowId,
      workflows,
    ],
  );

  const canUseServer =
    serviceState === 'connected' &&
    (Boolean(adminToken.trim()) || adminTrusted);

  /**
   * 辅助 Agent 与「保存草稿 / 编译 / 发布」不是一回事：
   * 它只拿用户自己的 Key 去生成提案，服务端不读不写任何数据，所以不需要 Admin token，
   * 只要站点 API 连通就能用。
   */
  const canUseCreatorAgent = serviceState === 'connected';
  /** 画布里那个「工作流运行时用的」模型节点：和辅助 Agent 的配置是两回事。 */
  const graphModelNode = graph.nodes.find((node) => node.type === 'llmModel');
  const creatorAgentProvider = providerOptions().find(
    (item) => item.id === creatorAgentConfig.provider,
  );
  const creatorSelectableModels = Array.from(
    new Set([
      ...(creatorAgentProvider?.models ?? []),
      ...creatorDiscoveredModels,
    ]),
  );
  const creatorAgentKeyRequired = creatorAgentProvider?.keyRequired ?? true;

  const creatorAgentProposalStale = Boolean(
    creatorAgentProposal?.mode === 'edit' &&
    creatorAgentProposalBase !== JSON.stringify(graph),
  );
  const creatorAgentUndoAvailable = Boolean(
    creatorAgentUndo?.workflowId === workflow.id &&
    creatorAgentUndo.appliedFingerprint === JSON.stringify(graph),
  );
  const compilePreviewStale = Boolean(
    compilePreview && compilePreviewBase !== JSON.stringify(graph),
  );

  const discoverCreatorModels = useCallback(async () => {
    setCreatorModelDiscovery({
      status: 'loading',
      message: '正在读取模型…',
    });
    try {
      const response = await authorizedFetch('/api/llm/models', {
        method: 'POST',
        body: JSON.stringify({
          provider: creatorAgentConfig.provider,
          apiKey: creatorAgentConfig.apiKey.trim() || undefined,
          baseUrl: creatorAgentConfig.baseUrl.trim() || undefined,
        }),
      });
      const data = (await response.json()) as {
        models?: string[];
        error?: string;
      };
      if (!response.ok || !Array.isArray(data.models)) {
        throw new Error(data.error ?? '没有读到模型列表。');
      }
      setCreatorDiscoveredModels(data.models);
      setCreatorAgentConfig((current) => ({
        ...current,
        model: current.model.trim() || data.models?.[0] || '',
      }));
      setCreatorModelDiscovery({
        status: 'success',
        message: `已识别 ${data.models.length} 个模型`,
      });
    } catch (cause) {
      setCreatorDiscoveredModels([]);
      setCreatorModelDiscovery({
        status: 'error',
        message: cause instanceof Error ? cause.message : '读取模型失败。',
      });
    }
  }, [authorizedFetch, creatorAgentConfig]);

  const requestCreatorAgentProposal = useCallback(async () => {
    if (!canUseCreatorAgent) {
      setCreatorAgentState('error');
      setCreatorAgentError(
        '网站 API 未连通，暂时无法调用辅助 Agent。请稍后重试或点「刷新数据」。',
      );
      return;
    }
    if (creatorAgentPrompt.trim().length < 5) {
      setCreatorAgentState('error');
      setCreatorAgentError('请用至少 5 个字说明要创建或修改什么。');
      return;
    }
    if (creatorAgentKeyRequired && !creatorAgentConfig.apiKey.trim()) {
      setCreatorAgentState('error');
      setCreatorAgentError('请输入本次模型调用的 API Key。');
      return;
    }

    const baseFingerprint =
      creatorAgentMode === 'edit' ? JSON.stringify(graph) : null;
    setCreatorAgentState('working');
    setCreatorAgentError(null);
    setCreatorAgentProposal(null);
    setCreatorAgentAppliedMode(null);
    try {
      const response = await authorizedFetch('/api/workflows/agent', {
        method: 'POST',
        body: JSON.stringify({
          mode: creatorAgentMode,
          prompt: creatorAgentPrompt.trim(),
          provider: creatorAgentConfig.provider,
          apiKey: creatorAgentConfig.apiKey.trim(),
          baseUrl: creatorAgentConfig.baseUrl.trim(),
          model: creatorAgentConfig.model.trim(),
          reasoningEffort: creatorAgentConfig.reasoningEffort,
          ...(creatorAgentMode === 'edit' ? { graph } : {}),
        }),
      });
      const data = (await response.json()) as {
        proposal?: CreatorAgentProposal;
        error?: string;
        details?: string[];
      };
      if (!response.ok || !data.proposal || !isGraph(data.proposal.graph)) {
        const details = data.details?.slice(0, 3).join('；');
        throw new Error(
          `${data.error ?? 'Agent 没有返回可用提案。'}${details ? ` ${details}` : ''}`,
        );
      }
      setCreatorAgentProposal(data.proposal);
      setCreatorAgentProposalBase(baseFingerprint);
      setCreatorAgentState('idle');
    } catch (cause) {
      setCreatorAgentState('error');
      setCreatorAgentError(
        cause instanceof Error ? cause.message : 'Agent 提案生成失败。',
      );
    }
  }, [
    authorizedFetch,
    canUseCreatorAgent,
    creatorAgentConfig,
    creatorAgentKeyRequired,
    creatorAgentMode,
    creatorAgentPrompt,
    graph,
  ]);

  const applyCreatorAgentProposal = useCallback(async () => {
    const proposal = creatorAgentProposal;
    if (!proposal) return;
    if (proposal.mode === 'edit') {
      if (creatorAgentProposalBase !== JSON.stringify(graph)) {
        setCreatorAgentState('error');
        setCreatorAgentError(
          '提案生成后画布已发生变化。请重新生成，避免覆盖新修改。',
        );
        return;
      }
      const nextGraph: WorkflowGraphV1 = {
        ...proposal.graph,
        id: workflow.id,
        revision: graph.revision,
        metadata: {
          ...proposal.graph.metadata,
          source: 'urtoris',
          updatedAt: Date.now(),
        },
      };
      setCreatorAgentUndo({
        workflowId: workflow.id,
        graph,
        appliedFingerprint: JSON.stringify(nextGraph),
      });
      setGraph(nextGraph);
      setSelectedEdgeId(null);
      setSelectedNodeId(
        nextGraph.nodes.find((node) => node.type === 'aiAgent')?.id ??
          nextGraph.nodes[0]?.id ??
          null,
      );
      setFitRequest((current) => current + 1);
      setCreatorAgentProposal(null);
      setCreatorAgentProposalBase(null);
      setCreatorAgentState('applied');
      setCreatorAgentAppliedMode('edit');
      setSaveState('idle');
      setConnectionMessage(
        'Agent 提案已应用到当前画布，尚未保存。可先检查节点，再点 Save。',
      );
      return;
    }

    if (!canUseServer) {
      setCreatorAgentState('error');
      setCreatorAgentError(
        '新建工作流会写进 D1，需要 Inspector 里的 Admin token；只想在画布上试试可以直接用「编辑当前」。',
      );
      return;
    }

    setCreatorAgentState('applying');
    setCreatorAgentError(null);
    let createdWorkflow: WorkflowRecord | null = null;
    let savedGraph: WorkflowGraphV1 | null = null;
    try {
      const createResponse = await authorizedFetch('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({ action: 'create' }),
      });
      const createData = (await createResponse.json()) as {
        workflow?: WorkflowRecord;
        error?: string;
      };
      if (!createResponse.ok || !createData.workflow) {
        throw new Error(createData.error ?? '新建工作流失败。');
      }
      createdWorkflow = createData.workflow;
      const candidate: WorkflowGraphV1 = {
        ...proposal.graph,
        id: createdWorkflow.id,
        revision: 0,
        runtime: { ...proposal.graph.runtime, binding: 'draft' },
        metadata: {
          ...proposal.graph.metadata,
          source: 'urtoris',
          updatedAt: Date.now(),
        },
      };
      const graphResponse = await authorizedFetch(
        `/api/workflows/${encodeURIComponent(createdWorkflow.id)}/graph`,
        {
          method: 'PUT',
          body: JSON.stringify({ graph: candidate, expectedRevision: 0 }),
        },
      );
      const graphData = (await graphResponse.json()) as {
        graph?: WorkflowGraphV1;
        error?: string;
      };
      if (!graphResponse.ok || !graphData.graph) {
        throw new Error(graphData.error ?? 'Agent Graph 保存失败。');
      }
      savedGraph = graphData.graph;

      const metadataResponse = await authorizedFetch('/api/workflows', {
        method: 'POST',
        body: JSON.stringify({
          id: createdWorkflow.id,
          name: savedGraph.name,
          description: savedGraph.description,
          steps: legacyStepsFromGraph(createdWorkflow, savedGraph),
          action: 'save',
          n8nWebhookUrl: '',
        }),
      });
      const metadataData = (await metadataResponse.json()) as {
        workflow?: WorkflowRecord;
        error?: string;
      };
      if (!metadataResponse.ok || !metadataData.workflow) {
        throw new Error(metadataData.error ?? '工作流元数据保存失败。');
      }

      pendingCreatorAgentGraphRef.current = savedGraph;
      setWorkflows((current) => [
        metadataData.workflow as WorkflowRecord,
        ...current.filter((item) => item.id !== metadataData.workflow?.id),
      ]);
      setWorkflowId(metadataData.workflow.id);
      setGraph(savedGraph);
      setGraphPersistence('server');
      setSelectedEdgeId(null);
      setSelectedNodeId(
        savedGraph.nodes.find((node) => node.type === 'aiAgent')?.id ??
          savedGraph.nodes[0]?.id ??
          null,
      );
      setCreatorAgentProposal(null);
      setCreatorAgentProposalBase(null);
      setCreatorAgentUndo(null);
      setCreatorAgentState('applied');
      setCreatorAgentAppliedMode('create');
      setCreatorAgentPrompt('');
      setFitRequest((current) => current + 1);
      setSaveState('saved');
      setConnectionMessage(
        `Agent 已创建并保存「${savedGraph.name}」Graph 草稿；尚未发布或导入 n8n。`,
      );
    } catch (cause) {
      if (createdWorkflow) {
        if (savedGraph) pendingCreatorAgentGraphRef.current = savedGraph;
        setWorkflows((current) => [
          createdWorkflow as WorkflowRecord,
          ...current.filter((item) => item.id !== createdWorkflow?.id),
        ]);
        setWorkflowId(createdWorkflow.id);
        setCreatorAgentProposal(null);
        setCreatorAgentProposalBase(null);
      }
      setCreatorAgentState('error');
      setCreatorAgentError(
        `${createdWorkflow ? '工作流记录已创建，但后续步骤未完整完成：' : ''}${
          cause instanceof Error ? cause.message : '应用 Agent 提案失败。'
        }`,
      );
    }
  }, [
    authorizedFetch,
    canUseServer,
    creatorAgentProposal,
    creatorAgentProposalBase,
    graph,
    workflow,
  ]);

  const undoCreatorAgentEdit = useCallback(() => {
    if (!creatorAgentUndo || creatorAgentUndo.workflowId !== workflow.id)
      return;
    if (creatorAgentUndo.appliedFingerprint !== JSON.stringify(graph)) {
      setCreatorAgentState('error');
      setCreatorAgentError(
        'Agent 提案应用后画布又有了新修改，为避免一起覆盖，已停用这次撤销。',
      );
      return;
    }
    const previous = creatorAgentUndo.graph;
    setGraph(previous);
    setSelectedEdgeId(null);
    setSelectedNodeId(
      previous.nodes.find((node) => node.type === 'aiAgent')?.id ??
        previous.nodes[0]?.id ??
        null,
    );
    setCreatorAgentUndo(null);
    setCreatorAgentAppliedMode(null);
    setCreatorAgentState('idle');
    setCreatorAgentError(null);
    setSaveState('idle');
    setFitRequest((current) => current + 1);
    setConnectionMessage('Agent 修改已撤销，画布恢复到应用提案之前。');
  }, [creatorAgentUndo, graph, workflow.id]);

  const abortTelemetry = useCallback(() => {
    const controller = telemetryAbortRef.current;
    if (controller) controller.abort();
    telemetryAbortRef.current = null;
  }, []);

  const pushEntry = useCallback((entry: Omit<ExecutionEntry, 'id' | 'at'>) => {
    setExecutionEntries((current) => [
      ...current,
      {
        ...entry,
        id: randomId(),
        at: Date.now(),
      },
    ]);
  }, []);

  /**
   * 轮询真实节点遥测。
   *
   * 这是节点状态的**唯一**来源：没有事件就保持 idle，绝不按主路径播放合成动画。
   * 运行可能已经结束（`/api/runs` 是同步等 n8n 返回的），所以第一轮通常就能把
   * 终态补齐；之后再等一轮空页确认没有迟到事件就收工。
   */
  const pollRunTelemetry = useCallback(
    async (requestId: string, signal: AbortSignal) => {
      const startedAt = Date.now();
      let afterSeq = 0;
      let emptyPolls = 0;
      let eventCount = 0;
      let retries = 0;
      // 客户端自己的折叠结果：分页时服务端只认识当页事件，跨页的累积在这里。
      const tracked = new Map<string, RunTelemetryNode>();
      const unmapped = new Set<string>();
      const headers = { Authorization: `Bearer ${adminToken.trim()}` };

      setTelemetryMeta({
        status: 'polling',
        binding: null,
        boundVersion: null,
        bindingCount: 0,
        eventCount: 0,
        summary: null,
        unmappedNodes: [],
      });

      // 上限只是编译器的护栏：真正收工靠 decideTelemetryPoll 的停止规则
      // （`for (;;)` 会让 react-compiler 直接以 invariant 报错）。
      for (let round = 0; round < 1_000; round += 1) {
        if (signal.aborted) return;
        let response: Response;
        try {
          response = await fetch(
            `/api/runs/${encodeURIComponent(requestId)}/telemetry?afterSeq=${afterSeq}&limit=100`,
            { cache: 'no-store', signal, headers },
          );
        } catch (cause) {
          if (signal.aborted) return;
          setTelemetryMeta((current) => ({
            ...(current ?? {
              binding: null,
              boundVersion: null,
              bindingCount: 0,
              eventCount,
              summary: null,
              unmappedNodes: [],
            }),
            status: 'error',
            message:
              cause instanceof Error
                ? `节点遥测请求失败：${cause.message}`
                : '节点遥测请求失败。',
          }));
          return;
        }

        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as {
            error?: string;
          };
          // 429 是限流，不是"读不到"：退避一次再试，不要把限流说成没有遥测。
          if (response.status === 429 && retries < 2) {
            retries += 1;
            const retryAfter = Number(response.headers.get('Retry-After'));
            const backoffMs = Number.isFinite(retryAfter)
              ? Math.min(Math.max(retryAfter * 1000, 1_000), 5_000)
              : 2_000;
            await waitFor(backoffMs, signal);
            continue;
          }
          const message =
            response.status === 401
              ? '管理员令牌无效，节点遥测不可用；运行结果本身仍然有效。'
              : response.status === 503
                ? '服务端未配置管理员令牌，节点遥测不可用。'
                : response.status === 404
                  ? '没有这次运行的遥测记录（运行记录可能已被清理）。'
                  : (payload.error ?? `节点遥测返回 ${response.status}。`);
          setTelemetryMeta((current) => ({
            ...(current ?? {
              binding: null,
              boundVersion: null,
              bindingCount: 0,
              eventCount,
              summary: null,
              unmappedNodes: [],
            }),
            status: 'unavailable',
            message,
          }));
          pushEntry({ level: 'info', message: `[遥测] ${message}` });
          return;
        }

        const payload = (await response.json()) as RunTelemetryPayload;
        const pageEvents = Array.isArray(payload.events)
          ? payload.events.length
          : 0;
        eventCount += pageEvents;
        retries = 0;

        setRuntime((current) => applyRunTelemetry(current, payload.nodes));

        for (const node of payload.nodes) {
          const before = tracked.get(node.nodeId);
          const state = mergeRuntimeState(before?.state, node.state);
          tracked.set(node.nodeId, {
            ...(before ?? node),
            state,
            durationMs: node.durationMs ?? before?.durationMs ?? null,
            startedAt: before?.startedAt ?? node.startedAt ?? null,
            finishedAt: node.finishedAt ?? before?.finishedAt ?? null,
            conflicts: (before?.conflicts ?? 0) + node.conflicts,
            lastEventSeq: node.lastEventSeq ?? before?.lastEventSeq ?? null,
          });
          if (before?.state === state) continue;
          const duration = formatDuration(node.durationMs ?? undefined);
          if (state === 'running') {
            pushEntry({
              nodeId: node.nodeId,
              level: 'info',
              message: `[遥测] ${node.name} 开始执行`,
            });
          } else if (state === 'success') {
            pushEntry({
              nodeId: node.nodeId,
              level: 'success',
              message: `[遥测] ${node.name} 执行成功${duration ? ` · ${duration}` : ''}`,
            });
          } else if (state === 'error') {
            pushEntry({
              nodeId: node.nodeId,
              level: 'error',
              message: `[遥测] ${node.name} 执行失败${duration ? ` · ${duration}` : ''}${
                node.error?.message ? `：${node.error.message}` : ''
              }`,
            });
          } else if (state === 'skipped') {
            pushEntry({
              nodeId: node.nodeId,
              level: 'info',
              message: `[遥测] ${node.name} 未被执行`,
            });
          }
        }
        for (const name of payload.unmappedNodes ?? []) unmapped.add(name);

        const summary = summarizeTelemetry([...tracked.values()]);
        emptyPolls = pageEvents === 0 ? emptyPolls + 1 : 0;
        const decision = decideTelemetryPoll({
          payload,
          emptyPolls,
          elapsedMs: Date.now() - startedAt,
        });

        setTelemetryMeta({
          status:
            decision.action === 'stop'
              ? decision.reason === 'timeout'
                ? 'timeout'
                : 'done'
              : 'polling',
          binding: payload.binding ?? null,
          boundVersion: payload.boundVersion ?? null,
          bindingCount: payload.bindingCount ?? 0,
          eventCount,
          summary,
          unmappedNodes: [...unmapped].sort(),
          message:
            decision.action === 'stop' && decision.reason === 'timeout'
              ? '轮询到达时限仍未收到终态；已显示收到的事件，不补造节点状态。'
              : undefined,
        });

        if (decision.action === 'fetch-more') {
          afterSeq = decision.afterSeq;
          continue;
        }
        if (decision.action === 'stop') {
          const unmappedNodes = [...unmapped].sort();
          if (!payload.bindingCount) {
            pushEntry({
              level: 'info',
              message: `[遥测] 这次运行没有节点绑定，画布节点不会点亮${
                unmappedNodes.length
                  ? `；${unmappedNodes.length} 个 n8n 节点未映射`
                  : ''
              }。`,
            });
          } else {
            pushEntry({
              level: summary.error ? 'error' : 'success',
              message: `[遥测] ${summary.total} 个画布节点：success ${summary.success} · error ${summary.error} · skipped ${summary.skipped} · waiting ${summary.waiting}${
                unmappedNodes.length
                  ? `；未映射 n8n 节点 ${unmappedNodes.length} 个`
                  : ''
              }`,
            });
          }
          return;
        }
        await waitFor(decision.delayMs, signal);
        afterSeq = decision.afterSeq;
      }
    },
    [adminToken, pushEntry],
  );

  const refreshVersions = useCallback(async () => {
    if (!canUseServer) return;
    try {
      const response = await authorizedFetch(
        `/api/workflows/${encodeURIComponent(workflow.id)}/graph/versions`,
      );
      if (!response.ok) return;
      const data = (await response.json()) as {
        versions?: ReleaseVersion[];
        activeVersionId?: string | null;
      };
      setReleaseVersions(data.versions ?? []);
      setActiveVersionId(data.activeVersionId ?? null);
    } catch {
      // 版本列表失败不影响编辑；下个动作会再取一次
    }
  }, [authorizedFetch, canUseServer, workflow.id]);

  const revealReleasePanel = useCallback(() => {
    setSelectedNodeId(null);
    setSelectedEdgeId(null);
    if (compactMode) setInspectorOpen(true);
  }, [compactMode]);

  const previewCompile = useCallback(async () => {
    revealReleasePanel();
    if (!canUseServer) {
      setReleaseMessage('编译预览需要连接站点；公网部署还要填管理员令牌。');
      return;
    }
    setReleaseState('working');
    setReleaseMessage(null);
    setCompilePreview(null);
    setCompilePreviewBase(null);
    const previewBase = JSON.stringify(graph);
    try {
      const response = await authorizedFetch(
        `/api/workflows/${encodeURIComponent(workflow.id)}/graph/preview`,
        { method: 'POST', body: JSON.stringify({ graph }) },
      );
      const data = (await response.json()) as CompilePreview & {
        error?: string;
      };
      if (!response.ok) throw new Error(data.error ?? '编译预览失败');
      setCompilePreview(data);
      setCompilePreviewBase(previewBase);
      setReleaseState('idle');
      setReleaseMessage(
        data.ok
          ? data.adapter === 'local-sqlite'
            ? `本机执行计划验证通过：将发布为 v${data.nextVersion}，发布后可在使用端查询。`
            : `编译预览通过：将发布为 v${data.nextVersion}，产物 hash ${data.compiledHash?.slice(0, 12)}…（未导入 n8n）`
          : `编译预览未通过：${data.issues.filter((issue) => issue.level === 'error').length} 条阻断错误`,
      );
    } catch (cause) {
      setReleaseState('error');
      setReleaseMessage(
        cause instanceof Error ? cause.message : '编译预览失败',
      );
    }
  }, [authorizedFetch, canUseServer, graph, revealReleasePanel, workflow.id]);

  const downloadCompilePreview = useCallback(() => {
    if (
      !compilePreview?.ok ||
      !compilePreview.compiledJson ||
      compilePreviewBase !== JSON.stringify(graph)
    ) {
      setReleaseMessage('画布已变化，请重新编译预览后再下载。');
      return;
    }
    const blob = new Blob([compilePreview.compiledJson], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const safeWorkflowId = workflow.id.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
    anchor.href = url;
    anchor.download = `${safeWorkflowId}-${compilePreview.adapter === 'local-sqlite' ? 'local-sqlite' : 'n8n'}-v${compilePreview.nextVersion}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
    setReleaseMessage(
      compilePreview.adapter === 'local-sqlite'
        ? `已下载本机执行计划（v${compilePreview.nextVersion}），发布后可用。`
        : `已下载 n8n JSON（v${compilePreview.nextVersion}）；产物未导入，也未激活。`,
    );
  }, [compilePreview, compilePreviewBase, graph, workflow.id]);

  const publishGraph = useCallback(async () => {
    revealReleasePanel();
    if (!canUseServer) {
      setReleaseMessage('发布快照需要连接站点；公网部署还要填管理员令牌。');
      return;
    }
    setReleaseState('working');
    setReleaseMessage(null);
    try {
      // 发布读取的是服务端草稿，所以先保存，再用保存后的 revision 发布。
      const saved = await saveGraph();
      if (!saved) throw new Error('草稿保存失败，已取消发布。');
      const response = await authorizedFetch(
        `/api/workflows/${encodeURIComponent(workflow.id)}/graph/publish`,
        {
          method: 'POST',
          body: JSON.stringify({ expectedRevision: saved.revision }),
        },
      );
      const data = (await response.json()) as {
        version?: ReleaseVersion;
        issues?: CompilePreview['issues'];
        error?: string;
      };
      if (!response.ok || !data.version) {
        setCompilePreviewBase(null);
        setCompilePreview(
          data.issues
            ? {
                nextVersion: 0,
                ok: false,
                graphHash: '',
                compiledHash: null,
                issues: data.issues,
                requiredCredentialRefs: [],
                compiledJson: null,
                stats: {
                  internalNodes: 0,
                  externalNodes: 0,
                  connections: 0,
                  unsupportedNodes: 0,
                },
              }
            : null,
        );
        throw new Error(data.error ?? '发布失败');
      }
      setReleaseState('published');
      setReleaseMessage(
        data.version.adapter === 'local-sqlite'
          ? `已发布本机数据库工作流 v${data.version.version}，可在使用端连接助手后运行。`
          : `已固化发布版本 v${data.version.version}（不可覆盖，可随时回滚）。尚未导入 n8n。`,
      );
      await refreshVersions();
    } catch (cause) {
      setReleaseState('error');
      setReleaseMessage(cause instanceof Error ? cause.message : '发布失败');
    }
  }, [
    authorizedFetch,
    canUseServer,
    refreshVersions,
    revealReleasePanel,
    saveGraph,
    workflow.id,
  ]);

  const rollbackToVersion = useCallback(
    async (versionId: string, version: number) => {
      if (!canUseServer) return;
      setReleaseState('working');
      setReleaseMessage(null);
      try {
        const response = await authorizedFetch(
          `/api/workflows/${encodeURIComponent(workflow.id)}/graph/versions/${encodeURIComponent(versionId)}/rollback`,
          { method: 'POST' },
        );
        const data = (await response.json()) as { error?: string };
        if (!response.ok) throw new Error(data.error ?? '回滚失败');
        setReleaseState('published');
        setReleaseMessage(`发布指针已回滚到 v${version}。历史版本仍然保留。`);
        await refreshVersions();
      } catch (cause) {
        setReleaseState('error');
        setReleaseMessage(cause instanceof Error ? cause.message : '回滚失败');
      }
    },
    [authorizedFetch, canUseServer, refreshVersions, workflow.id],
  );

  // 版本列表按需加载（打开 Inspector / 手动刷新 / 发布或回滚之后），
  // 不用 effect 自动拉：既避免"effect 里同步 setState"的级联渲染，
  // 也让"列表是空的"和"还没加载"两件事在 UI 上可以区分。

  const previewPath = useCallback(() => {
    const path: WorkflowGraphNode[] = [];
    let currentId = graph.entryNodeIds[0];
    const seen = new Set<string>();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const node = graph.nodes.find((item) => item.id === currentId);
      if (!node) break;
      path.push(node);
      const next = graph.edges.find(
        (edge) =>
          edge.source.nodeId === currentId &&
          (edge.kind === 'main' ||
            (edge.kind === 'branch' && edge.condition?.branch === 'true')),
      );
      currentId = next?.target.nodeId ?? '';
    }
    return path;
  }, [graph]);

  const animatePreview = useCallback(
    async (requestId: string, input: StudioRunInput) => {
      const path = previewPath();
      const pathIds = new Set(path.map((node) => node.id));
      const initial = Object.fromEntries(
        graph.nodes.map((node) => [
          node.id,
          {
            state:
              pathIds.has(node.id) ||
              ['llmModel', 'memory', 'tool'].includes(node.type)
                ? 'waiting'
                : 'skipped',
          } satisfies NodeRuntimeSnapshot,
        ]),
      );
      setRuntime(initial);
      for (const node of path) {
        setRuntime((current) => ({
          ...current,
          [node.id]: {
            state: 'running',
            input: { requestId, preview: true, ...input },
          },
        }));
        pushEntry({
          nodeId: node.id,
          level: 'info',
          message: `[本地预演] ${node.name} 开始`,
        });

        const relatedResources =
          node.type === 'aiAgent'
            ? graph.edges
                .filter(
                  (edge) =>
                    edge.source.nodeId === node.id &&
                    ['model', 'memory', 'tool'].includes(edge.kind),
                )
                .map((edge) => edge.target.nodeId)
            : [];
        if (relatedResources.length) {
          setRuntime((current) => ({
            ...current,
            ...Object.fromEntries(
              relatedResources.map((id) => [id, { state: 'running' }]),
            ),
          }));
        }
        await delay(node.type === 'aiAgent' ? 720 : 360);
        const duration =
          node.type === 'aiAgent' ? 2310 : 70 + ((node.name.length * 17) % 260);
        setRuntime((current) => ({
          ...current,
          [node.id]: {
            state: 'success',
            durationMs: duration,
            output: { success: true, node: node.name, preview: true },
          },
          ...Object.fromEntries(
            relatedResources.map((id, index) => [
              id,
              { state: 'success', durationMs: 110 + index * 42 },
            ]),
          ),
        }));
        pushEntry({
          nodeId: node.id,
          level: 'success',
          message: `[本地预演] ${node.name} 完成 · ${formatDuration(duration)}`,
        });
      }
    },
    [graph.edges, graph.nodes, previewPath, pushEntry],
  );

  const runWorkflow = useCallback(
    async (input: StudioRunInput) => {
      if (running) return;
      if (!graph.entryNodeIds.length && !workflow.publishedSteps) {
        setTerminalInputError('请先添加并连接一个输入节点。');
        return;
      }
      setRunning(true);
      setExecutionTab('terminal');
      setExecutionEntries([]);
      setTerminalInputError(null);
      setTerminalSubmittedInput(terminalInput.trim());
      setTerminalResponse(null);
      setLastRunInput(input);
      setRuntime({});
      abortTelemetry();
      setTelemetryMeta(null);
      const startedAt = Date.now();
      const previewRequestId = `req_${randomId().slice(0, 12)}`;
      const runPlan = planStudioRun(workflow);
      const initialRunMeta = {
        runId: `preview_${randomId().slice(0, 8)}`,
        requestId: runPlan.kind === 'preview' ? previewRequestId : undefined,
        engine: runPlan.engine,
        mode: runPlan.mode,
        degraded: runPlan.degraded,
        trace: runPlan.trace,
      };
      setRunMeta(initialRunMeta);
      pushEntry({
        level: 'info',
        message: runPlan.message,
      });

      let actualRun: WorkflowRun | undefined;
      const shouldPreview = !runPlan.executePublished;
      if (runPlan.executePublished) {
        try {
          const response = await fetch('/api/runs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              workflowId: workflow.id,
              ...input,
              requestId: previewRequestId,
              sessionId: input.sessionId ?? terminalSessionRef.current,
            }),
          });
          const data = (await response.json()) as {
            run?: WorkflowRun;
            envelope?: { data?: unknown };
            error?: string;
          };
          if (!response.ok || !data.run) {
            throw new Error(data.error ?? '运行接口没有返回结果');
          }
          actualRun = data.run;
          for (const log of actualRun.logs ?? []) {
            pushEntry({
              level: log.level === 'system' ? 'info' : log.level,
              message: log.message,
            });
          }
          if (actualRun.status !== 'failed') {
            setTerminalResponse({
              data:
                data.envelope && 'data' in data.envelope
                  ? data.envelope.data
                  : actualRun.output,
            });
          }
          const resultDescription = describeStudioRunResult(actualRun);
          setRunMeta({
            runId: actualRun.id,
            requestId: actualRun.requestId ?? undefined,
            engine: actualRun.engine ?? 'n8n',
            mode: actualRun.mode ?? 'rules',
            degraded: Boolean(actualRun.degraded),
            durationMs: actualRun.durationMs ?? undefined,
            trace: resultDescription.trace,
            output: actualRun.output,
            error:
              actualRun.status === 'failed'
                ? (actualRun.errorMessage ?? '工作流执行失败。')
                : undefined,
          });
          setRuntime({});
          pushEntry({
            level: actualRun.status === 'failed' ? 'error' : 'success',
            message: resultDescription.message,
          });
          // 只有真实 n8n run 才读节点遥测；没有事件就保持 idle。
          if (resultDescription.shouldPollTelemetry && actualRun.requestId) {
            abortTelemetry();
            const controller = new AbortController();
            telemetryAbortRef.current = controller;
            void pollRunTelemetry(actualRun.requestId, controller.signal);
          } else if (resultDescription.telemetryUnavailableMessage) {
            setTelemetryMeta({
              status: 'unavailable',
              binding: null,
              boundVersion: null,
              bindingCount: 0,
              eventCount: 0,
              summary: null,
              unmappedNodes: [],
              message: resultDescription.telemetryUnavailableMessage,
            });
          }
        } catch (cause) {
          const failureMessage =
            cause instanceof Error ? cause.message : '运行接口不可用';
          setRunMeta({ ...initialRunMeta, error: failureMessage });
          pushEntry({
            level: 'error',
            message: failureMessage,
          });
        }
      }

      if (shouldPreview) {
        await animatePreview(previewRequestId, input);
        const previewOutput = {
          preview: true,
          message: '本地预演完成；尚未调用真实工作流处理器。',
          input: input.input ?? { message: input.message },
        };
        setTerminalResponse({ data: previewOutput });
        setRunMeta((current) =>
          current
            ? {
                ...current,
                output: {
                  summary: '本地 Graph 预演',
                  processed: 0,
                  result: JSON.stringify(previewOutput),
                },
              }
            : current,
        );
      }
      const durationMs = Date.now() - startedAt;
      setRunMeta((current) =>
        current
          ? { ...current, durationMs: current.durationMs ?? durationMs }
          : null,
      );
      setRunning(false);
      window.requestAnimationFrame(() => terminalInputRef.current?.focus());
    },
    [
      abortTelemetry,
      animatePreview,
      graph.entryNodeIds.length,
      pollRunTelemetry,
      pushEntry,
      running,
      terminalInput,
      workflow,
    ],
  );

  const submitTerminalInput = useCallback(() => {
    if (running) return;
    try {
      const input = parseStudioRunInput(terminalInput);
      void runWorkflow(input);
    } catch (cause) {
      setTerminalInputError(
        cause instanceof Error ? cause.message : '输入格式有误。',
      );
    }
  }, [runWorkflow, running, terminalInput]);

  const openRunTerminal = useCallback(() => {
    setExecutionTab('terminal');
    setInspectorOpen(false);
    window.requestAnimationFrame(() => terminalInputRef.current?.focus());
  }, []);

  const filteredPalette = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return paletteNodeTypes.filter((type) => {
      const definition = nodeRegistry[type];
      return (
        !normalized ||
        `${definition.label} ${definition.description} ${definition.capability}`
          .toLowerCase()
          .includes(normalized)
      );
    });
  }, [query]);

  const selectedRuntime = selectedNode
    ? (runtime[selectedNode.id] ?? { state: 'idle' as const })
    : null;

  const telemetryBadge = useMemo(() => {
    if (!runMeta) return null;
    if (runMeta.trace !== 'run-envelope') {
      if (runMeta.trace === 'simulated-run') {
        return {
          label: '内置模拟 · 无 n8n 节点遥测',
          tone: 'off' as const,
        };
      }
      return {
        label: 'LOCAL PREVIEW · SYNTHETIC NODE DATA',
        tone: '' as const,
      };
    }
    if (!telemetryMeta) {
      return {
        label: 'RUN ENVELOPE · NO NODE TELEMETRY',
        tone: 'off' as const,
      };
    }
    if (telemetryMeta.status === 'polling') {
      return { label: 'RUN ENVELOPE · 读取节点遥测中', tone: 'off' as const };
    }
    if (telemetryMeta.status === 'done') {
      if (!telemetryMeta.bindingCount) {
        return { label: 'RUN ENVELOPE · 无节点绑定', tone: 'off' as const };
      }
      const summary = telemetryMeta.summary;
      const settled = summary
        ? summary.success + summary.error + summary.skipped
        : 0;
      return {
        label: `RUN ENVELOPE · 节点 ${settled}/${summary?.total ?? 0} 已定稿`,
        tone: 'ok' as const,
      };
    }
    if (telemetryMeta.status === 'timeout') {
      return { label: 'RUN ENVELOPE · 遥测未等全', tone: 'off' as const };
    }
    return { label: 'RUN ENVELOPE · 遥测不可用', tone: 'off' as const };
  }, [runMeta, telemetryMeta]);

  const telemetryNodesText = useMemo(() => {
    const summary = telemetryMeta?.summary;
    if (!summary) return '—';
    return `success ${summary.success} · error ${summary.error} · skipped ${summary.skipped} · waiting ${summary.waiting}${
      summary.conflicts ? ` · 冲突 ${summary.conflicts}` : ''
    }`;
  }, [telemetryMeta]);

  const telemetryBindingText = useMemo(() => {
    if (!telemetryMeta) return '—';
    if (!telemetryMeta.bindingCount) {
      return telemetryMeta.boundVersion
        ? `v${telemetryMeta.boundVersion} · 无绑定行`
        : '无发布版本绑定';
    }
    return `${telemetryMeta.binding ?? 'unknown'} · v${telemetryMeta.boundVersion ?? '—'} · ${telemetryMeta.bindingCount} 条`;
  }, [telemetryMeta]);

  const visibleWorkflowLibrary = useMemo(() => {
    const normalized = workflowLibraryQuery.trim().toLocaleLowerCase('zh-CN');
    if (!normalized) return workflows;
    return workflows.filter((item) =>
      `${item.name}\n${item.description}`
        .toLocaleLowerCase('zh-CN')
        .includes(normalized),
    );
  }, [workflowLibraryQuery, workflows]);
  const studioOverlayOpen = creatorAgentOpen || workflowLibraryOpen;

  return (
    <main className="studio-shell">
      <header className="studio-topbar" inert={studioOverlayOpen}>
        <div className="studio-brand-zone">
          {/* oxlint-disable-next-line next/no-html-link-for-pages -- Vinext 客户端路由异常；返回入口需要文档跳转。 */}
          <a className="studio-back" href="/" aria-label="返回双端入口">
            <ArrowLeft />
          </a>
          <span className="studio-brand-mark" aria-hidden="true">
            <Workflow />
          </span>
          <div>
            <strong>Urtoris</strong>
            <small>Workflow Studio</small>
          </div>
          <button
            ref={workflowLibraryTriggerRef}
            type="button"
            className="studio-library-trigger"
            disabled={running}
            aria-label={`打开工作流列表，共 ${workflows.length} 个`}
            aria-expanded={workflowLibraryOpen}
            aria-controls="studio-workflow-library"
            onClick={() => {
              setInspectorOpen(false);
              setWorkflowLibraryMessage(null);
              setWorkflowLibraryOpen(true);
            }}
          >
            <Workflow />
            <span>工作流</span>
            <b>{workflows.length}</b>
          </button>
        </div>

        <div className="studio-workflow-title">
          <input
            ref={workflowNameInputRef}
            aria-label="工作流名称"
            value={graph.name}
            onChange={(event) =>
              setGraph((current) => ({
                ...current,
                name: event.target.value,
                metadata: { ...current.metadata, updatedAt: Date.now() },
              }))
            }
          />
          <span>
            {graphPersistence === 'server'
              ? 'D1 graph'
              : graphPersistence === 'local'
                ? 'local draft'
                : 'projected graph'}{' '}
            · rev {graph.revision}
          </span>
        </div>

        <div className="studio-command-zone">
          <span
            className={`studio-validation-count${
              errorCount ? ' studio-validation-count-error' : ''
            }`}
          >
            {errorCount ? <CircleAlert /> : <CheckCircle2 />}
            {errorCount ? `${errorCount} errors` : 'Valid'}
          </span>
          <button
            type="button"
            className="studio-button studio-button-run"
            disabled={running}
            aria-label={
              workflow.publishedSteps ? '运行既有发布绑定' : '本地预演 Graph'
            }
            title={
              workflow.publishedSteps
                ? '打开运行终端，输入内容后运行既有发布绑定'
                : '打开预演终端，输入内容后进行本地 Graph 预演'
            }
            onClick={openRunTerminal}
          >
            {running ? <Loader2 className="studio-spin" /> : <Play />}
            {running
              ? 'Running'
              : workflow.publishedSteps
                ? 'Run binding'
                : 'Preview'}
          </button>
          <button
            type="button"
            className="studio-button"
            disabled={saveState === 'saving'}
            aria-label={saveState === 'saved' ? '工作流已保存' : '保存工作流'}
            title={saveState === 'saved' ? '工作流已保存' : '保存工作流'}
            onClick={() => void saveGraph()}
          >
            {saveState === 'saving' ? (
              <Loader2 className="studio-spin" />
            ) : saveState === 'saved' ? (
              <Check />
            ) : (
              <Save />
            )}
            {saveState === 'saved' ? 'Saved' : 'Save'}
          </button>
          <button
            ref={creatorAgentTriggerRef}
            type="button"
            className="studio-button studio-button-agent"
            aria-label="打开辅助 Agent（只改画布）"
            title="打开辅助 Agent（只改画布）"
            aria-expanded={creatorAgentOpen}
            aria-controls="studio-creator-agent"
            onClick={() => {
              setInspectorOpen(false);
              setCreatorAgentError(null);
              setCreatorAgentOpen(true);
            }}
          >
            <Bot /> Agent
          </button>
          <button
            type="button"
            className="studio-button studio-button-compile"
            disabled={!canUseServer || releaseState === 'working'}
            aria-label="编译预览"
            title={
              usesLocalDatabase
                ? '验证本机 SQLite 执行计划'
                : '只读编译：把当前画布编译成 n8n JSON 并列出错误与警告，不写库、不导入'
            }
            onClick={() => void previewCompile()}
          >
            {releaseState === 'working' ? (
              <Loader2 className="studio-spin" />
            ) : (
              <ScanSearch />
            )}
            Compile
          </button>
          <button
            type="button"
            className="studio-button studio-button-publish"
            disabled={!canUseServer || releaseState === 'working'}
            aria-label="发布工作流快照"
            title={
              usesLocalDatabase
                ? '发布本机数据库工作流，供使用端 AI 查询'
                : '把已保存的草稿固化为不可变发布版本（不导入 n8n）'
            }
            onClick={() => void publishGraph()}
          >
            {releaseState === 'working' ? (
              <Loader2 className="studio-spin" />
            ) : (
              <PackageCheck />
            )}
            Publish
          </button>
          {usesLocalDatabase ? (
            <span
              className="studio-button studio-button-deploy"
              title="浏览器通过这台电脑的数据库助手执行只读查询"
            >
              <Database /> 本机助手执行
            </span>
          ) : (
            <button
              type="button"
              className="studio-button studio-button-deploy"
              disabled
              title="发布快照已可用；导入 n8n 仍锁定，需先在克隆环境通过 Adapter canary"
              aria-label="部署锁定：Adapter canary 未通过前不导入 n8n"
            >
              <LockKeyhole /> Adapter locked
            </button>
          )}
          <button
            ref={inspectorTriggerRef}
            type="button"
            className="studio-button studio-button-inspector"
            aria-label="打开 Inspector"
            title="打开 Inspector"
            aria-expanded={inspectorOpen}
            onClick={() => {
              setInspectorOpen(true);
              void refreshVersions();
            }}
          >
            <Settings2 /> Inspector
          </button>
        </div>
      </header>

      <section className="studio-grid" inert={studioOverlayOpen}>
        <aside
          className="studio-palette"
          aria-label="节点库"
          inert={compactMode && inspectorOpen}
        >
          <div className="studio-panel-heading">
            <div>
              <strong>Nodes</strong>
              <span>拖入画布或单击添加</span>
            </div>
            <Plus />
          </div>
          <label className="studio-search">
            <Search />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索节点"
            />
          </label>
          <div className="studio-palette-scroll">
            {categoryOrder.map((category) => {
              const types = filteredPalette.filter(
                (type) => nodeRegistry[type].category === category,
              );
              if (!types.length) return null;
              return (
                <section className="studio-palette-group" key={category}>
                  <h2>{category}</h2>
                  {types.map((type) => {
                    const definition = nodeRegistry[type];
                    const Icon = iconByType[type];
                    return (
                      <button
                        type="button"
                        className="studio-palette-item"
                        aria-label={`添加 ${definition.label} 节点`}
                        key={type}
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData(DRAG_MIME, type);
                          event.dataTransfer.effectAllowed = 'move';
                        }}
                        onClick={() => addNode(type)}
                      >
                        <span className={`studio-palette-icon type-${type}`}>
                          <Icon />
                        </span>
                        <span>
                          <strong>{definition.label}</strong>
                          <small>{studioNodeRole(type)}</small>
                        </span>
                        {definition.risk === 'high' ? (
                          <ShieldAlert className="studio-risk-icon" />
                        ) : null}
                      </button>
                    );
                  })}
                </section>
              );
            })}
          </div>
          <div className="studio-palette-foot">
            <MousePointer2 />
            <span>拖动画布 · 滚轮缩放 · 端口连线 · 点线删除</span>
          </div>
        </aside>

        <section
          className="studio-canvas-column"
          inert={compactMode && inspectorOpen}
        >
          <div
            className="studio-canvas"
            onDrop={onDrop}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
          >
            <ReactFlow<CanvasNode, Edge>
              nodes={canvasNodes}
              edges={canvasEdges}
              nodeTypes={nodeTypes}
              onInit={(instance) => {
                setReactFlow(instance);
                setFitRequest((current) => current + 1);
              }}
              onNodesChange={onNodesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => {
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
                if (compactMode) {
                  setInspectorOpen(true);
                }
              }}
              onEdgeClick={(_, edge) => {
                setSelectedEdgeId(edge.id);
                setSelectedNodeId(null);
              }}
              onPaneClick={() => {
                setSelectedNodeId(null);
                setSelectedEdgeId(null);
              }}
              onEdgesDelete={(deleted) => {
                const deletedIds = new Set(deleted.map((item) => item.id));
                setGraph((current) => ({
                  ...current,
                  metadata: { ...current.metadata, updatedAt: Date.now() },
                  edges: current.edges.filter(
                    (edge) => !deletedIds.has(edge.id),
                  ),
                }));
                setSelectedEdgeId((current) =>
                  current && deletedIds.has(current) ? null : current,
                );
              }}
              minZoom={0.2}
              maxZoom={2}
              defaultEdgeOptions={{ type: 'default', interactionWidth: 28 }}
              proOptions={{ hideAttribution: true }}
              deleteKeyCode={['Backspace', 'Delete']}
            >
              <Background
                variant={BackgroundVariant.Dots}
                gap={22}
                size={1.1}
                color="#32414e"
              />
              <Controls showInteractive={false} position="bottom-left" />
            </ReactFlow>
            {selectedEdge ? (
              <button
                type="button"
                className="studio-delete-edge"
                title={
                  selectedEdgeEndpoints
                    ? `删除 ${selectedEdgeEndpoints.sourceNodeName} → ${selectedEdgeEndpoints.targetNodeName} 的连线`
                    : '删除选中的连线'
                }
                onClick={() => removeEdge(selectedEdge.id)}
              >
                <Trash2 aria-hidden="true" /> 删除连线
              </button>
            ) : null}
            <div className="studio-canvas-legend" aria-label="连接图例">
              {(['main', 'model', 'memory', 'tool'] as ConnectionKind[]).map(
                (kind) => (
                  <span key={kind}>
                    <i style={{ backgroundColor: kindColor[kind] }} />
                    {kind}
                  </span>
                ),
              )}
              {hasNodeTelemetry ? (
                <>
                  <span>
                    <i
                      style={{
                        backgroundColor: edgeRunColor.taken ?? '#62d69c',
                      }}
                    />
                    已走
                  </span>
                  <span className="studio-canvas-legend-dim">
                    <i className="studio-canvas-legend-dashed" />
                    未走
                  </span>
                  <span>
                    <i
                      style={{
                        backgroundColor: edgeRunColor.error ?? '#ff6b6b',
                      }}
                    />
                    失败
                  </span>
                </>
              ) : null}
            </div>
            <div className="studio-runtime-boundary">
              <LockKeyhole />
              <span>
                {usesLocalDatabase
                  ? 'DRAFT GRAPH · 本机 SQLite 只读查询 · 发布后在使用端运行'
                  : 'DRAFT GRAPH · 可编译预览与发布快照 · Run 按当前 Webhook 绑定执行'}
              </span>
            </div>
            {connectionMessage ? (
              <output className="studio-toast">{connectionMessage}</output>
            ) : null}
          </div>

          <section className="studio-execution" aria-label="运行结果">
            <header className="studio-execution-header">
              <nav aria-label="运行详情标签">
                {(
                  [
                    ['terminal', '终端'],
                    ['timeline', '过程'],
                    ['input', '输入'],
                    ['output', '输出'],
                    ['log', '日志'],
                    ['error', '错误'],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    type="button"
                    className={executionTab === id ? 'active' : ''}
                    onClick={() => setExecutionTab(id)}
                    key={id}
                  >
                    {label}
                  </button>
                ))}
              </nav>
              <div className="studio-run-context">
                {telemetryBadge && runMeta ? (
                  <span
                    aria-live="polite"
                    className={`studio-trace-badge trace-${runMeta.trace}${
                      telemetryBadge.tone
                        ? ` trace-telemetry-${telemetryBadge.tone}`
                        : ''
                    }`}
                  >
                    {telemetryBadge.label}
                  </span>
                ) : null}
                <div className="studio-run-id">
                  <Activity />
                  {runMeta?.requestId ?? runMeta?.runId ?? 'NO ACTIVE RUN'}
                </div>
              </div>
            </header>
            <div
              className={`studio-execution-body${executionTab === 'terminal' ? ' studio-execution-body-terminal' : ''}`}
            >
              {executionTab === 'terminal' ? (
                <WorkflowTerminal
                  graph={graph}
                  input={terminalInput}
                  submittedInput={terminalSubmittedInput}
                  inputError={terminalInputError}
                  entries={executionEntries}
                  response={terminalResponse}
                  error={runMeta?.error}
                  running={running}
                  inputRef={terminalInputRef}
                  onInputChange={(value) => {
                    setTerminalInput(value);
                    setTerminalInputError(null);
                  }}
                  onSubmit={submitTerminalInput}
                />
              ) : executionTab === 'timeline' ? (
                executionEntries.length ? (
                  <ol className="studio-timeline">
                    {executionEntries.map((entry) => (
                      <li className={`level-${entry.level}`} key={entry.id}>
                        <time>
                          {new Date(entry.at).toLocaleTimeString('zh-CN', {
                            hour12: false,
                          })}
                        </time>
                        <span>{entry.message}</span>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="studio-empty-execution">
                    <Zap />
                    <span>
                      Preview 会显示明确标注的合成节点数据；绑定 n8n 的 Run
                      显示真实运行与节点遥测，未绑定时显示内置模拟结果。
                    </span>
                  </div>
                )
              ) : executionTab === 'input' ? (
                <pre>
                  {JSON.stringify(
                    selectedRuntime?.input ??
                      lastRunInput ?? {
                        runId: runMeta?.runId,
                        requestId: runMeta?.requestId,
                        trace: runMeta?.trace,
                      },
                    null,
                    2,
                  )}
                </pre>
              ) : executionTab === 'output' ? (
                <pre>
                  {JSON.stringify(
                    selectedRuntime?.output ??
                      terminalResponse?.data ??
                      runMeta?.output ??
                      {},
                    null,
                    2,
                  )}
                </pre>
              ) : executionTab === 'error' ? (
                <pre>
                  {selectedRuntime?.error ??
                    runMeta?.error ??
                    'No node error. Runtime fallback is reported in Timeline.'}
                </pre>
              ) : (
                <pre>
                  {executionEntries
                    .filter(
                      (entry) =>
                        !selectedNodeId || entry.nodeId === selectedNodeId,
                    )
                    .map((entry) => entry.message)
                    .join('\n') || 'No logs for the selected node.'}
                </pre>
              )}
              <dl className="studio-run-meta">
                <div>
                  <dt>ENGINE</dt>
                  <dd>{runMeta?.engine ?? 'n8n'}</dd>
                </div>
                <div>
                  <dt>MODE</dt>
                  <dd>{runMeta?.mode ?? '—'}</dd>
                </div>
                <div>
                  <dt>DEGRADED</dt>
                  <dd>{runMeta ? String(runMeta.degraded) : '—'}</dd>
                </div>
                <div>
                  <dt>DURATION</dt>
                  <dd>{formatDuration(runMeta?.durationMs) ?? '—'}</dd>
                </div>
                <div>
                  <dt>TRACE</dt>
                  <dd>
                    {runMeta?.trace === 'run-envelope'
                      ? telemetryMeta?.bindingCount
                        ? 'run envelope + node telemetry'
                        : 'run envelope only'
                      : runMeta?.trace === 'simulated-run'
                        ? 'simulated result only'
                        : runMeta
                          ? 'local preview'
                          : '—'}
                  </dd>
                </div>
                <div>
                  <dt>BINDING</dt>
                  <dd title={telemetryBindingText}>{telemetryBindingText}</dd>
                </div>
                <div>
                  <dt>NODES</dt>
                  <dd title={telemetryNodesText}>{telemetryNodesText}</dd>
                </div>
                <div>
                  <dt>EVENTS</dt>
                  <dd>
                    {telemetryMeta ? `${telemetryMeta.eventCount} 条` : '—'}
                  </dd>
                </div>
                <div>
                  <dt>EDGES</dt>
                  <dd title={edgeRunSummaryText}>{edgeRunSummaryText}</dd>
                </div>
                <div className="studio-run-wide">
                  <dt>UNMAPPED</dt>
                  <dd
                    title={
                      telemetryMeta?.unmappedNodes.length
                        ? telemetryMeta.unmappedNodes.join('、')
                        : ''
                    }
                  >
                    {telemetryMeta
                      ? telemetryMeta.unmappedNodes.length
                        ? `${telemetryMeta.unmappedNodes.length} 个 n8n 节点未绑定`
                        : '0'
                      : '—'}
                  </dd>
                </div>
                {telemetryMeta?.message ? (
                  <div className="studio-run-note">
                    <dt>NOTE</dt>
                    <dd title={telemetryMeta.message}>
                      {telemetryMeta.message}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </div>
          </section>
        </section>

        {compactMode && inspectorOpen ? (
          <button
            type="button"
            className="studio-inspector-backdrop"
            aria-label="关闭 Inspector"
            onClick={() => setInspectorOpen(false)}
          />
        ) : null}
        <aside
          ref={inspectorRef}
          className={`studio-inspector${
            compactMode && inspectorOpen ? ' studio-inspector-open' : ''
          }`}
          aria-label="节点检查器"
          role={compactMode && inspectorOpen ? 'dialog' : undefined}
          aria-modal={(compactMode && inspectorOpen) || undefined}
        >
          <div className="studio-panel-heading">
            <div>
              <strong>Inspector</strong>
              <span>
                {selectedEdge
                  ? 'Connection'
                  : selectedNode
                    ? selectedNode.type
                    : 'Workflow'}
              </span>
            </div>
            <div className="studio-inspector-heading-actions">
              <Settings2 />
              <button
                ref={inspectorCloseRef}
                type="button"
                className="studio-inspector-close"
                aria-label="关闭 Inspector"
                onClick={() => setInspectorOpen(false)}
              >
                <X />
              </button>
            </div>
          </div>

          {selectedEdge && selectedEdgeEndpoints ? (
            <div className="studio-inspector-scroll">
              <section className="studio-inspector-section studio-node-summary">
                <div className="studio-inspector-icon type-subworkflow">
                  <GitBranch />
                </div>
                <div>
                  <strong>
                    {selectedEdgeEndpoints.sourceNodeName} →{' '}
                    {selectedEdgeEndpoints.targetNodeName}
                  </strong>
                  <span>{connectionKindLabel(selectedEdge.kind)}</span>
                </div>
                <span className={`runtime-${selectedEdgeRunState}`}>
                  {edgeRunText[selectedEdgeRunState]}
                </span>
              </section>

              <section className="studio-inspector-section">
                <h2>Connection</h2>
                <dl className="studio-edge-facts">
                  <div>
                    <dt>Source</dt>
                    <dd>
                      {selectedEdgeEndpoints.sourceNodeName} ·{' '}
                      {selectedEdgeEndpoints.sourcePortLabel}
                    </dd>
                  </div>
                  <div>
                    <dt>Target</dt>
                    <dd>
                      {selectedEdgeEndpoints.targetNodeName} ·{' '}
                      {selectedEdgeEndpoints.targetPortLabel}
                    </dd>
                  </div>
                  <div>
                    <dt>Kind</dt>
                    <dd>{connectionKindLabel(selectedEdge.kind)}</dd>
                  </div>
                  {selectedEdgeRunState === 'error' ? (
                    <div className="studio-edge-facts-reason">
                      <dt>Reason</dt>
                      <dd
                        title={
                          runtime[selectedEdge.target.nodeId]?.error ??
                          '下游节点失败'
                        }
                      >
                        {runtime[selectedEdge.target.nodeId]?.error ??
                          '下游节点失败，但事件里没有带出原因。'}
                      </dd>
                    </div>
                  ) : null}
                  {selectedEdge.condition?.branch ? (
                    <div>
                      <dt>Branch</dt>
                      <dd>{selectedEdge.condition.branch}</dd>
                    </div>
                  ) : null}
                  {hasNodeTelemetry ? (
                    <div>
                      <dt>Runtime</dt>
                      <dd>
                        {edgeRunText[selectedEdgeRunState]} ·{' '}
                        {selectedEdgeRunState}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <label>
                  <span>Label</span>
                  <input
                    value={selectedEdge.label ?? ''}
                    placeholder={
                      edgeDisplayLabel(graph, selectedEdge) ?? '（无标签）'
                    }
                    onChange={(event) =>
                      updateEdge(selectedEdge.id, {
                        label: event.target.value,
                      })
                    }
                  />
                </label>
                <p className="studio-help-copy">
                  连接类型不可手改：要换类型就删掉这条线，重新连到合法端口。
                  空标签时画布会按端口语义自动显示（如分支的 true / false）。
                </p>
              </section>

              <section className="studio-inspector-section">
                <h2>Validation</h2>
                <div className="studio-issue-list">
                  {selectedEdgeIssues.length ? (
                    selectedEdgeIssues.map((issue, index) => (
                      <button
                        type="button"
                        className={`issue-${issue.level}`}
                        key={`${issue.message}-${index}`}
                      >
                        {issue.level === 'error' ? (
                          <CircleAlert />
                        ) : (
                          <ShieldAlert />
                        )}
                        {issue.message}
                      </button>
                    ))
                  ) : (
                    <p className="studio-valid-message">
                      <CheckCircle2 /> 这条连接校验通过
                    </p>
                  )}
                </div>
              </section>

              <button
                type="button"
                className="studio-delete-node"
                onClick={() => removeEdge(selectedEdge.id)}
              >
                <Trash2 /> 删除这条连接
              </button>
            </div>
          ) : selectedNode ? (
            <div className="studio-inspector-scroll">
              <section className="studio-inspector-section studio-node-summary">
                <div
                  className={`studio-inspector-icon type-${selectedNode.type}`}
                >
                  {(() => {
                    const Icon = iconByType[selectedNode.type];
                    return <Icon />;
                  })()}
                </div>
                <div>
                  <strong>{selectedNode.name}</strong>
                  <span>{nodeRegistry[selectedNode.type].capability}</span>
                </div>
                <span className={`runtime-${selectedRuntime?.state ?? 'idle'}`}>
                  {selectedRuntime?.state ?? 'idle'}
                </span>
              </section>

              {selectedRuntime?.error ? (
                <section className="studio-inspector-section studio-error-detail">
                  <h2>Error</h2>
                  {selectedRuntime.errorCode ? (
                    <span className="studio-error-code">
                      {selectedRuntime.errorCode}
                    </span>
                  ) : null}
                  <p className="studio-error-message">
                    {selectedRuntime.error}
                  </p>
                  {selectedRuntime.errorDetail ? (
                    <pre className="studio-error-trace">
                      {selectedRuntime.errorDetail}
                    </pre>
                  ) : null}
                  <p className="studio-help-copy">
                    原因直接来自运行事件；没有事件就不会有这一栏。
                  </p>
                </section>
              ) : null}

              <section className="studio-inspector-section">
                <h2>General</h2>
                <label>
                  <span>Name</span>
                  <input
                    value={selectedNode.name}
                    onChange={(event) =>
                      updateNode(selectedNode.id, { name: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>Description</span>
                  <textarea
                    rows={3}
                    value={selectedNode.description}
                    onChange={(event) =>
                      updateNode(selectedNode.id, {
                        description: event.target.value,
                      })
                    }
                  />
                </label>
              </section>

              <section className="studio-inspector-section">
                <h2>Configuration</h2>
                {selectedNode.type === 'aiAgent' ? (
                  <>
                    <label>
                      <span>任务指令</span>
                      <textarea
                        rows={5}
                        value={configString(selectedNode.config.instructions)}
                        onChange={(event) =>
                          updateNode(selectedNode.id, {
                            config: {
                              ...selectedNode.config,
                              instructions: event.target.value,
                            },
                          })
                        }
                      />
                    </label>
                    <label>
                      <span>Fallback policy</span>
                      <select
                        value={configString(
                          selectedNode.config.fallbackPolicy,
                          'rules',
                        )}
                        onChange={(event) =>
                          updateNode(selectedNode.id, {
                            config: {
                              ...selectedNode.config,
                              fallbackPolicy: event.target.value,
                            },
                          })
                        }
                      >
                        <option value="rules">Rules · degraded</option>
                        <option value="error">Return explicit error</option>
                      </select>
                    </label>
                  </>
                ) : selectedNode.type === 'llmModel' ? (
                  <ModelServiceFields
                    node={selectedNode}
                    onChange={(config) =>
                      updateNode(selectedNode.id, { config })
                    }
                  />
                ) : selectedNode.type === 'database' ? (
                  <LocalDatabaseFields
                    key={selectedNode.id}
                    config={selectedNode.config}
                    onChange={(config) =>
                      updateNode(selectedNode.id, { config })
                    }
                    connectedToAgent={graph.edges.some(
                      (edge) =>
                        edge.kind === 'tool' &&
                        edge.target.nodeId === selectedNode.id &&
                        graph.nodes.some(
                          (node) =>
                            node.id === edge.source.nodeId &&
                            node.type === 'aiAgent',
                        ),
                    )}
                    onConnectAgent={
                      databaseAgent.length === 1
                        ? () =>
                            onConnect({
                              source: databaseAgent[0].id,
                              sourceHandle: 'resource.tools',
                              target: selectedNode.id,
                              targetHandle: 'tool.provider',
                            })
                        : undefined
                    }
                  />
                ) : selectedNode.type === 'condition' ? (
                  <label>
                    <span>Expression</span>
                    <input
                      value={configString(selectedNode.config.expression)}
                      onChange={(event) =>
                        updateNode(selectedNode.id, {
                          config: {
                            ...selectedNode.config,
                            expression: event.target.value,
                          },
                        })
                      }
                    />
                  </label>
                ) : (
                  <pre className="studio-config-preview">
                    {JSON.stringify(selectedNode.config, null, 2)}
                  </pre>
                )}
              </section>

              {selectedNode.type === 'aiAgent' ? (
                <section className="studio-inspector-section studio-agent-constraints">
                  <AgentConstraintsFields
                    value={configString(selectedNode.config.constraints)}
                    onChange={(constraints) =>
                      updateNode(selectedNode.id, {
                        config: { ...selectedNode.config, constraints },
                      })
                    }
                  />
                </section>
              ) : null}

              <section className="studio-inspector-section">
                <h2>输入 / 输出接口</h2>
                <ul className="studio-port-list">
                  {selectedNode.ports.map((port) => {
                    const connections = graph.edges.filter(
                      (edge) =>
                        (edge.source.nodeId === selectedNode.id &&
                          edge.source.portId === port.id) ||
                        (edge.target.nodeId === selectedNode.id &&
                          edge.target.portId === port.id),
                    ).length;
                    return (
                      <li key={port.id}>
                        <i style={{ backgroundColor: kindColor[port.kind] }} />
                        <span>
                          <strong>
                            {port.kind === 'main' ? '数据' : port.label}
                          </strong>
                          <small>
                            {port.direction === 'input'
                              ? '输入接口'
                              : '输出接口'}
                          </small>
                        </span>
                        <b>{connections}</b>
                      </li>
                    );
                  })}
                </ul>
              </section>

              <section className="studio-inspector-section">
                <h2>Validation</h2>
                <div className="studio-issue-list">
                  {issues.filter((issue) => issue.nodeId === selectedNode.id)
                    .length ? (
                    issues
                      .filter((issue) => issue.nodeId === selectedNode.id)
                      .map((issue, index) => (
                        <button
                          type="button"
                          className={`issue-${issue.level}`}
                          key={`${issue.message}-${index}`}
                        >
                          {issue.level === 'error' ? (
                            <CircleAlert />
                          ) : (
                            <ShieldAlert />
                          )}
                          {issue.message}
                        </button>
                      ))
                  ) : (
                    <p className="studio-valid-message">
                      <CheckCircle2 /> 当前节点校验通过
                    </p>
                  )}
                </div>
              </section>

              <button
                type="button"
                className="studio-delete-node"
                onClick={removeSelected}
              >
                <Trash2 /> 删除节点
              </button>
            </div>
          ) : (
            <div className="studio-inspector-scroll">
              <section className="studio-inspector-section">
                <h2>Workflow</h2>
                <label>
                  <span>Name</span>
                  <input
                    value={graph.name}
                    maxLength={80}
                    onChange={(event) =>
                      setGraph((current) => ({
                        ...current,
                        name: event.target.value,
                        metadata: {
                          ...current.metadata,
                          updatedAt: Date.now(),
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  <span>Description</span>
                  <textarea
                    rows={4}
                    value={graph.description}
                    onChange={(event) =>
                      setGraph((current) => ({
                        ...current,
                        description: event.target.value,
                        metadata: {
                          ...current.metadata,
                          updatedAt: Date.now(),
                        },
                      }))
                    }
                  />
                </label>
                <label>
                  <span>Workflow</span>
                  <select
                    value={workflow.id}
                    onChange={(event) => setWorkflowId(event.target.value)}
                  >
                    {workflows.map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.name} · v{item.version}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Admin token</span>
                  <div className="studio-secret-field">
                    <KeyRound />
                    <input
                      type="password"
                      autoComplete="off"
                      value={adminToken}
                      onChange={(event) => setAdminToken(event.target.value)}
                      placeholder="仅保存在当前会话"
                    />
                  </div>
                </label>
                <p className="studio-help-copy">
                  {adminTrusted
                    ? '这台机器是本机/内网访问，已被当作管理员会话：保存草稿、编译预览、发布快照都不用再填令牌。'
                    : '公网访问需要管理员令牌，它用于保存 D1 草稿、编译预览、发布快照与回滚。'}
                  {usesLocalDatabase
                    ? ' 本机数据库工作流发布后即可在使用端查询，需要保持连接助手运行。'
                    : ' 导入 n8n 仍然锁定，要等克隆环境的 Adapter canary 通过才会开放。'}
                </p>
              </section>
              <section className="studio-inspector-section">
                <h2>Release</h2>
                <div className="studio-release-actions">
                  <button
                    type="button"
                    className="studio-button"
                    disabled={!canUseServer || releaseState === 'working'}
                    onClick={() => void previewCompile()}
                  >
                    <ScanSearch /> 编译预览
                  </button>
                  <button
                    type="button"
                    className="studio-button"
                    disabled={!canUseServer || releaseState === 'working'}
                    onClick={() => void publishGraph()}
                  >
                    <PackageCheck /> 发布快照
                  </button>
                  {compilePreview?.ok && compilePreview.compiledJson ? (
                    <button
                      type="button"
                      className="studio-button studio-release-download"
                      disabled={compilePreviewStale}
                      onClick={downloadCompilePreview}
                    >
                      <Download />{' '}
                      {compilePreview.adapter === 'local-sqlite'
                        ? '下载本机执行计划'
                        : '下载 n8n JSON'}
                    </button>
                  ) : null}
                </div>
                {releaseMessage ? (
                  <p
                    className={`studio-help-copy studio-release-message${
                      releaseState === 'error' ? ' studio-release-error' : ''
                    }`}
                  >
                    {releaseMessage}
                  </p>
                ) : null}
                {compilePreview ? (
                  <dl className="studio-graph-facts">
                    <div>
                      <dt>编译结果</dt>
                      <dd>{compilePreview.ok ? '通过' : '被拒绝'}</dd>
                    </div>
                    <div>
                      <dt>目标版本</dt>
                      <dd>v{compilePreview.nextVersion || '—'}</dd>
                    </div>
                    <div>
                      <dt>
                        {compilePreview.adapter === 'local-sqlite'
                          ? '本机计划节点'
                          : '产物节点'}
                      </dt>
                      <dd>
                        {compilePreview.adapter === 'local-sqlite'
                          ? compilePreview.stats.internalNodes
                          : `${compilePreview.stats.externalNodes}/${compilePreview.stats.internalNodes}`}
                      </dd>
                    </div>
                    <div>
                      <dt>compiled hash</dt>
                      <dd>
                        {compilePreview.compiledHash?.slice(0, 12) ?? '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>需挂载凭据</dt>
                      <dd>
                        {compilePreview.requiredCredentialRefs.join('、') ||
                          '无'}
                      </dd>
                    </div>
                  </dl>
                ) : null}
                {compilePreviewStale ? (
                  <p className="studio-help-copy studio-release-message studio-release-error">
                    画布在本次预览后发生了变化，下载已停用。请重新编译预览。
                  </p>
                ) : null}
                {compilePreview?.issues.length ? (
                  <ul className="studio-release-issues">
                    {compilePreview.issues.slice(0, 8).map((issue, index) => (
                      <li
                        key={`${issue.message}-${index}`}
                        className={`studio-release-issue-${issue.level}`}
                      >
                        {issue.level === 'error' ? '✕' : '!'} {issue.message}
                      </li>
                    ))}
                  </ul>
                ) : null}
                <div className="studio-release-versions">
                  <div className="studio-panel-heading">
                    <div>
                      <strong>发布版本</strong>
                      <span>
                        {releaseVersions === null
                          ? '尚未加载'
                          : `${releaseVersions.length} 个 · 不可覆盖，可回滚`}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="studio-inspector-close"
                      aria-label="刷新发布版本列表"
                      disabled={!canUseServer}
                      onClick={() => void refreshVersions()}
                    >
                      <RefreshCcw />
                    </button>
                  </div>
                  {releaseVersions === null ? (
                    <p className="studio-help-copy">
                      点右上角的刷新按钮读取发布版本列表。
                      {activeVersionId
                        ? ` 当前生效：${activeVersionId.slice(0, 12)}…`
                        : ''}
                    </p>
                  ) : releaseVersions.length ? (
                    <ul>
                      {releaseVersions.map((version) => (
                        <li key={version.id}>
                          <div>
                            <strong>v{version.version}</strong>
                            <span>
                              草稿 rev {version.graphRevision} ·{' '}
                              {version.nodeCount} 节点 ·{' '}
                              {version.compiledHash?.slice(0, 8) ?? '—'}
                            </span>
                          </div>
                          {version.active ? (
                            <span className="studio-release-active">
                              生效中
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="studio-button"
                              disabled={releaseState === 'working'}
                              onClick={() =>
                                void rollbackToVersion(
                                  version.id,
                                  version.version,
                                )
                              }
                            >
                              <RotateCcw /> 回滚
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="studio-help-copy">
                      还没有发布版本。点「发布快照」把当前草稿固化成 v1。
                    </p>
                  )}
                </div>
              </section>
              <section className="studio-inspector-section">
                <h2>Graph</h2>
                <dl className="studio-graph-facts">
                  <div>
                    <dt>Nodes</dt>
                    <dd>{graph.nodes.length}</dd>
                  </div>
                  <div>
                    <dt>Edges</dt>
                    <dd>{graph.edges.length}</dd>
                  </div>
                  <div>
                    <dt>Runtime</dt>
                    <dd>
                      {usesLocalDatabase
                        ? '浏览器与本机助手'
                        : 'existing binding only'}
                    </dd>
                  </div>
                  <div>
                    <dt>Adapter</dt>
                    <dd>
                      {usesLocalDatabase
                        ? 'local-sqlite · 可发布'
                        : `${graph.runtime.adapter} · locked`}
                    </dd>
                  </div>
                </dl>
              </section>
            </div>
          )}
        </aside>
      </section>

      {workflowLibraryOpen ? (
        <>
          <button
            type="button"
            className="studio-library-backdrop"
            aria-label="关闭工作流列表"
            onClick={() => {
              setPendingWorkflowDelete(null);
              setWorkflowLibraryOpen(false);
            }}
          />
          <dialog
            open
            ref={workflowLibraryRef}
            id="studio-workflow-library"
            className="studio-library-panel"
            aria-modal="true"
            aria-labelledby="studio-workflow-library-title"
          >
            <header className="studio-library-heading">
              <span className="studio-library-mark" aria-hidden="true">
                <Workflow />
              </span>
              <div>
                <strong id="studio-workflow-library-title">工作流</strong>
                <span>{workflows.length} 个可编辑工作流</span>
              </div>
              <button
                ref={workflowLibraryCloseRef}
                type="button"
                className="studio-library-close"
                aria-label="关闭工作流列表"
                onClick={() => {
                  setPendingWorkflowDelete(null);
                  setWorkflowLibraryOpen(false);
                }}
              >
                <X />
              </button>
            </header>

            <div className="studio-library-toolbar">
              <label className="studio-library-search">
                <Search aria-hidden="true" />
                <span className="sr-only">搜索工作流</span>
                <input
                  value={workflowLibraryQuery}
                  onChange={(event) =>
                    setWorkflowLibraryQuery(event.target.value)
                  }
                  placeholder="按名称或用途搜索"
                  autoComplete="off"
                />
              </label>
              <button
                type="button"
                className="studio-library-create"
                disabled={workflowMutation !== null}
                onClick={() => void createWorkflowFromLibrary()}
              >
                {workflowMutation === 'create' ? (
                  <Loader2 className="studio-spin" />
                ) : (
                  <Plus />
                )}
                {workflowMutation === 'create' ? '正在新建' : '新建'}
              </button>
            </div>

            {workflowLibraryMessage ? (
              <p className="studio-library-message" role="alert">
                <CircleAlert aria-hidden="true" />
                {workflowLibraryMessage}
              </p>
            ) : null}

            <div className="studio-library-scroll">
              {visibleWorkflowLibrary.length ? (
                <ul className="studio-library-list">
                  {visibleWorkflowLibrary.map((item) => {
                    const isActive = item.id === workflowId;
                    const isDeleting = workflowMutation === item.id;
                    const confirmingDelete = pendingWorkflowDelete === item.id;
                    return (
                      <li
                        key={item.id}
                        className={isActive ? 'is-active' : undefined}
                      >
                        <button
                          type="button"
                          className="studio-library-main"
                          aria-current={isActive ? 'page' : undefined}
                          onClick={() => openWorkflowFromLibrary(item.id)}
                        >
                          <span className="studio-library-row-mark">
                            <Workflow aria-hidden="true" />
                          </span>
                          <span className="studio-library-copy">
                            <strong>{item.name || '未命名工作流'}</strong>
                            <small>
                              {item.description || '还没有填写用途说明'}
                            </small>
                            <span className="studio-library-meta">
                              <b>
                                {item.publishedSteps
                                  ? `v${item.version}`
                                  : '草稿'}
                              </b>
                              <b>{item.draftSteps.length} 个步骤</b>
                              <time
                                dateTime={new Date(
                                  item.updatedAt,
                                ).toISOString()}
                              >
                                {formatWorkflowDate(item.updatedAt)} 更新
                              </time>
                            </span>
                          </span>
                        </button>
                        <div className="studio-library-row-actions">
                          <button
                            type="button"
                            aria-label={`编辑 ${item.name}`}
                            title="编辑名称、用途和画布"
                            disabled={workflowMutation !== null}
                            onClick={() =>
                              openWorkflowFromLibrary(item.id, true)
                            }
                          >
                            <Pencil aria-hidden="true" />
                          </button>
                          <button
                            type="button"
                            className="is-danger"
                            aria-label={`删除 ${item.name}`}
                            title={
                              workflows.length <= 1
                                ? '至少保留一个工作流'
                                : '从列表删除，历史记录会保留'
                            }
                            disabled={
                              workflowMutation !== null || workflows.length <= 1
                            }
                            onClick={() => {
                              setWorkflowLibraryMessage(null);
                              setPendingWorkflowDelete(item.id);
                            }}
                          >
                            {isDeleting ? (
                              <Loader2
                                className="studio-spin"
                                aria-hidden="true"
                              />
                            ) : (
                              <Trash2 aria-hidden="true" />
                            )}
                          </button>
                        </div>
                        {confirmingDelete ? (
                          <div className="studio-library-confirm" role="alert">
                            <p>
                              删除「{item.name}
                              」？它会从列表和使用端隐藏，历史记录仍保留。
                            </p>
                            <div>
                              <button
                                type="button"
                                disabled={isDeleting}
                                onClick={() => setPendingWorkflowDelete(null)}
                              >
                                取消
                              </button>
                              <button
                                type="button"
                                className="is-danger"
                                disabled={isDeleting}
                                onClick={() =>
                                  void deleteWorkflowFromLibrary(item.id)
                                }
                              >
                                {isDeleting ? '正在删除' : '确认删除'}
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <div className="studio-library-empty">
                  <Search aria-hidden="true" />
                  <strong>没有匹配的工作流</strong>
                  <span>换一个名称或用途关键词</span>
                </div>
              )}
            </div>

            <footer className="studio-library-foot">
              <span
                className={adminAuthorized ? 'is-authorized' : undefined}
                aria-hidden="true"
              />
              {adminAuthorized
                ? '可以新建、保存与删除；删除不会清空历史记录。'
                : '编辑可先保存在浏览器；新建和删除需要管理员令牌。'}
            </footer>
          </dialog>
        </>
      ) : null}

      {creatorAgentOpen ? (
        <>
          <button
            type="button"
            className="studio-agent-backdrop"
            aria-label="关闭辅助 Agent"
            onClick={() => setCreatorAgentOpen(false)}
          />
          <dialog
            open
            ref={creatorAgentRef}
            id="studio-creator-agent"
            className="studio-agent-panel"
            aria-modal="true"
            aria-labelledby="studio-creator-agent-title"
          >
            <div className="studio-agent-heading">
              <span className="studio-agent-mark" aria-hidden="true">
                <Bot />
              </span>
              <div>
                <strong id="studio-creator-agent-title">
                  辅助 Agent · 只改画布
                </strong>
                <span>和工作流里运行的 Agent 是两套配置</span>
              </div>
              <button
                ref={creatorAgentCloseRef}
                type="button"
                className="studio-agent-close"
                aria-label="关闭辅助 Agent"
                onClick={() => setCreatorAgentOpen(false)}
              >
                <X />
              </button>
            </div>

            <div className="studio-agent-scroll">
              <section className="studio-agent-section">
                <fieldset className="studio-agent-mode">
                  <legend>Agent 工作模式</legend>
                  <button
                    type="button"
                    aria-pressed={creatorAgentMode === 'edit'}
                    onClick={() => {
                      setCreatorAgentMode('edit');
                      setCreatorAgentProposal(null);
                      setCreatorAgentProposalBase(null);
                      setCreatorAgentError(null);
                      setCreatorAgentAppliedMode(null);
                      setCreatorAgentState('idle');
                    }}
                  >
                    <Workflow /> 编辑当前
                  </button>
                  <button
                    type="button"
                    aria-pressed={creatorAgentMode === 'create'}
                    onClick={() => {
                      setCreatorAgentMode('create');
                      setCreatorAgentProposal(null);
                      setCreatorAgentProposalBase(null);
                      setCreatorAgentError(null);
                      setCreatorAgentAppliedMode(null);
                      setCreatorAgentState('idle');
                    }}
                  >
                    <Plus /> 新建工作流
                  </button>
                </fieldset>
                <p className="studio-agent-context">
                  {creatorAgentMode === 'edit' ? (
                    <>
                      目标：<strong>{graph.name}</strong> · rev {graph.revision}
                    </>
                  ) : (
                    '会生成一张新 Graph，确认后才创建工作流记录。'
                  )}
                </p>
              </section>

              <form
                className="studio-agent-section studio-agent-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  void requestCreatorAgentProposal();
                }}
              >
                <label>
                  <span>你想让工作流做什么？</span>
                  <textarea
                    rows={6}
                    value={creatorAgentPrompt}
                    maxLength={4_000}
                    placeholder={
                      creatorAgentMode === 'edit'
                        ? '例：在高优先级分支中增加 Qwen Agent，保留现有的失败路径。'
                        : '例：创建一个客服分流工作流，记住会话，高优先级调用 Agent，其余直接回复。'
                    }
                    onChange={(event) =>
                      setCreatorAgentPrompt(event.target.value)
                    }
                  />
                </label>

                <p className="studio-help-copy">
                  给辅助 Agent 选个模型服务、贴上你自己的 Key
                  就能用。它只负责把画布改好，不参与工作流运行；工作流真正跑起来时用的是画布上
                  AI Agent 连的 <strong>Model 节点</strong>。
                </p>

                <label>
                  <span>辅助 Agent 的模型服务</span>
                  <select
                    value={creatorAgentConfig.provider}
                    onChange={(event) => {
                      setCreatorDiscoveredModels([]);
                      setCreatorModelDiscovery({
                        status: 'idle',
                        message: '',
                      });
                      setCreatorAgentConfig((current) => {
                        const next = providerDefaults(event.target.value);
                        return next
                          ? {
                              ...current,
                              provider: next.id,
                              baseUrl: next.baseUrl,
                              model: next.model,
                              reasoningEffort: 'auto',
                            }
                          : current;
                      });
                    }}
                  >
                    {providerOptions().map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.vendor} · {option.label}
                      </option>
                    ))}
                  </select>
                </label>

                <label>
                  <span>
                    API Key（
                    {creatorAgentKeyRequired ? '本次必填' : '本机模型可留空'}）
                  </span>
                  <div className="studio-agent-secret">
                    <KeyRound />
                    <input
                      type="password"
                      autoComplete="off"
                      value={creatorAgentConfig.apiKey}
                      placeholder={
                        creatorAgentProvider?.keyHint ??
                        '仅保留到关闭当前标签页'
                      }
                      onChange={(event) => {
                        setCreatorDiscoveredModels([]);
                        setCreatorModelDiscovery({
                          status: 'idle',
                          message: '',
                        });
                        setCreatorAgentConfig((current) => ({
                          ...current,
                          apiKey: event.target.value,
                        }));
                      }}
                    />
                  </div>
                </label>

                <details className="studio-agent-model-settings">
                  <summary>
                    <ServerCog /> 高级 · 端点、模型与推理
                    <span>
                      {providerOptions().find(
                        (item) => item.id === creatorAgentConfig.provider,
                      )?.label ?? creatorAgentConfig.provider}{' '}
                      · {creatorAgentConfig.model}
                    </span>
                  </summary>
                  <div>
                    <label>
                      <span>Base URL</span>
                      <input
                        value={creatorAgentConfig.baseUrl}
                        inputMode="url"
                        placeholder={
                          providerOptions().find(
                            (item) => item.id === creatorAgentConfig.provider,
                          )?.defaultBaseUrl || 'https://你的网关/v1'
                        }
                        onChange={(event) => {
                          setCreatorDiscoveredModels([]);
                          setCreatorModelDiscovery({
                            status: 'idle',
                            message: '',
                          });
                          setCreatorAgentConfig((current) => ({
                            ...current,
                            baseUrl: event.target.value,
                          }));
                        }}
                      />
                    </label>
                    <label>
                      <span>模型名</span>
                      <input
                        list="studio-agent-model-list"
                        value={creatorAgentConfig.model}
                        onChange={(event) =>
                          setCreatorAgentConfig((current) => ({
                            ...current,
                            model: event.target.value,
                          }))
                        }
                      />
                      <datalist id="studio-agent-model-list">
                        {creatorSelectableModels.map((model) => (
                          <option key={model} value={model}>
                            {model}
                          </option>
                        ))}
                      </datalist>
                    </label>
                    <button
                      type="button"
                      className="studio-agent-model-discover"
                      disabled={
                        creatorModelDiscovery.status === 'loading' ||
                        (creatorAgentKeyRequired &&
                          !creatorAgentConfig.apiKey.trim()) ||
                        !creatorAgentConfig.baseUrl.trim()
                      }
                      onClick={() => void discoverCreatorModels()}
                    >
                      <RefreshCcw
                        className={
                          creatorModelDiscovery.status === 'loading'
                            ? 'is-spinning'
                            : undefined
                        }
                      />
                      {creatorModelDiscovery.status === 'loading'
                        ? '读取中…'
                        : '识别 API 模型'}
                    </button>
                    {creatorModelDiscovery.message ? (
                      <output
                        className={`studio-agent-model-status is-${creatorModelDiscovery.status}`}
                        aria-live="polite"
                      >
                        {creatorModelDiscovery.message}
                      </output>
                    ) : null}
                    <label>
                      <span>推理强度</span>
                      <select
                        value={
                          creatorAgentProvider?.reasoningMode === 'model-only'
                            ? 'auto'
                            : creatorAgentConfig.reasoningEffort
                        }
                        disabled={
                          creatorAgentProvider?.reasoningMode === 'model-only'
                        }
                        onChange={(event) => {
                          const value = event.target.value;
                          if (!isLlmReasoningEffort(value)) return;
                          setCreatorAgentConfig((current) => ({
                            ...current,
                            reasoningEffort: value,
                          }));
                        }}
                      >
                        <option value="auto">自动（API 默认）</option>
                        <option value="low">低 · 更快</option>
                        <option value="medium">中 · 均衡</option>
                        <option value="high">高 · 更深入</option>
                      </select>
                      <small>
                        {creatorAgentProvider?.reasoningNote ??
                          '仅在该 API 支持时生效。'}
                      </small>
                    </label>
                  </div>
                </details>

                <p className="studio-agent-privacy">
                  这个 Key 只用于让辅助 Agent
                  生成提案：它随请求发往所选模型服务， 不写入 Graph、D1
                  或运行记录，也不参与工作流运行。
                </p>

                {graphModelNode ? (
                  <button
                    type="button"
                    className="studio-agent-undo"
                    onClick={() => {
                      setSelectedNodeId(graphModelNode.id);
                      setSelectedEdgeId(null);
                      setCreatorAgentOpen(false);
                      if (compactMode) setInspectorOpen(true);
                    }}
                  >
                    <Settings2 /> 去改工作流里那个 Model 节点
                  </button>
                ) : null}

                {!canUseCreatorAgent ? (
                  <output className="studio-agent-notice">
                    <LockKeyhole /> 网站 API 未连通，辅助 Agent 暂时不可用。
                  </output>
                ) : null}

                <button
                  type="submit"
                  className="studio-agent-primary"
                  disabled={
                    creatorAgentState === 'working' ||
                    creatorAgentState === 'applying' ||
                    !canUseCreatorAgent ||
                    (creatorAgentKeyRequired &&
                      !creatorAgentConfig.apiKey.trim()) ||
                    creatorAgentPrompt.trim().length < 5
                  }
                >
                  {creatorAgentState === 'working' ? (
                    <Loader2 className="studio-spin" />
                  ) : (
                    <Bot />
                  )}
                  {creatorAgentState === 'working'
                    ? '正在规划并校验…'
                    : '生成变更提案'}
                </button>
              </form>

              {creatorAgentError ? (
                <section
                  className="studio-agent-section studio-agent-error"
                  role="alert"
                >
                  <CircleAlert />
                  <div>
                    <strong>未应用任何变更</strong>
                    <p>{creatorAgentError}</p>
                  </div>
                </section>
              ) : null}

              {creatorAgentState === 'applied' && !creatorAgentProposal ? (
                <section className="studio-agent-section studio-agent-applied">
                  <CheckCircle2 />
                  <div>
                    <strong>
                      {creatorAgentAppliedMode === 'create'
                        ? '新工作流草稿已创建'
                        : creatorAgentUndo
                          ? '提案已放到画布'
                          : 'Agent 修改已保存'}
                    </strong>
                    <p>
                      {creatorAgentAppliedMode === 'create'
                        ? 'Graph 已保存，但尚未发布，Deploy 仍然锁定。'
                        : creatorAgentUndo
                          ? saveState === 'error'
                            ? 'Graph 已写入 D1，但兼容元数据尚未同步。可重试保存，或撤销后再保存。'
                            : '还没有持久化。检查节点与连线后保存到 D1，或撤销这次修改。'
                          : graphPersistence === 'server'
                            ? 'Graph 草稿已持久化，但尚未发布或导入 n8n。'
                            : 'Graph 只保存在当前浏览器，还没有写入 D1。'}
                    </p>
                    {creatorAgentUndo ? (
                      <div className="studio-agent-applied-actions">
                        <button
                          type="button"
                          className="studio-agent-save"
                          disabled={!canUseServer || saveState === 'saving'}
                          onClick={() => void saveGraph()}
                        >
                          {saveState === 'saving' ? (
                            <Loader2 className="studio-spin" />
                          ) : (
                            <Save />
                          )}
                          {saveState === 'saving'
                            ? '正在保存…'
                            : saveState === 'error'
                              ? '重试同步'
                              : '保存到 D1'}
                        </button>
                        <button
                          type="button"
                          className="studio-agent-undo"
                          disabled={!creatorAgentUndoAvailable}
                          onClick={undoCreatorAgentEdit}
                        >
                          <RotateCcw /> 撤销这次修改
                        </button>
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {creatorAgentProposal ? (
                <section className="studio-agent-section studio-agent-proposal">
                  <div className="studio-agent-proposal-heading">
                    <div>
                      <strong>{creatorAgentProposal.graph.name}</strong>
                      <span>
                        {creatorAgentProposal.model} ·{' '}
                        {creatorAgentProposal.graph.nodes.length} 节点
                      </span>
                    </div>
                    <span
                      className={
                        creatorAgentProposal.compile.ready
                          ? 'studio-agent-ready'
                          : 'studio-agent-blocked'
                      }
                    >
                      {creatorAgentProposal.compile.ready
                        ? '可编译'
                        : '需补配置'}
                    </span>
                  </div>
                  <p className="studio-agent-summary">
                    {creatorAgentProposal.summary}
                  </p>
                  {creatorAgentProposal.graph.description ? (
                    <p className="studio-agent-description">
                      {creatorAgentProposal.graph.description}
                    </p>
                  ) : null}

                  <dl className="studio-agent-change-grid">
                    <div>
                      <dt>新增节点</dt>
                      <dd>+{creatorAgentProposal.changes.nodesAdded}</dd>
                    </div>
                    <div>
                      <dt>修改节点</dt>
                      <dd>{creatorAgentProposal.changes.nodesChanged}</dd>
                    </div>
                    <div>
                      <dt>删除节点</dt>
                      <dd>−{creatorAgentProposal.changes.nodesRemoved}</dd>
                    </div>
                    <div>
                      <dt>连线变更</dt>
                      <dd>
                        +{creatorAgentProposal.changes.edgesAdded} / −
                        {creatorAgentProposal.changes.edgesRemoved}
                      </dd>
                    </div>
                  </dl>

                  {creatorAgentProposal.compile.requiredCredentialRefs
                    .length ? (
                    <p className="studio-agent-credentials">
                      <KeyRound /> 导入前需由运维挂载：
                      {creatorAgentProposal.compile.requiredCredentialRefs.join(
                        '、',
                      )}
                    </p>
                  ) : null}

                  {creatorAgentProposal.compile.issues.length ? (
                    <ul className="studio-agent-issues">
                      {creatorAgentProposal.compile.issues
                        .slice(0, 6)
                        .map((issue, index) => (
                          <li
                            key={`${issue.message}-${index}`}
                            className={`issue-${issue.level}`}
                          >
                            {issue.level === 'error' ? (
                              <CircleAlert />
                            ) : (
                              <ShieldAlert />
                            )}
                            <span>{issue.message}</span>
                          </li>
                        ))}
                    </ul>
                  ) : null}

                  {creatorAgentProposalStale ? (
                    <p className="studio-agent-notice studio-agent-notice-error">
                      <RefreshCcw /> 画布已改变，请重新生成提案。
                    </p>
                  ) : null}

                  <p className="studio-agent-boundary">
                    应用只会改 Graph 草稿。不会发布、激活或导入 n8n。
                  </p>
                  <div className="studio-agent-actions">
                    <button
                      type="button"
                      onClick={() => {
                        setCreatorAgentProposal(null);
                        setCreatorAgentProposalBase(null);
                        setCreatorAgentError(null);
                      }}
                    >
                      放弃提案
                    </button>
                    <button
                      type="button"
                      className="studio-agent-apply"
                      disabled={
                        creatorAgentProposalStale ||
                        creatorAgentState === 'applying'
                      }
                      onClick={() => void applyCreatorAgentProposal()}
                    >
                      {creatorAgentState === 'applying' ? (
                        <Loader2 className="studio-spin" />
                      ) : creatorAgentProposal.mode === 'create' ? (
                        <Plus />
                      ) : (
                        <Check />
                      )}
                      {creatorAgentState === 'applying'
                        ? '正在保存…'
                        : creatorAgentProposal.mode === 'create'
                          ? '创建并保存草稿'
                          : '应用到当前画布'}
                    </button>
                  </div>
                </section>
              ) : creatorAgentState === 'idle' ? (
                <section className="studio-agent-section studio-agent-empty">
                  <strong>Agent 不会直接动你的工作流</strong>
                  <ol>
                    <li>模型返回节点蓝图</li>
                    <li>服务端重建端口并校验 Graph</li>
                    <li>你确认后才应用，且可撤销</li>
                  </ol>
                </section>
              ) : null}
            </div>
          </dialog>
        </>
      ) : null}

      <footer className="studio-statusbar" inert={studioOverlayOpen}>
        <span>
          <i className={`service-${serviceState}`} />
          {graphPersistence === 'server'
            ? 'Graph persisted in D1'
            : serviceState === 'connected'
              ? 'Website API connected · graph local'
              : serviceState === 'loading'
                ? 'Connecting…'
                : 'Demo data · local draft'}
        </span>
        <span>
          <Code2 /> Graph schema v1
        </span>
        <span>
          <Database /> {graph.nodes.length} nodes · {graph.edges.length} edges
        </span>
        <span>
          {usesLocalDatabase ? (
            <>
              <Database /> 本机 SQLite
            </>
          ) : (
            <>
              <LockKeyhole /> Adapter locked
            </>
          )}
        </span>
        <span className="studio-status-spacer" />
        <button
          type="button"
          onClick={() => reactFlow?.fitView({ padding: 0.2 })}
        >
          <RefreshCcw /> Fit view
        </button>
      </footer>
    </main>
  );
}

export function WorkflowStudio() {
  return (
    <ReactFlowProvider>
      <StudioSurface />
    </ReactFlowProvider>
  );
}
