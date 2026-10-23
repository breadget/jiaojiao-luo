import { getD1 } from '@/db';
import type {
  PythonRunObservation,
  PythonRunProfile,
  PythonRunStatus,
} from '@/lib/server/python-agent';

const COOKIE_NAME = 'urtoris_consumer';
const COOKIE_TOKEN_PATTERN = /^v1\.([a-f0-9]{64})$/;
const WORKFLOW_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SESSION_ID_PATTERN = /^session_[a-f0-9]{32}$/;
const RUN_ID_PATTERN = /^run_[a-f0-9]{32}$/;
const TASK_ID_PATTERN = /^task_[a-f0-9]{32}$/;
const MESSAGE_TEXT_LIMIT = 64_000;
const MESSAGE_METADATA_LIMIT = 256 * 1024;
const SESSION_TITLE_LIMIT = 48;

export type ConsumerSession = {
  id: string;
  workflowId: string;
  engineSessionId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
};

export type ConsumerMessageStatus = 'working' | 'completed' | 'failed';

export type ConsumerMessage = {
  id: string;
  sessionId: string;
  role: 'user' | 'agent';
  status: ConsumerMessageStatus;
  text: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
};

export type ConsumerPythonRun = {
  runId: string;
  sessionId: string;
  agentMessageId: string | null;
  taskId: string;
  attempt: number;
  profile: PythonRunProfile;
  status: PythonRunStatus;
  errorCode: string | null;
  errorMessage: string | null;
  artifacts: PythonRunObservation['artifacts'];
  metrics: PythonRunObservation['metrics'];
  limits: PythonRunObservation['limits'];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
};

type SessionRow = {
  id: string;
  workflow_id: string;
  engine_session_id: string;
  title: string;
  created_at: number;
  updated_at: number;
};

type MessageRow = {
  id: string;
  session_id: string;
  role: ConsumerMessage['role'];
  status: ConsumerMessageStatus;
  text: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
};

type PythonRunRow = {
  run_id: string;
  session_id: string;
  agent_message_id: string | null;
  task_id: string;
  attempt: number;
  profile: PythonRunProfile;
  status: PythonRunStatus;
  error_code: string | null;
  error_message: string | null;
  artifacts_json: string;
  metrics_json: string;
  limits_json: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  updated_at: number;
};

export class ConsumerSessionError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ConsumerSessionError';
  }
}

function randomHex(bytes: number): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new ConsumerSessionError('安全随机数服务不可用。', 503);
  }
  const value = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(value);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

async function sha256(value: string): Promise<string> {
  if (!globalThis.crypto?.subtle) {
    throw new ConsumerSessionError('浏览器会话加密服务不可用。', 503);
  }
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  );
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')}`;
}

function cookieToken(request: Request): string | null {
  const raw = request.headers.get('Cookie') ?? '';
  for (const item of raw.split(';')) {
    const [name, ...rest] = item.trim().split('=');
    if (name !== COOKIE_NAME) continue;
    const value = rest.join('=');
    return COOKIE_TOKEN_PATTERN.test(value) ? value : null;
  }
  return null;
}

function serializeCookie(request: Request, token: string): string {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`;
}

function mapSession(row: SessionRow): ConsumerSession {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    engineSessionId: row.engine_session_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function mapMessage(row: MessageRow): ConsumerMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    status: row.status,
    text: row.text,
    metadata: safeJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPythonRun(row: PythonRunRow): ConsumerPythonRun {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    agentMessageId: row.agent_message_id,
    taskId: row.task_id,
    attempt: row.attempt,
    profile: row.profile,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    artifacts: safeJson(row.artifacts_json, []),
    metrics: safeJson(row.metrics_json, {
      queuedMs: null,
      durationMs: null,
      cpuTimeMs: null,
      peakMemoryBytes: null,
    }),
    limits: safeJson(row.limits_json, {
      timeoutSeconds: 0,
      cpuCount: 0,
      memoryBytes: 0,
      processes: 0,
      stdoutBytes: 0,
      stderrBytes: 0,
    }),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    updatedAt: row.updated_at,
  };
}

function parseTime(
  value: string | null,
  fallback: number | null,
): number | null {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

async function findSession(
  browserKeyHash: string,
  workflowId: string,
  sessionId?: string,
): Promise<ConsumerSession | null> {
  if (sessionId && !SESSION_ID_PATTERN.test(sessionId)) {
    throw new ConsumerSessionError('会话编号无效。');
  }
  const row = await getD1()
    .prepare(
      `SELECT id, workflow_id, engine_session_id, title, created_at, updated_at
       FROM consumer_sessions
       WHERE browser_key_hash = ? AND workflow_id = ?
         ${sessionId ? 'AND id = ?' : ''}
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 1`,
    )
    .bind(browserKeyHash, workflowId, ...(sessionId ? [sessionId] : []))
    .first<SessionRow>();
  return row ? mapSession(row) : null;
}

async function insertSession(
  browserKeyHash: string,
  workflowId: string,
): Promise<ConsumerSession> {
  const now = Date.now();
  const id = `session_${randomHex(16)}`;
  await getD1()
    .prepare(
      `INSERT INTO consumer_sessions (
        id, browser_key_hash, workflow_id, engine_session_id, title,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, browserKeyHash, workflowId, id, '新对话', now, now)
    .run();
  const created = await findSession(browserKeyHash, workflowId, id);
  if (!created) {
    throw new ConsumerSessionError('无法创建使用端会话。', 503);
  }
  return created;
}

export async function getOrCreateConsumerSession(
  request: Request,
  workflowId: string,
  sessionId?: string,
): Promise<{ session: ConsumerSession; setCookie: string | null }> {
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new ConsumerSessionError('工作流编号无效。');
  }
  const existingToken = cookieToken(request);
  const token = existingToken ?? `v1.${randomHex(32)}`;
  const browserKeyHash = await sha256(token);
  const existing = await findSession(browserKeyHash, workflowId, sessionId);
  if (existing) {
    return {
      session: existing,
      setCookie: existingToken ? null : serializeCookie(request, token),
    };
  }
  if (sessionId) {
    throw new ConsumerSessionError('这条对话不存在或不属于当前浏览器。', 404);
  }
  return {
    session: await insertSession(browserKeyHash, workflowId),
    setCookie: existingToken ? null : serializeCookie(request, token),
  };
}

export async function createConsumerSession(
  request: Request,
  workflowId: string,
): Promise<{ session: ConsumerSession; setCookie: string | null }> {
  if (!WORKFLOW_ID_PATTERN.test(workflowId)) {
    throw new ConsumerSessionError('工作流编号无效。');
  }
  const existingToken = cookieToken(request);
  const token = existingToken ?? `v1.${randomHex(32)}`;
  const session = await insertSession(await sha256(token), workflowId);
  return {
    session,
    setCookie: existingToken ? null : serializeCookie(request, token),
  };
}

export async function listConsumerSessionsForOwner(
  ownerSessionId: string,
): Promise<ConsumerSession[]> {
  if (!SESSION_ID_PATTERN.test(ownerSessionId)) return [];
  const result = await getD1()
    .prepare(
      `SELECT id, workflow_id, engine_session_id, title, created_at, updated_at
       FROM consumer_sessions
       WHERE browser_key_hash = (
         SELECT browser_key_hash FROM consumer_sessions WHERE id = ? LIMIT 1
       )
       ORDER BY updated_at DESC, created_at DESC
       LIMIT 100`,
    )
    .bind(ownerSessionId)
    .all<SessionRow>();
  return result.results.map(mapSession);
}

export async function getConsumerSession(
  request: Request,
  workflowId: string,
  sessionId?: string,
): Promise<ConsumerSession | null> {
  const token = cookieToken(request);
  if (!token || !WORKFLOW_ID_PATTERN.test(workflowId)) return null;
  return findSession(await sha256(token), workflowId, sessionId);
}

export async function updateConsumerSessionTitle(
  session: ConsumerSession,
  title: string,
): Promise<ConsumerSession> {
  const clean = title.trim().replace(/\s+/g, ' ');
  if (!clean || Array.from(clean).length > SESSION_TITLE_LIMIT) {
    throw new ConsumerSessionError('会话标题无效。');
  }
  const updatedAt = Date.now();
  await getD1()
    .prepare(
      `UPDATE consumer_sessions SET title = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(clean, updatedAt, session.id)
    .run();
  return { ...session, title: clean, updatedAt };
}

export async function listConsumerMessages(
  sessionId: string,
): Promise<ConsumerMessage[]> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return [];
  // 按游标分批读取完整会话；单次 LIMIT 曾让长对话永远只显示最早 200 条。
  const pageSize = 25;
  const messages: ConsumerMessage[] = [];
  let cursor: MessageRow | undefined;
  while (true) {
    const query = getD1().prepare(
      `SELECT id, session_id, role, status, text, metadata_json, created_at, updated_at
       FROM consumer_messages
       WHERE session_id = ?${
         cursor ? ' AND (created_at > ? OR (created_at = ? AND id > ?))' : ''
       }
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
    );
    const result = await (
      cursor
        ? query.bind(
            sessionId,
            cursor.created_at,
            cursor.created_at,
            cursor.id,
            pageSize,
          )
        : query.bind(sessionId, pageSize)
    ).all<MessageRow>();
    messages.push(...result.results.map(mapMessage));
    if (result.results.length < pageSize) return messages;
    cursor = result.results.at(-1);
  }
}

export async function getConsumerMessage(
  sessionId: string,
  messageId: string,
): Promise<ConsumerMessage | null> {
  if (
    !SESSION_ID_PATTERN.test(sessionId) ||
    !MESSAGE_ID_PATTERN.test(messageId)
  ) {
    throw new ConsumerSessionError('消息编号无效。');
  }
  const row = await getD1()
    .prepare('SELECT * FROM consumer_messages WHERE session_id = ? AND id = ?')
    .bind(sessionId, messageId)
    .first<MessageRow>();
  return row ? mapMessage(row) : null;
}

export async function upsertConsumerMessage(
  session: ConsumerSession,
  input: {
    id: string;
    role: ConsumerMessage['role'];
    status: ConsumerMessageStatus;
    text: string;
    metadata?: Record<string, unknown>;
    createdAt?: number;
    /** Public message saves cannot replace server-owned database progress. */
    preserveDatabaseChat?: boolean;
  },
): Promise<void> {
  if (!MESSAGE_ID_PATTERN.test(input.id)) {
    throw new ConsumerSessionError('消息编号无效。');
  }
  if (input.role !== 'user' && input.role !== 'agent') {
    throw new ConsumerSessionError('消息角色无效。');
  }
  if (!['working', 'completed', 'failed'].includes(input.status)) {
    throw new ConsumerSessionError('消息状态无效。');
  }
  if (
    typeof input.text !== 'string' ||
    input.text.length > MESSAGE_TEXT_LIMIT
  ) {
    throw new ConsumerSessionError('消息内容过长。');
  }
  const metadata = JSON.stringify(input.metadata ?? {}, (key, value) =>
    key === 'previewUrl' ? undefined : value,
  );
  if (metadata.length > MESSAGE_METADATA_LIMIT) {
    throw new ConsumerSessionError('消息附加信息过长。');
  }
  const now = Date.now();
  const createdAt =
    typeof input.createdAt === 'number' && Number.isFinite(input.createdAt)
      ? Math.min(input.createdAt, now)
      : now;
  await getD1()
    .prepare(
      `INSERT INTO consumer_messages (
        id, session_id, role, status, text, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        status = excluded.status,
        text = excluded.text,
        metadata_json = ${
          input.preserveDatabaseChat
            ? `CASE WHEN json_type(consumer_messages.metadata_json, '$.databaseChat') = 'object'
              THEN json_set(excluded.metadata_json, '$.databaseChat', json_extract(consumer_messages.metadata_json, '$.databaseChat'))
              ELSE excluded.metadata_json END`
            : 'excluded.metadata_json'
        },
        updated_at = excluded.updated_at
      WHERE consumer_messages.session_id = excluded.session_id
        AND consumer_messages.role = excluded.role`,
    )
    .bind(
      input.id,
      session.id,
      input.role,
      input.status,
      input.text,
      metadata,
      createdAt,
      now,
    )
    .run();
  await getD1()
    .prepare(`UPDATE consumer_sessions SET updated_at = ? WHERE id = ?`)
    .bind(now, session.id)
    .run();
}

export async function upsertConsumerPythonRun(
  session: ConsumerSession,
  taskId: string,
  agentMessageId: string | null,
  observation: PythonRunObservation,
): Promise<void> {
  if (
    !TASK_ID_PATTERN.test(taskId) ||
    !RUN_ID_PATTERN.test(observation.runId) ||
    (agentMessageId !== null && !MESSAGE_ID_PATTERN.test(agentMessageId))
  ) {
    throw new ConsumerSessionError('Python 运行关联编号无效。');
  }
  const now = Date.now();
  const createdAt = parseTime(observation.createdAt, now) ?? now;
  const startedAt = parseTime(
    observation.startedAt,
    observation.status === 'running' ? now : null,
  );
  const finishedAt = parseTime(
    observation.finishedAt,
    observation.status === 'queued' || observation.status === 'running'
      ? null
      : now,
  );
  await getD1()
    .prepare(
      `INSERT INTO consumer_python_runs (
        run_id, session_id, agent_message_id, task_id, attempt, profile, status,
        error_code, error_message, artifacts_json, metrics_json, limits_json,
        created_at, started_at, finished_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET
        status = excluded.status,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        artifacts_json = excluded.artifacts_json,
        metrics_json = excluded.metrics_json,
        limits_json = excluded.limits_json,
        started_at = COALESCE(consumer_python_runs.started_at, excluded.started_at),
        finished_at = excluded.finished_at,
        updated_at = excluded.updated_at
      WHERE consumer_python_runs.session_id = excluded.session_id
        AND consumer_python_runs.task_id = excluded.task_id`,
    )
    .bind(
      observation.runId,
      session.id,
      agentMessageId,
      taskId,
      observation.attempt,
      observation.profile,
      observation.status,
      observation.error?.code ?? null,
      observation.error?.message.slice(0, 500) ?? null,
      JSON.stringify(observation.artifacts),
      JSON.stringify(observation.metrics),
      JSON.stringify(observation.limits),
      createdAt,
      startedAt,
      finishedAt,
      now,
    )
    .run();
}

export async function listConsumerPythonRuns(
  sessionId: string,
): Promise<ConsumerPythonRun[]> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return [];
  const result = await getD1()
    .prepare(
      `SELECT run_id, session_id, agent_message_id, task_id, attempt, profile,
        status, error_code, error_message, artifacts_json, metrics_json,
        limits_json, created_at, started_at, finished_at, updated_at
       FROM consumer_python_runs
       WHERE session_id = ?
       ORDER BY created_at DESC, run_id DESC
       LIMIT 100`,
    )
    .bind(sessionId)
    .all<PythonRunRow>();
  return result.results.map(mapPythonRun);
}

export async function consumerOwnsPythonRun(
  request: Request,
  taskId: string,
  runId: string,
): Promise<boolean> {
  const token = cookieToken(request);
  if (!token || !TASK_ID_PATTERN.test(taskId) || !RUN_ID_PATTERN.test(runId)) {
    return false;
  }
  const row = await getD1()
    .prepare(
      `SELECT r.run_id
       FROM consumer_python_runs r
       JOIN consumer_sessions s ON s.id = r.session_id
       WHERE s.browser_key_hash = ? AND r.task_id = ? AND r.run_id = ?
       LIMIT 1`,
    )
    .bind(await sha256(token), taskId, runId)
    .first<{ run_id: string }>();
  return Boolean(row);
}

export function consumerSessionErrorResponse(cause: unknown): Response {
  if (cause instanceof ConsumerSessionError) {
    return Response.json(
      { error: cause.message, code: 'CONSUMER_SESSION_ERROR' },
      { status: cause.status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  return Response.json(
    { error: '使用端会话暂时不可用。', code: 'CONSUMER_SESSION_ERROR' },
    { status: 503, headers: { 'Cache-Control': 'no-store' } },
  );
}
