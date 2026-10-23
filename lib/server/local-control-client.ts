import { env } from 'cloudflare:workers';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export class LocalControlClientError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'LOCAL_CONTROL_NOT_CONFIGURED'
      | 'LOCAL_CONTROL_BAD_CONFIG'
      | 'LOCAL_CONTROL_TIMEOUT'
      | 'LOCAL_CONTROL_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'LocalControlClientError';
  }
}

function configuration(): { baseUrl: string; token: string } {
  const rawUrl = env.LOCAL_CONTROL_URL?.trim() ?? '';
  const token = env.LOCAL_CONTROL_TOKEN?.trim() ?? '';
  if (!rawUrl || !token) {
    throw new LocalControlClientError(
      '本机控制服务尚未配置。',
      'LOCAL_CONTROL_NOT_CONFIGURED',
    );
  }
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new LocalControlClientError(
      'LOCAL_CONTROL_URL 不是合法地址。',
      'LOCAL_CONTROL_BAD_CONFIG',
    );
  }
  if (
    url.protocol !== 'http:' ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '/' && url.pathname !== '')
  ) {
    throw new LocalControlClientError(
      '本机控制服务必须使用不带路径或凭据的 loopback HTTP 地址。',
      'LOCAL_CONTROL_BAD_CONFIG',
    );
  }
  if (token.length < 32) {
    throw new LocalControlClientError(
      'LOCAL_CONTROL_TOKEN 长度不足。',
      'LOCAL_CONTROL_BAD_CONFIG',
    );
  }
  return { baseUrl: url.origin, token };
}

export async function callLocalControl(
  path: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
  if (!path.startsWith('/')) {
    throw new LocalControlClientError(
      '本机控制请求路径无效。',
      'LOCAL_CONTROL_BAD_CONFIG',
    );
  }
  const { baseUrl, token } = configuration();
  const controller = new AbortController();
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);
  const timeout = setTimeout(
    () => controller.abort(),
    init.timeoutMs ?? 10_000,
  );
  try {
    return await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    });
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      throw new LocalControlClientError(
        '本机控制服务响应超时。',
        'LOCAL_CONTROL_TIMEOUT',
      );
    }
    throw new LocalControlClientError(
      '无法连接本机控制服务。',
      'LOCAL_CONTROL_UNAVAILABLE',
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function proxyLocalControlResponse(
  upstream: Response,
): Promise<Response> {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Type':
      upstream.headers.get('Content-Type') ??
      'application/json; charset=utf-8',
  });
  const retryAfter = upstream.headers.get('Retry-After');
  if (retryAfter) headers.set('Retry-After', retryAfter);
  return new Response(await upstream.arrayBuffer(), {
    status: upstream.status,
    headers,
  });
}

export function localControlClientErrorResponse(cause: unknown): Response {
  if (cause instanceof LocalControlClientError) {
    return Response.json(
      { error: cause.message, code: cause.code },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(
    {
      error: '本机控制服务调用失败。',
      code: 'LOCAL_CONTROL_UNAVAILABLE',
    },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
