import {
  createConsumerSession,
  consumerSessionErrorResponse,
  ConsumerSessionError,
  getOrCreateConsumerSession,
  listConsumerSessionsForOwner,
  listConsumerMessages,
  listConsumerPythonRuns,
  updateConsumerSessionTitle,
  upsertConsumerMessage,
  upsertConsumerPythonRun,
  type ConsumerMessageStatus,
  type ConsumerPythonRun,
} from '@/lib/server/consumer-store';
import { callChatModel, resolveLlmSelection } from '@/lib/server/llm';
import { readPythonRunObservation } from '@/lib/server/python-agent';
import { callPythonExecutor } from '@/lib/server/python-executor-client';
import { getWorkflowById } from '@/lib/server/workflow-store';
import { reconcileChatReplies } from '@/lib/server/consumer-chat';
import {
  enforceExecutionAccess,
  enforceRateLimit,
  readJsonObject,
} from '@/lib/server/security';

const ACTIVE_STATUSES = new Set(['queued', 'running']);

function headers(setCookie: string | null): HeadersInit {
  return {
    'Cache-Control': 'private, no-store',
    ...(setCookie ? { 'Set-Cookie': setCookie } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readOptionalString(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : undefined;
}

function fallbackTitle(message: string): string {
  const clean = message
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[“”"'`《》<>【】{}]/g, '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/\s+/g, ' ')
    .trim();
  const characters = Array.from(clean || '新对话');
  return characters
    .slice(0, 18)
    .join('')
    .replace(/[，。！？、；：,.!?;:]$/, '');
}

function cleanGeneratedTitle(value: string, message: string): string {
  const firstLine = value
    .split(/\r?\n/, 1)[0]
    ?.replace(/^\s*(?:标题|title)\s*[：:]\s*/i, '')
    .replace(/[“”"'`《》<>【】]/g, '')
    .replaceAll('[', '')
    .replaceAll(']', '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!firstLine) return fallbackTitle(message);
  const title = Array.from(firstLine).slice(0, 24).join('');
  return title.length >= 2 ? title : fallbackTitle(message);
}

function recoveredText(run: ConsumerPythonRun): string {
  if (run.status === 'succeeded') {
    const names = run.artifacts.map((artifact) => artifact.name);
    return names.length
      ? `Python 运行已完成。生成文件：${names.join('、')}。`
      : 'Python 运行已完成，本次没有产物文件。';
  }
  if (run.errorCode === 'CANCELLED') return '这次 Python 运行已取消。';
  if (run.errorCode === 'TIMEOUT') {
    return `这次 Python 运行达到 ${run.limits.timeoutSeconds} 秒上限，已终止。`;
  }
  if (run.errorCode === 'WORKER_ERROR') {
    return 'Python 运行因本地节点离线或重启中断，没有伪装成功。';
  }
  return `Python 运行未成功（${run.errorCode ?? run.status}）。`;
}

async function reconcileRuns(
  session: Awaited<ReturnType<typeof getOrCreateConsumerSession>>['session'],
  runs: ConsumerPythonRun[],
) {
  for (const run of runs) {
    if (!ACTIVE_STATUSES.has(run.status)) continue;
    try {
      const response = await callPythonExecutor(
        `/v1/runs/${encodeURIComponent(run.runId)}`,
        {
          method: 'GET',
          headers: { 'X-Urtoris-Task-Id': run.taskId },
          timeoutMs: 5_000,
        },
      );
      if (!response.ok) continue;
      const observation = readPythonRunObservation(await response.json());
      if (!observation || observation.runId !== run.runId) continue;
      await upsertConsumerPythonRun(
        session,
        run.taskId,
        run.agentMessageId,
        observation,
      );
      if (
        run.agentMessageId &&
        observation.status !== 'queued' &&
        observation.status !== 'running'
      ) {
        const refreshed: ConsumerPythonRun = {
          ...run,
          status: observation.status,
          errorCode: observation.error?.code ?? null,
          errorMessage: observation.error?.message ?? null,
          artifacts: observation.artifacts,
          metrics: observation.metrics,
          limits: observation.limits,
        };
        await upsertConsumerMessage(session, {
          id: run.agentMessageId,
          role: 'agent',
          status: observation.status === 'succeeded' ? 'completed' : 'failed',
          text: recoveredText(refreshed),
          metadata: {
            recovered: true,
            python: {
              taskId: run.taskId,
              attempts: observation.attempt,
              succeeded: observation.status === 'succeeded',
              stopReason:
                observation.status === 'succeeded'
                  ? 'succeeded'
                  : 'non_retryable_failure',
              guarded: true,
            },
            artifacts: observation.artifacts.map((artifact) => ({
              ...artifact,
              runId: observation.runId,
            })),
          },
        });
      }
    } catch {
      // 节点休眠/离线时保留已持久化的中间状态；执行器重启后会把
      // 中断任务定稿为 WORKER_ERROR，下次刷新即可如实校准。
    }
  }
}

export async function GET(request: Request) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'consumer-session-read',
    limit: 60,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const workflowId =
    new URL(request.url).searchParams.get('workflowId')?.trim() ?? '';
  const sessionId =
    new URL(request.url).searchParams.get('sessionId')?.trim() || undefined;
  try {
    const workflow = await getWorkflowById(workflowId);
    if (!workflow?.publishedSteps) {
      return Response.json(
        { error: '当前工作流尚未发布。' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const resolved = await getOrCreateConsumerSession(
      request,
      workflowId,
      sessionId,
    );
    let runs = await listConsumerPythonRuns(resolved.session.id);
    await reconcileRuns(resolved.session, runs);
    runs = await listConsumerPythonRuns(resolved.session.id);
    let messages = await listConsumerMessages(resolved.session.id);
    if (await reconcileChatReplies(resolved.session, messages)) {
      messages = await listConsumerMessages(resolved.session.id);
    }
    const conversations = await listConsumerSessionsForOwner(
      resolved.session.id,
    );
    return Response.json(
      {
        session: resolved.session,
        conversations,
        messages,
        pythonRuns: runs,
      },
      { headers: headers(resolved.setCookie) },
    );
  } catch (cause) {
    return consumerSessionErrorResponse(cause);
  }
}

export async function POST(request: Request) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'consumer-session-write',
    limit: 40,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request, 512 * 1024);
  if ('response' in parsed) return parsed.response;
  const workflowId =
    typeof parsed.body.workflowId === 'string'
      ? parsed.body.workflowId.trim()
      : '';
  const sessionId =
    typeof parsed.body.sessionId === 'string'
      ? parsed.body.sessionId.trim()
      : undefined;
  const rawMessages = parsed.body.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length > 4) {
    return Response.json(
      { error: '每次只能保存 1–4 条消息。' },
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
    const resolved = await getOrCreateConsumerSession(
      request,
      workflowId,
      sessionId,
    );
    for (const candidate of rawMessages) {
      if (
        !isRecord(candidate) ||
        (candidate.role !== 'user' && candidate.role !== 'agent') ||
        !isRecord(candidate.metadata ?? {})
      ) {
        throw new ConsumerSessionError('消息结构无效。');
      }
      await upsertConsumerMessage(resolved.session, {
        id: typeof candidate.id === 'string' ? candidate.id : '',
        role: candidate.role,
        status: candidate.status as ConsumerMessageStatus,
        text: typeof candidate.text === 'string' ? candidate.text : '',
        metadata: (candidate.metadata ?? {}) as Record<string, unknown>,
        createdAt:
          typeof candidate.createdAt === 'number'
            ? candidate.createdAt
            : undefined,
      });
    }
    const conversations = await listConsumerSessionsForOwner(
      resolved.session.id,
    );
    return Response.json(
      {
        session: resolved.session,
        conversations,
        saved: rawMessages.length,
      },
      { headers: headers(resolved.setCookie) },
    );
  } catch (cause) {
    return consumerSessionErrorResponse(cause);
  }
}

export async function PUT(request: Request) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'consumer-session-create',
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request, 8 * 1024);
  if ('response' in parsed) return parsed.response;
  const workflowId =
    typeof parsed.body.workflowId === 'string'
      ? parsed.body.workflowId.trim()
      : '';
  try {
    const workflow = await getWorkflowById(workflowId);
    if (!workflow?.publishedSteps) {
      return Response.json(
        { error: '当前工作流尚未发布。' },
        { status: 409, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const resolved = await createConsumerSession(request, workflowId);
    const conversations = await listConsumerSessionsForOwner(
      resolved.session.id,
    );
    return Response.json(
      {
        session: resolved.session,
        conversations,
        messages: [],
        pythonRuns: [],
      },
      { status: 201, headers: headers(resolved.setCookie) },
    );
  } catch (cause) {
    return consumerSessionErrorResponse(cause);
  }
}

export async function PATCH(request: Request) {
  const accessError = enforceExecutionAccess(request, {
    allowConsumerClientMarker: true,
  });
  if (accessError) return accessError;
  const rateLimitError = enforceRateLimit(request, {
    label: 'consumer-session-title',
    limit: 20,
    windowMs: 60_000,
  });
  if (rateLimitError) return rateLimitError;

  const parsed = await readJsonObject(request, 24 * 1024);
  if ('response' in parsed) return parsed.response;
  const workflowId = readOptionalString(parsed.body.workflowId, 80) ?? '';
  const sessionId = readOptionalString(parsed.body.sessionId, 80);
  const userMessage = readOptionalString(parsed.body.userMessage, 2_000);
  const agentReply = readOptionalString(parsed.body.agentReply, 4_000);
  if (!sessionId || !userMessage) {
    return Response.json(
      { error: '缺少会话编号或首条消息。' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
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
    const resolved = await getOrCreateConsumerSession(
      request,
      workflowId,
      sessionId,
    );
    if (resolved.session.title !== '新对话') {
      return Response.json(
        {
          session: resolved.session,
          conversations: await listConsumerSessionsForOwner(
            resolved.session.id,
          ),
        },
        { headers: headers(resolved.setCookie) },
      );
    }

    let title = fallbackTitle(userMessage);
    const selection = resolveLlmSelection({
      provider: readOptionalString(parsed.body.provider, 40),
      baseUrl: readOptionalString(parsed.body.baseUrl, 400),
      model: readOptionalString(parsed.body.model, 120),
    });
    const apiKey = readOptionalString(parsed.body.apiKey, 400) ?? '';
    if (selection.ok && (apiKey || !selection.selection.keyRequired)) {
      const generated = await callChatModel({
        apiKey,
        provider: selection.selection.providerId,
        baseUrl: selection.selection.baseUrl,
        model: selection.selection.model,
        temperature: 0.2,
        timeoutMs: 12_000,
        maxTokens: 40,
        messages: [
          {
            role: 'system',
            content:
              '你负责给 AI 对话命名。只输出一个简短、具体的中文标题，不加引号、序号、句号或“标题”二字；通常 4–14 个汉字，保留必要的产品名。',
          },
          {
            role: 'user',
            content: `用户：${userMessage}\n助手：${agentReply ?? ''}`,
          },
        ],
      });
      if (generated.ok) {
        title = cleanGeneratedTitle(generated.text, userMessage);
      }
    }

    const session = await updateConsumerSessionTitle(resolved.session, title);
    return Response.json(
      {
        session,
        conversations: await listConsumerSessionsForOwner(session.id),
      },
      { headers: headers(resolved.setCookie) },
    );
  } catch (cause) {
    return consumerSessionErrorResponse(cause);
  }
}
