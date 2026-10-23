/**
 * 测试用的 Graph / 旧版工作流夹具。
 *
 * 目标是让每个用例只表达"这次要测的那个差异"，其余部分都是合法的，
 * 这样失败信息才能直接指向被破坏的规则。
 */
import { createGraphNode } from '@/lib/workflow-graph/registry';
import type {
  ConnectionKind,
  StudioNodeType,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';
import type {
  StepKind,
  WorkflowRecord,
  WorkflowStep,
} from '@/lib/workflow-types';

export function makeNode(
  type: StudioNodeType,
  id: string,
  overrides: Partial<WorkflowGraphNode> = {},
): WorkflowGraphNode {
  return createGraphNode(type, { x: 0, y: 0 }, { id, ...overrides });
}

export function makeEdge(
  sourceId: string,
  sourcePort: string,
  targetId: string,
  targetPort: string,
  kind: ConnectionKind = 'main',
): WorkflowGraphEdge {
  return {
    id: `edge_${sourceId}_${sourcePort}_${targetId}_${targetPort}`.replaceAll(
      '.',
      '_',
    ),
    kind,
    source: { nodeId: sourceId, portId: sourcePort },
    target: { nodeId: targetId, portId: targetPort },
    ...(kind === 'branch'
      ? { label: sourcePort.split('.')[1], condition: { branch: sourcePort.split('.')[1] } }
      : {}),
  };
}

export function graphOf(
  nodes: WorkflowGraphNode[],
  edges: WorkflowGraphEdge[],
  overrides: Partial<WorkflowGraphV1> = {},
): WorkflowGraphV1 {
  return {
    schemaVersion: 1,
    id: 'wf_test',
    name: '测试工作流',
    description: '测试夹具',
    revision: 0,
    nodes,
    edges,
    entryNodeIds: nodes.length ? [nodes[0].id] : [],
    runtime: {
      engine: 'n8n',
      adapter: 'n8n-v1',
      executionMode: 'webhook',
      binding: 'draft',
    },
    viewport: { x: 0, y: 0, zoom: 0.82 },
    metadata: { source: 'urtoris', updatedAt: 1_700_000_000_000 },
    ...overrides,
  };
}

/** 输出端口 id：Condition 走 true 分支，其余走 main。 */
function outPort(type: StudioNodeType, branch: 'true' | 'false' = 'true') {
  if (type === 'condition') return `branch.${branch}`;
  return 'main.out';
}

/** trigger/资源节点没有 main 输入。 */
function inPort(type: StudioNodeType) {
  if (type === 'trigger') return null;
  if (type === 'llmModel') return 'model.provider';
  if (type === 'memory') return 'memory.provider';
  if (type === 'tool') return 'tool.provider';
  return 'main.in';
}

/**
 * 把一串节点按主链路连起来。
 * Condition 的 true 分支接到下一个节点；false 分支由调用方显式补。
 */
export function chainGraph(types: StudioNodeType[], id = 'wf_test'): WorkflowGraphV1 {
  const nodes = types.map((type, index) =>
    makeNode(type, `node_${index}`, { name: `${type}_${index}` }),
  );
  const edges: WorkflowGraphEdge[] = [];
  for (let index = 0; index < nodes.length - 1; index += 1) {
    const source = nodes[index];
    const target = nodes[index + 1];
    const targetPort = inPort(target.type) ?? 'main.in';
    if (source.type === 'condition') {
      edges.push(
        makeEdge(source.id, 'branch.true', target.id, targetPort, 'branch'),
      );
      const output = nodes.findLast((node) => node.type === 'output');
      if (output && output.id !== target.id) {
        edges.push(
          makeEdge(source.id, 'branch.false', output.id, 'main.in', 'branch'),
        );
      }
    } else {
      edges.push(makeEdge(source.id, outPort(source.type), target.id, targetPort));
    }
  }
  return graphOf(nodes, edges, { id });
}

/** 最小合法图：Trigger → Transform → Output。 */
export function validGraph(): WorkflowGraphV1 {
  return chainGraph(['trigger', 'transform', 'output']);
}

/** 单窗口 100 节点上限的性能基线图：长链 + 一个 Condition。 */
export function largeGraph(nodeCount: number): WorkflowGraphV1 {
  const types: StudioNodeType[] = ['trigger'];
  for (let index = 1; index < nodeCount - 1; index += 1) {
    types.push(index % 9 === 4 ? 'condition' : 'transform');
  }
  types.push('output');
  return chainGraph(types, 'wf_large');
}

export function legacySteps(): WorkflowStep[] {
  return [
    { id: 'step_intake', title: '接收请求', detail: '读取输入', kind: 'input' },
    { id: 'step_clean', title: '清洗', detail: '归一化字段', kind: 'transform' },
    { id: 'step_route', title: '判定', detail: '按优先级分流', kind: 'decision' },
    { id: 'step_agent', title: 'AI 主管', detail: '模型判定职级', kind: 'compose' },
    { id: 'step_output', title: '返回', detail: '生成信封', kind: 'output' },
  ];
}

export function legacyWorkflow(
  steps: WorkflowStep[] = legacySteps(),
  overrides: Partial<WorkflowRecord> = {},
): WorkflowRecord {
  return {
    id: 'wf_legacy',
    name: '旧版工作流',
    description: '来自 WorkflowStep[] 的兼容投影',
    draftSteps: steps,
    publishedSteps: steps,
    version: 3,
    hasUnpublishedChanges: false,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    publishedAt: 1_700_000_000_000,
    n8nWebhookUrl: 'http://127.0.0.1:5678/webhook/urtoris/legacy',
    ...overrides,
  };
}

export function step(kind: StepKind, id: string): WorkflowStep {
  return { id, title: `${kind} 步骤`, detail: `${kind} 细节`, kind };
}

/**
 * Adapter 第一版支持的全部节点类型，构成一张真正能编译的图：
 *
 *   Trigger ─→ Condition ─true─→ AI Agent ─→ Robot Action ─┐
 *                  │ false              ↑ model/memory/tool │
 *                  └────→ HTTP Request ─┴────→ Output ←─────┘
 */
export function canaryGraph(id = 'wf_canary'): WorkflowGraphV1 {
  const nodes = [
    makeNode('trigger', 'node_trigger', { name: '接收请求', position: { x: 0, y: 120 } }),
    makeNode('condition', 'node_route', {
      name: '是否高优先级',
      position: { x: 240, y: 120 },
      config: { expression: '$json.priority === "high"' },
    }),
    makeNode('aiAgent', 'node_agent', { name: 'AI 主管', position: { x: 520, y: 60 } }),
    makeNode('llmModel', 'node_model', {
      name: 'Qwen Plus',
      position: { x: 520, y: 320 },
      config: { provider: 'openai-compatible', model: 'qwen-plus' },
    }),
    makeNode('memory', 'node_memory', {
      name: '会话记忆',
      position: { x: 760, y: 320 },
      config: { provider: 'window', maxTurns: 12 },
    }),
    makeNode('tool', 'node_tool', {
      name: '订单查询',
      position: { x: 1000, y: 320 },
      config: {
        implementation: 'http',
        url: 'https://api.example.com/orders',
        method: 'GET',
        timeoutMs: 15000,
        confirmation: 'on-risk',
      },
    }),
    makeNode('robotAction', 'node_robot', {
      name: '机器人指令',
      position: { x: 800, y: 60 },
      config: { action: 'dispatch', endpoint: 'http://robot.local/command', confirmation: 'on-risk' },
    }),
    makeNode('httpRequest', 'node_http', {
      name: '通知上游',
      position: { x: 520, y: 560 },
      config: { method: 'POST', url: 'https://api.example.com/notify', timeoutMs: 15000 },
    }),
    makeNode('output', 'node_out', { name: '返回结果', position: { x: 1080, y: 60 } }),
  ];
  const edges = [
    makeEdge('node_trigger', 'main.out', 'node_route', 'main.in'),
    makeEdge('node_route', 'branch.true', 'node_agent', 'main.in', 'branch'),
    makeEdge('node_route', 'branch.false', 'node_http', 'main.in', 'branch'),
    makeEdge('node_agent', 'main.out', 'node_robot', 'main.in'),
    makeEdge('node_http', 'main.out', 'node_out', 'main.in'),
    makeEdge('node_robot', 'main.out', 'node_out', 'main.in'),
    makeEdge('node_agent', 'resource.model', 'node_model', 'model.provider', 'model'),
    makeEdge('node_agent', 'resource.memory', 'node_memory', 'memory.provider', 'memory'),
    makeEdge('node_agent', 'resource.tools', 'node_tool', 'tool.provider', 'tool'),
  ];
  return graphOf(nodes, edges, { id, name: 'Canary 工作流', description: 'Adapter 验收图' });
}
