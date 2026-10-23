import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { chainGraph, largeGraph, makeNode, validGraph } from './helpers/graph';
import {
  containsCredentialMaterial,
  findCredentialMaterial,
  isWorkflowGraphPayload,
} from '@/lib/workflow-graph/payload';

describe('Graph payload guard', () => {
  it('接受合法草稿', () => {
    assert.equal(isWorkflowGraphPayload(validGraph()), true);
  });

  it('拒绝非对象与缺字段', () => {
    assert.equal(isWorkflowGraphPayload(null), false);
    assert.equal(isWorkflowGraphPayload('graph'), false);
    assert.equal(isWorkflowGraphPayload([]), false);
    assert.equal(isWorkflowGraphPayload({ schemaVersion: 2 }), false);
  });

  it('要求 runtime.engine 是 n8n、binding 是已知值', () => {
    const bad = validGraph();
    // @ts-expect-error 故意写入非法值
    bad.runtime = { ...bad.runtime, engine: 'airflow' };
    assert.equal(isWorkflowGraphPayload(bad), false);

    const badBinding = validGraph();
    // @ts-expect-error 故意写入非法值
    badBinding.runtime = { ...badBinding.runtime, binding: 'something' };
    assert.equal(isWorkflowGraphPayload(badBinding), false);
  });

  it('拒绝畸形节点：类型未知、缺端口、缺坐标、name 非字符串', () => {
    const unknownType = validGraph();
    // @ts-expect-error 故意写入非法类型
    unknownType.nodes[1].type = 'n8nOpaque';
    assert.equal(isWorkflowGraphPayload(unknownType), false);

    const noPorts = validGraph();
    // @ts-expect-error 故意删掉端口
    delete noPorts.nodes[1].ports;
    assert.equal(isWorkflowGraphPayload(noPorts), false);

    const noPosition = validGraph();
    // @ts-expect-error 故意写入非法坐标
    noPosition.nodes[1].position = { x: 0 };
    assert.equal(isWorkflowGraphPayload(noPosition), false);

    const noName = validGraph();
    // @ts-expect-error 故意写入非法名称
    noName.nodes[1].name = 42;
    assert.equal(isWorkflowGraphPayload(noName), false);
  });

  it('拒绝重复节点 id 与重复连接 id', () => {
    const duplicateNode = validGraph();
    duplicateNode.nodes[1] = { ...duplicateNode.nodes[1], id: duplicateNode.nodes[0].id };
    assert.equal(isWorkflowGraphPayload(duplicateNode), false);

    const duplicateEdge = validGraph();
    duplicateEdge.edges[1] = { ...duplicateEdge.edges[1], id: duplicateEdge.edges[0].id };
    assert.equal(isWorkflowGraphPayload(duplicateEdge), false);
  });

  it('拒绝负 revision 与非整数 revision', () => {
    assert.equal(isWorkflowGraphPayload({ ...validGraph(), revision: -1 }), false);
    assert.equal(isWorkflowGraphPayload({ ...validGraph(), revision: 1.5 }), false);
  });

  it('拒绝超过 100 个节点、超过 300 条连接、0 个节点', () => {
    assert.equal(isWorkflowGraphPayload(largeGraph(101)), false);
    assert.equal(isWorkflowGraphPayload(largeGraph(100)), true);
    assert.equal(isWorkflowGraphPayload({ ...validGraph(), nodes: [] }), false);

    const manyEdges = chainGraph(['trigger', 'output']);
    const base = manyEdges.edges[0];
    manyEdges.edges = Array.from({ length: 301 }, (_, index) => ({
      ...base,
      id: `edge_${index}`,
    }));
    assert.equal(isWorkflowGraphPayload(manyEdges), false);
  });

  it('保留装饰字段的宽容度：缺 viewport / metadata 仍可用', () => {
    const graph = validGraph();
    const loose = { ...graph } as Record<string, unknown>;
    delete loose.viewport;
    delete loose.metadata;
    assert.equal(isWorkflowGraphPayload(loose), true);
  });

  it('不把普通长标识符误判成密钥', () => {
    const graph = validGraph();
    graph.nodes[1] = {
      ...graph.nodes[1],
      id: 'node_step_1',
      name: '归一化收到的客户资料并判定优先级',
      config: { legacyStepId: 'step_1', mapping: '{"a":1}' },
    };
    graph.edges = [
      {
        ...graph.edges[0],
        id: 'edge_node_step_1_main_out_node_step_2_main_in',
        source: { nodeId: 'node_step_1', portId: 'main.out' },
      },
      graph.edges[1],
    ];
    assert.equal(containsCredentialMaterial(graph), false);
  });

  it('按字段名拒绝凭据（多种写法）', () => {
    for (const key of [
      'apiKey',
      'api_key',
      'X-Api-Key',
      'Authorization',
      'authorization',
      'password',
      'privateKey',
      'clientSecret',
      'accessToken',
      'secret',
    ]) {
      const graph = validGraph();
      graph.nodes[1] = {
        ...graph.nodes[1],
        config: { [key]: 'anything' },
      };
      assert.equal(
        containsCredentialMaterial(graph),
        true,
        `应当拒绝字段 ${key}`,
      );
    }
  });

  it('放行凭据引用（credentialRef / credentialId）', () => {
    const graph = validGraph();
    graph.nodes[1] = {
      ...graph.nodes[1],
      config: {
        credentialRef: 'n8n-header-auth',
        credentialId: 'cred_1',
        credentialName: 'urtoris-webhook',
      },
    };
    assert.equal(containsCredentialMaterial(graph), false);
  });

  it('按值形态拒绝内联密钥', () => {
    const samples = [
      'Bearer abcdefghijklmnop1234',
      'Basic YWJjZGVmZ2hpamtsbW5vcA==',
      'sk-abcdefghijklmnopqrstuvwx',
      'ghp_abcdefghijklmnopqrstuvwx',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.',
      '-----BEGIN RSA PRIVATE KEY-----',
    ];
    for (const value of samples) {
      const graph = validGraph();
      graph.nodes[1] = { ...graph.nodes[1], description: value };
      assert.equal(
        containsCredentialMaterial(graph),
        true,
        `应当拒绝值 ${value}`,
      );
    }
  });

  it('不把内容哈希当成密钥（否则编译产物自检永远过不了）', () => {
    // 本项目自己会产生 64 位十六进制的 graph_hash / compiled_hash，
    // 以及很长的边 id。通用"长随机串"规则会误伤它们，所以刻意不用。
    const graph = validGraph();
    graph.nodes[1] = {
      ...graph.nodes[1],
      description: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2',
    };
    assert.equal(containsCredentialMaterial(graph), false);
  });

  it('返回命中的字段路径，便于前端提示改哪里', () => {
    const graph = validGraph();
    graph.nodes[1] = { ...graph.nodes[1], config: { headers: { authorization: 'x' } } };
    assert.equal(findCredentialMaterial(graph), '$.nodes[1].config.headers.authorization');
  });

  it('容忍循环引用结构而不死循环', () => {
    const graph = validGraph();
    const cyclic: Record<string, unknown> = { token: undefined };
    cyclic.self = cyclic;
    graph.metadata = {
      ...graph.metadata,
      ...({ extra: cyclic } as unknown as typeof graph.metadata),
    };
    assert.equal(containsCredentialMaterial(graph), true);
  });

  it('Agent 资源端口的默认配置不算凭据', () => {
    const graph = chainGraph(['trigger', 'aiAgent', 'output']);
    const agent = graph.nodes.find((node) => node.type === 'aiAgent');
    assert.ok(agent);
    agent.config = {
      ...agent.config,
      allowBringYourOwnKey: true,
    };
    assert.equal(containsCredentialMaterial(graph), false);
  });

  it('trigger 的 authPolicy 值（urtoris-token）不算凭据', () => {
    const graph = validGraph();
    assert.equal(graph.nodes[0].type, 'trigger');
    assert.equal(containsCredentialMaterial(graph), false);
  });

  it('空节点数组里的节点也必须结构化', () => {
    const graph = validGraph();
    graph.nodes.push(makeNode('transform', 'node_bad'));
    graph.nodes[graph.nodes.length - 1] = {
      ...graph.nodes[graph.nodes.length - 1],
      ports: [{ id: 'main.in', label: 'Main', kind: 'main', direction: 'sideways' }],
    } as never;
    assert.equal(isWorkflowGraphPayload(graph), false);
  });
});
