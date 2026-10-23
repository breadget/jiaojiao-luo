import { getD1 } from '@/db';
import { UNIFIED_ASSISTANT_WORKFLOW_ID } from '@/lib/assistant-identity';
import type { WorkflowRecord } from '@/lib/workflow-types';

/**
 * Internal FK anchor for conversations without a selected workflow. The hidden
 * row has no executable steps and never appears in public/studio workflow lists.
 */
export async function ensureUnifiedAssistantWorkflow(): Promise<WorkflowRecord> {
  const now = Date.now();
  await getD1()
    .prepare(
      `INSERT OR IGNORE INTO workflows (
        id, name, description, draft_steps_json, published_steps_json, version,
        has_unpublished_changes, created_at, updated_at, published_at, deleted_at
      ) VALUES (?, ?, ?, '[]', '[]', 0, 0, ?, ?, ?, 1)`,
    )
    .bind(
      UNIFIED_ASSISTANT_WORKFLOW_ID,
      'AI 智能体对话',
      '课程知识与通用对话；可选择已发布工作流作为工具。',
      now,
      now,
      now,
    )
    .run();
  return {
    id: UNIFIED_ASSISTANT_WORKFLOW_ID,
    name: 'AI 智能体对话',
    description: '课程知识与通用对话；尚未选择工作流工具。',
    draftSteps: [],
    publishedSteps: [],
    version: 0,
    hasUnpublishedChanges: false,
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
    n8nWebhookUrl: null,
  };
}
