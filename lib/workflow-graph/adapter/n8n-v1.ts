/**
 * Graph → n8n 编译器（Adapter v1）。
 *
 * 三条硬约束，全部由测试守住：
 *  1. **确定性**：同一份 Graph + 同一个版本号，重复编译得到逐字节一致的 JSON
 *     和同一个 hash。节点 id 由 `workflowId|version|internalNodeId|role` 派生，
 *     产物里没有任何时间戳或随机值。
 *  2. **去凭据**：产物里绝不出现 apiKey / Authorization / credentials。
 *     config 走**白名单**进入 n8n parameters，密钥字段在结构上就进不来；
 *     需要凭据的节点只把引用名记进 `requiredCredentialRefs`，由运维在克隆环境挂载。
 *  3. **不静默丢失**：不支持的节点类型、缺失的必填配置都是 error，直接拒绝编译并
 *     返回 `workflow: null`（不产出任何半成品）。
 */
import {
  canonicalJson,
  hashGraphContent,
  sha256Hex,
} from '@/lib/workflow-graph/hash';
import { findProvider } from '@/lib/llm/providers';
import { findCredentialMaterial } from '@/lib/workflow-graph/payload';
import type {
  WorkflowGraphEdge,
  WorkflowGraphNode,
  WorkflowGraphV1,
} from '@/lib/workflow-graph/types';
import { hasErrors, validateGraph } from '@/lib/workflow-graph/validate';
import { bindingGuardCode, bindingParameters, RUNTIME_SOURCE } from './runtime-gate';
import type {
  AdapterIssue,
  CompileOptions,
  CompileResult,
  CompiledNodeBinding,
  N8nConnectionTarget,
  N8nConnections,
  N8nNode,
  N8nWorkflow,
} from './types';

export const ADAPTER_ID = 'n8n-v1';
export const ADAPTER_VERSION = '1.2.0';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

type BuildContext = {
  workflowId: string;
  version: number;
  webhookPath: string;
  /** Adapter 生成的输入归一节点名；AI 子节点用它取 sessionId。 */
  triggerDataName: string | null;
  node: WorkflowGraphNode;
};

type BuildSuccess = {
  parameters: Record<string, unknown>;
  credentialRefs?: string[];
  warnings?: string[];
  nodeFields?: Pick<N8nNode, 'onError'>;
};

type BuildResult = BuildSuccess | { error: string };

type NodeMapping = {
  /** n8n 节点类型。 */
  type: string;
  typeVersion: number;
  /** 业务主节点的 role；Adapter 还可以为 Trigger / Output 生成带 role 的边界节点。 */
  role: string;
  /** 允许写进 n8n parameters 的 config 键（白名单）。 */
  allowedConfig: string[];
  /** 明确"故意不翻译"的键：既不进产物，也不报警告。 */
  ignoredConfig: string[];
  build: (input: BuildContext) => BuildResult;
};

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asPositiveInt(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(value)));
}

function asMethod(value: unknown, fallback: string): string | null {
  const method = asString(value).toUpperCase();
  if (!method) return fallback;
  return HTTP_METHODS.includes(method) ? method : null;
}

function sanitizeId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Memory 在 Graph 里兼容历史 n8n 表达式，但编译产物不能盲信其中的节点名。
 * 这里只抽取安全的字段路径，节点引用由 Adapter 按发布版本重新生成。
 */
function sessionFieldPath(value: unknown): string | null {
  const raw = asString(value);
  if (!raw) return 'sessionId';
  const expression = raw
    .replace(/^=\{\{\s*/, '')
    .replace(/\s*\}\}$/, '')
    .trim();
  const direct = expression.match(
    /^(?:\$json\.)?([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)$/,
  )?.[1];
  const referenced = expression.match(
    /\.(?:item|first\(\))\.json\.([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*$/,
  )?.[1];
  const path = direct ?? referenced;
  if (!path) return null;
  return path.startsWith('body.') ? path.slice('body.'.length) : path;
}

function inputNormalizerCode(workflowId: string): string {
  return [
    '// Urtoris Adapter v1.1 输入归一：Webhook body 展平后才进入业务节点。',
    'const item = $input.first().json || {};',
    "const body = item.body && typeof item.body === 'object' && !Array.isArray(item.body) ? item.body : item;",
    "const headers = item.headers && typeof item.headers === 'object' ? item.headers : {};",
    "const context = body.context && typeof body.context === 'object' && !Array.isArray(body.context) ? body.context : {};",
    "const input = context.input && typeof context.input === 'object' && !Array.isArray(context.input) ? context.input : {};",
    "const requestId = typeof body.requestId === 'string' && body.requestId ? body.requestId : (headers['x-urtoris-request-id'] || null);",
    "const sessionId = typeof body.sessionId === 'string' && body.sessionId ? body.sessionId : (headers['x-urtoris-session-id'] || null);",
    "const question = body.question !== undefined ? body.question : (body.message !== undefined ? body.message : '');",
    'if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 80 || requestId.trim().toLowerCase() === "unknown") throw new Error("VALIDATION_ERROR: requestId required");',
    'if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 80) throw new Error("VALIDATION_ERROR: sessionId required");',
    'if (body.workflowId && body.workflowId !== ' + JSON.stringify(workflowId) + ') throw new Error("VALIDATION_ERROR: workflowId mismatch");',
    'return [{ json: Object.assign({}, body, {',
    '  workflowId: ' +
      JSON.stringify(workflowId) +
      ',',
    '  requestId: requestId.trim(), sessionId: sessionId.trim(), question,',
    '  channel: body.channel !== undefined ? body.channel : (context.channel ?? input.channel ?? null),',
    '  urgency: body.urgency !== undefined ? body.urgency : (context.urgency ?? input.urgency ?? null),',
    '  __urtorisStartedAt: Date.now(),',
    '  __urtorisExecutionId: $execution && $execution.id != null ? String($execution.id) : null',
    '}) }];',
  ].join('\n');
}

function outputEnvelopeCode(input: {
  workflowId: string;
  triggerDataName: string;
  outputNode: WorkflowGraphNode;
  agentNames: string[];
  rulesAgentNames: string[];
}): string {
  return [
    '// Urtoris Adapter v1.1 输出归一：所有分支都返回 urtoris.v1 信封。',
    'const source = $input.first().json || {};',
    'const llmExecuted = ' + JSON.stringify(input.agentNames) + '.some(name => $(name).isExecuted);',
    'const rulesDegraded = ' + JSON.stringify(input.rulesAgentNames) + '.some(name => $(name).isExecuted);',
    "const root = $('" + input.triggerDataName + "').first().json || {};",
    'let data = source;',
    "if (typeof source.output === 'string') {",
    '  try { data = JSON.parse(source.output); }',
    '  catch (error) { data = { message: source.output }; }',
    '}',
    "if (!data || typeof data !== 'object' || Array.isArray(data)) data = { message: String(data ?? '') };",
    'const finishedAt = Date.now();',
    "const startedAt = typeof root.__urtorisStartedAt === 'number' ? root.__urtorisStartedAt : finishedAt;",
    'return [{ json: {',
    "  protocol: 'urtoris.v1', success: true,",
    "  requestId: typeof root.requestId === 'string' && root.requestId ? root.requestId : 'unknown',",
    "  engine: 'n8n',",
    '  workflow: ' + JSON.stringify(input.workflowId) + ',',
    "  mode: llmExecuted ? 'llm' : 'rules', degraded: rulesDegraded,",
    '  data: Object.assign({}, data, {',
    '    outputNodeId: ' + JSON.stringify(input.outputNode.id) + ',',
    '    outputNodeName: ' + JSON.stringify(input.outputNode.name),
    '  }),',
    '  error: null,',
    '  meta: {',
    '    executionId: root.__urtorisExecutionId || null,',
    '    sessionId: root.sessionId || null,',
    '    durationMs: Math.max(0, finishedAt - startedAt),',
    '    attempt: root.meta && Number.isInteger(root.meta.attempt) ? root.meta.attempt : 1,',
    '    startedAt, finishedAt',
    '  }',
    '} }];',
  ].join('\n');
}

const NODE_MAPPINGS: Partial<Record<WorkflowGraphNode['type'], NodeMapping>> = {
  trigger: {
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    role: 'primary',
    allowedConfig: ['trigger', 'authPolicy'],
    ignoredConfig: [],
    build: ({ node, webhookPath }) => {
      const trigger = asString(node.config.trigger) || 'webhook';
      if (trigger !== 'webhook') {
        return { error: `Trigger 只支持 webhook，当前是 ${trigger}。` };
      }
      const authPolicy = asString(node.config.authPolicy) || 'urtoris-token';
      const authentication = authPolicy === 'none' ? 'none' : 'headerAuth';
      return {
        parameters: {
          httpMethod: 'POST',
          path: webhookPath,
          responseMode: 'responseNode',
          authentication,
          options: {},
        },
        credentialRefs: authentication === 'headerAuth' ? ['headerAuth'] : [],
        warnings:
          authentication === 'headerAuth'
            ? [
                'Webhook 使用 Header Auth：产物不含凭据，导入克隆环境后必须手工挂载 Header Auth 凭证。',
              ]
            : [],
      };
    },
  },
  condition: {
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    role: 'primary',
    allowedConfig: ['expression'],
    ignoredConfig: [],
    build: ({ node }) => {
      const expression = asString(node.config.expression);
      if (!expression) {
        return {
          error:
            'Condition 需要 config.expression（n8n 布尔表达式，例如 $json.priority === "high"）。',
        };
      }
      return {
        parameters: {
          conditions: {
            options: {
              caseSensitive: true,
              leftValue: '',
              typeValidation: 'loose',
              version: 2,
            },
            conditions: [
              {
                id: `cond-${sanitizeId(node.id)}`,
                leftValue: `={{ ${expression} }}`,
                rightValue: true,
                operator: {
                  type: 'boolean',
                  operation: 'true',
                  singleValue: true,
                },
              },
            ],
            combinator: 'and',
          },
          options: {},
        },
      };
    },
  },
  aiAgent: {
    type: '@n8n/n8n-nodes-langchain.agent',
    // n8n 2.38.6：AgentV3 version [3, 3.1]，defaultVersion 3.1。
    typeVersion: 3.1,
    role: 'primary',
    allowedConfig: [
      'instructions',
      'prompt',
      'maxIterations',
      'fallbackPolicy',
    ],
    ignoredConfig: ['strategy'],
    build: ({ node }) => {
      const instructions =
        asString(node.config.instructions) ||
        '理解请求，必要时调用工具，并返回结构化结果。';
      // v3.x：text = 用户提示词，systemMessage 才是系统指令（v2 的语义不同）。
      const prompt = asString(node.config.prompt) || '$json.question';
      const maxIterations = asPositiveInt(node.config.maxIterations, 10, 50);
      const fallbackPolicy = asString(node.config.fallbackPolicy) || 'error';
      if (fallbackPolicy !== 'error' && fallbackPolicy !== 'rules') {
        return {
          error: 'AI Agent 的 config.fallbackPolicy 只能是 error 或 rules。',
        };
      }
      return {
        parameters: {
          promptType: 'define',
          text: `={{ ${prompt} }}`,
          options: { systemMessage: instructions, maxIterations },
        },
        ...(fallbackPolicy === 'error'
          ? { nodeFields: { onError: 'stopWorkflow' as const } }
          : {
              warnings: [
                '规则备援只在 credentialRef=none 时启用；已配置模型的鉴权、网络或格式失败仍会停止工作流。',
              ],
            }),
      };
    },
  },
  llmModel: {
    type: '@n8n/n8n-nodes-langchain.lmChatOpenAi',
    // 1.3 新增 responsesApiEnabled（默认 true）。Qwen 走 DashScope 的
    // OpenAI 兼容端点，Responses API 不保证支持，所以显式关掉。
    typeVersion: 1.3,
    role: 'model',
    allowedConfig: ['provider', 'model', 'baseUrl', 'credentialRef'],
    ignoredConfig: ['allowBringYourOwnKey'],
    build: ({ node }) => {
      const rawProvider = asString(node.config.provider) || 'openai-compatible';
      const provider = findProvider(rawProvider);
      if (!provider) {
        return {
          error: `模型服务 ${rawProvider} 不在受支持的列表里（见 lib/llm/providers.ts）。`,
        };
      }
      const model = asString(node.config.model) || provider.defaultModel;
      if (!model && provider.requiresModel) {
        return { error: `${provider.label} 必须填写 config.model。` };
      }
      // n8n 侧只认 OpenAI 兼容节点，所以用该服务的 OpenAI 兼容端点：
      // 用户显式填的 baseUrl 优先，其次服务商预置的兼容端点；
      // OpenAI 官方本身就是默认端点，不用显式写 baseURL（保持既有产物不变）。
      const baseUrl =
        asString(node.config.baseUrl) || provider.openAiCompatibleBaseUrl || '';
      if (!baseUrl && provider.requiresBaseUrl) {
        return { error: `${provider.label} 必须填写 config.baseUrl。` };
      }
      return {
        parameters: {
          // 1.3 起 model 是 resourceLocator，不是纯字符串。
          model: {
            __rl: true,
            mode: 'list',
            value: model,
            cachedResultName: model,
          },
          responsesApiEnabled: false,
          options: baseUrl ? { baseURL: baseUrl } : {},
        },
        credentialRefs: node.config.credentialRef === 'none' ? [] : [asString(node.config.credentialRef) || 'openAiApi'],
        warnings: [
          node.config.credentialRef === 'none' ? '模型明确未配置；规则路径不调用模型或 Memory。' : 'Chat Model 凭证由运维按 credentialRef 挂载；产物不含 Key。',
          `模型服务：${provider.label}${baseUrl ? `（Base URL: ${baseUrl}）` : ''}；换服务商只需改 Graph 里的 provider / model。`,
        ],
      };
    },
  },
  memory: {
    type: '@n8n/n8n-nodes-langchain.memoryBufferWindow',
    typeVersion: 1.4,
    role: 'memory',
    allowedConfig: ['maxTurns', 'sessionKey'],
    ignoredConfig: ['provider'],
    build: ({ node, triggerDataName }) => {
      const maxTurns = asPositiveInt(node.config.maxTurns, 12, 50);
      // n8n 的 AI 子节点**不共享主前驱的 item 上下文**（Agent.node.js 的
      // builderHint 明确写了这一点），所以会话键显式引用 Trigger 节点，
      // 而不是裸用 `$json.sessionId`。
      const sessionPath = sessionFieldPath(node.config.sessionKey);
      if (!sessionPath) {
        return {
          error:
            'Memory 的 config.sessionKey 只能是字段路径或可识别的 $json / 节点引用表达式。',
        };
      }
      const sessionKey = triggerDataName
        ? `={{ $('${triggerDataName}').first().json.${sessionPath} }}`
        : `={{ $json.${sessionPath} }}`;
      return {
        parameters: {
          sessionIdType: 'customKey',
          sessionKey,
          contextWindowLength: maxTurns,
        },
        warnings: [
          'Simple Memory 用 Trigger 的 sessionId 做会话分区：子节点表达式上下文必须在克隆环境实测确认。',
        ],
      };
    },
  },
  tool: {
    type: '@n8n/n8n-nodes-langchain.toolHttpRequest',
    // 实测（n8n-nodes-langchain@2.38.2）版本表只有 [1, 1.1]；
    // 仓库蓝图里的 4.2 是 httpRequest 的版本号，属于错误数据。
    typeVersion: 1.1,
    role: 'tool',
    allowedConfig: ['implementation', 'url', 'method', 'description'],
    ignoredConfig: ['timeoutMs', 'confirmation'],
    build: ({ node }) => {
      const implementation = asString(node.config.implementation) || 'http';
      if (implementation !== 'http') {
        return {
          error: `Tool 只支持 HTTP 实现，当前是 ${implementation}（机器人能力请用 Robot Action 节点）。`,
        };
      }
      const url = asString(node.config.url);
      if (!url) return { error: 'HTTP Tool 需要 config.url。' };
      const method = asMethod(node.config.method, 'GET');
      if (!method)
        return { error: 'HTTP Tool 的 config.method 不是合法的 HTTP 方法。' };
      const description =
        asString(node.config.description) || node.description || node.name;
      return {
        parameters: { toolDescription: description, url, method, options: {} },
      };
    },
  },
  httpRequest: {
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    role: 'primary',
    allowedConfig: ['method', 'url', 'timeoutMs'],
    ignoredConfig: [],
    build: ({ node }) => {
      const url = asString(node.config.url);
      if (!url) return { error: 'HTTP Request 需要 config.url。' };
      const method = asMethod(node.config.method, 'POST');
      if (!method) {
        return {
          error: 'HTTP Request 的 config.method 不是合法的 HTTP 方法。',
        };
      }
      const timeout = asPositiveInt(node.config.timeoutMs, 15000, 120000);
      return { parameters: { method, url, options: { timeout } } };
    },
  },
  robotAction: {
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    role: 'primary',
    allowedConfig: ['action', 'endpoint', 'timeoutMs'],
    ignoredConfig: ['confirmation'],
    build: ({ node }) => {
      const endpoint = asString(node.config.endpoint);
      if (!endpoint) {
        return {
          error: 'Robot Action 需要 config.endpoint（机器人 HTTP 指令端点）。',
        };
      }
      const action = asString(node.config.action) || 'dispatch';
      const timeout = asPositiveInt(node.config.timeoutMs, 15000, 120000);
      return {
        parameters: {
          method: 'POST',
          url: endpoint,
          sendBody: true,
          specifyBody: 'json',
          jsonBody: JSON.stringify({ action }),
          options: { timeout },
        },
        warnings: [
          `Robot Action 按 HTTP 指令编译（action=${action}）：请先在机器人模拟器上确认指令语义。`,
        ],
      };
    },
  },
  output: {
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.5,
    role: 'primary',
    allowedConfig: [],
    ignoredConfig: ['envelope'],
    build: () => ({
      parameters: { respondWith: 'firstIncomingItem', options: {} },
    }),
  },
};

/** 连接类型（Graph）→ n8n 的 AI 子连接名。 */
const RESOURCE_CONNECTIONS: Record<string, string> = {
  model: 'ai_languageModel',
  memory: 'ai_memory',
  tool: 'ai_tool',
};

/** n8n node id：UUID 形状、内容确定，便于出问题时从 id 反推来源。 */
async function deterministicNodeId(seed: string): Promise<string> {
  const hex = await sha256Hex(seed);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

function externalNodeName(internalNodeId: string, role: string): string {
  return `U::${internalNodeId}::${role}`;
}

function defaultWebhookPath(workflowId: string): string {
  const slug = workflowId
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `urtoris/${slug || 'graph'}`;
}

/** 只把白名单里的 config 键带进产物，并报告被丢弃的"意外"配置。 */
function inspectConfig(
  node: WorkflowGraphNode,
  mapping: NodeMapping,
): string[] {
  const warnings: string[] = [];
  const known = new Set([...mapping.allowedConfig, ...mapping.ignoredConfig]);
  for (const key of Object.keys(node.config)) {
    if (known.has(key)) continue;
    const value = node.config[key];
    if (value === undefined || value === null || value === '') continue;
    warnings.push(
      `${node.name} 的 config.${key} 没有对应的 n8n 参数，已保留在 Graph 草稿中但不会进入产物。`,
    );
  }
  return warnings;
}

/**
 * 编译 Graph。任何 error 都会让整个编译失败并返回 `workflow: null`。
 */
export async function compileGraphToN8n(
  graph: WorkflowGraphV1,
  options: CompileOptions,
): Promise<CompileResult> {
  const graphHash = await hashGraphContent(graph);
  const issues: AdapterIssue[] = [];
  const credentialRefs = new Set<string>();

  for (const issue of validateGraph(graph)) {
    issues.push({
      level: issue.level,
      message: issue.message,
      nodeId: issue.nodeId,
    });
  }

  const unsupported = graph.nodes.filter((node) => !NODE_MAPPINGS[node.type]);
  for (const node of unsupported) {
    issues.push({
      level: 'error',
      message: `不支持的节点类型 ${node.type}（${node.name}）：Adapter v1 不能编译它，也不会静默丢弃。`,
      nodeId: node.id,
    });
  }

  const webhookPath =
    options.webhookPath ?? defaultWebhookPath(options.workflowId);
  const entryNode = graph.nodes.find((node) =>
    graph.entryNodeIds.includes(node.id),
  );
  const triggerDataName =
    entryNode?.type === 'trigger'
      ? externalNodeName(entryNode.id, 'input')
      : null;
  if (graph.entryNodeIds.length !== 1 || entryNode?.type !== 'trigger' ||
      graph.nodes.filter((node) => node.type === 'trigger').length !== 1 ||
      graph.nodes.some((node) => node.disabled)) {
    issues.push({ level: 'error', message: 'Runtime Adapter requires one enabled Webhook entry and no disabled nodes (binding cannot be bypassed).' });
  }
  const nodes: N8nNode[] = [];
  // Explicit no-key configuration is part of the immutable Graph, never inferred
  // from a provider error. Missing mounts for a declared reference still fail.
  const noModelAgents = new Set(graph.nodes.filter((node) => node.type === 'aiAgent' &&
    graph.edges.some((edge) => edge.kind === 'model' && edge.source.nodeId === node.id &&
      graph.nodes.find((candidate) => candidate.id === edge.target.nodeId)?.config.credentialRef === 'none')).map((node) => node.id));
  for (const node of graph.nodes.filter((node) => noModelAgents.has(node.id))) {
    if (node.config.fallbackPolicy !== 'rules') issues.push({ level: 'error', nodeId: node.id,
      message: 'credentialRef=none requires explicit fallbackPolicy=rules; an unconfigured model cannot be reported as LLM success.' });
  }
  const bindings: CompiledNodeBinding[] = [];
  const primaryByInternal = new Map<string, string>();
  const inputByInternal = new Map<string, string>();
  const outputByInternal = new Map<string, string>();
  const adapterConnections: Array<{
    owner: string;
    target: string;
    type: string;
    outputIndex: number;
  }> = [];

  const pushCompiledNode = async (input: {
    internalNode: WorkflowGraphNode;
    role: string;
    type: string;
    typeVersion: number;
    parameters: Record<string, unknown>;
    position: [number, number];
    notes: string;
    disabled?: boolean;
    nodeFields?: Pick<N8nNode, 'onError'>;
  }) => {
    const externalId = await deterministicNodeId(
      `${options.workflowId}|${options.version}|${input.internalNode.id}|${input.role}`,
    );
    const externalName = externalNodeName(input.internalNode.id, input.role);
    bindings.push({
      internalNodeId: input.internalNode.id,
      externalNodeId: externalId,
      externalNodeName: externalName,
      role: input.role,
    });
    nodes.push({
      parameters: input.parameters,
      id: externalId,
      name: externalName,
      type: input.type,
      typeVersion: input.typeVersion,
      ...(input.type === 'n8n-nodes-base.webhook' ? { webhookId: externalId } : {}),
      position: input.position,
      notes: input.notes.slice(0, 240),
      ...(input.disabled ? { disabled: true } : {}),
      ...input.nodeFields,
    });
    return externalName;
  };

  for (const node of graph.nodes) {
    const mapping: NodeMapping | undefined = noModelAgents.has(node.id) ? {
      ...NODE_MAPPINGS.aiAgent!, type: 'n8n-nodes-base.code', typeVersion: 2,
      build: () => ({ parameters: { mode: 'runOnceForAllItems', language: 'javaScript',
        jsCode: 'return [{ json: { message: "未配置模型，已按规则接收请求。", reason: "LLM_NOT_CONFIGURED", question: $input.first().json.question } }];' } }),
    } : NODE_MAPPINGS[node.type];
    if (!mapping) continue;

    const result = mapping.build({
      node,
      workflowId: options.workflowId,
      version: options.version,
      webhookPath,
      triggerDataName,
    });
    if ('error' in result) {
      issues.push({
        level: 'error',
        message: `${node.name}：${result.error}`,
        nodeId: node.id,
      });
      continue;
    }

    issues.push(
      ...inspectConfig(node, mapping).map((message) => ({
        level: 'warning' as const,
        message,
        nodeId: node.id,
      })),
    );

    for (const ref of result.credentialRefs ?? []) credentialRefs.add(ref);
    for (const warning of result.warnings ?? []) {
      issues.push({
        level: 'warning',
        message: `${node.name}：${warning}`,
        nodeId: node.id,
      });
    }

    const externalName = await pushCompiledNode({
      internalNode: node,
      role: mapping.role,
      type: mapping.type,
      typeVersion: mapping.typeVersion,
      parameters: result.parameters,
      position: [Math.round(node.position.x), Math.round(node.position.y)],
      notes: `${node.name} · ${node.description}`.slice(0, 240),
      disabled: node.disabled,
      nodeFields: result.nodeFields,
    });
    primaryByInternal.set(node.id, externalName);
    inputByInternal.set(node.id, externalName);
    outputByInternal.set(node.id, externalName);

    if (node.type === 'trigger') {
      const normalizedName = await pushCompiledNode({
        internalNode: node,
        role: 'input',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: inputNormalizerCode(options.workflowId),
        },
        position: [
          Math.round(node.position.x + 220),
          Math.round(node.position.y + 150),
        ],
        notes: `${node.name} · 展平 Webhook body，建立稳定的输入字段。`,
        disabled: node.disabled,
      });
      credentialRefs.add('urtorisEventsHeaderAuth');
      const bindName = await pushCompiledNode({
        internalNode: node, role: 'execution-bound',
        type: 'n8n-nodes-base.httpRequest', typeVersion: 4.2,
        parameters: bindingParameters({ workflowId: options.workflowId, version: options.version, triggerName: externalName }),
        position: [Math.round(node.position.x + 440), Math.round(node.position.y + 150)],
        notes: 'credentialRef: urtorisEventsHeaderAuth; clone only; synchronous execution.bound barrier.',
        nodeFields: { onError: 'stopWorkflow' },
      });
      const guardName = await pushCompiledNode({
        internalNode: node, role: 'binding-guard',
        type: 'n8n-nodes-base.code', typeVersion: 2,
        parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode: bindingGuardCode(normalizedName) },
        position: [Math.round(node.position.x + 660), Math.round(node.position.y + 150)],
        notes: 'Only HTTP 200 and ok=true, bound=true permit business execution.',
        nodeFields: { onError: 'stopWorkflow' },
      });
      outputByInternal.set(node.id, guardName);
      adapterConnections.push(
        { owner: normalizedName, target: bindName, type: 'main', outputIndex: 0 },
        { owner: bindName, target: guardName, type: 'main', outputIndex: 0 },
      );
      adapterConnections.push({
        owner: externalName,
        target: normalizedName,
        type: 'main',
        outputIndex: 0,
      });
    }

    if (node.type === 'output' && triggerDataName) {
      const envelopeName = await pushCompiledNode({
        internalNode: node,
        role: 'envelope',
        type: 'n8n-nodes-base.code',
        typeVersion: 2,
        parameters: {
          mode: 'runOnceForAllItems',
          language: 'javaScript',
          jsCode: outputEnvelopeCode({
            workflowId: options.workflowId,
            triggerDataName,
            outputNode: node,
            agentNames: graph.nodes.filter((candidate) => candidate.type === 'aiAgent' && !noModelAgents.has(candidate.id)).map((candidate) => externalNodeName(candidate.id, 'primary')),
            rulesAgentNames: [...noModelAgents].map((id) => externalNodeName(id, 'primary')),
          }),
        },
        position: [
          Math.round(node.position.x - 220),
          Math.round(node.position.y + 150),
        ],
        notes: `${node.name} · 生成 urtoris.v1 成功信封。`,
        disabled: node.disabled,
      });
      inputByInternal.set(node.id, envelopeName);
      adapterConnections.push({
        owner: envelopeName,
        target: externalName,
        type: 'main',
        outputIndex: 0,
      });
    }
  }

  const connections = buildConnections(
    { ...graph, edges: graph.edges.filter((edge) => !RESOURCE_CONNECTIONS[edge.kind] || !noModelAgents.has(edge.source.nodeId)) },
    {
      primaryByInternal,
      inputByInternal,
      outputByInternal,
      externalNodeOrder: nodes.map((node) => node.name),
      adapterConnections,
    },
    issues,
  );

  if (hasErrors(issues)) {
    return {
      ok: false,
      adapter: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      workflow: null,
      bindings: [],
      compiledJson: null,
      compiledHash: null,
      graphHash,
      issues,
      requiredCredentialRefs: [...credentialRefs].sort(),
    };
  }

  const workflow: N8nWorkflow = {
    name: graph.name,
    nodes,
    connections,
    // 环境相关的绑定（errorWorkflow、凭证）刻意不写进产物：
    // 它们属于部署环境，不属于这份不可变快照。
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' },
    active: false,
    meta: {
      urtoris: {
        adapter: ADAPTER_ID,
        adapterVersion: ADAPTER_VERSION,
        workflowId: options.workflowId,
        version: options.version,
        graphHash,
        webhookPath,
        eventSource: RUNTIME_SOURCE,
        runtimeCanaryOnly: true,
        noModelRoutes: [...noModelAgents].map((id) => ({ agentName: externalNodeName(id, 'primary'),
          resourceNames: graph.edges.filter((edge) => RESOURCE_CONNECTIONS[edge.kind] && edge.source.nodeId === id)
            .map((edge) => primaryByInternal.get(edge.target.nodeId)!).sort() })),
      },
    },
  };

  // 最后一道自检：产物里不允许出现任何凭据形态的值或键。
  const credentialPath = findCredentialMaterial(workflow);
  if (credentialPath) {
    return {
      ok: false,
      adapter: ADAPTER_ID,
      adapterVersion: ADAPTER_VERSION,
      workflow: null,
      bindings: [],
      compiledJson: null,
      compiledHash: null,
      graphHash,
      issues: [
        ...issues,
        {
          level: 'error',
          message: `编译产物自检失败：在 ${credentialPath} 发现疑似凭据，已拒绝输出产物。`,
        },
      ],
      requiredCredentialRefs: [...credentialRefs].sort(),
    };
  }

  const compiledJson = canonicalJson(workflow);
  return {
    ok: true,
    adapter: ADAPTER_ID,
    adapterVersion: ADAPTER_VERSION,
    workflow,
    bindings,
    compiledJson,
    compiledHash: await sha256Hex(compiledJson),
    graphHash,
    issues,
    requiredCredentialRefs: [...credentialRefs].sort(),
  };
}

/**
 * 组装 n8n 的 connections 结构。
 *
 *  - main / branch：连在**源节点**上；`if` 的 true=false 分支对应输出索引 0/1。
 *  - model / memory / tool：连在**子节点**上、指向 Agent（n8n 的 AI 子连接方向）。
 */
function buildConnections(
  graph: WorkflowGraphV1,
  mapping: {
    primaryByInternal: Map<string, string>;
    inputByInternal: Map<string, string>;
    outputByInternal: Map<string, string>;
    externalNodeOrder: string[];
    adapterConnections: Array<{
      owner: string;
      target: string;
      type: string;
      outputIndex: number;
    }>;
  },
  issues: AdapterIssue[],
): N8nConnections {
  const ownerTargets = new Map<string, Map<string, Map<number, Set<string>>>>();

  const addTarget = (
    owner: string,
    connectionType: string,
    outputIndex: number,
    target: string,
  ) => {
    const byType =
      ownerTargets.get(owner) ?? new Map<string, Map<number, Set<string>>>();
    const byIndex =
      byType.get(connectionType) ?? new Map<number, Set<string>>();
    const targets = byIndex.get(outputIndex) ?? new Set<string>();
    targets.add(target);
    byIndex.set(outputIndex, targets);
    byType.set(connectionType, byIndex);
    ownerTargets.set(owner, byType);
  };

  for (const connection of mapping.adapterConnections) {
    addTarget(
      connection.owner,
      connection.type,
      connection.outputIndex,
      connection.target,
    );
  }

  for (const edge of graph.edges) {
    const resourceType = RESOURCE_CONNECTIONS[edge.kind];
    if (resourceType) {
      const owner = mapping.primaryByInternal.get(edge.target.nodeId);
      const agent = mapping.primaryByInternal.get(edge.source.nodeId);
      if (!owner || !agent) continue;
      addTarget(owner, resourceType, 0, agent);
      continue;
    }
    if (edge.kind !== 'main' && edge.kind !== 'branch') continue;

    const owner = mapping.outputByInternal.get(edge.source.nodeId);
    const target = mapping.inputByInternal.get(edge.target.nodeId);
    if (!owner || !target) {
      issues.push({
        level: 'error',
        message: `连接 ${edge.id} 指向了未参与编译的节点。`,
        nodeId: edge.source.nodeId,
      });
      continue;
    }
    const outputIndex = edge.source.portId === 'branch.false' ? 1 : 0;
    addTarget(owner, 'main', outputIndex, target);
  }

  // 按节点顺序输出键，目标按名字排序：与 edges 的书写顺序无关，保证哈希稳定。
  const connections: N8nConnections = {};
  for (const externalName of mapping.externalNodeOrder) {
    const byType = ownerTargets.get(externalName);
    if (!byType) continue;
    const entry: Record<string, N8nConnectionTarget[][]> = {};
    for (const [connectionType, byIndex] of byType) {
      const maxIndex = Math.max(...byIndex.keys());
      const outputs: N8nConnectionTarget[][] = [];
      for (let index = 0; index <= maxIndex; index += 1) {
        const targets = [...(byIndex.get(index) ?? [])].sort();
        outputs.push(
          targets.map((name) => ({
            node: name,
            type: connectionType,
            index: 0,
          })),
        );
      }
      entry[connectionType] = outputs;
    }
    connections[externalName] = entry;
  }

  return connections;
}

/** 供 API 层复用的统计信息。 */
export function compileStats(graph: WorkflowGraphV1, result: CompileResult) {
  return {
    internalNodes: graph.nodes.length,
    externalNodes: result.workflow?.nodes.length ?? 0,
    connections: result.workflow
      ? Object.values(result.workflow.connections).reduce(
          (total, entry) =>
            total +
            Object.values(entry).reduce(
              (sum, outputs) =>
                sum +
                outputs.reduce((count, targets) => count + targets.length, 0),
              0,
            ),
          0,
        )
      : 0,
    unsupportedNodes: graph.nodes.filter((node) => !NODE_MAPPINGS[node.type])
      .length,
  };
}

export function isNodeTypeSupported(type: WorkflowGraphNode['type']): boolean {
  return Boolean(NODE_MAPPINGS[type]);
}

export const supportedNodeTypes = Object.keys(
  NODE_MAPPINGS,
) as WorkflowGraphNode['type'][];

/** 供 UI/文档展示：连接类型到 AI 子连接名的映射。 */
export function resourceConnectionName(kind: WorkflowGraphEdge['kind']) {
  return RESOURCE_CONNECTIONS[kind] ?? null;
}
