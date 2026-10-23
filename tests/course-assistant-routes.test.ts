import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { POST } from '@/app/api/course/ask/route';
import { GET } from '@/app/api/course/status/route';
import { requireCourseRequest } from '@/lib/server/course-assistant-client';
import { resetEnv } from './helpers/cloudflare-workers-stub';

const question = '队列的复杂度是多少？';
const csrfCookie = 'c'.repeat(32);
const csrfToken = 'd'.repeat(64);
const status = {
  ready: true,
  document_count: 1,
  page_count: 15,
  chunk_count: 33,
  documents: [{ name: '数据结构与算法知识库文档.pdf', pages: 15 }],
  llm_configured: false,
};
const answer = {
  question,
  answer: '已找到 1 条相关原文。',
  mode: 'retrieval_only',
  sources: [{ id: 'queue-1', filename: '课程.pdf', page: 1, excerpt: '入队和出队通常为 O(1)。', score: 0.9 }],
};
let address = 1;
type FetchInput = Parameters<typeof fetch>[0];

function requestBody(init: RequestInit | undefined): { question: string } {
  assert.equal(typeof init?.body, 'string');
  return JSON.parse(init?.body as string);
}

function request(body: unknown, headers: HeadersInit = {}, url = 'http://127.0.0.1:3000/api/course/ask') {
  const requestHeaders = new Headers(headers);
  if (!requestHeaders.has('Content-Type')) requestHeaders.set('Content-Type', 'application/json');
  if (!requestHeaders.has('X-Real-IP')) requestHeaders.set('X-Real-IP', `127.0.0.${address++}`);
  return new Request(url, {
    method: 'POST',
    headers: requestHeaders,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function home() {
  return new Response(`<input value='${csrfToken}' type='hidden' name='csrfmiddlewaretoken'>`, {
    headers: {
      'Content-Type': 'text/html',
      'Set-Cookie': `csrftoken=${csrfCookie}; Path=/; SameSite=Lax`,
    },
  });
}

afterEach(() => {
  mock.restoreAll();
  resetEnv();
});

describe('course knowledge routes in the main website', () => {
  it('serves the existing knowledge inventory on a local page with no enable flag', async () => {
    const backend = mock.method(globalThis, 'fetch', async () => Response.json(status, {
      headers: { 'Set-Cookie': 'private-backend-cookie=1', 'X-Debug': 'private' },
    }));
    const response = await GET(new Request('http://127.0.0.1:3000/api/course/status'));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('X-Debug'), null);
    assert.equal(backend.mock.callCount(), 1);
  });

  it('rejects public, cross-site, mismatched-origin and spoofed proxy requests before the knowledge backend', async () => {
    const backend = mock.method(globalThis, 'fetch', async () => Response.json(status));
    const invalidRequests = [
      new Request('https://urtoris.cn/api/course/status', {
        headers: { Origin: 'https://urtoris.cn', 'Sec-Fetch-Site': 'same-origin' },
      }),
      new Request('http://localhost:3000/api/course/status', {
        headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      }),
      new Request('http://localhost:3000/api/course/status', {
        headers: { Origin: 'http://localhost:4000', 'Sec-Fetch-Site': 'same-origin' },
      }),
      new Request('http://localhost:3000/api/course/status', {
        headers: { Host: 'localhost:3000', 'X-Forwarded-For': '203.0.113.7', 'X-Real-IP': '203.0.113.7' },
      }),
      new Request('http://localhost:3000/api/course/status', {
        headers: { 'X-Forwarded-Host': 'urtoris.cn', 'X-Forwarded-Proto': 'https' },
      }),
    ];
    for (const incoming of invalidRequests) {
      const response = await GET(incoming);
      assert.ok(response.status === 403 || response.status === 404);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
    }
    assert.equal(backend.mock.callCount(), 0);
  });

  it('applies the same local-only gate to question submissions', async () => {
    const backend = mock.method(globalThis, 'fetch', async () => Response.json(answer));
    for (const incoming of [
      request({ question }, { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' }),
      request({ question }, {}, 'https://urtoris.cn/api/course/ask'),
      request({ question }, { 'X-Real-IP': '198.51.100.8', Host: 'localhost:3000' }),
    ]) {
      const response = await POST(incoming);
      assert.ok(response.status === 403 || response.status === 404);
    }
    assert.equal(backend.mock.callCount(), 0);
  });

  it('honors the existing local-trust disable switch', () => {
    resetEnv({ URTORIS_ADMIN_TRUST_LOCAL: '0' });
    assert.equal(requireCourseRequest(new Request('http://localhost:3000/api/course/status'))?.status, 404);
  });

  it('opens only the configured HTTPS course origin while keeping cross-site requests blocked', async () => {
    resetEnv({ COURSE_ASSISTANT_PUBLIC_ORIGIN: 'https://urtoris.cn' });
    const backend = mock.method(globalThis, 'fetch', async () => Response.json(status));
    const publicResponse = await GET(new Request('https://urtoris.cn/api/course/status', {
      headers: { Origin: 'https://urtoris.cn', 'Sec-Fetch-Site': 'same-origin' },
    }));
    assert.equal(publicResponse.status, 200);
    const proxiedResponse = await GET(new Request('http://127.0.0.1:3000/api/course/status', {
      headers: {
        Origin: 'https://urtoris.cn', 'Sec-Fetch-Site': 'same-origin',
        Host: 'urtoris.cn', 'X-Forwarded-Proto': 'https',
        'X-Real-IP': '203.0.113.7',
      },
    }));
    assert.equal(proxiedResponse.status, 200);
    for (const incoming of [
      new Request('https://other.example/api/course/status'),
      new Request('http://urtoris.cn/api/course/status'),
      new Request('https://urtoris.cn/api/course/status', {
        headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      }),
    ]) assert.ok(requireCourseRequest(incoming));
    assert.equal(backend.mock.callCount(), 2);
  });

  it('fails closed for malformed or non-HTTPS publication configuration', () => {
    for (const configured of ['*', 'http://urtoris.cn', 'https://urtoris.cn/path',
      'https://name:secret@urtoris.cn', 'https://urtoris.cn?token=secret']) {
      resetEnv({ COURSE_ASSISTANT_PUBLIC_ORIGIN: configured });
      assert.equal(requireCourseRequest(new Request('https://urtoris.cn/api/course/status'))?.status, 404);
    }
  });

  it('submits a public question using only the backend CSRF session', async () => {
    resetEnv({ COURSE_ASSISTANT_PUBLIC_ORIGIN: 'https://urtoris.cn' });
    const backend = mock.method(globalThis, 'fetch', async (input: FetchInput) =>
      new URL(input instanceof Request ? input.url : String(input)).pathname === '/' ? home() : Response.json(answer));
    const response = await POST(request({ question }, {
      Origin: 'https://urtoris.cn', 'Sec-Fetch-Site': 'same-origin',
      'X-Real-IP': '203.0.113.90',
    }, 'https://urtoris.cn/api/course/ask'));
    assert.equal(response.status, 200);
    assert.equal(backend.mock.callCount(), 2);
  });

  it('cannot bypass the public question quota by rotating a forged Cloudflare address', async () => {
    resetEnv({ COURSE_ASSISTANT_PUBLIC_ORIGIN: 'https://urtoris.cn' });
    mock.method(globalThis, 'fetch', async (input: FetchInput) =>
      new URL(input instanceof Request ? input.url : String(input)).pathname === '/' ? home() : Response.json(answer));
    for (let index = 0; index < 13; index += 1) {
      const response = await POST(request({ question }, {
        Origin: 'https://urtoris.cn', 'Sec-Fetch-Site': 'same-origin',
        'X-Real-IP': '203.0.113.101', 'CF-Connecting-IP': `198.51.100.${index}`,
      }, 'https://urtoris.cn/api/course/ask'));
      assert.equal(response.status, index < 12 ? 200 : 429);
    }
  });

  it('rejects invalid question values, malformed JSON and non-object bodies without a backend call', async () => {
    const backend = mock.method(globalThis, 'fetch', async () => home());
    const invalidBodies: unknown[] = [
      {},
      { question: '' },
      { question: ' \n\t ' },
      { question: null },
      { question: 3 },
      { question: ['队列'] },
      { question: 'a'.repeat(2001) },
      '{"question":',
      'null',
      '[]',
      '"队列"',
    ];
    for (const body of invalidBodies) {
      const response = await POST(request(body));
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('Cache-Control'), 'no-store');
      assert.equal((await response.json() as { answer?: unknown }).answer, undefined);
    }
    assert.equal(backend.mock.callCount(), 0);
  });

  it('requires JSON content type and limits the actual body rather than trusting Content-Length', async () => {
    const backend = mock.method(globalThis, 'fetch', async () => home());
    const wrongType = await POST(request({ question }, { 'Content-Type': 'text/plain' }));
    assert.equal(wrongType.status, 415);

    const oversized = await POST(request({ question: 'x'.repeat(17 * 1024) }, { 'Content-Length': '1' }));
    assert.equal(oversized.status, 413);

    const advertisedTooLarge = await POST(request({ question }, { 'Content-Length': String(17 * 1024) }));
    assert.equal(advertisedTooLarge.status, 413);
    assert.equal(backend.mock.callCount(), 0);
  });

  it('posts a trimmed question with backend-owned CSRF credentials and leaves browser credentials behind', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mock.method(globalThis, 'fetch', async (input: FetchInput, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ url, init });
      return new URL(url).pathname === '/' ? home() : Response.json(answer, {
        headers: { 'Set-Cookie': 'backend-secret=1', 'X-Internal': '/private/course' },
      });
    });
    const response = await POST(request({ question: `\n ${question}  `, api_key: 'BODY_SECRET' }, {
      Origin: 'http://127.0.0.1:3000',
      'Sec-Fetch-Site': 'same-origin',
      Authorization: 'Bearer BROWSER_SECRET',
      Cookie: 'csrftoken=browser-csrf; sessionid=BROWSER_SECRET',
      'X-CSRFToken': 'BROWSER_SECRET',
    }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), answer);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Set-Cookie'), null);
    assert.equal(response.headers.get('X-Internal'), null);
    assert.equal(calls.length, 2);
    for (const call of calls) {
      assert.doesNotMatch(JSON.stringify({ headers: Object.fromEntries(new Headers(call.init?.headers)), body: call.init?.body }), /BROWSER_SECRET|BODY_SECRET|browser-csrf/);
    }
    const post = calls[1];
    assert.deepEqual(requestBody(post.init), { question });
    assert.equal(new Headers(post.init?.headers).get('Cookie'), `csrftoken=${csrfCookie}`);
    assert.equal(new Headers(post.init?.headers).get('X-CSRFToken'), csrfToken);
  });

  it('accepts the 2000 character limit and rejects repeated questions once the local quota is used', async () => {
    const longQuestion = '队'.repeat(2000);
    mock.method(globalThis, 'fetch', async (input: FetchInput, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).pathname === '/') return home();
      return Response.json({ ...answer, question: requestBody(init).question });
    });
    const boundaryResponse = await POST(request({ question: longQuestion }));
    assert.equal(boundaryResponse.status, 200);
    assert.equal((await boundaryResponse.json() as { question: string }).question, longQuestion);

    const client = `127.0.0.${address++}`;
    for (let index = 0; index < 12; index += 1) {
      const response = await POST(request({ question }, { 'X-Real-IP': client }));
      assert.equal(response.status, 200);
    }
    const throttled = await POST(request({ question }, { 'X-Real-IP': client }));
    assert.equal(throttled.status, 429);
    assert.ok(Number(throttled.headers.get('Retry-After')) > 0);
  });

  it('returns a safe service error when the local course service is down', async () => {
    mock.method(globalThis, 'fetch', async () => {
      throw new Error('SECRET_KEY failed on /private/index');
    });
    const response = await GET(new Request('http://127.0.0.1:3000/api/course/status'));
    assert.ok(response.status >= 500);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const text = await response.text();
    assert.doesNotMatch(text, /SECRET_KEY|\/private\/index/);
    assert.equal(JSON.parse(text).answer, undefined);
  });
});
