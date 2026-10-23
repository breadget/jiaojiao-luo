import assert from 'node:assert/strict';
import { it } from 'node:test';
import {
  executionDataEvents,
  type ExecutionSnapshot,
  type RuntimeManifest,
  type TaskData,
} from '@/lib/workflow-graph/execution-data-events';
const manifest: RuntimeManifest = {
  externalWorkflowId: 'external',
  workflowId: 'wf_n8n_test',
  graphVersion: 1,
  inputName: 'input',
  bindName: 'bind',
  guardName: 'guard',
  triggerName: 'webhook',
  auxiliaryNames: ['input', 'bind', 'guard'],
};
const task = (json: Record<string, unknown>, start = 100): TaskData => ({
  startTime: start,
  executionTime: 2,
  executionStatus: 'success',
  data: { main: [[{ json }]] },
});
function snapshot(high = true): ExecutionSnapshot {
  const root = {
    requestId: 'request-a',
    sessionId: 'session-a',
    workflowId: 'wf_n8n_test',
    __urtorisExecutionId: '1',
  };
  return {
    id: '1',
    workflowId: 'external',
    status: 'success',
    stoppedAt: 200,
    workflowData: {
      nodes: [
        { id: '1', name: 'route', type: 'n8n-nodes-base.if' },
        { id: '2', name: 'high', type: 'n8n-nodes-base.respondToWebhook' },
        { id: '3', name: 'normal', type: 'n8n-nodes-base.respondToWebhook' },
      ],
      connections: {
        route: { main: [[{ node: 'high' }], [{ node: 'normal' }]] },
      },
    },
    data: {
      resultData: {
        runData: {
          input: [task(root)],
          bind: [task({ statusCode: 200, body: { ok: true, bound: true } })],
          guard: [task(root)],
          route: [
            {
              ...task({}),
              data: {
                main: high ? [[{ json: {} }], []] : [[], [{ json: {} }]],
              },
            },
          ],
          model: [task({}, 110), task({}, 120)],
          memory: [task({}, 105), task({}, 130)],
          [high ? 'high' : 'normal']: [
            task(
              {
                protocol: 'urtoris.v1',
                success: true,
                requestId: 'request-a',
                mode: 'llm',
                degraded: false,
                workflow: 'wf_n8n_test',
                engine: 'n8n',
                error: null,
                data: {},
                meta: {
                  executionId: '1',
                  sessionId: 'session-a',
                  durationMs: 20,
                },
              },
              150,
            ),
          ],
        },
      },
    },
  };
}
for (const high of [true, false])
  it(`real-data converter follows the ${high ? 'true' : 'false'} output and emits deterministic sequence`, () => {
    const events = executionDataEvents(snapshot(high), manifest);
    assert.deepEqual(events, executionDataEvents(snapshot(high), manifest));
    assert.deepEqual(
      events.map((e) => e.sourceSeq),
      events.map((_, i) => i),
    );
    assert.equal(events[0].eventType, 'execution.bound');
    assert.equal(events.at(-1)!.eventType, 'run.completed');
    assert.equal(
      events.find((e) => e.node === (high ? 'normal' : 'high'))!.eventType,
      'node.skipped',
    );
    assert.ok(
      !events.some(
        (e) =>
          e.node === (high ? 'normal' : 'high') &&
          e.eventType === 'node.finished',
      ),
    );
    assert.equal(
      events.filter(
        (e) => e.node === 'memory' && e.eventType === 'node.finished',
      ).length,
      1,
    );
  });
for (const [message, expected] of [
  ['401 Incorrect API key Bearer throw-away-key', 'LLM_ERROR'],
  ['Connection error ECONNREFUSED', 'NETWORK_ERROR'],
  ['Unexpected token in JSON', 'LLM_ERROR'],
])
  it(`Qwen failure ${expected} cannot become rules success`, () => {
    const data = snapshot();
    data.status = 'error';
    data.data.resultData!.runData!.model[1].error = { message };
    data.data.resultData!.error = { message };
    const events = executionDataEvents(data, manifest);
    assert.equal(events.at(-1)!.eventType, 'run.failed');
    assert.equal(
      events.find((e) => e.eventType === 'workflow.error')!.payload!.code,
      expected,
    );
    assert.equal(
      events.find((e) => e.node === 'model' && e.eventType !== 'node.started')!
        .eventType,
      'node.error',
    );
    assert.ok(!JSON.stringify(events).includes('throw-away-key'));
    assert.ok(!events.some((e) => e.eventType === 'run.completed'));
  });
it('no saved data, pending execution, invalid binding or missing session never invent success', () => {
  const data = snapshot();
  data.status = 'running';
  assert.deepEqual(executionDataEvents(data, manifest), []);
  data.status = 'success';
  data.data.resultData!.runData!.bind = [task({ statusCode: 401 })];
  assert.deepEqual(executionDataEvents(data, manifest), []);
  data.data = {};
  assert.deepEqual(executionDataEvents(data, manifest), []);
  assert.throws(
    () =>
      executionDataEvents(snapshot(), {
        ...manifest,
        externalWorkflowId: 'other',
      }),
    /MISMATCH/,
  );
  const invalid = snapshot();
  invalid.data.resultData!.runData!.input = [
    task({ requestId: 'r', sessionId: '' }),
  ];
  assert.deepEqual(executionDataEvents(invalid, manifest), []);
});
it('an n8n success without a valid output envelope becomes run.failed', () => {
  const data = snapshot();
  delete data.data.resultData!.runData!.high;
  assert.equal(
    executionDataEvents(data, manifest).at(-1)!.eventType,
    'run.failed',
  );
});
for (const change of [
  { workflow: 'another-workflow' },
  { error: { code: 'LLM_ERROR' } },
  { degraded: 'false' },
  { meta: {} },
]) {
  it(`invalid success envelope fails closed: ${Object.keys(change)[0]}`, () => {
    const data = snapshot();
    Object.assign(
      data.data.resultData!.runData!.high[0].data!.main[0]![0].json!,
      change,
    );
    assert.equal(
      executionDataEvents(data, manifest).at(-1)!.eventType,
      'run.failed',
    );
  });
}
