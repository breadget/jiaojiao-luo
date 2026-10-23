import { env } from 'cloudflare:workers';
import type {
  CourseAnswer,
  CourseSource,
  CourseStatus,
} from '@/lib/course-assistant-types';
import {
  enforceRequestPolicy,
  isTrustedLocalRequest,
} from '@/lib/server/security';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const NO_STORE = { 'Cache-Control': 'no-store' };
const TOKEN_PATTERN = /^(?:[A-Za-z0-9]{32}|[A-Za-z0-9]{64})$/;

/** Only fixed, public messages may be returned for backend failures. */
const UPSTREAM_ERRORS: Record<string, string> = {
  method_not_allowed: '课程服务暂时无法处理此请求。',
  unsupported_media_type: '请求内容必须为 JSON。',
  invalid_request: '请求必须是包含 question 的 JSON 对象。',
  request_too_large: '请求过大，请缩短问题后重试。',
  invalid_json: 'JSON 格式有误，请重新提交。',
  invalid_question: '请输入 1 至 2000 字的课程问题。',
  csrf_failed: '课程服务会话验证失败，请稍后重试。',
  status_unavailable: '暂时无法读取知识库状态，请稍后重试。',
  service_unavailable: '课程问答服务暂时不可用，请稍后重试。',
  embedding_config: '课程语义向量服务尚未配置，请检查服务配置。',
  embedding_unavailable: '课程语义向量模型暂时不可用，请稍后重试。',
  knowledge_unavailable: '暂时无法读取课程知识库，请检查文档目录。',
  knowledge_missing: '课程知识库还没有 PDF，请先导入课程文档。',
  pdf_unreadable: '课程 PDF 无法读取，请检查文档是否加密或包含可提取文本。',
  empty_knowledge: '课程文档中没有可提取的文本，请先处理扫描件。',
  index_busy: '课程知识库正在建立索引，请稍后再试。',
  index_config: '课程知识库切分配置无效，请检查服务配置。',
  index_missing: '课程知识库尚未建立索引，请先建立索引。',
  index_failed: '课程知识库索引建立失败，请检查文档和服务配置。',
  index_invalid: '课程知识库索引不可用，请重新建立索引。',
};

export class CourseAssistantClientError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status = 503,
  ) {
    super(message);
    this.name = 'CourseAssistantClientError';
  }
}

export function courseAssistantErrorResponse(cause: unknown): Response {
  const failure =
    cause instanceof CourseAssistantClientError
      ? cause
      : new CourseAssistantClientError(
          '无法连接课程问答服务，请确认课程服务已启动。',
          'course_unavailable',
        );
  return Response.json(
    { error: { code: failure.code, message: failure.message } },
    { status: failure.status, headers: NO_STORE },
  );
}

/** Publish only the read/ask surface at an explicitly configured HTTPS origin. */
export function requireCourseRequest(request: Request): Response | null {
  const policy = enforceRequestPolicy(request);
  if (policy) {
    return courseAssistantErrorResponse(
      new CourseAssistantClientError(
        '请求来源未被允许。',
        'access_denied',
        403,
      ),
    );
  }
  if (!isTrustedLocalRequest(request) && !isPublishedCourseRequest(request)) {
    return courseAssistantErrorResponse(
      new CourseAssistantClientError('页面不存在。', 'not_found', 404),
    );
  }
  return null;
}

function isPublishedCourseRequest(request: Request): boolean {
  const configured = env.COURSE_ASSISTANT_PUBLIC_ORIGIN?.trim();
  if (!configured) return false;
  try {
    const allowed = new URL(configured);
    if (
      allowed.protocol !== 'https:' || allowed.pathname !== '/' ||
      allowed.username || allowed.password || allowed.search || allowed.hash
    ) return false;
    const incoming = new URL(request.url);
    const forwardedHost = request.headers.get('Host')?.trim();
    const forwardedProtocol = request.headers.get('X-Forwarded-Proto')?.trim();
    // The production reverse proxy overwrites Host and X-Forwarded-Proto.
    // Public access never changes the local/admin/robot/executor boundaries.
    const publicOrigin = forwardedHost && forwardedProtocol
      ? new URL(`${forwardedProtocol}://${forwardedHost}`).origin
      : incoming.origin;
    return publicOrigin === allowed.origin;
  } catch {
    return false;
  }
}

function baseOrigin(): string {
  const configured = env.COURSE_ASSISTANT_URL?.trim();
  let url: URL;
  try {
    url = new URL(configured || 'http://127.0.0.1:8001');
  } catch {
    throw badConfiguration();
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw badConfiguration();
  }
  return url.origin;
}

function badConfiguration(): CourseAssistantClientError {
  return new CourseAssistantClientError(
    '课程服务地址必须是本机 HTTP 地址，且不能包含路径或凭据。',
    'course_bad_config',
  );
}

function invalidResponse(): CourseAssistantClientError {
  return new CourseAssistantClientError(
    '课程服务返回了无效内容，请检查服务后重试。',
    'course_invalid_response',
    502,
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= limit &&
    Boolean(value.trim()) &&
    !hasForbiddenControls(value)
  );
}

function hasForbiddenControls(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 && code !== 9 && code !== 10 && code !== 13) return true;
  }
  return false;
}

function count(value: unknown, maximum = 100_000_000): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
  );
}

function filename(value: unknown): value is string {
  return boundedString(value, 300) && !/[\\/\r\n\t]/.test(value);
}

function normalizeStatus(value: unknown): CourseStatus {
  if (
    !record(value) ||
    typeof value.ready !== 'boolean' ||
    typeof value.llm_configured !== 'boolean' ||
    !count(value.document_count, 512) ||
    !count(value.page_count) ||
    !count(value.chunk_count) ||
    !Array.isArray(value.documents) ||
    value.documents.length > 512 ||
    value.documents.length !== value.document_count
  ) {
    throw invalidResponse();
  }
  const documents = value.documents.map((document) => {
    if (
      !record(document) ||
      !filename(document.name) ||
      (document.pages !== null && !count(document.pages))
    ) {
      throw invalidResponse();
    }
    return { name: document.name, pages: document.pages as number | null };
  });
  const result: CourseStatus = {
    ready: value.ready,
    document_count: value.document_count,
    page_count: value.page_count,
    chunk_count: value.chunk_count,
    documents,
    llm_configured: value.llm_configured,
  };
  for (const field of ['has_index', 'stale'] as const) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'boolean') throw invalidResponse();
    result[field] = value[field];
  }
  for (const field of ['embedding_backend', 'embedding_model'] as const) {
    if (value[field] === undefined) continue;
    if (!boundedString(value[field], 300)) throw invalidResponse();
    result[field] = value[field];
  }
  if (value.indexed_at !== undefined) {
    if (value.indexed_at !== null && !boundedString(value.indexed_at, 100)) {
      throw invalidResponse();
    }
    result.indexed_at = value.indexed_at as string | null;
  }
  return result;
}

function normalizeSource(value: unknown): CourseSource {
  if (
    !record(value) ||
    !boundedString(value.id, 128) ||
    !filename(value.filename) ||
    !count(value.page) ||
    value.page < 1 ||
    !boundedString(value.excerpt, 16_000) ||
    typeof value.score !== 'number' ||
    !Number.isFinite(value.score)
  ) {
    throw invalidResponse();
  }
  return {
    id: value.id,
    filename: value.filename,
    page: value.page,
    excerpt: value.excerpt,
    score: value.score,
  };
}

function normalizeAnswer(value: unknown, question: string): CourseAnswer {
  if (
    !record(value) ||
    !boundedString(value.question, 2000) ||
    value.question !== question ||
    !boundedString(value.answer, 64_000) ||
    !Array.isArray(value.sources) ||
    value.sources.length > 20 ||
    (value.mode !== 'llm' &&
      value.mode !== 'retrieval_only' &&
      value.mode !== 'no_match') ||
    (value.warning !== undefined && !boundedString(value.warning, 1000)) ||
    (value.mode === 'no_match' && value.sources.length !== 0) ||
    (value.mode !== 'no_match' && value.sources.length === 0)
  ) {
    throw invalidResponse();
  }
  return {
    question: value.question,
    answer: value.answer,
    sources: value.sources.map(normalizeSource),
    mode: value.mode,
    ...(value.warning === undefined ? {} : { warning: value.warning }),
  };
}

/** Keep the deadline active while consuming response bodies, too. */
async function withDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(
        new CourseAssistantClientError(
          '课程服务响应超时，请稍后重试。',
          'course_timeout',
          504,
        ),
      );
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } catch (cause) {
    if (cause instanceof CourseAssistantClientError) throw cause;
    if (controller.signal.aborted) {
      throw new CourseAssistantClientError(
        '课程服务响应超时，请稍后重试。',
        'course_timeout',
        504,
      );
    }
    throw new CourseAssistantClientError(
      '无法连接课程问答服务，请确认课程服务已启动。',
      'course_unavailable',
    );
  } finally {
    clearTimeout(timer!);
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw invalidResponse();
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text = '';
  let bytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw invalidResponse();
      }
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } catch (cause) {
    if (cause instanceof CourseAssistantClientError) throw cause;
    throw invalidResponse();
  } finally {
    reader.releaseLock();
  }
}

async function readBackendJson(response: Response): Promise<unknown> {
  const contentType = response.headers
    .get('Content-Type')
    ?.split(';')[0]
    .trim()
    .toLowerCase();
  if (contentType !== 'application/json') {
    await response.body?.cancel();
    throw invalidResponse();
  }
  let value: unknown;
  try {
    value = JSON.parse(await readBoundedText(response, 512 * 1024));
  } catch (cause) {
    if (cause instanceof CourseAssistantClientError) throw cause;
    throw invalidResponse();
  }
  if (!response.ok) {
    if (
      response.status >= 400 &&
      response.status <= 599 &&
      record(value) &&
      record(value.error) &&
      boundedString(value.error.code, 80) &&
      boundedString(value.error.message, 1000) &&
      Object.hasOwn(UPSTREAM_ERRORS, value.error.code)
    ) {
      throw new CourseAssistantClientError(
        UPSTREAM_ERRORS[value.error.code],
        value.error.code,
        response.status,
      );
    }
    throw invalidResponse();
  }
  return value;
}

function csrfSession(
  response: Response,
  html: string,
): { cookie: string; token: string } {
  let token = '';
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const attributes = new Map<string, string>();
    for (const attribute of input[0].matchAll(
      /([A-Za-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
    )) {
      attributes.set(
        attribute[1].toLowerCase(),
        attribute[2] ?? attribute[3] ?? attribute[4],
      );
    }
    if (
      attributes.get('name') === 'csrfmiddlewaretoken' &&
      attributes.get('type')?.toLowerCase() === 'hidden' &&
      TOKEN_PATTERN.test(attributes.get('value') ?? '')
    ) {
      token = attributes.get('value')!;
      break;
    }
  }
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies = headers.getSetCookie?.() ?? [];
  if (!cookies.length) cookies.push(headers.get('Set-Cookie') ?? '');
  let secret = '';
  for (const cookie of cookies) {
    const value =
      cookie.match(/(?:^|,\s*)csrftoken=([A-Za-z0-9]+)(?=;|,|$)/)?.[1] ?? '';
    if (TOKEN_PATTERN.test(value)) {
      secret = value;
      break;
    }
  }
  if (!token || !secret) throw invalidResponse();
  return { cookie: `csrftoken=${secret}`, token };
}

export async function fetchCourseStatus(): Promise<CourseStatus> {
  const origin = baseOrigin();
  return withDeadline(8000, async (signal) => {
    const response = await fetchBackend(`${origin}/api/status/`, {
      headers: { Accept: 'application/json' },
      signal,
    });
    return normalizeStatus(await readBackendJson(response));
  });
}

export async function askCourseQuestion(
  question: string,
): Promise<CourseAnswer> {
  if (!boundedString(question, 2000) || question !== question.trim()) {
    throw new CourseAssistantClientError(
      '请输入 1 至 2000 字的课程问题。',
      'invalid_question',
      400,
    );
  }
  const origin = baseOrigin();
  return withDeadline(90_000, async (signal) => {
    const home = await fetchBackend(`${origin}/`, {
      headers: { Accept: 'text/html' },
      signal,
    });
    if (!home.ok) {
      await home.body?.cancel();
      throw invalidResponse();
    }
    const session = csrfSession(home, await readBoundedText(home, 512 * 1024));
    const response = await fetchBackend(`${origin}/api/ask/`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Cookie: session.cookie,
        'X-CSRFToken': session.token,
        Origin: origin,
        Referer: `${origin}/`,
      },
      body: JSON.stringify({ question }),
      signal,
    });
    return normalizeAnswer(await readBackendJson(response), question);
  });
}

async function fetchBackend(url: string, init: RequestInit): Promise<Response> {
  const response = await fetch(url, {
    ...init,
    cache: 'no-store',
    // workerd supports manual/follow; explicitly reject redirects before reading a body.
    redirect: 'manual',
  });
  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  ) {
    await response.body?.cancel();
    throw invalidResponse();
  }
  return response;
}
