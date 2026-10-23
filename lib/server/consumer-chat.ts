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
import type { WorkflowRun } from '@/lib/workflow-types';

export const CHAT_RECOVERY_TIMEOUT_MS = 120_000;

/** Save the signed database session's fixed deadline before its model turn. */
export async function persistDatabaseChatProgress(
  session: ConsumerSession,
  agentMessageId: string,
  requestId: string,
  versionId: string,
  expiresAt: number,
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
      databaseChat: { versionId, expiresAt },
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
    text: run.output.result,
    metadata: {
      ...metadata,
      ...details,
      runId: run.id,
      mode:
        run.engine === 'n8n'
          ? 'n8n'
          : run.engine === 'model'
            ? 'model'
            : 'simulated',
      executionMode: run.mode,
      degraded: run.degraded,
      failed: run.status === 'failed',
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
      run.workflowId === session.workflowId &&
      run.sessionId === session.engineSessionId &&
      ['completed', 'failed'].includes(run.status)
    ) {
      await persistChatRunReply(session, message.id, run);
      changed = true;
      continue;
    }
    let recoveryDeadline = message.createdAt + CHAT_RECOVERY_TIMEOUT_MS;
    const progress = message.metadata.databaseChat;
    if (progress && typeof progress === 'object' && !Array.isArray(progress)) {
      const { versionId, expiresAt } = progress as Record<string, unknown>;
      if (
        typeof versionId === 'string' &&
        typeof expiresAt === 'number' &&
        Number.isFinite(expiresAt) &&
        expiresAt > message.createdAt &&
        expiresAt <= message.updatedAt + DATABASE_CHAT_SESSION_LIFETIME_MS
      ) {
        activeVersion ??= await getActiveWorkflowVersion(session.workflowId);
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
