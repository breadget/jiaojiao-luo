/**
 * Urtoris ↔ n8n 统一协议 v1。
 *
 * 契约唯一来源：`docs/PROTOCOL-v1.md`（本仓库 ../机器人 侧同名文档）。
 * 这里的职责只有三件事：
 *   1. 造请求信封（网站 → n8n）
 *   2. 造响应信封（n8n → 网站，成功与失败同形状）
 *   3. 把任何"不是信封"的东西归一化成信封（n8n 边界错误、历史工作流裸 JSON）
 */

import { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL } from '@/lib/server/llm';

export const URTORIS_PROTOCOL = 'urtoris.v1';

/** 全链路贯穿的协议头，n8n 侧工作流同样读它。 */
export const URTORIS_REQUEST_ID_HEADER = 'x-urtoris-request-id';
export const URTORIS_SESSION_ID_HEADER = 'x-urtoris-session-id';

export { DEFAULT_LLM_BASE_URL, DEFAULT_LLM_MODEL };

export type UrtorisErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UPSTREAM_ERROR'
  | 'UPSTREAM_TIMEOUT'
  | 'CREDENTIAL_MISSING'
  | 'LLM_NOT_CONFIGURED'
  | 'LLM_ERROR'
  | 'LLM_TIMEOUT'
  | 'NODE_ERROR'
  | 'INTENT_UNKNOWN'
  | 'INTERNAL_ERROR';

export type UrtorisEngine = 'n8n' | 'model' | 'simulated';
export type UrtorisMode = 'llm' | 'rules' | 'simulated';

/** 每个错误码的：中文说明 + 是否值得重试 + 建议的 HTTP 状态码。 */
export const ERROR_CATALOG: Record<
  UrtorisErrorCode,
  { label: string; retryable: boolean; status: number }
> = {
  VALIDATION_ERROR: {
    label: '请求内容不符合协议',
    retryable: false,
    status: 400,
  },
  UNAUTHORIZED: {
    label: '缺少或错误的访问令牌',
    retryable: false,
    status: 401,
  },
  FORBIDDEN: {
    label: '令牌有效但无权调用该工作流',
    retryable: false,
    status: 403,
  },
  NOT_FOUND: { label: '找不到这个工作流', retryable: false, status: 404 },
  RATE_LIMITED: { label: '触发限流，请稍后重试', retryable: true, status: 429 },
  TIMEOUT: { label: '工作流执行超时', retryable: true, status: 504 },
  NETWORK_ERROR: { label: '无法连接 n8n 引擎', retryable: true, status: 502 },
  UPSTREAM_ERROR: { label: '下游服务返回错误', retryable: true, status: 502 },
  UPSTREAM_TIMEOUT: { label: '下游服务响应超时', retryable: true, status: 504 },
  CREDENTIAL_MISSING: {
    label: '外部服务凭证尚未配置',
    retryable: false,
    status: 424,
  },
  LLM_NOT_CONFIGURED: {
    label: '尚未配置大模型密钥',
    retryable: false,
    status: 424,
  },
  LLM_ERROR: { label: '模型返回错误', retryable: true, status: 502 },
  LLM_TIMEOUT: { label: '模型响应超时', retryable: true, status: 504 },
  NODE_ERROR: { label: '工作流节点执行失败', retryable: false, status: 500 },
  INTENT_UNKNOWN: { label: '无法识别意图', retryable: false, status: 422 },
  INTERNAL_ERROR: { label: '引擎内部错误', retryable: true, status: 500 },
};

export function isRetryableCode(code: UrtorisErrorCode): boolean {
  return ERROR_CATALOG[code].retryable;
}

export function errorLabel(code: UrtorisErrorCode): string {
  return ERROR_CATALOG[code].label;
}

export type UrtorisLlmConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

export type UrtorisRequestMeta = {
  source: string;
  sentAt: number;
  attempt: number;
  timeoutMs: number;
  idempotencyKey: string;
  workflowVersion?: number;
  workflowName?: string;
  steps?: unknown;
};

export type UrtorisRequest = {
  protocol: typeof URTORIS_PROTOCOL;
  requestId: string;
  workflowId: string;
  sessionId: string;
  message: string;
  user: Record<string, unknown> & { id: string };
  context: Record<string, unknown>;
  meta: UrtorisRequestMeta;
};

export type UrtorisError = {
  code: UrtorisErrorCode;
  message: string;
  detail?: string | null;
  node?: string | null;
  retryable: boolean;
};

export type UrtorisResponseMeta = {
  executionId?: string | null;
  durationMs: number;
  attempt: number;
  startedAt?: number;
  finishedAt?: number;
  httpStatus?: number | null;
};

export type UrtorisResponse = {
  protocol: typeof URTORIS_PROTOCOL;
  success: boolean;
  requestId: string;
  engine: UrtorisEngine;
  /** 业务实际走的执行模式，不与工作流引擎混为一谈。 */
  mode: UrtorisMode;
  /** true 表示请求成功，但未走原定的 LLM 能力。 */
  degraded: boolean;
  workflow: string;
  data: Record<string, unknown> | null;
  error: UrtorisError | null;
  meta: UrtorisResponseMeta;
};

export function createRequestId(): string {
  return crypto.randomUUID();
}

export function createSessionId(): string {
  return `sess_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export type BuildRequestInput = {
  workflowId: string;
  message: string;
  sessionId?: string | null;
  userId?: string | null;
  context?: Record<string, unknown> | null;
  llm?: UrtorisLlmConfig | null;
  source?: string;
  timeoutMs?: number;
  attempt?: number;
  requestId?: string | null;
  workflowVersion?: number;
  workflowName?: string;
  steps?: unknown;
};

/** 造一个合法的 v1 请求信封。requestId 缺省时自动生成。 */
export function buildRequest(input: BuildRequestInput): UrtorisRequest {
  const requestId = input.requestId?.trim() || createRequestId();
  const context: Record<string, unknown> = { ...input.context };
  if (input.llm?.apiKey) {
    context.llm = {
      apiKey: input.llm.apiKey,
      baseUrl: input.llm.baseUrl || DEFAULT_LLM_BASE_URL,
      model: input.llm.model || DEFAULT_LLM_MODEL,
    };
  }

  return {
    protocol: URTORIS_PROTOCOL,
    requestId,
    workflowId: input.workflowId,
    sessionId: input.sessionId?.trim() || createSessionId(),
    message: input.message,
    user: { id: input.userId?.trim() || 'anonymous' },
    context,
    meta: {
      source: input.source ?? 'urtoris-web',
      sentAt: Date.now(),
      attempt: input.attempt ?? 1,
      timeoutMs: input.timeoutMs ?? 45_000,
      idempotencyKey: requestId,
      workflowVersion: input.workflowVersion,
      workflowName: input.workflowName,
      steps: input.steps,
    },
  };
}

export function successEnvelope(input: {
  requestId: string;
  workflow: string;
  data: Record<string, unknown>;
  engine?: UrtorisEngine;
  mode?: UrtorisMode;
  degraded?: boolean;
  meta: Partial<UrtorisResponseMeta> & { durationMs: number; attempt: number };
}): UrtorisResponse {
  const engine = input.engine ?? 'n8n';
  const mode =
    input.mode ??
    (engine === 'model'
      ? 'llm'
      : engine === 'simulated'
        ? 'simulated'
        : 'rules');
  return {
    protocol: URTORIS_PROTOCOL,
    success: true,
    requestId: input.requestId,
    engine,
    mode,
    degraded: input.degraded ?? mode === 'simulated',
    workflow: input.workflow,
    data: input.data,
    error: null,
    meta: {
      executionId: input.meta.executionId ?? null,
      durationMs: input.meta.durationMs,
      attempt: input.meta.attempt,
      startedAt: input.meta.startedAt,
      finishedAt: input.meta.finishedAt ?? Date.now(),
      httpStatus: input.meta.httpStatus ?? 200,
    },
  };
}

export function errorEnvelope(input: {
  requestId: string;
  workflow: string;
  code: UrtorisErrorCode;
  message?: string;
  detail?: string | null;
  node?: string | null;
  engine?: UrtorisEngine;
  mode?: UrtorisMode;
  degraded?: boolean;
  retryable?: boolean;
  meta: Partial<UrtorisResponseMeta> & { durationMs: number; attempt: number };
}): UrtorisResponse {
  const catalog = ERROR_CATALOG[input.code];
  const engine = input.engine ?? 'n8n';
  const mode =
    input.mode ??
    (engine === 'model'
      ? 'llm'
      : engine === 'simulated'
        ? 'simulated'
        : 'rules');
  return {
    protocol: URTORIS_PROTOCOL,
    success: false,
    requestId: input.requestId,
    engine,
    mode,
    degraded: input.degraded ?? mode === 'simulated',
    workflow: input.workflow,
    data: null,
    error: {
      code: input.code,
      message: input.message?.trim() || catalog.label,
      detail: input.detail ?? null,
      node: input.node ?? null,
      retryable: input.retryable ?? catalog.retryable,
    },
    meta: {
      executionId: input.meta.executionId ?? null,
      durationMs: input.meta.durationMs,
      attempt: input.meta.attempt,
      startedAt: input.meta.startedAt,
      finishedAt: input.meta.finishedAt ?? Date.now(),
      httpStatus: input.meta.httpStatus ?? catalog.status,
    },
  };
}

/** 判断一个载荷是不是合法的 v1 响应信封（宽松：字段齐全即可）。 */
export function isUrtorisEnvelope(value: unknown): value is UrtorisResponse {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.protocol !== URTORIS_PROTOCOL) return false;
  if (typeof record.requestId !== 'string') return false;
  return typeof record.success === 'boolean';
}

const legacyMessageKeys = [
  'reply',
  'text',
  'output',
  'result',
  'message',
  'answer',
  'summary',
] as const;

/** 从任意形状里抽出一句人类可读的话，供运行记录展示。 */
export function extractMessage(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractMessage(item);
      if (found) return found;
    }
    return null;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of legacyMessageKeys) {
      const found = extractMessage(record[key]);
      if (found) return found;
    }
    return null;
  }
  return null;
}

/** 把信封压成运行时用于展示的摘要文本。 */
export function summarizeEnvelope(envelope: UrtorisResponse): string {
  if (envelope.success) {
    return (
      extractMessage(envelope.data) ??
      `n8n 执行完成（${envelope.meta.durationMs}ms）`
    );
  }
  const error = envelope.error;
  if (!error) return 'n8n 执行失败（未返回错误详情）';
  const parts = [`[${error.code}] ${error.message}`];
  if (error.node) parts.push(`节点：${error.node}`);
  if (error.detail) parts.push(error.detail);
  return parts.join(' · ');
}

/** HTTP 状态码 → 协议错误码（n8n 边界错误的归一化规则）。 */
export function codeFromHttpStatus(status: number): UrtorisErrorCode {
  if (status === 400 || status === 422) return 'VALIDATION_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 408 || status === 504) return 'TIMEOUT';
  if (status === 424) return 'CREDENTIAL_MISSING';
  if (status === 429) return 'RATE_LIMITED';
  if (status === 502 || status === 503) return 'UPSTREAM_ERROR';
  return 'INTERNAL_ERROR';
}

/** 试图从 n8n 的裸错误响应体里读出它自己的错误消息，读不到就用状态码兜底。 */
export function messageFromRawBody(raw: string, status: number): string {
  const trimmed = raw.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const candidate =
        extractMessage(parsed.message) ??
        extractMessage(parsed.error) ??
        extractMessage(parsed);
      if (candidate) return candidate.slice(0, 300);
    } catch {
      if (!trimmed.startsWith('<')) return trimmed.slice(0, 300);
    }
  }
  if (status === 404)
    return 'n8n 没有注册这个 webhook（工作流可能未激活 / 未 Publish）。';
  if (status === 403) return 'n8n 拒绝了这次调用（Header Auth 令牌不匹配）。';
  return `n8n 返回 HTTP ${status}`;
}

export type NormalizeInput = {
  requestId: string;
  workflow: string;
  attempt: number;
  startedAt: number;
  durationMs: number;
  httpStatus: number;
  raw: string;
  parsed: unknown;
  /** 网络层错误（连接失败 / 超时）优先于 HTTP 状态码。 */
  transportFailure?: {
    code: UrtorisErrorCode;
    message: string;
    detail?: string;
  } | null;
};

/**
 * 归一化：无论 n8n 返回什么，都产出一个 v1 信封。
 * - 网络失败 → 直接用 transportFailure
 * - 非 2xx → 状态码映射成错误码
 * - 2xx + 合法信封 → 原样透传（补全 requestId / meta）
 * - 2xx + 裸 JSON/数组（历史工作流）→ 包进 data.legacy
 */
export function normalizeResponse(input: NormalizeInput): UrtorisResponse {
  const baseMeta = {
    durationMs: input.durationMs,
    attempt: input.attempt,
    startedAt: input.startedAt,
    finishedAt: input.startedAt + input.durationMs,
    httpStatus: input.httpStatus,
  };

  if (input.transportFailure) {
    return errorEnvelope({
      requestId: input.requestId,
      workflow: input.workflow,
      code: input.transportFailure.code,
      message: input.transportFailure.message,
      detail: input.transportFailure.detail ?? null,
      meta: baseMeta,
    });
  }

  if (input.httpStatus < 200 || input.httpStatus >= 300) {
    const code = codeFromHttpStatus(input.httpStatus);
    return errorEnvelope({
      requestId: input.requestId,
      workflow: input.workflow,
      code,
      message: messageFromRawBody(input.raw, input.httpStatus),
      detail: input.raw.trim().slice(0, 500) || null,
      meta: baseMeta,
    });
  }

  if (isUrtorisEnvelope(input.parsed)) {
    const envelope = input.parsed;
    const engine = envelope.engine ?? 'n8n';
    const mode =
      envelope.mode ??
      (engine === 'model'
        ? 'llm'
        : engine === 'simulated'
          ? 'simulated'
          : 'rules');
    return {
      ...envelope,
      // 以调用方生成的 requestId 为准，便于重试后仍然对得上
      requestId: input.requestId,
      engine,
      mode,
      degraded: envelope.degraded ?? mode === 'simulated',
      workflow: envelope.workflow || input.workflow,
      meta: {
        executionId: envelope.meta?.executionId ?? null,
        durationMs: input.durationMs,
        attempt: input.attempt,
        startedAt: input.startedAt,
        finishedAt: input.startedAt + input.durationMs,
        httpStatus: input.httpStatus,
      },
    };
  }

  // 兼容期：老工作流（例如只返回 {reply, ticketId} 或裸数组）
  const legacyPayload = input.parsed ?? (input.raw.trim() || null);
  const message = extractMessage(legacyPayload);
  if (message !== null) {
    return successEnvelope({
      requestId: input.requestId,
      workflow: input.workflow,
      data: {
        message,
        legacy: legacyPayload,
        legacyEnvelope: true,
      },
      meta: baseMeta,
    });
  }

  return successEnvelope({
    requestId: input.requestId,
    workflow: input.workflow,
    data: {
      message: 'n8n 已执行完成（未返回可读内容）',
      legacy: legacyPayload,
      legacyEnvelope: true,
    },
    meta: baseMeta,
  });
}
