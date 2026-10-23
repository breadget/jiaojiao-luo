import { env } from 'cloudflare:workers';

const rateBuckets = new Map<string, { startedAt: number; count: number }>();

export const JSON_BODY_LIMIT_BYTES = 32 * 1024;
export const ADMIN_JSON_BODY_LIMIT_BYTES = 64 * 1024;

type RateLimitOptions = {
  limit: number;
  windowMs: number;
  label: string;
};

function jsonError(
  message: string,
  status: number,
  headers?: HeadersInit,
): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Cache-Control', 'no-store');
  return Response.json(
    { error: message },
    {
      status,
      headers: responseHeaders,
    },
  );
}

function requestAddress(request: Request): string {
  return (
    request.headers.get('CF-Connecting-IP')?.trim() ||
    request.headers.get('X-Real-IP')?.trim() ||
    request.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'anonymous'
  );
}

/**
 * 进程内令牌桶。ECS 上的站点是单实例 Worker 进程；即使未来扩容，
 * 它仍能作为每实例的第一层保护，边缘层可再叠加更严格的全局限流。
 */
export function enforceRateLimit(
  request: Request,
  options: RateLimitOptions,
): Response | null {
  const now = Date.now();
  const key = `${options.label}:${requestAddress(request)}`;

  for (const [bucketKey, bucket] of rateBuckets) {
    if (now - bucket.startedAt > options.windowMs * 2) {
      rateBuckets.delete(bucketKey);
    }
  }

  const current = rateBuckets.get(key);
  const bucket =
    !current || now - current.startedAt >= options.windowMs
      ? { startedAt: now, count: 0 }
      : current;
  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (bucket.count <= options.limit) return null;

  const retryAfter = Math.max(
    1,
    Math.ceil((bucket.startedAt + options.windowMs - now) / 1000),
  );
  return jsonError('请求过于频繁，请稍后重试。', 429, {
    'Retry-After': String(retryAfter),
    'X-RateLimit-Limit': String(options.limit),
    'X-RateLimit-Remaining': '0',
  });
}

/** 读取并限制真实请求体大小，避免只依赖可伪造的 Content-Length。 */
export async function readJsonObject(
  request: Request,
  maxBytes = JSON_BODY_LIMIT_BYTES,
): Promise<{ body: Record<string, unknown> } | { response: Response }> {
  const advertisedLength = Number(request.headers.get('Content-Length') ?? 0);
  if (
    Number.isFinite(advertisedLength) &&
    advertisedLength >= 0 &&
    advertisedLength > maxBytes
  ) {
    return {
      response: jsonError(
        `请求内容不能超过 ${Math.round(maxBytes / 1024)} KB。`,
        413,
      ),
    };
  }

  let bytes: Uint8Array;
  try {
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          if (!part.value?.byteLength) continue;
          totalBytes += part.value.byteLength;
          if (totalBytes > maxBytes) {
            await reader.cancel();
            return {
              response: jsonError(
                `请求内容不能超过 ${Math.round(maxBytes / 1024)} KB。`,
                413,
              ),
            };
          }
          chunks.push(part.value);
        }
      } finally {
        reader.releaseLock();
      }

      bytes = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
    } else {
      bytes = new Uint8Array(await request.arrayBuffer());
    }
  } catch {
    return { response: jsonError('无法读取请求内容。', 400) };
  }
  if (bytes.byteLength > maxBytes) {
    return {
      response: jsonError(
        `请求内容不能超过 ${Math.round(maxBytes / 1024)} KB。`,
        413,
      ),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { response: jsonError('请求内容必须是有效 JSON。', 400) };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { response: jsonError('请求内容必须是 JSON 对象。', 400) };
  }
  return { body: parsed as Record<string, unknown> };
}

function timingSafeEqual(a: string, b: string): boolean {
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    diff |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  }
  return diff === 0;
}

function adminToken(request: Request): string {
  const authorization = request.headers.get('Authorization')?.trim() ?? '';
  if (authorization.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }
  return request.headers.get('X-Urtoris-Admin-Token')?.trim() || '';
}

/** 独立于公开执行 API 的管理令牌。 */
export function requireAdmin(request: Request): Response | null {
  const expected = env.URTORIS_ADMIN_TOKEN?.trim();
  if (expected && timingSafeEqual(adminToken(request), expected)) return null;

  // 本机 / 内网访问直接视为管理员会话：本地开发不用再粘贴令牌。
  // 公网入口（域名或公网 IP）仍然必须带令牌，行为与以前完全一致。
  if (isTrustedLocalRequest(request)) return null;

  if (!expected) {
    return jsonError('服务端尚未配置管理员访问令牌。', 503);
  }
  return jsonError('管理员访问令牌无效。', 401, {
    'WWW-Authenticate': 'Bearer',
  });
}

/** 关掉「本机免令牌」时把这个环境变量设成 0 / false / off。 */
const ADMIN_TRUST_LOCAL_ENV = 'URTORIS_ADMIN_TRUST_LOCAL';

function requestHostname(request: Request): string | null {
  const forwardedHost = request.headers
    .get('X-Forwarded-Host')
    ?.split(',')[0]
    ?.trim();
  const candidates = [
    forwardedHost,
    request.headers.get('Host')?.trim(),
    (() => {
      try {
        return new URL(request.url).host;
      } catch {
        return undefined;
      }
    })(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const withoutPort = candidate.startsWith('[')
      ? candidate.slice(0, candidate.indexOf(']') + 1)
      : candidate.split(':')[0];
    const hostname = withoutPort.replace(/^\[|\]$/g, '').toLowerCase();
    if (hostname) return hostname;
  }
  return null;
}

/** loopback / RFC1918 私网 / 链路本地 / .local，都算「自己人」。 */
export function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return false;
  if (
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    return true;
  }
  if (hostname === '0.0.0.0' || hostname === '::') return true;

  if (hostname.includes(':')) {
    // IPv6 唯一本地地址 fc00::/7
    const prefix = hostname.slice(0, 2);
    return (
      prefix === 'fc' ||
      prefix === 'fd' ||
      prefix === 'fe8' ||
      prefix === 'fe9' ||
      prefix === 'fea' ||
      prefix === 'feb'
    );
  }

  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => Number(part));
  if (
    octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return false;
  }
  const [a, b] = octets;
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/**
 * 这次请求是不是来自「本机 / 内网」。
 *
 * 三条一起满足才算：
 *  1. Host（含反代的 X-Forwarded-Host）落在 loopback / 私网 / .local；
 *  2. 请求**没有**经过代理：只要带 `X-Forwarded-For` / `Forwarded`，就按公网对待。
 *     这一条很关键 —— nginx 传的是 `$host`，远程访客可以用 `Host: localhost` 伪装，
 *     但代理一定会加上 X-Forwarded-*，所以带代理头就不认“本机”。
 *  3. 不是跨站请求（跨站由 `enforceRequestPolicy` 再挡一道）。
 *
 * 生产上想彻底关掉这个便捷通道：设 `URTORIS_ADMIN_TRUST_LOCAL=0`。
 */
export function isTrustedLocalRequest(request: Request): boolean {
  const toggle = env[ADMIN_TRUST_LOCAL_ENV]?.trim().toLowerCase();
  if (toggle === '0' || toggle === 'false' || toggle === 'off') return false;
  if (request.headers.get('Sec-Fetch-Site')?.toLowerCase() === 'cross-site') {
    return false;
  }

  const hostname = requestHostname(request);
  if (!hostname || !isPrivateHostname(hostname)) return false;

  // 经过代理时，Host 是可以被远程访客伪装的（nginx 传的是 `$host`），
  // 所以还要看真实来源地址：本机 dev server 会补 127.0.0.1，
  // 公网 nginx 补的最后一个 X-Forwarded-For / X-Real-IP 才是真客户端 IP。
  for (const address of forwardedAddresses(request)) {
    if (!isPrivateHostname(address)) return false;
  }
  return true;
}

/** 代理链上能拿到的客户端地址；取最后一段（由我们自己这层的反代写入）。 */
function forwardedAddresses(request: Request): string[] {
  const addresses: string[] = [];
  const forwardedFor = request.headers.get('X-Forwarded-For');
  if (forwardedFor) {
    const entries = forwardedFor
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const last = entries.at(-1);
    if (last) addresses.push(last.replace(/^\[|\]$/g, ''));
  }
  const realIp = request.headers.get('X-Real-IP')?.trim();
  if (realIp) addresses.push(realIp.replace(/^\[|\]$/g, ''));
  const forwarded = request.headers.get('Forwarded');
  if (forwarded) {
    for (const part of forwarded.split(',')) {
      const match = part.match(/for=\s*"?(\[[^\]]+\]|[^;",\s]+)"?/i);
      if (match) addresses.push(match[1].replace(/^\[|\]$/g, ''));
    }
  }
  return addresses;
}

/**
 * JSON 执行接口只接受同源浏览器请求；没有 Origin 的 CLI/WebMCP 请求仍可用。
 * 显式 cross-site 请求直接拒绝，避免把浏览器会话当成执行授权。
 */
export function enforceRequestPolicy(request: Request): Response | null {
  const fetchSite = request.headers.get('Sec-Fetch-Site')?.toLowerCase();
  if (fetchSite === 'cross-site') {
    return jsonError('跨站请求被拒绝。', 403);
  }

  const origin = request.headers.get('Origin')?.trim();
  if (!origin) return null;

  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return jsonError('请求来源无效。', 403);
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return jsonError('请求来源无效。', 403);
  }

  const allowedOrigins = new Set<string>();
  try {
    const requestUrl = new URL(request.url);
    allowedOrigins.add(requestUrl.origin.toLowerCase());
  } catch {
    // request.url 由运行时提供，解析失败时只依赖反代头 / 配置白名单。
  }

  const forwardedHost =
    request.headers.get('X-Forwarded-Host')?.split(',')[0]?.trim() ||
    request.headers.get('Host')?.trim();
  const forwardedProtocol =
    request.headers.get('X-Forwarded-Proto')?.split(',')[0]?.trim() || '';
  if (
    forwardedHost &&
    (forwardedProtocol === 'http' || forwardedProtocol === 'https')
  ) {
    try {
      allowedOrigins.add(
        new URL(`${forwardedProtocol}://${forwardedHost}`).origin.toLowerCase(),
      );
    } catch {
      // 忽略错误的反代头，保留其余同源和显式白名单检查。
    }
  }

  for (const configured of (env.URTORIS_ALLOWED_ORIGINS ?? '').split(',')) {
    const value = configured.trim();
    if (!value) continue;
    try {
      const configuredUrl = new URL(value);
      if (
        (configuredUrl.protocol === 'http:' ||
          configuredUrl.protocol === 'https:') &&
        configuredUrl.pathname === '/' &&
        !configuredUrl.search &&
        !configuredUrl.hash &&
        !configuredUrl.username &&
        !configuredUrl.password
      ) {
        allowedOrigins.add(configuredUrl.origin.toLowerCase());
      }
    } catch {
      // 忽略错误配置，保留同源检查。
    }
  }

  if (!allowedOrigins.has(originUrl.origin.toLowerCase())) {
    return jsonError('请求来源未被允许。', 403);
  }
  return null;
}

/**
 * 执行接口的访问边界：浏览器必须是同源请求；无 Origin 的服务端调用
 * 需要使用公开 API 令牌。这样既保留工作台调用能力，也不会把 POST
 * 当成一个可被任意跨站表单触发的匿名执行端点。
 */
export function enforceExecutionAccess(
  request: Request,
  options: { allowConsumerClientMarker?: boolean } = {},
): Response | null {
  const policy = enforceRequestPolicy(request);
  if (policy) return policy;

  const fetchSite = request.headers.get('Sec-Fetch-Site')?.toLowerCase();
  if (
    request.headers.get('Origin')?.trim() ||
    fetchSite === 'same-origin' ||
    fetchSite === 'same-site'
  ) {
    return null;
  }

  // Some embedded browsers omit both Origin and Sec-Fetch-Site on same-origin
  // GETs. The consumer UI opts into this narrow marker via a custom header;
  // because it is non-simple, a cross-origin browser cannot send it without a
  // preflight that this endpoint does not permit. Keep it opt-in per route.
  if (
    options.allowConsumerClientMarker &&
    request.headers.get('X-Urtoris-Consumer-Client') === '1'
  ) {
    return null;
  }

  const expected = env.URTORIS_API_TOKEN?.trim();
  const authorization = request.headers.get('Authorization')?.trim() ?? '';
  const supplied = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  if (expected && timingSafeEqual(supplied, expected)) return null;

  return jsonError('仅允许同源请求或携带有效 API 访问令牌。', 401, {
    'WWW-Authenticate': 'Bearer',
  });
}
