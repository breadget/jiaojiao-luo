'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { randomId } from '@/lib/random-id';
import { LocalDatabaseConnector } from '@/components/studio/local-database-fields';
import {
  executeDatabaseRequests,
  getDatabaseConnectionCode,
  readDatabasePairingLink,
  type DatabaseToolRequest,
} from '@/lib/local-database-client';
import { ConversationRefreshGuard, fetchChatJson } from '@/lib/chat-client';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronLeft,
  CirclePlus,
  Copy,
  Download,
  FolderOpen,
  HardDrive,
  KeyRound,
  Loader2,
  Menu,
  MessageSquarePlus,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Play,
  RefreshCw,
  Save,
  Send,
  ShieldAlert,
  Terminal,
  Trash2,
  Workflow as WorkflowIcon,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import { isArtifactGenerationRequest } from '@/lib/artifact-intent';
import {
  DEFAULT_LLM_PROVIDER_ID,
  findProvider,
  isLlmReasoningEffort,
  providerDefaults,
  providerOptions,
} from '@/lib/llm/providers';
import {
  PYTHON_ATTACHMENT_ACCEPT,
  attachmentMimeType,
  mountNameFor,
  toAgentInputs,
  validateAttachments,
} from '@/lib/python-attachments';
import type {
  AgentChatResponse,
  ChatArtifact,
  ChatShellRun,
  ChatTurn,
  ConsumerConversationSummary,
  ConsumerMessageRecord,
  ConsumerPythonRunRecord,
  ConsumerSessionResponse,
  LlmConfig,
  StateResponse,
  StepKind,
  WorkflowRecord,
  WorkflowRun,
  WorkflowStep,
} from '@/lib/workflow-types';

const LLM_STORAGE_KEY = 'urtoris.llm.config.v1';
/** 右侧执行面板的收起状态；'0' 表示收起。 */
const RUN_PANEL_STORAGE_KEY = 'urtoris.consumer.runPanel.v2';
const ADMIN_TOKEN_STORAGE_KEY = 'urtoris.admin.token.v1';

/** 使用端待上传的附件：挂载名用安全 ASCII，展示名保留原始文件名。 */
type PendingAttachment = {
  id: string;
  file: File;
  name: string;
  mountName: string;
  size: number;
  previewUrl: string | null;
};

type PythonTaskCapability = {
  taskId: string;
  taskToken: string;
};

/** 使用端的工作模式：决定这一轮消息走哪条通道。 */
type WorkMode = 'auto' | 'chat' | 'python' | 'shell';

const WORK_MODES: ReadonlyArray<{
  id: WorkMode;
  label: string;
  hint: string;
}> = [
  {
    id: 'auto',
    label: '自动',
    hint: '文件处理或生成任务会自动执行，其他按已装载工作流运行',
  },
  {
    id: 'chat',
    label: '仅对话',
    hint: '只用模型回答，不在沙箱里跑代码',
  },
  {
    id: 'python',
    label: '允许 Python',
    hint: '这一轮允许 Agent 调用 run_python，可产出文件',
  },
  {
    id: 'shell',
    label: '本机全权限',
    hint: '仅本机可用；Agent 以当前用户身份执行任意 Shell 命令',
  },
];

type PythonAgentResponse = {
  reply: string;
  replySource: 'model' | 'fallback' | 'guard';
  guardViolations: string[];
  taskId: string;
  attempts: number;
  succeeded: boolean;
  stopReason: string;
  model: string | null;
  providerLabel?: string;
  artifacts: Array<{
    artifactId: string;
    name: string;
    mimeType: string;
    sizeBytes: number;
  }>;
  runs: Array<{
    runId: string;
    status: string;
    errorCode: string | null;
    artifactIds: string[];
  }>;
  lastError: { code: string; message: string } | null;
};

type LocalControlAgentResponse = {
  reply: string;
  replySource: 'model' | 'fallback';
  taskId: string;
  usedShell: boolean;
  succeeded: boolean;
  stopReason: string;
  commands: number;
  model: string | null;
  providerLabel?: string;
  runs: ChatShellRun[];
};

type LocalControlInfoView = {
  username: string;
  uid: number | null;
  hostname: string;
  platform: string;
  shell: string;
  default_cwd: string;
  concurrency: number;
  maximum_timeout_seconds: number;
};

type LocalControlState =
  | { visibility: 'checking'; available: false; message: string }
  | { visibility: 'hidden'; available: false; message: string }
  | { visibility: 'local'; available: false; message: string }
  | {
      visibility: 'local';
      available: true;
      message: string;
      info: LocalControlInfoView;
    };

/** 记录与项目的保存位置（用户自己选的文件夹，在这台 Mac 上）。 */
type LocalStoreStatusView = {
  root: string | null;
  folder: string | null;
  collections: { conversations: number; projects: number; runs: number };
  updated_at: string | null;
};

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KiB`;
  return `${bytes} B`;
}

/** 把异常整理成给用户看的一句话，失败信息会直接显示在对话气泡里。 */
function describeChatFailure(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : 'Agent 暂时没有回应，请重试。';
}

const defaultLlmConfig: LlmConfig = {
  provider: DEFAULT_LLM_PROVIDER_ID,
  apiKey: '',
  baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  model: 'qwen-plus',
  reasoningEffort: 'auto',
};

const kindLabels: Record<StepKind, string> = {
  input: '接收输入',
  transform: '处理数据',
  decision: '判断条件',
  compose: '生成内容',
  output: '回传结果',
};

/** 运行台账上的状态戳：簿册里不出现原始英文状态码。 */
const runStatusLabels: Record<WorkflowRun['status'], string> = {
  queued: '排队中',
  running: '运行中',
  completed: '已完成',
  failed: '已失败',
};

const pythonRunStatusLabels: Record<ConsumerPythonRunRecord['status'], string> =
  {
    queued: '排队中',
    running: '运行中',
    succeeded: '已完成',
    failed: '已失败',
    timed_out: '已超时',
    killed: '已取消',
  };

const shellRunStatusLabels: Record<ChatShellRun['status'], string> = {
  queued: '排队中',
  running: '运行中',
  succeeded: '已完成',
  failed: '已失败',
  timed_out: '已超时',
  cancelled: '已取消',
};

const starterWorkflow: WorkflowRecord = {
  id: 'wf_demo_triage',
  name: '客户请求分流',
  description: '接收一条客户请求，判断优先级，生成处理摘要并回传。',
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
      detail: '整理问题、优先级和建议动作',
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

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatClock(timestamp: number | null) {
  if (!timestamp) return '尚未运行';
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(timestamp));
}

function formatConversationAge(timestamp: number): string {
  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天`;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  }).format(new Date(timestamp));
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0
    ? `${minutes} 分 ${String(remainder).padStart(2, '0')} 秒`
    : `${remainder} 秒`;
}

function shellElapsed(run: ChatShellRun, now: number): string {
  const started = Date.parse(run.startedAt ?? run.createdAt);
  return formatElapsed(Number.isFinite(started) ? now - started : 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function persistedShellRun(value: unknown): ChatShellRun | null {
  if (!isObject(value)) return null;
  const statuses = new Set<ChatShellRun['status']>([
    'queued',
    'running',
    'succeeded',
    'failed',
    'timed_out',
    'cancelled',
  ]);
  if (
    typeof value.runId !== 'string' ||
    typeof value.status !== 'string' ||
    !statuses.has(value.status as ChatShellRun['status']) ||
    typeof value.command !== 'string' ||
    typeof value.cwd !== 'string' ||
    typeof value.timeoutSeconds !== 'number' ||
    (value.reason !== null && typeof value.reason !== 'string') ||
    (value.exitCode !== null && typeof value.exitCode !== 'number') ||
    (value.signal !== null && typeof value.signal !== 'string') ||
    typeof value.stdout !== 'string' ||
    typeof value.stderr !== 'string' ||
    typeof value.stdoutTruncated !== 'boolean' ||
    typeof value.stderrTruncated !== 'boolean' ||
    typeof value.cancellationRequested !== 'boolean' ||
    typeof value.createdAt !== 'string' ||
    (value.startedAt !== null && typeof value.startedAt !== 'string') ||
    (value.finishedAt !== null && typeof value.finishedAt !== 'string')
  ) {
    return null;
  }
  const error = isObject(value.error)
    ? {
        code: typeof value.error.code === 'string' ? value.error.code : '',
        message:
          typeof value.error.message === 'string' ? value.error.message : '',
      }
    : null;
  return {
    runId: value.runId,
    status: value.status as ChatShellRun['status'],
    command: value.command,
    cwd: value.cwd,
    timeoutSeconds: value.timeoutSeconds,
    reason: value.reason as string | null,
    exitCode: value.exitCode as number | null,
    signal: value.signal as string | null,
    stdout: value.stdout,
    stderr: value.stderr,
    stdoutTruncated: value.stdoutTruncated,
    stderrTruncated: value.stderrTruncated,
    cancellationRequested: value.cancellationRequested,
    createdAt: value.createdAt,
    startedAt: value.startedAt as string | null,
    finishedAt: value.finishedAt as string | null,
    error: error?.code && error.message ? error : null,
  };
}

function persistedTurn(record: ConsumerMessageRecord): ChatTurn {
  const metadata = isObject(record.metadata) ? record.metadata : {};
  const attachments = Array.isArray(metadata.attachments)
    ? metadata.attachments.filter(isObject).flatMap((item) =>
        typeof item.name === 'string' &&
        typeof item.size === 'number' &&
        typeof item.mimeType === 'string'
          ? [
              {
                name: item.name,
                size: item.size,
                mimeType: item.mimeType,
                previewUrl: null,
              },
            ]
          : [],
      )
    : undefined;
  const artifacts = Array.isArray(metadata.artifacts)
    ? metadata.artifacts.filter(isObject).flatMap((item) =>
        typeof item.artifactId === 'string' &&
        typeof item.runId === 'string' &&
        typeof item.name === 'string' &&
        typeof item.mimeType === 'string' &&
        typeof item.sizeBytes === 'number'
          ? [
              {
                artifactId: item.artifactId,
                runId: item.runId,
                name: item.name,
                mimeType: item.mimeType,
                sizeBytes: item.sizeBytes,
                previewUrl: null,
              },
            ]
          : [],
      )
    : undefined;
  const python = isObject(metadata.python)
    ? {
        taskId:
          typeof metadata.python.taskId === 'string'
            ? metadata.python.taskId
            : '',
        attempts:
          typeof metadata.python.attempts === 'number'
            ? metadata.python.attempts
            : 0,
        succeeded: metadata.python.succeeded === true,
        stopReason:
          typeof metadata.python.stopReason === 'string'
            ? metadata.python.stopReason
            : '',
        guarded: metadata.python.guarded === true,
      }
    : undefined;
  const shell = isObject(metadata.shell)
    ? {
        taskId:
          typeof metadata.shell.taskId === 'string'
            ? metadata.shell.taskId
            : '',
        runs: Array.isArray(metadata.shell.runs)
          ? metadata.shell.runs.flatMap((run) => {
              const parsed = persistedShellRun(run);
              return parsed ? [parsed] : [];
            })
          : [],
        succeeded: metadata.shell.succeeded === true,
        stopReason:
          typeof metadata.shell.stopReason === 'string'
            ? metadata.shell.stopReason
            : '',
      }
    : undefined;
  return {
    id: record.id,
    role: record.role,
    text: record.text,
    at: record.createdAt,
    working: record.status === 'working',
    chatRequestId:
      typeof metadata.chatRequestId === 'string'
        ? metadata.chatRequestId
        : undefined,
    failed: record.status === 'failed' || metadata.failed === true,
    runId: typeof metadata.runId === 'string' ? metadata.runId : undefined,
    intent: typeof metadata.intent === 'string' ? metadata.intent : undefined,
    priority:
      typeof metadata.priority === 'string' ? metadata.priority : undefined,
    mode:
      metadata.mode === 'model' ||
      metadata.mode === 'simulated' ||
      metadata.mode === 'n8n'
        ? metadata.mode
        : undefined,
    executionMode:
      metadata.executionMode === 'llm' ||
      metadata.executionMode === 'rules' ||
      metadata.executionMode === 'simulated'
        ? metadata.executionMode
        : undefined,
    degraded:
      typeof metadata.degraded === 'boolean' ? metadata.degraded : undefined,
    attachments,
    artifacts,
    python: python?.taskId ? python : undefined,
    shell: shell?.taskId ? shell : undefined,
  };
}

function turnMetadata(turn: ChatTurn): Record<string, unknown> {
  return {
    ...(turn.chatRequestId ? { chatRequestId: turn.chatRequestId } : {}),
    ...(turn.runId ? { runId: turn.runId } : {}),
    ...(turn.intent ? { intent: turn.intent } : {}),
    ...(turn.priority ? { priority: turn.priority } : {}),
    ...(turn.mode ? { mode: turn.mode } : {}),
    ...(turn.executionMode ? { executionMode: turn.executionMode } : {}),
    ...(typeof turn.degraded === 'boolean' ? { degraded: turn.degraded } : {}),
    ...(turn.failed ? { failed: true } : {}),
    ...(turn.attachments?.length
      ? {
          attachments: turn.attachments.map(({ name, size, mimeType }) => ({
            name,
            size,
            mimeType,
          })),
        }
      : {}),
    ...(turn.artifacts?.length
      ? {
          artifacts: turn.artifacts.map(
            ({ artifactId, runId, name, mimeType, sizeBytes }) => ({
              artifactId,
              runId,
              name,
              mimeType,
              sizeBytes,
            }),
          ),
        }
      : {}),
    ...(turn.python ? { python: turn.python } : {}),
    ...(turn.shell ? { shell: turn.shell } : {}),
  };
}

type SaveState = 'idle' | 'saving' | 'saved';
type Portal = 'gateway' | 'creator' | 'consumer';

export function WorkflowLab({
  initialPortal = 'gateway',
  embedded = false,
}: {
  initialPortal?: Portal;
  embedded?: boolean;
} = {}) {
  const [portal, setPortal] = useState<Portal>(initialPortal);
  const [consumerSidebarCollapsed, setConsumerSidebarCollapsed] =
    useState(false);
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [creatorWorkflowId, setCreatorWorkflowId] = useState<string | null>(
    null,
  );
  const [consumerWorkflowId, setConsumerWorkflowId] = useState<string | null>(
    null,
  );
  /** 当前装载的工作流是否绑定了真实 n8n webhook —— 决定文案与提示该怎么说。 */
  const loadedUsesN8n = useMemo(
    () =>
      Boolean(
        workflows.find((item) => item.id === consumerWorkflowId)?.n8nWebhookUrl,
      ),
    [workflows, consumerWorkflowId],
  );
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [runPage, setRunPage] = useState(0);
  const [runPagination, setRunPagination] = useState({
    hasPrevious: false,
    hasNext: false,
  });
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [running, setRunning] = useState(false);
  const [activeRun, setActiveRun] = useState<WorkflowRun | null>(null);
  const [visibleLogs, setVisibleLogs] = useState<WorkflowRun['logs']>([]);
  const [currentStepId, setCurrentStepId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [apiCopied, setApiCopied] = useState(false);
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [conversations, setConversations] = useState<
    ConsumerConversationSummary[]
  >([]);
  const [consumerSessionId, setConsumerSessionId] = useState<string | null>(
    null,
  );
  const [consumerPythonRuns, setConsumerPythonRuns] = useState<
    ConsumerPythonRunRecord[]
  >([]);
  const [consumerSessionLoading, setConsumerSessionLoading] = useState(false);
  const [cancelingRunId, setCancelingRunId] = useState<string | null>(null);
  const [elapsedNow, setElapsedNow] = useState(() => Date.now());
  const [chatDraft, setChatDraft] = useState('');
  const [chatBusy, setChatBusy] = useState(false);
  /** 使用端待发送的附件：图片与受控数据文件都会走 Python 通道。 */
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  /** 加号菜单：附件 / 工作流 / 工作模式都在这里选。 */
  const [composerMenuOpen, setComposerMenuOpen] = useState(false);
  const [workMode, setWorkMode] = useState<WorkMode>('auto');
  const [localControl, setLocalControl] = useState<LocalControlState>({
    visibility: 'checking',
    available: false,
    message: '正在检查本机 Control Agent…',
  });
  /** 使用端：「内封」设置页。 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 右侧执行面板可以收起来，把宽度让给对话；选择记在这个浏览器里。 */
  const [runPanelOpen, setRunPanelOpen] = useState(false);
  /** 记录与项目的保存位置：由用户自己选，存在这台 Mac 上。 */
  const [storeStatus, setStoreStatus] = useState<LocalStoreStatusView | null>(
    null,
  );
  const [storePathDraft, setStorePathDraft] = useState('');
  const [storeBusy, setStoreBusy] = useState(false);
  const [storeError, setStoreError] = useState<string | null>(null);
  /** 这次会话里每个 Python 任务的下载凭据；只存在内存里。 */
  const pythonTokensRef = useRef<Map<string, PythonTaskCapability>>(new Map());
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  const [chatProgress, setChatProgress] = useState<{
    turnId: string;
    message: string;
  } | null>(null);
  // 使用端自带的模型配置：只存在这个浏览器里，随请求发给服务端用完即弃。
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(defaultLlmConfig);
  const [llmReady, setLlmReady] = useState(false);
  const [llmPanelOpen, setLlmPanelOpen] = useState(false);
  const [discoveredModels, setDiscoveredModels] = useState<string[]>([]);
  const [modelDiscovery, setModelDiscovery] = useState<{
    status: 'idle' | 'loading' | 'success' | 'error';
    message: string;
  }>({ status: 'idle', message: '' });
  const selectedLlmProvider = findProvider(llmConfig.provider);
  const selectableModels = useMemo(() => {
    const source = discoveredModels.length
      ? discoveredModels
      : (selectedLlmProvider?.models ?? []);
    return Array.from(
      new Set([llmConfig.model.trim(), ...source].filter(Boolean)),
    );
  }, [discoveredModels, llmConfig.model, selectedLlmProvider]);
  const llmConfigured = Boolean(
    llmReady &&
    selectedLlmProvider &&
    (!selectedLlmProvider.keyRequired || llmConfig.apiKey.trim()) &&
    llmConfig.baseUrl.trim() &&
    llmConfig.model.trim(),
  );
  const llmRuntimeLabel =
    llmConfigured && selectedLlmProvider?.id === 'ollama'
      ? '本机模型'
      : llmConfigured
        ? '真实模型'
        : '模型未配置';
  const [adminToken, setAdminToken] = useState('');
  const [adminTokenReady, setAdminTokenReady] = useState(false);
  /** 服务端把本机/内网访问当管理员会话时为 true（此时不需要令牌）。 */
  const [adminTrusted, setAdminTrusted] = useState(false);
  const runLock = useRef(false);
  const chatLock = useRef(false);
  /** 会话 ID：服务端首次回传后常驻，保证多轮对话落在同一个 n8n Memory 分区里。 */
  const sessionIdRef = useRef<string | null>(null);
  /** D1 对话记录 ID；目前与 engineSessionId 相同，但用途分开，避免以后协议耦合。 */
  const consumerSessionIdRef = useRef<string | null>(null);
  const chatListRef = useRef<HTMLDivElement>(null);
  /** 加号菜单：Esc / 点面板之外收起后要把焦点还给这颗按钮。 */
  const composerPlusRef = useRef<HTMLButtonElement | null>(null);
  const composerMenuRef = useRef<HTMLDivElement | null>(null);
  /** 同一组凭据只自动识别一次，手动刷新仍可随时重试。 */
  const modelDiscoveryFingerprintRef = useRef('');
  /** 设置页用原生模态：Esc、焦点锁、关闭后归位都交给 top layer。 */
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
  const gatewayTitleRef = useRef<HTMLHeadingElement>(null);
  const creatorTitleRef = useRef<HTMLHeadingElement>(null);
  const consumerTitleRef = useRef<HTMLHeadingElement>(null);
  const workflowsRef = useRef<WorkflowRecord[]>([]);
  const consumerWorkflowIdRef = useRef<string | null>(null);
  const consumerLoadSequenceRef = useRef(0);
  const consumerRefreshGuardRef = useRef(new ConversationRefreshGuard());
  const pendingChatReplyRef = useRef<{
    sessionId: string;
    messageId: string;
    resolve: (record: ConsumerMessageRecord) => void;
  } | null>(null);
  const runActionRef = useRef<
    (workflowId?: string) => Promise<WorkflowRun | null>
  >(async () => null);
  const chatActionRef = useRef<
    (message: string, workflowId?: string) => Promise<WorkflowRun | null>
  >(async () => null);
  const selectConsumerWorkflowRef = useRef<(id: string) => void>(() => {});
  const lastReplyRef = useRef('');
  const lastReplyRunIdRef = useRef<string | null>(null);

  const editableWorkflows = workflows.length ? workflows : [starterWorkflow];
  const workflow =
    editableWorkflows.find((item) => item.id === creatorWorkflowId) ??
    editableWorkflows[0];
  const consumerWorkflow =
    workflows.find((item) => item.id === consumerWorkflowId) ?? null;
  const publishedWorkflows = workflows.filter((item) =>
    Boolean(item.publishedSteps),
  );
  const publishedSteps = consumerWorkflow?.publishedSteps ?? null;
  const activeConversation =
    conversations.find((item) => item.id === consumerSessionId) ?? null;

  const refreshState = useCallback(async (requestedRunPage = 0) => {
    setLoadState('loading');
    try {
      const response = await fetch(`/api/state?runPage=${requestedRunPage}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('读取本地数据失败');
      const data = (await response.json()) as StateResponse;
      setWorkflows(data.workflows);
      setRuns(data.runs);
      setRunPage(data.runPagination?.page ?? requestedRunPage);
      setRunPagination({
        hasPrevious: data.runPagination?.hasPrevious ?? false,
        hasNext: data.runPagination?.hasNext ?? false,
      });
      setAdminTrusted(data.adminTrusted === true);
      setCreatorWorkflowId((current) =>
        current && data.workflows.some((item) => item.id === current)
          ? current
          : (data.workflows[0]?.id ?? null),
      );
      setConsumerWorkflowId((current) => {
        if (current && data.workflows.some((item) => item.id === current)) {
          return current;
        }
        return (
          data.workflows.find((item) => item.publishedSteps)?.id ??
          data.workflows[0]?.id ??
          null
        );
      });
      setLoadState('ready');
      setError(null);
    } catch {
      setLoadState('error');
      setError('暂时无法读取本地数据，请刷新后重试。');
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refreshState(0));
    // 首次读取固定从最新一页开始；分页按钮会显式传页码。
  }, [refreshState]);

  const refreshLocalControl = useCallback(async () => {
    setLocalControl((current) => ({
      ...current,
      available: false,
      message: '正在检查本机 Control Agent…',
    }));
    try {
      const response = await fetch('/api/local-control/status', {
        cache: 'no-store',
        headers: { 'X-Urtoris-Consumer-Client': '1' },
      });
      const data = (await response.json()) as {
        available?: boolean;
        local?: boolean;
        error?: string;
        info?: LocalControlInfoView;
      };
      if (response.status === 404 || data.local !== true) {
        setLocalControl({
          visibility: 'hidden',
          available: false,
          message: '本机控制只在本机站点显示。',
        });
        return;
      }
      if (response.ok && data.available === true && data.info) {
        setLocalControl({
          visibility: 'local',
          available: true,
          message: '本机全权限已连接',
          info: data.info,
        });
        return;
      }
      setLocalControl({
        visibility: 'local',
        available: false,
        message:
          data.error ??
          '本机 Control Agent 未连接；请用 npm run dev:control 启动。',
      });
    } catch {
      setLocalControl({
        visibility: 'local',
        available: false,
        message: '无法检查本机 Control Agent；请重新启动本机开发站点。',
      });
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => void refreshLocalControl());
  }, [refreshLocalControl]);

  const applyConsumerSession = useCallback((data: ConsumerSessionResponse) => {
    sessionIdRef.current = data.session.engineSessionId;
    consumerSessionIdRef.current = data.session.id;
    setConsumerSessionId(data.session.id);
    setConversations(data.conversations);
    setConsumerPythonRuns(data.pythonRuns);
    const pending = pendingChatReplyRef.current;
    if (pending?.sessionId === data.session.id) {
      const completed = data.messages.find(
        (record) =>
          record.id === pending.messageId &&
          record.role === 'agent' &&
          record.status !== 'working',
      );
      if (completed) pending.resolve(completed);
    }
    setChat((current) => {
      const previousById = new Map(current.map((turn) => [turn.id, turn]));
      return data.messages.map((record) => {
        const restored = persistedTurn(record);
        const previous = previousById.get(record.id);
        if (!previous) return restored;
        return {
          ...restored,
          attachments: restored.attachments?.map((item, index) => ({
            ...item,
            previewUrl:
              previous.attachments?.[index]?.name === item.name
                ? previous.attachments[index]?.previewUrl
                : null,
          })),
          artifacts: restored.artifacts?.map((item) => ({
            ...item,
            previewUrl: previous.artifacts?.find(
              (candidate) => candidate.artifactId === item.artifactId,
            )?.previewUrl,
          })),
        };
      });
    });
  }, []);

  const loadConsumerSession = useCallback(
    async (
      workflowId: string,
      options: { quiet?: boolean; sessionId?: string | null } = {},
    ) => {
      const sequence = ++consumerLoadSequenceRef.current;
      const revision = consumerRefreshGuardRef.current.beginRead();
      if (!options.quiet) setConsumerSessionLoading(true);
      try {
        const requestedSessionId =
          options.sessionId === undefined
            ? consumerSessionIdRef.current
            : options.sessionId;
        const sessionQuery = requestedSessionId
          ? `&sessionId=${encodeURIComponent(requestedSessionId)}`
          : '';
        const { response, data } = await fetchChatJson<
          ConsumerSessionResponse & { error?: string }
        >(
          `/api/consumer/session?workflowId=${encodeURIComponent(workflowId)}${sessionQuery}`,
          {
            cache: 'no-store',
            headers: { 'X-Urtoris-Consumer-Client': '1' },
          },
          15_000,
        );
        if (!response.ok || !data.session) {
          throw new Error(data.error ?? '无法读取使用端会话。');
        }
        if (
          sequence === consumerLoadSequenceRef.current &&
          consumerRefreshGuardRef.current.canApply(revision) &&
          consumerWorkflowIdRef.current === workflowId
        ) {
          applyConsumerSession(data);
        }
      } catch (cause) {
        if (!options.quiet && sequence === consumerLoadSequenceRef.current) {
          setError(
            cause instanceof Error ? cause.message : '无法读取使用端会话。',
          );
        }
      } finally {
        if (!options.quiet && sequence === consumerLoadSequenceRef.current) {
          setConsumerSessionLoading(false);
        }
      }
    },
    [applyConsumerSession],
  );

  const persistConsumerTurns = useCallback(
    async (workflowId: string, turns: ChatTurn[]) => {
      const finishWrite = consumerRefreshGuardRef.current.beginWrite();
      try {
        const { response, data } = await fetchChatJson<{
          session?: { id?: string; engineSessionId?: string };
          conversations?: ConsumerConversationSummary[];
          error?: string;
        }>(
          '/api/consumer/session',
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Urtoris-Consumer-Client': '1',
            },
            body: JSON.stringify({
              workflowId,
              sessionId: consumerSessionIdRef.current ?? undefined,
              messages: turns.map((turn) => ({
                id: turn.id,
                role: turn.role,
                status: turn.working
                  ? 'working'
                  : turn.failed
                    ? 'failed'
                    : 'completed',
                text: turn.text,
                metadata: turnMetadata(turn),
                createdAt: turn.at,
              })),
            }),
          },
          20_000,
        );
        if (
          !response.ok ||
          !data.session?.id ||
          !data.session.engineSessionId
        ) {
          throw new Error(data.error ?? '无法保存使用端会话。');
        }
        sessionIdRef.current = data.session.engineSessionId;
        consumerSessionIdRef.current = data.session.id;
        setConsumerSessionId(data.session.id);
        if (data.conversations) setConversations(data.conversations);
      } finally {
        finishWrite();
      }
    },
    [],
  );

  const createConversation = useCallback(async () => {
    const target =
      workflows.find(
        (item) =>
          item.id === consumerWorkflowId && Boolean(item.publishedSteps),
      ) ?? publishedWorkflows[0];
    if (!target?.publishedSteps || chatBusy) return;
    setConsumerSessionLoading(true);
    try {
      const response = await fetch('/api/consumer/session', {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'X-Urtoris-Consumer-Client': '1',
        },
        body: JSON.stringify({ workflowId: target.id }),
      });
      const data = (await response.json()) as ConsumerSessionResponse & {
        error?: string;
      };
      if (!response.ok || !data.session) {
        throw new Error(data.error ?? '无法新建对话。');
      }
      consumerWorkflowIdRef.current = target.id;
      setConsumerWorkflowId(target.id);
      setChatProgress(null);
      setActiveRun(null);
      setVisibleLogs([]);
      lastReplyRef.current = '';
      lastReplyRunIdRef.current = null;
      setCurrentStepId(null);
      applyConsumerSession(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '无法新建对话。');
    } finally {
      setConsumerSessionLoading(false);
    }
  }, [
    applyConsumerSession,
    chatBusy,
    consumerWorkflowId,
    publishedWorkflows,
    workflows,
  ]);

  const openConversation = useCallback(
    (conversation: ConsumerConversationSummary) => {
      if (chatBusy || conversation.id === consumerSessionIdRef.current) return;
      consumerLoadSequenceRef.current += 1;
      consumerWorkflowIdRef.current = conversation.workflowId;
      consumerSessionIdRef.current = conversation.id;
      sessionIdRef.current = conversation.engineSessionId;
      setConsumerSessionId(conversation.id);
      setChat([]);
      setConsumerPythonRuns([]);
      setChatProgress(null);
      setActiveRun(null);
      setVisibleLogs([]);
      setCurrentStepId(null);
      if (conversation.workflowId === consumerWorkflowId) {
        void loadConsumerSession(conversation.workflowId, {
          sessionId: conversation.id,
        });
      } else {
        setConsumerWorkflowId(conversation.workflowId);
      }
    },
    [chatBusy, consumerWorkflowId, loadConsumerSession],
  );

  const generateConversationTitle = useCallback(
    async (workflowId: string, userMessage: string, agentReply: string) => {
      const sessionId = consumerSessionIdRef.current;
      if (!sessionId) return;
      try {
        const response = await fetch('/api/consumer/session', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'X-Urtoris-Consumer-Client': '1',
          },
          body: JSON.stringify({
            workflowId,
            sessionId,
            userMessage,
            agentReply,
            provider: llmConfig.provider,
            apiKey: llmConfig.apiKey.trim() || undefined,
            baseUrl: llmConfig.baseUrl.trim() || undefined,
            model: llmConfig.model.trim() || undefined,
          }),
        });
        const data = (await response.json()) as {
          conversations?: ConsumerConversationSummary[];
        };
        if (response.ok && data.conversations) {
          setConversations(data.conversations);
        }
      } catch {
        // 标题生成失败不打断对话；下次仍可保持「新对话」。
      }
    },
    [llmConfig],
  );

  useEffect(() => {
    if (!consumerWorkflowId) return;
    consumerWorkflowIdRef.current = consumerWorkflowId;
    queueMicrotask(() => setConsumerPythonRuns([]));
    queueMicrotask(
      () =>
        void loadConsumerSession(consumerWorkflowId, {
          sessionId: consumerSessionIdRef.current,
        }),
    );
  }, [consumerWorkflowId, loadConsumerSession]);

  const hasActivePythonRun = consumerPythonRuns.some(
    (run) => run.status === 'queued' || run.status === 'running',
  );
  const hasActiveShellRun = chat.some((turn) =>
    turn.shell?.runs.some(
      (run) => run.status === 'queued' || run.status === 'running',
    ),
  );
  const hasPendingAgentMessage = chat.some(
    (turn) => turn.role === 'agent' && turn.working,
  );

  useEffect(() => {
    if (
      !consumerWorkflowId ||
      (!chatBusy &&
        !hasActivePythonRun &&
        !hasActiveShellRun &&
        !hasPendingAgentMessage)
    ) {
      return;
    }
    const refresh = () =>
      void loadConsumerSession(consumerWorkflowId, { quiet: true });
    refresh();
    const timer = window.setInterval(refresh, 2_000);
    return () => window.clearInterval(timer);
  }, [
    chatBusy,
    consumerWorkflowId,
    hasActivePythonRun,
    hasActiveShellRun,
    hasPendingAgentMessage,
    loadConsumerSession,
  ]);

  useEffect(() => {
    if (!hasActivePythonRun && !hasActiveShellRun && !hasPendingAgentMessage)
      return;
    const updateElapsed = () => setElapsedNow(Date.now());
    queueMicrotask(updateElapsed);
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [hasActivePythonRun, hasActiveShellRun, hasPendingAgentMessage]);

  // 读取本浏览器里保存的模型配置（Key 不入服务端、不进代码库）。
  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = window.localStorage.getItem(LLM_STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as Partial<LlmConfig>;
          const storedProvider =
            typeof parsed.provider === 'string' &&
            providerDefaults(parsed.provider)
              ? parsed.provider
              : defaultLlmConfig.provider;
          setLlmConfig({
            provider: storedProvider,
            apiKey: typeof parsed.apiKey === 'string' ? parsed.apiKey : '',
            baseUrl:
              typeof parsed.baseUrl === 'string' && parsed.baseUrl.trim()
                ? parsed.baseUrl
                : defaultLlmConfig.baseUrl,
            model:
              typeof parsed.model === 'string' && parsed.model.trim()
                ? parsed.model
                : defaultLlmConfig.model,
            reasoningEffort: isLlmReasoningEffort(parsed.reasoningEffort)
              ? parsed.reasoningEffort
              : 'auto',
          });
        }
      } catch {
        // 读不到就用默认值，不影响页面其他部分。
      }
      setLlmReady(true);
    });
  }, []);

  // 右侧执行面板的收起状态（同样只存在这个浏览器里）。
  useEffect(() => {
    queueMicrotask(() => {
      try {
        setRunPanelOpen(
          window.localStorage.getItem(RUN_PANEL_STORAGE_KEY) === '1',
        );
      } catch {
        // 读不到就保持默认收起，把空间优先留给对话。
      }
    });
  }, []);

  const toggleRunPanel = useCallback(() => {
    setRunPanelOpen((current) => {
      const next = !current;
      try {
        window.localStorage.setItem(RUN_PANEL_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // 存不了只影响下次打开，不影响这次。
      }
      return next;
    });
  }, []);

  const refreshStore = useCallback(async () => {
    try {
      const response = await fetch('/api/local-store/store', {
        cache: 'no-store',
      });
      if (!response.ok) {
        setStoreStatus(null);
        return;
      }
      const payload = (await response.json()) as LocalStoreStatusView;
      setStoreStatus(payload);
      if (payload.root) setStorePathDraft(payload.root);
    } catch {
      setStoreStatus(null);
    }
  }, []);

  /** 保存位置：原生文件夹选择器，或者手填绝对路径。 */
  const applyStore = useCallback(
    async (mode: 'pick' | 'path') => {
      setStoreBusy(true);
      setStoreError(null);
      try {
        const response =
          mode === 'pick'
            ? await fetch('/api/local-store/store/pick', { method: 'POST' })
            : await fetch('/api/local-store/store/root', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ path: storePathDraft.trim() }),
              });
        const payload = (await response.json()) as LocalStoreStatusView & {
          cancelled?: boolean;
          error?: string;
          status?: LocalStoreStatusView;
        };
        if (!response.ok) {
          setStoreError(payload.error ?? '没有保存成功。');
          return;
        }
        if (payload.cancelled) return;
        const status = payload.status ?? payload;
        setStoreStatus(status);
        if (status.root) setStorePathDraft(status.root);
      } catch {
        setStoreError('无法连接本机存储服务。');
      } finally {
        setStoreBusy(false);
      }
    },
    [storePathDraft],
  );

  useEffect(() => {
    if (localControl.available) queueMicrotask(() => void refreshStore());
  }, [localControl.available, refreshStore]);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        setAdminToken(
          window.sessionStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? '',
        );
      } catch {
        // 隐私模式下无法读取也没关系，管理员仍可在当前页面输入。
      } finally {
        setAdminTokenReady(true);
      }
    });
  }, []);

  useEffect(() => {
    if (!adminTokenReady) return;
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
      // 隐私模式下无法保存也没关系。
    }
  }, [adminToken, adminTokenReady]);

  useEffect(() => {
    if (!llmReady) return;
    try {
      window.localStorage.setItem(LLM_STORAGE_KEY, JSON.stringify(llmConfig));
    } catch {
      // 隐私模式下写不进去也没关系。
    }
  }, [llmConfig, llmReady]);

  const discoverLlmModels = useCallback(async () => {
    modelDiscoveryFingerprintRef.current = [
      llmConfig.provider,
      llmConfig.baseUrl.trim(),
      llmConfig.apiKey.trim(),
    ].join('\n');
    setModelDiscovery({ status: 'loading', message: '正在读取模型…' });
    try {
      const response = await fetch('/api/llm/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Urtoris-Consumer-Client': '1',
        },
        body: JSON.stringify({
          provider: llmConfig.provider,
          apiKey: llmConfig.apiKey.trim() || undefined,
          baseUrl: llmConfig.baseUrl.trim() || undefined,
        }),
      });
      const payload = (await response.json()) as {
        models?: string[];
        error?: string;
      };
      if (!response.ok || !Array.isArray(payload.models)) {
        throw new Error(payload.error ?? '没有读到模型列表。');
      }
      setDiscoveredModels(payload.models);
      setLlmConfig((current) => ({
        ...current,
        model:
          !current.model.trim() ||
          (current.model === findProvider(current.provider)?.defaultModel &&
            !payload.models?.includes(current.model))
            ? (payload.models?.[0] ?? current.model)
            : current.model,
      }));
      setModelDiscovery({
        status: 'success',
        message: `已识别 ${payload.models.length} 个模型`,
      });
    } catch (cause) {
      setDiscoveredModels([]);
      setModelDiscovery({
        status: 'error',
        message: cause instanceof Error ? cause.message : '读取模型失败。',
      });
    }
  }, [llmConfig.apiKey, llmConfig.baseUrl, llmConfig.provider]);

  // 凭据与端点齐备后自动识别一次；用户不需要再猜“识别”按钮何时可点。
  useEffect(() => {
    if (
      !llmReady ||
      !selectedLlmProvider ||
      !llmConfig.baseUrl.trim() ||
      (selectedLlmProvider.keyRequired && !llmConfig.apiKey.trim())
    ) {
      return;
    }
    const fingerprint = [
      llmConfig.provider,
      llmConfig.baseUrl.trim(),
      llmConfig.apiKey.trim(),
    ].join('\n');
    if (modelDiscoveryFingerprintRef.current === fingerprint) return;
    const timer = window.setTimeout(() => {
      modelDiscoveryFingerprintRef.current = fingerprint;
      void discoverLlmModels();
    }, 700);
    return () => window.clearTimeout(timer);
  }, [
    discoverLlmModels,
    llmConfig.apiKey,
    llmConfig.baseUrl,
    llmConfig.provider,
    llmReady,
    selectedLlmProvider,
  ]);

  useEffect(() => {
    window.scrollTo(0, 0);
    const target =
      portal === 'gateway'
        ? gatewayTitleRef.current
        : portal === 'creator'
          ? creatorTitleRef.current
          : consumerTitleRef.current;
    target?.focus();
  }, [portal]);

  const patchWorkflow = (id: string, change: Partial<WorkflowRecord>) => {
    setWorkflows((current) => {
      const list = current.length ? current : [starterWorkflow];
      return list.map((item) =>
        item.id === id
          ? { ...item, ...change, hasUnpublishedChanges: true }
          : item,
      );
    });
    setSaveState('idle');
  };

  const markChanged = (change: Partial<WorkflowRecord>) => {
    patchWorkflow(workflow.id, change);
  };

  const updateStep = (id: string, change: Partial<WorkflowStep>) => {
    patchWorkflow(workflow.id, {
      draftSteps: workflow.draftSteps.map((step) =>
        step.id === id ? { ...step, ...change } : step,
      ),
    });
  };

  const addStep = () => {
    if (workflow.draftSteps.length >= 12) {
      setError('第一版最多支持 12 个步骤；请先删掉一个再添加。');
      return;
    }
    const id = `step_${randomId().slice(0, 8)}`;
    patchWorkflow(workflow.id, {
      draftSteps: [
        ...workflow.draftSteps,
        {
          id,
          title: '新步骤',
          detail: '说明这个步骤要完成什么',
          kind: 'transform',
        },
      ],
    });
    setError(null);
  };

  const removeStep = (id: string) => {
    if (workflow.draftSteps.length === 1) {
      setError('工作流至少需要保留一个步骤。');
      return;
    }
    patchWorkflow(workflow.id, {
      draftSteps: workflow.draftSteps.filter((step) => step.id !== id),
    });
  };

  const moveStep = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= workflow.draftSteps.length) return;
    const next = [...workflow.draftSteps];
    [next[index], next[target]] = [next[target], next[index]];
    patchWorkflow(workflow.id, { draftSteps: next });
  };

  const createNewWorkflow = async () => {
    setError(null);
    try {
      const response = await fetch('/api/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken.trim()
            ? { Authorization: `Bearer ${adminToken.trim()}` }
            : {}),
        },
        body: JSON.stringify({ action: 'create' }),
      });
      const data = (await response.json()) as {
        workflow?: WorkflowRecord;
        error?: string;
      };
      if (!response.ok || !data.workflow) {
        throw new Error(data.error ?? '新建失败');
      }
      setWorkflows((current) => [data.workflow as WorkflowRecord, ...current]);
      setCreatorWorkflowId(data.workflow.id);
      setSaveState('idle');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '新建失败，请重试。');
    }
  };

  const persistWorkflow = async (action: 'save' | 'publish') => {
    if (
      workflow.name.trim().length < 2 ||
      workflow.draftSteps.some((step) => !step.title.trim())
    ) {
      setError('请填写工作流名称，并确保每个步骤都有名称。');
      return;
    }

    setSaveState('saving');
    setError(null);
    try {
      const response = await fetch('/api/workflows', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(adminToken.trim()
            ? { Authorization: `Bearer ${adminToken.trim()}` }
            : {}),
        },
        body: JSON.stringify({
          id: workflow.id,
          name: workflow.name,
          description: workflow.description,
          steps: workflow.draftSteps,
          action,
          n8nWebhookUrl: workflow.n8nWebhookUrl ?? '',
        }),
      });
      const data = (await response.json()) as {
        workflow?: WorkflowRecord;
        error?: string;
      };
      if (!response.ok || !data.workflow) {
        throw new Error(data.error ?? '保存失败');
      }
      setWorkflows((current) => {
        const list = current.length ? current : [starterWorkflow];
        return list.map((item) =>
          item.id === data.workflow?.id
            ? (data.workflow as WorkflowRecord)
            : item,
        );
      });
      setSaveState('saved');
      if (action === 'publish') {
        setActiveRun(null);
        setVisibleLogs([]);
      }
    } catch (cause) {
      setSaveState('idle');
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
    }
  };

  const startRun = useCallback(
    async (requestedWorkflowId?: string): Promise<WorkflowRun | null> => {
      const target =
        workflows.find(
          (item) => item.id === (requestedWorkflowId ?? consumerWorkflowId),
        ) ?? null;
      if (!target?.publishedSteps || running || runLock.current) return null;

      runLock.current = true;
      setRunning(true);
      setCurrentStepId(null);
      setVisibleLogs([]);
      setError(null);

      try {
        const response = await fetch('/api/runs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workflowId: target.id }),
        });
        const data = (await response.json()) as {
          run?: WorkflowRun;
          error?: string;
        };
        if (!response.ok || !data.run) {
          throw new Error(data.error ?? '运行失败');
        }

        const completedRun = data.run;
        setActiveRun({ ...completedRun, status: 'running' });
        for (let index = 0; index < completedRun.logs.length; index += 1) {
          const log = completedRun.logs[index];
          setVisibleLogs(completedRun.logs.slice(0, index + 1));
          setCurrentStepId(log.stepId ?? null);
          await wait(index === 0 ? 260 : 520);
        }
        setCurrentStepId(null);
        setActiveRun(completedRun);
        setRuns((current) => [completedRun, ...current].slice(0, 8));
        return completedRun;
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '运行失败，请重试。');
        setActiveRun(null);
        return null;
      } finally {
        runLock.current = false;
        setRunning(false);
      }
    },
    [running, workflows, consumerWorkflowId],
  );

  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  useEffect(
    () => () => {
      for (const item of attachmentsRef.current) {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      }
    },
    [],
  );

  /** 把新选中的文件并入待发附件；超限或类型不支持时整体拒绝并说明原因。 */
  const addAttachments = useCallback(
    (incoming: File[]) => {
      if (incoming.length === 0) return;
      const merged: PendingAttachment[] = [
        ...attachments,
        ...incoming.map((file) => ({
          id: randomId(),
          file,
          name: file.name || '剪贴板图片.png',
          mountName: '',
          size: file.size,
          previewUrl: file.type.startsWith('image/')
            ? URL.createObjectURL(file)
            : null,
        })),
      ].map((item, index) => ({
        ...item,
        mountName: mountNameFor(index, item.name),
      }));

      const verdict = validateAttachments(
        merged.map((item) => ({ name: item.name, size: item.size })),
      );
      if (!verdict.ok) {
        for (const item of merged.slice(attachments.length)) {
          if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        }
        setError(verdict.error);
        return;
      }
      setError(null);
      setAttachments(merged);
    },
    [attachments],
  );

  const removeAttachment = useCallback((id: string) => {
    setAttachments((current) => {
      const target = current.find((item) => item.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      return current
        .filter((item) => item.id !== id)
        .map((item, index) => ({
          ...item,
          mountName: mountNameFor(index, item.name),
        }));
    });
  }, []);

  const clearAttachments = useCallback(() => {
    for (const item of attachmentsRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    attachmentsRef.current = [];
    setAttachments([]);
  }, []);

  const handleAttachmentDrop = useCallback(
    (event: React.DragEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      addAttachments(files);
    },
    [addAttachments],
  );

  const handleAttachmentPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      addAttachments(files);
    },
    [addAttachments],
  );

  /** 每次带附件的发送都开一个新任务：文件归属清晰，也不会吃掉上一次的尝试次数。 */
  const createPythonTask =
    useCallback(async (): Promise<PythonTaskCapability> => {
      const response = await fetch('/api/python/tasks', { method: 'POST' });
      const data = (await response.json()) as {
        taskId?: string;
        taskToken?: string;
        error?: string;
      };
      if (!response.ok || !data.taskId || !data.taskToken) {
        throw new Error(data.error ?? '无法创建 Python 任务。');
      }
      const capability = {
        taskId: data.taskId,
        taskToken: data.taskToken,
      };
      pythonTokensRef.current.set(capability.taskId, capability);
      return capability;
    }, []);

  const uploadAttachment = useCallback(
    async (
      attachment: PendingAttachment,
      capability: PythonTaskCapability,
    ): Promise<string> => {
      const response = await fetch(
        `/api/python/files?taskId=${encodeURIComponent(capability.taskId)}&name=${encodeURIComponent(attachment.mountName)}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Urtoris-Task-Token': capability.taskToken,
          },
          body: attachment.file,
        },
      );
      const data = (await response.json()) as {
        file?: { file_id?: string };
        error?: string;
      };
      if (!response.ok || !data.file?.file_id) {
        throw new Error(data.error ?? `上传失败：${attachment.name}`);
      }
      return data.file.file_id;
    },
    [],
  );

  const fetchArtifactBlob = useCallback(
    async (
      taskId: string,
      runId: string,
      artifactId: string,
    ): Promise<Blob> => {
      const capability = pythonTokensRef.current.get(taskId);
      const response = await fetch(
        `/api/python/artifacts/${encodeURIComponent(artifactId)}?taskId=${encodeURIComponent(taskId)}&runId=${encodeURIComponent(runId)}`,
        {
          headers: capability
            ? {
                'X-Urtoris-Task-Token': capability.taskToken,
                'X-Urtoris-Consumer-Client': '1',
              }
            : { 'X-Urtoris-Consumer-Client': '1' },
        },
      );
      if (!response.ok) throw new Error('下载产物失败。');
      return response.blob();
    },
    [],
  );

  const downloadArtifact = useCallback(
    async (taskId: string, artifact: ChatArtifact) => {
      try {
        const blob = await fetchArtifactBlob(
          taskId,
          artifact.runId,
          artifact.artifactId,
        );
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = artifact.name;
        anchor.click();
        URL.revokeObjectURL(url);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '下载产物失败。');
      }
    },
    [fetchArtifactBlob],
  );

  const cancelPythonRun = useCallback(
    async (run: ConsumerPythonRunRecord) => {
      if (cancelingRunId) return;
      setCancelingRunId(run.runId);
      setError(null);
      try {
        const capability = pythonTokensRef.current.get(run.taskId);
        const response = await fetch(
          `/api/python/runs/${encodeURIComponent(run.runId)}?taskId=${encodeURIComponent(run.taskId)}`,
          {
            method: 'DELETE',
            headers: capability
              ? {
                  'X-Urtoris-Task-Token': capability.taskToken,
                  'X-Urtoris-Consumer-Client': '1',
                }
              : { 'X-Urtoris-Consumer-Client': '1' },
          },
        );
        const data = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? '无法取消这次运行。');
        }
        if (consumerWorkflowId) {
          await loadConsumerSession(consumerWorkflowId, { quiet: true });
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '无法取消这次运行。');
      } finally {
        setCancelingRunId(null);
      }
    },
    [cancelingRunId, consumerWorkflowId, loadConsumerSession],
  );

  const cancelShellRun = useCallback(
    async (taskId: string, run: ChatShellRun) => {
      if (cancelingRunId) return;
      setCancelingRunId(run.runId);
      setError(null);
      try {
        const response = await fetch(
          `/api/local-control/runs/${encodeURIComponent(run.runId)}?taskId=${encodeURIComponent(taskId)}`,
          {
            method: 'DELETE',
            headers: { 'X-Urtoris-Consumer-Client': '1' },
          },
        );
        const data = (await response.json()) as { error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? '无法取消这条本机命令。');
        }
        if (consumerWorkflowId) {
          await loadConsumerSession(consumerWorkflowId, { quiet: true });
        }
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : '无法取消这条本机命令。',
        );
      } finally {
        setCancelingRunId(null);
      }
    },
    [cancelingRunId, consumerWorkflowId, loadConsumerSession],
  );

  const sendChatMessage = useCallback(
    async (
      rawMessage?: string,
      requestedWorkflowId?: string,
    ): Promise<WorkflowRun | null> => {
      const text = (rawMessage ?? chatDraft).trim();
      const target =
        workflows.find(
          (item) => item.id === (requestedWorkflowId ?? consumerWorkflowId),
        ) ?? null;
      if (!text || !target?.publishedSteps || chatLock.current) return null;
      const usesLocalDatabase = target.databaseRuntime === 'local-sqlite';
      if (
        usesLocalDatabase &&
        (attachments.length > 0 ||
          workMode === 'shell' ||
          workMode === 'python')
      ) {
        setError(
          '本机数据库工作流请使用「自动」或「仅对话」模式，直接提问即可查询 SQLite；当前不支持附件、Python 或本机 Shell。',
        );
        setComposerMenuOpen(true);
        return null;
      }
      if (usesLocalDatabase && !getDatabaseConnectionCode()) {
        setError('请先在设置中连接本机数据库助手，再向 AI 提问。');
        setSettingsOpen(true);
        return null;
      }
      const shouldGenerateTitle =
        chat.length === 0 &&
        (!activeConversation || activeConversation.title === '新对话');
      if (workMode === 'chat' && attachments.length > 0) {
        setError(
          '当前是「仅对话」模式：附件要切到「自动」或「允许 Python」才会交给沙箱处理。',
        );
        setComposerMenuOpen(true);
        return null;
      }
      if (workMode === 'shell' && attachments.length > 0) {
        setError(
          '「本机全权限」当前不接收浏览器附件；请先把文件保存到这台 Mac，再在消息里写明绝对路径。',
        );
        setComposerMenuOpen(true);
        return null;
      }
      if (workMode === 'shell' && !localControl.available) {
        setError(
          localControl.message ||
            '本机 Control Agent 未连接，请用 npm run dev:control 重新启动。',
        );
        setSettingsOpen(true);
        return null;
      }

      chatLock.current = true;
      lastReplyRef.current = '';
      lastReplyRunIdRef.current = null;
      setChatBusy(true);
      setChatDraft('');
      setError(null);
      setRunning(true);
      setCurrentStepId(null);
      setVisibleLogs([]);

      const now = Date.now();
      const pending = attachments;
      const artifactGenerationRequested =
        !usesLocalDatabase &&
        workMode === 'auto' &&
        isArtifactGenerationRequest(text);
      const isPlainChat =
        workMode !== 'shell' &&
        workMode !== 'python' &&
        pending.length === 0 &&
        !artifactGenerationRequested;
      const chatRequestId = isPlainChat ? randomId() : undefined;
      const userTurn: ChatTurn = {
        id: randomId(),
        role: 'user',
        text,
        at: now,
        attachments: pending.map((item) => ({
          name: item.name,
          size: item.size,
          mimeType: attachmentMimeType(item.name),
          previewUrl: item.previewUrl,
        })),
      };
      const agentTurnId = randomId();
      const agentTurn: ChatTurn = {
        id: agentTurnId,
        role: 'agent',
        text: '',
        at: now + 1,
        working: true,
        chatRequestId,
      };
      setChatProgress({ turnId: agentTurnId, message: '正在保存消息…' });
      setChat((current) => [...current, userTurn, agentTurn]);
      let shellRequestReachedServer = false;
      let chatRequestReachedServer = false;
      const recoveredChatReply = {
        record: null as ConsumerMessageRecord | null,
      };
      const chatResponseController = new AbortController();

      const showRecoveredReply = (record: ConsumerMessageRecord) => {
        consumerRefreshGuardRef.current.invalidate();
        setChatProgress(null);
        setCurrentStepId(null);
        setChat((current) =>
          current.map((turn) =>
            turn.id === agentTurnId ? persistedTurn(record) : turn,
          ),
        );
        if (record.status === 'failed') {
          setError(record.text);
          return;
        }
        lastReplyRef.current = record.text;
        lastReplyRunIdRef.current =
          typeof record.metadata.runId === 'string'
            ? record.metadata.runId
            : null;
        if (shouldGenerateTitle) {
          void generateConversationTitle(target.id, text, record.text);
        }
      };

      try {
        // 先把「用户消息 + 处理中」落库，再启动任务。
        // 即使页面立刻关闭，重开后也能找回这一轮。
        await persistConsumerTurns(target.id, [userTurn, agentTurn]);

        if (workMode === 'shell') {
          setChatProgress({
            turnId: agentTurnId,
            message: 'Control Agent 正在规划本机命令…',
          });
          shellRequestReachedServer = true;
          const shellResponse = await fetch('/api/local-control/agent', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Urtoris-Consumer-Client': '1',
            },
            body: JSON.stringify({
              message: text,
              provider: llmConfig.provider,
              apiKey: llmConfig.apiKey.trim() || undefined,
              baseUrl: llmConfig.baseUrl.trim() || undefined,
              model: llmConfig.model.trim() || undefined,
              reasoningEffort: llmConfig.reasoningEffort,
              workflowId: target.id,
              sessionId: consumerSessionIdRef.current ?? undefined,
              agentMessageId: agentTurnId,
              userMessageId: userTurn.id,
            }),
          });
          const shellData = (await shellResponse.json()) as
            | (LocalControlAgentResponse & { error?: string })
            | { error?: string; errorCode?: string };
          if (!shellResponse.ok || !('reply' in shellData)) {
            throw new Error(
              ('error' in shellData && shellData.error) ||
                '本机 Control Agent 暂时没有回应。',
            );
          }
          setChatProgress(null);
          consumerRefreshGuardRef.current.invalidate();
          const completedTurn: ChatTurn = {
            ...agentTurn,
            working: false,
            text: shellData.reply,
            shell: {
              taskId: shellData.taskId,
              runs: shellData.runs,
              succeeded: shellData.succeeded,
              stopReason: shellData.stopReason,
            },
            failed: !shellData.succeeded,
          };
          setChat((current) =>
            current.map((turn) =>
              turn.id === agentTurnId ? completedTurn : turn,
            ),
          );
          void loadConsumerSession(target.id, { quiet: true });
          lastReplyRef.current = shellData.reply;
          if (shouldGenerateTitle) {
            void generateConversationTitle(target.id, text, shellData.reply);
          }
          return null;
        }

        // 走 Python 通道的情况：模式明确要求、自动模式带了附件，
        // 或用户明确要求生成可下载文件。
        // 附件先上传成受控 file_id，再交给 Agent。
        if (
          workMode === 'python' ||
          pending.length > 0 ||
          artifactGenerationRequested
        ) {
          const capability = await createPythonTask();
          const uploaded = [];
          if (pending.length > 0) {
            setChatProgress({ turnId: agentTurnId, message: '正在上传附件…' });
            for (const item of pending) {
              uploaded.push({
                fileId: await uploadAttachment(item, capability),
                mountName: item.mountName,
                name: item.name,
                size: item.size,
              });
            }
          }

          setChatProgress({
            turnId: agentTurnId,
            message: artifactGenerationRequested
              ? '正在执行并生成文件…'
              : '正在分析…',
          });
          const pythonResponse = await fetch('/api/python/agent', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Urtoris-Task-Token': capability.taskToken,
            },
            body: JSON.stringify({
              taskId: capability.taskId,
              message: text,
              inputs: toAgentInputs(uploaded),
              provider: llmConfig.provider,
              apiKey: llmConfig.apiKey.trim() || undefined,
              baseUrl: llmConfig.baseUrl.trim() || undefined,
              model: llmConfig.model.trim() || undefined,
              reasoningEffort: llmConfig.reasoningEffort,
              workflowId: target.id,
              sessionId: consumerSessionIdRef.current ?? undefined,
              agentMessageId: agentTurnId,
              userMessageId: userTurn.id,
            }),
          });
          const pythonData = (await pythonResponse.json()) as
            | (PythonAgentResponse & { error?: string })
            | { error?: string; errorCode?: string };
          if (!pythonResponse.ok || !('reply' in pythonData)) {
            throw new Error(
              ('error' in pythonData && pythonData.error) ||
                'Python Agent 暂时没有回应。',
            );
          }

          const artifacts: ChatArtifact[] = [];
          for (const artifact of pythonData.artifacts) {
            const runId =
              pythonData.runs.find((run) =>
                run.artifactIds.includes(artifact.artifactId),
              )?.runId ??
              pythonData.runs.at(-1)?.runId ??
              '';
            let previewUrl: string | null = null;
            if (artifact.mimeType.startsWith('image/')) {
              try {
                previewUrl = URL.createObjectURL(
                  await fetchArtifactBlob(
                    pythonData.taskId,
                    runId,
                    artifact.artifactId,
                  ),
                );
              } catch {
                previewUrl = null;
              }
            }
            artifacts.push({ ...artifact, runId, previewUrl });
          }

          clearAttachments();
          setChatProgress(null);
          const completedTurn: ChatTurn = {
            ...agentTurn,
            working: false,
            text: pythonData.reply,
            artifacts,
            python: {
              taskId: pythonData.taskId,
              attempts: pythonData.attempts,
              succeeded: pythonData.succeeded,
              stopReason: pythonData.stopReason,
              guarded: pythonData.replySource === 'guard',
            },
            failed: !pythonData.succeeded,
          };
          await persistConsumerTurns(target.id, [completedTurn]);
          setChat((current) =>
            current.map((turn) =>
              turn.id === agentTurnId ? completedTurn : turn,
            ),
          );
          void loadConsumerSession(target.id, { quiet: true });
          lastReplyRef.current = pythonData.reply;
          if (shouldGenerateTitle) {
            void generateConversationTitle(target.id, text, pythonData.reply);
          }
          return null;
        }

        setChatProgress({
          turnId: agentTurnId,
          message: '正在读取对话记录并请求回复…',
        });
        chatRequestReachedServer = true;
        const savedReply = new Promise<ConsumerMessageRecord>((resolve) => {
          pendingChatReplyRef.current = {
            sessionId: consumerSessionIdRef.current!,
            messageId: agentTurnId,
            resolve: (record) => {
              recoveredChatReply.record = record;
              resolve(record);
            },
          };
        });
        const chatBody = {
          workflowId: target.id,
          message: text,
          // 会话 ID 由服务端首次生成后回传，之后每轮原样带回 → n8n 侧 Memory 才能接上上下文
          sessionId: sessionIdRef.current ?? undefined,
          // 使用端会话 ID：服务端据此从 D1 读出已落库的历史轮次，
          // 让直连模型也能像 n8n Memory 一样看到同一个对话的前文。
          consumerSessionId: consumerSessionIdRef.current ?? undefined,
          userMessageId: userTurn.id,
          agentMessageId: agentTurnId,
          requestId: chatRequestId,
          apiKey: llmConfig.apiKey.trim() || undefined,
          provider: llmConfig.provider,
          baseUrl: llmConfig.baseUrl.trim() || undefined,
          model: llmConfig.model.trim() || undefined,
          reasoningEffort: llmConfig.reasoningEffort,
        };
        const httpReply = (async () => {
          type Reply = AgentChatResponse & {
            error?: string;
            database?: { session: string; requests: DatabaseToolRequest[] };
          };
          const requestReply = (body: unknown) =>
            fetchChatJson<Reply>(
              '/api/agent/chat',
              {
                method: 'POST',
                signal: chatResponseController.signal,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
              },
              100_000,
            );
          let reply = await requestReply(chatBody);
          for (
            let round = 0;
            round < 6 && reply.response.ok && reply.data.database;
            round++
          ) {
            const { session, requests } = reply.data.database;
            const databaseResults = await executeDatabaseRequests(
              requests,
              (message) => setChatProgress({ turnId: agentTurnId, message }),
              chatResponseController.signal,
            );
            setChatProgress({
              turnId: agentTurnId,
              message: 'AI 正在分析查询结果…',
            });
            reply = await requestReply({
              ...chatBody,
              databaseSession: session,
              databaseResults,
            });
          }
          if (reply.response.ok && reply.data.database)
            throw new Error(
              'AI 数据库查询轮数已达上限，请缩小问题范围后重试。',
            );
          return reply;
        })();
        const result = await Promise.race([
          httpReply.then((value) => ({ source: 'http' as const, ...value })),
          savedReply.then((record) => ({ source: 'saved' as const, record })),
        ]);
        if (result.source === 'saved') {
          chatResponseController.abort();
          showRecoveredReply(result.record);
          return null;
        }
        const { response, data } = result;
        consumerRefreshGuardRef.current.invalidate();
        if (data.sessionId) {
          sessionIdRef.current = data.sessionId;
        }
        if (!response.ok || !data.run) {
          chatRequestReachedServer = Boolean(data.run);
          throw new Error(data.error ?? 'Agent 暂时没有回应。');
        }
        setVisibleLogs(data.run.logs);

        lastReplyRef.current = data.reply;
        lastReplyRunIdRef.current = data.run.id;
        setChatProgress(null);
        setCurrentStepId(null);
        const completedTurn: ChatTurn = {
          ...agentTurn,
          working: false,
          text: data.reply,
          runId: data.run.id,
          intent: data.intent,
          priority: data.priority,
          mode: data.mode,
          executionMode: data.executionMode,
          degraded: data.degraded,
        };
        // The server has already saved the reply; show it immediately.
        setChat((current) =>
          current.map((turn) =>
            turn.id === agentTurnId ? completedTurn : turn,
          ),
        );
        setActiveRun(data.run);
        setRuns((current) => [data.run, ...current].slice(0, 8));
        if (shouldGenerateTitle) {
          void generateConversationTitle(target.id, text, data.reply);
        }
        return data.run;
      } catch (cause) {
        // 失败必须留在对话里：否则用户只看到"发了消息没人回"。
        const failureMessage = describeChatFailure(cause);
        consumerRefreshGuardRef.current.invalidate();
        setChatProgress(null);
        const failedTurn: ChatTurn = {
          ...agentTurn,
          working: false,
          text: failureMessage,
          failed: true,
        };
        setChat((current) =>
          current.map((turn) =>
            turn.id === agentTurnId
              ? {
                  ...turn,
                  working: false,
                  text: describeChatFailure(cause),
                  failed: true,
                }
              : turn,
          ),
        );
        try {
          if (shellRequestReachedServer || chatRequestReachedServer) {
            await loadConsumerSession(target.id, { quiet: true });
          } else {
            await persistConsumerTurns(target.id, [failedTurn]);
          }
        } catch {
          // 会话存储本身不可用时，保留原始失败原因。
        }
        if (recoveredChatReply.record) {
          showRecoveredReply(recoveredChatReply.record);
          return null;
        }
        setError(failureMessage);
        return null;
      } finally {
        if (pendingChatReplyRef.current?.messageId === agentTurnId) {
          pendingChatReplyRef.current = null;
        }
        chatResponseController.abort();
        chatLock.current = false;
        setChatBusy(false);
        setRunning(false);
      }
    },
    [
      attachments,
      activeConversation,
      chat,
      chatDraft,
      workMode,
      workflows,
      consumerWorkflowId,
      llmConfig,
      localControl,
      createPythonTask,
      uploadAttachment,
      fetchArtifactBlob,
      clearAttachments,
      loadConsumerSession,
      persistConsumerTurns,
      generateConversationTitle,
    ],
  );

  useEffect(() => {
    readDatabasePairingLink();
  }, []);

  useEffect(() => {
    workflowsRef.current = workflows;
  }, [workflows]);

  useEffect(() => {
    consumerWorkflowIdRef.current = consumerWorkflowId;
  }, [consumerWorkflowId]);

  useEffect(() => {
    runActionRef.current = startRun;
  }, [startRun]);

  useEffect(() => {
    chatActionRef.current = sendChatMessage;
  }, [sendChatMessage]);

  const resetConsumerSession = useCallback(() => {
    consumerLoadSequenceRef.current += 1;
    sessionIdRef.current = null;
    consumerSessionIdRef.current = null;
    setConsumerSessionId(null);
    setChat([]);
    setConsumerPythonRuns([]);
    setChatProgress(null);
    setActiveRun(null);
    setVisibleLogs([]);
    setCurrentStepId(null);
  }, []);

  const selectConsumerWorkflow = useCallback(
    (id: string) => {
      if (consumerWorkflowIdRef.current === id) return;
      consumerWorkflowIdRef.current = id;
      setConsumerWorkflowId(id);
      resetConsumerSession();
    },
    [resetConsumerSession],
  );

  useEffect(() => {
    selectConsumerWorkflowRef.current = selectConsumerWorkflow;
  }, [selectConsumerWorkflow]);

  useEffect(() => {
    const node = chatListRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [chat, chatProgress]);

  /**
   * 关闭内封设置页：先关掉原生模态，浏览器会把焦点还给触发按钮，
   * 再由 onClose 同步回 React 状态；没有模态可关时直接落状态。
   */
  const closeSettings = useCallback(() => {
    const dialog = settingsDialogRef.current;
    if (dialog?.open) {
      dialog.close();
      return;
    }
    setSettingsOpen(false);
  }, []);

  useEffect(() => {
    const dialog = settingsDialogRef.current;
    if (!settingsOpen || !dialog) return;
    if (!dialog.open) dialog.showModal();
    // 点在这张纸页之外（原生遮罩）就合上它；纸页自身的边距不算外面。
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      const insidePaper =
        event.clientX >= bounds.left &&
        event.clientX <= bounds.right &&
        event.clientY >= bounds.top &&
        event.clientY <= bounds.bottom;
      if (!insidePaper) closeSettings();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, [closeSettings, settingsOpen]);

  useEffect(() => {
    if (!composerMenuOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setComposerMenuOpen(false);
      composerPlusRef.current?.focus();
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (composerMenuRef.current?.contains(target)) return;
      if (composerPlusRef.current?.contains(target)) return;
      setComposerMenuOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [composerMenuOpen]);

  useEffect(() => {
    const context = document.modelContext;
    if (!context?.registerTool) return;

    const lifecycle = new AbortController();
    const reportRegistrationError = (cause: unknown) => {
      console.error('WebMCP tool registration failed', cause);
    };

    try {
      void Promise.resolve(
        context.registerTool(
          {
            name: 'read_workflow_state',
            title: '读取工作流状态',
            description:
              '读取当前所有工作流的草稿、发布版本和最近运行数量，不修改任何数据。',
            inputSchema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: true,
              untrustedContentHint: false,
            },
            async execute() {
              const response = await fetch('/api/state', { cache: 'no-store' });
              if (!response.ok) throw new Error('无法读取工作流状态。');
              const state = (await response.json()) as StateResponse;
              setWorkflows(state.workflows);
              workflowsRef.current = state.workflows;
              setRuns(state.runs);
              return {
                workflows: state.workflows.map((item) => ({
                  id: item.id,
                  name: item.name,
                  version: item.version,
                  published: Boolean(item.publishedSteps),
                  hasUnpublishedChanges: item.hasUnpublishedChanges,
                })),
                recentRunCount: state.runs.length,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(reportRegistrationError);

      void Promise.resolve(
        context.registerTool(
          {
            name: 'run_published_workflow',
            title: '运行已发布工作流',
            description:
              '在使用工作流端运行指定的已发布工作流，并在界面中显示执行步骤、日志和结果。',
            inputSchema: {
              type: 'object',
              properties: {
                workflowId: {
                  type: 'string',
                  description: '由 read_workflow_state 返回的工作流编号。',
                },
              },
              required: ['workflowId'],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: false,
              untrustedContentHint: false,
            },
            async execute(input) {
              if (
                !input ||
                typeof input !== 'object' ||
                typeof (input as { workflowId?: unknown }).workflowId !==
                  'string'
              ) {
                throw new Error('workflowId 必须是字符串。');
              }
              const workflowId = (input as { workflowId: string }).workflowId;
              const target = workflowsRef.current.find(
                (item) => item.id === workflowId,
              );
              if (!target) {
                throw new Error('找不到这个工作流，请先读取最新状态。');
              }
              if (!target.publishedSteps) {
                throw new Error('该工作流尚未发布。');
              }
              setPortal('consumer');
              selectConsumerWorkflowRef.current(workflowId);
              const run = await runActionRef.current(workflowId);
              if (!run) throw new Error('工作流未能启动。');
              return {
                runId: run.id,
                status: run.status,
                workflowVersion: run.workflowVersion,
                processedSteps: run.output.processed,
                result: run.output.result,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(reportRegistrationError);

      void Promise.resolve(
        context.registerTool(
          {
            name: 'chat_with_agent',
            title: '与 Agent 对话',
            description:
              '向使用工作流端的 Agent 发送一条消息，Agent 按指定（或当前装载）的已发布工作流逐步处理并回复，界面会切换到使用端展示对话。',
            inputSchema: {
              type: 'object',
              properties: {
                message: {
                  type: 'string',
                  description: '要发送给 Agent 的消息内容。',
                },
                workflowId: {
                  type: 'string',
                  description:
                    '可选：指定已发布工作流的编号；缺省使用当前装载的工作流。',
                },
              },
              required: ['message'],
              additionalProperties: false,
            },
            annotations: {
              readOnlyHint: false,
              untrustedContentHint: false,
            },
            async execute(input) {
              if (
                !input ||
                typeof input !== 'object' ||
                typeof (input as { message?: unknown }).message !== 'string'
              ) {
                throw new Error('message 必须是字符串。');
              }
              const body = input as { message: string; workflowId?: unknown };
              const workflowId =
                typeof body.workflowId === 'string' && body.workflowId
                  ? body.workflowId
                  : consumerWorkflowIdRef.current;
              if (!workflowId) {
                throw new Error('当前没有已发布的工作流可以对话。');
              }
              const target = workflowsRef.current.find(
                (item) => item.id === workflowId,
              );
              if (!target?.publishedSteps) {
                throw new Error('该工作流不存在或尚未发布。');
              }
              setPortal('consumer');
              selectConsumerWorkflowRef.current(workflowId);
              const run = await chatActionRef.current(body.message, workflowId);
              if (!run && !lastReplyRunIdRef.current) {
                throw new Error('Agent 未能回应。');
              }
              return {
                runId: run?.id ?? lastReplyRunIdRef.current,
                workflowVersion: run?.workflowVersion ?? target.version,
                intent: run?.output.summary,
                reply: lastReplyRef.current,
              };
            },
          },
          { signal: lifecycle.signal },
        ),
      ).catch(reportRegistrationError);
    } catch (cause) {
      reportRegistrationError(cause);
    }

    return () => lifecycle.abort();
  }, []);

  const visibleChat = chat;
  const consumerShellRuns = useMemo(
    () =>
      chat
        .flatMap((turn) => turn.shell?.runs ?? [])
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
    [chat],
  );

  const latestRun =
    activeRun ??
    runs.find((run) => run.workflowId === consumerWorkflowId) ??
    null;
  const logs = running ? visibleLogs : (latestRun?.logs ?? []);
  const runMatchesVersion =
    latestRun?.workflowVersion === (consumerWorkflow?.version ?? -1);
  const serviceLabel =
    loadState === 'loading'
      ? '正在连接'
      : loadState === 'error'
        ? '连接异常'
        : '服务已联通';

  const currentStepIndex = useMemo(
    () => publishedSteps?.findIndex((step) => step.id === currentStepId) ?? -1,
    [currentStepId, publishedSteps],
  );

  const stepState = (step: WorkflowStep, index: number) => {
    if (running && runMatchesVersion) {
      if (step.id === currentStepId) return 'running';
      if (currentStepIndex > index) return 'completed';
      return 'queued';
    }
    if (runMatchesVersion && latestRun?.status === 'completed')
      return 'completed';
    return 'queued';
  };

  const copyApiAddress = async () => {
    const address = `${window.location.origin}/api/v1/run`;
    try {
      // 剪贴板 API 同样要求安全上下文：HTTP + 公网 IP 部署下它是 undefined。
      // 这里不去动用已废弃的 execCommand，而是如实把地址显示出来让用户手动复制。
      if (!navigator.clipboard?.writeText) {
        setError(`当前环境不支持自动复制，请手动复制接口地址：${address}`);
        return;
      }
      await navigator.clipboard.writeText(address);
      setApiCopied(true);
      setTimeout(() => setApiCopied(false), 1600);
    } catch {
      setError(`接口地址：${address}`);
    }
  };

  function returnToGateway() {
    if (embedded || initialPortal === 'consumer') {
      window.location.assign('/');
    } else {
      setPortal('gateway');
    }
  }

  const WorkspaceRegion = embedded ? 'section' : 'main';
  const ConsumerHeading = embedded ? 'h2' : 'h1';

  return (
    <div className={`urtoris-shell${embedded ? ' is-embedded' : ''}`}>
      {portal === 'consumer' ? null : (
        <header className="urtoris-header">
          <button
            type="button"
            className="brand-lockup brand-button"
            aria-label="返回端口选择"
            onClick={returnToGateway}
          >
            <span className="brand-mark" aria-hidden="true">
              <WorkflowIcon />
            </span>
            <span>Urtoris</span>
          </button>

          <p className="header-title">
            {portal === 'gateway'
              ? '工作台入口'
              : portal === 'creator'
                ? '创建工作流端'
                : '询问 AI 智能体'}
          </p>

          <div
            className="connection-state"
            aria-label={`连接状态：${serviceLabel}`}
          >
            <Wifi aria-hidden="true" />
            <span>{serviceLabel}</span>
            <span
              className={`connection-dot connection-dot-${loadState}`}
              aria-hidden="true"
            />
          </div>
        </header>
      )}

      {portal === 'gateway' ? (
        <main className="portal-gateway">
          <section className="gateway-frame" aria-labelledby="gateway-title">
            <div className="gateway-intro">
              <div>
                <span className="gateway-brand-mark" aria-hidden="true">
                  <WorkflowIcon />
                </span>
                <h1 id="gateway-title" ref={gatewayTitleRef} tabIndex={-1}>
                  选择你要进入的工作端
                </h1>
                <p>
                  创建并发布工作流，或向 AI 智能体提问。
                  课程知识与工作流对话，都在同一张工作台。
                </p>
              </div>
              <div className="gateway-connection">
                <span className="connection-dot" aria-hidden="true" />
                工作流的创建与使用共享已发布版本
              </div>
            </div>

            <div className="portal-choice-list" aria-label="选择工作端">
              <Link
                href="/studio"
                prefetch={false}
                className="portal-choice portal-choice-creator"
                onClick={(event) => {
                  // vinext's client router currently throws while resolving this
                  // route in production. A document navigation keeps the entry
                  // usable while still preserving an ordinary link fallback.
                  event.preventDefault();
                  window.location.assign('/studio');
                }}
              >
                <span className="portal-choice-icon" aria-hidden="true">
                  <WorkflowIcon />
                </span>
                <span className="portal-choice-copy">
                  <strong>创建工作流端</strong>
                  <span>设计步骤、保存草稿，并发布可供调用的版本。</span>
                  <small>
                    {loadState === 'loading'
                      ? '正在读取工作流'
                      : loadState === 'error'
                        ? '暂时无法读取工作流'
                        : workflows.length
                          ? `${workflows.length} 个工作流 · ${publishedWorkflows.length} 个已发布`
                          : '还没有工作流，进入创建端开始'}
                  </small>
                </span>
                <span className="portal-choice-action">
                  进入创建端 <ArrowRight aria-hidden="true" />
                </span>
              </Link>

              <Link
                href="/ai"
                prefetch={false}
                className="portal-choice portal-choice-consumer"
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  window.location.assign('/ai');
                }}
              >
                <span className="portal-choice-icon" aria-hidden="true">
                  <Bot />
                </span>
                <span className="portal-choice-copy">
                  <strong>询问 AI 智能体</strong>
                  <span>
                    查阅课程知识并核对原文，或装载工作流与 Agent 对话。
                  </span>
                  <small>课程知识与工作流，随时切换</small>
                </span>
                <span className="portal-choice-action">
                  开始提问 <ArrowRight aria-hidden="true" />
                </span>
              </Link>
            </div>
          </section>
          {loadState === 'error' ? (
            <div className="gateway-error" role="alert">
              <span>暂时无法连接工作流服务。</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void refreshState(runPage)}
              >
                重试连接
              </Button>
            </div>
          ) : (
            <p className="gateway-footnote">
              当前为功能原型，暂不需要账号密码。
            </p>
          )}
        </main>
      ) : (
        <WorkspaceRegion
          id="workspace"
          className={
            portal === 'consumer'
              ? 'urtoris-workspace consumer-workspace'
              : 'urtoris-workspace'
          }
        >
          {portal === 'consumer' ? null : (
            <nav className="portal-toolbar" aria-label="当前工作端">
              <Button
                type="button"
                variant="ghost"
                className="back-to-gateway"
                onClick={returnToGateway}
              >
                <ChevronLeft data-icon="inline-start" />
                切换工作端
              </Button>
              <div className="portal-current">
                {portal === 'creator' ? <WorkflowIcon /> : <Bot />}
                <span>
                  <small>当前身份</small>
                  <strong>
                    {portal === 'creator' ? '工作流创建者' : '工作流使用者'}
                  </strong>
                </span>
              </div>
            </nav>
          )}

          {error ? (
            <div className="error-banner" role="alert">
              <span>{error}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setError(null)}
              >
                知道了
              </Button>
            </div>
          ) : null}

          <div className={`workflow-map workflow-map-${portal}`}>
            {portal === 'creator' ? (
              <section
                className="workbench-panel creator-panel"
                aria-labelledby="creator-title"
              >
                <header className="panel-heading">
                  <div>
                    <h1 id="creator-title" ref={creatorTitleRef} tabIndex={-1}>
                      创建工作流端
                    </h1>
                    <p>编排步骤，形成可被使用端装载并调用的版本。</p>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      workflow.hasUnpublishedChanges
                        ? 'state-stamp state-stamp-draft'
                        : 'state-stamp state-stamp-ready'
                    }
                  >
                    {workflow.hasUnpublishedChanges
                      ? '有未发布更改'
                      : `已发布 v${workflow.version}`}
                  </Badge>
                </header>

                <div className="workflow-switcher">
                  <label htmlFor="creator-workflow-select">当前工作流</label>
                  <NativeSelect
                    id="creator-workflow-select"
                    className="workflow-select"
                    size="sm"
                    value={workflow.id}
                    onChange={(event) =>
                      setCreatorWorkflowId(event.target.value)
                    }
                  >
                    {editableWorkflows.map((item) => (
                      <NativeSelectOption value={item.id} key={item.id}>
                        {item.name.trim() || '未命名工作流'}
                        {item.publishedSteps ? ` · v${item.version}` : ''}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="new-workflow-button"
                    onClick={() => void createNewWorkflow()}
                  >
                    <CirclePlus data-icon="inline-start" />
                    新建
                  </Button>
                </div>

                <div className="manifest-fields">
                  <label htmlFor="workflow-name">工作流名称</label>
                  <Input
                    id="workflow-name"
                    className="manifest-name-input"
                    value={workflow.name}
                    onChange={(event) =>
                      markChanged({ name: event.target.value })
                    }
                    maxLength={80}
                  />
                  <label htmlFor="workflow-description">用途说明</label>
                  <Textarea
                    id="workflow-description"
                    className="manifest-description-input"
                    value={workflow.description}
                    onChange={(event) =>
                      markChanged({ description: event.target.value })
                    }
                    maxLength={240}
                    rows={2}
                  />
                  <label htmlFor="workflow-n8n-url">n8n webhook</label>
                  <Input
                    id="workflow-n8n-url"
                    className="manifest-name-input engine-input"
                    value={workflow.n8nWebhookUrl ?? ''}
                    onChange={(event) =>
                      markChanged({
                        n8nWebhookUrl: event.target.value || null,
                      })
                    }
                    placeholder="http://127.0.0.1:5678/webhook/xxxx"
                    spellCheck={false}
                  />
                  <p className="field-note">
                    填入后，这个工作流在使用端的「运行」和「对话」会真的 POST
                    到这个 n8n webhook，并把 n8n
                    的返回写进运行记录；留空则退回内置模拟执行器。
                  </p>
                  <p className="field-note">
                    Webhook 鉴权统一由服务端的 N8N_WEBHOOK_TOKEN 提供，
                    不在浏览器或工作流数据中保存令牌。
                  </p>
                  <label htmlFor="workflow-admin-token">
                    管理员令牌（仅保存在当前浏览器会话）
                  </label>
                  <Input
                    id="workflow-admin-token"
                    className="manifest-name-input engine-input"
                    type="password"
                    value={adminToken}
                    onChange={(event) => setAdminToken(event.target.value)}
                    placeholder={
                      adminTrusted
                        ? '本机/内网访问，可留空'
                        : '输入 URTORIS_ADMIN_TOKEN'
                    }
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <p className="field-note">
                    {adminTrusted
                      ? '当前是本机/内网访问，服务端已把这次会话当管理员，保存与发布都不用填令牌。'
                      : '公网部署下保存草稿、发布版本需要这个令牌。'}
                  </p>
                </div>

                <div className="step-list-heading">
                  <h2>执行顺序</h2>
                  <span>{workflow.draftSteps.length} 个步骤</span>
                </div>

                <div className="step-list" aria-label="工作流步骤">
                  {workflow.draftSteps.map((step, index) => (
                    <article className="step-ticket" key={step.id}>
                      <span
                        className="step-number"
                        aria-label={`第 ${index + 1} 步`}
                      >
                        {String(index + 1).padStart(2, '0')}
                      </span>

                      <div className="step-ticket-body">
                        <label className="sr-only" htmlFor={`${step.id}-title`}>
                          第 {index + 1} 步名称
                        </label>
                        <Input
                          id={`${step.id}-title`}
                          className="step-title-input"
                          value={step.title}
                          onChange={(event) =>
                            updateStep(step.id, { title: event.target.value })
                          }
                          maxLength={80}
                        />
                        <div className="step-ticket-meta">
                          <label
                            className="sr-only"
                            htmlFor={`${step.id}-kind`}
                          >
                            第 {index + 1} 步类型
                          </label>
                          <NativeSelect
                            id={`${step.id}-kind`}
                            className="step-kind-select"
                            size="sm"
                            value={step.kind}
                            onChange={(event) =>
                              updateStep(step.id, {
                                kind: event.target.value as StepKind,
                              })
                            }
                          >
                            {Object.entries(kindLabels).map(([kind, label]) => (
                              <NativeSelectOption value={kind} key={kind}>
                                {label}
                              </NativeSelectOption>
                            ))}
                          </NativeSelect>
                          <label
                            className="sr-only"
                            htmlFor={`${step.id}-detail`}
                          >
                            第 {index + 1} 步说明
                          </label>
                          <Input
                            id={`${step.id}-detail`}
                            className="step-detail-input"
                            value={step.detail}
                            onChange={(event) =>
                              updateStep(step.id, {
                                detail: event.target.value,
                              })
                            }
                            maxLength={180}
                          />
                        </div>
                      </div>

                      <div
                        className="step-actions"
                        aria-label={`调整第 ${index + 1} 步`}
                      >
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="上移"
                          title="上移"
                          disabled={index === 0}
                          onClick={() => moveStep(index, -1)}
                        >
                          <ArrowUp />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label="下移"
                          title="下移"
                          disabled={index === workflow.draftSteps.length - 1}
                          onClick={() => moveStep(index, 1)}
                        >
                          <ArrowDown />
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="delete-step"
                          aria-label="删除步骤"
                          title="删除步骤"
                          onClick={() => removeStep(step.id)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </article>
                  ))}
                </div>

                <Button
                  type="button"
                  variant="ghost"
                  className="add-step-button"
                  onClick={addStep}
                >
                  <CirclePlus data-icon="inline-start" />
                  添加步骤
                </Button>

                <footer className="creator-actions">
                  <Button
                    type="button"
                    variant="outline"
                    className="secondary-action"
                    disabled={saveState === 'saving'}
                    onClick={() => void persistWorkflow('save')}
                  >
                    {saveState === 'saving' ? (
                      <Loader2 className="spin" data-icon="inline-start" />
                    ) : saveState === 'saved' ? (
                      <Check data-icon="inline-start" />
                    ) : (
                      <Save data-icon="inline-start" />
                    )}
                    {saveState === 'saving'
                      ? '正在保存'
                      : saveState === 'saved'
                        ? '已保存'
                        : '保存草稿'}
                  </Button>
                  <Button
                    type="button"
                    className="publish-action"
                    disabled={saveState === 'saving'}
                    onClick={() => void persistWorkflow('publish')}
                  >
                    <Send data-icon="inline-start" />
                    发布到使用端
                  </Button>
                </footer>
              </section>
            ) : (
              <section
                className={`ledger-shell${
                  consumerSidebarCollapsed ? ' is-sidebar-collapsed' : ''
                }`}
                aria-labelledby="consumer-title"
              >
                {/*
                  THESIS: Urtoris 是一张安静的对话工作台；拒绝工作流仪表盘把
                  状态、说明和执行日志同时推到用户眼前的默认布局。
                  OWN-WORLD: 炭黑画布、石墨侧栏与柔和蓝色行动点；导航、消息、
                  输入和设置共享低对比度分层与 1px 冷灰边界。
                  STORY: 新建或打开一段对话 → 直接提出要求 → Agent 回复；标题、
                  持久化和执行证据在后台完成，需要时才展开。
                  FIRST VIEWPORT: 280px 会话侧栏固定在左，当前对话占满其余画布；
                  空会话只显示一个短问题和居中的宽输入框，主操作在输入框右下角。
                  FORM: 用户指定的深色 AI 对话工作台；seed 31fd6896，brief-pinned。
                  FINISH: unreviewed and undocumented is unfinished; this build
                  ends with the finish review, the verdict, and DESIGN.md.
                */}
                <aside className="ledger-index">
                  <div className="ledger-spine">
                    {embedded ? (
                      <strong className="consumer-sidebar-title">
                        工作流对话
                      </strong>
                    ) : (
                      <button
                        type="button"
                        className="consumer-brand"
                        onClick={returnToGateway}
                        aria-label="返回工作端选择"
                      >
                        <span
                          className="consumer-brand-mark"
                          aria-hidden="true"
                        >
                          <Bot />
                        </span>
                        <strong>Urtoris</strong>
                      </button>
                    )}
                    <button
                      type="button"
                      className="sidebar-collapse"
                      aria-label={
                        consumerSidebarCollapsed ? '展开侧栏' : '收起侧栏'
                      }
                      aria-expanded={!consumerSidebarCollapsed}
                      onClick={() =>
                        setConsumerSidebarCollapsed((current) => !current)
                      }
                    >
                      <Menu aria-hidden="true" />
                    </button>
                  </div>
                  <nav className="consumer-shortcuts" aria-label="使用端导航">
                    <button
                      type="button"
                      className="consumer-shortcut is-primary"
                      disabled={!publishedWorkflows.length || chatBusy}
                      onClick={() => void createConversation()}
                    >
                      <MessageSquarePlus aria-hidden="true" />
                      新对话
                    </button>
                    <button
                      type="button"
                      className="consumer-shortcut"
                      onClick={() =>
                        window.location.assign('/studio?panel=workflows')
                      }
                    >
                      <WorkflowIcon aria-hidden="true" />
                      工作流
                    </button>
                    {embedded ? null : (
                      <Link
                        href="/ai"
                        prefetch={false}
                        className="consumer-shortcut"
                        onClick={(event) => {
                          event.preventDefault();
                          window.location.assign('/ai');
                        }}
                      >
                        <Bot aria-hidden="true" />
                        询问 AI 智能体
                      </Link>
                    )}
                  </nav>
                  <div className="ledger-index-body">
                    <section
                      className="index-section"
                      aria-labelledby="index-chat-title"
                    >
                      <header className="index-section-head">
                        <h2 id="index-chat-title">聊天记录</h2>
                      </header>
                      {conversations.length ? (
                        <ul className="ledger-list ledger-list-chat">
                          {conversations.map((conversation) => (
                            <li key={conversation.id}>
                              <button
                                type="button"
                                className={
                                  conversation.id === consumerSessionId
                                    ? 'is-active'
                                    : ''
                                }
                                disabled={chatBusy}
                                onClick={() => openConversation(conversation)}
                              >
                                <span className="ledger-list-name">
                                  {conversation.title}
                                </span>
                                <time className="index-entry-meta">
                                  {formatConversationAge(
                                    conversation.updatedAt,
                                  )}
                                </time>
                              </button>
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="ledger-empty">还没有聊天记录</p>
                      )}
                    </section>
                  </div>
                  <footer className="ledger-index-foot">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setSettingsOpen(true);
                        // 设置页里模型字段默认展开，不用再点一次标题。
                        setLlmPanelOpen(true);
                      }}
                    >
                      <KeyRound data-icon="inline-start" />
                      设置
                    </Button>
                    {embedded ? null : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={returnToGateway}
                      >
                        <ChevronLeft data-icon="inline-start" />
                        切换工作端
                      </Button>
                    )}
                  </footer>
                </aside>

                <div className="ledger-main">
                  <header className="ledger-head">
                    <div className="conversation-heading">
                      <ConsumerHeading
                        id="consumer-title"
                        ref={consumerTitleRef}
                        tabIndex={-1}
                      >
                        {activeConversation?.title ?? '新对话'}
                      </ConsumerHeading>
                      <span>{consumerWorkflow?.name ?? '未选择工作流'}</span>
                    </div>
                    <div className="consumer-head-actions">
                      <span className="consumer-runtime">
                        <span className="connection-dot" aria-hidden="true" />
                        {chatBusy
                          ? '处理中'
                          : consumerSessionLoading
                            ? '载入中'
                            : loadedUsesN8n
                              ? 'n8n'
                              : llmConfigured
                                ? selectedLlmProvider?.label
                                : '模拟'}
                      </span>
                      <button
                        type="button"
                        className="consumer-head-button"
                        aria-label={
                          runPanelOpen ? '收起执行详情' : '展开执行详情'
                        }
                        aria-expanded={runPanelOpen}
                        title={runPanelOpen ? '收起执行详情' : '执行详情'}
                        onClick={toggleRunPanel}
                      >
                        {runPanelOpen ? (
                          <PanelRightClose aria-hidden="true" />
                        ) : (
                          <PanelRightOpen aria-hidden="true" />
                        )}
                      </button>
                      <button
                        type="button"
                        className="consumer-head-button"
                        aria-label="打开设置"
                        title="设置"
                        onClick={() => {
                          setSettingsOpen(true);
                          setLlmPanelOpen(true);
                        }}
                      >
                        <KeyRound aria-hidden="true" />
                      </button>
                    </div>
                  </header>

                  <div
                    className={`ledger-spread${
                      runPanelOpen ? '' : ' is-run-collapsed'
                    }`}
                  >
                    <div className="ledger-page ledger-page-log">
                      {settingsOpen ? (
                        <dialog
                          ref={settingsDialogRef}
                          className="ledger-sheet"
                          aria-label="设置：大模型与本机控制"
                          onClose={() => setSettingsOpen(false)}
                        >
                          <button
                            type="button"
                            className="ledger-sheet-close"
                            aria-label="关闭设置"
                            onClick={closeSettings}
                          >
                            <X aria-hidden="true" />
                          </button>
                          <section
                            className="llm-panel"
                            aria-label="Agent 模型设置"
                          >
                            <button
                              type="button"
                              className="llm-panel-head"
                              aria-expanded={llmPanelOpen}
                              onClick={() =>
                                setLlmPanelOpen((current) => !current)
                              }
                            >
                              <div>
                                <h3>
                                  <KeyRound aria-hidden="true" />
                                  Agent 模型
                                  {llmConfigured ? (
                                    <span className="llm-state llm-state-on">
                                      {llmRuntimeLabel}已启用
                                    </span>
                                  ) : loadedUsesN8n ? (
                                    <span className="llm-state llm-state-on">
                                      已接入 n8n 引擎
                                    </span>
                                  ) : (
                                    <span className="llm-state llm-state-off">
                                      当前为模拟回复
                                    </span>
                                  )}
                                </h3>
                                <p>
                                  配置服务与 API
                                  Key；模型和推理强度在发送键旁选择。
                                </p>
                              </div>
                              {llmPanelOpen ? (
                                <ArrowUp aria-hidden="true" />
                              ) : (
                                <ArrowDown aria-hidden="true" />
                              )}
                            </button>

                            {llmPanelOpen ? (
                              <div className="llm-panel-body">
                                <div className="llm-field">
                                  <label htmlFor="llm-provider">模型服务</label>
                                  <NativeSelect
                                    id="llm-provider"
                                    className="workflow-select"
                                    size="sm"
                                    value={llmConfig.provider}
                                    onChange={(event) => {
                                      setDiscoveredModels([]);
                                      setModelDiscovery({
                                        status: 'idle',
                                        message: '',
                                      });
                                      const next = providerDefaults(
                                        event.target.value,
                                      );
                                      if (!next) return;
                                      setLlmConfig((current) => ({
                                        ...current,
                                        provider: next.id,
                                        baseUrl: next.baseUrl,
                                        model: next.model,
                                        reasoningEffort: 'auto',
                                      }));
                                    }}
                                  >
                                    {providerOptions().map((option) => (
                                      <NativeSelectOption
                                        key={option.id}
                                        value={option.id}
                                      >
                                        {option.vendor} · {option.label}
                                      </NativeSelectOption>
                                    ))}
                                  </NativeSelect>
                                </div>
                                <div className="llm-field">
                                  <label htmlFor="llm-api-key">API Key</label>
                                  <Input
                                    id="llm-api-key"
                                    type="password"
                                    value={llmConfig.apiKey}
                                    onChange={(event) => {
                                      setDiscoveredModels([]);
                                      setModelDiscovery({
                                        status: 'idle',
                                        message: '',
                                      });
                                      setLlmConfig((current) => ({
                                        ...current,
                                        apiKey: event.target.value,
                                      }));
                                    }}
                                    placeholder={
                                      providerOptions().find(
                                        (option) =>
                                          option.id === llmConfig.provider,
                                      )?.keyHint ?? 'sk-...'
                                    }
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </div>
                                <div className="llm-field">
                                  <label htmlFor="llm-base-url">Base URL</label>
                                  <Input
                                    id="llm-base-url"
                                    value={llmConfig.baseUrl}
                                    placeholder={
                                      providerOptions().find(
                                        (option) =>
                                          option.id === llmConfig.provider,
                                      )?.defaultBaseUrl || 'https://你的网关/v1'
                                    }
                                    onChange={(event) => {
                                      setDiscoveredModels([]);
                                      setModelDiscovery({
                                        status: 'idle',
                                        message: '',
                                      });
                                      setLlmConfig((current) => ({
                                        ...current,
                                        baseUrl: event.target.value,
                                      }));
                                    }}
                                    spellCheck={false}
                                  />
                                </div>
                                <div className="llm-field">
                                  <div className="llm-field-head">
                                    <label htmlFor="llm-model">模型</label>
                                    <Button
                                      type="button"
                                      size="sm"
                                      variant="ghost"
                                      className="llm-discover-button"
                                      onClick={() => void discoverLlmModels()}
                                      disabled={
                                        modelDiscovery.status === 'loading' ||
                                        Boolean(
                                          selectedLlmProvider?.keyRequired &&
                                          !llmConfig.apiKey.trim(),
                                        ) ||
                                        !llmConfig.baseUrl.trim()
                                      }
                                    >
                                      <RefreshCw
                                        aria-hidden="true"
                                        className={
                                          modelDiscovery.status === 'loading'
                                            ? 'is-spinning'
                                            : undefined
                                        }
                                      />
                                      {modelDiscovery.status === 'loading'
                                        ? '读取中'
                                        : '识别 API 模型'}
                                    </Button>
                                  </div>
                                  <Input
                                    id="llm-model"
                                    list="llm-model-list"
                                    value={llmConfig.model}
                                    placeholder={
                                      providerOptions().find(
                                        (option) =>
                                          option.id === llmConfig.provider,
                                      )?.defaultModel || '例如 gpt-4o-mini'
                                    }
                                    onChange={(event) =>
                                      setLlmConfig((current) => ({
                                        ...current,
                                        model: event.target.value,
                                      }))
                                    }
                                    spellCheck={false}
                                  />
                                  <datalist id="llm-model-list">
                                    {selectableModels.map((model) => (
                                      <option key={model} value={model}>
                                        {model}
                                      </option>
                                    ))}
                                  </datalist>
                                  {modelDiscovery.message ? (
                                    <output
                                      className={`llm-model-status is-${modelDiscovery.status}`}
                                      aria-live="polite"
                                    >
                                      {modelDiscovery.message}
                                    </output>
                                  ) : null}
                                </div>
                                <div className="llm-field">
                                  <label htmlFor="llm-reasoning-effort">
                                    推理强度
                                  </label>
                                  <NativeSelect
                                    id="llm-reasoning-effort"
                                    className="workflow-select"
                                    size="sm"
                                    value={
                                      selectedLlmProvider?.reasoningMode ===
                                      'model-only'
                                        ? 'auto'
                                        : llmConfig.reasoningEffort
                                    }
                                    disabled={
                                      selectedLlmProvider?.reasoningMode ===
                                      'model-only'
                                    }
                                    onChange={(event) => {
                                      const value = event.target.value;
                                      if (!isLlmReasoningEffort(value)) return;
                                      setLlmConfig((current) => ({
                                        ...current,
                                        reasoningEffort: value,
                                      }));
                                    }}
                                  >
                                    <NativeSelectOption value="auto">
                                      自动（API 默认）
                                    </NativeSelectOption>
                                    <NativeSelectOption value="low">
                                      低 · 更快
                                    </NativeSelectOption>
                                    <NativeSelectOption value="medium">
                                      中 · 均衡
                                    </NativeSelectOption>
                                    <NativeSelectOption value="high">
                                      高 · 更深入
                                    </NativeSelectOption>
                                  </NativeSelect>
                                  <span className="llm-field-hint">
                                    {selectedLlmProvider?.reasoningNote ??
                                      '仅在该 API 支持时生效。'}
                                  </span>
                                </div>
                                <p className="llm-note">
                                  填好 Key 后会自动识别一次，也可手动刷新。Key
                                  只保存在这个浏览器里，不写入服务端。
                                </p>
                                <div className="llm-actions">
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      setLlmConfig((current) => ({
                                        ...current,
                                        apiKey: '',
                                      }))
                                    }
                                  >
                                    清除 Key
                                  </Button>
                                  <Button
                                    type="button"
                                    size="sm"
                                    variant="ghost"
                                    onClick={() =>
                                      setLlmConfig((current) => ({
                                        ...current,
                                        ...(providerDefaults(
                                          current.provider,
                                        ) ?? {
                                          baseUrl: defaultLlmConfig.baseUrl,
                                          model: defaultLlmConfig.model,
                                        }),
                                        reasoningEffort: 'auto',
                                      }))
                                    }
                                  >
                                    恢复该服务默认值
                                  </Button>
                                </div>
                              </div>
                            ) : null}
                          </section>
                          <p className="ledger-sheet-note">
                            Key
                            只保存在这台浏览器里，随请求用完即弃，不写入服务端或代码库。
                          </p>
                          <section
                            className="consumer-local-database"
                            aria-labelledby="consumer-database-title"
                          >
                            <h2 id="consumer-database-title">本机数据库</h2>
                            <LocalDatabaseConnector />
                          </section>
                          {localControl.visibility !== 'hidden' ? (
                            <section
                              className={`local-control-panel${
                                localControl.available ? ' is-connected' : ''
                              }`}
                              aria-labelledby="local-control-title"
                            >
                              <header className="local-control-head">
                                <div>
                                  <h2 id="local-control-title">
                                    <ShieldAlert aria-hidden="true" />
                                    本机控制
                                    <span
                                      className={`local-control-state${
                                        localControl.available ? ' is-on' : ''
                                      }`}
                                    >
                                      {localControl.available
                                        ? '本机全权限'
                                        : '未连接'}
                                    </span>
                                  </h2>
                                  <p>
                                    这是当前用户 Shell，不经过 Python
                                    沙箱；只在本机地址开放。
                                  </p>
                                </div>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void refreshLocalControl()}
                                >
                                  <RefreshCw data-icon="inline-start" />
                                  重新检查
                                </Button>
                              </header>
                              {localControl.available ? (
                                <>
                                  <dl className="local-control-facts">
                                    <div>
                                      <dt>身份</dt>
                                      <dd className="tabular">
                                        {localControl.info.username}
                                        {localControl.info.uid === null
                                          ? ''
                                          : ` · uid ${localControl.info.uid}`}
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>主机</dt>
                                      <dd>{localControl.info.hostname}</dd>
                                    </div>
                                    <div>
                                      <dt>Shell</dt>
                                      <dd>
                                        <code>{localControl.info.shell}</code>
                                      </dd>
                                    </div>
                                    <div>
                                      <dt>默认目录</dt>
                                      <dd>
                                        <code>
                                          {localControl.info.default_cwd}
                                        </code>
                                      </dd>
                                    </div>
                                  </dl>
                                  <p className="local-control-warning">
                                    Agent
                                    可读取和改写这个用户能访问的全部文件、调用已登录的
                                    CLI 与网络服务。它不会自动取得
                                    root；每条命令、理由、终态和输出大小都会写入本机审计。
                                  </p>
                                  <section
                                    className="local-store-panel"
                                    aria-labelledby="local-store-title"
                                  >
                                    <div className="local-store-head">
                                      <div>
                                        <h3 id="local-store-title">
                                          <HardDrive aria-hidden="true" />
                                          保存位置
                                        </h3>
                                        <p>
                                          聊天记录、运行记录和项目都写在这台 Mac
                                          上你选的文件夹里；线上站点不保存这些内容。
                                        </p>
                                      </div>
                                    </div>
                                    {storeStatus?.root ? (
                                      <dl className="local-control-facts">
                                        <div>
                                          <dt>当前位置</dt>
                                          <dd>
                                            <code>{storeStatus.root}</code>
                                          </dd>
                                        </div>
                                        <div>
                                          <dt>已存内容</dt>
                                          <dd className="tabular">
                                            对话{' '}
                                            {
                                              storeStatus.collections
                                                .conversations
                                            }{' '}
                                            · 项目{' '}
                                            {storeStatus.collections.projects} ·
                                            运行 {storeStatus.collections.runs}
                                          </dd>
                                        </div>
                                      </dl>
                                    ) : (
                                      <p className="local-store-empty">
                                        还没有选择保存位置。在你选之前，记录不会写进任何地方。
                                      </p>
                                    )}
                                    <div className="local-store-actions">
                                      <Button
                                        type="button"
                                        size="sm"
                                        variant="outline"
                                        disabled={storeBusy}
                                        onClick={() => void applyStore('pick')}
                                      >
                                        <FolderOpen data-icon="inline-start" />
                                        选择文件夹…
                                      </Button>
                                      <Input
                                        value={storePathDraft}
                                        onChange={(event) =>
                                          setStorePathDraft(event.target.value)
                                        }
                                        placeholder="/Users/你/Urtoris 记录"
                                        aria-label="保存位置的绝对路径"
                                      />
                                      <Button
                                        type="button"
                                        size="sm"
                                        disabled={
                                          storeBusy || !storePathDraft.trim()
                                        }
                                        onClick={() => void applyStore('path')}
                                      >
                                        保存这个位置
                                      </Button>
                                    </div>
                                    {storeError ? (
                                      <p
                                        className="local-store-error"
                                        role="alert"
                                      >
                                        {storeError}
                                      </p>
                                    ) : null}
                                  </section>
                                </>
                              ) : (
                                <div className="local-control-offline">
                                  <p>{localControl.message}</p>
                                  <code>npm run dev:control</code>
                                  <span>
                                    请在项目目录运行；它会同时启动本机网页和
                                    loopback Control
                                    Agent，关闭网页开发服务器时也会收回权限。
                                  </span>
                                </div>
                              )}
                            </section>
                          ) : null}
                          <section
                            className="api-access"
                            aria-labelledby="api-access-title"
                          >
                            <header>
                              <div>
                                <h2 id="api-access-title">API 接入</h2>
                                <p>外部程序可用密钥触发指定工作流。</p>
                              </div>
                              <span>POST</span>
                            </header>
                            <div className="api-endpoint">
                              <code>/api/v1/run</code>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                onClick={() => void copyApiAddress()}
                              >
                                {apiCopied ? (
                                  <Check data-icon="inline-start" />
                                ) : (
                                  <Copy data-icon="inline-start" />
                                )}
                                {apiCopied ? '已复制' : '复制地址'}
                              </Button>
                            </div>
                            <details className="api-example">
                              <summary>查看请求格式</summary>
                              <pre>{`Authorization: Bearer <API_TOKEN>
Content-Type: application/json

{"workflowId":"${consumerWorkflow?.id ?? '…'}","input":{}}`}</pre>
                            </details>
                          </section>
                        </dialog>
                      ) : null}

                      <section
                        className="agent-chat"
                        aria-labelledby="agent-chat-title"
                      >
                        <h2 id="agent-chat-title" className="sr-only">
                          当前对话
                        </h2>

                        <div
                          className="chat-stream"
                          ref={chatListRef}
                          aria-live="polite"
                        >
                          {visibleChat.length === 0 ? (
                            <div className="chat-empty-state">
                              <span
                                className="chat-empty-mark"
                                aria-hidden="true"
                              >
                                <Bot />
                              </span>
                              <h3>想从哪里开始？</h3>
                            </div>
                          ) : null}
                          {visibleChat.map((turn) => {
                            const pythonRun = consumerPythonRuns.find(
                              (run) =>
                                run.agentMessageId === turn.id &&
                                (run.status === 'queued' ||
                                  run.status === 'running'),
                            );
                            const shellRun = turn.shell?.runs.find(
                              (run) =>
                                run.status === 'queued' ||
                                run.status === 'running',
                            );
                            const activeToolRunId =
                              shellRun?.runId ?? pythonRun?.runId ?? null;
                            return (
                              <article
                                className={`chat-turn chat-turn-${turn.role}`}
                                key={turn.id}
                                id={`chat-turn-${turn.id}`}
                                tabIndex={-1}
                              >
                                <span
                                  className="chat-avatar"
                                  aria-hidden="true"
                                >
                                  {turn.role === 'agent' ? <Bot /> : '我'}
                                </span>
                                <div
                                  className={`chat-bubble${
                                    turn.failed ? ' chat-bubble-failed' : ''
                                  }`}
                                >
                                  {turn.role === 'agent' && turn.working ? (
                                    <div className="chat-working">
                                      <Loader2
                                        className="spin"
                                        aria-hidden="true"
                                      />
                                      <span>
                                        {shellRun
                                          ? `${shellRunStatusLabels[shellRun.status]} · 本机全权限 · 已用 ${shellElapsed(
                                              shellRun,
                                              elapsedNow,
                                            )}`
                                          : pythonRun
                                            ? `${pythonRunStatusLabels[pythonRun.status]} · ${pythonRun.profile === 'long' ? '长任务' : '短任务'} · 已用 ${formatElapsed(
                                                elapsedNow -
                                                  (pythonRun.startedAt ??
                                                    pythonRun.createdAt),
                                              )}`
                                            : chatProgress?.turnId === turn.id
                                              ? chatProgress.message
                                              : chatBusy
                                                ? '正在等待回复…'
                                                : '正在恢复回复…'}
                                        {!shellRun && !pythonRun ? (
                                          <span aria-hidden="true">
                                            {' '}
                                            · 已用{' '}
                                            {formatElapsed(
                                              elapsedNow - turn.at,
                                            )}
                                          </span>
                                        ) : null}
                                      </span>
                                      {!activeToolRunId &&
                                      elapsedNow - turn.at > 15_000 ? (
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          className="chat-cancel-run"
                                          onClick={() =>
                                            void loadConsumerSession(
                                              consumerWorkflowId!,
                                              { quiet: true },
                                            )
                                          }
                                        >
                                          刷新结果
                                        </Button>
                                      ) : null}
                                      {activeToolRunId ? (
                                        <Button
                                          type="button"
                                          size="sm"
                                          variant="outline"
                                          className="chat-cancel-run"
                                          disabled={
                                            cancelingRunId === activeToolRunId
                                          }
                                          onClick={() => {
                                            if (shellRun && turn.shell) {
                                              void cancelShellRun(
                                                turn.shell.taskId,
                                                shellRun,
                                              );
                                            } else if (pythonRun) {
                                              void cancelPythonRun(pythonRun);
                                            }
                                          }}
                                        >
                                          {cancelingRunId ===
                                          activeToolRunId ? (
                                            <Loader2
                                              className="spin"
                                              aria-hidden="true"
                                            />
                                          ) : (
                                            <X aria-hidden="true" />
                                          )}
                                          {cancelingRunId === activeToolRunId
                                            ? '正在取消'
                                            : '取消'}
                                        </Button>
                                      ) : null}
                                    </div>
                                  ) : (
                                    <>
                                      {turn.failed ? (
                                        <span className="chat-fail-stamp">
                                          未完成 · 如实记录
                                        </span>
                                      ) : null}
                                      {turn.attachments?.length ? (
                                        <div className="chat-attachments">
                                          {turn.attachments.map((file) => (
                                            <span
                                              className="chat-attachment"
                                              key={`${turn.id}-${file.name}-${file.size}`}
                                            >
                                              {file.previewUrl ? (
                                                // eslint-disable-next-line next/no-img-element -- 本地 object URL 缩略图，走不了 next/image 优化
                                                <img
                                                  className="chat-thumb"
                                                  src={file.previewUrl}
                                                  alt={file.name}
                                                />
                                              ) : (
                                                <Paperclip aria-hidden="true" />
                                              )}
                                              <span>
                                                {file.name}（
                                                {formatFileSize(file.size)}）
                                              </span>
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                      <p className="chat-text">{turn.text}</p>
                                      {turn.artifacts?.length ? (
                                        <div className="chat-artifacts">
                                          {turn.artifacts.map((artifact) => (
                                            <div
                                              className="chat-artifact"
                                              key={artifact.artifactId}
                                            >
                                              {artifact.previewUrl ? (
                                                // eslint-disable-next-line next/no-img-element -- 带鉴权取回的图片产物预览
                                                <img
                                                  className="chat-thumb chat-thumb-large"
                                                  src={artifact.previewUrl}
                                                  alt={artifact.name}
                                                />
                                              ) : null}
                                              <span>
                                                {artifact.name}（
                                                {formatFileSize(
                                                  artifact.sizeBytes,
                                                )}
                                                ）
                                              </span>
                                              {turn.python ? (
                                                <Button
                                                  type="button"
                                                  size="sm"
                                                  variant="outline"
                                                  className="chat-artifact-download"
                                                  onClick={() =>
                                                    void downloadArtifact(
                                                      turn.python!.taskId,
                                                      artifact,
                                                    )
                                                  }
                                                >
                                                  <Download
                                                    aria-hidden="true"
                                                    data-icon="inline-start"
                                                  />
                                                  下载
                                                </Button>
                                              ) : null}
                                            </div>
                                          ))}
                                        </div>
                                      ) : null}
                                      {turn.python ? (
                                        <span className="chat-meta chat-meta-python">
                                          Python · 尝试 {turn.python.attempts}{' '}
                                          次 ·{' '}
                                          {turn.python.succeeded
                                            ? '成功'
                                            : `未成功（${turn.python.stopReason}）`}
                                          {turn.python.guarded
                                            ? ' · 结论已按运行结果改写'
                                            : ''}
                                        </span>
                                      ) : null}
                                      {turn.shell ? (
                                        <div className="chat-shell-runs">
                                          <div className="chat-shell-heading">
                                            <span>
                                              <Terminal aria-hidden="true" />
                                              本机全权限 ·{' '}
                                              {turn.shell.runs.length} 条命令
                                            </span>
                                            <span
                                              className={
                                                turn.shell.succeeded
                                                  ? 'is-success'
                                                  : 'is-failed'
                                              }
                                            >
                                              {turn.shell.succeeded
                                                ? '任务已完成'
                                                : `未完成 · ${turn.shell.stopReason}`}
                                            </span>
                                          </div>
                                          {turn.shell.runs.map((run) => (
                                            <details
                                              className="chat-shell-run"
                                              key={run.runId}
                                            >
                                              <summary>
                                                <span
                                                  className={`shell-run-state shell-run-${run.status}`}
                                                >
                                                  {
                                                    shellRunStatusLabels[
                                                      run.status
                                                    ]
                                                  }
                                                </span>
                                                <code>{run.command}</code>
                                                <span className="tabular">
                                                  {run.runId.slice(0, 14)}
                                                </span>
                                              </summary>
                                              <div className="chat-shell-body">
                                                {run.reason ? (
                                                  <p>{run.reason}</p>
                                                ) : null}
                                                <dl>
                                                  <div>
                                                    <dt>目录</dt>
                                                    <dd>
                                                      <code>{run.cwd}</code>
                                                    </dd>
                                                  </div>
                                                  <div>
                                                    <dt>退出</dt>
                                                    <dd className="tabular">
                                                      {run.exitCode ?? '—'}
                                                      {run.signal
                                                        ? ` · ${run.signal}`
                                                        : ''}
                                                    </dd>
                                                  </div>
                                                </dl>
                                                <pre>
                                                  <code>{`$ ${run.command}\n${
                                                    run.stdout ||
                                                    (run.stderr
                                                      ? ''
                                                      : '（无标准输出）')
                                                  }${
                                                    run.stderr
                                                      ? `\n[stderr]\n${run.stderr}`
                                                      : ''
                                                  }${
                                                    run.stdoutTruncated ||
                                                    run.stderrTruncated
                                                      ? '\n…（输出已截断，完整捕获见本机审计目录）'
                                                      : ''
                                                  }`}</code>
                                                </pre>
                                                {run.error ? (
                                                  <p className="chat-shell-error">
                                                    {run.error.code} ·{' '}
                                                    {run.error.message}
                                                  </p>
                                                ) : null}
                                              </div>
                                            </details>
                                          ))}
                                        </div>
                                      ) : null}
                                      {turn.runId ? (
                                        <span className="chat-meta">
                                          {turn.intent} · {turn.priority}优先级
                                          · RUN {turn.runId.slice(0, 8)}
                                          {turn.mode === 'n8n' ? (
                                            <span
                                              className={`engine-tag ${
                                                turn.degraded
                                                  ? 'engine-tag-degraded'
                                                  : 'engine-tag-model'
                                              }`}
                                            >
                                              <Zap aria-hidden="true" />
                                              {turn.degraded
                                                ? 'n8n · 规则降级'
                                                : turn.executionMode === 'llm'
                                                  ? 'n8n · 真实模型'
                                                  : 'n8n · 规则'}
                                            </span>
                                          ) : turn.mode === 'model' ? (
                                            <span className="engine-tag engine-tag-model">
                                              <Zap aria-hidden="true" />
                                              真实模型
                                            </span>
                                          ) : (
                                            <span className="engine-tag">
                                              模拟回复
                                            </span>
                                          )}
                                        </span>
                                      ) : null}
                                    </>
                                  )}
                                </div>
                              </article>
                            );
                          })}
                        </div>

                        <div
                          className={`composer-card${
                            visibleChat.length === 0 ? ' is-empty' : ''
                          }`}
                        >
                          {composerMenuOpen ? (
                            <div
                              ref={composerMenuRef}
                              className="composer-menu"
                              aria-label="附件、工作流与工作模式"
                            >
                              <fieldset className="composer-menu-group">
                                <legend className="composer-menu-title">
                                  附件
                                </legend>
                                <button
                                  type="button"
                                  disabled={workMode === 'shell'}
                                  onClick={() => {
                                    setComposerMenuOpen(false);
                                    composerPlusRef.current?.focus();
                                    attachmentInputRef.current?.click();
                                  }}
                                >
                                  添加文件
                                  <span className="composer-menu-hint">
                                    {workMode === 'shell'
                                      ? '全权限模式请在消息里提供本机绝对路径'
                                      : 'PDF、Word、PPT、Excel、数据与图片，单个 ≤25 MiB'}
                                  </span>
                                </button>
                              </fieldset>
                              <fieldset className="composer-menu-group">
                                <legend className="composer-menu-title">
                                  工作流
                                </legend>
                                {publishedWorkflows.length ? (
                                  publishedWorkflows.map((item) => (
                                    <button
                                      type="button"
                                      key={item.id}
                                      aria-pressed={
                                        item.id === consumerWorkflowId
                                      }
                                      className={
                                        item.id === consumerWorkflowId
                                          ? 'is-active'
                                          : ''
                                      }
                                      onClick={() => {
                                        selectConsumerWorkflow(item.id);
                                        setComposerMenuOpen(false);
                                        composerPlusRef.current?.focus();
                                      }}
                                    >
                                      {item.name} · v{item.version}
                                    </button>
                                  ))
                                ) : (
                                  <span className="composer-menu-empty">
                                    还没有已发布的工作流
                                  </span>
                                )}
                              </fieldset>
                              <fieldset className="composer-menu-group">
                                <legend className="composer-menu-title">
                                  工作模式
                                </legend>
                                {WORK_MODES.filter(
                                  (mode) =>
                                    mode.id !== 'shell' ||
                                    localControl.visibility === 'local',
                                ).map((mode) => (
                                  <button
                                    type="button"
                                    key={mode.id}
                                    aria-pressed={mode.id === workMode}
                                    disabled={
                                      mode.id === 'shell' &&
                                      !localControl.available
                                    }
                                    className={
                                      mode.id === workMode ? 'is-active' : ''
                                    }
                                    onClick={() => {
                                      setWorkMode(mode.id);
                                      setComposerMenuOpen(false);
                                      composerPlusRef.current?.focus();
                                    }}
                                  >
                                    {mode.label}
                                    <span className="composer-menu-hint">
                                      {mode.hint}
                                    </span>
                                  </button>
                                ))}
                              </fieldset>
                            </div>
                          ) : null}

                          {attachments.length > 0 ? (
                            <div className="chat-attachment-strip">
                              {attachments.map((item) => (
                                <span
                                  className="chat-attachment-chip"
                                  key={item.id}
                                >
                                  {item.previewUrl ? (
                                    // eslint-disable-next-line next/no-img-element -- 本地 object URL 缩略图
                                    <img
                                      className="chat-thumb chat-thumb-chip"
                                      src={item.previewUrl}
                                      alt=""
                                    />
                                  ) : (
                                    <Paperclip aria-hidden="true" />
                                  )}
                                  <span>{item.name}</span>
                                  <button
                                    type="button"
                                    onClick={() => removeAttachment(item.id)}
                                    aria-label={`移除 ${item.name}`}
                                  >
                                    <X aria-hidden="true" />
                                  </button>
                                </span>
                              ))}
                            </div>
                          ) : null}
                          <form
                            className="chat-composer"
                            onSubmit={(event) => {
                              event.preventDefault();
                              void sendChatMessage();
                            }}
                          >
                            <input
                              ref={attachmentInputRef}
                              className="sr-only"
                              type="file"
                              accept={PYTHON_ATTACHMENT_ACCEPT}
                              multiple
                              onChange={(event) => {
                                addAttachments(
                                  Array.from(event.target.files ?? []),
                                );
                                event.target.value = '';
                              }}
                            />
                            <label
                              className="sr-only"
                              htmlFor="agent-chat-input"
                            >
                              给 Agent 发消息
                            </label>
                            <Textarea
                              id="agent-chat-input"
                              className="chat-input"
                              value={chatDraft}
                              onChange={(event) =>
                                setChatDraft(event.target.value)
                              }
                              onPaste={handleAttachmentPaste}
                              onDrop={handleAttachmentDrop}
                              onDragOver={(event) => event.preventDefault()}
                              onKeyDown={(event) => {
                                if (
                                  event.key === 'Enter' &&
                                  !event.shiftKey &&
                                  !event.nativeEvent.isComposing
                                ) {
                                  event.preventDefault();
                                  void sendChatMessage();
                                }
                              }}
                              placeholder={
                                !publishedSteps
                                  ? '先发布一个工作流'
                                  : workMode === 'shell'
                                    ? localControl.available
                                      ? '告诉 Agent 要在这台 Mac 上完成什么'
                                      : '请先在设置中连接本机控制'
                                    : '描述你想完成的事，或粘贴文件'
                              }
                              rows={3}
                              maxLength={2000}
                              autoComplete="off"
                              disabled={!publishedSteps || chatBusy}
                            />
                            <div className="composer-toolbar">
                              <Button
                                type="button"
                                variant="outline"
                                className="chat-plus"
                                ref={composerPlusRef}
                                aria-label="添加附件、选择工作流与工作模式"
                                aria-expanded={composerMenuOpen}
                                title="附件 / 工作流 / 工作模式"
                                disabled={!publishedSteps || chatBusy}
                                onClick={() =>
                                  setComposerMenuOpen((open) => !open)
                                }
                              >
                                <CirclePlus aria-hidden="true" />
                              </Button>
                              <div className="composer-send-controls">
                                <div
                                  className={`composer-model-control is-${modelDiscovery.status}`}
                                  title={
                                    modelDiscovery.message ||
                                    '填好 API Key 后会自动识别模型'
                                  }
                                >
                                  {modelDiscovery.status === 'loading' ? (
                                    <Loader2
                                      className="spin"
                                      aria-hidden="true"
                                    />
                                  ) : (
                                    <Bot aria-hidden="true" />
                                  )}
                                  <NativeSelect
                                    className="composer-model-select"
                                    size="sm"
                                    aria-label="选择模型"
                                    value={llmConfig.model}
                                    disabled={
                                      chatBusy || selectableModels.length === 0
                                    }
                                    onChange={(event) =>
                                      setLlmConfig((current) => ({
                                        ...current,
                                        model: event.target.value,
                                      }))
                                    }
                                  >
                                    {selectableModels.map((model) => (
                                      <NativeSelectOption
                                        key={model}
                                        value={model}
                                      >
                                        {model}
                                      </NativeSelectOption>
                                    ))}
                                  </NativeSelect>
                                </div>
                                <NativeSelect
                                  className="composer-reasoning-select"
                                  size="sm"
                                  aria-label="选择推理强度"
                                  title={
                                    selectedLlmProvider?.reasoningNote ??
                                    '仅在该 API 支持时生效'
                                  }
                                  value={
                                    selectedLlmProvider?.reasoningMode ===
                                    'model-only'
                                      ? 'auto'
                                      : llmConfig.reasoningEffort
                                  }
                                  disabled={
                                    chatBusy ||
                                    selectedLlmProvider?.reasoningMode ===
                                      'model-only'
                                  }
                                  onChange={(event) => {
                                    const value = event.target.value;
                                    if (!isLlmReasoningEffort(value)) return;
                                    setLlmConfig((current) => ({
                                      ...current,
                                      reasoningEffort: value,
                                    }));
                                  }}
                                >
                                  <NativeSelectOption value="auto">
                                    {selectedLlmProvider?.reasoningMode ===
                                    'model-only'
                                      ? '内置'
                                      : '自动'}
                                  </NativeSelectOption>
                                  <NativeSelectOption value="low">
                                    低
                                  </NativeSelectOption>
                                  <NativeSelectOption value="medium">
                                    中
                                  </NativeSelectOption>
                                  <NativeSelectOption value="high">
                                    高
                                  </NativeSelectOption>
                                </NativeSelect>
                                <Button
                                  type="submit"
                                  className="chat-send"
                                  data-busy={chatBusy ? 'true' : 'false'}
                                  aria-label={
                                    chatBusy ? '正在回复' : '发送消息'
                                  }
                                  title={chatBusy ? '正在回复' : '发送'}
                                  disabled={
                                    !publishedSteps ||
                                    chatBusy ||
                                    running ||
                                    !chatDraft.trim() ||
                                    (workMode === 'shell' &&
                                      !localControl.available)
                                  }
                                >
                                  {chatBusy ? (
                                    <>
                                      <Loader2
                                        className="spin"
                                        aria-hidden="true"
                                      />
                                      <span>正在回复</span>
                                    </>
                                  ) : (
                                    <Send aria-hidden="true" />
                                  )}
                                </Button>
                              </div>
                              <output className="sr-only" aria-live="polite">
                                {modelDiscovery.message}
                              </output>
                            </div>
                          </form>
                        </div>
                      </section>
                    </div>

                    <aside
                      className="ledger-page ledger-page-run"
                      aria-label="执行面板"
                      hidden={!runPanelOpen}
                    >
                      <div className="ledger-run-head">
                        <h2>本次办理</h2>
                        <div className="run-panel-actions">
                          <span>
                            {latestRun
                              ? `RUN ${latestRun.id.slice(0, 8)}`
                              : '等待任务'}
                          </span>
                          <button
                            type="button"
                            className="run-panel-toggle"
                            aria-expanded={runPanelOpen}
                            onClick={toggleRunPanel}
                          >
                            <PanelRightClose aria-hidden="true" />
                            收起
                          </button>
                        </div>
                      </div>

                      <Button
                        type="button"
                        className="run-action"
                        disabled={!publishedSteps || running || chatBusy}
                        onClick={() => void startRun()}
                      >
                        {running ? (
                          <Loader2 className="spin" data-icon="inline-start" />
                        ) : (
                          <Play data-icon="inline-start" />
                        )}
                        {chatBusy
                          ? 'Agent 正在对话执行'
                          : running
                            ? 'Agent 正在执行'
                            : '运行当前工作流'}
                      </Button>

                      <div className="agent-route-heading">
                        <h2>Agent 执行路线</h2>
                        <span>{running ? '运行中' : '等待任务'}</span>
                      </div>

                      <ol className="agent-route">
                        {(publishedSteps ?? []).map((step, index) => {
                          const state = stepState(step, index);
                          return (
                            <li
                              className={`route-step route-step-${state}`}
                              key={step.id}
                            >
                              <span className="route-state" aria-hidden="true">
                                {state === 'completed' ? (
                                  <CheckCircle2 />
                                ) : state === 'running' ? (
                                  <Loader2 className="spin" />
                                ) : (
                                  <span />
                                )}
                              </span>
                              <span className="route-index">
                                {String(index + 1).padStart(2, '0')}
                              </span>
                              <span className="route-name">{step.title}</span>
                              <span className="route-kind">
                                {kindLabels[step.kind]}
                              </span>
                            </li>
                          );
                        })}
                      </ol>

                      <div className="run-log-heading">
                        <h2>运行记录</h2>
                        <span>
                          {latestRun
                            ? `RUN ${latestRun.id.slice(0, 8)}`
                            : '暂无记录'}
                        </span>
                      </div>
                      <output
                        className="run-log"
                        aria-live="polite"
                        aria-atomic="false"
                      >
                        {logs.length ? (
                          logs.map((log, index) => (
                            <span
                              className={`log-line log-${log.level}`}
                              key={`${log.at}-${index}`}
                            >
                              <time>{formatClock(log.at)}</time>
                              <span>{log.message}</span>
                            </span>
                          ))
                        ) : (
                          <span className="log-empty">
                            对话或运行后，Agent 的每一步会在这里留下记录。
                          </span>
                        )}
                      </output>

                      {latestRun?.status === 'completed' && !running ? (
                        <div className="result-strip">
                          <CheckCircle2 aria-hidden="true" />
                          <div>
                            <strong>{latestRun.output.result}</strong>
                            <span>{latestRun.output.summary}</span>
                          </div>
                          <time>{formatClock(latestRun.finishedAt)}</time>
                        </div>
                      ) : null}

                      <div className="run-log-heading">
                        <h2>运行台账</h2>
                        <span className="tabular">
                          {consumerShellRuns.length +
                            consumerPythonRuns.length +
                            runs.length}{' '}
                          条
                        </span>
                      </div>
                      {consumerShellRuns.length ||
                      consumerPythonRuns.length ||
                      runs.length ? (
                        <>
                          <ul className="ledger-list ledger-list-runs is-on-paper">
                            {consumerShellRuns.map((run) => (
                              <li key={run.runId}>
                                <span className="ledger-run">
                                  <span className="ledger-list-name">
                                    Shell · {run.command}
                                  </span>
                                  <span className="ledger-list-stamp tabular">
                                    {run.runId.slice(6, 12)}
                                  </span>
                                  <span
                                    className={`ledger-run-state ledger-run-${run.status}`}
                                  >
                                    {shellRunStatusLabels[run.status]}
                                  </span>
                                  <time className="tabular">
                                    {run.status === 'queued' ||
                                    run.status === 'running'
                                      ? shellElapsed(run, elapsedNow)
                                      : formatClock(
                                          run.finishedAt
                                            ? Date.parse(run.finishedAt)
                                            : null,
                                        )}
                                  </time>
                                </span>
                              </li>
                            ))}
                            {consumerPythonRuns.map((run) => (
                              <li key={run.runId}>
                                <span className="ledger-run">
                                  <span className="ledger-list-name">
                                    Python ·{' '}
                                    {run.profile === 'long'
                                      ? '长任务'
                                      : '短任务'}
                                  </span>
                                  <span className="ledger-list-stamp tabular">
                                    #{run.attempt}
                                  </span>
                                  <span
                                    className={`ledger-run-state ledger-run-${run.status}`}
                                  >
                                    {pythonRunStatusLabels[run.status]}
                                  </span>
                                  <time className="tabular">
                                    {run.status === 'queued' ||
                                    run.status === 'running'
                                      ? formatElapsed(
                                          elapsedNow -
                                            (run.startedAt ?? run.createdAt),
                                        )
                                      : formatClock(run.finishedAt)}
                                  </time>
                                </span>
                              </li>
                            ))}
                            {runs.map((run) => (
                              <li key={run.id}>
                                <span className="ledger-run">
                                  <span className="ledger-list-name">
                                    {run.workflowName}
                                  </span>
                                  <span className="ledger-list-stamp tabular">
                                    v{run.workflowVersion}
                                  </span>
                                  <span
                                    className={`ledger-run-state ledger-run-${run.status}`}
                                  >
                                    {runStatusLabels[run.status] ?? run.status}
                                  </span>
                                  <time className="tabular">
                                    {formatClock(run.startedAt)}
                                  </time>
                                </span>
                              </li>
                            ))}
                          </ul>
                          <nav
                            className="ledger-pagination is-on-paper"
                            aria-label="运行台账分页"
                          >
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={
                                !runPagination.hasPrevious ||
                                loadState === 'loading'
                              }
                              onClick={() => void refreshState(runPage - 1)}
                            >
                              <ChevronLeft aria-hidden="true" />
                              上一页
                            </Button>
                            <span className="tabular">第 {runPage + 1} 页</span>
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              disabled={
                                !runPagination.hasNext ||
                                loadState === 'loading'
                              }
                              onClick={() => void refreshState(runPage + 1)}
                            >
                              下一页
                              <ArrowRight aria-hidden="true" />
                            </Button>
                          </nav>
                        </>
                      ) : (
                        <p className="ledger-empty is-on-paper">
                          还没有运行记录。
                        </p>
                      )}
                    </aside>
                  </div>
                </div>
              </section>
            )}
          </div>
        </WorkspaceRegion>
      )}
    </div>
  );
}
