import { env } from 'cloudflare:workers';
import { isLlmReasoningEffort } from '@/lib/llm/providers';

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
  getRunByRequestId,
  getWorkflowById,
} from '@/lib/server/workflow-store';
import { enforceRateLimit, readJsonObject } from '@/lib/server/security';
import { getActiveWorkflowVersion } from '@/lib/server/workflow-version-store';
import { hasAgentConstraints } from '@/lib/workflow-graph/agent-constraints';
import { hasLocalDatabaseNodes } from '@/lib/workflow-graph/local-database';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
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
    reasoningEffort: isLlmReasoningEffort(record.reasoningEffort)
      ? record.reasoningEffort
      : 'auto',
  };
}

export async function POST(request: Request) {
  const token = env.URTORIS_API_TOKEN;
  if (!token) {
    return Response.json(
      { ok: false, error: 'API 访问密钥尚未配置。' },
      { status: 503, headers: corsHeaders },
    );
  }

  if (request.headers.get('Authorization') !== `Bearer ${token}`) {
    return Response.json(
      { ok: false, error: '访问密钥无效。' },
      { status: 401, headers: corsHeaders },
    );
  }

  const rateLimitError = enforceRateLimit(request, {
    label: 'v1-run',
    limit: 30,
    windowMs: 60_000,
  });
  if (rateLimitError) {
    return Response.json(
      { ok: false, error: '请求过于频繁，请稍后重试。' },
      {
        status: 429,
        headers: {
          ...corsHeaders,
          'Retry-After': rateLimitError.headers.get('Retry-After') ?? '60',
        },
      },
    );
  }

  const parsed = await readJsonObject(request);
  if ('response' in parsed) {
    const headers = new Headers(parsed.response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
    return new Response(parsed.response.body, { status: parsed.response.status, headers });
  }
  const body = parsed.body;

  if (typeof body.workflowId !== 'string') {
    return Response.json(
      { ok: false, error: 'workflowId 必须是字符串。' },
      { status: 400, headers: corsHeaders },
    );
  }
  if (
    body.input !== undefined &&
    (!body.input || typeof body.input !== 'object' || Array.isArray(body.input))
  ) {
    return Response.json(
      { ok: false, error: 'input 必须是 JSON 对象。' },
      { status: 400, headers: corsHeaders },
    );
  }

  const workflow = await getWorkflowById(body.workflowId);
  if (!workflow?.publishedSteps) {
    return Response.json(
      { ok: false, error: '找不到已发布的工作流。' },
      { status: 404, headers: corsHeaders },
    );
  }

  const message =
    typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : '';

  const publishedGraph = (await getActiveWorkflowVersion(workflow.id))?.graph;
  if (publishedGraph && hasLocalDatabaseNodes(publishedGraph)) {
    return Response.json(
      { ok: false, error: '本机数据库工作流需要浏览器连接助手，请在对话中运行。', errorCode: 'LOCAL_DATABASE_BROWSER_REQUIRED' },
      { status: 409, headers: corsHeaders },
    );
  }

  // 绑定了 n8n 的工作流走统一协议；调用方拿到的永远是同一个信封。
  if (workflow.n8nWebhookUrl) {
    // 对外 API 是脚本重试最可能打的地方，所以幂等策略与 /api/agent/chat、/api/runs 完全一致：
    // 格式校验 → 重放已完成的 → 抢执行权（抢不到就等，绝不重复触发 n8n）。
    const incomingRequestId =
      typeof body.requestId === 'string' ? body.requestId.trim() : '';
    if (incomingRequestId && !isSafeRequestId(incomingRequestId)) {
      return Response.json(
        {
          ok: false,
          error:
            'requestId 格式非法：只允许 8–80 位的字母、数字、点、下划线、冒号、连字符。',
        },
        { status: 400, headers: corsHeaders },
      );
    }

    const decision = decideReplay(
      incomingRequestId ? await getRunByRequestId(incomingRequestId) : null,
      workflow.id,
    );
    if (decision.kind === 'conflict') {
      return Response.json(
        { ok: false, error: decision.message },
        { status: 409, headers: corsHeaders },
      );
    }
    if (decision.kind === 'replay') {
      return Response.json(
        {
          ok: decision.run.status === 'completed',
          envelope: envelopeFromRun(decision.run),
          run: decision.run,
          replayed: true,
          notice: replayNotice(decision.run),
        },
        { headers: corsHeaders },
      );
    }

    let claimedRunId: string | null = null;
    if (incomingRequestId) {
      const claim = await claimRunRequest(incomingRequestId);
      if (claim.kind === 'in_progress') {
        const settled = await waitForSettledRun(incomingRequestId);
        if (!settled) {
          return Response.json(
            {
              ok: false,
              error:
                '该 requestId 正在执行中，本次未重复触发。请稍后用同一 requestId 重试以获取结果。',
              code: 'REQUEST_IN_PROGRESS',
              requestId: incomingRequestId,
            },
            { status: 409, headers: { ...corsHeaders, 'Retry-After': '2' } },
          );
        }
        return Response.json(
          {
            ok: settled.status === 'completed',
            envelope: envelopeFromRun(settled),
            run: settled,
            replayed: true,
            notice: replayNotice(settled),
          },
          { headers: corsHeaders },
        );
      }
      claimedRunId = claim.runId;
    }

    const startedAt = Date.now();
    const envelopeRequest = buildRequest({
      requestId: incomingRequestId || null,
      workflowId: workflow.id,
      message,
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

      return Response.json(
        { ok: result.envelope.success, envelope: result.envelope, run },
        { headers: corsHeaders },
      );
    } finally {
      if (incomingRequestId) {
        try {
          await releaseClaim(incomingRequestId);
        } catch {
          // 释放失败只影响一次重试要等 TTL
        }
      }
    }
  }

  if (hasAgentConstraints(publishedGraph)) {
    return Response.json(
      {
        ok: false,
        error:
          '当前工作流的 Agent 配置了自然语言行为限制，模拟执行无法应用这些限制。请通过真实模型或已部署的工作流执行。',
        errorCode: 'AGENT_CONSTRAINTS_REQUIRE_MODEL',
      },
      { status: 409, headers: corsHeaders },
    );
  }

  const run = await createCompletedRun(workflow);
  return Response.json(
    {
      ok: true,
      run: {
        id: run.id,
        workflowId: run.workflowId,
        workflowVersion: run.workflowVersion,
        status: run.status,
        logs: run.logs,
        output: run.output,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      },
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
    },
    { headers: corsHeaders },
  );
}
