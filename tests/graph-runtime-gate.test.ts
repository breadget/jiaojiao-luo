import assert from 'node:assert/strict';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { compileGraphToN8n } from '@/lib/workflow-graph/adapter/n8n-v1';
import { bindingGuardCode } from '@/lib/workflow-graph/adapter/runtime-gate';
import { canaryGraph } from './helpers/graph';

it('every business path is dominated by validation, binding HTTP, and the strict guard', async () => {
  const result = await compileGraphToN8n(canaryGraph(), {
    workflowId: 'wf_canary',
    version: 1,
  });
  assert.ok(result.ok);
  const wf = result.workflow!;
  assert.equal(
    wf.connections['U::node_trigger::primary'].main[0][0].node,
    'U::node_trigger::input',
  );
  assert.equal(
    wf.connections['U::node_trigger::input'].main[0][0].node,
    'U::node_trigger::execution-bound',
  );
  assert.equal(
    wf.connections['U::node_trigger::execution-bound'].main[0][0].node,
    'U::node_trigger::binding-guard',
  );
  assert.equal(
    wf.nodes.find((n) => n.name.endsWith('::execution-bound'))!.onError,
    'stopWorkflow',
  );
  const second = await compileGraphToN8n(canaryGraph(), {
    workflowId: 'wf_canary',
    version: 1,
  });
  assert.equal(result.compiledJson, second.compiledJson);
  assert.deepEqual(result.bindings, second.bindings);
});

it('400/401/404/409/503, deceptive 2xx and invalid bodies cannot reach dangerous code', () => {
  let dangerous = 0;
  const code = '(function(){' + bindingGuardCode('input') + '})()';
  for (const statusCode of [400, 401, 404, 409, 503, 201, 204, 302]) {
    assert.throws(() => {
      runInNewContext(code, {
        $input: {
          first: () => ({
            json: { statusCode, body: { ok: true, bound: true } },
          }),
        },
      });
      dangerous++;
    }, /BINDING_FAILED/);
  }
  for (const body of [
    {},
    { ok: true },
    { ok: 'true', bound: true },
    { ok: true, bound: 'true' },
  ]) {
    assert.throws(
      () =>
        runInNewContext(code, {
          $input: { first: () => ({ json: { statusCode: 200, body } }) },
        }),
      /BINDING_FAILED/,
    );
  }
  assert.equal(dangerous, 0);
  const root = { requestId: 'r', sessionId: 's', question: 'q' };
  const output = runInNewContext(code, {
    $input: {
      first: () => ({
        json: { statusCode: 200, body: { ok: true, bound: true } },
      }),
    },
    $: () => ({ first: () => ({ json: root }) }),
  });
  assert.equal(output[0].json, root);
});

it('invalid identifiers and workflow override fail before binding', async () => {
  const result = await compileGraphToN8n(canaryGraph(), {
    workflowId: 'wf_canary',
    version: 1,
  });
  const code =
    '(function(){' +
    result.workflow!.nodes.find((n) => n.name.endsWith('::input'))!.parameters
      .jsCode +
    '})()';
  for (const body of [
    {},
    { requestId: 'unknown', sessionId: 's' },
    { requestId: 'r', sessionId: '' },
    { requestId: 'r', sessionId: 's', workflowId: 'wf_other' },
  ]) {
    assert.throws(
      () =>
        runInNewContext(code, {
          $input: { first: () => ({ json: { body } }) },
          $execution: { id: '1' },
        }),
      /VALIDATION_ERROR/,
    );
  }
});

it('explicit no-key rules configuration never mounts or calls a model and marks degradation', async () => {
  const graph = canaryGraph();
  graph.nodes.find((node) => node.id === 'node_model')!.config.credentialRef =
    'none';
  graph.nodes.find((node) => node.id === 'node_agent')!.config.fallbackPolicy =
    'rules';
  const compiled = await compileGraphToN8n(graph, {
    workflowId: 'wf_canary',
    version: 1,
  });
  assert.equal(compiled.ok, true);
  assert.equal(
    compiled.workflow!.nodes.find(
      (node) => node.name === 'U::node_agent::primary',
    )!.type,
    'n8n-nodes-base.code',
  );
  assert.ok(!compiled.requiredCredentialRefs.includes('openAiApi'));
  assert.equal(
    compiled.workflow!.connections['U::node_model::model'],
    undefined,
  );
  const envelope = compiled.workflow!.nodes.find(
    (node) => node.name === 'U::node_out::envelope',
  )!;
  const result = runInNewContext(
    '(function(){' + envelope.parameters.jsCode + '})()',
    {
      $input: { first: () => ({ json: { reason: 'LLM_NOT_CONFIGURED' } }) },
      $: (name: string) =>
        name === 'U::node_agent::primary'
          ? { isExecuted: true }
          : { first: () => ({ json: { requestId: 'r' } }) },
    },
  );
  assert.equal(result[0].json.mode, 'rules');
  assert.equal(result[0].json.degraded, true);
  graph.nodes.find((node) => node.id === 'node_agent')!.config.fallbackPolicy =
    'error';
  const rejected = await compileGraphToN8n(graph, {
    workflowId: 'wf_canary',
    version: 1,
  });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.workflow, null);
});
