import {
  listOwnedProgramJobs,
  programErrorResponse,
  startOwnedProgram,
} from '@/lib/server/workflow-program-store';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';

export async function GET(request: Request) {
  const denied =
    enforceExecutionAccess(request, { allowConsumerClientMarker: true }) ??
    enforceRateLimit(request, {
      label: 'program-history',
      limit: 90,
      windowMs: 60_000,
    });
  if (denied) return denied;
  const params = new URL(request.url).searchParams;
  const id = params.get('workflowId')?.trim();
  if (!id || id.length > 100)
    return Response.json({ error: '缺少有效的工作流编号。' }, { status: 400 });
  try {
    return Response.json(
      {
        jobs: await listOwnedProgramJobs(
          request,
          id,
          params.get('consumerSessionId') ?? undefined,
        ),
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (cause) {
    return programErrorResponse(cause);
  }
}

export async function POST(request: Request) {
  const denied =
    enforceExecutionAccess(request) ??
    enforceRateLimit(request, {
      label: 'program-start',
      limit: 12,
      windowMs: 60_000,
    });
  if (denied) return denied;
  const parsed = await readJsonObject(request, 48 * 1024);
  if ('response' in parsed) return parsed.response;
  try {
    const result = await startOwnedProgram(request, parsed.body);
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    if (result.setCookie) headers.append('Set-Cookie', result.setCookie);
    return Response.json(
      {
        job: result.job,
        consumerSessionId: result.session.id,
        replayed: result.replayed,
      },
      { status: 202, headers },
    );
  } catch (cause) {
    return programErrorResponse(cause);
  }
}
