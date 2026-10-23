import { LOCAL_CONTROL_RUN_ID_PATTERN } from '@/lib/local-control-protocol';
import { requireLocalControlRequest } from '@/lib/server/local-control-access';
import {
  callLocalControl,
  localControlClientErrorResponse,
  proxyLocalControlResponse,
} from '@/lib/server/local-control-client';
import { enforceRateLimit } from '@/lib/server/security';

type Context = { params: Promise<{ runId: string }> };

async function forward(
  request: Request,
  context: Context,
  method: 'GET' | 'DELETE',
): Promise<Response> {
  const accessError = requireLocalControlRequest(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: method === 'GET' ? 'local-control-read' : 'local-control-cancel',
    limit: method === 'GET' ? 120 : 30,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const { runId } = await context.params;
  const taskId = new URL(request.url).searchParams.get('taskId')?.trim() ?? '';
  if (!LOCAL_CONTROL_RUN_ID_PATTERN.test(runId) || !taskId) {
    return Response.json(
      { error: '本机命令编号或任务编号无效。', code: 'INVALID_REQUEST' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  try {
    const upstream = await callLocalControl(
      `/v1/runs/${encodeURIComponent(runId)}`,
      {
        method,
        headers: { 'X-Urtoris-Local-Task-Id': taskId },
        timeoutMs: 10_000,
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

export async function DELETE(request: Request, context: Context) {
  return forward(request, context, 'DELETE');
}
