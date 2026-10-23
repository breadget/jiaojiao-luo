import { getD1 } from '@/db';
import type { AgentAnalysis } from '@/lib/server/agent-brain';
import type { UrtorisResponse } from '@/lib/server/protocol';
import { summarizeEnvelope } from '@/lib/server/protocol';
import type {
  N8nEvent,
  N8nExecutionBinding,
  RunEngine,
  RunLog,
  RunMode,
  PublicWorkflowRecord,
  PublicWorkflowRun,
  WorkflowRecord,
  WorkflowRun,
  WorkflowStep,
} from '@/lib/workflow-types';

type WorkflowRow = {
  id: string;
  name: string;
  description: string;
  draft_steps_json: string;
  published_steps_json: string | null;
  version: number;
  has_unpublished_changes: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  n8n_webhook_url: string | null;
};

type RunRow = {
  id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  status: WorkflowRun['status'];
  steps_json: string;
  logs_json: string;
  output_json: string;
  started_at: number;
  finished_at: number | null;
  request_id?: string | null;
  session_id?: string | null;
  engine?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  duration_ms?: number | null;
  attempts?: number | null;
  execution_id?: string | null;
  mode?: string | null;
  degraded?: number | null;
};

type N8nExecutionBindingRow = {
  execution_id: string;
  request_id: string;
  workflow_id: string;
  workflow_name: string | null;
  session_id: string | null;
  created_at: number;
};

type N8nEventRow = {
  id: string;
  request_id: string | null;
  session_id: string | null;
  workflow: string | null;
  execution_id: string | null;
  level: N8nEvent['level'];
  event_type: string;
  node: string | null;
  message: string;
  payload_json: string | null;
  duration_ms: number | null;
  created_at: number;
};

/** runs 表所有列，抽出来避免每条 SELECT 各写一遍。 */
const RUN_COLUMNS = `id, workflow_id, workflow_name, workflow_version, status,
  steps_json, logs_json, output_json, started_at, finished_at,
  request_id, session_id, engine, error_code, error_message,
  duration_ms, attempts, execution_id, mode, degraded`;

function parseJson<T>(value: string): T {
  return JSON.parse(value) as T;
}

export function mapWorkflow(row: WorkflowRow): WorkflowRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    draftSteps: parseJson<WorkflowStep[]>(row.draft_steps_json),
    publishedSteps: row.published_steps_json
      ? parseJson<WorkflowStep[]>(row.published_steps_json)
      : null,
    version: row.version,
    hasUnpublishedChanges: Boolean(row.has_unpublished_changes),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
    n8nWebhookUrl: row.n8n_webhook_url ?? null,
  };
}

export function mapRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    status: row.status,
    steps: parseJson<WorkflowStep[]>(row.steps_json),
    logs: parseJson<RunLog[]>(row.logs_json),
    output: parseJson<WorkflowRun['output']>(row.output_json),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    engine: (row.engine as RunEngine | null) ?? undefined,
    requestId: row.request_id ?? null,
    sessionId: row.session_id ?? null,
    errorCode: row.error_code ?? null,
    errorMessage: row.error_message ?? null,
    durationMs: row.duration_ms ?? null,
    attempts: row.attempts ?? null,
    executionId: row.execution_id ?? null,
    mode: (row.mode as RunMode | null) ?? null,
    degraded:
      row.degraded === null || row.degraded === undefined
        ? null
        : Boolean(row.degraded),
  };
}

/**
 * 公开状态专用 DTO：状态轮询不应把用户原文、模型回复、内部日志、
 * session/request/execution 关联标识下发给任何浏览器。
 */
export function toPublicRun(run: WorkflowRun): PublicWorkflowRun {
  return {
    id: run.id,
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    workflowVersion: run.workflowVersion,
    status: run.status,
    steps: run.steps,
    logs: [],
    output: {
      summary: run.output.summary,
      processed: run.output.processed,
      result: run.status === 'completed' ? '执行完成' : '执行失败',
    },
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    engine: run.engine,
    requestId: null,
    sessionId: null,
    errorMessage: null,
    executionId: null,
    mode: run.mode,
    degraded: run.degraded,
  };
}

export function toPublicWorkflow(
  workflow: WorkflowRecord,
): PublicWorkflowRecord {
  return {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    draftSteps: workflow.draftSteps,
    publishedSteps: workflow.publishedSteps,
    version: workflow.version,
    hasUnpublishedChanges: workflow.hasUnpublishedChanges,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
    publishedAt: workflow.publishedAt,
    n8nWebhookUrl: workflow.n8nWebhookUrl,
  };
}

function mapN8nExecutionBinding(
  row: N8nExecutionBindingRow,
): N8nExecutionBinding {
  return {
    executionId: row.execution_id,
    requestId: row.request_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}

function mapN8nEvent(row: N8nEventRow): N8nEvent {
  return {
    id: row.id,
    requestId: row.request_id,
    sessionId: row.session_id,
    workflow: row.workflow,
    executionId: row.execution_id,
    level: row.level,
    eventType: row.event_type,
    node: row.node,
    message: row.message,
    payload: row.payload_json ? safeParse(row.payload_json) : null,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export async function getLatestWorkflow() {
  const row = await getD1()
    .prepare(
      `SELECT id, name, description, draft_steps_json, published_steps_json,
        version, has_unpublished_changes, created_at, updated_at, published_at,
        n8n_webhook_url
       FROM workflows
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 1`,
    )
    .first<WorkflowRow>();

  return row ? mapWorkflow(row) : null;
}

export async function getWorkflowById(id: string) {
  const row = await getD1()
    .prepare(
      `SELECT id, name, description, draft_steps_json, published_steps_json,
        version, has_unpublished_changes, created_at, updated_at, published_at,
        n8n_webhook_url
       FROM workflows
       WHERE id = ? AND deleted_at IS NULL
       LIMIT 1`,
    )
    .bind(id)
    .first<WorkflowRow>();

  return row ? mapWorkflow(row) : null;
}

export async function listWorkflows() {
  const result = await getD1()
    .prepare(
      `SELECT id, name, description, draft_steps_json, published_steps_json,
        version, has_unpublished_changes, created_at, updated_at, published_at,
        n8n_webhook_url
       FROM workflows
       WHERE deleted_at IS NULL
       ORDER BY updated_at DESC
       LIMIT 24`,
    )
    .all<WorkflowRow>();

  return result.results.map(mapWorkflow);
}

export async function createWorkflow() {
  const now = Date.now();
  const id = `wf_${crypto.randomUUID().slice(0, 8)}`;
  const steps: WorkflowStep[] = [
    {
      id: `step_${crypto.randomUUID().slice(0, 8)}`,
      title: '接收请求',
      detail: '接收用户的请求内容',
      kind: 'input',
    },
  ];

  await getD1()
    .prepare(
      `INSERT INTO workflows (
        id, name, description, draft_steps_json, published_steps_json, version,
        has_unpublished_changes, created_at, updated_at, published_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      '未命名工作流',
      '描述这个工作流要完成什么',
      JSON.stringify(steps),
      null,
      0,
      1,
      now,
      now,
      null,
    )
    .run();

  const workflow = await getWorkflowById(id);
  if (!workflow) throw new Error('Failed to create workflow.');
  return workflow;
}

export type DeleteWorkflowResult = 'deleted' | 'not_found' | 'last_workflow';

/**
 * 从活动列表删除一个工作流。
 *
 * 这里故意使用软删除：运行、会话、Graph 草稿和不可变发布版本都是审计证据，
 * 列表操作不应把它们级联清空。最后一个活动工作流也不会被删除，避免 Studio
 * 进入没有可编辑目标的损坏状态；用户可以先新建再删除。
 */
export async function deleteWorkflow(
  id: string,
): Promise<DeleteWorkflowResult> {
  const existing = await getD1()
    .prepare(
      `SELECT id FROM workflows WHERE id = ? AND deleted_at IS NULL LIMIT 1`,
    )
    .bind(id)
    .first<{ id: string }>();
  if (!existing) return 'not_found';

  const now = Date.now();
  const result = await getD1()
    .prepare(
      `UPDATE workflows
       SET deleted_at = ?, updated_at = ?
       WHERE id = ?
         AND deleted_at IS NULL
         AND (SELECT COUNT(*) FROM workflows WHERE deleted_at IS NULL) > 1`,
    )
    .bind(now, now, id)
    .run();

  return (result.meta?.changes ?? 0) > 0 ? 'deleted' : 'last_workflow';
}

export async function getRecentRuns(
  workflowId?: string,
  options: { limit?: number; offset?: number } = {},
) {
  const limit = Math.min(Math.max(options.limit ?? 8, 1), 100);
  const offset = Math.min(Math.max(options.offset ?? 0, 0), 10_000);
  const statement = workflowId
    ? getD1()
        .prepare(
          `SELECT ${RUN_COLUMNS}
           FROM runs
           WHERE workflow_id = ?
           ORDER BY started_at DESC
           LIMIT ? OFFSET ?`,
        )
        .bind(workflowId, limit, offset)
    : getD1().prepare(
        `SELECT ${RUN_COLUMNS}
         FROM runs
         ORDER BY started_at DESC
         LIMIT ? OFFSET ?`,
      ).bind(limit, offset);

  const result = await statement.all<RunRow>();
  return result.results.map(mapRun);
}

/** 按 requestId 反查一次运行 —— 排错时唯一的入口。 */
export async function getRunByRequestId(requestId: string) {
  const row = await getD1()
    .prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE request_id = ? LIMIT 1`)
    .bind(requestId)
    .first<RunRow>();
  return row ? mapRun(row) : null;
}

export async function listN8nEvents(options: {
  requestId?: string;
  limit?: number;
}): Promise<N8nEvent[]> {
  const limit = Math.min(Math.max(options.limit ?? 40, 1), 200);
  const statement = options.requestId
    ? getD1()
        .prepare(
          `SELECT * FROM n8n_events WHERE request_id = ? ORDER BY created_at DESC LIMIT ?`,
        )
        .bind(options.requestId, limit)
    : getD1()
        .prepare(`SELECT * FROM n8n_events ORDER BY created_at DESC LIMIT ?`)
        .bind(limit);

  const result = await statement.all<N8nEventRow>();
  return result.results.map(mapN8nEvent);
}

export type N8nEventInput = {
  requestId?: string | null;
  sessionId?: string | null;
  workflowId?: string | null;
  workflow?: string | null;
  executionId?: string | null;
  level?: N8nEvent['level'];
  eventType?: string;
  node?: string | null;
  message?: string;
  payload?: unknown;
  durationMs?: number | null;
};

/** executionId 已经绑到另一个 requestId：不允许覆盖，由调用方决定怎么报错。 */
export class ExecutionBindingConflict extends Error {
  constructor(
    public readonly executionId: string,
    public readonly existingRequestId: string,
    public readonly incomingRequestId: string,
  ) {
    super(
      `executionId ${executionId} 已绑定到 requestId ${existingRequestId}，拒绝覆盖为 ${incomingRequestId}。`,
    );
    this.name = 'ExecutionBindingConflict';
  }
}

export type ExecutionBindingOutcome = {
  binding: N8nExecutionBinding;
  /** 本次是否新建了映射（false = 之前就有）。 */
  created: boolean;
  /** 是否与已有映射冲突（已按策略保留旧值，没有覆盖）。 */
  conflict: boolean;
};

/**
 * 保存 n8n 在工作流入口上报的确定性映射。
 *
 * **不可覆盖**：一个 executionId 只能对应一个 requestId。重复上报同一对是幂等的；
 * 想用同一个 executionId 绑到另一个 requestId 时：
 *   · `reject`（显式 execution.bound 路径）→ 抛 ExecutionBindingConflict，由接口回 409；
 *   · `keep`（事件里顺带发现的被动路径）→ 保留旧映射，只回报 conflict，绝不改写。
 * 这样"重试/串号"都不会把一条已经正确的绑定污染掉。
 */
export async function recordExecutionBinding(
  input: {
    executionId: string;
    requestId: string;
    workflowId: string;
    workflowName?: string | null;
    sessionId?: string | null;
    createdAt?: number;
  },
  options: { onConflict?: 'reject' | 'keep' } = {},
): Promise<ExecutionBindingOutcome> {
  const existing = await getExecutionBindingByExecutionId(input.executionId);
  if (existing) {
    if (existing.requestId === input.requestId && existing.workflowId === input.workflowId &&
        (!input.sessionId || !existing.sessionId || existing.sessionId === input.sessionId)) {
      // 幂等：同一对重复上报，什么都不用改
      return { binding: existing, created: false, conflict: false };
    }
    if ((options.onConflict ?? 'keep') === 'reject') {
      throw new ExecutionBindingConflict(
        input.executionId,
        existing.requestId,
        input.requestId,
      );
    }
    return { binding: existing, created: false, conflict: true };
  }

  const binding: N8nExecutionBinding = {
    executionId: input.executionId,
    requestId: input.requestId,
    workflowId: input.workflowId,
    workflowName: input.workflowName ?? null,
    sessionId: input.sessionId ?? null,
    createdAt: input.createdAt ?? Date.now(),
  };

  try {
    await getD1()
      .prepare(
        `INSERT INTO n8n_execution_map (
          execution_id, request_id, workflow_id, workflow_name, session_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        binding.executionId,
        binding.requestId,
        binding.workflowId,
        binding.workflowName,
        binding.sessionId,
        binding.createdAt,
      )
      .run();
  } catch (cause) {
    // 并发下另一方先插进去了：读回来按同样的规则处理，不要覆盖
    const winner = await getExecutionBindingByExecutionId(input.executionId);
    if (!winner) throw cause;
    if (winner.requestId === input.requestId && winner.workflowId === input.workflowId &&
        (!input.sessionId || !winner.sessionId || winner.sessionId === input.sessionId)) {
      return { binding: winner, created: false, conflict: false };
    }
    if ((options.onConflict ?? 'keep') === 'reject') {
      throw new ExecutionBindingConflict(
        input.executionId,
        winner.requestId,
        input.requestId,
      );
    }
    return { binding: winner, created: false, conflict: true };
  }

  await getD1()
    .prepare(
      `UPDATE runs SET execution_id = ?
       WHERE request_id = ? AND (execution_id IS NULL OR execution_id = '')`,
    )
    .bind(binding.executionId, binding.requestId)
    .run();

  return { binding, created: true, conflict: false };
}

export async function getExecutionBindingByExecutionId(
  executionId: string,
): Promise<N8nExecutionBinding | null> {
  const row = await getD1()
    .prepare(`SELECT * FROM n8n_execution_map WHERE execution_id = ? LIMIT 1`)
    .bind(executionId)
    .first<N8nExecutionBindingRow>();
  return row ? mapN8nExecutionBinding(row) : null;
}

export async function getLatestExecutionBindingByRequestId(
  requestId: string,
): Promise<N8nExecutionBinding | null> {
  const row = await getD1()
    .prepare(
      `SELECT * FROM n8n_execution_map
       WHERE request_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(requestId)
    .first<N8nExecutionBindingRow>();
  return row ? mapN8nExecutionBinding(row) : null;
}

/**
 * 硬失败时把「运行记录」和「n8n 节点级错误事件」对上号。
 *
 * 背景：n8n 2.x 的 Error Trigger 不再把触发数据（含 requestId）传给 Error Workflow，
 * 所以工作流被节点抛错打死时，那条错误事件是**没有 requestId 的**。
 * 主路径先按 executionId 查 n8n_execution_map。只有旧工作流没有
 * 上报入口映射时，才做有界的时间窗双向补链：
 *   · 事件先到 → 找最近的失败运行，补上 executionId
 *   · 运行先落库 → 找最近的未关联错误事件，补上 requestId
 * 匹配窗口 ±2 分钟且限定同一工作流，宁可不匹配也不乱匹配。
 */
const LINK_WINDOW_MS = 120_000;

export async function linkErrorEventToRun(input: {
  workflow: string | null;
  executionId: string | null;
  at: number;
}): Promise<string | null> {
  if (!input.executionId) return null;

  const exact = await getExecutionBindingByExecutionId(input.executionId);
  if (exact) {
    await getD1()
      .prepare(
        `UPDATE runs SET execution_id = ?
         WHERE request_id = ? AND (execution_id IS NULL OR execution_id = '')`,
      )
      .bind(input.executionId, exact.requestId)
      .run();
    return exact.requestId;
  }

  if (!input.workflow) return null;

  const row = await getD1()
    .prepare(
      `SELECT id, request_id FROM runs
       WHERE workflow_name = ?
         AND status = 'failed'
         AND execution_id IS NULL
         AND started_at BETWEEN ? AND ?
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .bind(input.workflow, input.at - LINK_WINDOW_MS, input.at + 10_000)
    .first<{ id: string; request_id: string | null }>();

  if (!row?.request_id) return null;

  await getD1()
    .prepare(`UPDATE runs SET execution_id = ? WHERE id = ?`)
    .bind(input.executionId, row.id)
    .run();

  return row.request_id;
}

/** 反方向：运行先落库，稍后到达的错误事件来认领它。 */
export async function linkRunToErrorEvent(input: {
  runId: string;
  workflowName: string;
  startedAt: number;
  requestId: string;
}): Promise<string | null> {
  const exact = await getLatestExecutionBindingByRequestId(input.requestId);
  if (exact) {
    await getD1()
      .prepare(`UPDATE runs SET execution_id = ? WHERE id = ?`)
      .bind(exact.executionId, input.runId)
      .run();
    await getD1()
      .prepare(
        `UPDATE n8n_events SET request_id = ?
         WHERE execution_id = ? AND (request_id IS NULL OR request_id = '')`,
      )
      .bind(input.requestId, exact.executionId)
      .run();
    return exact.executionId;
  }

  const row = await getD1()
    .prepare(
      `SELECT id, execution_id FROM n8n_events
       WHERE event_type = 'workflow.error'
         AND workflow = ?
         AND (request_id IS NULL OR request_id = '')
         AND created_at BETWEEN ? AND ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .bind(
      input.workflowName,
      input.startedAt - 10_000,
      input.startedAt + LINK_WINDOW_MS,
    )
    .first<{ id: string; execution_id: string | null }>();

  if (!row) return null;

  await getD1()
    .prepare(`UPDATE n8n_events SET request_id = ? WHERE id = ?`)
    .bind(input.requestId, row.id)
    .run();

  if (row.execution_id) {
    await getD1()
      .prepare(`UPDATE runs SET execution_id = ? WHERE id = ?`)
      .bind(row.execution_id, input.runId)
      .run();
  }

  return row.execution_id;
}

/** 写入一条 n8n 上报事件（common-log 子工作流 / 全局 Error Workflow 用）。 */
export async function recordN8nEvent(input: N8nEventInput): Promise<N8nEvent> {
  const event: N8nEvent = {
    id: crypto.randomUUID(),
    requestId: input.requestId ?? null,
    sessionId: input.sessionId ?? null,
    workflow: input.workflow ?? null,
    executionId: input.executionId ?? null,
    level: input.level ?? 'info',
    eventType: input.eventType ?? 'log',
    node: input.node ?? null,
    message: (input.message ?? '').slice(0, 4000),
    payload: input.payload ?? null,
    durationMs: input.durationMs ?? null,
    createdAt: Date.now(),
  };

  if (event.requestId && event.executionId && input.workflowId) {
    await recordExecutionBinding({
      requestId: event.requestId,
      executionId: event.executionId,
      workflowId: input.workflowId,
      workflowName: event.workflow,
      sessionId: event.sessionId,
      createdAt: event.createdAt,
    });
  }

  await getD1()
    .prepare(
      `INSERT INTO n8n_events (
        id, request_id, session_id, workflow, execution_id, level, event_type,
        node, message, payload_json, duration_ms, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      event.id,
      event.requestId,
      event.sessionId,
      event.workflow,
      event.executionId,
      event.level,
      event.eventType,
      event.node,
      event.message,
      event.payload === null
        ? null
        : JSON.stringify(event.payload).slice(0, 8000),
      event.durationMs,
      event.createdAt,
    )
    .run();

  return event;
}

export async function saveWorkflow(input: {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  action: 'save' | 'publish';
  n8nWebhookUrl?: string | null;
}) {
  const current = await getWorkflowById(input.id);
  if (!current) return null;
  const now = Date.now();
  const publishing = input.action === 'publish';
  const nextVersion = publishing
    ? Math.max(1, (current?.version ?? 0) + 1)
    : (current?.version ?? 0);
  const publishedSteps = publishing
    ? JSON.stringify(input.steps)
    : current?.publishedSteps
      ? JSON.stringify(current.publishedSteps)
      : null;
  const hasUnpublishedChanges = publishing ? 0 : 1;

  await getD1()
    .prepare(
      `INSERT INTO workflows (
        id, name, description, draft_steps_json, published_steps_json, version,
        has_unpublished_changes, created_at, updated_at, published_at,
        n8n_webhook_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        draft_steps_json = excluded.draft_steps_json,
        published_steps_json = excluded.published_steps_json,
        version = excluded.version,
        has_unpublished_changes = excluded.has_unpublished_changes,
        updated_at = excluded.updated_at,
        published_at = excluded.published_at,
        n8n_webhook_url = excluded.n8n_webhook_url`,
    )
    .bind(
      input.id,
      input.name,
      input.description,
      JSON.stringify(input.steps),
      publishedSteps,
      nextVersion,
      hasUnpublishedChanges,
      current?.createdAt ?? now,
      now,
      publishing ? now : (current?.publishedAt ?? null),
      input.n8nWebhookUrl === undefined
        ? (current?.n8nWebhookUrl ?? null)
        : input.n8nWebhookUrl,
    )
    .run();

  return getWorkflowById(input.id);
}

function truncateText(text: string, limit: number) {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** SQLite 唯一约束冲突的错误特征（D1 会把原始信息包在 message 里）。 */
function isUniqueConflict(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(text);
}

/**
 * 幂等收口：request_id 上有唯一索引（见 drizzle/0004_run_idempotency.sql）。
 *
 * 两个并发的同 requestId 请求可能都通过了前置检查，于是都执行了 n8n、都来落库。
 * 这里让后到的那个不报错，而是把**先落库的那条**读回来当作结果 ——
 * 调用方拿到的是同一次运行的记录，库里也不会出现两条重复行。
 */
async function persistRunIdempotent(run: WorkflowRun): Promise<WorkflowRun> {
  try {
    await persistRun(run);
    return run;
  } catch (cause) {
    if (!run.requestId || !isUniqueConflict(cause)) throw cause;
    const winner = await getRunByRequestId(run.requestId);
    if (winner) return winner;
    throw cause;
  }
}

async function persistRun(run: WorkflowRun) {
  await getD1()
    .prepare(
      `INSERT INTO runs (
        id, workflow_id, workflow_name, workflow_version, status,
        steps_json, logs_json, output_json, started_at, finished_at,
        request_id, session_id, engine, error_code, error_message,
        duration_ms, attempts, execution_id, mode, degraded
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      run.id,
      run.workflowId,
      run.workflowName,
      run.workflowVersion,
      run.status,
      JSON.stringify(run.steps),
      JSON.stringify(run.logs),
      JSON.stringify(run.output),
      run.startedAt,
      run.finishedAt,
      run.requestId ?? null,
      run.sessionId ?? null,
      run.engine ?? null,
      run.errorCode ?? null,
      run.errorMessage ?? null,
      run.durationMs ?? null,
      run.attempts ?? null,
      run.executionId ?? null,
      run.mode ?? null,
      run.degraded ?? false,
    )
    .run();
}

export async function createCompletedRun(workflow: WorkflowRecord) {
  if (!workflow.publishedSteps) {
    throw new Error('Workflow has not been published.');
  }

  const startedAt = Date.now();
  const stepSpacing = 840;
  const logs: RunLog[] = [
    {
      at: startedAt,
      level: 'system',
      message: `Agent 已接收 ${workflow.name} · v${workflow.version}`,
    },
    ...workflow.publishedSteps.map((step, index) => ({
      at: startedAt + (index + 1) * stepSpacing,
      level: 'info' as const,
      message: `${String(index + 1).padStart(2, '0')} / ${workflow.publishedSteps?.length}  ${step.title}`,
      stepId: step.id,
    })),
    {
      at: startedAt + (workflow.publishedSteps.length + 1) * stepSpacing,
      level: 'success',
      message: '结果已回传到创建端',
    },
  ];
  const finishedAt = logs.at(-1)?.at ?? startedAt;
  const run: WorkflowRun = {
    id: crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowVersion: workflow.version,
    status: 'completed',
    steps: workflow.publishedSteps,
    logs,
    output: {
      summary: `已按 ${workflow.publishedSteps.length} 个步骤完成「${workflow.name}」`,
      processed: workflow.publishedSteps.length,
      result: '演示任务执行成功',
    },
    startedAt,
    finishedAt,
    engine: 'simulated',
    mode: 'simulated',
    degraded: true,
  };

  return persistRunIdempotent(run);
}

export async function createChatRun(
  workflow: WorkflowRecord,
  message: string,
  analysis: AgentAnalysis,
  options?: {
    reply?: string;
    engine?: RunEngine;
    model?: string;
    /** 并发幂等 claim 预留的运行 id。 */
    runId?: string;
    /** 协议 v1 的链路信息，直接落库，便于按 requestId 反查。 */
    trace?: Partial<
      Pick<
        WorkflowRun,
        | 'requestId'
        | 'sessionId'
        | 'errorCode'
        | 'errorMessage'
        | 'durationMs'
        | 'attempts'
        | 'executionId'
        | 'mode'
        | 'degraded'
      >
    >;
  },
): Promise<WorkflowRun> {
  if (!workflow.publishedSteps) {
    throw new Error('Workflow has not been published.');
  }

  const engine: RunEngine = options?.engine ?? 'simulated';
  const startedAt = Date.now();
  const stepSpacing = 640;
  const steps = workflow.publishedSteps;
  const engineLabel =
    engine === 'n8n'
      ? 'n8n 引擎'
      : engine === 'model'
        ? `模型 ${options?.model ?? '自定义'}`
        : null;
  const logs: RunLog[] = [
    {
      at: startedAt,
      level: 'system',
      message: engineLabel
        ? `对话消息 · ${truncateText(message, 28)}（${engineLabel}）`
        : `对话消息 · ${truncateText(message, 28)}`,
    },
    ...(options?.trace?.requestId
      ? [
          {
            at: startedAt,
            level: 'info' as const,
            message: `requestId ${options.trace.requestId}`,
          },
        ]
      : []),
    ...steps.map((step, index) => ({
      at: startedAt + (index + 1) * stepSpacing,
      level: 'info' as const,
      message: `${String(index + 1).padStart(2, '0')} / ${steps.length}  ${step.title}`,
      stepId: step.id,
    })),
    options?.trace?.errorCode
      ? {
          at: startedAt + (steps.length + 1) * stepSpacing,
          level: 'error' as const,
          message: `[${options.trace.errorCode}] ${options.trace.errorMessage ?? '执行失败'}`,
        }
      : {
          at: startedAt + (steps.length + 1) * stepSpacing,
          level: 'success' as const,
          message:
            engine === 'n8n'
              ? 'n8n 已返回执行结果'
              : engine === 'model'
                ? '模型回复已回传到使用端'
                : '回复已生成并回传到使用端',
        },
  ];
  const finishedAt = logs.at(-1)?.at ?? startedAt;
  const run: WorkflowRun = {
    id: options?.runId ?? crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowVersion: workflow.version,
    status: options?.trace?.errorCode ? 'failed' : 'completed',
    steps,
    logs,
    output: {
      summary: options?.trace?.errorCode
        ? `${engine === 'model' ? '模型' : engine === 'n8n' ? 'n8n' : '模拟'}执行失败 · ${options.trace.errorCode}`
        : `${analysis.intent} · ${analysis.priority}优先级`,
      processed: steps.length,
      result: options?.reply
        ? truncateText(options.reply, 400)
        : `已回复：${analysis.action}`,
    },
    startedAt,
    finishedAt,
    engine,
    mode: engine === 'model' ? 'llm' : 'simulated',
    degraded: engine !== 'model',
    ...options?.trace,
  };

  return persistRunIdempotent(run);
}

export type N8nRunContext = {
  message?: string;
  startedAt?: number;
  sessionId?: string | null;
  /** 幂等 claim 预生成的运行 id；不传则新建。 */
  runId?: string;
};

/**
 * 由真实 n8n 工作流执行一次，并落成一条运行记录。
 *
 * 入参是**归一化之后的 v1 信封**：无论 n8n 内部发生了什么（成功、节点报错、
 * 鉴权失败、超时、网络不通），这里拿到的都是同一种形状 —— 所以这段代码
 * 不需要任何 if (是不是 n8n 的错误) 分支。
 */
export async function createN8nRun(
  workflow: WorkflowRecord,
  envelope: UrtorisResponse,
  context?: N8nRunContext,
): Promise<WorkflowRun> {
  if (!workflow.publishedSteps) {
    throw new Error('Workflow has not been published.');
  }

  const startedAt = context?.startedAt ?? Date.now();
  const steps = workflow.publishedSteps;
  const ok = envelope.success;
  const summaryText = summarizeEnvelope(envelope);
  const settledAt = startedAt + envelope.meta.durationMs;
  let executionId = envelope.meta.executionId ?? null;

  if (!executionId) {
    try {
      executionId =
        (await getLatestExecutionBindingByRequestId(envelope.requestId))
          ?.executionId ?? null;
    } catch {
      // 映射查询失败不影响业务结果落库。
    }
  }

  const logs: RunLog[] = [
    {
      at: startedAt,
      level: 'system',
      message: context?.message
        ? `已触发 n8n 引擎 · ${workflow.name} v${workflow.version} · ${truncateText(context.message, 28)}`
        : `已触发 n8n 引擎 · ${workflow.name} v${workflow.version}`,
    },
    {
      at: startedAt,
      level: 'info',
      message: `requestId ${envelope.requestId}${
        envelope.meta.attempt > 1
          ? `（第 ${envelope.meta.attempt} 次投递）`
          : ''
      }`,
    },
    ...steps.map((step, index) => ({
      at: startedAt + (index + 1) * 420,
      level: 'info' as const,
      message: `${String(index + 1).padStart(2, '0')} / ${steps.length}  ${step.title}`,
      stepId: step.id,
    })),
    ok
      ? {
          at: settledAt,
          level: 'success' as const,
          message: 'n8n 已返回执行结果',
        }
      : { at: settledAt, level: 'error' as const, message: summaryText },
  ];

  const run: WorkflowRun = {
    id: context?.runId ?? crypto.randomUUID(),
    workflowId: workflow.id,
    workflowName: workflow.name,
    workflowVersion: workflow.version,
    status: ok ? 'completed' : 'failed',
    steps,
    logs,
    output: ok
      ? {
          summary: `${
            envelope.mode === 'llm'
              ? '真实模型'
              : envelope.degraded
                ? '规则降级'
                : '规则模式'
          } · ${envelope.meta.durationMs} ms`,
          processed: steps.length,
          result: summaryText,
        }
      : {
          summary: `n8n 执行失败 · ${envelope.error?.code ?? 'UNKNOWN'}`,
          processed: 0,
          result: summaryText,
        },
    startedAt,
    finishedAt: Math.max(settledAt, startedAt),
    engine: 'n8n',
    requestId: envelope.requestId,
    sessionId: context?.sessionId ?? null,
    errorCode: envelope.error?.code ?? null,
    errorMessage: envelope.error?.message ?? null,
    durationMs: envelope.meta.durationMs,
    attempts: envelope.meta.attempt,
    executionId,
    mode: envelope.mode,
    degraded: envelope.degraded,
  };

  // 幂等落库：并发的同 requestId 请求里，只有一条会真正写入
  const stored = await persistRunIdempotent(run);

  // 硬失败（节点抛错 / n8n 500）时信封里没有 executionId，
  // 由 Error Workflow 上报的事件来认领这条运行记录。
  if (!stored.executionId && !ok) {
    try {
      const linked = await linkRunToErrorEvent({
        runId: stored.id,
        workflowName: stored.workflowName,
        startedAt,
        requestId: stored.requestId ?? envelope.requestId,
      });
      if (linked) stored.executionId = linked;
    } catch {
      // 补链失败不影响主流程
    }
  }

  // 入口事件可能比 webhook 响应更早到站点；一旦已从确定性映射取到
  // executionId，也把它补回调用方将要返回的同一个信封对象。
  if (stored.executionId && !envelope.meta.executionId) {
    envelope.meta.executionId = stored.executionId;
  }

  return stored;
}
