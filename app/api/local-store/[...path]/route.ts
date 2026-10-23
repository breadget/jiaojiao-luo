import { requireLocalControlRequest } from '@/lib/server/local-control-access';
import {
  callLocalControl,
  localControlClientErrorResponse,
  proxyLocalControlResponse,
} from '@/lib/server/local-control-client';
import { enforceRateLimit } from '@/lib/server/security';

/**
 * 本机记录与项目的存储通道。
 *
 * 位置由用户自己选，内容写在那台 Mac 上；这条路由只对本机同源请求开放，
 * 线上站点拿不到任何记录。
 */

type Context = { params: Promise<{ path?: string[] }> };

const SEGMENT_PATTERN = /^(root|pick|[a-z]+|[A-Za-z0-9][A-Za-z0-9._:-]{0,79})$/;
const REQUEST_BYTES_LIMIT = 512 * 1024;

function invalid(message: string): Response {
  return Response.json(
    { error: message, code: 'INVALID_REQUEST' },
    { status: 400, headers: { 'Cache-Control': 'no-store' } },
  );
}

async function forward(
  request: Request,
  context: Context,
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
): Promise<Response> {
  const accessError = requireLocalControlRequest(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'local-store',
    limit: 120,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const { path = [] } = await context.params;
  if (
    path.length === 0 ||
    path.length > 3 ||
    path[0] !== 'store' ||
    path.some((segment) => !SEGMENT_PATTERN.test(segment))
  ) {
    return invalid('本机存储路径无效。');
  }

  let body: string | undefined;
  if (method === 'PUT' || method === 'POST') {
    body = await request.text();
    if (new TextEncoder().encode(body).length > REQUEST_BYTES_LIMIT) {
      return invalid('要保存的内容太大。');
    }
  }

  try {
    const upstream = await callLocalControl(
      `/v1/${path.map(encodeURIComponent).join('/')}`,
      {
        method,
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body }),
        // 选文件夹时 macOS 对话框会一直开着，等到用户点完为止。
        timeoutMs: 200_000,
      },
    );
    return proxyLocalControlResponse(upstream);
  } catch (cause) {
    return localControlClientErrorResponse(cause);
  }
}

export async function GET(request: Request, context: Context) {
  return forward(request, context, 'GET');
}

export async function PUT(request: Request, context: Context) {
  return forward(request, context, 'PUT');
}

export async function POST(request: Request, context: Context) {
  return forward(request, context, 'POST');
}

export async function DELETE(request: Request, context: Context) {
  return forward(request, context, 'DELETE');
}
