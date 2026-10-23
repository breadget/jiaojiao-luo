import { callN8nWorkflow } from '@/lib/server/n8n';
import {
  buildRequest,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  type UrtorisLlmConfig,
} from '@/lib/server/protocol';
import {
  claimRunRequest,
  decideReplay,
  envelopeFromRun,
  isSafeRequestId,
  releaseClaim,
  replayNotice,
  waitForSettledRun,
} from '@/lib/server/replay';
import {
  createCompletedRun,
  createN8nRun,
  getRecentRuns,
  getRunByRequestId,
  getWorkflowById,
} from '@/lib/server/workflow-store';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';

export async function GET(request: Request) {
  const accessError = enforceExecutionAccess(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'runs-read',
    limit: 60,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const params = new URL(request.url).searchParams;

  // 排错入口：拿到 requestId 就能看到这一次请求的完整运行记录
  const requestId = params.get('requestId');
  if (requestId) {
    const run = await getRunByRequestId(requestId);
    return Response.json({ run }, { status: run ? 200 : 404 });
  }

  const workflowId = params.get('workflowId') ?? undefined;
  const runs = await getRecentRuns(workflowId);
  return Response.json({ runs });
}

function readLlmConfig(body: Record<string, unknown>): UrtorisLlmConfig | null {
  const raw = body.llm;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const apiKey = typeof record.apiKey === 'string' ? record.apiKey.trim() : '';
  if (!apiKey) return null;
  return {
    apiKey,
    baseUrl:
      typeof record.baseUrl === 'string' && record.baseUrl.trim()
        ? record.baseUrl.trim()
        : DEFAULT_LLM_BASE_URL,
    model:
      typeof record.model === 'string' && record.model.trim()
        ? record.model.trim()
        : DEFAULT_LLM_MODEL,
  };
}

export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'runs-execution',
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;

  if (typeof body.workflowId !== 'string') {
    return Response.json({ error: '缺少工作流编号。' }, { status: 400 });
  }

  const workflow = await getWorkflowById(body.workflowId);
  if (!workflow?.publishedSteps) {
    return Response.json(
      { error: '请先在创建端发布一个版本。' },
      { status: 409 },
    );
  }

  const message =
    typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : '';

  // 绑定了 n8n webhook 的工作流，交给真实执行引擎；否则用内置模拟执行器。
  if (workflow.n8nWebhookUrl) {
    // 幂等：重复投递同一个 requestId 直接重放已记录的运行，不再触发 n8n。
    const incomingRequestId =
      typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (incomingRequestId && !isSafeRequestId(incomingRequestId)) {
      return Response.json(
        {
          error:
            'requestId 格式非法：只允许 8–80 位的字母、数字、点、下划线、冒号、连字符。',
        },
        { status: 400 },
      );
    }

    const decision = decideReplay(
      incomingRequestId ? await getRunByRequestId(incomingRequestId) : null,
      workflow.id,
    );
    if (decision.kind === 'conflict') {
      return Response.json({ error: decision.message }, { status: 409 });
    }
    if (decision.kind === 'replay') {
      return Response.json({
        run: decision.run,
        envelope: envelopeFromRun(decision.run),
        replayed: true,
        notice: replayNotice(decision.run),
      });
    }

    // 抢执行权：拿不到就说明同一个 requestId 正在跑，绝不再触发一次 n8n。
    let claimedRunId: string | null = null;
    if (incomingRequestId) {
      const claim = await claimRunRequest(incomingRequestId);
      if (claim.kind === 'in_progress') {
        const settled = await waitForSettledRun(incomingRequestId);
        if (settled) {
          return Response.json({
            run: settled,
            envelope: envelopeFromRun(settled),
            replayed: true,
            notice: replayNotice(settled),
          });
        }
        return Response.json(
          {
            error:
              '该 requestId 正在执行中，本次未重复触发。请稍后用同一 requestId 重试以获取结果。',
            code: 'REQUEST_IN_PROGRESS',
            requestId: incomingRequestId,
          },
          { status: 409, headers: { 'Retry-After': '2' } },
        );
      }
      claimedRunId = claim.runId;
    }

    const startedAt = Date.now();
    const envelopeRequest = buildRequest({
      workflowId: workflow.id,
      message,
      requestId: incomingRequestId || null,
      sessionId: typeof body.sessionId === 'string' ? body.sessionId : null,
      userId: typeof body.userId === 'string' ? body.userId : null,
      llm: readLlmConfig(body),
      context:
        body.input &&
        typeof body.input === 'object' &&
        !Array.isArray(body.input)
          ? { input: body.input }
          : undefined,
      source: 'urtoris-api',
      timeoutMs:
        typeof body.timeoutMs === 'number' ? body.timeoutMs : undefined,
      workflowVersion: workflow.version,
      workflowName: workflow.name,
      steps: workflow.publishedSteps.map((step, index) => ({
        index: index + 1,
        id: step.id,
        title: step.title,
        detail: step.detail,
        kind: step.kind,
      })),
    });

    try {
      const result = await callN8nWorkflow({
        webhookUrl: workflow.n8nWebhookUrl,
        request: envelopeRequest,
      });

      const run = await createN8nRun(workflow, result.envelope, {
        message,
        startedAt,
        sessionId: envelopeRequest.sessionId,
        runId: claimedRunId ?? undefined,
      });

      return Response.json({ run, envelope: result.envelope });
    } finally {
      // 执行结束后释放 claim：此后靠 runs.request_id 唯一索引继续去重，
      // claim 表不会随时间无限增长。
      if (incomingRequestId) {
        try {
          await releaseClaim(incomingRequestId);
        } catch {
          // 释放失败只影响一次重试要等 TTL，不影响本次结果
        }
      }
    }
  }

  const run = await createCompletedRun(workflow);
  return Response.json({
    run,
    // 未绑定 n8n 时也返回同形状信封，调用方不需要为两种情况写分支
    envelope: {
      protocol: 'urtoris.v1',
      success: true,
      requestId: run.id,
      engine: 'simulated',
      mode: 'simulated',
      degraded: true,
      workflow: workflow.id,
      data: { message: run.output.result, simulated: true },
      error: null,
      meta: { executionId: null, durationMs: 0, attempt: 1 },
    },
  });
}
