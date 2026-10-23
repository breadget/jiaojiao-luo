import { env } from 'cloudflare:workers';

const ALLOWED_RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Disposition',
  'Retry-After',
];

export class PythonExecutorClientError extends Error {
  readonly status: number;

  constructor(message: string, status = 503) {
    super(message);
    this.name = 'PythonExecutorClientError';
    this.status = status;
  }
}

function executorConfig(): { baseUrl: URL; token: string } {
  const rawUrl = env.PYTHON_EXECUTOR_URL?.trim() ?? '';
  const token = env.PYTHON_EXECUTOR_TOKEN?.trim() ?? '';
  if (!rawUrl || token.length < 32) {
    throw new PythonExecutorClientError('Python Executor 尚未安全配置。');
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawUrl);
  } catch {
    throw new PythonExecutorClientError('Python Executor 地址配置无效。');
  }
  if (
    baseUrl.protocol !== 'http:' ||
    (baseUrl.hostname !== '127.0.0.1' &&
      baseUrl.hostname !== '[::1]' &&
      baseUrl.hostname !== '::1') ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.pathname !== '/' ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new PythonExecutorClientError(
      'Python Executor 必须配置为无凭据的 loopback HTTP 根地址。',
    );
  }
  return { baseUrl, token };
}

export async function callPythonExecutor(
  path: string,
  options: {
    method: 'GET' | 'POST' | 'DELETE';
    body?: BodyInit | null;
    headers?: HeadersInit;
    timeoutMs?: number;
  },
): Promise<Response> {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new PythonExecutorClientError('Python Executor 内部路径无效。');
  }
  const { baseUrl, token } = executorConfig();
  const url = new URL(path.slice(1), baseUrl);
  if (url.origin !== baseUrl.origin) {
    throw new PythonExecutorClientError('Python Executor 内部路径越界。');
  }
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body,
      // workerd 只支持 follow / manual；用 manual 并自己拒绝 3xx，
      // 效果等同于「绝不跟随重定向」。
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs ?? 75_000),
    });
  } catch {
    throw new PythonExecutorClientError('Python Executor 当前不可用。');
  }
  if (
    response.type === 'opaqueredirect' ||
    (response.status >= 300 && response.status < 400)
  ) {
    throw new PythonExecutorClientError('Python Executor 返回了意外的重定向。');
  }
  return response;
}

export function proxyPythonExecutorResponse(upstream: Response): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  for (const name of ALLOWED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function pythonExecutorErrorResponse(cause: unknown): Response {
  if (cause instanceof PythonExecutorClientError) {
    return Response.json(
      { error: cause.message, code: 'PYTHON_EXECUTOR_UNAVAILABLE' },
      { status: cause.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(
    { error: 'Python Executor 调用失败。', code: 'PYTHON_EXECUTOR_ERROR' },
    { status: 502, headers: { 'Cache-Control': 'no-store' } },
  );
}
