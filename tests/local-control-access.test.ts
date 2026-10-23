import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import {
  isLocalControlEnabled,
  requireLocalControlRequest,
} from '@/lib/server/local-control-access';
import { resetEnv } from './helpers/cloudflare-workers-stub';

afterEach(() => resetEnv());

function request(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { method: 'POST', headers });
}

describe('本机全权限入口', () => {
  it('默认关闭；本机请求会得到明确启动提示', async () => {
    resetEnv();
    assert.equal(isLocalControlEnabled(), false);
    const response = requireLocalControlRequest(
      request('http://127.0.0.1:3000/api/local-control/agent'),
    );
    assert.equal(response?.status, 503);
    const payload = (await response?.json()) as { code?: string };
    assert.equal(payload.code, 'LOCAL_CONTROL_DISABLED');
  });

  it('只在显式开关 + 本机同源条件下放行', () => {
    resetEnv({ LOCAL_CONTROL_ENABLED: '1' });
    assert.equal(
      requireLocalControlRequest(
        request('http://localhost:3000/api/local-control/agent', {
          Origin: 'http://localhost:3000',
          'Sec-Fetch-Site': 'same-origin',
        }),
      ),
      null,
    );
  });

  it('公网域名即使配置了开关也隐藏入口', () => {
    resetEnv({ LOCAL_CONTROL_ENABLED: '1' });
    const response = requireLocalControlRequest(
      request('https://urtoris.cn/api/local-control/agent', {
        Origin: 'https://urtoris.cn',
        'Sec-Fetch-Site': 'same-origin',
      }),
    );
    assert.equal(response?.status, 404);
  });

  it('拒绝跨站来源和伪造 localhost Host 的公网代理请求', () => {
    resetEnv({ LOCAL_CONTROL_ENABLED: '1' });
    const crossSite = requireLocalControlRequest(
      request('http://localhost:3000/api/local-control/agent', {
        Origin: 'https://evil.example',
        'Sec-Fetch-Site': 'cross-site',
      }),
    );
    assert.equal(crossSite?.status, 403);

    const spoofed = requireLocalControlRequest(
      request('http://localhost:3000/api/local-control/agent', {
        Host: 'localhost:3000',
        'X-Forwarded-For': '203.0.113.7',
        'X-Real-IP': '203.0.113.7',
      }),
    );
    assert.equal(spoofed?.status, 404);
  });
});
