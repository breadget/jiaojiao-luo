import { createHash } from 'node:crypto';
import type { ProgramStartRequest } from '../../lib/workflow-program/types';
import { PROGRAM_SNAPSHOT_MAX_BYTES } from '../../lib/workflow-program/types';
import { isWorkflowGraphPayload } from '../../lib/workflow-graph/payload';

export const JOB_ID = /^program_[a-f0-9]{32}$/;
export const ARTIFACT_ID = /^artifact_[a-f0-9]{32}$/;
export const MAX_REQUEST_BYTES = 512 * 1024;
export const MAX_SNAPSHOT_BYTES = PROGRAM_SNAPSHOT_MAX_BYTES;
export const MAX_ARTIFACT_BYTES = 1024 * 1024;
const SECRET_FIELD =
  /(?:api.?key|model.?key|authorization|password|secret|credential|access.?token|refresh.?token)/i;

export class ProgramServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = 'ProgramServiceError';
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function secretRedactor(secrets: string[]) {
  const values = [
    ...new Set(
      secrets
        .flatMap((secret) =>
          secret
            ? [
                secret,
                secret.trim(),
                encodeURIComponent(secret),
                Buffer.from(secret).toString('base64'),
              ]
            : [],
        )
        .filter(Boolean),
    ),
  ].sort((a, b) => b.length - a.length);
  return (text: string) => {
    let value = text;
    for (const secret of values) value = value.split(secret).join('[REDACTED]');
    return value;
  };
}

/** Only bounded JSON can cross the persistence/public boundary. */
export function sanitizeJson(
  value: unknown,
  redact: (text: string) => string,
  depth = 0,
): unknown {
  if (depth > 16) return '[TRUNCATED]';
  if (typeof value === 'string') return redact(value).slice(0, 128_000);
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value))
    return value
      .slice(0, 1000)
      .map((item) => sanitizeJson(item, redact, depth + 1));
  if (!record(value)) return null;
  const output: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value).slice(0, 1000)) {
    if (
      SECRET_FIELD.test(key) ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      continue;
    output[redact(key).slice(0, 200)] = sanitizeJson(item, redact, depth + 1);
  }
  return output;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]),
  );
}

export function requestFingerprint(request: ProgramStartRequest): string {
  // Model credentials deliberately have no influence on idempotence.
  return createHash('sha256')
    .update(
      JSON.stringify(
        canonical({
          workflowId: request.workflowId,
          workflowVersion: request.workflowVersion,
          versionId: request.versionId,
          graph: request.plan.graph,
          input: request.input,
          provider: request.llm.provider,
          model: request.llm.model,
          baseUrl: request.llm.baseUrl,
          reasoningEffort: request.llm.reasoningEffort,
        }),
      ),
    )
    .digest('hex');
}

export function parseStartRequest(value: unknown): ProgramStartRequest {
  if (
    !record(value) ||
    !JOB_ID.test(String(value.id)) ||
    typeof value.workflowId !== 'string' ||
    !value.workflowId ||
    value.workflowId.length > 128 ||
    typeof value.versionId !== 'string' ||
    !value.versionId ||
    value.versionId.length > 128 ||
    typeof value.workflowName !== 'string' ||
    value.workflowName.length > 300 ||
    !Number.isSafeInteger(value.workflowVersion) ||
    Number(value.workflowVersion) < 1 ||
    !record(value.plan) ||
    value.plan.schemaVersion !== 1 ||
    value.plan.workflowId !== value.workflowId ||
    value.plan.workflowVersion !== value.workflowVersion ||
    !isWorkflowGraphPayload(value.plan.graph) ||
    !Array.isArray(value.plan.inputFields) ||
    !Array.isArray(value.plan.executionNodeIds) ||
    !Array.isArray(value.plan.resourceNodeIds) ||
    !record(value.input) ||
    !record(value.llm)
  ) {
    throw new ProgramServiceError('INVALID_REQUEST', '程序任务内容无效。');
  }
  if (
    value.dispatchExpiresAt !== undefined &&
    (!Number.isSafeInteger(value.dispatchExpiresAt) ||
      Number(value.dispatchExpiresAt) < 1 ||
      Number(value.dispatchExpiresAt) > Date.now() + 30_000)
  )
    throw new ProgramServiceError('INVALID_REQUEST', '程序派发期限无效。');
  for (const field of ['provider', 'apiKey', 'baseUrl', 'model'] as const) {
    if (
      typeof value.llm[field] !== 'string' ||
      String(value.llm[field]).length > (field === 'apiKey' ? 4096 : 2000)
    )
      throw new ProgramServiceError('INVALID_REQUEST', '模型设置无效。');
  }
  if (
    !['auto', 'low', 'medium', 'high'].includes(
      String(value.llm.reasoningEffort),
    )
  )
    throw new ProgramServiceError('INVALID_REQUEST', '模型设置无效。');
  if (
    String(value.llm.apiKey).trim() &&
    String(value.id).includes(String(value.llm.apiKey).trim())
  )
    throw new ProgramServiceError(
      'INVALID_REQUEST',
      '任务编号不能包含模型凭据。',
    );
  if (value.llm.baseUrl) {
    try {
      const url = new URL(value.llm.baseUrl as string);
      if (url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      throw new ProgramServiceError(
        'INVALID_REQUEST',
        '模型地址不能包含凭据或查询参数。',
      );
    }
  }
  // Cloning also ensures the asynchronous worker owns its request.
  return structuredClone(value) as ProgramStartRequest;
}
