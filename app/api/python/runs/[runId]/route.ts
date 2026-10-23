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

type Context = { params: Promise<{ runId: string }> };

export async function GET(request: Request, context: Context) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'python-runs-read',
    limit: 60,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const { runId } = await context.params;
  const taskId = new URL(request.url).searchParams.get('taskId')?.trim() ?? '';
  const taskError = await requirePythonTaskCapability(request, taskId);
  if (taskError && !(await consumerOwnsPythonRun(request, taskId, runId))) {
    return taskError;
  }
  try {
    const upstream = await callPythonExecutor(
      `/v1/runs/${encodeURIComponent(runId)}`,
      {
        method: 'GET',
        headers: { 'X-Urtoris-Task-Id': taskId },
        timeoutMs: 10_000,
      },
    );
    return proxyPythonExecutorResponse(upstream);
  } catch (cause) {
    return pythonExecutorErrorResponse(cause);
  }
}

export async function DELETE(request: Request, context: Context) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'python-runs-cancel',
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const { runId } = await context.params;
  const taskId = new URL(request.url).searchParams.get('taskId')?.trim() ?? '';
  const taskError = await requirePythonTaskCapability(request, taskId);
  if (taskError && !(await consumerOwnsPythonRun(request, taskId, runId))) {
    return taskError;
  }
  try {
    const upstream = await callPythonExecutor(
      `/v1/runs/${encodeURIComponent(runId)}`,
      {
        method: 'DELETE',
        headers: { 'X-Urtoris-Task-Id': taskId },
        timeoutMs: 10_000,
      },
    );
    return proxyPythonExecutorResponse(upstream);
  } catch (cause) {
    return pythonExecutorErrorResponse(cause);
  }
}
