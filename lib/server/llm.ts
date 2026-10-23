import {
  DEFAULT_LLM_PROVIDER_ID,
  findProvider,
  providerOrDefault,
  type LlmProvider,
  type LlmReasoningEffort,
} from '@/lib/llm/providers';
import type { WorkflowRecord } from '@/lib/workflow-types';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type ChatModelRequest = {
  apiKey: string;
  /** 模型服务 id（见 `lib/llm/providers.ts`）；缺省用平台默认服务。 */
  provider?: string | null;
  /** 覆盖服务商默认端点；自定义服务商必填。 */
  baseUrl?: string;
  /** 覆盖服务商默认模型。 */
  model?: string;
  /** auto 不发送厂商特定参数；其余值仅在该 provider 支持时映射。 */
  reasoningEffort?: LlmReasoningEffort;
  messages: ChatMessage[];
  temperature?: number;
  timeoutMs?: number;
  maxTokens?: number;
};

export type ChatModelResult =
  | { ok: true; text: string; model: string }
  | {
      ok: false;
      error: string;
      status?: number;
      code:
        | 'LLM_NOT_CONFIGURED'
        | 'LLM_ERROR'
        | 'LLM_TIMEOUT'
        | 'NETWORK_ERROR'
        | 'RATE_LIMITED'
        | 'UPSTREAM_ERROR'
        | 'LLM_UNSUPPORTED_PROVIDER';
    };

const defaultProvider = providerOrDefault(DEFAULT_LLM_PROVIDER_ID);

/** 默认指向阿里云百炼（OpenAI 兼容），可被使用端覆盖。 */
export const DEFAULT_LLM_BASE_URL = defaultProvider.defaultBaseUrl;
export const DEFAULT_LLM_MODEL = defaultProvider.defaultModel;

export type LlmSelection = {
  providerId: string;
  providerLabel: string;
  baseUrl: string;
  model: string;
  /** 该服务是否必须要 Key（本机 Ollama 这类可以留空）。 */
  keyRequired: boolean;
};

/**
 * 解析「用户选了哪个模型服务」。
 *
 * 规则：显式指定的 provider 必须认得出来（认不出就报错，绝不静默换成默认服务）；
 * baseUrl / model 缺省时用该服务的默认值；自定义服务没有默认端点，必须用户填写。
 */
export function resolveLlmSelection(input: {
  provider?: string | null;
  baseUrl?: string | null;
  model?: string | null;
}):
  | { ok: true; selection: LlmSelection }
  | {
      ok: false;
      code: 'LLM_UNSUPPORTED_PROVIDER' | 'LLM_ERROR';
      error: string;
    } {
  const requested =
    typeof input.provider === 'string' ? input.provider.trim() : '';
  if (requested && !findProvider(requested)) {
    return {
      ok: false,
      code: 'LLM_UNSUPPORTED_PROVIDER',
      error: `不支持的模型服务：${requested}。`,
    };
  }

  const provider = providerOrDefault(requested);
  const baseUrl =
    (typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '') ||
    provider.defaultBaseUrl;
  const model =
    (typeof input.model === 'string' ? input.model.trim() : '') ||
    provider.defaultModel;

  if (!baseUrl) {
    return {
      ok: false,
      code: 'LLM_ERROR',
      error: `${provider.label} 没有默认端点，请填写 Base URL。`,
    };
  }
  if (!model) {
    return {
      ok: false,
      code: 'LLM_ERROR',
      error: `${provider.label} 没有默认模型，请填写模型名。`,
    };
  }

  return {
    ok: true,
    selection: {
      providerId: provider.id,
      providerLabel: provider.label,
      baseUrl,
      model,
      keyRequired: provider.keyRequired,
    },
  };
}

function trimTrailingSlash(value: string) {
  return value.trim().replace(/\/+$/, '');
}

function describeHttpError(status: number, raw: string) {
  const snippet = raw.slice(0, 300);
  if (status === 401 || status === 403) {
    return `模型服务拒绝了这把 API Key（HTTP ${status}）。请检查 Key 是否有效、是否与 Base URL 匹配。`;
  }
  if (status === 404) {
    return `模型服务找不到该模型或接口（HTTP 404）。请检查模型名与 Base URL。（${snippet}）`;
  }
  if (status === 429) {
    return '模型服务返回 429：请求过于频繁或额度已用尽，请稍后重试。';
  }
  return `模型服务返回 HTTP ${status}：${snippet}`;
}

function extractMessageContent(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const embeddedError = (payload as { error?: unknown }).error;
  if (embeddedError && typeof embeddedError === 'object') {
    const message = (embeddedError as { message?: unknown }).message;
    if (typeof message === 'string') return `__ERROR__${message}`;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0] as { message?: { content?: unknown } };
  const content = first?.message?.content;
  if (typeof content === 'string') return content;
  // Some providers return content as an array of parts.
  if (Array.isArray(content)) {
    const joined = content
      .map((part) =>
        part &&
        typeof part === 'object' &&
        typeof (part as { text?: unknown }).text === 'string'
          ? (part as { text: string }).text
          : '',
      )
      .join('');
    return joined || null;
  }
  return null;
}

function isLoopbackHost(hostname: string) {
  return (
    hostname === '127.0.0.1' ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

function resolveEndpoint(value: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return { error: 'Base URL 不是合法地址。' };
  }
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHost(url.hostname))
  ) {
    return {
      error: '出于安全考虑，Base URL 必须使用 https（本机地址除外）。',
    };
  }
  return { url };
}

type ProtocolRequest = {
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

type ProtocolPlan = ProtocolRequest & {
  /** 从响应 JSON 里取出正文；返回 null 表示结构不对。 */
  extract: (payload: unknown) => string | null;
};

const THINKING_BUDGETS: Record<Exclude<LlmReasoningEffort, 'auto'>, number> = {
  low: 2_048,
  medium: 8_192,
  high: 24_576,
};

function openAiReasoningBody(
  provider: LlmProvider,
  effort: LlmReasoningEffort,
): Record<string, unknown> {
  if (effort === 'auto' || provider.reasoningMode === 'model-only') return {};
  if (provider.reasoningMode === 'qwen-thinking') {
    return {
      enable_thinking: true,
      thinking_budget: THINKING_BUDGETS[effort],
    };
  }
  if (provider.reasoningMode === 'openai-effort') {
    return { reasoning_effort: effort };
  }
  return {};
}

function buildOpenAiChatPlan(input: {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  reasoningEffort: LlmReasoningEffort;
}): ProtocolPlan {
  return {
    endpoint: `${input.baseUrl}/chat/completions`,
    headers: {
      'Content-Type': 'application/json',
      ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
    },
    body: {
      model: input.model,
      messages: input.messages,
      ...(input.provider.reasoningMode === 'openai-effort' &&
      input.reasoningEffort !== 'auto'
        ? {}
        : { temperature: input.temperature }),
      ...openAiReasoningBody(input.provider, input.reasoningEffort),
    },
    extract: extractMessageContent,
  };
}

/** Anthropic Messages API：system 是顶层字段，鉴权走 x-api-key。 */
function buildAnthropicPlan(input: {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  maxTokens: number;
  reasoningEffort: LlmReasoningEffort;
}): ProtocolPlan {
  const system = input.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const turns = input.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: message.content,
    }));

  const thinkingBudget =
    input.reasoningEffort === 'auto'
      ? null
      : THINKING_BUDGETS[input.reasoningEffort];

  return {
    endpoint: input.baseUrl.endsWith('/v1')
      ? `${input.baseUrl}/messages`
      : `${input.baseUrl}/v1/messages`,
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': input.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: {
      model: input.model,
      max_tokens: thinkingBudget
        ? Math.max(input.maxTokens, thinkingBudget + 1_024)
        : input.maxTokens,
      ...(thinkingBudget
        ? { thinking: { type: 'enabled', budget_tokens: thinkingBudget } }
        : { temperature: input.temperature }),
      ...(system ? { system } : {}),
      messages: turns,
    },
    extract(payload) {
      const error = readEmbeddedError(payload);
      if (error) return `__ERROR__${error}`;
      if (!payload || typeof payload !== 'object') return null;
      const blocks = (payload as { content?: unknown }).content;
      if (!Array.isArray(blocks)) return null;
      const text = blocks
        .map((block) =>
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
            ? (block as { text: string }).text
            : '',
        )
        .join('');
      return text || null;
    },
  };
}

/** Gemini generateContent：鉴权走 x-goog-api-key，system 走 systemInstruction。 */
function buildGooglePlan(input: {
  provider: LlmProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  temperature: number;
  reasoningEffort: LlmReasoningEffort;
}): ProtocolPlan {
  const system = input.messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents = input.messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    }));

  return {
    endpoint: `${input.baseUrl}/v1beta/models/${encodeURIComponent(
      input.model,
    )}:generateContent`,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': input.apiKey,
    },
    body: {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: {
        temperature: input.temperature,
        ...(input.reasoningEffort === 'auto'
          ? {}
          : {
              thinkingConfig: {
                thinkingBudget: THINKING_BUDGETS[input.reasoningEffort],
              },
            }),
      },
    },
    extract(payload) {
      const error = readEmbeddedError(payload);
      if (error) return `__ERROR__${error}`;
      if (!payload || typeof payload !== 'object') return null;
      const blocked = (
        payload as { promptFeedback?: { blockReason?: unknown } }
      ).promptFeedback?.blockReason;
      if (typeof blocked === 'string' && blocked) {
        return `__ERROR__模型服务以 ${blocked} 拒绝了这次请求。`;
      }
      const candidates = (payload as { candidates?: unknown }).candidates;
      if (!Array.isArray(candidates) || candidates.length === 0) return null;
      const parts = (
        candidates[0] as { content?: { parts?: unknown } } | undefined
      )?.content?.parts;
      if (!Array.isArray(parts)) return null;
      const text = parts
        .map((part) =>
          part &&
          typeof part === 'object' &&
          typeof (part as { text?: unknown }).text === 'string'
            ? (part as { text: string }).text
            : '',
        )
        .join('');
      return text || null;
    },
  };
}

function readEmbeddedError(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const error = (payload as { error?: unknown }).error;
  if (!error) return null;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return null;
}

export async function callChatModel(
  request: ChatModelRequest,
): Promise<ChatModelResult> {
  const requestedProviderId = request.provider?.trim();
  if (requestedProviderId && !findProvider(requestedProviderId)) {
    return {
      ok: false,
      code: 'LLM_UNSUPPORTED_PROVIDER',
      error: `不支持的模型服务：${requestedProviderId}。请在模型服务列表里选择，或用自定义（OpenAI 兼容）填写 Base URL。`,
    };
  }

  const provider = providerOrDefault(request.provider);

  const apiKey = request.apiKey.trim();
  if (!apiKey && provider.keyRequired) {
    return {
      ok: false,
      code: 'LLM_NOT_CONFIGURED',
      error: `缺少 API Key：${provider.label} 需要 Key 才能调用。`,
    };
  }

  const baseUrl = trimTrailingSlash(
    request.baseUrl?.trim() || provider.defaultBaseUrl,
  );
  if (!baseUrl) {
    return {
      ok: false,
      code: 'LLM_ERROR',
      error: `缺少 Base URL：${provider.label} 没有默认端点，必须填写。`,
    };
  }

  const model = request.model?.trim() || provider.defaultModel;
  if (!model) {
    return {
      ok: false,
      code: 'LLM_ERROR',
      error: `缺少模型名：${provider.label} 没有默认模型，必须填写。`,
    };
  }

  const endpoint = resolveEndpoint(baseUrl);
  if ('error' in endpoint) {
    return { ok: false, code: 'LLM_ERROR', error: endpoint.error };
  }

  const planInput = {
    provider,
    baseUrl,
    apiKey,
    model,
    messages: request.messages,
    temperature: request.temperature ?? 0.3,
    maxTokens: request.maxTokens ?? 4096,
    reasoningEffort: request.reasoningEffort ?? 'auto',
  };
  const plan =
    provider.protocol === 'anthropic-messages'
      ? buildAnthropicPlan(planInput)
      : provider.protocol === 'google-generate-content'
        ? buildGooglePlan(planInput)
        : buildOpenAiChatPlan(planInput);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? 45_000,
  );

  try {
    const response = await fetch(plan.endpoint, {
      method: 'POST',
      headers: plan.headers,
      body: JSON.stringify(plan.body),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code:
          response.status === 429
            ? 'RATE_LIMITED'
            : response.status >= 500
              ? 'UPSTREAM_ERROR'
              : 'LLM_ERROR',
        error: describeHttpError(response.status, raw),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: '模型返回的内容不是合法 JSON。',
      };
    }

    const text = plan.extract(parsed);
    if (text?.startsWith('__ERROR__')) {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: `模型服务返回错误：${text.slice('__ERROR__'.length)}`,
      };
    }
    if (!text || !text.trim()) {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: `${provider.label} 没有返回任何文本内容（模型：${model}）。`,
      };
    }

    const reportedModel =
      parsed && typeof parsed === 'object'
        ? ((parsed as { model?: unknown }).model ??
          (parsed as { modelVersion?: unknown }).modelVersion)
        : undefined;

    return {
      ok: true,
      text: text.trim(),
      model: typeof reportedModel === 'string' ? reportedModel : model,
    };
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      return {
        ok: false,
        code: 'LLM_TIMEOUT',
        error: '模型请求超时，请重试或换用更快的模型。',
      };
    }
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      error: `无法连接模型服务（${provider.label}）：${cause instanceof Error ? cause.message : '未知网络错误'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export type ListAvailableModelsRequest = {
  apiKey: string;
  provider?: string | null;
  baseUrl?: string;
  timeoutMs?: number;
};

export type ListAvailableModelsResult =
  | {
      ok: true;
      models: string[];
      providerId: string;
      providerLabel: string;
    }
  | {
      ok: false;
      error: string;
      status?: number;
      code:
        | 'LLM_NOT_CONFIGURED'
        | 'LLM_ERROR'
        | 'LLM_TIMEOUT'
        | 'NETWORK_ERROR'
        | 'RATE_LIMITED'
        | 'UPSTREAM_ERROR'
        | 'LLM_UNSUPPORTED_PROVIDER';
    };

function modelListEndpoint(provider: LlmProvider, baseUrl: string): string {
  const normalizedBase = baseUrl
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/messages$/i, '')
    .replace(/\/models$/i, '');
  if (provider.protocol === 'anthropic-messages') {
    return normalizedBase.endsWith('/v1')
      ? `${normalizedBase}/models`
      : `${normalizedBase}/v1/models`;
  }
  if (provider.protocol === 'google-generate-content') {
    return normalizedBase.endsWith('/v1beta')
      ? `${normalizedBase}/models?pageSize=1000`
      : `${normalizedBase}/v1beta/models?pageSize=1000`;
  }
  return `${normalizedBase}/models`;
}

function extractAvailableModels(
  provider: LlmProvider,
  payload: unknown,
): string[] {
  if (!payload || typeof payload !== 'object') return [];
  const data = (payload as { data?: unknown }).data;
  const models = (payload as { models?: unknown }).models;
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(data)
      ? data
      : Array.isArray(models)
        ? models
        : [];
  const ids: string[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (
      provider.protocol === 'google-generate-content' &&
      typeof candidate === 'object'
    ) {
      const methods = (candidate as { supportedGenerationMethods?: unknown })
        .supportedGenerationMethods;
      if (
        Array.isArray(methods) &&
        !methods.some((method) => method === 'generateContent')
      ) {
        continue;
      }
    }
    const raw =
      typeof candidate === 'string'
        ? candidate
        : typeof candidate === 'object'
          ? ((candidate as { id?: unknown }).id ??
            (candidate as { name?: unknown }).name ??
            (candidate as { model?: unknown }).model ??
            (candidate as { model_id?: unknown }).model_id)
          : undefined;
    if (typeof raw !== 'string') continue;
    const id = raw.replace(/^models\//, '').trim();
    const hasControlCharacter = Array.from(id).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    });
    if (!id || id.length > 160 || hasControlCharacter) continue;
    ids.push(id);
  }
  return Array.from(new Set(ids)).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
}

/** 用用户自己的 Key 读取该 API 当前真正开放的模型，不保存凭据或响应。 */
export async function listAvailableModels(
  request: ListAvailableModelsRequest,
): Promise<ListAvailableModelsResult> {
  const requestedProviderId = request.provider?.trim();
  if (requestedProviderId && !findProvider(requestedProviderId)) {
    return {
      ok: false,
      code: 'LLM_UNSUPPORTED_PROVIDER',
      error: `不支持的模型服务：${requestedProviderId}。`,
    };
  }
  const provider = providerOrDefault(request.provider);
  const apiKey = request.apiKey.trim();
  if (!apiKey && provider.keyRequired) {
    return {
      ok: false,
      code: 'LLM_NOT_CONFIGURED',
      error: `请先填写 ${provider.label} 的 API Key。`,
    };
  }
  const baseUrl = trimTrailingSlash(
    request.baseUrl?.trim() || provider.defaultBaseUrl,
  );
  if (!baseUrl) {
    return {
      ok: false,
      code: 'LLM_ERROR',
      error: `${provider.label} 没有默认端点，请先填写 Base URL。`,
    };
  }
  const endpoint = resolveEndpoint(baseUrl);
  if ('error' in endpoint) {
    return { ok: false, code: 'LLM_ERROR', error: endpoint.error };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? 15_000,
  );
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (provider.protocol === 'anthropic-messages') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
    } else if (provider.protocol === 'google-generate-content') {
      headers['x-goog-api-key'] = apiKey;
    } else if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(modelListEndpoint(provider, baseUrl), {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code:
          response.status === 429
            ? 'RATE_LIMITED'
            : response.status >= 500
              ? 'UPSTREAM_ERROR'
              : 'LLM_ERROR',
        error: describeHttpError(response.status, raw),
      };
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: '模型列表接口返回的内容不是合法 JSON。',
      };
    }
    const models = extractAvailableModels(provider, payload).slice(0, 300);
    if (models.length === 0) {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: `${provider.label} 没有返回可用的文本生成模型。`,
      };
    }
    return {
      ok: true,
      models,
      providerId: provider.id,
      providerLabel: provider.label,
    };
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      return {
        ok: false,
        code: 'LLM_TIMEOUT',
        error: '读取模型列表超时，请检查 Base URL 或稍后重试。',
      };
    }
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      error: `无法读取 ${provider.label} 的模型列表：${cause instanceof Error ? cause.message : '未知网络错误'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 工具调用用的函数定义（当前只实现 OpenAI 兼容协议）。 */
export type ChatToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type ChatToolCall = {
  id: string;
  name: string;
  /** 模型给出的原始 JSON 字符串；解析和校验由调用方负责。 */
  arguments: string;
};

export type ToolChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type LlmFailureCode =
  | 'LLM_NOT_CONFIGURED'
  | 'LLM_ERROR'
  | 'LLM_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'RATE_LIMITED'
  | 'UPSTREAM_ERROR'
  | 'LLM_UNSUPPORTED_PROVIDER'
  | 'LLM_TOOLS_UNSUPPORTED';

export type ChatToolTurnRequest = {
  apiKey: string;
  provider?: string | null;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: LlmReasoningEffort;
  messages: ToolChatMessage[];
  /** 为空数组表示本轮不给模型任何工具。 */
  tools?: ChatToolDefinition[];
  toolChoice?: 'auto' | 'none';
  temperature?: number;
  timeoutMs?: number;
};

export type ChatToolTurnResult =
  | { ok: true; model: string; text: string | null; toolCalls: ChatToolCall[] }
  | { ok: false; code: LlmFailureCode; status?: number; error: string };

function mapToolMessages(
  messages: ToolChatMessage[],
): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    if (message.role === 'assistant') {
      return {
        role: 'assistant',
        content: message.content ?? '',
        ...(message.toolCalls.length > 0
          ? {
              tool_calls: message.toolCalls.map((call) => ({
                id: call.id,
                type: 'function',
                function: { name: call.name, arguments: call.arguments },
              })),
            }
          : {}),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function readTextContent(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return null;
  const joined = content
    .map((part) =>
      part &&
      typeof part === 'object' &&
      typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join('');
  return joined || null;
}

/** 从 OpenAI 兼容响应里取出正文和 tool_calls；结构不对返回 null。 */
function extractToolTurn(payload: unknown): {
  text: string | null;
  toolCalls: ChatToolCall[];
} | null {
  if (!payload || typeof payload !== 'object') return null;
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const message = (choices[0] as { message?: unknown }).message;
  if (!message || typeof message !== 'object') return null;
  const text = readTextContent((message as { content?: unknown }).content);
  const rawCalls = (message as { tool_calls?: unknown }).tool_calls;
  const toolCalls: ChatToolCall[] = [];
  if (Array.isArray(rawCalls)) {
    for (const [index, candidate] of rawCalls.entries()) {
      if (!candidate || typeof candidate !== 'object') return null;
      const fn = (candidate as { function?: unknown }).function;
      if (!fn || typeof fn !== 'object') return null;
      const name = (fn as { name?: unknown }).name;
      const args = (fn as { arguments?: unknown }).arguments;
      if (typeof name !== 'string') return null;
      const id = (candidate as { id?: unknown }).id;
      toolCalls.push({
        id: typeof id === 'string' && id ? id : `call_${index}`,
        name,
        arguments: typeof args === 'string' ? args : '{}',
      });
    }
  }
  return { text, toolCalls };
}

/**
 * 带工具的一轮模型调用。
 *
 * MVP 只实现 OpenAI 兼容协议（`openai-chat`）：Anthropic Messages 与 Gemini
 * 的工具编码不同，未实现前一律 fail closed，不静默退化成纯文本对话——否则模型
 * 会以为自己调用了 `run_python`。
 */
export async function callChatModelTurn(
  request: ChatToolTurnRequest,
): Promise<ChatToolTurnResult> {
  const requestedProviderId = request.provider?.trim();
  if (requestedProviderId && !findProvider(requestedProviderId)) {
    return {
      ok: false,
      code: 'LLM_UNSUPPORTED_PROVIDER',
      error: `不支持的模型服务：${requestedProviderId}。请在模型服务列表里选择，或用自定义（OpenAI 兼容）填写 Base URL。`,
    };
  }

  const provider = providerOrDefault(request.provider);
  if (provider.protocol !== 'openai-chat') {
    return {
      ok: false,
      code: 'LLM_TOOLS_UNSUPPORTED',
      error: `${provider.label} 的协议暂不支持工具调用，请改用 OpenAI 兼容协议的服务商。`,
    };
  }

  const apiKey = request.apiKey.trim();
  if (!apiKey && provider.keyRequired) {
    return {
      ok: false,
      code: 'LLM_NOT_CONFIGURED',
      error: `缺少 API Key：${provider.label} 需要 Key 才能调用。`,
    };
  }

  const baseUrl = trimTrailingSlash(
    request.baseUrl?.trim() || provider.defaultBaseUrl,
  );
  if (!baseUrl) {
    return {
      ok: false,
      code: 'LLM_ERROR',
      error: `缺少 Base URL：${provider.label} 没有默认端点，必须填写。`,
    };
  }
  const model = request.model?.trim() || provider.defaultModel;
  if (!model) {
    return {
      ok: false,
      code: 'LLM_ERROR',
      error: `缺少模型名：${provider.label} 没有默认模型，必须填写。`,
    };
  }
  const endpoint = resolveEndpoint(baseUrl);
  if ('error' in endpoint) {
    return { ok: false, code: 'LLM_ERROR', error: endpoint.error };
  }

  const tools = request.tools ?? [];
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    request.timeoutMs ?? 45_000,
  );

  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        messages: mapToolMessages(request.messages),
        ...(provider.reasoningMode === 'openai-effort' &&
        request.reasoningEffort !== undefined &&
        request.reasoningEffort !== 'auto'
          ? {}
          : { temperature: request.temperature ?? 0.2 }),
        ...openAiReasoningBody(provider, request.reasoningEffort ?? 'auto'),
        ...(tools.length > 0
          ? { tools, tool_choice: request.toolChoice ?? 'auto' }
          : {}),
      }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        code:
          response.status === 429
            ? 'RATE_LIMITED'
            : response.status >= 500
              ? 'UPSTREAM_ERROR'
              : 'LLM_ERROR',
        error: describeHttpError(response.status, raw),
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: '模型返回的内容不是合法 JSON。',
      };
    }

    const embedded = readEmbeddedError(parsed);
    if (embedded) {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: `模型服务返回错误：${embedded}`,
      };
    }

    const turn = extractToolTurn(parsed);
    if (!turn) {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: '模型返回的内容结构无法识别。',
      };
    }
    const text = turn.text?.trim() ?? null;
    if (!text && turn.toolCalls.length === 0) {
      return {
        ok: false,
        code: 'LLM_ERROR',
        error: `${provider.label} 既没有返回文本也没有返回工具调用（模型：${model}）。`,
      };
    }

    const reportedModel =
      parsed && typeof parsed === 'object'
        ? (parsed as { model?: unknown }).model
        : undefined;

    return {
      ok: true,
      text,
      toolCalls: turn.toolCalls,
      model: typeof reportedModel === 'string' ? reportedModel : model,
    };
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') {
      return {
        ok: false,
        code: 'LLM_TIMEOUT',
        error: '模型请求超时，请重试或换用更快的模型。',
      };
    }
    return {
      ok: false,
      code: 'NETWORK_ERROR',
      error: `无法连接模型服务（${provider.label}）：${cause instanceof Error ? cause.message : '未知网络错误'}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const kindHints: Record<string, string> = {
  input: '接收并理解用户输入',
  transform: '整理、提取或转换信息',
  decision: '做出判断或分流',
  compose: '生成给用户的回复内容',
  output: '把结果回传',
};

/** 把创建工作流端编排的步骤，转成给模型的系统提示词。 */
export function buildWorkflowSystemPrompt(workflow: WorkflowRecord): string {
  const steps = workflow.publishedSteps ?? [];
  const stepLines = steps.map(
    (step, index) =>
      `${String(index + 1).padStart(2, '0')}. ${step.title}（${kindHints[step.kind] ?? step.kind}）— ${step.detail}`,
  );

  return [
    `你正在执行一个由用户编排的工作流：「${workflow.name}」v${workflow.version}。`,
    workflow.description ? `工作流用途：${workflow.description}` : '',
    '',
    '这个工作流按以下步骤执行，你需要真正完成每一步的内容，而不只是复述步骤名：',
    ...stepLines,
    '',
    '请直接用中文回复用户，要求：',
    '1. 先给出你实际处理后的结论与可执行建议（不要只描述流程）。',
    `2. 在回复末尾另起一行，用一行汇总：结论 = <一句话结论>；优先级 = <高/中/低>。`,
    '3. 不要输出 JSON，不要提及你是模型或提示词的存在。',
  ]
    .filter(Boolean)
    .join('\n');
}
