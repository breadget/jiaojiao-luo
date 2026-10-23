import type { LocalDatabaseSchema } from '@/lib/local-database-protocol';

const ASSISTANT_URL = 'http://127.0.0.1:3022';
const STORAGE_KEY = 'urtoris.database-connection';
export const DATABASE_CONNECTION_EVENT = 'urtoris-database-connection';
let memoryCode = '';

export function subscribeDatabaseConnection(listener: () => void) {
  window.addEventListener(DATABASE_CONNECTION_EVENT, listener);
  return () => window.removeEventListener(DATABASE_CONNECTION_EVENT, listener);
}

export function getDatabaseConnectionCode(): string {
  if (typeof window === 'undefined') return '';
  try {
    return sessionStorage.getItem(STORAGE_KEY) ?? memoryCode;
  } catch {
    return memoryCode;
  }
}

export function setDatabaseConnectionCode(code: string): void {
  if (typeof window === 'undefined') return;
  memoryCode = code.trim();
  try {
    if (code) sessionStorage.setItem(STORAGE_KEY, code.trim());
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    /* 当前浏览器禁止存储时，连接信息不会持久化。 */
  }
  window.dispatchEvent(new Event(DATABASE_CONNECTION_EVENT));
}

export function readDatabasePairingLink(): void {
  const match = window.location.hash.match(/^#database-pair=([a-f0-9]{64})$/);
  if (!match) return;
  setDatabaseConnectionCode(match[1]);
  window.history.replaceState(
    null,
    '',
    window.location.pathname + window.location.search,
  );
}

async function assistantRequest<T>(
  operation: string,
  body?: unknown,
  timeoutMs = 12_000,
  signal?: AbortSignal,
): Promise<T> {
  const token = getDatabaseConnectionCode();
  if (!token) throw new Error('请先启动并连接本机数据库助手。');
  let response: Response;
  try {
    response = await fetch(`${ASSISTANT_URL}/v1/${operation}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
      credentials: 'omit',
    });
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    throw new Error(
      '无法连接电脑上的数据库助手。请运行 npm run database:local，并允许浏览器访问本机网络后重试。',
    );
  }
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error ?? '本机数据库请求失败。');
  return payload;
}

export function checkDatabaseAssistant() {
  return assistantRequest<{ available: boolean; readOnly: boolean }>('status');
}
export function inspectLocalDatabase(filePath: string) {
  return assistantRequest<LocalDatabaseSchema>('inspect', { filePath });
}
export function pickLocalDatabase() {
  return assistantRequest<{ filePath: string | null; cancelled: boolean }>(
    'pick',
    {},
    200_000,
  );
}

export type DatabaseToolRequest = {
  id: string;
  nodeId: string;
  name: string;
  filePath: string;
  operation: 'inspect' | 'query';
  sql?: string;
  parameters?: unknown;
  maxRows?: number;
};
export type DatabaseToolResult = {
  id: string;
  result?: unknown;
  error?: string;
};

export async function executeDatabaseRequests(
  requests: DatabaseToolRequest[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
): Promise<DatabaseToolResult[]> {
  if (!Array.isArray(requests) || requests.length > 4)
    throw new Error('AI 返回了过多数据库操作。');
  const results: DatabaseToolResult[] = [];
  let resultBytes = 0;
  for (const request of requests) {
    signal?.throwIfAborted();
    onProgress?.(
      request.operation === 'inspect'
        ? `正在读取「${request.name}」的表结构…`
        : `正在查询「${request.name}」…`,
    );
    try {
      if (!['inspect', 'query'].includes(request.operation))
        throw new Error('AI 返回了不支持的数据库操作。');
      const result = await assistantRequest(
        request.operation,
        {
          filePath: request.filePath,
          ...(request.operation === 'query'
            ? {
                sql: request.sql,
                parameters: request.parameters,
                maxRows: request.maxRows,
              }
            : {}),
        },
        12_000,
        signal,
      );
      const bytes = new TextEncoder().encode(JSON.stringify(result)).length;
      if (resultBytes + bytes > 40 * 1024)
        throw new Error(
          '本轮查询结果过大，请减少查询字段或使用 LIMIT 后重试。',
        );
      resultBytes += bytes;
      results.push({ id: request.id, result });
    } catch (cause) {
      if (signal?.aborted) signal.throwIfAborted();
      results.push({
        id: request.id,
        error: cause instanceof Error ? cause.message : '本机数据库查询失败。',
      });
    }
  }
  return results;
}
