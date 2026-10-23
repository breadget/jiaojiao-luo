import { timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DockerSandboxBackend } from './docker-runner';
import { PythonExecutor } from './executor';
import {
  EXECUTOR_LIMITS,
  ToolRequestError,
  toolErrorEnvelope,
} from './protocol';
import { ExecutorStorage } from './storage';

const RUN_REQUEST_BYTES = 128 * 1024;

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.byteLength),
    ...extraHeaders,
  });
  response.end(bytes);
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const authorization = request.headers.authorization?.trim() ?? '';
  const supplied = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.byteLength === expectedBytes.byteLength &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

async function readLimited(
  request: IncomingMessage,
  maximumBytes: number,
): Promise<Buffer> {
  const advertised = request.headers['content-length'];
  if (advertised !== undefined) {
    const length = Number(advertised);
    if (!Number.isInteger(length) || length < 0) {
      throw new ToolRequestError(
        'INVALID_REQUEST',
        'Content-Length is invalid.',
      );
    }
    if (length > maximumBytes) {
      request.resume();
      throw new ToolRequestError(
        'INVALID_REQUEST',
        `The request body cannot exceed ${maximumBytes} bytes.`,
      );
    }
  }

  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      exceeded = true;
      continue;
    }
    chunks.push(bytes);
  }
  if (exceeded) {
    throw new ToolRequestError(
      'INVALID_REQUEST',
      `The request body cannot exceed ${maximumBytes} bytes.`,
    );
  }
  return Buffer.concat(chunks, total);
}

function requestHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value)
    ? (value[0]?.trim() ?? '')
    : (value?.trim() ?? '');
}

function internalError(response: ServerResponse) {
  json(response, 500, {
    error: {
      code: 'WORKER_ERROR',
      message: 'The executor failed safely.',
      retryable: false,
    },
  });
}

export function createExecutorHttpServer(options: {
  executor: PythonExecutor;
  token: string;
}) {
  if (options.token.length < 32) {
    throw new Error(
      'PYTHON_EXECUTOR_TOKEN must contain at least 32 characters.',
    );
  }

  return createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/health') {
      json(response, 200, { ok: true });
      return;
    }
    if (!authorized(request, options.token)) {
      json(
        response,
        401,
        {
          protocol: 'urtoris.python-executor.v1',
          task_id: null,
          run_id: null,
          status: null,
          error: {
            code: 'UNAUTHORIZED',
            message: 'The executor token is invalid.',
            retryable: false,
          },
        },
        { 'WWW-Authenticate': 'Bearer' },
      );
      return;
    }

    try {
      if (request.method === 'POST' && url.pathname === '/v1/files') {
        const taskId = requestHeader(request, 'x-urtoris-task-id');
        const name = requestHeader(request, 'x-urtoris-file-name');
        const bytes = await readLimited(
          request,
          EXECUTOR_LIMITS.inputFileBytes,
        );
        const file = await options.executor.storeInput({ taskId, name, bytes });
        json(response, 201, { file });
        return;
      }

      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const bytes = await readLimited(request, RUN_REQUEST_BYTES);
        let body: unknown;
        try {
          body = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new ToolRequestError(
            'INVALID_REQUEST',
            'The run request must be valid JSON.',
          );
        }
        const result = await options.executor.submit(body);
        const pending =
          result.status === 'queued' || result.status === 'running';
        json(response, pending ? 202 : 200, result, {
          Location: `/v1/runs/${result.run_id}`,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/v1/runs') {
        const taskId = requestHeader(request, 'x-urtoris-task-id');
        const runs = await options.executor.listRuns(taskId);
        json(response, 200, { runs });
        return;
      }

      const runMatch = url.pathname.match(/^\/v1\/runs\/(run_[a-f0-9]{32})$/);
      if (request.method === 'GET' && runMatch) {
        const taskId = requestHeader(request, 'x-urtoris-task-id');
        const result = await options.executor.getRun(taskId, runMatch[1]);
        if (!result) {
          json(response, 404, {
            error: { code: 'RUN_UNAVAILABLE', message: 'Run not found.' },
          });
          return;
        }
        json(response, 200, result);
        return;
      }
      if (request.method === 'DELETE' && runMatch) {
        const taskId = requestHeader(request, 'x-urtoris-task-id');
        const result = await options.executor.cancelRun(taskId, runMatch[1]);
        if (!result) {
          json(response, 404, {
            error: { code: 'RUN_UNAVAILABLE', message: 'Run not found.' },
          });
          return;
        }
        const pending =
          result.status === 'queued' || result.status === 'running';
        json(response, pending ? 202 : 200, result, {
          Location: `/v1/runs/${result.run_id}`,
        });
        return;
      }

      const artifactMatch = url.pathname.match(
        /^\/v1\/artifacts\/(artifact_[a-f0-9]{32})$/,
      );
      if (request.method === 'GET' && artifactMatch) {
        const taskId = requestHeader(request, 'x-urtoris-task-id');
        const runId = requestHeader(request, 'x-urtoris-run-id');
        const artifact = await options.executor.getArtifact({
          taskId,
          runId,
          artifactId: artifactMatch[1],
        });
        if (!artifact) {
          json(response, 404, {
            error: {
              code: 'ARTIFACT_UNAVAILABLE',
              message: 'Artifact not found.',
            },
          });
          return;
        }
        response.writeHead(200, {
          'Cache-Control': 'private, no-store',
          'Content-Type': artifact.mimeType,
          'Content-Length': String(artifact.size),
          'Content-Disposition': `attachment; filename="${artifact.name}"`,
          'X-Content-Type-Options': 'nosniff',
        });
        const stream = createReadStream(artifact.path);
        stream.once('error', () => response.destroy());
        stream.pipe(response);
        return;
      }

      json(response, 404, {
        error: { code: 'NOT_FOUND', message: 'Not found.' },
      });
    } catch (cause) {
      if (cause instanceof ToolRequestError) {
        json(
          response,
          cause.httpStatus,
          toolErrorEnvelope(cause),
          cause.httpStatus === 429 ? { 'Retry-After': '2' } : {},
        );
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`[python-executor] ${message}\n`);
      internalError(response);
    }
  });
}

async function main() {
  const production = process.env.NODE_ENV === 'production';
  const host = process.env.PYTHON_EXECUTOR_HOST?.trim() || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Python Executor must bind to a loopback address.');
  }
  const port = Number(process.env.PYTHON_EXECUTOR_PORT ?? 3010);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PYTHON_EXECUTOR_PORT is invalid.');
  }
  const token = process.env.PYTHON_EXECUTOR_TOKEN?.trim() ?? '';
  const image =
    process.env.PYTHON_EXECUTOR_IMAGE?.trim() || 'urtoris/python-executor:dev';
  const storageRoot =
    process.env.PYTHON_EXECUTOR_STORAGE_ROOT?.trim() ||
    resolve(process.cwd(), 'work', 'python-executor');
  const storage = new ExecutorStorage(storageRoot);
  const maximumQueuedRuns = Number(
    process.env.PYTHON_EXECUTOR_MAX_QUEUED_RUNS ?? 20,
  );
  if (!Number.isInteger(maximumQueuedRuns) || maximumQueuedRuns < 1) {
    throw new Error('PYTHON_EXECUTOR_MAX_QUEUED_RUNS is invalid.');
  }
  const sandbox = new DockerSandboxBackend({ image, production });
  const executor = new PythonExecutor({
    storage,
    sandbox,
    sandboxImage: image,
    maximumQueuedRuns,
  });
  await executor.init();
  const server = createExecutorHttpServer({ executor, token });
  server.listen(port, host, () => {
    process.stdout.write(
      `[python-executor] listening on http://${host}:${port}\n`,
    );
  });

  const close = () =>
    server.close(() => {
      void executor.shutdown().finally(() => process.exit(0));
    });
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

const entry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (entry === import.meta.url) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[python-executor] startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
