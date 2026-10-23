/**
 * 安全上下文无关的随机 id。
 *
 * `crypto.randomUUID()` 只在**安全上下文**（HTTPS、localhost、127.0.0.1）里存在。
 * 站点一旦用 `http://<公网 IP>` 提供（域名未备案时只能这样），它就是
 * `undefined` —— 直接调用会让 Studio / 使用端在渲染阶段抛
 * `TypeError: crypto.randomUUID is not a function`，整页挂掉。
 *
 * 这里退回到 `crypto.getRandomValues()`（非安全上下文同样提供），
 * 再退回 `Math.random()` 兜底，保证任何部署形态下 id 都能生成。
 */
const BYTE_TO_HEX = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, '0'),
);

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  const api = globalThis.crypto;
  if (typeof api?.getRandomValues === 'function') {
    api.getRandomValues(bytes);
    return bytes;
  }
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
}

/** RFC 4122 v4 形状的 UUID。 */
export function randomId(): string {
  const api = globalThis.crypto;
  if (typeof api?.randomUUID === 'function') {
    return api.randomUUID();
  }
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => BYTE_TO_HEX[byte]);
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}

/**
 * 环境里有没有安全上下文才提供的 Crypto。
 *
 * 用于需要在 UI 上解释"为什么某个功能不可用"的场景（例如 HTTP 部署下
 * 剪贴板 API 不可用），不要在业务逻辑里拿它当开关。
 */
export function hasSecureCrypto(): boolean {
  return typeof globalThis.crypto?.subtle !== 'undefined';
}
