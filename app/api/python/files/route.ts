import {
  callPythonExecutor,
  proxyPythonExecutorResponse,
  pythonExecutorErrorResponse,
} from '@/lib/server/python-executor-client';
import { requirePythonTaskCapability } from '@/lib/server/python-task-capability';
import {
  enforceExecutionAccess,
  enforceRateLimit,
} from '@/lib/server/security';

const MAXIMUM_INPUT_BYTES = 25 * 1024 * 1024;

async function readInput(request: Request): Promise<ArrayBuffer | Response> {
  const advertised = Number(request.headers.get('Content-Length') ?? 0);
  if (Number.isFinite(advertised) && advertised > MAXIMUM_INPUT_BYTES) {
    return Response.json(
      { error: '单个输入文件不能超过 25 MiB。' },
      { status: 413 },
    );
  }
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      if (!part.value.byteLength) continue;
      total += part.value.byteLength;
      if (total > MAXIMUM_INPUT_BYTES) {
        await reader.cancel();
        return Response.json(
          { error: '单个输入文件不能超过 25 MiB。' },
          { status: 413 },
        );
      }
      chunks.push(part.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'python-files',
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const params = new URL(request.url).searchParams;
  const taskId = params.get('taskId')?.trim() ?? '';
  const name = params.get('name')?.trim() ?? '';
  const taskError = await requirePythonTaskCapability(request, taskId);
  if (taskError) return taskError;
  const input = await readInput(request);
  if (input instanceof Response) return input;

  try {
    const upstream = await callPythonExecutor('/v1/files', {
      method: 'POST',
      body: input,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Urtoris-Task-Id': taskId,
        'X-Urtoris-File-Name': name,
      },
      timeoutMs: 30_000,
    });
    return proxyPythonExecutorResponse(upstream);
  } catch (cause) {
    return pythonExecutorErrorResponse(cause);
  }
}
