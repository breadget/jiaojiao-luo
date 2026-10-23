import {
  getConsumerMessage,
  upsertConsumerMessage,
  type ConsumerSession,
  type ConsumerMessage,
} from '@/lib/server/consumer-store';
import { getRunByRequestId } from '@/lib/server/workflow-store';
import type { WorkflowRun } from '@/lib/workflow-types';

export const CHAT_RECOVERY_TIMEOUT_MS = 120_000;

/** Persist a finished reply before returning it to the browser. */
export async function persistChatRunReply(
  session: ConsumerSession,
  agentMessageId: string,
  run: WorkflowRun,
  details: { intent?: string; priority?: string } = {},
): Promise<void> {
  const message = await getConsumerMessage(session.id, agentMessageId);
  if (!message || message.role !== 'agent') return;
  await upsertConsumerMessage(session, {
    id: message.id,
    role: 'agent',
    status: run.status === 'failed' ? 'failed' : 'completed',
    text: run.output.result,
    metadata: {
      ...message.metadata,
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
    } else if (now - message.createdAt > CHAT_RECOVERY_TIMEOUT_MS) {
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
