/**
 * Graph API 测试的公共脚手架。
 *
 * 关键点：`@/db` 用 mock.module 换成运行在内存 SQLite 上的 D1 替身，
 * 所以 route handler 走的是**真实 SQL**（唯一约束、外键、batch 事务都在），
 * 而不是被桩掉的行为。
 */
import { mock } from 'node:test';
import type { SqliteD1 } from './d1';

export const ADMIN_TOKEN = 'test-admin-token';

/** 每个请求换一个来源 IP，避免命中 enforceRateLimit 的同一令牌桶。 */
let addressCounter = 0;
export function nextAddress(): string {
  addressCounter += 1;
  return `10.0.0.${(addressCounter % 250) + 1}`;
}

export function installDatabaseMock(d1: SqliteD1): void {
  // `exports` 是 node:test 里替换整个模块命名空间的新写法（运行时支持），
  // 但 @types/node 22 的 MockModuleOptions 还只声明了已废弃的 namedExports，
  // 所以这里显式断一次类型，而不是用一个已被 lint 禁止的旧字段。
  const options = {
    exports: {
      getD1: () => d1,
      getDb: () => ({}),
    },
  } as unknown as Parameters<typeof mock.module>[1];
  mock.module('@/db', options);
}

export type SeedWorkflowInput = {
  id?: string;
  name?: string;
  description?: string;
  draftSteps?: unknown[];
  publishedSteps?: unknown[] | null;
  version?: number;
  hasUnpublishedChanges?: boolean;
  n8nWebhookUrl?: string | null;
};

export async function seedWorkflow(
  d1: SqliteD1,
  input: SeedWorkflowInput = {},
): Promise<string> {
  const id = input.id ?? 'wf_test';
  const now = 1_700_000_000_000;
  await d1
    .prepare(
      `INSERT INTO workflows (
         id, name, description, draft_steps_json, published_steps_json, version,
         has_unpublished_changes, created_at, updated_at, published_at,
         n8n_webhook_url
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      input.name ?? '测试工作流',
      input.description ?? '夹具',
      JSON.stringify(input.draftSteps ?? []),
      input.publishedSteps ? JSON.stringify(input.publishedSteps) : null,
      input.version ?? 0,
      input.hasUnpublishedChanges ?? true,
      now,
      now,
      null,
      input.n8nWebhookUrl ?? null,
    )
    .run();
  return id;
}

export function graphContext(id: string) {
  return { params: Promise.resolve({ id }) };
}

export function adminRequest(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string | null;
    headers?: Record<string, string>;
  } = {},
): Request {
  const headers: Record<string, string> = {
    'X-Real-IP': nextAddress(),
    ...options.headers,
  };
  if (options.token !== null) {
    headers.Authorization = `Bearer ${options.token ?? ADMIN_TOKEN}`;
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  return new Request(url, {
    method: options.method ?? (body ? 'PUT' : 'GET'),
    headers,
    body,
  });
}

/** 读取 JSON 响应的类型化封装。 */
export async function readJson<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}
