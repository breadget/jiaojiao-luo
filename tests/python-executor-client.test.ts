import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  PythonExecutorClientError,
  callPythonExecutor,
  proxyPythonExecutorResponse,
} from '@/lib/server/python-executor-client';
import { resetEnv } from './helpers/cloudflare-workers-stub';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetEnv();
});

describe('website → Python Executor client', () => {
  it('fails closed when the executor URL is not loopback', async () => {
    resetEnv({
      PYTHON_EXECUTOR_URL: 'https://executor.example.com',
      PYTHON_EXECUTOR_TOKEN: 'a'.repeat(64),
    });
    await assert.rejects(
      () => callPythonExecutor('/v1/runs', { method: 'POST', body: '{}' }),
      PythonExecutorClientError,
    );
  });

  it('adds the internal token only to an approved loopback target', async () => {
    resetEnv({
      PYTHON_EXECUTOR_URL: 'http://127.0.0.1:3010',
      PYTHON_EXECUTOR_TOKEN: 'b'.repeat(64),
    });
    let capturedUrl = '';
    let capturedAuthorization = '';
    let capturedRedirect: string | undefined;
    globalThis.fetch = async (input, init) => {
      capturedUrl =
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input;
      capturedAuthorization =
        new Headers(init?.headers).get('Authorization') ?? '';
      capturedRedirect = init?.redirect;
      return Response.json({ ok: true });
    };
    const response = await callPythonExecutor('/v1/runs', {
      method: 'POST',
      body: '{}',
    });
    assert.equal(response.status, 200);
    assert.equal(capturedUrl, 'http://127.0.0.1:3010/v1/runs');
    assert.equal(capturedAuthorization, `Bearer ${'b'.repeat(64)}`);
    // workerd 只接受 follow / manual：必须用 manual 并且自己拒绝 3xx。
    assert.equal(capturedRedirect, 'manual');
  });

  it('treats a redirect from the executor as unavailable instead of following it', async () => {
    resetEnv({
      PYTHON_EXECUTOR_URL: 'http://127.0.0.1:3010',
      PYTHON_EXECUTOR_TOKEN: 'e'.repeat(64),
    });
    globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: { Location: 'https://attacker.example.com/' },
      });
    await assert.rejects(
      () => callPythonExecutor('/v1/runs', { method: 'POST', body: '{}' }),
      PythonExecutorClientError,
    );
  });

  it('does not forward arbitrary internal response headers to the browser', () => {
    const proxied = proxyPythonExecutorResponse(
      new Response('ok', {
        headers: {
          'Content-Type': 'text/plain',
          'Set-Cookie': 'executor-secret=1',
          'X-Internal-Path': '/var/lib/executor',
        },
      }),
    );
    assert.equal(proxied.headers.get('Content-Type'), 'text/plain');
    assert.equal(proxied.headers.get('Set-Cookie'), null);
    assert.equal(proxied.headers.get('X-Internal-Path'), null);
    assert.equal(proxied.headers.get('X-Content-Type-Options'), 'nosniff');
  });
});
