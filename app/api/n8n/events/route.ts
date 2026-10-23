import { env } from 'cloudflare:workers';

import {
  EXECUTION_BOUND_EVENT,
  resolveInternalNodeId,
} from '@/lib/server/node-telemetry';
import {
  ExecutionBindingConflict,
  getWorkflowById,
  linkErrorEventToRun,
  listN8nEvents,
  recordExecutionBinding,
  recordN8nEvent,
} from '@/lib/server/workflow-store';
import { getActiveWorkflowVersion } from '@/lib/server/workflow-version-store';

/**
 * n8n → 网站 的执行事件回传入口（common-log 子工作流 / 全局 Error Workflow 调用）。
 *
 * 这是"可观测"的另一半：网站只知道自己发了什么、收到什么；
 * 工作流内部每一步发生了什么，靠这个接口按 requestId 汇进来。
 *
 * 鉴权：`Authorization: Bearer <URTORIS_INTERNAL_TOKEN>`。
 * 未配置令牌时直接 503 —— 绝不暴露一个开放写入端点。
 */

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authorized(request: Request): boolean {
  const expected = env.URTORIS_INTERNAL_TOKEN;
  if (!expected) return false;
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return timingSafeEqual(token, expected);
}

function readString(value: unknown, limit: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, limit) : null;
}

function readLevel(
  value: unknown,
  eventType: string | null,
): 'debug' | 'info' | 'warn' | 'error' {
  if (
    value === 'debug' ||
    value === 'info' ||
    value === 'warn' ||
    value === 'error'
  ) {
    return value;
  }
  if (eventType === 'error') return 'error';
  return 'info';
}

/** GET：按 requestId 反查一次请求在工作流内部留下的全部事件。 */
export async function GET(request: Request) {
  if (!authorized(request)) {
    return Response.json(
      { ok: false, error: '访问令牌无效。' },
      { status: 401, headers: corsHeaders },
    );
  }

  const url = new URL(request.url);
  const requestId = url.searchParams.get('requestId') ?? undefined;
  const limit = Number(url.searchParams.get('limit') ?? 40);
  const events = await listN8nEvents({ requestId, limit });
  return Response.json({ ok: true, events }, { headers: corsHeaders });
}

export async function POST(request: Request) {
  if (!env.URTORIS_INTERNAL_TOKEN) {
    return Response.json(
      {
        ok: false,
        error: '服务端尚未配置 URTORIS_INTERNAL_TOKEN，事件写入已关闭。',
      },
      { status: 503, headers: corsHeaders },
    );
  }
  if (!authorized(request)) {
    return Response.json(
      { ok: false, error: '访问令牌无效。' },
      { status: 401, headers: corsHeaders },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { ok: false, error: '请求内容必须是有效 JSON。' },
      { status: 400, headers: corsHeaders },
    );
  }

  // 支持单条、裸数组、以及 { events: [...] } 三种形状
  let rawEvents: unknown[];
  if (Array.isArray(body)) {
    rawEvents = body;
  } else if (
    body &&
    typeof body === 'object' &&
    Array.isArray((body as { events?: unknown }).events)
  ) {
    rawEvents = (body as { events: unknown[] }).events;
  } else {
    rawEvents = [body];
  }

  if (rawEvents.length > 50) {
    return Response.json(
      { ok: false, error: '单次最多上报 50 条事件。' },
      { status: 413, headers: corsHeaders },
    );
  }

  const stored: string[] = [];
  for (const raw of rawEvents) {
    if (!raw || typeof raw !== 'object') continue;
    const record = raw as Record<string, unknown>;
    const eventType = readString(record.eventType ?? record.type, 40) ?? 'log';
    const workflowId = readString(record.workflowId, 120);
    const workflow = readString(record.workflow ?? workflowId, 120);
    const executionId = readString(record.executionId, 80);
    let requestId = readString(record.requestId, 80);

    /**
     * 提前绑定：工作流在**危险节点之前**上报 requestId ↔ executionId。
     *
     * 这里刻意"失败就报错"（fail closed）：n8n 侧的守卫节点靠 2xx/非 2xx 判断
     * 能不能继续往下走，所以任何异常都绝不能悄悄存下来当成功。
     *
     * 状态码契约（生成器与站点两侧都按它实现）：
     *   200 { ok:true, bound:true }  → 放行
     *   400 BINDING_INVALID          → 缺字段，或 requestId 使用保留哨兵值 unknown
     *   401                          → 内部令牌无效
     *   404 BINDING_UNKNOWN_WORKFLOW → workflowId 不是站点已知的工作流
     *   409 BINDING_CONFLICT         → 该 executionId 已绑到别的 requestId（不覆盖）
     *   503                          → 服务端未配置内部令牌
     */
    if (eventType === EXECUTION_BOUND_EVENT) {
      const missing = [
        !requestId ? 'requestId' : null,
        !executionId ? 'executionId' : null,
        !workflowId ? 'workflowId' : null,
      ].filter((value): value is string => value !== null);
      if (missing.length) {
        return Response.json(
          {
            ok: false,
            code: 'BINDING_INVALID',
            error: `execution.bound 缺少必填字段：${missing.join('、')}`,
          },
          { status: 400, headers: corsHeaders },
        );
      }

      // 旧生成器曾把缺失 requestId 静默降成 "unknown"。如果这里接受它，多个
      // 请求会污染到同一条伪 requestId 下；当前生成器已经 fail-fast，所以站点也
      // 反向拒绝这个保留哨兵，防止跨仓库回归。
      if ((requestId as string).toLowerCase() === 'unknown') {
        return Response.json(
          {
            ok: false,
            code: 'BINDING_INVALID',
            error: 'execution.bound 的 requestId 不能使用保留值 unknown。',
          },
          { status: 400, headers: corsHeaders },
        );
      }

      const boundWorkflowId = workflowId as string;
      // workflowId 用的是**站点侧**的工作流 id（协议 body 里的那个），不是 n8n
      // 自己的工作流 id —— 所以这里查得到；查不到说明两侧 id 命名空间对不上，
      // 必须响亮地失败，而不是建立一条永远对不上的映射。
      if (!(await getWorkflowById(boundWorkflowId))) {
        return Response.json(
          {
            ok: false,
            code: 'BINDING_UNKNOWN_WORKFLOW',
            error: `未知工作流 ${boundWorkflowId}，拒绝建立绑定。`,
          },
          { status: 404, headers: corsHeaders },
        );
      }

      // triggerNodeId 是现字段名；`node` 是 n8n 侧更自然的叫法，两个都收。
      const triggerNodeId =
        readString(record.triggerNodeId, 120) ?? readString(record.node, 120);

      let outcome;
      try {
        outcome = await recordExecutionBinding(
          {
            executionId: executionId as string,
            requestId: requestId as string,
            workflowId: boundWorkflowId,
            workflowName: workflow,
            sessionId: readString(record.sessionId, 80),
          },
          { onConflict: 'reject' },
        );
      } catch (cause) {
        if (cause instanceof ExecutionBindingConflict) {
          return Response.json(
            {
              ok: false,
              code: 'BINDING_CONFLICT',
              error: cause.message,
              existingRequestId: cause.existingRequestId,
            },
            { status: 409, headers: corsHeaders },
          );
        }
        throw cause;
      }

      // 节点级映射**只能**来自 workflow_node_bindings；查不到就是 null，
      // 由 telemetry 接口把它归到 unmappedNodes，绝不在这里猜一个 id。
      const version = await getActiveWorkflowVersion(boundWorkflowId);
      const internalNodeId = resolveInternalNodeId(
        version?.bindings ?? [],
        triggerNodeId,
      );

      const event = await recordN8nEvent({
        requestId,
        sessionId: readString(record.sessionId, 80),
        workflowId: boundWorkflowId,
        workflow,
        executionId,
        level: 'info',
        eventType: EXECUTION_BOUND_EVENT,
        node: triggerNodeId,
        message: outcome.created
          ? `execution.bound：requestId ↔ executionId 已建立${internalNodeId ? '' : '（triggerNodeId 未在绑定表中，标记为未映射）'}`
          : 'execution.bound：重复上报，映射已存在（幂等）',
        payload: {
          triggerNodeId,
          internalNodeId,
          bound: true,
          created: outcome.created,
        },
        durationMs: null,
      });
      stored.push(event.id);
      continue;
    }

    // 全局 Error Workflow 拿不到 requestId 时，先用 executionId 查入口映射；
    // 只有旧工作流未上报映射时才会落到「工作流 + ±2 分钟」的兼容逻辑。
    if (!requestId && eventType === 'workflow.error') {
      try {
        requestId = await linkErrorEventToRun({
          workflow,
          executionId,
          at: Date.now(),
        });
      } catch {
        // 补链失败不影响事件本身落库
      }
    }

    const event = await recordN8nEvent({
      requestId,
      sessionId: readString(record.sessionId, 80),
      workflowId,
      workflow,
      executionId,
      level: readLevel(record.level, eventType),
      eventType,
      node: readString(record.node, 120),
      message: readString(record.message, 4000) ?? '',
      payload: record.payload ?? null,
      durationMs:
        typeof record.durationMs === 'number'
          ? Math.round(record.durationMs)
          : null,
    });
    stored.push(event.id);
  }

  return Response.json(
    {
      ok: true,
      stored: stored.length,
      ids: stored,
      // n8n 侧的守卫节点据此判断能否继续：只有明确 true 才允许进危险节点。
      bound: rawEvents.some(
        (raw) =>
          raw !== null &&
          typeof raw === 'object' &&
          (raw as Record<string, unknown>).eventType === EXECUTION_BOUND_EVENT,
      ),
    },
    { headers: corsHeaders },
  );
}
