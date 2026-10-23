import { resolveLlmSelection } from '@/lib/server/llm';
import { isLlmReasoningEffort } from '@/lib/llm/providers';
import { isArtifactGenerationRequest } from '@/lib/artifact-intent';
import { PYTHON_ATTACHMENT_EXTENSIONS } from '@/lib/python-attachments';
import {
  PYTHON_AGENT_MAX_INPUT_FILES,
  PYTHON_FILE_ID_PATTERN,
  PYTHON_MOUNT_NAME_PATTERN,
  summarizeRun,
  type PythonAgentInputFile,
} from '@/lib/server/python-agent';
import {
  isPythonAgentEnabled,
  runPythonAgent,
} from '@/lib/server/python-agent-runtime';
import { loadConversationHistory } from '@/lib/server/conversation-history';
import type { ChatMessage } from '@/lib/server/llm';
import {
  consumerSessionErrorResponse,
  getOrCreateConsumerSession,
  upsertConsumerMessage,
  upsertConsumerPythonRun,
  type ConsumerSession,
} from '@/lib/server/consumer-store';
import {
  PYTHON_TASK_ID_PATTERN,
  requirePythonTaskCapability,
} from '@/lib/server/python-task-capability';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';
import { getWorkflowById } from '@/lib/server/workflow-store';
import { getActiveWorkflowVersion } from '@/lib/server/workflow-version-store';
import { buildWorkflowAgentConstraintsPrompt } from '@/lib/workflow-graph/agent-constraints';
import { hasLocalDatabaseNodes } from '@/lib/workflow-graph/local-database';

/**
 * Agent → `run_python` 的入口。
 *
 * 它是 `docs/python-agent-system-prompt.md` 里的 Orchestrator：校验同源/API token、
 * 校验七天有效的 task capability、注入本次任务上下文、按最多三次尝试运行，
 * 并把每次尝试的结构化结果原样给网页看。
 */

const MESSAGE_LIMIT = 2000;
const INPUT_EXTENSIONS = new Set<string>(PYTHON_ATTACHMENT_EXTENSIONS);

function readOptionalString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function extensionOf(name: string): string {
  const index = name.lastIndexOf('.');
  return index < 0 ? '' : name.slice(index).toLowerCase();
}

function readInputs(
  value: unknown,
): { ok: true; inputs: PythonAgentInputFile[] } | { ok: false; error: string } {
  if (value === undefined) return { ok: true, inputs: [] };
  if (!Array.isArray(value)) return { ok: false, error: 'inputs 必须是数组。' };
  if (value.length > PYTHON_AGENT_MAX_INPUT_FILES) {
    return {
      ok: false,
      error: `inputs 最多 ${PYTHON_AGENT_MAX_INPUT_FILES} 个文件。`,
    };
  }
  const inputs: PythonAgentInputFile[] = [];
  for (const [index, candidate] of value.entries()) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      return { ok: false, error: `inputs[${index}] 必须是对象。` };
    }
    const record = candidate as Record<string, unknown>;
    const fileId = record.fileId;
    const mountName = record.mountName;
    if (
      typeof fileId !== 'string' ||
      !PYTHON_FILE_ID_PATTERN.test(fileId.trim())
    ) {
      return { ok: false, error: `inputs[${index}].fileId 格式无效。` };
    }
    if (
      typeof mountName !== 'string' ||
      !PYTHON_MOUNT_NAME_PATTERN.test(mountName.trim()) ||
      !INPUT_EXTENSIONS.has(extensionOf(mountName.trim()))
    ) {
      return {
        ok: false,
        error: `inputs[${index}].mountName 必须是受支持的办公文档、数据文件或图片的单层安全文件名。`,
      };
    }
    const sizeBytes = record.sizeBytes;
    inputs.push({
      fileId: fileId.trim(),
      mountName: mountName.trim(),
      displayName:
        readOptionalString(record.displayName, 120) ?? mountName.trim(),
      sizeBytes:
        typeof sizeBytes === 'number' &&
        Number.isInteger(sizeBytes) &&
        sizeBytes >= 0
          ? sizeBytes
          : 0,
    });
  }
  return { ok: true, inputs };
}

export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'python-agent',
    limit: 6,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request);
  if ('response' in parsed) return parsed.response;
  const body = parsed.body;

  // 真实 Docker 安全门禁通过前，Agent 拿不到 run_python：默认关闭，只认显式开关。
  if (!isPythonAgentEnabled()) {
    return Response.json(
      {
        error:
          'Python Agent 尚未启用：需要先通过真实容器的九项安全门禁，并显式打开 PYTHON_AGENT_ENABLED。',
        code: 'PYTHON_AGENT_DISABLED',
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const taskId = typeof body.taskId === 'string' ? body.taskId.trim() : '';
  if (!PYTHON_TASK_ID_PATTERN.test(taskId)) {
    return Response.json({ error: '缺少合法的任务编号。' }, { status: 400 });
  }
  const taskError = await requirePythonTaskCapability(request, taskId);
  if (taskError) return taskError;

  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) {
    return Response.json({ error: '任务内容不能为空。' }, { status: 400 });
  }
  if (message.length > MESSAGE_LIMIT) {
    return Response.json(
      { error: `任务内容过长，请控制在 ${MESSAGE_LIMIT} 字以内。` },
      { status: 400 },
    );
  }

  const inputs = readInputs(body.inputs);
  if (!inputs.ok) {
    return Response.json({ error: inputs.error }, { status: 400 });
  }

  const selection = resolveLlmSelection({
    provider: readOptionalString(body.provider, 40),
    baseUrl: readOptionalString(body.baseUrl, 400),
    model: readOptionalString(body.model, 120),
  });
  if (!selection.ok) {
    return Response.json(
      { error: selection.error, errorCode: selection.code },
      { status: 400 },
    );
  }
  const reasoningEffort =
    body.reasoningEffort === undefined
      ? 'auto'
      : isLlmReasoningEffort(body.reasoningEffort)
        ? body.reasoningEffort
        : null;
  if (!reasoningEffort) {
    return Response.json(
      { error: '推理强度只能是 auto、low、medium 或 high。' },
      { status: 400 },
    );
  }

  // 浏览器使用端会带 workflowId + agentMessageId。这条支线把每次
  // Executor 观测都写入 D1；纯 API 调用不带这两个字段时仍按原协议工作。
  const workflowId =
    typeof body.workflowId === 'string' ? body.workflowId.trim() : '';
  const agentMessageId =
    typeof body.agentMessageId === 'string' ? body.agentMessageId.trim() : '';
  const consumerSessionId =
    typeof body.sessionId === 'string' ? body.sessionId.trim() : undefined;
  let consumerSession: ConsumerSession | null = null;
  let setConsumerCookie: string | null = null;
  let history: ChatMessage[] = [];
  let workflowConstraints = '';
  if (workflowId || agentMessageId) {
    if (!workflowId || !agentMessageId) {
      return Response.json(
        { error: 'workflowId 和 agentMessageId 必须同时提供。' },
        { status: 400 },
      );
    }
    try {
      const workflow = await getWorkflowById(workflowId);
      if (!workflow?.publishedSteps) {
        return Response.json(
          { error: '当前工作流尚未发布。' },
          { status: 409, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      const publishedGraph = (await getActiveWorkflowVersion(workflowId))?.graph;
      if (publishedGraph && hasLocalDatabaseNodes(publishedGraph)) {
        return Response.json(
          { error: '本机数据库工作流请使用对话模式，文件生成模式暂不支持连接电脑数据库。', errorCode: 'LOCAL_DATABASE_BROWSER_REQUIRED' },
          { status: 409, headers: { 'Cache-Control': 'no-store' } },
        );
      }
      workflowConstraints = buildWorkflowAgentConstraintsPrompt(publishedGraph);
      const resolved = await getOrCreateConsumerSession(
        request,
        workflowId,
        consumerSessionId,
      );
      consumerSession = resolved.session;
      setConsumerCookie = resolved.setCookie;
      history = await loadConversationHistory(consumerSession.id, {
        excludeMessageId: agentMessageId,
        currentMessageId: readOptionalString(body.userMessageId, 80),
        currentText: message,
      });
      await upsertConsumerMessage(consumerSession, {
        id: agentMessageId,
        role: 'agent',
        status: 'working',
        text: '',
        metadata: { pythonTaskId: taskId },
      });
    } catch (cause) {
      return consumerSessionErrorResponse(cause);
    }
  }

  const result = await runPythonAgent({
    taskId,
    task: message,
    inputs: inputs.inputs,
    artifactsAllowed: body.artifactsAllowed !== false,
    requireArtifact: isArtifactGenerationRequest(message),
    history,
    workflowConstraints,
    llm: {
      apiKey: readOptionalString(body.apiKey, 400) ?? '',
      provider: selection.selection.providerId,
      baseUrl: selection.selection.baseUrl,
      model: selection.selection.model,
      reasoningEffort,
    },
    onRunObservation: consumerSession
      ? (observation) =>
          upsertConsumerPythonRun(
            consumerSession as ConsumerSession,
            taskId,
            agentMessageId,
            observation,
          )
      : undefined,
  });

  const payload = {
    reply: result.reply,
    replySource: result.replySource,
    guardViolations: result.replyViolations,
    taskId,
    attempts: result.attempts,
    usedPython: result.usedPython,
    succeeded: result.succeeded,
    stopReason: result.stopReason,
    rejection: result.rejection,
    llmError: result.llmError,
    lastError: result.lastError,
    runs: result.runs.map((run) => ({
      ...summarizeRun(run),
      artifactIds: run.artifacts.map((artifact) => artifact.artifactId),
    })),
    artifacts: result.artifacts,
    model: result.model,
    provider: selection.selection.providerId,
    providerLabel: selection.selection.providerLabel,
  };

  if (consumerSession) {
    try {
      const artifacts = result.artifacts.map((artifact) => ({
        ...artifact,
        runId:
          result.runs.find((run) =>
            run.artifacts.some(
              (candidate) => candidate.artifactId === artifact.artifactId,
            ),
          )?.runId ?? '',
      }));
      await upsertConsumerMessage(consumerSession, {
        id: agentMessageId,
        role: 'agent',
        status:
          result.usedPython && !result.succeeded
            ? 'failed'
            : result.llmError && !result.reply
              ? 'failed'
              : 'completed',
        text: result.reply,
        metadata: {
          artifacts,
          python: {
            taskId,
            attempts: result.attempts,
            succeeded: result.succeeded,
            stopReason: result.stopReason,
            guarded: result.replySource === 'guard',
          },
        },
      });
    } catch (cause) {
      return consumerSessionErrorResponse(cause);
    }
  }

  const responseHeaders = {
    'Cache-Control': 'no-store',
    ...(setConsumerCookie ? { 'Set-Cookie': setConsumerCookie } : {}),
  };

  // 一次都没跑成功、模型本身也没答上来：这是失败，不能伪装成 200 + 一段话。
  if (result.stopReason === 'llm_error' && result.attempts === 0) {
    return Response.json(
      {
        ...payload,
        error: result.llmError?.message ?? '模型服务调用失败。',
        errorCode: result.llmError?.code ?? 'LLM_ERROR',
      },
      { status: 502, headers: responseHeaders },
    );
  }

  return Response.json(payload, { headers: responseHeaders });
}
