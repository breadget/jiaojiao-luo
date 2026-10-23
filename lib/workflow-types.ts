export const stepKinds = [
  'input',
  'transform',
  'decision',
  'compose',
  'output',
] as const;

export type StepKind = (typeof stepKinds)[number];

export type WorkflowStep = {
  id: string;
  title: string;
  detail: string;
  kind: StepKind;
};

export type WorkflowRecord = {
  id: string;
  name: string;
  description: string;
  draftSteps: WorkflowStep[];
  publishedSteps: WorkflowStep[] | null;
  version: number;
  hasUnpublishedChanges: boolean;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  /** 已发布工作流绑定的 n8n webhook 地址；为空表示使用内置模拟执行器。 */
  n8nWebhookUrl: string | null;
};

/** `/api/state` 中允许公开的工作流字段；新增内部字段不会自动进入 DTO。 */
export type PublicWorkflowRecord = {
  id: string;
  name: string;
  description: string;
  draftSteps: WorkflowStep[];
  publishedSteps: WorkflowStep[] | null;
  version: number;
  hasUnpublishedChanges: boolean;
  createdAt: number;
  updatedAt: number;
  publishedAt: number | null;
  n8nWebhookUrl: string | null;
};

/** `/api/state` 中允许公开的运行字段；消息、日志和链路标识固定为空。 */
export type PublicWorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  status: WorkflowRun['status'];
  steps: WorkflowStep[];
  logs: [];
  output: {
    summary: string;
    processed: number;
    result: string;
  };
  startedAt: number;
  finishedAt: number | null;
  engine?: RunEngine;
  requestId: null;
  sessionId: null;
  errorMessage: null;
  executionId: null;
  mode?: RunMode | null;
  degraded?: boolean | null;
};

export type RunLog = {
  at: number;
  level: 'system' | 'info' | 'success' | 'error';
  message: string;
  stepId?: string;
};

/** 一次运行到底由谁执行：内置模拟器、真实 n8n、还是使用端自带的大模型。 */
export type RunEngine = 'simulated' | 'n8n' | 'model';
export type RunMode = 'llm' | 'rules' | 'simulated';

/** 协议 v1 的可观测字段：一次运行从哪来、到哪去、错在哪。 */
export type RunTrace = {
  /** 全链路 ID：网站 → n8n → 子工作流 → 日志，靠它反查一切。 */
  requestId?: string | null;
  /** 多轮会话 ID，用于 Memory 分区。 */
  sessionId?: string | null;
  /** n8n 侧的错误码（见 docs/PROTOCOL-v1.md 错误码表）。 */
  errorCode?: string | null;
  errorMessage?: string | null;
  /** 端到端耗时（毫秒）。 */
  durationMs?: number | null;
  /** 实际投递次数（含重试）。 */
  attempts?: number | null;
  /** n8n execution id，用于直接跳进 n8n 界面看这次执行。 */
  executionId?: string | null;
  /** 真正的业务执行模式，与 engine（承载引擎）分开。 */
  mode?: RunMode | null;
  /** 工作流成功但能力降级（例如无 Key 改走规则）。 */
  degraded?: boolean | null;
};

export type WorkflowRun = {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  status: 'queued' | 'running' | 'completed' | 'failed';
  steps: WorkflowStep[];
  logs: RunLog[];
  output: {
    summary: string;
    processed: number;
    result: string;
  };
  startedAt: number;
  finishedAt: number | null;
  engine?: RunEngine;
} & RunTrace;

/** n8n 执行过程中上报的结构化事件。 */
export type N8nEvent = {
  id: string;
  requestId: string | null;
  sessionId: string | null;
  workflow: string | null;
  executionId: string | null;
  level: 'debug' | 'info' | 'warn' | 'error';
  eventType: string;
  node: string | null;
  message: string;
  payload: unknown;
  durationMs: number | null;
  createdAt: number;
};

/** 在危险节点前写入的 requestId ↔ executionId 确定性映射。 */
export type N8nExecutionBinding = {
  executionId: string;
  requestId: string;
  workflowId: string;
  workflowName: string | null;
  sessionId: string | null;
  createdAt: number;
};

export type StateResponse = {
  workflows: PublicWorkflowRecord[];
  runs: PublicWorkflowRun[];
  /** 本机/内网访问时服务端会把这次会话当管理员（免令牌）。 */
  adminTrusted?: boolean;
};

export type ChatTurn = {
  id: string;
  role: 'user' | 'agent';
  text: string;
  at: number;
  working?: boolean;
  runId?: string;
  intent?: string;
  priority?: string;
  /** agent 回复的来源：真实模型或内置规则模拟。 */
  mode?: ChatMode;
  executionMode?: RunMode;
  degraded?: boolean;
};

/** 使用端自带的大模型配置；只停留在浏览器，不写入服务端。 */
export type LlmConfig = {
  /** 模型服务 id（见 lib/llm/providers.ts）；决定默认端点与默认模型。 */
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
};

export type ChatMode = 'model' | 'simulated' | 'n8n';

export type AgentChatResponse = {
  reply: string;
  intent: string;
  priority: '高' | '中' | '低';
  keywords: string[];
  run: WorkflowRun;
  mode: ChatMode;
  executionMode?: RunMode;
  degraded?: boolean;
  model?: string;
  /** 回传给使用端的会话 ID，下一轮必须原样带回来。 */
  sessionId?: string;
  requestId?: string;
  /** n8n 返回的统一错误码（成功时为 null）。 */
  errorCode?: string | null;
};
