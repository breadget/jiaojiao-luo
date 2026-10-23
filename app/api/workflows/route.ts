import {
  createWorkflow,
  saveWorkflow,
} from '@/lib/server/workflow-store';
import { normalizeWebhookUrl } from '@/lib/server/n8n';
import { stepKinds, type WorkflowStep } from '@/lib/workflow-types';
import {
  ADMIN_JSON_BODY_LIMIT_BYTES,
  enforceRateLimit,
  readJsonObject,
  requireAdmin,
} from '@/lib/server/security';

function isWorkflowStep(value: unknown): value is WorkflowStep {
  if (!value || typeof value !== 'object') return false;
  const step = value as Partial<WorkflowStep>;
  return (
    typeof step.id === 'string' &&
    typeof step.title === 'string' &&
    typeof step.detail === 'string' &&
    typeof step.kind === 'string' &&
    stepKinds.includes(step.kind as WorkflowStep['kind'])
  );
}

export async function POST(request: Request) {
  const rateLimitError = enforceRateLimit(request, {
    label: 'workflows-admin',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const authError = requireAdmin(request);
  if (authError) return authError;

  const parsed = await readJsonObject(request, ADMIN_JSON_BODY_LIMIT_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;

  if (body.action === 'create') {
    const workflow = await createWorkflow();
    return Response.json({ workflow });
  }

  const steps = Array.isArray(body.steps) ? body.steps : [];
  const action = body.action === 'publish' ? 'publish' : 'save';

  if (
    typeof body.id !== 'string' ||
    typeof body.name !== 'string' ||
    typeof body.description !== 'string' ||
    body.name.trim().length < 2 ||
    steps.length < 1 ||
    steps.length > 12 ||
    !steps.every(isWorkflowStep)
  ) {
    return Response.json(
      { error: '工作流名称和 1–12 个有效步骤为必填项。' },
      { status: 400 },
    );
  }

  // 三态语义：字段缺失 = 保持不变；空串 = 显式清空；有值 = 必须合法。
  let n8nWebhookUrl: string | null | undefined;
  if (body.n8nWebhookUrl === undefined) {
    n8nWebhookUrl = undefined;
  } else if (
    body.n8nWebhookUrl === null ||
    (typeof body.n8nWebhookUrl === 'string' && !body.n8nWebhookUrl.trim())
  ) {
    n8nWebhookUrl = null;
  } else {
    const normalized =
      typeof body.n8nWebhookUrl === 'string'
        ? normalizeWebhookUrl(body.n8nWebhookUrl)
        : null;
    if (normalized === null) {
      return Response.json(
        {
          error:
            'n8n webhook 只能指向已配置 N8N_BASE_URL 的 /webhook/urtoris/* 地址。',
        },
        { status: 400 },
      );
    }
    n8nWebhookUrl = normalized;
  }

  const workflow = await saveWorkflow({
    id: body.id,
    name: body.name.trim().slice(0, 80),
    description: body.description.trim().slice(0, 240),
    steps: steps.map((step) => ({
      ...step,
      title: step.title.trim().slice(0, 80),
      detail: step.detail.trim().slice(0, 180),
    })),
    action,
    n8nWebhookUrl,
  });

  if (!workflow) {
    return Response.json({ error: '工作流不存在或已删除。' }, { status: 404 });
  }

  return Response.json({ workflow });
}
