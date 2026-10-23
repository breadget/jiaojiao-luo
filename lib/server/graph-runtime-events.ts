import { getD1 } from '@/db';
import { canonicalJson, sha256Hex } from '@/lib/workflow-graph/hash';
import { RUNTIME_SOURCE } from '@/lib/workflow-graph/adapter/runtime-gate';
import { sanitizeMessage, sanitizeTelemetryPayload } from './node-telemetry';
import {
  ExecutionBindingConflict,
  getExecutionBindingByExecutionId,
  getRunByRequestId,
  recordExecutionBinding,
} from './workflow-store';
import {
  getWorkflowVersion,
  listWorkflowVersions,
} from './workflow-version-store';

export type RuntimeStream = {
  execution_id: string;
  request_id: string;
  workflow_id: string;
  version_id: string;
  session_id: string | null;
  last_source_seq: number;
  terminal_type: string | null;
};
const TYPES = new Set([
  'execution.bound',
  'node.started',
  'node.finished',
  'node.error',
  'node.skipped',
  'run.completed',
  'run.failed',
  'workflow.error',
]);

class RuntimeRejection extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
const reject = (status: number, code: string): never => {
  throw new RuntimeRejection(status, code);
};
function required(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    value !== value.trim()
  ) {
    return reject(400, 'RUNTIME_INVALID');
  }
  return value;
}

export async function getRuntimeStream(
  executionId: string,
): Promise<RuntimeStream | null> {
  return getD1()
    .prepare('SELECT * FROM n8n_runtime_streams WHERE execution_id = ?')
    .bind(executionId)
    .first<RuntimeStream>();
}

/** Receipts and event rows share a D1 transaction; no acknowledgment before commit. */
export async function acceptRuntimeEvent(
  raw: Record<string, unknown>,
): Promise<Response> {
  try {
    const requestId = required(raw.requestId, 80);
    const executionId = required(raw.executionId, 80);
    const workflowId = required(raw.workflowId, 120);
    const eventType = required(raw.eventType, 40);
    if (
      raw.source !== RUNTIME_SOURCE ||
      !TYPES.has(eventType) ||
      requestId.toLowerCase() === 'unknown' ||
      !Number.isSafeInteger(raw.sourceSeq) ||
      (raw.sourceSeq as number) < 0
    )
      reject(400, 'RUNTIME_INVALID');
    const sourceSeq = raw.sourceSeq as number;
    const bound = eventType === 'execution.bound';
    if (bound !== (sourceSeq === 0)) reject(400, 'RUNTIME_INVALID');
    const node = raw.node ?? raw.triggerNodeId;
    if (eventType.startsWith('node.') || bound) required(node, 120);
    if (
      !bound &&
      (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at <= 0)
    )
      reject(400, 'RUNTIME_INVALID');
    const sessionId =
      raw.sessionId == null ? null : required(raw.sessionId, 80);
    const run = await getRunByRequestId(requestId);
    if (run && run.workflowId !== workflowId)
      reject(409, 'RUNTIME_WORKFLOW_CONFLICT');
    let stream = await getRuntimeStream(executionId);
    if (!stream && !bound) reject(409, 'RUNTIME_BINDING_REQUIRED');
    if (!stream) {
      const versions = await listWorkflowVersions(workflowId);
      const version = versions.find(
        (entry) => entry.version === raw.graphVersion,
      );
      if (!version) reject(404, 'RUNTIME_VERSION_UNKNOWN');
      const existing = await getExecutionBindingByExecutionId(executionId);
      if (
        existing &&
        (existing.requestId !== requestId ||
          existing.workflowId !== workflowId ||
          existing.sessionId !== sessionId)
      )
        reject(409, 'BINDING_CONFLICT');
      await recordExecutionBinding(
        { executionId, requestId, workflowId, sessionId },
        { onConflict: 'reject' },
      );
      await getD1()
        .prepare(`INSERT INTO n8n_runtime_streams
        (execution_id, request_id, workflow_id, version_id, session_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(execution_id) DO NOTHING`)
        .bind(
          executionId,
          requestId,
          workflowId,
          version!.id,
          sessionId,
          Date.now(),
        )
        .run();
      stream = await getRuntimeStream(executionId);
    }
    if (
      !stream ||
      stream.request_id !== requestId ||
      stream.workflow_id !== workflowId ||
      stream.session_id !== sessionId
    ) {
      reject(409, 'BINDING_CONFLICT');
    }
    const version = await getWorkflowVersion(stream!.version_id);
    if (raw.graphVersion !== version?.version)
      reject(409, 'RUNTIME_VERSION_CONFLICT');
    // Hash normalized, redacted content; delivery time must not affect duplicate binding.
    const message = sanitizeMessage(
      typeof raw.message === 'string' ? raw.message : '',
    );
    const payload = sanitizeTelemetryPayload(raw.payload ?? null).payload;
    const duration =
      typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)
        ? Math.max(0, Math.round(raw.durationMs))
        : null;
    const content = {
      requestId,
      executionId,
      workflowId,
      eventType,
      sourceSeq,
      sessionId,
      node: typeof node === 'string' ? node : null,
      message,
      payload,
      duration,
      at: bound ? null : raw.at,
    };
    const hash = await sha256Hex(canonicalJson(content));
    const eventId =
      'runtime_' + (await sha256Hex(`${executionId}|${sourceSeq}`));
    const receipt = await getD1()
      .prepare(
        'SELECT event_hash FROM n8n_runtime_receipts WHERE execution_id = ? AND source_seq = ?',
      )
      .bind(executionId, sourceSeq)
      .first<{ event_hash: string }>();
    if (receipt) {
      if (receipt.event_hash !== hash) reject(409, 'RUNTIME_REPLAY_CONFLICT');
      return Response.json({ ok: true, bound, duplicate: true, sourceSeq });
    }
    if (stream!.last_source_seq !== sourceSeq - 1)
      reject(409, 'RUNTIME_SEQUENCE_GAP');
    if (stream!.terminal_type) reject(409, 'RUNTIME_ALREADY_TERMINAL');
    const terminal =
      eventType === 'run.completed' || eventType === 'run.failed'
        ? eventType
        : null;
    const db = getD1();
    await db.batch([
      db
        .prepare(`INSERT INTO n8n_runtime_receipts (execution_id, source_seq, event_id, event_hash)
        SELECT execution_id, ?, ?, ? FROM n8n_runtime_streams
        WHERE execution_id = ? AND last_source_seq = ? AND terminal_type IS NULL
        ON CONFLICT(execution_id, source_seq) DO NOTHING`)
        .bind(sourceSeq, eventId, hash, executionId, sourceSeq - 1),
      db
        .prepare(`INSERT INTO n8n_events (id, request_id, session_id, workflow, execution_id,
        level, event_type, node, message, payload_json, duration_ms, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM n8n_runtime_receipts
        WHERE execution_id = ? AND source_seq = ? AND event_hash = ? ON CONFLICT(id) DO NOTHING`)
        .bind(
          eventId,
          requestId,
          sessionId,
          workflowId,
          executionId,
          /error|failed/.test(eventType) ? 'error' : 'info',
          eventType,
          content.node,
          message,
          JSON.stringify(payload),
          duration,
          bound ? Date.now() : raw.at,
          executionId,
          sourceSeq,
          hash,
        ),
      db
        .prepare(`UPDATE n8n_runtime_streams SET last_source_seq = ?, terminal_type = ?
        WHERE execution_id = ? AND last_source_seq = ? AND EXISTS
        (SELECT 1 FROM n8n_runtime_receipts WHERE execution_id = ? AND source_seq = ? AND event_hash = ?)`)
        .bind(
          sourceSeq,
          terminal,
          executionId,
          sourceSeq - 1,
          executionId,
          sourceSeq,
          hash,
        ),
    ]);
    const committed = await db
      .prepare(
        'SELECT event_hash FROM n8n_runtime_receipts WHERE execution_id = ? AND source_seq = ?',
      )
      .bind(executionId, sourceSeq)
      .first<{ event_hash: string }>();
    if (committed?.event_hash !== hash) reject(409, 'RUNTIME_REPLAY_CONFLICT');
    return Response.json({ ok: true, bound, sourceSeq });
  } catch (cause) {
    if (cause instanceof ExecutionBindingConflict)
      return Response.json(
        { ok: false, code: 'BINDING_CONFLICT' },
        { status: 409 },
      );
    if (cause instanceof RuntimeRejection)
      return Response.json(
        { ok: false, code: cause.code },
        { status: cause.status },
      );
    // Do not disclose SQL, raw errors or secrets. A missing migration/storage failure is closed.
    return Response.json(
      { ok: false, code: 'RUNTIME_UNAVAILABLE' },
      { status: 503 },
    );
  }
}
