import type {
  ConnectionKind,
  StudioNodeType,
  WorkflowGraphNode,
  WorkflowPort,
} from '@/lib/workflow-graph/types';
import { DEFAULT_LLM_PROVIDER_ID } from '@/lib/llm/providers';
import { randomId } from '@/lib/random-id';

export type NodeCategory =
  | 'Trigger'
  | 'Agent'
  | 'Logic'
  | 'Data'
  | 'Actions'
  | 'Resources';

export type NodeDefinition = {
  type: StudioNodeType;
  category: NodeCategory;
  label: string;
  description: string;
  capability: string;
  risk: 'low' | 'medium' | 'high';
  ports: WorkflowPort[];
  config: Record<string, unknown>;
};

const port = (
  id: string,
  label: string,
  kind: ConnectionKind,
  direction: 'input' | 'output',
  required = false,
  maxConnections: number | null = null,
): WorkflowPort => ({
  id,
  label,
  kind,
  direction,
  required,
  maxConnections,
});

export const nodeRegistry: Record<StudioNodeType, NodeDefinition> = {
  trigger: {
    type: 'trigger',
    category: 'Trigger',
    label: 'Webhook Trigger',
    description: '接收外部请求并创建 requestId',
    capability: 'webhook',
    risk: 'low',
    ports: [port('main.out', 'Main', 'main', 'output', true)],
    config: { trigger: 'webhook', authPolicy: 'urtoris-token' },
  },
  aiAgent: {
    type: 'aiAgent',
    category: 'Agent',
    label: 'AI Agent',
    description: '调用模型、记忆与工具完成任务',
    capability: 'agent.tools',
    risk: 'medium',
    ports: [
      port('main.in', 'Main', 'main', 'input', true, 1),
      port('main.out', 'Main', 'main', 'output'),
      port('resource.model', 'Model', 'model', 'output', true, 1),
      port('resource.memory', 'Memory', 'memory', 'output', false, 1),
      port('resource.tools', 'Tools', 'tool', 'output'),
    ],
    config: {
      strategy: 'tools',
      instructions: '理解请求，必要时调用工具，并返回结构化结果。',
      /** n8n 表达式体；Adapter 编译时包成 ={{ ... }} 作为 Agent 的用户提示词。 */
      prompt: '$json.message',
      maxIterations: 6,
      // 没有真实规则备援链路时必须显式失败，不伪装成降级成功。
      fallbackPolicy: 'error',
    },
  },
  llmModel: {
    type: 'llmModel',
    category: 'Resources',
    label: 'Qwen Model',
    description:
      '可选的模型服务：通义千问 / OpenAI / DeepSeek / Kimi / GLM / Claude / Gemini / 本机 Ollama / 自定义 OpenAI 兼容端点',
    capability: 'model.chat',
    risk: 'medium',
    ports: [port('model.provider', 'Model', 'model', 'input', false, 1)],
    config: {
      provider: DEFAULT_LLM_PROVIDER_ID,
      model: 'qwen-plus',
      allowBringYourOwnKey: true,
    },
  },
  memory: {
    type: 'memory',
    category: 'Resources',
    label: 'Window Memory',
    description: '按 sessionId 保存最近对话',
    capability: 'memory.window',
    risk: 'low',
    ports: [port('memory.provider', 'Memory', 'memory', 'input', false, 1)],
    config: { provider: 'window', maxTurns: 12 },
  },
  tool: {
    type: 'tool',
    category: 'Resources',
    label: 'HTTP Tool',
    description: '供 Agent 调用的受控工具',
    capability: 'tool.http',
    risk: 'high',
    ports: [port('tool.provider', 'Tool', 'tool', 'input', false, 1)],
    config: {
      implementation: 'http',
      url: '',
      timeoutMs: 15000,
      confirmation: 'on-risk',
    },
  },
  condition: {
    type: 'condition',
    category: 'Logic',
    label: 'Condition',
    description: '按表达式选择 true / false 分支',
    capability: 'logic.branch',
    risk: 'low',
    ports: [
      port('main.in', 'Main', 'main', 'input', true, 1),
      port('branch.true', 'true', 'branch', 'output', true),
      port('branch.false', 'false', 'branch', 'output', true),
    ],
    config: { expression: '$json.priority === "high"' },
  },
  httpRequest: {
    type: 'httpRequest',
    category: 'Data',
    label: 'HTTP Request',
    description: '调用白名单中的外部 API',
    capability: 'http.request',
    risk: 'high',
    ports: [
      port('main.in', 'Main', 'main', 'input', true, 1),
      port('main.out', 'Main', 'main', 'output'),
    ],
    config: { method: 'POST', url: '', timeoutMs: 15000 },
  },
  database: {
    type: 'database',
    category: 'Data',
    label: 'Database',
    description: '读取或写入受控数据源',
    capability: 'database.query',
    risk: 'high',
    ports: [
      port('main.in', 'Main', 'main', 'input', true, 1),
      port('main.out', 'Main', 'main', 'output'),
    ],
    config: { operation: 'select' },
  },
  transform: {
    type: 'transform',
    category: 'Logic',
    label: 'Transform',
    description: '把输入整理为下一节点需要的结构',
    capability: 'data.transform',
    risk: 'low',
    ports: [
      port('main.in', 'Main', 'main', 'input', true, 1),
      port('main.out', 'Main', 'main', 'output'),
    ],
    config: { mapping: '{}' },
  },
  robotAction: {
    type: 'robotAction',
    category: 'Actions',
    label: 'Robot Action',
    description: '把已校验指令发送给比赛机器人',
    capability: 'robot.command',
    risk: 'high',
    ports: [
      port('main.in', 'Main', 'main', 'input', true, 1),
      port('main.out', 'Main', 'main', 'output'),
    ],
    config: { action: 'dispatch', endpoint: '', confirmation: 'on-risk' },
  },
  subworkflow: {
    type: 'subworkflow',
    category: 'Resources',
    label: 'Subworkflow',
    description: '复用另一个已发布工作流',
    capability: 'workflow.invoke',
    risk: 'medium',
    ports: [
      port(
        'subworkflow.provider',
        'Workflow',
        'subworkflow',
        'input',
        false,
        1,
      ),
    ],
    config: { versionPolicy: 'pinned' },
  },
  output: {
    type: 'output',
    category: 'Actions',
    label: 'Output',
    description: '归一化并返回工作流结果',
    capability: 'response.output',
    risk: 'low',
    ports: [port('main.in', 'Main', 'main', 'input', true)],
    config: { envelope: 'urtoris.v1' },
  },
  legacyStep: {
    type: 'legacyStep',
    category: 'Logic',
    label: 'Legacy Step',
    description: '旧版步骤的只读兼容节点',
    capability: 'legacy.step',
    risk: 'low',
    ports: [
      port('main.in', 'Main', 'main', 'input', false, 1),
      port('main.out', 'Main', 'main', 'output'),
    ],
    config: {},
  },
  externalN8nWorkflow: {
    type: 'externalN8nWorkflow',
    category: 'Actions',
    label: 'External n8n',
    description: '继续调用已经存在的 n8n Webhook',
    capability: 'n8n.external',
    risk: 'medium',
    ports: [
      port('main.in', 'Main', 'main', 'input', false, 1),
      port('main.out', 'Main', 'main', 'output'),
    ],
    config: {},
  },
};

export const paletteNodeTypes: StudioNodeType[] = [
  'trigger',
  'aiAgent',
  'condition',
  'transform',
  'httpRequest',
  'database',
  'robotAction',
  'output',
  'llmModel',
  'memory',
  'tool',
];

export function createGraphNode(
  type: StudioNodeType,
  position: { x: number; y: number },
  overrides: Partial<WorkflowGraphNode> = {},
): WorkflowGraphNode {
  const definition = nodeRegistry[type];
  return {
    id: `node_${randomId().slice(0, 8)}`,
    type,
    name: definition.label,
    description: definition.description,
    position,
    ports: definition.ports.map((item) => ({ ...item })),
    config: { ...definition.config },
    ...overrides,
  };
}
