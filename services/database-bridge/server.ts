import { execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { platform } from 'node:os';
import type {
  LocalDatabaseParameter,
  LocalDatabaseParameters,
} from '../../lib/local-database-protocol';
import {
  inspectDatabase,
  queryDatabase,
  LocalDatabaseError,
} from '../local-database/index';

const ORIGINS = new Set([
  'https://urtoris.cn',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const REQUEST_BYTES = 64 * 1_024;
const API_PATHS = new Set([
  '/v1/status',
  '/v1/inspect',
  '/v1/query',
  '/v1/pick',
]);

function pickDatabaseFile(): Promise<string | null> {
  if (platform() !== 'darwin')
    return Promise.reject(new Error('请直接填写电脑上的数据库绝对路径。'));
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      [
        '-e',
        'POSIX path of (choose file with prompt "选择要连接的 SQLite 数据库文件")',
      ],
      { timeout: 180_000 },
      (error, stdout) => {
        if (error && /User canceled|-128/.test(error.message))
          return resolve(null);
        if (error) return reject(new Error('文件选择器未能打开。'));
        resolve(stdout.trim() || null);
      },
    );
  });
}

function localRequest(request: IncomingMessage): boolean {
  const peer = request.socket.remoteAddress;
  if (peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1')
    return false;
  if (
    request.headers.forwarded ||
    request.headers['x-forwarded-for'] ||
    request.headers['x-real-ip']
  )
    return false;
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})$/.exec(
    request.headers.host ?? '',
  );
  return Boolean(match && Number(match[1]) === request.socket.localPort);
}

function readBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const length = request.headers['content-length'];
  if (
    length !== undefined &&
    (!/^[0-9]+$/.test(length) || Number(length) > REQUEST_BYTES)
  ) {
    request.resume();
    return Promise.reject(
      new LocalDatabaseError('INVALID_REQUEST', '数据库请求过大。', 413),
    );
  }
  if (
    (request.headers['content-type'] ?? '')
      .split(';', 1)[0]
      .trim()
      .toLowerCase() !== 'application/json'
  ) {
    request.resume();
    return Promise.reject(
      new LocalDatabaseError(
        'INVALID_REQUEST',
        '数据库请求必须使用 JSON。',
        415,
      ),
    );
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let completed = false;
    const fail = (error: LocalDatabaseError) => {
      if (completed) return;
      completed = true;
      request.removeListener('data', data);
      request.resume();
      reject(error);
    };
    const data = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > REQUEST_BYTES) {
        fail(
          new LocalDatabaseError('INVALID_REQUEST', '数据库请求过大。', 413),
        );
        return;
      }
      chunks.push(bytes);
    };
    request.on('data', data);
    request.once('error', () =>
      fail(
        new LocalDatabaseError('INVALID_REQUEST', '数据库请求未能完整读取。'),
      ),
    );
    request.once('aborted', () =>
      fail(new LocalDatabaseError('INVALID_REQUEST', '数据库请求已取消。')),
    );
    request.once('end', () => {
      if (completed) return;
      completed = true;
      try {
        const value: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          reject(
            new LocalDatabaseError(
              'INVALID_REQUEST',
              '数据库请求必须是 JSON 对象。',
            ),
          );
          return;
        }
        resolve(value as Record<string, unknown>);
      } catch {
        reject(
          new LocalDatabaseError(
            'INVALID_REQUEST',
            '数据库请求不是合法 JSON。',
          ),
        );
      }
    });
  });
}

function isParameter(value: unknown): value is LocalDatabaseParameter {
  return (
    value === null ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function readParameters(value: unknown): LocalDatabaseParameters | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value) && value.every(isParameter)) return value;
  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.values(value).every(isParameter)
  ) {
    return value as Record<string, LocalDatabaseParameter>;
  }
  throw new LocalDatabaseError(
    'INVALID_REQUEST',
    '查询参数只支持有限数字、字符串和 null。',
  );
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value))
    throw new LocalDatabaseError('INVALID_REQUEST', `${name}必须是整数。`);
  return value;
}

export function createDatabaseBridge(options: {
  token: string;
  pickFile?: () => Promise<string | null>;
}) {
  if (!/^[a-f0-9]{64}$/.test(options.token))
    throw new Error('数据库助手连接代码必须是 64 位随机十六进制文本。');
  const expectedToken = Buffer.from(options.token);
  let activeQueries = 0;
  let pickingFile = false;
  const server = createServer(
    async (request: IncomingMessage, response: ServerResponse) => {
      const origin = request.headers.origin;
      const headers: Record<string, string> = {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network',
      };
      const json = (status: number, value: unknown) => {
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(status, {
          ...headers,
          'Content-Type': 'application/json; charset=utf-8',
        });
        response.end(JSON.stringify(value));
      };
      if (
        !localRequest(request) ||
        (origin !== undefined && !ORIGINS.has(origin))
      ) {
        request.resume();
        json(403, {
          error: '这个网页不能访问本机数据库助手。',
          code: 'ORIGIN_REJECTED',
        });
        return;
      }
      if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type';
        if (
          request.headers['access-control-request-private-network'] === 'true'
        )
          headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      let url: URL;
      try {
        url = new URL(request.url ?? '/', 'http://127.0.0.1');
      } catch {
        request.resume();
        json(400, { error: '数据库请求地址无效。', code: 'INVALID_REQUEST' });
        return;
      }
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method'];
        const requestedHeaders = (
          request.headers['access-control-request-headers'] ?? ''
        )
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        if (
          !origin ||
          !API_PATHS.has(url.pathname) ||
          (method !== 'GET' && method !== 'POST') ||
          requestedHeaders.some(
            (value) => value !== 'authorization' && value !== 'content-type',
          )
        ) {
          json(403, {
            error: '这个网页请求不能访问本机数据库助手。',
            code: 'ORIGIN_REJECTED',
          });
          return;
        }
        response.writeHead(204, headers);
        response.end();
        return;
      }
      if (request.method === 'GET' && url.pathname === '/connect') {
        const crossSiteResource =
          request.headers['sec-fetch-site'] === 'cross-site' &&
          (request.headers['sec-fetch-mode'] !== 'navigate' ||
            request.headers['sec-fetch-dest'] !== 'document');
        if (origin !== undefined || crossSiteResource) {
          json(403, {
            error: '请在本机直接打开连接页面。',
            code: 'ORIGIN_REJECTED',
          });
          return;
        }
        const link = `https://urtoris.cn/studio#database-pair=${options.token}`;
        response.writeHead(200, {
          ...headers,
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'",
          'Referrer-Policy': 'no-referrer',
          'X-Frame-Options': 'DENY',
        });
        response.end(
          `<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width, initial-scale=1"><title>连接本机数据库 · Urtoris</title><style>body{margin:0;background:#08111a;color:#edf4f8;font:16px/1.65 system-ui}main{max-width:560px;margin:12vh auto;padding:24px}h1{font-size:28px}p{color:#b6c7d1}a{display:inline-block;padding:12px 18px;background:#ff6b35;color:#08111a;border-radius:8px;font-weight:650;text-decoration:none}a:focus-visible{outline:3px solid #edf4f8;outline-offset:4px}code{display:block;overflow-wrap:anywhere;color:#c1d1dc;font-size:13px}summary{cursor:pointer;margin-top:28px}</style><main><h1>连接电脑上的数据库</h1><p>连接助手已启动。打开工作台后，选择数据库节点，填写或选择 SQLite 文件，再测试连接。</p><p>数据库只在这台电脑读取。AI 使用的查询结果会发送给你选择的模型。</p><a href="${link}">打开工作台并连接</a><details><summary>手动连接代码</summary><p>在工作台的“连接代码”中粘贴下方内容。不要分享此代码。</p><code>${options.token}</code></details></main></html>`,
        );
        return;
      }
      const supplied = /^Bearer\s+([a-f0-9]{64})$/i.exec(
        request.headers.authorization ?? '',
      )?.[1];
      if (!supplied || !timingSafeEqual(Buffer.from(supplied), expectedToken)) {
        request.resume();
        json(401, {
          error: '连接代码不正确，请重新打开本机助手的连接页面。',
          code: 'UNAUTHORIZED',
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/v1/status') {
        request.resume();
        json(200, { available: true, readOnly: true, platform: platform() });
        return;
      }
      if (
        request.method !== 'POST' ||
        !['/v1/inspect', '/v1/query', '/v1/pick'].includes(url.pathname)
      ) {
        request.resume();
        json(404, { error: '数据库操作不存在。', code: 'NOT_FOUND' });
        return;
      }
      try {
        const body = await readBody(request);
        const permittedKeys =
          url.pathname === '/v1/query'
            ? ['filePath', 'sql', 'parameters', 'maxRows', 'timeoutMs']
            : url.pathname === '/v1/inspect'
              ? ['filePath']
              : [];
        if (Object.keys(body).some((key) => !permittedKeys.includes(key)))
          throw new LocalDatabaseError(
            'INVALID_REQUEST',
            '数据库请求包含不支持的字段。',
          );
        if (url.pathname === '/v1/pick') {
          if (pickingFile) {
            json(429, {
              error: '文件选择器已打开，请先完成当前选择。',
              code: 'BUSY',
            });
            return;
          }
          pickingFile = true;
          try {
            const filePath = await (options.pickFile ?? pickDatabaseFile)();
            json(200, { filePath, cancelled: filePath === null });
          } finally {
            pickingFile = false;
          }
          return;
        }
        if (typeof body.filePath !== 'string')
          throw new LocalDatabaseError(
            'INVALID_REQUEST',
            '请填写数据库文件位置。',
          );
        if (activeQueries >= 4) {
          headers['Retry-After'] = '1';
          json(429, {
            error: '本机数据库正在处理其他查询，请稍后重试。',
            code: 'BUSY',
          });
          return;
        }
        activeQueries++;
        try {
          if (url.pathname === '/v1/query' && typeof body.sql !== 'string')
            throw new LocalDatabaseError(
              'INVALID_REQUEST',
              '请填写只读查询 SQL。',
            );
          const result =
            url.pathname === '/v1/inspect'
              ? await inspectDatabase(body.filePath)
              : await queryDatabase({
                  filePath: body.filePath,
                  sql: body.sql as string,
                  parameters: readParameters(body.parameters),
                  maxRows: optionalInteger(body.maxRows, '最多返回行数'),
                  timeoutMs: optionalInteger(body.timeoutMs, '查询超时'),
                });
          // The signed browser request identifies the configured path. The kernel
          // resolves it internally, but /var aliases and symlinks must not change
          // the path echoed back for continuation validation.
          json(
            200,
            url.pathname === '/v1/inspect'
              ? { ...result, filePath: body.filePath.trim() }
              : result,
          );
        } finally {
          activeQueries--;
        }
      } catch (cause) {
        if (cause instanceof LocalDatabaseError)
          json(cause.httpStatus, { error: cause.message, code: cause.code });
        else
          json(503, {
            error:
              '本机数据库操作失败。请检查文件位置，或直接填写数据库绝对路径。',
            code: 'DATABASE_UNAVAILABLE',
          });
      }
    },
  );
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}
