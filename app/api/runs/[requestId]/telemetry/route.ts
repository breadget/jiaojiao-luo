import { getD1 } from '@/db';
import { env } from 'cloudflare:workers';
import { guardAdminRequest, jsonResponse } from '@/lib/server/graph-api';
import {
  type NodeBinding,
  executionBindingKind,
  listTelemetryEvents,
  projectNodeTelemetry,
  unmappedExternalNodes,
} from '@/lib/server/node-telemetry';
import { getActiveWorkflowVersion, getWorkflowVersion } from '@/lib/server/workflow-version-store';
import { getRuntimeStream } from '@/lib/server/graph-runtime-events';
import { getRunByRequestId } from '@/lib/server/workflow-store';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

/**
 * 一次运行的节点级真实遥测（游标增量）。
 *
 * 这是 Studio 取节点状态的**唯一**来源：`waiting` 就是"服务端还没有这个节点的事件"，
 * 前端不再自己按主路径播放动画。
 *
 * 游标语义：返回 `nextSeq`，客户端下次带 `?afterSeq=nextSeq` 即可断线重连，
 * 不重复、不丢事件 —— 这就是"SSE 中断后重新拉取"的实现方式。
 *
 * Graph runtime 节点集合来自 execution.bound 固定的发布版本；旧运行使用当前版本。
 * 事件里的 n8n 节点若在绑定表里找不到，
 * 会被列进 `unmappedNodes`，而不是静默留成 waiting。
 */
export async function GET(
  request: Request,
  context: { params: Promise<{ requestId: string }> },
) {
  const guard = guardAdminRequest(request, {
    label: 'run-telemetry',
    limit: 240,
  });
  if (guard) return guard;

  const params = await context.params;
  const requestId = params.requestId.trim();
  if (!requestId) {
    return jsonResponse({ error: '缺少 requestId。' }, 400);
  }

  const url = new URL(request.url);
  const afterSeq = Number(url.searchParams.get('afterSeq') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  if (!Number.isFinite(afterSeq) || afterSeq < 0) {
    return jsonResponse({ error: 'afterSeq 无效。' }, 400);
  }

  const run = await getRunByRequestId(requestId);
  if (!run) {
    return jsonResponse({ error: '没有这个 requestId 的运行记录。' }, 404);
  }

  const stream = run.executionId && (env as unknown as Record<string, unknown>).URTORIS_GRAPH_RUNTIME_CANARY === '1'
    ? await getRuntimeStream(run.executionId) : null;
  const version = stream ? await getWorkflowVersion(stream.version_id) : await getActiveWorkflowVersion(run.workflowId);
  const graph = version ? (version.graph as WorkflowGraphV1) : null;
  const bindings: NodeBinding[] = version?.bindings ?? [];
  const graphNodes = graph?.nodes ?? [];

  const events = await listTelemetryEvents(getD1(), {
    requestId,
    afterSeq,
    limit,
    bindings,
    executionId: stream?.execution_id,
  });

  const telemetry = projectNodeTelemetry({
    nodeIds: graphNodes.map((node) => node.id),
    bindings,
    events,
  });

  const binding = await executionBindingKind(getD1(), requestId);

  const nodes = graphNodes.map((node) => {
    const entry = telemetry.get(node.id);
    return {
      nodeId: node.id,
      name: node.name,
      type: node.type,
      state: entry?.state ?? 'waiting',
      durationMs: entry?.durationMs ?? null,
      startedAt: entry?.startedAt ?? null,
      finishedAt: entry?.finishedAt ?? null,
      conflicts: entry?.conflicts ?? 0,
      lastEventSeq: entry?.lastEventSeq ?? null,
      /**
       * 失败原因原样带出（已在折叠时脱敏 + 截断）：画布与 Inspector 要能回答
       * "为什么红"，而不是只给一个红色的点。
       */
      error: entry?.error ?? null,
    };
  });

  const nextSeq = events.length ? events[events.length - 1].seq : afterSeq;

  return jsonResponse({
    requestId,
    run: {
      id: run.id,
      status: stream ? (stream.terminal_type === 'run.completed' ? 'completed' : stream.terminal_type === 'run.failed' ? 'failed' : 'running') : run.status,
      workflowId: run.workflowId,
      executionId: run.executionId ?? null,
      engine: run.engine ?? null,
      mode: run.mode ?? null,
      degraded: run.degraded ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs ?? null,
    },
    boundVersionId: version?.id ?? null,
    boundVersion: version?.version ?? null,
    bindingCount: bindings.length,
    /** prebound = 危险节点之前就报了 executionId；legacy = 只可能是旧工作流走时间窗 fallback。 */
    binding,
    eventSource: stream ? 'n8n-execution-data-v1' : null,
    eventsComplete: stream ? stream.terminal_type !== null : null,
    nodes,
    events,
    unmappedNodes: unmappedExternalNodes(bindings, events),
    nextSeq,
    hasMore: events.length >= Math.min(Math.max(Math.trunc(limit), 1), 100),
  });
}
