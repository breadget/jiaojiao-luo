import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import {
  askCourseQuestion,
  courseAssistantErrorResponse,
  fetchCourseStatus,
} from '@/lib/server/course-assistant-client';
import { resetEnv } from './helpers/cloudflare-workers-stub';

const question = '队列的入队和出队复杂度是多少？';
const csrfCookie = 'a'.repeat(32);
const csrfToken = 'b'.repeat(64);
const status = {
  ready: true,
  has_index: true,
  stale: false,
  document_count: 1,
  page_count: 15,
  chunk_count: 33,
  documents: [{ name: '数据结构与算法知识库文档.pdf', pages: 15 }],
  llm_configured: false,
  embedding_backend: 'fastembed',
  embedding_model: 'BAAI/bge-small-zh-v1.5',
  indexed_at: '2026-10-13T04:12:00+00:00',
};
const answer = {
  question,
  answer: '已找到 1 条相关原文。请展开“来源依据”查看。',
  mode: 'retrieval_only',
  warning: '尚未配置大模型 API Key，未调用大模型生成答案。',
  sources: [{
    id: 'queue-page-2',
    filename: '数据结构与算法知识库文档.pdf',
    page: 2,
    excerpt: '队列遵循先进先出，入队和出队的时间复杂度为 O(1)。',
    score: 0.9,
  }],
};

function home(headers: HeadersInit = {}) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('Content-Type', 'text/html; charset=utf-8');
  responseHeaders.append('Set-Cookie', `csrftoken=${csrfCookie}; Path=/; SameSite=Lax`);
  responseHeaders.append('Set-Cookie', 'sessionid=backend-private; Path=/; HttpOnly');
  return new Response(`<input type="hidden" name="csrfmiddlewaretoken" value="${csrfToken}">`, {
    headers: responseHeaders,
  });
}

type FetchInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchInput | undefined) {
  assert.notEqual(input, undefined);
  return input instanceof Request ? input.url : String(input);
}

function requestBody(init: RequestInit | undefined) {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init?.body as string);
}

function stubAnswer(payload: unknown = answer) {
  return mock.method(globalThis, 'fetch', async (input: FetchInput) => {
    if (new URL(urlOf(input)).pathname === '/') return home();
    return Response.json(payload);
  });
}

async function errorFrom(action: () => Promise<unknown>) {
  let caught: unknown;
  try {
    await action();
  } catch (cause) {
    caught = cause;
  }
  assert.notEqual(caught, undefined, 'Expected the course bridge to reject an unsafe response.');
  const response = courseAssistantErrorResponse(caught);
  return { response, text: await response.text() };
}

afterEach(() => {
  mock.restoreAll();
  resetEnv();
});

describe('course knowledge service bridge', () => {
  it('uses the local default and preserves the validated inventory without exposing extra fields', async () => {
    const backend = mock.method(globalThis, 'fetch', async () => Response.json({
      ...status,
      api_key: 'UPSTREAM_SECRET',
      index_path: '/private/course/index',
      documents: [{ ...status.documents[0], path: '/private/source.pdf' }],
    }));
    assert.deepEqual(await fetchCourseStatus(), status);
    assert.equal(urlOf(backend.mock.calls[0].arguments[0]), 'http://127.0.0.1:8001/api/status/');
    const init = backend.mock.calls[0].arguments[1];
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('Authorization'), null);
  });

  it('keeps a missing or stale index visible instead of inventing ready state', async () => {
    const expected = {
      ...status,
      ready: false,
      has_index: false,
      stale: true,
      page_count: 0,
      chunk_count: 0,
      indexed_at: null,
      documents: [{ ...status.documents[0], pages: null }],
    };
    mock.method(globalThis, 'fetch', async () => Response.json(expected));
    assert.deepEqual(await fetchCourseStatus(), expected);
  });

  it('rejects non-loopback targets, credentials, paths, query strings and unsupported protocols before fetching', async () => {
    const backend = mock.method(globalThis, 'fetch', async () => Response.json(status));
    const invalidTargets = [
      'not a URL',
      'https://course.example.com',
      'http://192.168.1.8:8001',
      'http://10.0.0.1:8001',
      'http://0.0.0.0:8001',
      'http://service.local:8001',
      'http://localhost.example.com:8001',
      'http://username:password@127.0.0.1:8001',
      'http://127.0.0.1:8001/other-service',
      'http://127.0.0.1:8001/?token=secret',
      'http://127.0.0.1:8001/#private',
      'ftp://127.0.0.1:8001',
    ];
    for (const target of invalidTargets) {
      resetEnv({ COURSE_ASSISTANT_URL: target });
      const { response } = await errorFrom(() => fetchCourseStatus());
      assert.ok(response.status >= 400, target);
    }
    assert.equal(backend.mock.callCount(), 0);
  });

  it('never follows an upstream redirect', async () => {
    const backend = mock.method(globalThis, 'fetch', async () => new Response(null, {
      status: 302,
      headers: { Location: 'https://attacker.example.com/' },
    }));
    const { response } = await errorFrom(() => fetchCourseStatus());
    assert.ok(response.status >= 500);
    assert.equal(backend.mock.callCount(), 1);
    assert.equal(backend.mock.calls[0].arguments[1]?.redirect, 'manual');
  });

  it('validates numeric inventory and document metadata', async () => {
    const malformed = [
      { ...status, ready: 'yes' },
      { ...status, document_count: -1 },
      { ...status, page_count: 1.5 },
      { ...status, chunk_count: '33' },
      { ...status, llm_configured: 'false' },
      { ...status, document_count: 2 },
      { ...status, documents: [{ name: 'course.pdf', pages: -1 }] },
      { ...status, documents: [{ name: 3, pages: 15 }] },
      { ...status, documents: [{ name: '/private/course.pdf', pages: 15 }] },
      { ...status, documents: 'course.pdf' },
    ];
    for (const payload of malformed) {
      mock.method(globalThis, 'fetch', async () => Response.json(payload));
      const { response } = await errorFrom(() => fetchCourseStatus());
      assert.ok(response.status >= 500);
      mock.restoreAll();
    }
  });

  it('does not expose HTML debugging output, malformed JSON or connection details', async () => {
    const failures = [
      () => new Response('<html>DEBUG SECRET_API_KEY /private/index</html>', {
        status: 500, headers: { 'Content-Type': 'text/html' },
      }),
      () => new Response('{"secret":"SECRET_API_KEY",', {
        headers: { 'Content-Type': 'application/json' },
      }),
      () => { throw new Error('connect ECONNREFUSED SECRET_API_KEY /private/index'); },
    ];
    for (const failure of failures) {
      mock.method(globalThis, 'fetch', async () => failure());
      const { response, text } = await errorFrom(() => fetchCourseStatus());
      assert.ok(response.status >= 500);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.doesNotMatch(text, /SECRET_API_KEY|\/private\/index|<html>|ECONNREFUSED/);
      mock.restoreAll();
    }
  });

  it('limits upstream response bytes even when Content-Length is absent or forged', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 8; index += 1) {
          controller.enqueue(new Uint8Array(128 * 1024));
        }
      },
      cancel() { cancelled = true; },
    });
    mock.method(globalThis, 'fetch', async () => new Response(body, {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
    }));
    const { response } = await errorFrom(() => fetchCourseStatus());
    assert.ok(response.status >= 500);
    assert.equal(cancelled, true);
  });

  it('applies the status deadline while reading a stalled response body', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let signal: AbortSignal | null = null;
    mock.method(globalThis, 'fetch', async (_input: FetchInput, init?: RequestInit) => {
      signal = init?.signal ?? null;
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
        },
      }), { headers: { 'Content-Type': 'application/json' } });
    });
    const pending = errorFrom(() => fetchCourseStatus());
    context.mock.timers.tick(8000);
    const { response, text } = await pending;
    assert.equal(response.status, 504);
    assert.equal((signal as AbortSignal | null)?.aborted, true);
    assert.equal(JSON.parse(text).error.code, 'course_timeout');
  });

  it('uses one question deadline across both CSRF handshake and answer request', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    let resolveHome!: (value: Response) => void;
    const signals: Array<AbortSignal | null> = [];
    mock.method(globalThis, 'fetch', (input: FetchInput, init?: RequestInit) => {
      signals.push(init?.signal ?? null);
      if (new URL(urlOf(input)).pathname === '/') {
        return new Promise<Response>((resolve) => { resolveHome = resolve; });
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    });
    const pending = errorFrom(() => askCourseQuestion(question));
    context.mock.timers.tick(50_000);
    resolveHome(home());
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(signals.length, 2);
    assert.equal(signals[0], signals[1]);
    context.mock.timers.tick(40_000);
    const { response, text } = await pending;
    assert.equal(response.status, 504);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(JSON.parse(text).error.code, 'course_timeout');
  });

  it('performs its own Django CSRF handshake then posts the question with source evidence intact', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (input: FetchInput, init?: RequestInit) => {
      calls.push({ url: urlOf(input), init });
      return calls.length === 1 ? home() : Response.json({
        ...answer,
        api_key: 'UPSTREAM_SECRET',
        sources: [{ ...answer.sources[0], private_path: '/private/source.pdf' }],
      });
    });
    assert.deepEqual(await askCourseQuestion(question), answer);
    assert.deepEqual(calls.map(({ url }) => url), [
      'http://127.0.0.1:8001/',
      'http://127.0.0.1:8001/api/ask/',
    ]);
    const post = calls[1].init;
    assert.equal(post?.method, 'POST');
    assert.equal(post?.redirect, 'manual');
    assert.deepEqual(requestBody(post), { question });
    const headers = new Headers(post?.headers);
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get('Cookie'), `csrftoken=${csrfCookie}`);
    assert.equal(headers.get('X-CSRFToken'), csrfToken);
    assert.equal(headers.get('Origin'), 'http://127.0.0.1:8001');
    assert.equal(headers.get('Referer'), 'http://127.0.0.1:8001/');
    assert.equal(headers.get('Authorization'), null);
  });

  it('rejects a missing CSRF cookie or invalid CSRF token without submitting a question', async () => {
    const pages = [
      new Response(`<input type="hidden" name="csrfmiddlewaretoken" value="${csrfToken}">`, {
        headers: { 'Content-Type': 'text/html' },
      }),
      new Response('<input name="csrfmiddlewaretoken" value="invalid-token">', {
        headers: { 'Content-Type': 'text/html', 'Set-Cookie': 'csrftoken=invalid; Path=/' },
      }),
    ];
    for (const page of pages) {
      const backend = mock.method(globalThis, 'fetch', async () => page);
      const { response } = await errorFrom(() => askCourseQuestion(question));
      assert.ok(response.status >= 500);
      assert.equal(backend.mock.callCount(), 1);
      mock.restoreAll();
    }
  });

  it('keeps no-match answers and empty sources explicit', async () => {
    const noMatch = { question, answer: '知识库中没有找到足够相关的内容。', mode: 'no_match', sources: [] };
    stubAnswer(noMatch);
    assert.deepEqual(await askCourseQuestion(question), noMatch);
  });

  it('rejects fabricated modes, invalid source pages and malformed evidence', async () => {
    const malformed = [
      { ...answer, mode: 'guess' },
      { ...answer, answer: '' },
      { ...answer, question: '被替换的问题' },
      { ...answer, sources: 'not evidence' },
      { ...answer, sources: [{ ...answer.sources[0], page: 0 }] },
      { ...answer, sources: [{ ...answer.sources[0], page: 2.5 }] },
      { ...answer, sources: [{ ...answer.sources[0], filename: '/private/source.pdf' }] },
      { ...answer, sources: [{ ...answer.sources[0], excerpt: '' }] },
      { ...answer, sources: [{ ...answer.sources[0], excerpt: 'x'.repeat(16_001) }] },
      { ...answer, sources: [{ ...answer.sources[0], score: '0.9' }] },
      { ...answer, sources: Array.from({ length: 21 }, () => answer.sources[0]) },
      { ...answer, answer: 'x'.repeat(64_001) },
      { ...answer, mode: 'llm', sources: [] },
      { ...answer, mode: 'no_match' },
    ];
    for (const payload of malformed) {
      stubAnswer(payload);
      const { response, text } = await errorFrom(() => askCourseQuestion(question));
      assert.ok(response.status >= 500);
      assert.equal(JSON.parse(text).answer, undefined);
      mock.restoreAll();
    }
  });

  it('maps upstream faults to safe errors without creating an answer', async () => {
    mock.method(globalThis, 'fetch', async (input: FetchInput) =>
      new URL(urlOf(input)).pathname === '/' ? home() : Response.json({
        error: { code: 'index_missing', message: 'SECRET_API_KEY /private/index' },
      }, { status: 503 }),
    );
    const { response, text } = await errorFrom(() => askCourseQuestion(question));
    assert.ok(response.status >= 500);
    assert.doesNotMatch(text, /SECRET_API_KEY|\/private\/index/);
    assert.equal(JSON.parse(text).answer, undefined);
  });
});
