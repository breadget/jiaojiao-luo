import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compileGraphToLocalSqlite } from '@/lib/workflow-graph/adapter/local-sqlite';
import { compileGraphToN8n } from '@/lib/workflow-graph/adapter/n8n-v1';
import {
  buildWorkflowAgentMessages,
  createWorkflowAgentProposal,
} from '@/lib/workflow-graph/agent';
import {
  getLocalDatabaseConnections,
  hasLocalDatabaseNodes,
  validateLocalDatabaseConfig,
} from '@/lib/workflow-graph/local-database';
import { isWorkflowGraphPayload } from '@/lib/workflow-graph/payload';
import { validateGraph } from '@/lib/workflow-graph/validate';
import { makeEdge, makeNode } from './helpers/graph';
import { localDatabaseGraph } from './helpers/local-database-graph';

describe('本机 SQLite 工作流配置与计划', () => {
  it('数据库是 Agent 的只读工具，编译成明确的本机计划而非 n8n JSON', async () => {
    const graph = localDatabaseGraph();
    assert.equal(
      validateGraph(graph).some((issue) =>
        issue.message.includes('尚未连接 Memory'),
      ),
      false,
    );
    const result = await compileGraphToLocalSqlite(graph, {
      workflowId: graph.id,
      version: 1,
    });
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.workflow, null);
    assert.equal(result.adapter, 'local-sqlite');
    assert.equal(result.plan?.format, 'urtoris.local-sqlite.v1');
    assert.equal(result.plan?.transport, 'browser-loopback');
    assert.equal(result.plan?.readOnly, true);
    assert.match(result.plan?.agent.systemPrompt ?? '', /只允许查询订单/);
    assert.deepEqual(result.plan?.databases[0].agentNodeIds, ['local_agent']);
    assert.deepEqual(result.requiredCredentialRefs, []);
    assert.deepEqual(result.bindings, []);
    assert.equal(
      (await compileGraphToN8n(graph, { workflowId: graph.id, version: 1 })).ok,
      false,
    );
  });

  it('同图/版本的计划哈希稳定，修改路径或限制会改变计划', async () => {
    const graph = localDatabaseGraph();
    const original = await compileGraphToLocalSqlite(graph, {
      workflowId: graph.id,
      version: 1,
    });
    graph.revision = 7;
    graph.metadata.updatedAt += 100;
    const repeated = await compileGraphToLocalSqlite(graph, {
      workflowId: graph.id,
      version: 1,
    });
    assert.equal(original.compiledHash, repeated.compiledHash);
    assert.equal(original.graphHash, repeated.graphHash);
    graph.nodes.find((node) => node.type === 'database')!.config.filePath =
      '/Users/me/data/customers.db';
    assert.notEqual(
      original.compiledHash,
      (
        await compileGraphToLocalSqlite(graph, {
          workflowId: graph.id,
          version: 1,
        })
      ).compiledHash,
    );
  });

  it('可保存未填路径的草稿，但不能发布它', async () => {
    const graph = localDatabaseGraph('wf_empty', '');
    assert.equal(isWorkflowGraphPayload(graph), true);
    assert.equal(
      validateGraph(graph).some((issue) => issue.level === 'error'),
      false,
    );
    const compiled = await compileGraphToLocalSqlite(graph, {
      workflowId: graph.id,
      version: 1,
    });
    assert.equal(compiled.ok, false);
    assert.equal(compiled.compiledJson, null);
    assert.match(
      compiled.issues.map((issue) => issue.message).join('\n'),
      /完整位置/,
    );
  });

  it('文件地址校验支持 Unix 与 Windows，只允许只读 SQLite 文件', () => {
    const config = localDatabaseGraph().nodes.find(
      (node) => node.type === 'database',
    )!.config;
    for (const filePath of [
      '/Users/me/My Data/订单.db',
      'C:\\data\\orders.sqlite',
      'D:/data/orders.sqlite3',
    ]) {
      assert.equal(validateLocalDatabaseConfig({ ...config, filePath }), null);
    }
    for (const filePath of [
      'orders.db',
      '~/orders.db',
      'https://example.com/orders.db',
      'file:///tmp/orders.db',
      '/tmp/../orders.db',
      '/tmp/orders.csv',
      '/tmp/line\nbreak.db',
    ]) {
      assert.ok(validateLocalDatabaseConfig({ ...config, filePath }), filePath);
    }
    for (const operation of ['insert', 'update', 'delete', 'execute']) {
      assert.ok(validateLocalDatabaseConfig({ ...config, operation }));
    }
    for (const maxRows of [0, 501, 1.2, '100'])
      assert.ok(validateLocalDatabaseConfig({ ...config, maxRows }));
  });

  it('payload 拒绝畸形本机配置，保留旧服务器数据库快照的形状兼容', () => {
    const graph = localDatabaseGraph();
    const database = graph.nodes.find((node) => node.type === 'database')!;
    database.config.filePath = 123;
    assert.equal(isWorkflowGraphPayload(graph), false);
    database.config = { operation: 'insert' };
    database.ports = database.ports.filter((port) => port.kind === 'main');
    assert.equal(isWorkflowGraphPayload(graph), true);
    assert.equal(hasLocalDatabaseNodes(graph), false);
  });

  it('兼容仅有 main ports 的数据库，但不会授权孤立数据库', async () => {
    const graph = localDatabaseGraph();
    graph.edges = graph.edges.filter(
      (edge) => edge.kind !== 'tool' && edge.target.nodeId !== 'local_output',
    );
    graph.edges.push(
      makeEdge('local_agent', 'main.out', 'local_database', 'main.in'),
      makeEdge('local_database', 'main.out', 'local_output', 'main.in'),
    );
    graph.nodes.find((node) => node.type === 'database')!.ports = graph.nodes
      .find((node) => node.type === 'database')!
      .ports.filter((port) => port.kind === 'main');
    assert.deepEqual(getLocalDatabaseConnections(graph)[0].agentNodeIds, [
      'local_agent',
    ]);
    assert.equal(
      (
        await compileGraphToLocalSqlite(graph, {
          workflowId: graph.id,
          version: 1,
        })
      ).ok,
      true,
    );
    const detached = localDatabaseGraph();
    detached.edges = detached.edges.filter((edge) => edge.kind !== 'tool');
    assert.deepEqual(getLocalDatabaseConnections(detached)[0].agentNodeIds, []);
    assert.equal(
      (
        await compileGraphToLocalSqlite(detached, {
          workflowId: detached.id,
          version: 1,
        })
      ).ok,
      false,
    );
  });

  it('混合不支持节点、没有 Agent/Model 与多个 Agent 都明确拒绝', async () => {
    for (const mutate of [
      (graph: ReturnType<typeof localDatabaseGraph>) =>
        graph.nodes.push(makeNode('httpRequest', 'http')),
      (graph: ReturnType<typeof localDatabaseGraph>) =>
        graph.nodes.push(makeNode('aiAgent', 'second_agent')),
      (graph: ReturnType<typeof localDatabaseGraph>) => {
        graph.nodes = graph.nodes.filter((node) => node.type !== 'llmModel');
      },
      (graph: ReturnType<typeof localDatabaseGraph>) => {
        graph.nodes.find((node) => node.type === 'aiAgent')!.disabled = true;
      },
      (graph: ReturnType<typeof localDatabaseGraph>) => {
        graph.edges.push(
          makeEdge('missing_node', 'main.out', 'local_output', 'main.in'),
        );
      },
    ]) {
      const graph = localDatabaseGraph();
      mutate(graph);
      assert.equal(
        (
          await compileGraphToLocalSqlite(graph, {
            workflowId: graph.id,
            version: 1,
          })
        ).ok,
        false,
      );
    }
  });

  it('辅助 Agent 可以生成本机数据库蓝图与可发布 runtime', async () => {
    const graph = localDatabaseGraph();
    const blueprint = {
      schemaVersion: 1,
      summary: '创建本机订单数据库助手',
      name: graph.name,
      description: '',
      nodes: graph.nodes.map((node) => ({
        key: node.id,
        type: node.type,
        name: node.name,
        description: node.description,
        config: node.config,
      })),
      connections: graph.edges.map((edge) => ({
        sourceKey: edge.source.nodeId,
        sourcePort: edge.source.portId,
        targetKey: edge.target.nodeId,
        targetPort: edge.target.portId,
      })),
    };
    const proposal = createWorkflowAgentProposal(JSON.stringify(blueprint), {
      mode: 'create',
    });
    assert.equal(proposal.graph.runtime.adapter, 'local-sqlite');
    assert.equal(
      (
        await compileGraphToLocalSqlite(proposal.graph, {
          workflowId: proposal.graph.id,
          version: 1,
        })
      ).ok,
      true,
    );
    const messages = buildWorkflowAgentMessages({
      mode: 'create',
      request: '连接我电脑中的 SQLite 文件',
    });
    assert.match(messages[0].content, /不导入 n8n/);
    assert.match(messages[0].content, /不能读取服务器同名文件/);
  });
});
