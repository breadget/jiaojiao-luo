import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import {
  DATABASE_CONNECTION_EVENT,
  checkDatabaseAssistant,
  executeDatabaseRequests,
  getDatabaseConnectionCode,
  inspectLocalDatabase,
  readDatabasePairingLink,
  setDatabaseConnectionCode,
  type DatabaseToolRequest,
} from '@/lib/local-database-client';
import { LOCAL_DATABASE_PROTOCOL } from '@/lib/local-database-protocol';

const pairingCode = 'a'.repeat(64);
const storageKey = 'urtoris.database-connection';
const filePath = '/Users/me/data/orders.sqlite';
const savedWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const savedStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  'sessionStorage',
);
let storedValues: Map<string, string>;
let dispatchedEvents: string[];
let replacedUrls: string[];
let location: { hash: string; pathname: string; search: string };

function fetchUrl(input: RequestInfo | URL): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

function requestBody(init?: RequestInit): string {
  const body = init?.body;
  assert.equal(typeof body, 'string');
  return body as string;
}

function request(
  operation: 'inspect' | 'query',
  id: string,
): DatabaseToolRequest {
  return {
    id,
    nodeId: 'local_database',
    name: '订单数据库',
    filePath,
    operation,
    ...(operation === 'query'
      ? {
          sql: 'SELECT id, status FROM orders WHERE id = ? LIMIT 10',
          parameters: [7],
          maxRows: 10,
        }
      : {}),
  };
}

function restoreDescriptor(
  key: 'window' | 'sessionStorage',
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(globalThis, key, descriptor);
  else Reflect.deleteProperty(globalThis, key);
}

beforeEach(() => {
  storedValues = new Map();
  dispatchedEvents = [];
  replacedUrls = [];
  location = { hash: '', pathname: '/studio', search: '?workflow=orders' };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location,
      dispatchEvent(event: Event) {
        dispatchedEvents.push(event.type);
        return true;
      },
      history: {
        replaceState(_state: unknown, _unused: string, url: string) {
          replacedUrls.push(url);
          location.hash = '';
        },
      },
    },
  });
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      getItem(key: string) {
        return storedValues.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storedValues.set(key, value);
      },
      removeItem(key: string) {
        storedValues.delete(key);
      },
    },
  });
  setDatabaseConnectionCode('');
  dispatchedEvents.length = 0;
});

afterEach(() => {
  setDatabaseConnectionCode('');
  mock.restoreAll();
  restoreDescriptor('window', savedWindow);
  restoreDescriptor('sessionStorage', savedStorage);
});

describe('本机数据库浏览器连接与工具协议', () => {
  it('连接码仅保存在当前标签页 sessionStorage，清除连接时同步发送事件', () => {
    setDatabaseConnectionCode(` ${pairingCode} `);
    assert.equal(getDatabaseConnectionCode(), pairingCode);
    assert.equal(storedValues.get(storageKey), pairingCode);
    assert.deepEqual(dispatchedEvents, [DATABASE_CONNECTION_EVENT]);
    setDatabaseConnectionCode('');
    assert.equal(getDatabaseConnectionCode(), '');
    assert.equal(storedValues.has(storageKey), false);
    assert.deepEqual(dispatchedEvents, [
      DATABASE_CONNECTION_EVENT,
      DATABASE_CONNECTION_EVENT,
    ]);
  });

  it('消费配对链接 fragment 并从历史地址中移除，保留页面与查询参数', () => {
    location.hash = `#database-pair=${pairingCode}`;
    readDatabasePairingLink();
    assert.equal(getDatabaseConnectionCode(), pairingCode);
    assert.equal(location.hash, '');
    assert.deepEqual(replacedUrls, ['/studio?workflow=orders']);
    assert.equal(replacedUrls[0].includes(pairingCode), false);
    readDatabasePairingLink();
    assert.equal(replacedUrls.length, 1);
  });

  it('不匹配的 fragment 不会被消费，也不会意外改写连接码', () => {
    location.hash = '#unrelated-section';
    readDatabasePairingLink();
    assert.equal(location.hash, '#unrelated-section');
    assert.equal(getDatabaseConnectionCode(), '');
    assert.deepEqual(replacedUrls, []);
  });

  it('连接码只在访问固定 loopback 助手的 Authorization 中出现，不进入工具请求体或 AI 结果', async () => {
    setDatabaseConnectionCode(pairingCode);
    const queryResult = {
      protocol: LOCAL_DATABASE_PROTOCOL,
      columns: ['id', 'status'],
      rows: [[7, '已发货']],
      rowCount: 1,
      truncated: false,
    };
    const calls: { url: string; init?: RequestInit }[] = [];
    mock.method(
      globalThis,
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: fetchUrl(input), init });
        return Response.json(queryResult);
      },
    );
    const results = await executeDatabaseRequests([
      request('query', 'call_query'),
    ]);
    assert.deepEqual(results, [{ id: 'call_query', result: queryResult }]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://127.0.0.1:3022/v1/query');
    assert.equal(
      new Headers(calls[0].init?.headers).get('Authorization'),
      `Bearer ${pairingCode}`,
    );
    assert.equal(calls[0].init?.credentials, 'omit');
    assert.equal(calls[0].init?.cache, 'no-store');
    assert.equal(typeof calls[0].init?.body, 'string');
    assert.equal(requestBody(calls[0].init).includes(pairingCode), false);
    assert.equal(JSON.stringify(results).includes(pairingCode), false);
    assert.deepEqual(JSON.parse(requestBody(calls[0].init)), {
      filePath,
      sql: request('query', 'query').sql,
      parameters: [7],
      maxRows: 10,
    });
  });

  it('表结构与查询依次调用助手，使用真实 JSON 返回值并报告进度', async () => {
    setDatabaseConnectionCode(pairingCode);
    const schema = {
      protocol: LOCAL_DATABASE_PROTOCOL,
      filePath,
      tables: [
        {
          name: 'orders',
          kind: 'table',
          columns: [
            { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          ],
          truncated: false,
        },
      ],
      truncated: false,
    };
    const queryResult = {
      protocol: LOCAL_DATABASE_PROTOCOL,
      columns: ['id'],
      rows: [[7]],
      rowCount: 1,
      truncated: false,
    };
    const sequence: string[] = [];
    const bodies: unknown[] = [];
    mock.method(
      globalThis,
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const operation = new URL(fetchUrl(input)).pathname.split('/').at(-1)!;
        sequence.push(`fetch:${operation}`);
        bodies.push(JSON.parse(requestBody(init)));
        const response = Response.json(
          operation === 'inspect' ? schema : queryResult,
        );
        const parseJson = response.json.bind(response);
        mock.method(response, 'json', async () => {
          const payload = await parseJson();
          sequence.push(`json:${operation}`);
          return payload;
        });
        return response;
      },
    );
    const progress: string[] = [];
    const results = await executeDatabaseRequests(
      [request('inspect', 'schema'), request('query', 'query')],
      (message) => progress.push(message),
    );
    assert.deepEqual(sequence, [
      'fetch:inspect',
      'json:inspect',
      'fetch:query',
      'json:query',
    ]);
    assert.deepEqual(bodies[0], { filePath });
    assert.deepEqual(results, [
      { id: 'schema', result: schema },
      { id: 'query', result: queryResult },
    ]);
    assert.match(progress[0], /表结构/);
    assert.match(progress[1], /查询/);
  });

  it('助手离线和查询失败转为 AI 可说明的工具错误，保留对应调用 id', async () => {
    setDatabaseConnectionCode(pairingCode);
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('fetch failed');
      return Response.json({ error: '数据库文件不存在。' }, { status: 404 });
    });
    const results = await executeDatabaseRequests([
      request('inspect', 'offline'),
      request('query', 'missing'),
    ]);
    assert.equal(results[0].id, 'offline');
    assert.match(results[0].error ?? '', /无法连接.*数据库助手/);
    assert.match(results[0].error ?? '', /database:local/);
    assert.equal(results[0].result, undefined);
    assert.deepEqual(results[1], {
      id: 'missing',
      error: '数据库文件不存在。',
    });
    assert.equal(JSON.stringify(results).includes(pairingCode), false);
  });

  it('未配对时不会访问网络；状态与表结构的直接调用也只访问助手', async () => {
    const calls: string[] = [];
    mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
      calls.push(fetchUrl(input));
      return Response.json({ available: true, readOnly: true });
    });
    await assert.rejects(() => checkDatabaseAssistant(), /先启动并连接/);
    assert.deepEqual(calls, []);
    setDatabaseConnectionCode(pairingCode);
    assert.deepEqual(await checkDatabaseAssistant(), {
      available: true,
      readOnly: true,
    });
    await inspectLocalDatabase(filePath);
    assert.deepEqual(calls, [
      'http://127.0.0.1:3022/v1/status',
      'http://127.0.0.1:3022/v1/inspect',
    ]);
  });

  it('单轮最多 4 项操作，超过上限时执行前拒绝，未知操作也不会调用助手', async () => {
    setDatabaseConnectionCode(pairingCode);
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return Response.json({ rowCount: 0, rows: [] });
    });
    await assert.rejects(
      () =>
        executeDatabaseRequests(
          Array.from({ length: 5 }, (_, index) =>
            request('query', String(index)),
          ),
        ),
      /过多/,
    );
    assert.equal(calls, 0);
    const invalid = {
      ...request('query', 'invalid'),
      operation: 'delete',
    } as unknown as DatabaseToolRequest;
    const results = await executeDatabaseRequests([invalid]);
    assert.match(results[0].error ?? '', /不支持/);
    assert.equal(calls, 0);
    assert.equal(
      (
        await executeDatabaseRequests(
          Array.from({ length: 4 }, (_, index) =>
            request('query', String(index)),
          ),
        )
      ).length,
      4,
    );
    assert.equal(calls, 4);
  });

  it('累计结果限 40 KiB，按 UTF-8 字节计数，超出部分只返回工具错误', async () => {
    setDatabaseConnectionCode(pairingCode);
    const payload = { rows: [['汉'.repeat(7_200)]] };
    assert.ok(
      new TextEncoder().encode(JSON.stringify(payload)).byteLength < 32 * 1024,
    );
    mock.method(globalThis, 'fetch', async () => Response.json(payload));
    const results = await executeDatabaseRequests([
      request('query', 'first'),
      request('query', 'second'),
    ]);
    assert.deepEqual(results[0], { id: 'first', result: payload });
    assert.equal(results[1].result, undefined);
    assert.match(results[1].error ?? '', /结果过大/);
    assert.ok(
      new TextEncoder().encode(JSON.stringify(results)).byteLength < 40 * 1024,
    );
  });

  it('sessionStorage 不可用时使用内存连接码，清除后不再携带旧码', async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new Error('storage blocked');
      },
    });
    setDatabaseConnectionCode(pairingCode);
    assert.equal(getDatabaseConnectionCode(), pairingCode);
    let authorization: string | null = null;
    mock.method(
      globalThis,
      'fetch',
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get('Authorization');
        return Response.json({ available: true, readOnly: true });
      },
    );
    await checkDatabaseAssistant();
    assert.equal(authorization, `Bearer ${pairingCode}`);
    setDatabaseConnectionCode('');
    assert.equal(getDatabaseConnectionCode(), '');
    await assert.rejects(() => checkDatabaseAssistant(), /先启动并连接/);
  });

  it('取消当前查询后不再执行下一项，并将取消信号传给 fetch', async () => {
    setDatabaseConnectionCode(pairingCode);
    const controller = new AbortController();
    const calls: string[] = [];
    let forwardedSignal: AbortSignal | null | undefined;
    mock.method(
      globalThis,
      'fetch',
      async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(fetchUrl(input));
        forwardedSignal = init?.signal;
        controller.abort(new DOMException('用户已取消', 'AbortError'));
        if (forwardedSignal?.aborted) throw forwardedSignal.reason;
        return Response.json({ rows: [] });
      },
    );
    const progress: string[] = [];
    try {
      await executeDatabaseRequests(
        [request('query', 'first'), request('query', 'second')],
        (message) => progress.push(message),
        controller.signal,
      );
    } catch (cause) {
      assert.equal((cause as Error).name, 'AbortError');
    }
    assert.equal(controller.signal.aborted, true);
    assert.equal(forwardedSignal?.aborted, true);
    assert.equal(calls.length, 1);
    assert.equal(progress.length, 1);
  });

  it('开始前已经取消时不会触发查询或进度', async () => {
    setDatabaseConnectionCode(pairingCode);
    const controller = new AbortController();
    controller.abort(new DOMException('用户已取消', 'AbortError'));
    let calls = 0;
    mock.method(globalThis, 'fetch', async () => {
      calls += 1;
      return Response.json({ rows: [] });
    });
    const progress: string[] = [];
    try {
      await executeDatabaseRequests(
        [request('query', 'cancelled')],
        (message) => progress.push(message),
        controller.signal,
      );
    } catch (cause) {
      assert.equal((cause as Error).name, 'AbortError');
    }
    assert.equal(calls, 0);
    assert.deepEqual(progress, []);
  });
});
