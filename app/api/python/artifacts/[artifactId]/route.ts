import {
  callPythonExecutor,
  proxyPythonExecutorResponse,
  pythonExecutorErrorResponse,
} from '@/lib/server/python-executor-client';
import { requirePythonTaskCapability } from '@/lib/server/python-task-capability';
import { consumerOwnsPythonRun } from '@/lib/server/consumer-store';
import {
  enforceExecutionAccess,
  enforceRateLimit,
} from '@/lib/server/security';

type Context = { params: Promise<{ artifactId: string }> };

export async function GET(request: Request, context: Context) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'python-artifacts-read',
    limit: 60,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const { artifactId } = await context.params;
  const params = new URL(request.url).searchParams;
  const taskId = params.get('taskId')?.trim() ?? '';
  const runId = params.get('runId')?.trim() ?? '';
  const taskError = await requirePythonTaskCapability(request, taskId);
  if (taskError && !(await consumerOwnsPythonRun(request, taskId, runId))) {
    return taskError;
  }
  try {
    const upstream = await callPythonExecutor(
      `/v1/artifacts/${encodeURIComponent(artifactId)}`,
      {
        method: 'GET',
        headers: {
          'X-Urtoris-Task-Id': taskId,
          'X-Urtoris-Run-Id': runId,
        },
        timeoutMs: 30_000,
      },
    );
    return proxyPythonExecutorResponse(upstream);
  } catch (cause) {
    return pythonExecutorErrorResponse(cause);
  }
}
