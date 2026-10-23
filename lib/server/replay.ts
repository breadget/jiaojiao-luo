import { getD1 } from '@/db';
import {
  ERROR_CATALOG,
  URTORIS_PROTOCOL,
  type UrtorisErrorCode,
  type UrtorisResponse,
} from '@/lib/server/protocol';
import { getRunByRequestId } from '@/lib/server/workflow-store';
import type { WorkflowRun } from '@/lib/workflow-types';

/**
 * 幂等与重放。
 *
 * 设计约束：重复投递必须**不产生副作用**（不再触发一次 n8n 执行），
 * 而且要返回和第一次**同样形状**的响应，否则调用方得为"重放"写第二套解析逻辑。
 */

/** requestId 白名单字符，避免有人拿它当路径/注入载体。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,80}$/;

export function isSafeRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value.trim());
}

export type ReplayDecision =
  | { kind: 'execute' }
  | { kind: 'replay'; run: WorkflowRun }
  | { kind: 'conflict'; message: string };

export function decideReplay(
  existing: WorkflowRun | null,
  workflowId: string,
  sessionId?: string | null,
): ReplayDecision {
  if (!existing) return { kind: 'execute' };
  if (existing.workflowId !== workflowId) {
    return {
      kind: 'conflict',
      message: `requestId 已被工作流 ${existing.workflowId} 使用，不能复用到 ${workflowId}。请换一个 requestId。`,
    };
  }
  if (sessionId && existing.sessionId && existing.sessionId !== sessionId) {
    return {
      kind: 'conflict',
      message: `requestId 已绑定会话 ${existing.sessionId}，不能复用到会话 ${sessionId}。请换一个 requestId。`,
    };
  }
  return { kind: 'replay', run: existing };
}

/** 落库的 error_code 是自由文本，回填信封前先收敛到协议闭集里。 */
function asErrorCode(value: string | null | undefined): UrtorisErrorCode {
  if (value && Object.hasOwn(ERROR_CATALOG, value)) {
    return value as UrtorisErrorCode;
  }
  return 'INTERNAL_ERROR';
}

/**
 * 从已落库的运行记录重建 v1 信封。
 *
 * 我们只持久化 run（不存整份信封），但重放时必须给出同样的形状，
 * 所以这里按记录里的 success/errorCode/durationMs 还原。
 */
export function envelopeFromRun(run: WorkflowRun): UrtorisResponse {
  const ok = run.status === 'completed';
  const finishedAt = run.finishedAt ?? run.startedAt;
  const engine = run.engine ?? 'n8n';
  // 重放时沿用运行时记录下来的执行模式；没记录就按引擎推断
  // （与 protocol.ts 的 successEnvelope / normalizeResponse 保持同一套推导规则）
  const mode =
    run.mode ??
    (engine === 'model'
      ? 'llm'
      : engine === 'simulated'
        ? 'simulated'
        : 'rules');
  const degraded = run.degraded ?? mode === 'simulated';
  const meta = {
    executionId: run.executionId ?? null,
    sessionId: run.sessionId ?? null,
    durationMs: run.durationMs ?? Math.max(0, finishedAt - run.startedAt),
    attempt: run.attempts ?? 1,
    startedAt: run.startedAt,
    finishedAt,
    httpStatus: ok ? 200 : 502,
  };

  if (ok) {
    return {
      protocol: URTORIS_PROTOCOL,
      success: true,
      requestId: run.requestId ?? run.id,
      engine,
      workflow: run.workflowId,
      data: { message: run.output.result, replayed: true },
      error: null,
      meta,
      mode,
      degraded,
    };
  }

  return {
    protocol: URTORIS_PROTOCOL,
    success: false,
    requestId: run.requestId ?? run.id,
    engine,
    workflow: run.workflowId,
    data: null,
    error: {
      code: asErrorCode(run.errorCode),
      message: run.errorMessage ?? run.output.result ?? '执行失败',
      detail: null,
      node: null,
      retryable: false,
    },
    meta,
    mode,
    degraded,
  };
}

/** 重放时给调用方的一句话说明。 */
export function replayNotice(run: WorkflowRun): string {
  return `该 requestId 已执行过（run ${run.id.slice(0, 8)}），本次为幂等重放，未再次触发执行引擎。`;
}

/** claim 的存活时间：超过它就认为持有者已经崩了，允许别的请求接管。 */
export const CLAIM_TTL_MS = 120_000;

export type ClaimOutcome =
  | { kind: 'claimed'; runId: string }
  | { kind: 'in_progress'; runId: string }
  | { kind: 'acquired_after_stale'; runId: string };

/**
 * 抢执行权。
 *
 * 只有拿到 claim 的请求可以真正触发 n8n；其余请求去等结果。
 * 这是"副作用幂等"的关键 —— 光有 runs.request_id 唯一索引只能防重复记录，
 * 防不住工作流被跑两遍。
 */
export async function claimRunRequest(
  requestId: string,
  now = Date.now(),
): Promise<ClaimOutcome> {
  const d1 = getD1();
  const candidateRunId = crypto.randomUUID();

  const inserted = await d1
    .prepare(
      `INSERT OR IGNORE INTO run_claims (request_id, run_id, claimed_at) VALUES (?, ?, ?)`,
    )
    .bind(requestId, candidateRunId, now)
    .run();

  if ((inserted.meta?.changes ?? 0) > 0) {
    return { kind: 'claimed', runId: candidateRunId };
  }

  const row = await d1
    .prepare(`SELECT run_id, claimed_at FROM run_claims WHERE request_id = ?`)
    .bind(requestId)
    .first<{ run_id: string; claimed_at: number }>();

  // 读回来的行就是自己插的 → 说明 INSERT 其实成功了，
  // 只是 D1 没有回报 changes（不同版本/驱动行为不一致，不能依赖它）
  if (row && row.run_id === candidateRunId) {
    return { kind: 'claimed', runId: candidateRunId };
  }

  if (!row) {
    // 极少数情况：刚好被释放了，重试一次即可视为抢到
    return { kind: 'claimed', runId: candidateRunId };
  }

  if (now - row.claimed_at < CLAIM_TTL_MS) {
    return { kind: 'in_progress', runId: row.run_id };
  }

  // 陈旧 claim：用乐观更新接管（带上旧时间戳，避免和另一个接管者撞车）
  await d1
    .prepare(
      `UPDATE run_claims SET run_id = ?, claimed_at = ?
       WHERE request_id = ? AND claimed_at = ?`,
    )
    .bind(candidateRunId, now, requestId, row.claimed_at)
    .run();

  const after = await d1
    .prepare(`SELECT run_id FROM run_claims WHERE request_id = ?`)
    .bind(requestId)
    .first<{ run_id: string }>();

  if (after?.run_id === candidateRunId) {
    return { kind: 'acquired_after_stale', runId: candidateRunId };
  }
  return { kind: 'in_progress', runId: after?.run_id ?? row.run_id };
}

/**
 * 释放本次请求的瞬时并发锁。
 *
 * 如果 `runs` 已经落库，后续同 requestId 会先被 `decideReplay` 命中并重放，
 * 不会因为这里删了 claim 就再次触发 n8n。只有在传输/持久化中断、根本没有
 * durable run 可重放时，释放 claim 才允许调用方重新取得执行权，而不是等 TTL。
 */
export async function releaseClaim(requestId: string): Promise<void> {
  await getD1()
    .prepare(`DELETE FROM run_claims WHERE request_id = ?`)
    .bind(requestId)
    .run();
}

/**
 * 没抢到 claim 时，等先到的那次执行落库。
 * 等到了就重放（调用方体验等价于幂等），等不到才报 409。
 */
export async function waitForSettledRun(
  requestId: string,
  timeoutMs = 8_000,
): Promise<WorkflowRun | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await getRunByRequestId(requestId);
    if (run) return run;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return getRunByRequestId(requestId);
}
