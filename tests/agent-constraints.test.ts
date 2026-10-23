import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildWorkflowSystemPrompt } from '@/lib/server/llm';
import { compileGraphToN8n } from '@/lib/workflow-graph/adapter/n8n-v1';
import type { N8nNode } from '@/lib/workflow-graph/adapter/types';
import { AGENT_CONSTRAINTS_MAX_LENGTH } from '@/lib/workflow-graph/agent-constraints';
import { isWorkflowGraphPayload } from '@/lib/workflow-graph/payload';
import {
  canaryGraph,
  legacyWorkflow,
  makeEdge,
  makeNode,
} from './helpers/graph';

describe('Agent 自然语言行为限制', () => {
  it('每个 Agent 的限制只编译到自己的系统提示词，保留任务指令', async () => {
    const graph = canaryGraph();
    const agent = graph.nodes.find((node) => node.type === 'aiAgent');
    assert.ok(agent);
    agent.config = {
      ...agent.config,
      instructions: '查询客户的订单状态。',
      constraints: '只允许查询订单，不得修改数据。',
    };
    graph.nodes.push(
      makeNode('aiAgent', 'node_second_agent', {
        name: '摘要 Agent',
        config: { instructions: '整理摘要。', constraints: '不得发送消息。' },
      }),
      makeNode('llmModel', 'node_second_model'),
    );
    graph.edges = graph.edges.filter(
      (edge) =>
        !(
          edge.source.nodeId === 'node_robot' &&
          edge.target.nodeId === 'node_out'
        ),
    );
    graph.edges.push(
      makeEdge('node_robot', 'main.out', 'node_second_agent', 'main.in'),
      makeEdge('node_second_agent', 'main.out', 'node_out', 'main.in'),
      makeEdge(
        'node_second_agent',
        'resource.model',
        'node_second_model',
        'model.provider',
        'model',
      ),
    );

    const compiled = await compileGraphToN8n(graph, {
      workflowId: graph.id,
      version: 1,
    });
    assert.equal(compiled.ok, true, JSON.stringify(compiled.issues));
    const promptFor = (nodeId: string) => {
      const node: N8nNode | undefined = compiled.workflow?.nodes.find(
        (item) => item.name === `U::${nodeId}::primary`,
      );
      return String(
        (node?.parameters.options as { systemMessage?: string })?.systemMessage,
      );
    };
    assert.match(promptFor(agent.id), /查询客户的订单状态/);
    assert.match(promptFor(agent.id), /只允许查询订单，不得修改数据/);
    assert.doesNotMatch(promptFor(agent.id), /不得发送消息/);
    assert.match(promptFor('node_second_agent'), /不得发送消息/);
    assert.doesNotMatch(promptFor('node_second_agent'), /不得修改数据/);

    const prompt = buildWorkflowSystemPrompt(legacyWorkflow(), graph);
    assert.match(prompt, /执行「AI 主管」对应步骤时/);
    assert.match(prompt, /执行「摘要 Agent」对应步骤时/);
    graph.nodes.find((node) => node.id === 'node_second_agent')!.disabled =
      true;
    assert.doesNotMatch(
      buildWorkflowSystemPrompt(legacyWorkflow(), graph),
      /不得发送消息/,
    );
  });

  it('清空或省略限制兼容原有 Agent 的系统提示词', async () => {
    const graph = canaryGraph();
    const agent = graph.nodes.find((node) => node.type === 'aiAgent');
    assert.ok(agent);
    for (const value of [undefined, '', '  \n  ']) {
      agent.config.constraints = value;
      const compiled = await compileGraphToN8n(graph, {
        workflowId: graph.id,
        version: 1,
      });
      assert.equal(compiled.ok, true);
      const node: N8nNode | undefined = compiled.workflow?.nodes.find(
        (item) => item.name === `U::${agent.id}::primary`,
      );
      assert.equal(
        (node?.parameters.options as { systemMessage?: string })?.systemMessage,
        agent.config.instructions,
      );
      assert.doesNotMatch(
        buildWorkflowSystemPrompt(legacyWorkflow(), graph),
        /行为限制/,
      );
    }
  });

  it('配置了限制的 Agent 不能通过无模型规则备援绕过限制', async () => {
    const graph = canaryGraph();
    const agent = graph.nodes.find((node) => node.type === 'aiAgent')!;
    const model = graph.nodes.find((node) => node.type === 'llmModel')!;
    agent.config.fallbackPolicy = 'rules';
    model.config.credentialRef = 'none';
    agent.config.constraints = '不得修改订单。';
    const rejected = await compileGraphToN8n(graph, {
      workflowId: graph.id,
      version: 1,
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.workflow, null);
    assert.ok(rejected.issues.some((issue) =>
      issue.level === 'error' && issue.nodeId === agent.id &&
      issue.message.includes('规则备援无法应用这些限制')));
    agent.config.constraints = '';
    assert.equal((await compileGraphToN8n(graph, {
      workflowId: graph.id,
      version: 1,
    })).ok, true);
  });

  it('保存入口和编译入口拒绝非文本及超长限制，允许 4000 字符', async () => {
    const graph = canaryGraph();
    const agent = graph.nodes.find((node) => node.type === 'aiAgent');
    assert.ok(agent);
    for (const value of [
      null,
      false,
      42,
      ['禁止删除'],
      { text: '禁止删除' },
      '限'.repeat(AGENT_CONSTRAINTS_MAX_LENGTH + 1),
    ]) {
      agent.config.constraints = value;
      assert.equal(isWorkflowGraphPayload(graph), false);
      const compiled = await compileGraphToN8n(graph, {
        workflowId: graph.id,
        version: 1,
      });
      assert.equal(compiled.ok, false);
      assert.equal(compiled.workflow, null);
      assert.ok(
        compiled.issues.some(
          (issue) =>
            issue.level === 'error' && issue.message.includes('行为限制'),
        ),
      );
    }
    agent.config.constraints = '限'.repeat(AGENT_CONSTRAINTS_MAX_LENGTH);
    assert.equal(isWorkflowGraphPayload(graph), true);
    assert.equal(
      (await compileGraphToN8n(graph, { workflowId: graph.id, version: 1 })).ok,
      true,
    );
  });
});
