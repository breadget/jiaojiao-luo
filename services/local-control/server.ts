import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { hostname, platform, userInfo } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  LOCAL_CONTROL_LIMITS,
  LOCAL_CONTROL_PROTOCOL,
  LOCAL_CONTROL_RUN_ID_PATTERN,
  LOCAL_CONTROL_TASK_ID_PATTERN,
  type LocalControlInfo,
} from '../../lib/local-control-protocol';
import { LocalControlExecutor } from './executor';
import {
  LocalControlRequestError,
  localControlErrorEnvelope,
  parseLocalControlSubmission,
} from './protocol';
import { LocalControlStorage } from './storage';
import { LocalControlStore, LocalStoreError } from './store';

/** 让用户用 macOS 原生对话框挑一个文件夹；取消返回 null。 */
function pickFolder(): Promise<string | null> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      '/usr/bin/osascript',
      [
        '-e',
        'POSIX path of (choose folder with prompt "选择 Urtoris 保存记录与项目的位置")',
      ],
      { timeout: 180_000 },
      (error, stdout) => {
        if (error) {
          const message = String((error as Error).message ?? '');
          if (/User canceled|-128/.test(message)) {
            resolvePromise(null);
            return;
          }
          reject(
            new LocalStoreError(
              'STORE_UNAVAILABLE',
              '打不开文件夹选择器；可以直接填写绝对路径。',
            ),
          );
          return;
        }
        const path = stdout.trim().replace(/\/+$/, '');
        resolvePromise(path || null);
      },
    );
  });
}

function json(
  response: ServerResponse,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  response.writeHead(status, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.byteLength),
    'X-Content-Type-Options': 'nosniff',
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
    if (!Number.isInteger(length) || length < 0 || length > maximumBytes) {
      request.resume();
      throw new LocalControlRequestError(
        'INVALID_REQUEST',
        `The request body cannot exceed ${maximumBytes} bytes.`,
      );
    }
  }
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (total > maximumBytes) {
      throw new LocalControlRequestError(
        'INVALID_REQUEST',
        `The request body cannot exceed ${maximumBytes} bytes.`,
      );
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0]?.trim() ?? '' : value?.trim() ?? '';
}

function toolError(
  response: ServerResponse,
  code: 'RUN_UNAVAILABLE' | 'INVALID_REQUEST',
  message: string,
  status: number,
): void {
  json(response, status, {
    protocol: LOCAL_CONTROL_PROTOCOL,
    error: { code, message },
  });
}

export function createLocalControlHttpServer(options: {
  executor: LocalControlExecutor;
  token: string;
  defaultCwd: string;
  info: LocalControlInfo;
  store?: LocalControlStore;
}) {
  if (options.token.length < 32) {
    throw new Error('LOCAL_CONTROL_TOKEN must contain at least 32 characters.');
  }

  return createServer(async (request, response) => {
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
          protocol: LOCAL_CONTROL_PROTOCOL,
          error: {
            code: 'UNAUTHORIZED',
            message: 'The local control token is invalid.',
          },
        },
        { 'WWW-Authenticate': 'Bearer' },
      );
      return;
    }

    try {
      if (request.method === 'GET' && url.pathname === '/v1/info') {
        json(response, 200, options.info);
        return;
      }
      if (url.pathname.startsWith('/v1/store')) {
        const store = options.store;
        if (!store) {
          throw new LocalStoreError(
            'STORE_UNAVAILABLE',
            '这个 Control Agent 没有启用本机存储。',
            503,
          );
        }
        if (request.method === 'GET' && url.pathname === '/v1/store') {
          json(response, 200, await store.status());
          return;
        }
        if (request.method === 'PUT' && url.pathname === '/v1/store/root') {
          const bytes = await readLimited(request, 16 * 1024);
          let body: unknown;
          try {
            body = JSON.parse(bytes.toString('utf8'));
          } catch {
            throw new LocalStoreError('INVALID_REQUEST', '请求体不是合法 JSON。');
          }
          const path =
            body && typeof body === 'object' && typeof (body as { path?: unknown }).path === 'string'
              ? (body as { path: string }).path
              : '';
          json(response, 200, await store.setRoot(path));
          return;
        }
        if (request.method === 'POST' && url.pathname === '/v1/store/pick') {
          const picked = await pickFolder();
          if (!picked) {
            json(response, 200, { cancelled: true, status: await store.status() });
            return;
          }
          json(response, 200, {
            cancelled: false,
            status: await store.setRoot(picked),
          });
          return;
        }
        const match = url.pathname.match(
          /^\/v1\/store\/([a-z]+)(?:\/([A-Za-z0-9._:-]{1,80}))?$/,
        );
        if (match) {
          const [, collection, id] = match;
          if (!id) {
            if (request.method !== 'GET') {
              throw new LocalStoreError('INVALID_REQUEST', '不支持的存储操作。');
            }
            json(response, 200, { items: await store.list(collection) });
            return;
          }
          if (request.method === 'GET') {
            json(response, 200, { id, value: await store.read(collection, id) });
            return;
          }
          if (request.method === 'PUT') {
            const bytes = await readLimited(request, 512 * 1024);
            let body: unknown;
            try {
              body = JSON.parse(bytes.toString('utf8'));
            } catch {
              throw new LocalStoreError('INVALID_REQUEST', '请求体不是合法 JSON。');
            }
            const value =
              body && typeof body === 'object' && 'value' in body
                ? (body as { value: unknown }).value
                : undefined;
            if (value === undefined) {
              throw new LocalStoreError('INVALID_REQUEST', '缺少要保存的内容。');
            }
            json(response, 200, await store.write(collection, id, value));
            return;
          }
          if (request.method === 'DELETE') {
            await store.remove(collection, id);
            json(response, 200, { removed: id });
            return;
          }
        }
        throw new LocalStoreError('INVALID_REQUEST', '不支持的存储请求。');
      }
      if (request.method === 'POST' && url.pathname === '/v1/runs') {
        const bytes = await readLimited(
          request,
          LOCAL_CONTROL_LIMITS.requestBytes,
        );
        let body: unknown;
        try {
          body = JSON.parse(bytes.toString('utf8'));
        } catch {
          throw new LocalControlRequestError(
            'INVALID_REQUEST',
            'The run request must be valid JSON.',
          );
        }
        const submission = parseLocalControlSubmission(body, options.defaultCwd);
        const run = await options.executor.submit(submission);
        const pending = run.status === 'queued' || run.status === 'running';
        json(response, pending ? 202 : 200, run, {
          Location: `/v1/runs/${run.run_id}`,
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/runs') {
        const taskId = header(request, 'x-urtoris-local-task-id');
        if (!LOCAL_CONTROL_TASK_ID_PATTERN.test(taskId)) {
          toolError(response, 'INVALID_REQUEST', 'task id is invalid.', 400);
          return;
        }
        json(response, 200, { runs: options.executor.listRuns(taskId) });
        return;
      }

      const match = url.pathname.match(/^\/v1\/runs\/(shell_[a-f0-9]{32})$/);
      if (match && LOCAL_CONTROL_RUN_ID_PATTERN.test(match[1])) {
        const taskId = header(request, 'x-urtoris-local-task-id');
        if (!LOCAL_CONTROL_TASK_ID_PATTERN.test(taskId)) {
          toolError(response, 'INVALID_REQUEST', 'task id is invalid.', 400);
          return;
        }
        if (request.method === 'GET') {
          const run = options.executor.getRun(taskId, match[1]);
          if (!run) {
            toolError(response, 'RUN_UNAVAILABLE', 'Run not found.', 404);
            return;
          }
          json(response, 200, run);
          return;
        }
        if (request.method === 'DELETE') {
          const run = await options.executor.cancelRun(taskId, match[1]);
          if (!run) {
            toolError(response, 'RUN_UNAVAILABLE', 'Run not found.', 404);
            return;
          }
          const pending = run.status === 'queued' || run.status === 'running';
          json(response, pending ? 202 : 200, run, {
            Location: `/v1/runs/${run.run_id}`,
          });
          return;
        }
      }

      toolError(response, 'RUN_UNAVAILABLE', 'Not found.', 404);
    } catch (cause) {
      if (cause instanceof LocalControlRequestError) {
        json(
          response,
          cause.httpStatus,
          localControlErrorEnvelope(cause),
          cause.httpStatus === 429 ? { 'Retry-After': '2' } : {},
        );
        return;
      }
      if (cause instanceof LocalStoreError) {
        json(response, cause.httpStatus, {
          protocol: LOCAL_CONTROL_PROTOCOL,
          error: { code: cause.code, message: cause.message },
        });
        return;
      }
      const message = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`[local-control] ${message}\n`);
      json(response, 500, {
        protocol: LOCAL_CONTROL_PROTOCOL,
        error: {
          code: 'WORKER_ERROR',
          message: 'The local control service failed safely.',
        },
      });
    }
  });
}

async function main(): Promise<void> {
  const host = process.env.LOCAL_CONTROL_HOST?.trim() || '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('Local Control must bind to a loopback address.');
  }
  const port = Number(process.env.LOCAL_CONTROL_PORT ?? 3020);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('LOCAL_CONTROL_PORT is invalid.');
  }
  const token = process.env.LOCAL_CONTROL_TOKEN?.trim() ?? '';
  const defaultCwd =
    process.env.LOCAL_CONTROL_DEFAULT_CWD?.trim() || process.cwd();
  if (!isAbsolute(defaultCwd)) {
    throw new Error('LOCAL_CONTROL_DEFAULT_CWD must be absolute.');
  }
  const shellCandidate =
    process.env.LOCAL_CONTROL_SHELL?.trim() ||
    process.env.SHELL?.trim() ||
    '/bin/zsh';
  if (!isAbsolute(shellCandidate)) {
    throw new Error('LOCAL_CONTROL_SHELL must be an absolute path.');
  }
  const storageRoot =
    process.env.LOCAL_CONTROL_STORAGE_ROOT?.trim() ||
    resolve(process.cwd(), 'work', 'local-control');
  if (!isAbsolute(storageRoot)) {
    throw new Error('LOCAL_CONTROL_STORAGE_ROOT must be absolute.');
  }
  const maximumQueuedRuns = Number(
    process.env.LOCAL_CONTROL_MAX_QUEUED_RUNS ?? 20,
  );
  const storage = new LocalControlStorage(storageRoot);
  const store = new LocalControlStore(
    process.env.LOCAL_CONTROL_STORE_CONFIG?.trim() ||
      resolve(storageRoot, 'store.json'),
  );
  await store.init();
  const executor = new LocalControlExecutor({
    storage,
    shell: shellCandidate,
    defaultCwd,
    maximumQueuedRuns,
  });
  await executor.init();

  let username = process.env.USER || 'current-user';
  let uid: number | null = null;
  try {
    const identity = userInfo();
    username = String(identity.username || username);
    uid = typeof identity.uid === 'number' ? identity.uid : null;
  } catch {
    // Fall back to the inherited process identity label.
  }
  const startedAt = new Date().toISOString();
  const info: LocalControlInfo = {
    protocol: LOCAL_CONTROL_PROTOCOL,
    mode: 'local-user-shell',
    username,
    uid,
    hostname: hostname(),
    platform: platform(),
    shell: shellCandidate,
    default_cwd: defaultCwd,
    concurrency: 1,
    maximum_timeout_seconds: LOCAL_CONTROL_LIMITS.maximumTimeoutSeconds,
    started_at: startedAt,
  };

  const server = createLocalControlHttpServer({
    executor,
    token,
    defaultCwd,
    info,
    store,
  });
  server.listen(port, host, () => {
    process.stdout.write(
      `[local-control] current-user shell enabled on http://${host}:${port}\n`,
    );
  });

  const close = () => {
    server.close(() => {
      void executor.shutdown().finally(() => process.exit(0));
    });
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

const entry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : '';
if (entry === import.meta.url) {
  main().catch((cause: unknown) => {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`[local-control] startup failed: ${message}\n`);
    process.exitCode = 1;
  });
}
