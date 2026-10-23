import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { loadDatabaseBridgeToken } from '../services/database-bridge/main';
import { createDatabaseBridge } from '../services/database-bridge/server';

const TOKEN = '0123456789abcdef'.repeat(4);
const ALLOWED_ORIGIN = 'https://urtoris.cn';
const AUTH = { Authorization: `Bearer ${TOKEN}` };
const JSON_AUTH = { ...AUTH, 'Content-Type': 'application/json' };

type Reply = { status: number; headers: IncomingHttpHeaders; body: string };

function request(
  port: number,
  path: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    chunked?: boolean;
  } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          ...options.headers,
          ...(options.chunked ? { 'Transfer-Encoding': 'chunked' } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    outgoing.on('error', reject);
    if (options.chunked && options.body) {
      outgoing.write(options.body.slice(0, 20_000));
      outgoing.end(options.body.slice(20_000));
    } else outgoing.end(options.body);
  });
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  assert.equal(address.address, '127.0.0.1');
  return address.port;
}

describe('local SQLite HTTP connection assistant', () => {
  let directory: string;
  let filePath: string;
  let server: Server;
  let port: number;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'urtoris-database-bridge-'));
    filePath = join(directory, 'orders.sqlite');
    const database = new DatabaseSync(filePath);
    database.exec(
      "CREATE TABLE orders(id INTEGER PRIMARY KEY, customer TEXT, total REAL); INSERT INTO orders VALUES(1, '小明', 12.5), (2, '小红', 20);",
    );
    database.close();
    server = createDatabaseBridge({ token: TOKEN, pickFile: async () => null });
    port = await listen(server);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });

  const post = (
    path: string,
    value: unknown,
    headers: Record<string, string> = {},
  ) =>
    request(port, path, {
      method: 'POST',
      headers: { ...JSON_AUTH, ...headers },
      body: JSON.stringify(value),
    });

  it('allows only exact production/local origins and private-network preflights', async () => {
    for (const origin of [
      ALLOWED_ORIGIN,
      'http://localhost:3000',
      'http://127.0.0.1:3000',
    ]) {
      const reply = await request(port, '/v1/query', {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, content-type',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      assert.equal(reply.status, 204);
      assert.equal(reply.headers['access-control-allow-origin'], origin);
      assert.equal(
        reply.headers['access-control-allow-private-network'],
        'true',
      );
      assert.equal(
        reply.headers['access-control-allow-credentials'],
        undefined,
      );
      assert.match(String(reply.headers.vary), /Origin/);
    }
    for (const origin of [
      'https://urtoris.cn.evil.example',
      'https://www.urtoris.cn',
      'http://localhost:3001',
      'null',
    ]) {
      const reply = await request(port, '/v1/status', {
        headers: { ...AUTH, Origin: origin },
      });
      assert.equal(reply.status, 403);
      assert.equal(reply.headers['access-control-allow-origin'], undefined);
    }
  });

  it('rejects unsupported preflight headers, methods, routes, or absent origins', async () => {
    for (const [path, headers] of [
      [
        '/v1/query',
        { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'DELETE' },
      ],
      [
        '/v1/query',
        {
          Origin: ALLOWED_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'X-Custom-Header',
        },
      ],
      [
        '/connect',
        { Origin: ALLOWED_ORIGIN, 'Access-Control-Request-Method': 'GET' },
      ],
      ['/v1/status', { 'Access-Control-Request-Method': 'GET' }],
    ] as Array<[string, Record<string, string>]>) {
      assert.equal(
        (await request(port, path, { method: 'OPTIONS', headers })).status,
        403,
      );
    }
  });

  it('requires a matching local Host and rejects forwarded requests', async () => {
    for (const headers of [
      { Host: `evil.example:${port}` },
      { Host: `localhost:${port + 1}` },
      { Host: 'localhost' },
      { 'X-Forwarded-For': '127.0.0.1' },
      { Forwarded: 'for=127.0.0.1' },
      { 'X-Real-IP': '127.0.0.1' },
    ] as Array<Record<string, string>>) {
      assert.equal(
        (
          await request(port, '/v1/status', {
            headers: { ...AUTH, ...headers },
          })
        ).status,
        403,
      );
    }
    assert.equal(
      (
        await request(port, '/v1/status', {
          headers: { ...AUTH, Host: `localhost:${port}` },
        })
      ).status,
      200,
    );
  });

  it('requires the full exact token for data routes and never leaks it in errors/status', async () => {
    for (const authorization of [
      '',
      `Bearer ${'f'.repeat(64)}`,
      `Bearer ${TOKEN.slice(1)}`,
      `Bearer ${'é'.repeat(64)}`,
    ]) {
      const reply = await request(port, '/v1/status', {
        headers: { Authorization: authorization, Origin: ALLOWED_ORIGIN },
      });
      assert.equal(reply.status, 401);
      assert.equal(reply.body.includes(TOKEN), false);
    }
    const reply = await request(port, '/v1/status', {
      headers: { ...AUTH, Origin: ALLOWED_ORIGIN },
    });
    assert.equal(reply.status, 200);
    assert.equal(JSON.parse(reply.body).readOnly, true);
    assert.equal(reply.body.includes(TOKEN), false);
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.throws(() => createDatabaseBridge({ token: 'short' }), /64/);
  });

  it('offers local navigation pairing only through a URL fragment, with no embedding or referrer', async () => {
    const page = await request(port, '/connect');
    assert.equal(page.status, 200);
    assert.ok(
      page.body.includes(`https://urtoris.cn/studio#database-pair=${TOKEN}`),
    );
    assert.equal(page.body.includes(`?database-pair=${TOKEN}`), false);
    assert.equal(page.headers['referrer-policy'], 'no-referrer');
    assert.match(
      String(page.headers['content-security-policy']),
      /frame-ancestors 'none'/,
    );
    assert.equal(page.headers['x-frame-options'], 'DENY');
    for (const headers of [
      { Origin: ALLOWED_ORIGIN },
      { Origin: 'https://evil.example' },
      {
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Dest': 'image',
      },
      {
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'iframe',
      },
    ] as Array<Record<string, string>>) {
      const rejected = await request(port, '/connect', { headers });
      assert.equal(rejected.status, 403);
      assert.equal(rejected.body.includes(TOKEN), false);
    }
    assert.equal(
      (
        await request(port, '/connect', {
          headers: {
            'Sec-Fetch-Site': 'cross-site',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Dest': 'document',
          },
        })
      ).status,
      200,
    );
  });

  it('reads real schema and parameterized results without changing the SQLite file', async () => {
    const before = await readFile(filePath);
    const inspected = await post(
      '/v1/inspect',
      { filePath },
      { Origin: ALLOWED_ORIGIN },
    );
    assert.equal(inspected.status, 200);
    assert.equal(JSON.parse(inspected.body).tables[0].name, 'orders');
    assert.equal(JSON.parse(inspected.body).filePath, filePath);
    const queried = await post('/v1/query', {
      filePath,
      sql: 'SELECT customer, total FROM orders WHERE id = ?',
      parameters: [1],
      maxRows: 10,
    });
    assert.equal(queried.status, 200);
    assert.deepEqual(JSON.parse(queried.body).rows, [['小明', 12.5]]);
    assert.deepEqual(await readFile(filePath), before);
  });

  it('keeps the configured inspection path when the kernel resolves a symlink', async () => {
    const linkedPath = join(directory, 'linked-orders.db');
    await symlink(filePath, linkedPath);
    const reply = await post('/v1/inspect', { filePath: ` ${linkedPath} ` });
    assert.equal(reply.status, 200);
    assert.equal(JSON.parse(reply.body).filePath, linkedPath);
    assert.equal(JSON.parse(reply.body).tables[0].name, 'orders');
  });

  it('rejects writes, multi-statement SQL, invalid parameters and unknown options', async () => {
    const before = await readFile(filePath);
    for (const sql of [
      'DELETE FROM orders',
      'SELECT 1; DELETE FROM orders',
      "ATTACH DATABASE '/tmp/other.sqlite' AS other",
    ]) {
      const reply = await post('/v1/query', { filePath, sql });
      assert.equal(reply.status, 400);
      assert.equal(JSON.parse(reply.body).code, 'READ_ONLY_QUERY_REQUIRED');
    }
    for (const value of [
      { filePath, sql: 'SELECT ?', parameters: [true] },
      { filePath, sql: 'SELECT :value', parameters: { value: {} } },
      { filePath, sql: 'SELECT 1', maxRows: 1.5 },
      { filePath, sql: 'SELECT 1', maxRows: 501 },
      { filePath, sql: 'SELECT 1', timeoutMs: '1' },
      { filePath, sql: 'SELECT 1', command: 'pwd' },
    ])
      assert.equal((await post('/v1/query', value)).status, 400);
    assert.deepEqual(await readFile(filePath), before);
  });

  it('rejects malformed JSON and non-JSON objects while keeping the server responsive', async () => {
    for (const body of ['{', 'null', '[]', '"string"']) {
      assert.equal(
        (
          await request(port, '/v1/query', {
            method: 'POST',
            headers: JSON_AUTH,
            body,
          })
        ).status,
        400,
      );
    }
    for (const type of ['text/plain', 'application/json-not-a-type']) {
      assert.equal(
        (
          await request(port, '/v1/query', {
            method: 'POST',
            headers: { ...JSON_AUTH, 'Content-Type': type },
            body: '{}',
          })
        ).status,
        415,
      );
    }
    const malformedUrl = await request(port, 'http://[', { headers: AUTH });
    assert.equal(malformedUrl.status, 400);
    assert.equal(
      (await request(port, '/v1/status', { headers: AUTH })).status,
      200,
    );
  });

  it('enforces the 64 KiB request boundary for content-length and chunked input', async () => {
    const body = JSON.stringify({ filePath, sql: 'SELECT 1 AS value' }).padEnd(
      64 * 1_024,
      ' ',
    );
    assert.equal(
      (
        await request(port, '/v1/query', {
          method: 'POST',
          headers: JSON_AUTH,
          body,
        })
      ).status,
      200,
    );
    for (const chunked of [false, true]) {
      const oversized = await request(port, '/v1/query', {
        method: 'POST',
        headers: JSON_AUTH,
        body: `${body} `,
        chunked,
      });
      assert.equal(oversized.status, 413);
    }
    assert.equal(
      (await request(port, '/v1/status', { headers: AUTH })).status,
      200,
    );
  });

  it('does not expose shell or general file endpoints and reports cancelled file selection', async () => {
    for (const path of [
      '/v1/shell',
      '/v1/exec',
      '/v1/readfile',
      '/api/local-control',
    ]) {
      assert.equal((await post(path, { command: 'pwd' })).status, 404);
    }
    const picked = await post('/v1/pick', {});
    assert.equal(picked.status, 200);
    assert.deepEqual(JSON.parse(picked.body), {
      filePath: null,
      cancelled: true,
    });
    assert.equal((await post('/v1/pick', { command: 'pwd' })).status, 400);
    assert.equal(
      (await post('/v1/inspect', { filePath: join(directory, 'missing.db') }))
        .status,
      404,
    );
  });
});

describe('database connection token storage', () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'urtoris-database-token-'));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('creates and reuses a private 64-character code and repairs directory/file permissions', async () => {
    const runtime = join(directory, 'state');
    const token = await loadDatabaseBridgeToken(runtime);
    assert.match(token, /^[a-f0-9]{64}$/);
    const tokenFile = join(runtime, 'connection-token');
    assert.equal((await lstat(runtime)).mode & 0o777, 0o700);
    assert.equal((await lstat(tokenFile)).mode & 0o777, 0o600);
    await chmod(runtime, 0o755);
    await chmod(tokenFile, 0o644);
    assert.equal(await loadDatabaseBridgeToken(runtime), token);
    assert.equal((await lstat(runtime)).mode & 0o777, 0o700);
    assert.equal((await lstat(tokenFile)).mode & 0o777, 0o600);
  });

  it('does not follow state-directory or token-file symlinks', async () => {
    const realRuntime = join(directory, 'real');
    await loadDatabaseBridgeToken(realRuntime);
    const linkedRuntime = join(directory, 'linked');
    await symlink(realRuntime, linkedRuntime);
    await assert.rejects(loadDatabaseBridgeToken(linkedRuntime), /普通文件夹/);
    const victim = join(directory, 'other-token');
    await writeFile(victim, TOKEN, { mode: 0o644 });
    const tokenFile = join(realRuntime, 'connection-token');
    await rm(tokenFile);
    await symlink(victim, tokenFile);
    await assert.rejects(loadDatabaseBridgeToken(realRuntime));
    assert.equal((await lstat(victim)).mode & 0o777, 0o644);
    assert.equal(await readFile(victim, 'utf8'), TOKEN);
  });

  it('rejects an invalid stored code instead of starting with predictable credentials', async () => {
    const runtime = join(directory, 'state');
    await loadDatabaseBridgeToken(runtime);
    await writeFile(join(runtime, 'connection-token'), 'short');
    await assert.rejects(loadDatabaseBridgeToken(runtime), /连接代码文件无效/);
  });
});
