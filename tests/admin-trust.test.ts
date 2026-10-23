/**
 * 本机 / 内网访问 = 管理员会话（免令牌）的边界。
 *
 * 这条便捷通道只对「访问入口就是自己人」的请求生效；公网入口、跨站请求、
 * 以及带代理头（真实来源是公网）的请求都必须回到原来的令牌逻辑。
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  isPrivateHostname,
  isTrustedLocalRequest,
  requireAdmin,
} from '@/lib/server/security';
import { installDatabaseMock } from './helpers/api';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { createTestDatabase, type TestDatabase } from './helpers/d1';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

// 整个文件共用一个内存 D1：/api/state 的用例也要用它。
after(() => {
  database.close();
});

const ADMIN_TOKEN = 'test-admin-token';

function request(
  headers: Record<string, string>,
  url = 'http://localhost:3000/api/workflows/wf_demo_triage/graph',
) {
  return new Request(url, { headers });
}

function status(result: Response | null) {
  return result?.status ?? 200;
}

describe('本机/内网免令牌', () => {
  before(() => {
    resetEnv({ URTORIS_ADMIN_TOKEN: ADMIN_TOKEN });
  });

  it('loopback 与私网地址算自己人', () => {
    for (const hostname of [
      'localhost',
      '127.0.0.1',
      '::1',
      '10.43.21.145',
      '192.168.1.20',
      '172.16.3.4',
      '169.254.10.10',
      'my-mac.local',
    ]) {
      assert.equal(isPrivateHostname(hostname), true, hostname);
    }
    for (const hostname of ['urtoris.cn', '203.0.113.9', '8.8.8.8', '172.32.0.1']) {
      assert.equal(isPrivateHostname(hostname), false, hostname);
    }
  });

  it('本机访问不带令牌也能过管理员门禁', () => {
    assert.equal(
      status(requireAdmin(request({ Host: 'localhost:3000' }))),
      200,
    );
    assert.equal(
      status(requireAdmin(request({ Host: '127.0.0.1:3000' }))),
      200,
    );
    assert.equal(
      status(requireAdmin(request({ Host: '192.168.1.20:3000' }))),
      200,
    );
  });

  it('公网入口仍然要令牌：没令牌 503/401，令牌不对 401，令牌正确 200', () => {
    const publicRequest = () =>
      request(
        { Host: 'urtoris.cn' },
        'https://urtoris.cn/api/workflows/wf_demo_triage/graph',
      );
    assert.equal(status(requireAdmin(publicRequest())), 401);
    assert.equal(
      status(
        requireAdmin(
          request(
            { Host: 'urtoris.cn', Authorization: 'Bearer wrong' },
            'https://urtoris.cn/api/workflows/wf_demo_triage/graph',
          ),
        ),
      ),
      401,
    );
    assert.equal(
      status(
        requireAdmin(
          request(
            { Host: 'urtoris.cn', Authorization: `Bearer ${ADMIN_TOKEN}` },
            'https://urtoris.cn/api/workflows/wf_demo_triage/graph',
          ),
        ),
      ),
      200,
    );

    resetEnv({});
    assert.equal(status(requireAdmin(publicRequest())), 503);
    resetEnv({ URTORIS_ADMIN_TOKEN: ADMIN_TOKEN });
  });

  it('代理头暴露了公网来源就不算自己人（防 Host 伪装）', () => {
    assert.equal(
      isTrustedLocalRequest(
        request({
          Host: 'localhost:3000',
          'X-Forwarded-For': '203.0.113.7',
        }),
      ),
      false,
    );
    assert.equal(
      isTrustedLocalRequest(
        request({ Host: 'localhost:3000', 'X-Real-IP': '203.0.113.7' }),
      ),
      false,
    );
    assert.equal(
      isTrustedLocalRequest(
        request({
          Host: 'localhost',
          'X-Forwarded-Host': 'localhost',
          Forwarded: 'for=198.51.100.9;proto=https',
        }),
      ),
      false,
    );
    // 代理链最后一段是本机（本机 dev server 的情况）时仍然信任
    assert.equal(
      isTrustedLocalRequest(
        request({ Host: 'localhost:3000', 'X-Forwarded-For': '127.0.0.1' }),
      ),
      true,
    );
  });

  it('跨站请求永远不信任', () => {
    assert.equal(
      isTrustedLocalRequest(
        request({ Host: 'localhost:3000', 'Sec-Fetch-Site': 'cross-site' }),
      ),
      false,
    );
  });

  it('URTORIS_ADMIN_TRUST_LOCAL=0 可以彻底关掉这条通道', () => {
    resetEnv({
      URTORIS_ADMIN_TOKEN: ADMIN_TOKEN,
      URTORIS_ADMIN_TRUST_LOCAL: '0',
    });
    assert.equal(
      status(requireAdmin(request({ Host: 'localhost:3000' }))),
      401,
    );
    resetEnv({ URTORIS_ADMIN_TOKEN: ADMIN_TOKEN });
  });
});

describe('GET /api/state · adminTrusted', () => {
  type StateRoute = typeof import('@/app/api/state/route');
  let route!: StateRoute;

  before(async () => {
    resetEnv({ URTORIS_ADMIN_TOKEN: ADMIN_TOKEN });
    route = await import('@/app/api/state/route');
  });

  it('把当前访问者的信任级别告诉前端，但不泄露服务端配置', async () => {
    const local = (await (
      await route.GET(request({ Host: 'localhost:3000' }, 'http://localhost:3000/api/state'))
    ).json()) as { adminTrusted?: boolean };
    assert.equal(local.adminTrusted, true);
    assert.equal(JSON.stringify(local).includes(ADMIN_TOKEN), false);

    const publicResponse = await route.GET(
      request({ Host: 'urtoris.cn' }, 'https://urtoris.cn/api/state'),
    );
    const outside = (await publicResponse.json()) as { adminTrusted?: boolean };
    assert.equal(outside.adminTrusted, false);
  });
});
