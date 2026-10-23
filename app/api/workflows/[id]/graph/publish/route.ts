import {
  guardAdminRequest,
  jsonResponse,
  routeWorkflowId,
} from '@/lib/server/graph-api';
import { getWorkflowById } from '@/lib/server/workflow-store';
import { GraphRevisionConflict } from '@/lib/server/workflow-graph-store';
import {
  GraphPublishRejected,
  publishWorkflowGraph,
} from '@/lib/server/workflow-version-store';
import { readJsonObject } from '@/lib/server/security';

/**
 * 发布 Graph 草稿：编译 → 固化不可变版本 → 移动发布指针。
 *
 * 状态码语义：
 *  - 409：草稿 revision（或内容哈希）与客户端本地不一致，先重新载入；
 *  - 422：编译被拒（不支持的节点、缺必填配置、结构错误），库里什么都没写。
 *
 * program-v1 和 local-sqlite 的发布版本可由各自执行器直接运行。
 * n8n 产物仍不自动导入；其部署须通过现有 Adapter canary。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = guardAdminRequest(request, {
    label: 'workflow-graph-publish',
    limit: 10,
  });
  if (guard) return guard;

  const parsed = await readJsonObject(request, 64 * 1024);
  if ('response' in parsed) return parsed.response;

  const id = await routeWorkflowId(context);
  const expectedRevision = parsed.body.expectedRevision;
  const expectedGraphHash = parsed.body.expectedGraphHash;
  const webhookPath = parsed.body.webhookPath;
  const executionTarget = parsed.body.executionTarget;
  if (executionTarget !== undefined && executionTarget !== 'program')
    return jsonResponse({ error: '执行目标无效。' }, 400);

  if (
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0 ||
    (expectedGraphHash !== undefined &&
      typeof expectedGraphHash !== 'string') ||
    (webhookPath !== undefined && typeof webhookPath !== 'string')
  ) {
    return jsonResponse({ error: 'expectedRevision 无效。' }, 400);
  }
  if (!(await getWorkflowById(id))) {
    return jsonResponse({ error: '工作流不存在。' }, 404);
  }

  try {
    const result = await publishWorkflowGraph({
      workflowId: id,
      expectedRevision,
      expectedGraphHash,
      webhookPath: typeof webhookPath === 'string' ? webhookPath : undefined,
      publishedBy: 'admin',
      ...(executionTarget === 'program'
        ? { executionTarget: 'program' as const }
        : {}),
    });
    return jsonResponse({
      version: result.version,
      issues: result.issues,
      imported: false,
      adapterLocked: !['local-sqlite', 'program-v1'].includes(
        result.version.adapter,
      ),
      runnable: ['local-sqlite', 'program-v1'].includes(result.version.adapter),
    });
  } catch (cause) {
    if (cause instanceof GraphRevisionConflict) {
      return jsonResponse(
        {
          error: 'Graph 草稿已变化（或本地有未保存修改），请重新载入后再发布。',
          currentRevision: cause.currentRevision,
        },
        409,
      );
    }
    if (cause instanceof GraphPublishRejected) {
      return jsonResponse({ error: cause.message, issues: cause.issues }, 422);
    }
    throw cause;
  }
}
