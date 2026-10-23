import {
  programErrorResponse,
  readOwnedProgramJob,
} from '@/lib/server/workflow-program-store';
import {
  enforceExecutionAccess,
  enforceRateLimit,
} from '@/lib/server/security';

type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, context: Context) {
  const denied =
    enforceExecutionAccess(request, { allowConsumerClientMarker: true }) ??
    enforceRateLimit(request, {
      label: 'program-poll',
      limit: 180,
      windowMs: 60_000,
    });
  if (denied) return denied;
  try {
    return Response.json(
      { job: await readOwnedProgramJob(request, (await context.params).id) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return programErrorResponse(cause);
  }
}
export async function DELETE(request: Request, context: Context) {
  const denied =
    enforceExecutionAccess(request) ??
    enforceRateLimit(request, {
      label: 'program-cancel',
      limit: 30,
      windowMs: 60_000,
    });
  if (denied) return denied;
  try {
    return Response.json(
      {
        job: await readOwnedProgramJob(
          request,
          (await context.params).id,
          true,
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return programErrorResponse(cause);
  }
}
