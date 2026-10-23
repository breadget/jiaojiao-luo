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
 * ⚠️ 这个端点**不会**把产物导入 n8n。Adapter canary 通过前，部署仍然锁在
 * Studio 的 `Adapter locked` 后面，导入只在克隆环境由运维执行。
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
    });
    return jsonResponse({
      version: result.version,
      issues: result.issues,
      imported: false,
      adapterLocked: result.version.adapter !== 'local-sqlite',
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
