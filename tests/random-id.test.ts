import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { randomId } from '@/lib/random-id';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 临时把某个 Crypto 方法隐藏起来，模拟"非安全上下文"。 */
function withoutCryptoMethod<T>(name: 'randomUUID' | 'getRandomValues', run: () => T): T {
  const cryptoApi = globalThis.crypto as unknown as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(cryptoApi, name);
  Object.defineProperty(cryptoApi, name, {
    value: undefined,
    configurable: true,
    writable: true,
  });
  try {
    return run();
  } finally {
    if (original) Object.defineProperty(cryptoApi, name, original);
    else delete cryptoApi[name];
  }
}

describe('安全上下文无关的随机 id', () => {
  it('安全上下文里直接用 crypto.randomUUID', () => {
    assert.match(randomId(), UUID_V4);
  });

  it('没有 randomUUID 时（HTTP + 公网 IP 部署）仍然生成合法 id', () => {
    // 这正是线上故障的形状：crypto.randomUUID is not a function
    const ids = withoutCryptoMethod('randomUUID', () => [
      randomId(),
      randomId(),
    ]);
    assert.match(ids[0], UUID_V4);
    assert.match(ids[1], UUID_V4);
    assert.notEqual(ids[0], ids[1]);
  });

  it('连 getRandomValues 都没有时退回 Math.random，也不重复', () => {
    const ids = withoutCryptoMethod('randomUUID', () =>
      withoutCryptoMethod('getRandomValues', () => [randomId(), randomId()]),
    );
    assert.match(ids[0], UUID_V4);
    assert.notEqual(ids[0], ids[1]);
  });
});
