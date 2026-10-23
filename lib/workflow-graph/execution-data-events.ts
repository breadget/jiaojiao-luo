import { RUNTIME_SOURCE } from './adapter/runtime-gate';

type Item = { json?: Record<string, unknown> };
export type TaskData = {
  startTime: number;
  executionTime: number;
  executionStatus?: string;
  error?: unknown;
  data?: Record<string, Array<Item[] | null>>;
};
export type ExecutionSnapshot = {
  id: string;
  workflowId: string;
  status: string;
  stoppedAt: number | null;
  data: {
    resultData?: {
      runData?: Record<string, TaskData[]>;
      error?: unknown;
      lastNodeExecuted?: string;
    };
  };
  workflowData: {
    nodes: Array<{ id: string; name: string; type: string }>;
    connections: Record<string, Record<string, Array<Array<{ node: string }>>>>;
  };
};
export type RuntimeManifest = {
  externalWorkflowId: string;
  workflowId: string;
  graphVersion: number;
  inputName: string;
  triggerName: string;
  guardName: string;
  bindName: string;
  auxiliaryNames: string[];
  triggerId?: string;
  noModelRoutes?: Array<{ agentName: string; resourceNames: string[] }>;
};
export type RuntimeEvent = {
  source: typeof RUNTIME_SOURCE;
  sourceSeq: number;
  requestId: string;
  executionId: string;
  workflowId: string;
  graphVersion: number;
  sessionId: string | null;
  eventType: string;
  node?: string;
  triggerNodeId?: string;
  at?: number;
  durationMs?: number;
  payload?: Record<string, unknown>;
};

/** Raw errors are used for classification only, never transmitted. */
export function classifyExecutionError(error: unknown) {
  const text = JSON.stringify(error) ?? '';
  const network =
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|network|connection error|fetch failed/i.test(
      text,
    );
  const binding = /BINDING_FAILED/.test(text);
  const code = binding
    ? 'BINDING_FAILED'
    : network
      ? 'NETWORK_ERROR'
      : 'LLM_ERROR';
  return {
    code,
    message: binding
      ? 'Execution binding was rejected.'
      : network
        ? 'Model or upstream network request failed.'
        : 'n8n execution failed.',
    detail:
      'Raw upstream content and credentials withheld; inspect the isolated execution locally.',
  };
}

function firstJson(
  tasks: TaskData[] | undefined,
): Record<string, unknown> | undefined {
  return tasks?.[0]?.data?.main?.[0]?.[0]?.json;
}

/** Only finalized, saved engine data is evidence. Empty/running snapshots produce no events. */
export function executionDataEvents(
  snapshot: ExecutionSnapshot,
  manifest: RuntimeManifest,
): RuntimeEvent[] {
  if (snapshot.workflowId !== manifest.externalWorkflowId)
    throw new Error('WORKFLOW_SNAPSHOT_MISMATCH');
  if (
    manifest.triggerId &&
    !snapshot.workflowData.nodes.some(
      (node) =>
        node.name === manifest.triggerName && node.id === manifest.triggerId,
    )
  )
    return [];
  if (
    !['success', 'error', 'crashed', 'canceled'].includes(snapshot.status) ||
    !snapshot.stoppedAt
  )
    return [];
  const result = snapshot.data.resultData;
  const runs = result?.runData ?? {};
  if (!Object.keys(runs).length) return [];
  const input = firstJson(runs[manifest.inputName]);
  if (
    !input ||
    typeof input.requestId !== 'string' ||
    typeof input.sessionId !== 'string' ||
    !input.requestId.trim() ||
    !input.sessionId.trim() ||
    input.workflowId !== manifest.workflowId ||
    String(input.__urtorisExecutionId) !== snapshot.id
  )
    return [];
  // A failed prebind has no authorized stream. Never establish a binding after execution.
  const bind = firstJson(runs[manifest.bindName]);
  const response = bind?.body as Record<string, unknown> | undefined;
  if (
    bind?.statusCode !== 200 ||
    response?.ok !== true ||
    response?.bound !== true
  )
    return [];
  const identity = {
    source: RUNTIME_SOURCE as typeof RUNTIME_SOURCE,
    requestId: input.requestId,
    sessionId: input.sessionId,
    executionId: snapshot.id,
    workflowId: manifest.workflowId,
    graphVersion: manifest.graphVersion,
  };
  const events: RuntimeEvent[] = [
    {
      ...identity,
      sourceSeq: 0,
      eventType: 'execution.bound',
      triggerNodeId: manifest.triggerName,
    },
  ];
  const pending: Omit<RuntimeEvent, 'sourceSeq'>[] = [];
  const auxiliary = new Set(manifest.auxiliaryNames);
  let error: unknown = result?.error;
  let errorNode: string | undefined = result?.lastNodeExecuted;
  for (const [name, tasks] of Object.entries(runs)) {
    for (const task of tasks) {
      if (
        !Number.isFinite(task.startTime) ||
        !Number.isFinite(task.executionTime)
      )
        throw new Error('INVALID_TASK_TIMING');
      if (task.error) {
        error ??= task.error;
        errorNode ??= name;
      }
    }
    if (auxiliary.has(name) || !tasks.length) continue;
    const failed = tasks.find(
      (task) =>
        task.error ||
        (task.executionStatus && task.executionStatus !== 'success'),
    );
    if (failed) {
      error ??= failed.error ?? { message: 'Non-success task status' };
      errorNode ??= name;
    }
    const startedAt = Math.min(...tasks.map((task) => task.startTime));
    const finishedAt = Math.max(
      ...tasks.map((task) => task.startTime + task.executionTime),
    );
    pending.push({
      ...identity,
      eventType: 'node.started',
      node: name,
      at: startedAt,
      payload: { runCount: tasks.length },
    });
    pending.push({
      ...identity,
      eventType: failed ? 'node.error' : 'node.finished',
      node: name,
      at: finishedAt,
      durationMs: finishedAt - startedAt,
      payload: failed
        ? { ...classifyExecutionError(failed.error), runCount: tasks.length }
        : { runCount: tasks.length },
    });
  }
  pending.sort(
    (a, b) =>
      a.at! - b.at! ||
      (a.eventType === 'node.started' ? 0 : 1) -
        (b.eventType === 'node.started' ? 0 : 1) ||
      (a.node! < b.node! ? -1 : a.node! > b.node! ? 1 : 0),
  );
  events.push(...pending.map((event, i) => ({ ...event, sourceSeq: i + 1 })));
  // Only actual empty Condition outputs prove a branch was not selected. Stop at any executed join.
  const skipped = new Set<string>();
  const noModelSkipped = new Set<string>();
  for (const route of manifest.noModelRoutes ?? []) {
    if (firstJson(runs[route.agentName])?.reason === 'LLM_NOT_CONFIGURED') {
      for (const name of route.resourceNames)
        if (!runs[name]?.length) {
          skipped.add(name);
          noModelSkipped.add(name);
        }
    }
  }
  function markBranch(name: string) {
    if (runs[name]?.length || skipped.has(name)) return;
    skipped.add(name);
    for (const outputs of Object.values(
      snapshot.workflowData.connections[name] ?? {},
    )) {
      for (const targets of outputs)
        for (const target of targets) markBranch(target.node);
    }
  }
  for (const node of snapshot.workflowData.nodes.filter(
    (entry) => entry.type === 'n8n-nodes-base.if',
  )) {
    const tasks = runs[node.name];
    if (tasks?.length !== 1 || tasks[0].error) continue;
    const outputs = tasks[0].data?.main;
    if (!outputs?.some((items) => items && items.length > 0)) continue;
    outputs.forEach((items, index) => {
      if (Array.isArray(items) && items.length === 0) {
        for (const target of snapshot.workflowData.connections[node.name]
          ?.main?.[index] ?? [])
          markBranch(target.node);
      }
    });
  }
  for (const node of [...skipped].sort()) {
    if (!auxiliary.has(node))
      events.push({
        ...identity,
        sourceSeq: events.length,
        eventType: 'node.skipped',
        node,
        at: snapshot.stoppedAt,
        payload: {
          reason: noModelSkipped.has(node)
            ? 'model-not-configured'
            : 'condition-output-empty',
        },
      });
  }
  const envelopes = snapshot.workflowData.nodes
    .filter((node) => node.type === 'n8n-nodes-base.respondToWebhook')
    .flatMap((node) => runs[node.name] ?? [])
    .flatMap((task) => task.data?.main?.[0] ?? [])
    .map((item) => item.json)
    .filter(
      (json) =>
        json?.protocol === 'urtoris.v1' && json.requestId === input.requestId,
    );
  const envelope = envelopes[0];
  const meta = envelope?.meta as Record<string, unknown> | undefined;
  const success =
    snapshot.status === 'success' &&
    !error &&
    envelopes.length === 1 &&
    envelope?.success === true &&
    envelope.workflow === manifest.workflowId &&
    envelope.engine === 'n8n' &&
    ['llm', 'rules'].includes(String(envelope.mode)) &&
    typeof envelope.degraded === 'boolean' &&
    envelope.error === null &&
    envelope.data !== null &&
    typeof envelope.data === 'object' &&
    meta?.executionId === snapshot.id &&
    meta.sessionId === input.sessionId &&
    typeof meta.durationMs === 'number' &&
    Number.isFinite(meta.durationMs) &&
    meta.durationMs >= 0;
  if (!success) {
    const payload = error
      ? classifyExecutionError(error)
      : {
          code: 'WORKFLOW_ERROR',
          message: 'Execution did not produce one valid success envelope.',
          detail:
            'No success is inferred from an HTTP response or missing data.',
        };
    events.push({
      ...identity,
      sourceSeq: events.length,
      eventType: 'workflow.error',
      node: errorNode,
      at: snapshot.stoppedAt,
      payload,
    });
    events.push({
      ...identity,
      sourceSeq: events.length,
      eventType: 'run.failed',
      at: snapshot.stoppedAt,
      payload,
    });
  } else {
    events.push({
      ...identity,
      sourceSeq: events.length,
      eventType: 'run.completed',
      at: snapshot.stoppedAt,
      payload: { mode: envelopes[0]?.mode, degraded: envelopes[0]?.degraded },
    });
  }
  return events;
}
