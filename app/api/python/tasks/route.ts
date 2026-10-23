import { createPythonTaskCapability } from '@/lib/server/python-task-capability';
import {
  enforceExecutionAccess,
  enforceRateLimit,
} from '@/lib/server/security';

export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'python-tasks',
    limit: 12,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  try {
    const capability = await createPythonTaskCapability();
    return Response.json(capability, {
      status: 201,
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : '无法创建 Python 任务。';
    return Response.json(
      { error: message, code: 'PYTHON_TASK_UNAVAILABLE' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
