import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enforceRateLimit } from '@/lib/server/security';
import { RateLimitBuckets } from '@/lib/server/rate-limit';

const request = (headers: Record<string, string>) =>
  new Request('https://urtoris.cn/api/state', { headers });

describe('public ingress rate identity', () => {
  it('changing forged Cloudflare and early forwarding headers cannot bypass a real client limit', () => {
    const options = { label: 'spoofed-headers', limit: 2, windowMs: 60_000 };
    for (let index = 0; index < 3; index++) {
      const response = enforceRateLimit(
        request({
          'X-Real-IP': '203.0.113.20',
          'CF-Connecting-IP': `198.51.100.${index + 1}`,
          'X-Forwarded-For': `198.51.100.${index + 1}, 203.0.113.20`,
        }),
        options,
      );
      assert.equal(response?.status ?? 200, index < 2 ? 200 : 429);
      if (response) assert.ok(Number(response.headers.get('Retry-After')) > 0);
    }
    assert.equal(
      enforceRateLimit(request({ 'X-Real-IP': '203.0.113.21' }), options),
      null,
    );
  });

  it('uses the last trusted proxy hop when X-Real-IP is absent', () => {
    const options = { label: 'last-proxy-hop', limit: 1, windowMs: 60_000 };
    assert.equal(
      enforceRateLimit(
        request({ 'X-Forwarded-For': '198.51.100.1, 203.0.113.30' }),
        options,
      ),
      null,
    );
    assert.equal(
      enforceRateLimit(
        request({ 'X-Forwarded-For': '198.51.100.2, 203.0.113.30' }),
        options,
      )?.status,
      429,
    );
  });

  it('invalid addresses share a bucket instead of creating arbitrary keys or falling back to forged CF addresses', () => {
    const options = { label: 'invalid-address', limit: 1, windowMs: 60_000 };
    assert.equal(
      enforceRateLimit(
        request({
          'X-Real-IP': 'attacker-key-1',
          'CF-Connecting-IP': '198.51.100.1',
        }),
        options,
      ),
      null,
    );
    assert.equal(
      enforceRateLimit(
        request({
          'X-Real-IP': 'attacker-key-2',
          'CF-Connecting-IP': '198.51.100.2',
        }),
        options,
      )?.status,
      429,
    );
  });
});

describe('bounded rate buckets', () => {
  it('rejects new identities at capacity without evicting an active limit, then recovers after expiration', () => {
    const limiter = new RateLimitBuckets(2);
    assert.equal(limiter.consume('client-a', 1, 5_000, 1_000), null);
    assert.equal(limiter.consume('client-b', 1, 5_000, 1_000), null);
    assert.ok(limiter.consume('client-c', 1, 5_000, 1_001));
    assert.equal(limiter.consume('client-a', 1, 5_000, 1_002), 5);
    assert.equal(limiter.consume('client-c', 1, 5_000, 6_000), null);
  });

  it("short-window requests cannot expire another endpoint's longer protection window", () => {
    const limiter = new RateLimitBuckets();
    assert.equal(limiter.consume('chat', 1, 60_000, 1_000), null);
    assert.equal(limiter.consume('poll', 10, 1_000, 4_001), null);
    assert.equal(limiter.consume('chat', 1, 60_000, 4_002), 57);
    assert.equal(limiter.consume('chat', 1, 60_000, 61_000), null);
  });
});
