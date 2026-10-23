import { env } from 'cloudflare:workers';

import {
  errorEnvelope,
  isRetryableCode,
  normalizeResponse,
  URTORIS_PROTOCOL,
  URTORIS_REQUEST_ID_HEADER,
  URTORIS_SESSION_ID_HEADER,
  type UrtorisErrorCode,
  type UrtorisRequest,
  type UrtorisResponse,
} from '@/lib/server/protocol';

const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_ATTEMPTS = 2;
const RETRY_BACKOFF_MS = 400;
const WEBHOOK_PATH_PREFIX = '/webhook/urtoris/';

/** 只有这些 HTTP 状态码值得重投；其余（4xx 语义错误）重投也没用。 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export type CallN8nOptions = {
  /** 完整 webhook 地址；也接受 `/webhook/urtoris/xxx` 这种相对路径。 */
  webhookUrl: string;
  request: UrtorisRequest;
  timeoutMs?: number;
  maxAttempts?: number;
};

export type CallN8nResult = {
  /** 永远是合法的 v1 信封 —— 调用方不需要再判形状。 */
  envelope: UrtorisResponse;
  httpStatus: number | null;
  attempts: number;
  durationMs: number;
  raw: string;
};

function configuredN8nOrigin(): string | null {
  const configuredBase = env.N8N_BASE_URL?.trim();
  if (!configuredBase || configuredBase.includes('\\')) return null;

  let base: URL;
  try {
    base = new URL(configuredBase);
  } catch {
    return null;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return null;
  // N8N_BASE_URL is an origin, not a URL that carries credentials or a path.
  if (
    base.username ||
    base.password ||
    base.pathname !== '/' ||
    base.search ||
    base.hash
  ) {
    return null;
  }
  return base.origin.toLowerCase();
}

function isAllowedWebhookUrl(url: URL, expectedOrigin: string): boolean {
  if (url.origin.toLowerCase() !== expectedOrigin) return false;
  if (url.username || url.password || url.search || url.hash) return false;
  if (!url.pathname.startsWith(WEBHOOK_PATH_PREFIX)) return false;
  if (url.pathname.includes('\\') || url.pathname.includes('..')) return false;

  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(url.pathname);
  } catch {
    return false;
  }
  if (
    !decodedPath.startsWith(WEBHOOK_PATH_PREFIX) ||
    decodedPath.includes('\\') ||
    decodedPath.includes('..') ||
    Array.from(decodedPath).some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code <= 0x1f || code === 0x7f;
    })
  ) {
    return false;
  }

  return decodedPath.length > WEBHOOK_PATH_PREFIX.length;
}

/**
 * 将管理面提交的 webhook 地址规范化，并在写入前完成最终目标白名单检查。
 * 空串、非字符串、未配置 N8N_BASE_URL 或任何越界目标都会返回 null。
 */
export function normalizeWebhookUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes('\\')) return null;

  const expectedOrigin = configuredN8nOrigin();
  if (!expectedOrigin) return null;

  try {
    const url = trimmed.startsWith('/')
      ? new URL(trimmed, `${expectedOrigin}/`)
      : new URL(trimmed);
    return isAllowedWebhookUrl(url, expectedOrigin) ? url.toString() : null;
  } catch {
    return null;
  }
}

/**
 * 运行时调用前再次解析和校验。数据库中的历史值也不能绕过同一白名单。
 */
export function resolveWebhookUrl(raw: string): string | null {
  return normalizeWebhookUrl(raw);
}

/**
 * 取 webhook 鉴权头：只使用服务端共享令牌（`N8N_WEBHOOK_TOKEN`）。
 * 令牌只存在于服务端环境变量，不出现在浏览器或数据库。
 */
export function resolveAuthHeader(): string | null {
  const shared = env.N8N_WEBHOOK_TOKEN?.trim();
  if (shared) return `Bearer ${shared}`;
  return null;
}

function parseMaybeJson(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 调用一个 n8n 工作流，并把结果归一化成 v1 信封。
 *
 * 三件事由这里统一兜住（网站因此不需要知道 n8n 内部结构）：
 *   1. 超时 —— AbortController，超时映射成 TIMEOUT / UPSTREAM_TIMEOUT
 *   2. 重试 —— 同一 requestId 重投，只递增 meta.attempt，幂等键不变
 *   3. 归一 —— 非 2xx / 裸 JSON / 网络错误，全部变成同一种形状
 */
export async function callN8nWorkflow(
  options: CallN8nOptions,
): Promise<CallN8nResult> {
  const startedAt = Date.now();
  const requestId = options.request.requestId;
  const workflow = options.request.workflowId;
  const timeoutMs = options.timeoutMs ?? options.request.meta.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);

  const endpoint = resolveWebhookUrl(options.webhookUrl);
  if (!endpoint) {
    return {
      envelope: errorEnvelope({
        requestId,
        workflow,
        code: 'VALIDATION_ERROR',
        message: 'n8n webhook 地址无效或未配置（相对路径需要 N8N_BASE_URL）。',
        meta: { durationMs: Date.now() - startedAt, attempt: 0 },
      }),
      httpStatus: null,
      attempts: 0,
      durationMs: Date.now() - startedAt,
      raw: '',
    };
  }

  const authHeader = resolveAuthHeader();
  let lastResult: CallN8nResult | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [URTORIS_REQUEST_ID_HEADER]: requestId,
      [URTORIS_SESSION_ID_HEADER]: options.request.sessionId,
    };
    if (authHeader) headers.Authorization = authHeader;

    const payload: UrtorisRequest = {
      ...options.request,
      meta: { ...options.request.meta, attempt },
    };

    let httpStatus = 0;
    let raw = '';
    let transportFailure: {
      code: UrtorisErrorCode;
      message: string;
      detail?: string;
    } | null = null;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      httpStatus = response.status;
      raw = await response.text();
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === 'AbortError';
      transportFailure = aborted
        ? {
            code: 'TIMEOUT',
            message: `n8n 工作流在 ${timeoutMs} ms 内没有返回。`,
            detail: `requestId=${requestId}`,
          }
        : {
            code: 'NETWORK_ERROR',
            message: `无法连接 n8n：${cause instanceof Error ? cause.message : '未知网络错误'}`,
            detail: endpoint,
          };
    } finally {
      clearTimeout(timer);
    }

    const durationMs = Date.now() - attemptStartedAt;
    const envelope = normalizeResponse({
      requestId,
      workflow,
      attempt,
      startedAt: attemptStartedAt,
      durationMs,
      httpStatus,
      raw,
      parsed: transportFailure ? null : parseMaybeJson(raw),
      transportFailure,
    });

    const result: CallN8nResult = {
      envelope,
      httpStatus: httpStatus || null,
      attempts: attempt,
      durationMs: Date.now() - startedAt,
      raw,
    };
    lastResult = result;

    const shouldRetry =
      attempt < maxAttempts &&
      (transportFailure !== null || RETRYABLE_STATUS.has(httpStatus)) &&
      (transportFailure !== null ? isRetryableCode(transportFailure.code) : true);

    if (!shouldRetry) return result;
    await sleep(RETRY_BACKOFF_MS * attempt);
  }

  return (
    lastResult ?? {
      envelope: errorEnvelope({
        requestId,
        workflow,
        code: 'INTERNAL_ERROR',
        message: 'n8n 调用没有产生任何结果。',
        meta: { durationMs: Date.now() - startedAt, attempt: 0 },
      }),
      httpStatus: null,
      attempts: 0,
      durationMs: Date.now() - startedAt,
      raw: '',
    }
  );
}

/** 给外部（例如健康检查接口）用的协议自检。 */
export function describeProtocol(): { protocol: string; baseUrl: string | null; hasToken: boolean } {
  return {
    protocol: URTORIS_PROTOCOL,
    baseUrl: env.N8N_BASE_URL?.trim() ?? null,
    hasToken: Boolean(env.N8N_WEBHOOK_TOKEN?.trim()),
  };
}
