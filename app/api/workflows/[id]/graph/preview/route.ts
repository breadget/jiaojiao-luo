import {
  guardAdminRequest,
  jsonResponse,
  routeWorkflowId,
} from '@/lib/server/graph-api';
import {
  GRAPH_JSON_LIMIT_BYTES,
  findCredentialMaterial,
  isWorkflowGraphPayload,
} from '@/lib/workflow-graph/payload';
import { getWorkflowById } from '@/lib/server/workflow-store';
import { previewWorkflowGraph } from '@/lib/server/workflow-version-store';
import { getWorkflowGraphDraft } from '@/lib/server/workflow-graph-store';
import { readJsonObject } from '@/lib/server/security';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

/**
 * 编译预览：只读，永远不写库、永远不导入 n8n。
 *
 * 预览用的是"即将分配的下一个版本号"，所以预览得到的 `compiledHash`
 * 与真正发布后写进 `workflow_versions.compiled_hash` 的值完全一致 ——
 * 这样"预览通过 → 发布"之间不存在第二个变数。
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guard = guardAdminRequest(request, {
    label: 'workflow-graph-preview',
    limit: 30,
  });
  if (guard) return guard;

  const parsed = await readJsonObject(request, GRAPH_JSON_LIMIT_BYTES);
  if ('response' in parsed) return parsed.response;

  const id = await routeWorkflowId(context);
  if (!(await getWorkflowById(id))) {
    return jsonResponse({ error: '工作流不存在。' }, 404);
  }

  const executionTarget = parsed.body.executionTarget;
  if (executionTarget !== undefined && executionTarget !== 'program')
    return jsonResponse({ error: '执行目标无效。' }, 400);
  const webhookPath = parsed.body.webhookPath;
  if (webhookPath !== undefined && typeof webhookPath !== 'string') {
    return jsonResponse({ error: 'webhookPath 无效。' }, 400);
  }

  let graph: WorkflowGraphV1;
  if (parsed.body.graph === undefined) {
    // 没带图就预览库里已保存的草稿
    const draft = await getWorkflowGraphDraft(id);
    if (!draft) {
      return jsonResponse({ error: '还没有保存过 Graph 草稿。' }, 404);
    }
    graph = draft.graph;
  } else {
    const candidate = parsed.body.graph;
    if (!isWorkflowGraphPayload(candidate) || candidate.id !== id) {
      return jsonResponse({ error: 'Graph 格式无效。' }, 400);
    }
    const credentialPath = findCredentialMaterial(candidate);
    if (credentialPath) {
      return jsonResponse(
        {
          error: 'Graph 只能保存凭据引用，不能保存 Key、密码或鉴权头。',
          path: credentialPath,
        },
        400,
      );
    }
    graph = candidate;
  }

  const preview = await previewWorkflowGraph({
    workflowId: id,
    graph,
    ...(executionTarget === 'program'
      ? { executionTarget: 'program' as const }
      : {}),
    webhookPath: typeof webhookPath === 'string' ? webhookPath : undefined,
  });

  return jsonResponse({
    nextVersion: preview.nextVersion,
    ok: preview.ok,
    adapter: preview.adapter,
    adapterVersion: preview.adapterVersion,
    graphHash: preview.graphHash,
    compiledHash: preview.compiledHash,
    compiledJson: preview.compiledJson,
    bindings: preview.bindings,
    issues: preview.issues,
    requiredCredentialRefs: preview.requiredCredentialRefs,
    stats: preview.stats,
    // 预览不创建运行；原生 program/local-sqlite 发布后由各自执行器运行。
    imported: false,
    adapterLocked: !['local-sqlite', 'program-v1'].includes(preview.adapter),
    runnable: ['local-sqlite', 'program-v1'].includes(preview.adapter),
  });
}
