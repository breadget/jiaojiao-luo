import { getD1 } from '@/db';
import { UNIFIED_ASSISTANT_WORKFLOW_ID } from '@/lib/assistant-identity';
import { canonicalJson, sha256Hex } from '@/lib/workflow-graph/hash';
import { compileGraphToProgram } from '@/lib/workflow-graph/adapter/program';
import { validateProgramInput } from '@/lib/workflow-program/engine';
import type {
  ProgramDescription,
  ProgramJob,
  ProgramPlan,
  ProgramStartRequest,
} from '@/lib/workflow-program/types';
import type { LlmConfig } from '@/lib/workflow-types';
import { ensureUnifiedAssistantWorkflow } from '@/lib/server/assistant-session';
import {
  ConsumerSessionError,
  getConsumerSession,
  getOrCreateConsumerSession,
  type ConsumerSession,
} from '@/lib/server/consumer-store';
import { resolveLlmSelection } from '@/lib/server/llm';
import { redactModelCredentials } from '@/lib/server/unified-assistant';
import { isLlmReasoningEffort } from '@/lib/llm/providers';
import {
  getActiveWorkflowVersion,
  getWorkflowVersion,
  type PublishedVersion,
} from '@/lib/server/workflow-version-store';
import {
  getRunByRequestId,
  getWorkflowById,
  syncProgramRun,
} from '@/lib/server/workflow-store';
import {
  claimRunRequest,
  isSafeRequestId,
  releaseClaim,
} from '@/lib/server/replay';
import {
  cancelProgramJob,
  fetchProgramJob,
  programExecutorConfigured,
  ProgramClientError,
  submitProgramJob,
} from '@/lib/server/workflow-program-client';

export class ProgramRequestError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = 'PROGRAM_REQUEST_INVALID',
  ) {
    super(message);
    this.name = 'ProgramRequestError';
  }
}

export type ProgramJobRow = {
  id: string;
  workflow_id: string;
  version_id: string;
  consumer_session_id: string;
  request_id: string;
  input_hash: string;
  snapshot_json: string;
  created_at: number;
  updated_at: number;
};

export async function getProgramPlan(
  version: PublishedVersion,
): Promise<ProgramPlan> {
  if (version.adapter !== 'program-v1')
    throw new ProgramRequestError(
      '请先在创建端把工作流发布为可运行程序。',
      409,
      'PROGRAM_NOT_PUBLISHED',
    );
  const compiled = await compileGraphToProgram(version.graph, {
    workflowId: version.workflowId,
    version: version.version,
  });
  if (
    !compiled.ok ||
    !compiled.plan ||
    compiled.compiledHash !== version.compiledHash
  )
    throw new ProgramRequestError(
      '程序发布版本无法验证，请重新发布。',
      409,
      'PROGRAM_VERSION_INVALID',
    );
  return compiled.plan;
}

export async function describeProgram(
  workflowId: string,
): Promise<ProgramDescription | null> {
  const workflow = await getWorkflowById(workflowId);
  if (!workflow?.publishedSteps) return null;
  const version = await getActiveWorkflowVersion(workflowId);
  if (!version || version.adapter !== 'program-v1') return null;
  const plan = await getProgramPlan(version);
  return {
    workflowId,
    name: version.graph.name,
    versionId: version.id,
    workflowVersion: version.version,
    inputFields: plan.inputFields,
    nodes: plan.executionNodeIds.map((id) => {
      const node = plan.graph.nodes.find((item) => item.id === id)!;
      return { id, name: node.name, type: node.type };
    }),
    requiresModel: plan.graph.nodes.some(
      (node) => !node.disabled && node.type === 'aiAgent',
    ),
  };
}

export function readProgramLlm(value: unknown): LlmConfig {
  const raw =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const read = (key: string, limit: number) => {
    const item = raw[key];
    if (item === undefined) return undefined;
    if (typeof item !== 'string' || item.length > limit || /\p{Cc}/u.test(item))
      throw new ProgramRequestError('模型设置格式无效。');
    return item.trim();
  };
  const selection = resolveLlmSelection({
    provider: read('provider', 40),
    baseUrl: read('baseUrl', 400),
    model: read('model', 120),
  });
  if (!selection.ok)
    throw new ProgramRequestError(selection.error, 400, selection.code);
  try {
    const endpoint = new URL(selection.selection.baseUrl);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error();
  } catch {
    throw new ProgramRequestError(
      '模型端点必须是 HTTP 地址，密钥请只填在 API Key 中。',
    );
  }
  const effort = raw.reasoningEffort ?? 'auto';
  if (!isLlmReasoningEffort(effort))
    throw new ProgramRequestError('推理强度无效。');
  return {
    provider: selection.selection.providerId,
    baseUrl: selection.selection.baseUrl,
    model: selection.selection.model,
    apiKey: read('apiKey', 400) ?? '',
    reasoningEffort: effort,
  };
}

function parseSnapshot(row: ProgramJobRow): ProgramJob {
  return JSON.parse(row.snapshot_json) as ProgramJob;
}
export async function getProgramJobRow(
  id: string,
): Promise<ProgramJobRow | null> {
  if (!/^program_[a-f0-9]{32}$/.test(id)) return null;
  return getD1()
    .prepare('SELECT * FROM workflow_program_jobs WHERE id = ? LIMIT 1')
    .bind(id)
    .first<ProgramJobRow>();
}

export async function ownedProgramJob(
  request: Request,
  id: string,
): Promise<{ row: ProgramJobRow; session: ConsumerSession }> {
  const row = await getProgramJobRow(id);
  const session = row
    ? await getConsumerSession(
        request,
        UNIFIED_ASSISTANT_WORKFLOW_ID,
        row.consumer_session_id,
      )
    : null;
  if (!row || !session)
    throw new ProgramRequestError(
      '这次程序运行不存在或不属于当前浏览器。',
      404,
      'PROGRAM_NOT_FOUND',
    );
  return { row, session };
}

async function synchronize(
  row: ProgramJobRow,
  incoming: ProgramJob,
  session: ConsumerSession,
): Promise<ProgramJob> {
  if (
    incoming.id !== row.id ||
    incoming.workflowId !== row.workflow_id ||
    incoming.versionId !== row.version_id
  )
    throw new ProgramClientError('后台返回的程序版本不匹配。', 502);
  const progressAt = Math.max(
    incoming.createdAt,
    incoming.startedAt ?? 0,
    incoming.finishedAt ?? 0,
    ...Object.values(incoming.nodes).flatMap((node) => [
      node.startedAt ?? 0,
      node.finishedAt ?? 0,
    ]),
  );
  await getD1()
    .prepare(
      `UPDATE workflow_program_jobs SET snapshot_json = ?, updated_at = ? WHERE id = ? AND updated_at <= ? AND json_extract(snapshot_json, '$.finishedAt') IS NULL AND (? != 'queued' OR json_extract(snapshot_json, '$.status') = 'queued')`,
    )
    .bind(
      JSON.stringify(incoming),
      progressAt,
      row.id,
      progressAt,
      incoming.status,
    )
    .run();
  const latest = await getProgramJobRow(row.id);
  const job = latest ? parseSnapshot(latest) : incoming;
  const workflow = await getWorkflowById(row.workflow_id);
  const version = await getWorkflowVersion(row.version_id);
  if (workflow && version)
    await syncProgramRun(workflow, job, {
      requestId: row.request_id,
      sessionId: session.engineSessionId,
      graph: version.graph,
    });
  return job;
}

export async function readOwnedProgramJob(
  request: Request,
  id: string,
  cancel = false,
): Promise<ProgramJob> {
  const { row, session } = await ownedProgramJob(request, id);
  const cached = parseSnapshot(row);
  if (cached.finishedAt !== null) return cached;
  try {
    return await synchronize(
      row,
      cancel ? await cancelProgramJob(id) : await fetchProgramJob(id),
      session,
    );
  } catch (cause) {
    // A dispatch acknowledgement can be lost. Keep its fixed ID and wait for
    // the background executor; a failed HTTP poll never starts another job.
    if (cause instanceof ProgramClientError && cause.status === 404) {
      if (Date.now() - row.created_at < 35_000) return cached;
      return synchronize(
        row,
        {
          ...cached,
          status: 'failed',
          result: null,
          finishedAt: Date.now(),
          error: {
            code: 'PROGRAM_HANDOFF_LOST',
            message: '后台未接收到这次程序任务，请发起新的运行。',
          },
        },
        session,
      );
    }
    throw cause;
  }
}

export async function listOwnedProgramJobs(
  request: Request,
  workflowId: string,
  sessionId?: string,
): Promise<ProgramJob[]> {
  const session = await getConsumerSession(
    request,
    UNIFIED_ASSISTANT_WORKFLOW_ID,
    sessionId,
  );
  if (!session) return [];
  const rows = await getD1()
    .prepare(
      'SELECT * FROM workflow_program_jobs WHERE consumer_session_id = ? AND workflow_id = ? ORDER BY created_at DESC LIMIT 20',
    )
    .bind(session.id, workflowId)
    .all<ProgramJobRow>();
  return rows.results.map(parseSnapshot);
}

export async function startOwnedProgram(
  request: Request,
  body: Record<string, unknown>,
  options: { claimHeld?: boolean } = {},
): Promise<{
  job: ProgramJob;
  session: ConsumerSession;
  setCookie: string | null;
  replayed: boolean;
}> {
  const workflowId =
    typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
  const requestId =
    typeof body.requestId === 'string' ? body.requestId.trim() : '';
  if (!isSafeRequestId(requestId))
    throw new ProgramRequestError('缺少有效的运行编号，请重新点击运行。');
  for (const field of [
    'graph',
    'plan',
    'compiledJson',
    'apiKey',
    'filePath',
    'sql',
  ]) {
    if (Object.hasOwn(body, field))
      throw new ProgramRequestError('程序图和执行配置只能来自已发布版本。');
  }
  await ensureUnifiedAssistantWorkflow();
  const resolved = await getOrCreateConsumerSession(
    request,
    UNIFIED_ASSISTANT_WORKFLOW_ID,
    typeof body.consumerSessionId === 'string'
      ? body.consumerSessionId
      : undefined,
  );
  const findExisting = () =>
    getD1()
      .prepare(
        'SELECT * FROM workflow_program_jobs WHERE request_id = ? LIMIT 1',
      )
      .bind(requestId)
      .first<ProgramJobRow>();
  const existing = await findExisting();
  if (
    existing &&
    (existing.consumer_session_id !== resolved.session.id ||
      existing.workflow_id !== workflowId)
  ) {
    throw new ProgramRequestError(
      '这次运行编号已被使用，请发起新的运行。',
      409,
    );
  }
  const workflow = await getWorkflowById(workflowId);
  // A retry always belongs to its original immutable release, even after publish/rollback.
  const version = existing
    ? await getWorkflowVersion(existing.version_id)
    : await getActiveWorkflowVersion(workflowId);
  if (!workflow?.publishedSteps || !version)
    throw new ProgramRequestError('当前工作流尚未发布为程序。', 409);
  if (body.versionId !== undefined && body.versionId !== version.id)
    throw new ProgramRequestError(
      '工作流已发布了新版本，请重新读取参数后运行。',
      409,
      'PROGRAM_VERSION_CHANGED',
    );
  const plan = await getProgramPlan(version);
  let input: Record<string, unknown>;
  try {
    input = validateProgramInput(plan.inputFields, body.input ?? {});
  } catch (cause) {
    throw new ProgramRequestError(
      cause instanceof Error ? cause.message : '程序输入无效。',
    );
  }
  const llm = readProgramLlm(body.llm);
  const inputHash = await sha256Hex(
    canonicalJson({
      workflowId,
      versionId: version.id,
      input,
      model: {
        provider: llm.provider,
        baseUrl: llm.baseUrl,
        model: llm.model,
        reasoningEffort: llm.reasoningEffort,
      },
    }),
  );
  const replay = (row: ProgramJobRow) => {
    if (
      row.consumer_session_id !== resolved.session.id ||
      row.workflow_id !== workflowId ||
      row.input_hash !== inputHash
    )
      throw new ProgramRequestError(
        '这次运行编号已被使用，请发起新的运行。',
        409,
      );
    return { job: parseSnapshot(row), ...resolved, replayed: true };
  };
  if (existing) return replay(existing);
  if (!programExecutorConfigured())
    throw new ProgramClientError('后台程序执行器尚未连接，请稍后重试。');
  let release = false;
  if (!options.claimHeld) {
    const claim = await claimRunRequest(requestId);
    if (claim.kind === 'in_progress') {
      const winner = await findExisting();
      if (winner) return replay(winner);
      throw new ProgramRequestError(
        '同一运行请求正在处理，请稍后重试。',
        409,
        'REQUEST_IN_PROGRESS',
      );
    }
    release = true;
  }
  try {
    const winner = await findExisting();
    if (winner) return replay(winner);
    if (await getRunByRequestId(requestId))
      throw new ProgramRequestError(
        '这次运行编号已被使用，请发起新的运行。',
        409,
      );
    const id = `program_${crypto.randomUUID().replaceAll('-', '')}`;
    const now = Date.now();
    const job: ProgramJob = {
      id,
      workflowId,
      workflowVersion: version.version,
      versionId: version.id,
      status: 'queued',
      input: Object.fromEntries(
        Object.entries(input).map(([key, value]) => [
          key,
          typeof value === 'string'
            ? redactModelCredentials(value, llm)
            : value,
        ]),
      ),
      nodes: Object.fromEntries(
        plan.graph.nodes.map((graphNode) => [
          graphNode.id,
          {
            id: graphNode.id,
            name: graphNode.name,
            state: graphNode.disabled ? 'skipped' : 'waiting',
          },
        ]),
      ),
      result: null,
      artifacts: [],
      createdAt: now,
      startedAt: null,
      finishedAt: null,
    };
    const inserted = await getD1()
      .prepare(
        'INSERT OR IGNORE INTO workflow_program_jobs (id, workflow_id, version_id, consumer_session_id, request_id, input_hash, snapshot_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .bind(
        id,
        workflowId,
        version.id,
        resolved.session.id,
        requestId,
        inputHash,
        JSON.stringify(job),
        now,
        now,
      )
      .run();
    if (inserted.meta.changes !== 1) {
      const concurrent = await findExisting();
      if (!concurrent)
        throw new ProgramRequestError('运行请求未能保存，请重试。', 503);
      return replay(concurrent);
    }
    // Record the reservation before contacting the worker, so legacy endpoints
    // see the same request ID and cannot execute it through another adapter.
    await syncProgramRun(workflow, job, {
      requestId,
      sessionId: resolved.session.engineSessionId,
      graph: version.graph,
    });
    const row = (await getProgramJobRow(id))!;
    const start: ProgramStartRequest = {
      id,
      workflowId,
      workflowName: version.graph.name,
      workflowVersion: version.version,
      versionId: version.id,
      plan,
      input,
      llm,
      dispatchExpiresAt: now + 30_000,
    };
    try {
      return {
        job: await synchronize(
          row,
          await submitProgramJob(start),
          resolved.session,
        ),
        ...resolved,
        replayed: false,
      };
    } catch (cause) {
      if (
        cause instanceof ProgramClientError &&
        [400, 404, 408, 409, 429].includes(cause.status)
      ) {
        const failed: ProgramJob = {
          ...job,
          status: 'failed',
          finishedAt: Date.now(),
          error: { code: cause.code, message: cause.message },
        };
        return {
          job: await synchronize(row, failed, resolved.session),
          ...resolved,
          replayed: false,
        };
      }
      // An unknown acknowledgement keeps the reserved ID for polling; no retry
      // can dispatch a second business execution or persist model credentials.
      return { job, ...resolved, replayed: false };
    }
  } finally {
    if (release) await releaseClaim(requestId);
  }
}

export function programErrorResponse(cause: unknown): Response {
  const known =
    cause instanceof ProgramRequestError ||
    cause instanceof ProgramClientError ||
    cause instanceof ConsumerSessionError;
  return Response.json(
    {
      error: known ? cause.message : '程序运行请求暂时无法处理。',
      code:
        cause instanceof ProgramRequestError ||
        cause instanceof ProgramClientError
          ? cause.code
          : 'PROGRAM_REQUEST_FAILED',
    },
    {
      status: known ? cause.status : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
