import { createGraphNode } from '@/lib/workflow-graph/registry';
import type {
  ConnectionKind,
  StudioNodeType,
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';
import type { StepKind, WorkflowRecord } from '@/lib/workflow-types';

const stepType: Record<StepKind, StudioNodeType> = {
  input: 'trigger',
  transform: 'transform',
  decision: 'condition',
  compose: 'aiAgent',
  output: 'output',
};

function edge(
  source: WorkflowGraphNode,
  sourcePort: string,
  target: WorkflowGraphNode,
  targetPort: string,
  kind: ConnectionKind,
  label?: string,
): WorkflowGraphEdge {
  return {
    id: `edge_${source.id}_${sourcePort}_${target.id}_${targetPort}`.replaceAll(
      '.',
      '_',
    ),
    kind,
    source: { nodeId: source.id, portId: sourcePort },
    target: { nodeId: target.id, portId: targetPort },
    label,
    ...(kind === 'branch' && label ? { condition: { branch: label } } : {}),
  };
}

export function projectLegacyWorkflow(
  workflow: WorkflowRecord,
): WorkflowGraphV1 {
  const steps = workflow.draftSteps.length
    ? workflow.draftSteps
    : [
        {
          id: 'step_intake',
          title: '接收请求',
          detail: '读取输入内容',
          kind: 'input' as const,
        },
      ];
  /**
   * Output 在 Graph v1 里是终点节点（没有输出端口），所以主链到第一个
   * `output` 步骤为止：排在它后面的旧步骤不投影成画布节点，更不会连出
   * 「从 Output 出发」的悬空边。这些步骤仍然留在 `draft_steps_json` 里，
   * 使用端步骤列表能看到，想放到画布上就调整顺序或改类型。
   */
  const firstOutputIndex = steps.findIndex((step) => step.kind === 'output');
  const canvasSteps =
    firstOutputIndex >= 0 ? steps.slice(0, firstOutputIndex + 1) : steps;
  const mainNodes = canvasSteps.map((step, index) =>
    createGraphNode(
      stepType[step.kind],
      { x: 80 + index * 280, y: 150 },
      {
        id: `node_${step.id}`,
        name: step.title,
        description: step.detail,
        config: {
          ...createGraphNode(stepType[step.kind], { x: 0, y: 0 }).config,
          legacyStepId: step.id,
          legacyStepKind: step.kind,
        },
      },
    ),
  );

  const nodes = [...mainNodes];
  const edges: WorkflowGraphEdge[] = [];
  const outputNode = [...mainNodes]
    .reverse()
    .find((node) => node.type === 'output');

  const hasMainInput = (node: WorkflowGraphNode) =>
    node.ports.some((port) => port.id === 'main.in' && port.direction === 'input');
  const hasMainOutput = (node: WorkflowGraphNode) =>
    node.ports.some(
      (port) => port.id === 'main.out' && port.direction === 'output',
    );

  mainNodes.forEach((node, index) => {
    const next = mainNodes[index + 1];
    if (!next) return;
    if (node.type === 'condition') {
      if (hasMainInput(next)) {
        edges.push(
          edge(node, 'branch.true', next, 'main.in', 'branch', 'true'),
        );
      }
      if (outputNode && outputNode.id !== next.id && hasMainInput(outputNode)) {
        edges.push(
          edge(node, 'branch.false', outputNode, 'main.in', 'branch', 'false'),
        );
      }
      return;
    }
    /**
     * Output 是终点节点，没有输出端口。
     * 旧步骤如果排在 Output 之后（例如用户后加的"新步骤"），就从这里断开，
     * 而不是连出一条从不存在端口出发的悬空边 —— 那种边连 React Flow 都画不出来，
     * 也会让「辅助 Agent」回显现有连接时被判无效。
     */
    if (!hasMainOutput(node) || !hasMainInput(next)) return;
    edges.push(edge(node, 'main.out', next, 'main.in', 'main'));
  });

  const agent = mainNodes.find((node) => node.type === 'aiAgent');
  if (agent) {
    const resources: WorkflowGraphNode[] = [
      createGraphNode(
        'llmModel',
        { x: agent.position.x - 120, y: 430 },
        {
          id: `${agent.id}_model`,
          name: 'Qwen Plus',
          description: 'BYO Key · OpenAI compatible',
        },
      ),
      createGraphNode(
        'memory',
        { x: agent.position.x + 110, y: 430 },
        {
          id: `${agent.id}_memory`,
          name: 'Conversation Memory',
          description: '按 sessionId 隔离上下文',
        },
      ),
      createGraphNode(
        'tool',
        { x: agent.position.x + 340, y: 430 },
        {
          id: `${agent.id}_http_tool`,
          name: 'HTTP API',
          description: '受控白名单请求',
        },
      ),
      createGraphNode(
        'tool',
        { x: agent.position.x + 340, y: 570 },
        {
          id: `${agent.id}_robot_tool`,
          name: 'Robot Control',
          description: 'ESP32 / Robot action',
          config: { implementation: 'robot', confirmation: 'on-risk' },
        },
      ),
    ];
    nodes.push(...resources);
    edges.push(
      edge(agent, 'resource.model', resources[0], 'model.provider', 'model'),
      edge(agent, 'resource.memory', resources[1], 'memory.provider', 'memory'),
      edge(agent, 'resource.tools', resources[2], 'tool.provider', 'tool'),
      edge(agent, 'resource.tools', resources[3], 'tool.provider', 'tool'),
    );
  }

  return {
    schemaVersion: 1,
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    revision: 0,
    nodes,
    edges,
    entryNodeIds: mainNodes[0] ? [mainNodes[0].id] : [],
    runtime: {
      engine: 'n8n',
      adapter: 'n8n-v1',
      executionMode: 'webhook',
      binding: workflow.n8nWebhookUrl ? 'external' : 'draft',
    },
    viewport: { x: 0, y: 0, zoom: 0.82 },
    metadata: { source: 'legacy-steps', updatedAt: Date.now() },
  };
}
