import {
  getConsumerMessage,
  upsertConsumerMessage,
  type ConsumerSession,
  type ConsumerMessage,
} from '@/lib/server/consumer-store';
import { getRunByRequestId } from '@/lib/server/workflow-store';
import { getActiveWorkflowVersion } from '@/lib/server/workflow-version-store';
import {
  DATABASE_CHAT_SESSION_LIFETIME_MS,
  DatabaseAgentError,
} from '@/lib/server/database-agent';
import { UNIFIED_ASSISTANT_WORKFLOW_ID } from '@/lib/assistant-identity';
import type { WorkflowRun } from '@/lib/workflow-types';
import type { ProgramPlan } from '@/lib/workflow-program/types';

export const CHAT_RECOVERY_TIMEOUT_MS = 120_000;

/** Chat may supply one published text input; every other value keeps its published default. */
export function programInputFromChat(
  plan: ProgramPlan,
  message: string,
): {
  input: Record<string, unknown>;
  missing: string[];
} {
  const input: Record<string, unknown> = Object.fromEntries(
    plan.inputFields
      .filter((field) => field.default !== undefined)
      .map((field) => [field.name, field.default]),
  );
  const textField =
    ['topic', 'query', 'message']
      .map((name) =>
        plan.inputFields.find(
          (field) => field.name === name && field.type === 'text',
        ),
      )
      .find(Boolean) ?? plan.inputFields.find((field) => field.type === 'text');
  if (textField) input[textField.name] = message;
  const missing = plan.inputFields
    .filter(
      (field) =>
        field.required &&
        (input[field.name] === undefined ||
          (typeof input[field.name] === 'string' &&
            !String(input[field.name]).trim())),
    )
    .map((field) => field.label);
  return { input, missing };
}

/** This is a completed chat acknowledgement, never a claim that background work has finished. */
export function programChatReply(run: WorkflowRun): string {
  if (run.status === 'queued' || run.status === 'running')
    return `「${run.workflowName}」已启动，请打开运行详情查看进度、结果和文件。`;
  return run.output.result;
}

/** Save the signed database session's fixed deadline before its model turn. */
export async function persistDatabaseChatProgress(
  session: ConsumerSession,
  agentMessageId: string,
  requestId: string,
  versionId: string,
  expiresAt: number,
  workflowId?: string,
): Promise<void> {
  const message = await getConsumerMessage(session.id, agentMessageId);
  if (
    !message ||
    message.role !== 'agent' ||
    message.metadata.chatRequestId !== requestId ||
    !Number.isFinite(expiresAt) ||
    expiresAt <= Date.now() ||
    expiresAt > Date.now() + DATABASE_CHAT_SESSION_LIFETIME_MS
  )
    return;
  const existingProgress = message.metadata.databaseChat;
  if (
    message.status !== 'working' ||
    (existingProgress &&
      typeof existingProgress === 'object' &&
      ((existingProgress as Record<string, unknown>).versionId !== versionId ||
        (existingProgress as Record<string, unknown>).expiresAt !== expiresAt))
  ) {
    throw new DatabaseAgentError(
      '这条数据库请求已经开始或结束，请继续原查询，或重新发送一条消息。',
      409,
      'LOCAL_DATABASE_SESSION_INVALID',
    );
  }
  await upsertConsumerMessage(session, {
    id: message.id,
    role: 'agent',
    status: 'working',
    text: message.text,
    metadata: {
      ...message.metadata,
      databaseChat: {
        versionId,
        expiresAt,
        ...(workflowId ? { workflowId } : {}),
      },
    },
    createdAt: message.createdAt,
  });
}

/** Persist a finished reply before returning it to the browser. */
export async function persistChatRunReply(
  session: ConsumerSession,
  agentMessageId: string,
  run: WorkflowRun,
  details: { intent?: string; priority?: string } = {},
): Promise<void> {
  const message = await getConsumerMessage(session.id, agentMessageId);
  if (!message || message.role !== 'agent') return;
  const metadata = { ...message.metadata };
  delete metadata.databaseChat;
  await upsertConsumerMessage(session, {
    id: message.id,
    role: 'agent',
    status: run.status === 'failed' ? 'failed' : 'completed',
    text: run.engine === 'program' ? programChatReply(run) : run.output.result,
    metadata: {
      ...metadata,
      ...details,
      runId: run.id,
      mode:
        run.engine === 'program'
          ? 'program'
          : run.engine === 'n8n'
            ? 'n8n'
            : run.engine === 'model'
              ? 'model'
              : run.engine === 'retrieval'
                ? 'retrieval'
                : 'simulated',
      executionMode: run.mode,
      degraded: run.degraded,
      failed: run.status === 'failed',
      ...(run.output.programJobId
        ? { programJobId: run.output.programJobId }
        : {}),
      ...(run.output.knowledge ? { knowledge: run.output.knowledge } : {}),
      ...(run.output.model ? { model: run.output.model } : {}),
    },
    createdAt: message.createdAt,
  });
}

/** Recover a lost HTTP response from its saved run, without calling a model again. */
export async function reconcileChatReplies(
  session: ConsumerSession,
  messages: ConsumerMessage[],
  now = Date.now(),
): Promise<boolean> {
  let changed = false;
  let activeVersion:
    | Awaited<ReturnType<typeof getActiveWorkflowVersion>>
    | undefined;
  for (const message of messages) {
    const requestId = message.metadata.chatRequestId;
    if (
      message.role !== 'agent' ||
      message.status !== 'working' ||
      typeof requestId !== 'string'
    )
      continue;
    const run = await getRunByRequestId(requestId);
    if (
      run &&
      (run.workflowId === session.workflowId ||
        session.workflowId === UNIFIED_ASSISTANT_WORKFLOW_ID) &&
      run.sessionId === session.engineSessionId &&
      (['completed', 'failed'].includes(run.status) ||
        (run.engine === 'program' &&
          ['queued', 'running'].includes(run.status) &&
          typeof run.output.programJobId === 'string'))
    ) {
      await persistChatRunReply(session, message.id, run);
      changed = true;
      continue;
    }
    let recoveryDeadline = message.createdAt + CHAT_RECOVERY_TIMEOUT_MS;
    const progress = message.metadata.databaseChat;
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const { versionId, expiresAt, workflowId } = progress as Record<
        string,
        unknown
      >;
      if (
        typeof versionId === 'string' &&
        typeof expiresAt === 'number' &&
        Number.isFinite(expiresAt) &&
        expiresAt > message.createdAt &&
        expiresAt <= message.updatedAt + DATABASE_CHAT_SESSION_LIFETIME_MS
      ) {
        activeVersion = await getActiveWorkflowVersion(
          session.workflowId === UNIFIED_ASSISTANT_WORKFLOW_ID &&
            typeof workflowId === 'string'
            ? workflowId
            : session.workflowId,
        );
        if (
          activeVersion?.adapter === 'local-sqlite' &&
          activeVersion.id === versionId
        )
          recoveryDeadline = expiresAt;
      }
    }
    if (now > recoveryDeadline) {
      await upsertConsumerMessage(session, {
        id: message.id,
        role: 'agent',
        status: 'failed',
        text: '这次请求未能返回结果，请重新发送。已保存的聊天记录仍在。',
        metadata: { ...message.metadata, failed: true },
        createdAt: message.createdAt,
      });
      changed = true;
    }
  }
  return changed;
}
