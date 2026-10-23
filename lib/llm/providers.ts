/**
 * 模型服务注册表（前后端共用，纯数据，不含任何凭据）。
 *
 * 一个 provider 描述三件事：
 *  1. **怎么调**：`protocol` 决定站点直连时用哪种请求/响应格式；
 *  2. **调哪里**：`defaultBaseUrl`（原生协议端点）与 `openAiCompatibleBaseUrl`
 *     （编译到 n8n 时用的 OpenAI 兼容端点，Adapter v1 只产出已验证的
 *     `lmChatOpenAi` 节点，所以这里必须给兼容端点，或者留 null 让用户自填）；
 *  3. **可选什么模型**：`models` 只是下拉建议，用户始终可以手填厂商新出的模型名。
 *
 * 这个文件会被浏览器直接 import，**不允许** import 任何服务端模块，
 * 也不允许写入 API Key、token、账号密码。
 */

/** 站点直连模型时使用的协议族。 */
export type LlmProtocol =
  | 'openai-chat'
  | 'anthropic-messages'
  | 'google-generate-content';

/** 用户可选的推理强度；auto 表示完全交给模型服务默认策略。 */
export const LLM_REASONING_EFFORTS = ['auto', 'low', 'medium', 'high'] as const;

export type LlmReasoningEffort = (typeof LLM_REASONING_EFFORTS)[number];

/** 不同厂商表达“推理强度”的协议方式。 */
export type LlmReasoningMode =
  | 'openai-effort'
  | 'qwen-thinking'
  | 'anthropic-thinking'
  | 'gemini-thinking'
  | 'model-only';

export function isLlmReasoningEffort(
  value: unknown,
): value is LlmReasoningEffort {
  return (
    typeof value === 'string' &&
    (LLM_REASONING_EFFORTS as readonly string[]).includes(value)
  );
}

export type LlmProvider = {
  id: string;
  /** 面向用户的名称。 */
  label: string;
  /** 厂商，用于分组展示。 */
  vendor: string;
  protocol: LlmProtocol;
  /** 原生协议端点（不带结尾斜杠）。 */
  defaultBaseUrl: string;
  /** 编译到 n8n 用的 OpenAI 兼容端点；null 表示必须由用户填写。 */
  openAiCompatibleBaseUrl: string | null;
  models: readonly string[];
  defaultModel: string;
  /** 没有默认端点时必须由用户填写（自定义服务）。 */
  requiresBaseUrl: boolean;
  /** 没有默认模型时必须由用户填写。 */
  requiresModel: boolean;
  keyRequired: boolean;
  /** 输入框提示语，只描述格式，不放真实凭据。 */
  keyHint: string;
  docsUrl: string;
  /** 推理强度如何映射到厂商 API；model-only 表示只能通过模型名选择。 */
  reasoningMode: LlmReasoningMode;
  reasoningNote: string;
  note?: string;
};

export const llmProviders: readonly LlmProvider[] = [
  {
    id: 'qwen',
    label: '通义千问 · 阿里云百炼',
    vendor: '阿里云',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    openAiCompatibleBaseUrl:
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    defaultModel: 'qwen-plus',
    requiresBaseUrl: false,
    requiresModel: false,
    keyRequired: true,
    keyHint: 'DashScope API Key（sk- 开头）',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/',
    reasoningMode: 'qwen-thinking',
    reasoningNote: '低 / 中 / 高会映射为千问 thinking budget。',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    vendor: 'OpenAI',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    openAiCompatibleBaseUrl: null,
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-4.1-mini'],
    defaultModel: 'gpt-4o-mini',
    requiresBaseUrl: false,
    requiresModel: false,
    keyRequired: true,
    keyHint: 'OpenAI API Key（sk- 开头）',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    reasoningMode: 'openai-effort',
    reasoningNote: '支持时会把强度作为 reasoning_effort 发送。',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    vendor: 'DeepSeek',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    openAiCompatibleBaseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    requiresBaseUrl: false,
    requiresModel: false,
    keyRequired: true,
    keyHint: 'DeepSeek API Key',
    docsUrl: 'https://api-docs.deepseek.com/',
    reasoningMode: 'model-only',
    reasoningNote:
      'DeepSeek 通过模型名决定：需要推理请选择 deepseek-reasoner。',
  },
  {
    id: 'moonshot',
    label: 'Kimi · 月之暗面',
    vendor: '月之暗面',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.moonshot.cn/v1',
    openAiCompatibleBaseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    defaultModel: 'moonshot-v1-8k',
    requiresBaseUrl: false,
    requiresModel: false,
    keyRequired: true,
    keyHint: 'Moonshot API Key',
    docsUrl: 'https://platform.moonshot.cn/docs/api/chat',
    reasoningMode: 'model-only',
    reasoningNote: '该服务的推理能力由所选模型决定。',
    note: 'Kimi 的新模型名请以控制台为准，这里只放长期可用的几个。',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    vendor: '智谱 AI',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    openAiCompatibleBaseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    defaultModel: 'glm-4-flash',
    requiresBaseUrl: false,
    requiresModel: false,
    keyRequired: true,
    keyHint: '智谱 API Key',
    docsUrl: 'https://docs.bigmodel.cn/',
    reasoningMode: 'model-only',
    reasoningNote: '该服务的推理能力由所选模型决定。',
  },
  {
    id: 'anthropic',
    label: 'Claude · Anthropic',
    vendor: 'Anthropic',
    protocol: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    // Anthropic 官方提供 OpenAI SDK 兼容层，n8n 侧仍用已验证的 OpenAI 节点。
    openAiCompatibleBaseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-3-5-haiku-latest'],
    defaultModel: 'claude-sonnet-4-5',
    requiresBaseUrl: false,
    requiresModel: false,
    keyRequired: true,
    keyHint: 'Anthropic API Key（sk-ant- 开头）',
    docsUrl: 'https://docs.anthropic.com/en/api/messages',
    reasoningMode: 'anthropic-thinking',
    reasoningNote: '低 / 中 / 高会映射为 Claude thinking budget。',
  },
  {
    id: 'gemini',
    label: 'Gemini · Google',
    vendor: 'Google',
    protocol: 'google-generate-content',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com',
    openAiCompatibleBaseUrl:
      'https://generativelanguage.googleapis.com/v1beta/openai/',
    models: ['gemini-2.5-flash', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    defaultModel: 'gemini-2.5-flash',
    requiresBaseUrl: false,
    requiresModel: false,
    keyRequired: true,
    keyHint: 'Google AI Studio API Key',
    docsUrl: 'https://ai.google.dev/api/generate-content',
    reasoningMode: 'gemini-thinking',
    reasoningNote: '低 / 中 / 高会映射为 Gemini thinking budget。',
  },
  {
    id: 'ollama',
    label: 'Ollama（本机模型）',
    vendor: '本地',
    protocol: 'openai-chat',
    defaultBaseUrl: 'http://127.0.0.1:11434/v1',
    openAiCompatibleBaseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'deepseek-r1:7b'],
    defaultModel: 'qwen2.5:7b',
    requiresBaseUrl: false,
    requiresModel: false,
    keyRequired: false,
    keyHint: '本机模型通常不需要 Key，留空即可',
    docsUrl: 'https://github.com/ollama/ollama/blob/main/docs/openai.md',
    reasoningMode: 'model-only',
    reasoningNote: '本机服务的推理能力由模型名与服务端配置决定。',
    note: '只在 https 之外放行本机地址；换成别的内网地址请用「自定义」。',
  },
  {
    id: 'custom',
    label: '自定义（OpenAI 兼容）',
    vendor: '其他',
    protocol: 'openai-chat',
    defaultBaseUrl: '',
    openAiCompatibleBaseUrl: null,
    models: [],
    defaultModel: '',
    requiresBaseUrl: true,
    requiresModel: true,
    keyRequired: true,
    keyHint: '该服务商签发的 Key',
    docsUrl: 'https://platform.openai.com/docs/api-reference/chat',
    reasoningMode: 'openai-effort',
    reasoningNote: '会按 OpenAI 兼容格式发送；若网关不支持请选“自动”。',
    note: '自建网关、代理、聚合平台都走这条：Base URL 必填，模型名手填。',
  },
] as const;

export const DEFAULT_LLM_PROVIDER_ID = 'qwen';

/**
 * 历史 Graph 里写的 `openai-compatible`：没有自带 Base URL 时等价于 OpenAI 官方端点，
 * 所以映射到 `openai` 而不是必须填地址的 `custom`（否则老草稿会突然编不过）。
 */
const providerAliases: Record<string, string> = {
  'openai-compatible': 'openai',
  openai_compatible: 'openai',
  dashscope: 'qwen',
  tongyi: 'qwen',
  kimi: 'moonshot',
  glm: 'zhipu',
  claude: 'anthropic',
  google: 'gemini',
};

export function findProvider(
  id: string | null | undefined,
): LlmProvider | null {
  if (typeof id !== 'string') return null;
  const normalized = normalizeProviderId(id);
  if (!normalized) return null;
  return llmProviders.find((provider) => provider.id === normalized) ?? null;
}

/** 认得的 provider id；认不出来返回 null（调用方必须显式报错，不许静默兜底）。 */
export function normalizeProviderId(
  id: string | null | undefined,
): string | null {
  if (typeof id !== 'string') return null;
  const value = id.trim().toLowerCase();
  if (!value) return null;
  const aliased = providerAliases[value] ?? value;
  return llmProviders.some((provider) => provider.id === aliased)
    ? aliased
    : null;
}

export function providerOrDefault(id: string | null | undefined): LlmProvider {
  return (
    findProvider(id) ??
    (llmProviders.find(
      (provider) => provider.id === DEFAULT_LLM_PROVIDER_ID,
    ) as LlmProvider)
  );
}

/**
 * 切换模型服务时要带上的默认值。
 * Key 不在这里——换服务商不该把用户已填的 Key 清掉，也不该替用户猜。
 */
export function providerDefaults(
  id: string,
): { id: string; baseUrl: string; model: string } | null {
  const provider = findProvider(id);
  if (!provider) return null;
  return {
    id: provider.id,
    baseUrl: provider.defaultBaseUrl,
    model: provider.defaultModel,
  };
}

/** 给 UI 用的轻量列表（不含任何密钥字段）。 */
export function providerOptions(): Array<{
  id: string;
  label: string;
  vendor: string;
  models: readonly string[];
  defaultModel: string;
  defaultBaseUrl: string;
  requiresBaseUrl: boolean;
  requiresModel: boolean;
  keyRequired: boolean;
  keyHint: string;
  reasoningMode: LlmReasoningMode;
  reasoningNote: string;
  note?: string;
}> {
  return llmProviders.map((provider) => ({
    id: provider.id,
    label: provider.label,
    vendor: provider.vendor,
    models: provider.models,
    defaultModel: provider.defaultModel,
    defaultBaseUrl: provider.defaultBaseUrl,
    requiresBaseUrl: provider.requiresBaseUrl,
    requiresModel: provider.requiresModel,
    keyRequired: provider.keyRequired,
    keyHint: provider.keyHint,
    reasoningMode: provider.reasoningMode,
    reasoningNote: provider.reasoningNote,
    ...(provider.note ? { note: provider.note } : {}),
  }));
}
