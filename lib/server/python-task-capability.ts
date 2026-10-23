import { env } from 'cloudflare:workers';

const TASK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;

/** 无账号阶段唯一的任务 ID 形状；上游校验直接复用它，避免两处漂移。 */
export const PYTHON_TASK_ID_PATTERN = /^task_[a-f0-9]{32}$/;

type TaskCapability = {
  taskId: string;
  taskToken: string;
  expiresAt: string;
};

export class PythonTaskCapabilityError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'PythonTaskCapabilityError';
    this.status = status;
  }
}

function randomHex(bytes: number): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new PythonTaskCapabilityError('安全随机数服务不可用。', 503);
  }
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function base64Url(bytes: ArrayBuffer): string {
  const value = new Uint8Array(bytes);
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll(/=+$/g, '');
}

async function signingKey(): Promise<CryptoKey> {
  const secret = env.PYTHON_TASK_SIGNING_KEY?.trim() ?? '';
  if (secret.length < 32 || !globalThis.crypto?.subtle) {
    throw new PythonTaskCapabilityError('Python 任务授权尚未安全配置。', 503);
  }
  return globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function createPythonTaskCapability(
  now = Date.now(),
): Promise<TaskCapability> {
  const key = await signingKey();
  const taskId = `task_${randomHex(16)}`;
  const expiresAtMs = now + TASK_LIFETIME_MS;
  const nonce = randomHex(16);
  const unsigned = `${taskId}.${expiresAtMs}.${nonce}`;
  const signature = await globalThis.crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(unsigned),
  );
  return {
    taskId,
    taskToken: `${unsigned}.${base64Url(signature)}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export async function verifyPythonTaskCapability(options: {
  taskId: string;
  taskToken: string;
  now?: number;
}): Promise<boolean> {
  const key = await signingKey();
  if (!PYTHON_TASK_ID_PATTERN.test(options.taskId)) return false;
  const parts = options.taskToken.split('.');
  if (parts.length !== 4) return false;
  const [taskId, expiresRaw, nonce, signatureRaw] = parts;
  if (
    taskId !== options.taskId ||
    !/^\d{13}$/.test(expiresRaw) ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{43}$/.test(signatureRaw)
  ) {
    return false;
  }
  const expiresAt = Number(expiresRaw);
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;
  if (expiresAt - now > TASK_LIFETIME_MS) return false;

  const normalized = signatureRaw.replaceAll('-', '+').replaceAll('_', '/');
  let signature: Uint8Array<ArrayBuffer>;
  try {
    const binary = atob(`${normalized}=`);
    signature = new Uint8Array(new ArrayBuffer(binary.length));
    for (let index = 0; index < binary.length; index += 1) {
      signature[index] = binary.charCodeAt(index);
    }
  } catch {
    return false;
  }
  if (base64Url(signature.buffer) !== signatureRaw) return false;
  const unsigned = `${taskId}.${expiresRaw}.${nonce}`;
  return globalThis.crypto.subtle.verify(
    'HMAC',
    key,
    signature,
    new TextEncoder().encode(unsigned),
  );
}

export async function requirePythonTaskCapability(
  request: Request,
  taskId: string,
): Promise<Response | null> {
  const taskToken = request.headers.get('X-Urtoris-Task-Token')?.trim() ?? '';
  try {
    if (
      taskToken &&
      (await verifyPythonTaskCapability({ taskId, taskToken }))
    ) {
      return null;
    }
  } catch (cause) {
    if (cause instanceof PythonTaskCapabilityError) {
      return Response.json(
        { error: cause.message, code: 'PYTHON_TASK_UNAVAILABLE' },
        { status: cause.status, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    throw cause;
  }
  return Response.json(
    { error: 'Python 任务授权无效或已过期。', code: 'PYTHON_TASK_FORBIDDEN' },
    { status: 403, headers: { 'Cache-Control': 'no-store' } },
  );
}
