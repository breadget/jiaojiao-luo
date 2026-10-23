import { readLocalControlInfo } from '@/lib/local-control-protocol';
import { requireLocalControlRequest } from '@/lib/server/local-control-access';
import { getLocalControlInfo } from '@/lib/server/local-control-agent-runtime';
import { localControlClientErrorResponse } from '@/lib/server/local-control-client';

export async function GET(request: Request) {
  const accessError = requireLocalControlRequest(request);
  if (accessError) return accessError;
  try {
    const info = await getLocalControlInfo();
    if (!readLocalControlInfo(info)) {
      return Response.json(
        {
          error: '本机控制服务身份信息无效。',
          code: 'LOCAL_CONTROL_UNAVAILABLE',
          local: true,
        },
        { status: 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    return Response.json(
      { available: true, local: true, info },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    const response = localControlClientErrorResponse(cause);
    const payload = (await response.json()) as Record<string, unknown>;
    return Response.json(
      { ...payload, available: false, local: true },
      { status: response.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
