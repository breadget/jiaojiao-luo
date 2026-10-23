import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProgramExecutor } from './executor';
import { ProgramStorage } from './storage';
import { JOB_ID, MAX_REQUEST_BYTES, ProgramServiceError } from './safety';

function json(response: ServerResponse, status: number, value: unknown): void {
  if (response.destroyed || response.headersSent) return;
  const bytes = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(bytes.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(bytes);
}

function authorized(request: IncomingMessage, expected: Buffer): boolean {
  const value = request.headers.authorization ?? '';
  const supplied = /^Bearer ([^\r\n]+)$/i.exec(value)?.[1] ?? '';
  return timingSafeEqual(
    createHash('sha256').update(supplied).digest(),
    expected,
  );
}

async function readRequest(request: IncomingMessage): Promise<unknown> {
  if (
    request.headers['content-type']?.split(';')[0].trim().toLowerCase() !==
    'application/json'
  )
    throw new ProgramServiceError(
      'INVALID_REQUEST',
      '请求内容必须为 JSON。',
      415,
    );
  const declared = request.headers['content-length'];
  if (
    declared !== undefined &&
    (!/^\d+$/.test(declared) || Number(declared) > MAX_REQUEST_BYTES)
  )
    throw new ProgramServiceError('REQUEST_TOO_LARGE', '程序请求过大。', 413);
  return new Promise((resolveBody, rejectBody) => {
    let total = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };
    const reject = (error: ProgramServiceError) => {
      cleanup();
      chunks.length = 0;
      // Rejecting an async iterator would destroy IncomingMessage and its
      // socket before the client can read our JSON error. Drain without
      // retaining further bytes; the server's request/socket deadlines remain.
      request.resume();
      rejectBody(error);
    };
    const onData = (part: Buffer | string) => {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      total += bytes.length;
      if (total > MAX_REQUEST_BYTES) {
        reject(
          new ProgramServiceError('REQUEST_TOO_LARGE', '程序请求过大。', 413),
        );
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolveBody(
          JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.concat(chunks, total),
            ),
          ),
        );
      } catch {
        rejectBody(new ProgramServiceError('INVALID_JSON', 'JSON 格式无效。'));
      }
    };
    const onError = () =>
      reject(new ProgramServiceError('INVALID_REQUEST', '读取程序请求失败。'));
    const onAborted = () =>
      reject(new ProgramServiceError('INVALID_REQUEST', '程序请求已中断。'));
    const timer = setTimeout(
      () =>
        reject(
          new ProgramServiceError('REQUEST_TIMEOUT', '读取程序请求超时。', 408),
        ),
      5000,
    );
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

export function createProgramHttpServer(options: {
  executor: ProgramExecutor;
  storage: ProgramStorage;
  token: string;
}) {
  if (
    options.token.length < 32 ||
    options.token.length > 4096 ||
    /[\r\n]/.test(options.token)
  )
    throw new Error('WORKFLOW_PROGRAM_TOKEN must contain 32–4096 characters.');
  const tokenHash = createHash('sha256').update(options.token).digest();
  const server = createServer(async (request, response) => {
    // A rejected body's drain can later be aborted by its sender. The request
    // reader handles active reads; this listener also covers already-rejected reads.
    request.on('error', () => undefined);
    try {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      if (
        request.method === 'GET' &&
        url.pathname === '/health' &&
        !url.search
      ) {
        json(response, 200, { ok: true, service: 'workflow-program' });
        return;
      }
      if (!authorized(request, tokenHash)) {
        response.setHeader('WWW-Authenticate', 'Bearer');
        json(response, 401, {
          error: { code: 'UNAUTHORIZED', message: '程序服务令牌无效。' },
        });
        return;
      }
      if (url.search)
        throw new ProgramServiceError('NOT_FOUND', '程序任务不存在。', 404);
      if (request.method === 'POST' && url.pathname === '/v1/jobs') {
        json(
          response,
          202,
          await options.executor.submit(await readRequest(request)),
        );
        return;
      }
      const match =
        /^\/v1\/jobs\/(program_[a-f0-9]{32})(?:\/artifacts\/(artifact_[a-f0-9]{32}))?$/.exec(
          url.pathname,
        );
      if (!match || !JOB_ID.test(match[1]))
        throw new ProgramServiceError('NOT_FOUND', '程序任务不存在。', 404);
      const [, id, artifactId] = match;
      if (artifactId && request.method === 'GET') {
        const result = await options.storage.readArtifact(id, artifactId);
        if (!result)
          throw new ProgramServiceError('NOT_FOUND', '程序文件不存在。', 404);
        const encodedName = encodeURIComponent(result.artifact.name).replace(
          /['()*]/g,
          (character) =>
            `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        );
        response.writeHead(200, {
          'Content-Type': `${result.artifact.mimeType}; charset=utf-8`,
          'Content-Length': String(result.bytes.length),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': `attachment; filename="program-output.txt"; filename*=UTF-8''${encodedName}`,
        });
        response.end(result.bytes);
        return;
      }
      if (!artifactId && request.method === 'GET') {
        const job = options.executor.get(id);
        if (!job)
          throw new ProgramServiceError('NOT_FOUND', '程序任务不存在。', 404);
        json(response, 200, job);
        return;
      }
      if (!artifactId && request.method === 'DELETE') {
        json(response, 200, await options.executor.cancel(id));
        return;
      }
      throw new ProgramServiceError('NOT_FOUND', '程序接口不存在。', 404);
    } catch (cause) {
      const error =
        cause instanceof ProgramServiceError
          ? cause
          : new ProgramServiceError(
              'WORKER_ERROR',
              '程序服务暂时不可用。',
              500,
            );
      // Never return arbitrary compiler/runtime exceptions or request material.
      if (!request.complete) request.resume();
      json(response, error.status, {
        error: { code: error.code, message: error.message },
      });
    } finally {
      if (!request.complete) request.resume();
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  server.timeout = 15_000;
  server.keepAliveTimeout = 1000;
  server.maxHeadersCount = 40;
  return server;
}

export async function startProgramService(): Promise<void> {
  const port = Number(process.env.WORKFLOW_PROGRAM_PORT ?? '8030');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('WORKFLOW_PROGRAM_PORT is invalid.');
  const storage = new ProgramStorage(
    process.env.WORKFLOW_PROGRAM_STATE_DIR ?? resolve('work/workflow-program'),
  );
  const executor = new ProgramExecutor({ storage });
  const server = createProgramHttpServer({
    executor,
    storage,
    token: process.env.WORKFLOW_PROGRAM_TOKEN ?? '',
  });
  await executor.init();
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      done();
    });
  });
  console.log(`Workflow program service listening on 127.0.0.1:${port}`);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    server.close();
    void executor.close().finally(() => server.closeAllConnections());
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  void startProgramService().catch(() => {
    console.error(
      'Workflow program service could not start. Check its local configuration and state directory.',
    );
    process.exitCode = 1;
  });
}
