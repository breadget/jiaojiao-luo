import { getWorkflowById } from '@/lib/server/workflow-store';
import {
  GraphRevisionConflict,
  getWorkflowGraphDraft,
  saveWorkflowGraphDraft,
} from '@/lib/server/workflow-graph-store';
import {
  enforceRateLimit,
  readJsonObject,
  requireAdmin,
} from '@/lib/server/security';
import {
  GRAPH_JSON_LIMIT_BYTES,
  findCredentialMaterial,
  isWorkflowGraphPayload,
} from '@/lib/workflow-graph/payload';
import { projectLegacyWorkflow } from '@/lib/workflow-graph/project-legacy';
import { validateGraph } from '@/lib/workflow-graph/validate';

async function workflowId(context: { params: Promise<{ id: string }> }) {
  const params = await context.params;
  return params.id.trim();
}

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const rateLimitError = enforceRateLimit(request, {
    label: 'workflow-graph-read',
    limit: 90,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;
  const authError = requireAdmin(request);
  if (authError) return authError;

  const id = await workflowId(context);
  const workflow = await getWorkflowById(id);
  if (!workflow) {
    return Response.json({ error: '工作流不存在。' }, { status: 404 });
  }
  const stored = await getWorkflowGraphDraft(id);
  const graph = stored?.graph ?? projectLegacyWorkflow(workflow);
  return Response.json(
    {
      graph,
      persisted: Boolean(stored),
      hash: stored?.hash ?? null,
      issues: validateGraph(graph),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const rateLimitError = enforceRateLimit(request, {
    label: 'workflow-graph-write',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;
  const authError = requireAdmin(request);
  if (authError) return authError;

  const parsed = await readJsonObject(request, GRAPH_JSON_LIMIT_BYTES);
  if ('response' in parsed) return parsed.response;
  const id = await workflowId(context);
  const graph = parsed.body.graph;
  const expectedRevision = parsed.body.expectedRevision;

  if (
    !isWorkflowGraphPayload(graph) ||
    graph.id !== id ||
    typeof expectedRevision !== 'number' ||
    !Number.isInteger(expectedRevision) ||
    expectedRevision < 0
  ) {
    return Response.json(
      { error: 'Graph 格式或 revision 无效。' },
      { status: 400 },
    );
  }
  if (graph.name.trim().length < 2 || graph.name.trim().length > 80) {
    return Response.json(
      { error: '工作流名称必须为 2–80 个字符。' },
      { status: 400 },
    );
  }
  const credentialPath = findCredentialMaterial(graph);
  if (credentialPath) {
    return Response.json(
      {
        error: 'Graph 只能保存凭据引用，不能保存 Key、密码或鉴权头。',
        path: credentialPath,
      },
      { status: 400 },
    );
  }
  if (!(await getWorkflowById(id))) {
    return Response.json({ error: '工作流不存在。' }, { status: 404 });
  }

  try {
    const saved = await saveWorkflowGraphDraft({
      workflowId: id,
      graph: {
        ...graph,
        name: graph.name.trim(),
        description: graph.description.trim().slice(0, 500),
      },
      expectedRevision,
      updatedBy: 'admin',
    });
    return Response.json({
      ...saved,
      issues: validateGraph(saved.graph),
    });
  } catch (cause) {
    if (cause instanceof GraphRevisionConflict) {
      return Response.json(
        {
          error: 'Graph 已被其他会话修改，请重新载入后再保存。',
          currentRevision: cause.currentRevision,
        },
        { status: 409 },
      );
    }
    throw cause;
  }
}
