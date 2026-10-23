import { jsonResponse } from '@/lib/server/graph-api';
import {
  callChatModel,
  resolveLlmSelection,
} from '@/lib/server/llm';
import { getWorkflowById } from '@/lib/server/workflow-store';
import {
  buildWorkflowAgentMessages,
  createWorkflowAgentProposal,
  WorkflowAgentProposalError,
  type WorkflowAgentMode,
} from '@/lib/workflow-graph/agent';
import {
  compileGraphToN8n,
  compileStats,
} from '@/lib/workflow-graph/adapter/n8n-v1';
import {
  GRAPH_JSON_LIMIT_BYTES,
  findCredentialMaterial,
  isWorkflowGraphPayload,
} from '@/lib/workflow-graph/payload';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';

const AGENT_REQUEST_LIMIT_BYTES = GRAPH_JSON_LIMIT_BYTES + 16 * 1024;

function optionalString(value: unknown, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= max ? normalized : null;
}

function llmFailureStatus(code: string) {
  if (code === 'LLM_NOT_CONFIGURED') return 400;
  if (code === 'LLM_UNSUPPORTED_PROVIDER') return 400;
  if (code === 'LLM_TIMEOUT') return 504;
  if (code === 'RATE_LIMITED') return 429;
  return 502;
}

/**
 * Creator Agent 只生成提案，不写库、不发布、不导入 n8n。
 * 前端必须先展示变更摘要，再由用户选择应用或放弃。
 *
 * 门禁与 `/api/agent/chat` 的 BYO Key 直连路径同级：同源浏览器请求 + 限流即可，
 * 因为这条路径**不读也不写任何服务端数据**，模型 Key 由调用方自带、随请求即弃。
 * 管理令牌仍然管着真正会落库的动作（保存草稿 / 编译 / 发布 / 回滚）。
 */
export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request);
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'workflow-creator-agent',
    limit: 8,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request, AGENT_REQUEST_LIMIT_BYTES);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;
  const mode: WorkflowAgentMode | null =
    body.mode === 'create' || body.mode === 'edit' ? body.mode : null;
  const prompt = optionalString(body.prompt, 4_000);
  const apiKey = optionalString(body.apiKey, 1_000);
  const provider = optionalString(body.provider, 40);
  const baseUrl = optionalString(body.baseUrl, 500);
  const model = optionalString(body.model, 120);

  if (!mode || !prompt || prompt.length < 5) {
    return jsonResponse(
      { error: '请选择新建/编辑模式，并用至少 5 个字说明需求。' },
      400,
    );
  }
  // 模型服务必须认得出来：认不出就报错，不静默换回默认服务。
  const selection = resolveLlmSelection({ provider, baseUrl, model });
  if (!selection.ok) {
    return jsonResponse({ error: selection.error, code: selection.code }, 400);
  }
  if (!apiKey && selection.selection.keyRequired) {
    return jsonResponse(
      {
        error: `辅助 Agent（改画布用）需要一次性 API Key（${selection.selection.providerLabel}）。`,
        code: 'LLM_NOT_CONFIGURED',
      },
      400,
    );
  }

  let currentGraph: WorkflowGraphV1 | undefined;
  if (mode === 'edit') {
    if (!isWorkflowGraphPayload(body.graph)) {
      return jsonResponse({ error: '编辑模式需要有效的当前 Graph。' }, 400);
    }
    currentGraph = body.graph;
    const credentialPath = findCredentialMaterial(currentGraph);
    if (credentialPath) {
      return jsonResponse(
        {
          error: '当前 Graph 含有疑似凭据，不能发给模型。',
          path: credentialPath,
        },
        400,
      );
    }
    if (!(await getWorkflowById(currentGraph.id))) {
      return jsonResponse({ error: '要编辑的工作流不存在。' }, 404);
    }
  } else if (body.graph !== undefined && body.graph !== null) {
    return jsonResponse({ error: '新建模式不接受现有 Graph。' }, 400);
  }

  let messages;
  try {
    messages = buildWorkflowAgentMessages({
      mode,
      request: prompt,
      currentGraph,
    });
  } catch (cause) {
    const message =
      cause instanceof Error ? cause.message : '无法组装 Agent 请求。';
    return jsonResponse(
      { error: message, code: 'AGENT_REQUEST_REJECTED' },
      400,
    );
  }

  const result = await callChatModel({
    apiKey: apiKey ?? '',
    provider: selection.selection.providerId,
    baseUrl: selection.selection.baseUrl,
    model: selection.selection.model,
    messages,
    temperature: 0.1,
    timeoutMs: 60_000,
  });
  if (!result.ok) {
    return jsonResponse(
      {
        error: result.error,
        code: result.code,
        upstreamStatus: result.status ?? null,
      },
      llmFailureStatus(result.code),
    );
  }

  try {
    const proposal = createWorkflowAgentProposal(result.text, {
      mode,
      currentGraph,
    });
    const compiled = await compileGraphToN8n(proposal.graph, {
      workflowId: proposal.graph.id,
      version: proposal.graph.revision + 1,
    });
    return jsonResponse({
      proposal: {
        ...proposal,
        model: result.model,
        provider: selection.selection.providerId,
        providerLabel: selection.selection.providerLabel,
        compile: {
          ready: compiled.ok,
          adapter: compiled.adapter,
          adapterVersion: compiled.adapterVersion,
          issues: compiled.issues,
          requiredCredentialRefs: compiled.requiredCredentialRefs,
          stats: compileStats(proposal.graph, compiled),
        },
      },
      persisted: false,
      published: false,
      imported: false,
      adapterLocked: true,
    });
  } catch (cause) {
    if (cause instanceof WorkflowAgentProposalError) {
      return jsonResponse(
        {
          error: cause.message,
          code: cause.code,
          details: cause.details,
        },
        422,
      );
    }
    throw cause;
  }
}
