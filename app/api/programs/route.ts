import {
  describeProgram,
  programErrorResponse,
} from '@/lib/server/workflow-program-store';
import { programExecutorConfigured } from '@/lib/server/workflow-program-client';
import {
  enforceExecutionAccess,
  enforceRateLimit,
} from '@/lib/server/security';

export async function GET(request: Request) {
  const denied =
    enforceExecutionAccess(request, { allowConsumerClientMarker: true }) ??
    enforceRateLimit(request, {
      label: 'program-description',
      limit: 90,
      windowMs: 60_000,
    });
  if (denied) return denied;
  const id = new URL(request.url).searchParams.get('workflowId')?.trim();
  if (!id || id.length > 100)
    return Response.json({ error: '缺少有效的工作流编号。' }, { status: 400 });
  try {
    return Response.json(
      {
        program: await describeProgram(id),
        available: programExecutorConfigured(),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return programErrorResponse(cause);
  }
}
