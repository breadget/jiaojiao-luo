import {
  callPythonExecutor,
  proxyPythonExecutorResponse,
  pythonExecutorErrorResponse,
} from '@/lib/server/python-executor-client';
import { requirePythonTaskCapability } from '@/lib/server/python-task-capability';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';

const RUN_REQUEST_BYTES = 128 * 1024;

export async function GET(request: Request) {
  const accessError = enforceExecutionAccess(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'python-runs-read-list',
    limit: 60,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const taskId = new URL(request.url).searchParams.get('taskId')?.trim() ?? '';
  const taskError = await requirePythonTaskCapability(request, taskId);
  if (taskError) return taskError;
  try {
    const upstream = await callPythonExecutor('/v1/runs', {
      method: 'GET',
      headers: { 'X-Urtoris-Task-Id': taskId },
      timeoutMs: 10_000,
    });
    return proxyPythonExecutorResponse(upstream);
  } catch (cause) {
    return pythonExecutorErrorResponse(cause);
  }
}

export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'python-runs-write',
    limit: 12,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request, RUN_REQUEST_BYTES);
  if ('response' in parsed) return parsed.response;
  const taskId =
    typeof parsed.body.task_id === 'string' ? parsed.body.task_id : '';
  const taskError = await requirePythonTaskCapability(request, taskId);
  if (taskError) return taskError;
  try {
    const upstream = await callPythonExecutor('/v1/runs', {
      method: 'POST',
      body: JSON.stringify(parsed.body),
      headers: { 'Content-Type': 'application/json' },
    });
    return proxyPythonExecutorResponse(upstream);
  } catch (cause) {
    return pythonExecutorErrorResponse(cause);
  }
}
