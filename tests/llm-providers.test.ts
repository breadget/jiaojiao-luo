/**
 * 多家模型服务：注册表、协议分发与路由选择。
 *
 * 覆盖三件事：
 *  1. 注册表自身的完整性（id 唯一、默认值齐、地址要么 https 要么本机回环）；
 *  2. `callChatModel` 按协议发出正确的端点 / 鉴权头 / 请求体，并如实映射错误；
 *  3. `/api/agent/chat` 把用户选的服务真正用起来，认不出的服务直接 400，不静默兜底。
 */
import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import {
  DEFAULT_LLM_PROVIDER_ID,
  findProvider,
  llmProviders,
  normalizeProviderId,
  providerDefaults,
  providerOptions,
} from '@/lib/llm/providers';
import {
  callChatModel,
  callChatModelTurn,
  DEFAULT_LLM_BASE_URL,
  DEFAULT_LLM_MODEL,
  listAvailableModels,
  resolveLlmSelection,
} from '@/lib/server/llm';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { createTestDatabase, type TestDatabase } from './helpers/d1';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

type JsonRecord = Record<string, unknown>;
type UpstreamCall = {
  path: string;
  url: URL;
  headers: IncomingMessage['headers'];
  body: JsonRecord;
};

const DIRECT_WORKFLOW_ID = 'wf_provider_direct';
const steps = [
  {
    id: 'step_compose',
    title: '生成回复',
    detail: '用模型生成最终回复。',
    kind: 'compose' as const,
  },
];

let mockServer!: ReturnType<typeof createServer>;
let serverOrigin = '';
let upstreamCalls: UpstreamCall[] = [];

// 整个文件共用一个上游：协议分发的用例和路由用例都要打到它。
before(async () => {
  mockServer = createServer((request, response) => {
    void handleUpstream(request, response).catch((cause: unknown) => {
      sendJson(response, 500, {
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    mockServer.once('error', reject);
    mockServer.listen(0, '127.0.0.1', () => resolve());
  });
  serverOrigin = `http://127.0.0.1:${(mockServer.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    mockServer.close((cause) => (cause ? reject(cause) : resolve()));
  });
  database.close();
});

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(payload));
}

async function readRequest(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as JsonRecord) : {};
}

/** 按 Key 决定返回哪种答案/错误，模拟不同协议的上游。 */
async function handleUpstream(
  request: IncomingMessage,
  response: ServerResponse,
) {
  const body = await readRequest(request);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const keyHeader =
    request.headers.authorization ??
    (request.headers['x-api-key'] as string | undefined) ??
    (request.headers['x-goog-api-key'] as string | undefined) ??
    '';
  const key = keyHeader.replace(/^Bearer\s+/i, '');
  upstreamCalls.push({
    path: request.url ?? '',
    url,
    headers: request.headers,
    body,
  });

  if (key === 'key-401') {
    sendJson(response, 401, { error: { message: 'invalid key' } });
    return;
  }
  if (key === 'key-429') {
    sendJson(response, 429, { error: { message: 'slow down' } });
    return;
  }
  if (key === 'key-500') {
    sendJson(response, 500, { error: { message: 'boom' } });
    return;
  }
  if (key === 'key-not-json') {
    response.writeHead(200, { 'Content-Type': 'text/plain' });
    response.end('not json at all');
    return;
  }
  if (key === 'key-embedded-error') {
    sendJson(response, 200, {
      error: { message: 'quota for this model is 0' },
    });
    return;
  }
  if (url.pathname.endsWith('/models')) {
    if (url.pathname === '/mixed-models/v1/models') {
      sendJson(response, 200, {
        models: ['model-z', { model: 'model-a' }, { model_id: 'model-b' }],
      });
      return;
    }
    if (request.headers['x-goog-api-key']) {
      sendJson(response, 200, {
        models: [
          {
            name: 'models/gemini-2.5-pro',
            supportedGenerationMethods: ['generateContent'],
          },
          {
            name: 'models/text-embedding-004',
            supportedGenerationMethods: ['embedContent'],
          },
        ],
      });
      return;
    }
    if (request.headers['x-api-key']) {
      sendJson(response, 200, {
        data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-opus-4-1' }],
      });
      return;
    }
    sendJson(response, 200, {
      data: [{ id: 'gpt-4.1' }, { id: 'gpt-4o-mini' }, { id: 'gpt-4.1' }],
    });
    return;
  }
  if (url.pathname.endsWith(':generateContent')) {
    sendJson(response, 200, {
      modelVersion: 'gemini-2.5-flash-001',
      candidates: [
        { content: { role: 'model', parts: [{ text: '来自 Gemini 的回答' }] } },
      ],
    });
    return;
  }
  if (url.pathname.endsWith('/messages')) {
    sendJson(response, 200, {
      id: 'msg_1',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: '来自 Claude 的回答' }],
    });
    return;
  }
  if (url.pathname.endsWith('/chat/completions')) {
    sendJson(response, 200, {
      id: 'cmpl_1',
      model: body.model ?? 'unknown',
      choices: [
        { message: { role: 'assistant', content: '来自兼容端点的回答' } },
      ],
    });
    return;
  }
  sendJson(response, 404, {
    error: { message: `unexpected path ${url.pathname}` },
  });
}

describe('模型服务注册表', () => {
  it('id 唯一，默认服务在表里，地址要么 https 要么本机回环', () => {
    const ids = llmProviders.map((provider) => provider.id);
    assert.equal(new Set(ids).size, ids.length, 'provider id 必须唯一');
    assert.ok(findProvider(DEFAULT_LLM_PROVIDER_ID), '默认服务必须在注册表里');

    for (const provider of llmProviders) {
      assert.ok(
        [
          'openai-chat',
          'anthropic-messages',
          'google-generate-content',
        ].includes(provider.protocol),
        `${provider.id} 的协议不支持`,
      );
      for (const value of [
        provider.defaultBaseUrl,
        provider.openAiCompatibleBaseUrl,
      ]) {
        if (!value) continue;
        const url = new URL(value);
        const local = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
        assert.ok(
          url.protocol === 'https:' || (url.protocol === 'http:' && local),
          `${provider.id} 的端点必须 https（本机回环除外）：${value}`,
        );
      }
      if (!provider.requiresModel) {
        assert.ok(provider.defaultModel, `${provider.id} 缺默认模型`);
      }
      if (provider.models.length) {
        assert.ok(
          provider.models.includes(provider.defaultModel),
          `${provider.id} 的默认模型应出现在建议列表里`,
        );
      }
      // 注册表里永远不允许出现凭据字段。
      assert.equal(
        JSON.stringify(provider).includes('apiKey'),
        false,
        `${provider.id} 的描述里不能出现 apiKey`,
      );
    }
  });

  it('认得历史写法与别名，认不出的返回 null', () => {
    assert.equal(normalizeProviderId('openai-compatible'), 'openai');
    assert.equal(normalizeProviderId('DASHSCOPE'), 'qwen');
    assert.equal(normalizeProviderId('kimi'), 'moonshot');
    assert.equal(normalizeProviderId('claude'), 'anthropic');
    assert.equal(normalizeProviderId('  '), null);
    assert.equal(normalizeProviderId('gpt5-magic'), null);
    assert.equal(findProvider('gpt5-magic'), null);
  });

  it('给 UI 的选项里只有展示信息，没有 Key', () => {
    const options = providerOptions();
    assert.equal(options.length, llmProviders.length);
    for (const option of options) {
      assert.deepEqual(
        Object.keys(option).filter((key) => /key|token|secret/i.test(key)),
        ['keyRequired', 'keyHint'],
      );
    }
  });

  it('providerDefaults 只换地址与模型', () => {
    assert.deepEqual(providerDefaults('deepseek'), {
      id: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
    });
    assert.equal(providerDefaults('nope'), null);
  });
});

describe('resolveLlmSelection', () => {
  it('缺省用平台默认服务，并带上默认端点与模型', () => {
    const result = resolveLlmSelection({});
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.selection, {
      providerId: DEFAULT_LLM_PROVIDER_ID,
      providerLabel: findProvider(DEFAULT_LLM_PROVIDER_ID)?.label,
      baseUrl: DEFAULT_LLM_BASE_URL,
      model: DEFAULT_LLM_MODEL,
      keyRequired: true,
    });
  });

  it('显式选择的服务必须认得出来，否则报错而不是回退默认', () => {
    const result = resolveLlmSelection({ provider: 'gpt5-magic' });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.code, 'LLM_UNSUPPORTED_PROVIDER');
  });

  it('自定义服务必须自带 Base URL 与模型名', () => {
    const missing = resolveLlmSelection({ provider: 'custom' });
    assert.equal(missing.ok, false);
    assert.match(!missing.ok ? missing.error : '', /Base URL/);

    const filled = resolveLlmSelection({
      provider: 'custom',
      baseUrl: 'https://gateway.example.com/v1',
      model: 'my-model',
    });
    assert.equal(filled.ok, true);
    assert.equal(
      filled.ok && filled.selection.baseUrl,
      'https://gateway.example.com/v1',
    );
    assert.equal(filled.ok && filled.selection.model, 'my-model');
  });

  it('本机 Ollama 不强制 Key', () => {
    const result = resolveLlmSelection({ provider: 'ollama' });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.selection.keyRequired, false);
  });
});

describe('callChatModel · 多家协议', () => {
  it('OpenAI 兼容协议：Bearer 鉴权 + /chat/completions', async () => {
    upstreamCalls = [];
    const result = await callChatModel({
      provider: 'deepseek',
      apiKey: 'key-openai',
      baseUrl: `${serverOrigin}/v1`,
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: '系统指令' },
        { role: 'user', content: '你好' },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.text, '来自兼容端点的回答');
    const call = upstreamCalls.at(-1);
    assert.equal(call?.url.pathname, '/v1/chat/completions');
    assert.equal(call?.headers.authorization, 'Bearer key-openai');
    assert.equal(call?.body.model, 'deepseek-chat');
    assert.equal(call?.body.temperature, 0.3);
  });

  it('Anthropic 协议：x-api-key + system 提到顶层 + /v1/messages', async () => {
    upstreamCalls = [];
    const result = await callChatModel({
      provider: 'anthropic',
      apiKey: 'key-anthropic',
      baseUrl: serverOrigin,
      model: 'claude-sonnet-4-5',
      messages: [
        { role: 'system', content: '系统指令' },
        { role: 'user', content: '你好' },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.text, '来自 Claude 的回答');
    const call = upstreamCalls.at(-1);
    assert.equal(call?.url.pathname, '/v1/messages');
    assert.equal(call?.headers['x-api-key'], 'key-anthropic');
    assert.equal(call?.headers.authorization, undefined);
    assert.equal(call?.headers['anthropic-version'], '2023-06-01');
    assert.equal(call?.body.system, '系统指令');
    assert.equal(call?.body.max_tokens, 4096);
    assert.deepEqual(call?.body.messages, [{ role: 'user', content: '你好' }]);
  });

  it('Gemini 协议：x-goog-api-key + 模型名进路径 + generateContent', async () => {
    upstreamCalls = [];
    const result = await callChatModel({
      provider: 'gemini',
      apiKey: 'key-gemini',
      baseUrl: serverOrigin,
      model: 'gemini-2.5-flash',
      messages: [
        { role: 'system', content: '系统指令' },
        { role: 'user', content: '你好' },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.text, '来自 Gemini 的回答');
    assert.equal(result.ok && result.model, 'gemini-2.5-flash-001');
    const call = upstreamCalls.at(-1);
    assert.equal(
      call?.url.pathname,
      '/v1beta/models/gemini-2.5-flash:generateContent',
    );
    assert.equal(call?.headers['x-goog-api-key'], 'key-gemini');
    assert.equal(call?.url.search, '', 'Key 不能出现在 URL 查询参数里');
    assert.deepEqual(call?.body.systemInstruction, {
      parts: [{ text: '系统指令' }],
    });
    assert.deepEqual(call?.body.contents, [
      { role: 'user', parts: [{ text: '你好' }] },
    ]);
  });

  it('三种协议都不把 Key 放进 URL', async () => {
    upstreamCalls = [];
    for (const [provider, baseUrl] of [
      ['openai', `${serverOrigin}/v1`],
      ['anthropic', serverOrigin],
      ['gemini', serverOrigin],
    ] as const) {
      await callChatModel({
        provider,
        apiKey: 'key-url-check',
        baseUrl,
        model: 'any-model',
        messages: [{ role: 'user', content: 'hi' }],
      });
    }
    for (const call of upstreamCalls) {
      assert.equal(call.url.search, '', `${call.path} 不应带查询参数`);
      assert.equal(
        call.url.pathname.includes('key-url-check'),
        false,
        `${call.path} 不应把 Key 写进路径`,
      );
    }
  });

  it('上游错误码如实映射：401 / 429 / 500 / 非 JSON / 报错信封', async () => {
    const cases = [
      ['key-401', 'LLM_ERROR'],
      ['key-429', 'RATE_LIMITED'],
      ['key-500', 'UPSTREAM_ERROR'],
      ['key-not-json', 'LLM_ERROR'],
      ['key-embedded-error', 'LLM_ERROR'],
    ] as const;
    for (const [apiKey, code] of cases) {
      const result = await callChatModel({
        provider: 'openai',
        apiKey,
        baseUrl: `${serverOrigin}/v1`,
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: 'hi' }],
      });
      assert.equal(result.ok, false, `${apiKey} 应该失败`);
      assert.equal(!result.ok && result.code, code, `${apiKey} 错误码不对`);
      if (apiKey === 'key-embedded-error') {
        assert.match(!result.ok ? result.error : '', /quota for this model/);
      }
    }
  });

  it('认不出的服务与不安全的地址都直接拒绝', async () => {
    const unknown = await callChatModel({
      provider: 'gpt5-magic',
      apiKey: 'key',
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(unknown.ok, false);
    assert.equal(!unknown.ok && unknown.code, 'LLM_UNSUPPORTED_PROVIDER');

    const insecure = await callChatModel({
      provider: 'custom',
      apiKey: 'key',
      baseUrl: 'http://gateway.example.com/v1',
      model: 'x',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(insecure.ok, false);
    assert.match(!insecure.ok ? insecure.error : '', /必须使用 https/);

    const noKey = await callChatModel({
      provider: 'anthropic',
      apiKey: '',
      model: 'claude-sonnet-4-5',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(noKey.ok, false);
    assert.equal(!noKey.ok && noKey.code, 'LLM_NOT_CONFIGURED');
  });

  it('本机 Ollama 免 Key：不带 Authorization 也能真调模型', async () => {
    upstreamCalls = [];
    const result = await callChatModel({
      provider: 'ollama',
      apiKey: '',
      baseUrl: `${serverOrigin}/v1`,
      model: 'qwen2.5:7b',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(result.ok, true);
    const call = upstreamCalls.at(-1);
    assert.equal(call?.headers.authorization, undefined);
    assert.equal(call?.url.pathname, '/v1/chat/completions');
  });

  it('把推理强度按不同厂商协议映射，model-only 服务不伪造参数', async () => {
    upstreamCalls = [];
    await callChatModel({
      provider: 'openai',
      apiKey: 'key-openai',
      baseUrl: `${serverOrigin}/v1`,
      model: 'o3',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(upstreamCalls.at(-1)?.body.reasoning_effort, 'high');
    assert.equal(upstreamCalls.at(-1)?.body.temperature, undefined);

    await callChatModel({
      provider: 'qwen',
      apiKey: 'key-qwen',
      baseUrl: `${serverOrigin}/v1`,
      model: 'qwen-plus',
      reasoningEffort: 'medium',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(upstreamCalls.at(-1)?.body.enable_thinking, true);
    assert.equal(upstreamCalls.at(-1)?.body.thinking_budget, 8192);

    await callChatModel({
      provider: 'anthropic',
      apiKey: 'key-anthropic',
      baseUrl: serverOrigin,
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.deepEqual(upstreamCalls.at(-1)?.body.thinking, {
      type: 'enabled',
      budget_tokens: 2048,
    });
    assert.equal(upstreamCalls.at(-1)?.body.temperature, undefined);

    await callChatModel({
      provider: 'gemini',
      apiKey: 'key-gemini',
      baseUrl: serverOrigin,
      model: 'gemini-2.5-pro',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const generationConfig = upstreamCalls.at(-1)?.body.generationConfig;
    assert.ok(generationConfig && typeof generationConfig === 'object');
    assert.deepEqual((generationConfig as JsonRecord).thinkingConfig, {
      thinkingBudget: 24576,
    });

    await callChatModel({
      provider: 'deepseek',
      apiKey: 'key-deepseek',
      baseUrl: `${serverOrigin}/v1`,
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(upstreamCalls.at(-1)?.body.reasoning_effort, undefined);
    assert.equal(upstreamCalls.at(-1)?.body.thinking_budget, undefined);
  });

  it('工具调用也带上兼容协议的推理强度', async () => {
    upstreamCalls = [];
    const result = await callChatModelTurn({
      provider: 'openai',
      apiKey: 'key-openai',
      baseUrl: `${serverOrigin}/v1`,
      model: 'o3',
      reasoningEffort: 'low',
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(result.ok, true);
    assert.equal(upstreamCalls.at(-1)?.body.reasoning_effort, 'low');
  });
});

describe('listAvailableModels · API 模型识别', () => {
  it('识别 OpenAI 兼容模型并去重排序', async () => {
    upstreamCalls = [];
    const result = await listAvailableModels({
      provider: 'openai',
      apiKey: 'key-openai',
      baseUrl: `${serverOrigin}/v1`,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.models, ['gpt-4.1', 'gpt-4o-mini']);
    assert.equal(
      upstreamCalls.at(-1)?.headers.authorization,
      'Bearer key-openai',
    );
  });

  it('兼容字符串模型列表、model 字段与已经带 /models 的地址', async () => {
    upstreamCalls = [];
    const result = await listAvailableModels({
      provider: 'custom',
      apiKey: 'key-custom',
      baseUrl: `${serverOrigin}/mixed-models/v1/models`,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ok && result.models, [
      'model-a',
      'model-b',
      'model-z',
    ]);
    assert.equal(upstreamCalls.at(-1)?.url.pathname, '/mixed-models/v1/models');
  });

  it('识别 Anthropic 与 Gemini，并过滤 Gemini 的非生成模型', async () => {
    const anthropic = await listAvailableModels({
      provider: 'anthropic',
      apiKey: 'key-anthropic',
      baseUrl: serverOrigin,
    });
    assert.equal(anthropic.ok, true);
    assert.deepEqual(anthropic.ok && anthropic.models, [
      'claude-opus-4-1',
      'claude-sonnet-4-5',
    ]);

    const gemini = await listAvailableModels({
      provider: 'gemini',
      apiKey: 'key-gemini',
      baseUrl: serverOrigin,
    });
    assert.equal(gemini.ok, true);
    assert.deepEqual(gemini.ok && gemini.models, ['gemini-2.5-pro']);
  });

  it('缺 Key 与不安全地址在发请求前失败', async () => {
    upstreamCalls = [];
    const noKey = await listAvailableModels({
      provider: 'openai',
      apiKey: '',
    });
    assert.equal(noKey.ok, false);
    assert.equal(!noKey.ok && noKey.code, 'LLM_NOT_CONFIGURED');
    const insecure = await listAvailableModels({
      provider: 'custom',
      apiKey: 'key',
      baseUrl: 'http://example.com/v1',
    });
    assert.equal(insecure.ok, false);
    assert.equal(upstreamCalls.length, 0);
  });
});

describe('POST /api/llm/models · 模型识别入口', () => {
  type ModelsRoute = typeof import('@/app/api/llm/models/route');
  let route!: ModelsRoute;

  before(async () => {
    route = await import('@/app/api/llm/models/route');
  });

  it('只回传模型元数据，不回显 API Key，并禁止缓存', async () => {
    const response = await route.POST(
      new Request('http://urtoris.test/api/llm/models', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://urtoris.test',
          'X-Real-IP': nextAddress(),
        },
        body: JSON.stringify({
          provider: 'openai',
          apiKey: 'key-model-route',
          baseUrl: `${serverOrigin}/v1`,
        }),
      }),
    );
    const body = (await response.json()) as JsonRecord;
    assert.equal(response.status, 200);
    assert.deepEqual(body.models, ['gpt-4.1', 'gpt-4o-mini']);
    assert.equal(JSON.stringify(body).includes('key-model-route'), false);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  });
});

describe('POST /api/agent/chat · 服务选择', () => {
  type AgentChatRoute = typeof import('@/app/api/agent/chat/route');
  let route!: AgentChatRoute;

  function postChat(body: JsonRecord): Promise<Response> {
    return route.POST(
      new Request('http://urtoris.test/api/agent/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'http://urtoris.test',
          'X-Real-IP': nextAddress(),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  before(async () => {
    resetEnv({
      N8N_BASE_URL: serverOrigin,
      N8N_WEBHOOK_TOKEN: 'test-n8n-token',
    });
    await seedWorkflow(database.d1, {
      id: DIRECT_WORKFLOW_ID,
      name: '服务选择直连',
      version: 1,
      publishedSteps: steps,
    });
    route = await import('@/app/api/agent/chat/route');
  });

  it('选 Anthropic 时走 /v1/messages，并把 Key 记成不落库', async () => {
    upstreamCalls = [];
    const response = await postChat({
      workflowId: DIRECT_WORKFLOW_ID,
      message: '用 Claude 回答',
      requestId: 'req_provider_anthropic',
      sessionId: 'sess_provider_anthropic',
      provider: 'anthropic',
      apiKey: 'key-anthropic',
      baseUrl: serverOrigin,
      model: 'claude-sonnet-4-5',
    });
    const body = (await response.json()) as JsonRecord;

    assert.equal(response.status, 200);
    assert.equal(body.mode, 'model');
    assert.equal(body.provider, 'anthropic');
    assert.equal(body.errorCode, null);
    const call = upstreamCalls.at(-1);
    assert.equal(call?.url.pathname, '/v1/messages');
    assert.equal(call?.headers['x-api-key'], 'key-anthropic');

    const stored = await database.d1
      .prepare(`SELECT * FROM runs WHERE request_id = ?`)
      .bind('req_provider_anthropic')
      .first<JsonRecord>();
    assert.equal(JSON.stringify(stored).includes('key-anthropic'), false);
  });

  it('认不出的服务返回 400，且不调用任何上游', async () => {
    upstreamCalls = [];
    const response = await postChat({
      workflowId: DIRECT_WORKFLOW_ID,
      message: '选择不存在的服务',
      provider: 'gpt5-magic',
      apiKey: 'key-anthropic',
      model: 'whatever',
    });
    const body = (await response.json()) as JsonRecord;
    assert.equal(response.status, 400);
    assert.equal(body.errorCode, 'LLM_UNSUPPORTED_PROVIDER');
    assert.equal(upstreamCalls.length, 0, '不该发出任何上游请求');
  });

  it('自定义服务缺少 Base URL 时返回 400，而不是偷偷用默认端点', async () => {
    upstreamCalls = [];
    const response = await postChat({
      workflowId: DIRECT_WORKFLOW_ID,
      message: '自定义服务没填地址',
      provider: 'custom',
      apiKey: 'key-anthropic',
      model: 'my-model',
      requestId: 'req_provider_custom_missing',
    });
    const body = (await response.json()) as JsonRecord;
    assert.equal(response.status, 400);
    assert.match(String(body.error), /Base URL/);
    assert.equal(upstreamCalls.length, 0);
  });

  it('拒绝未知的推理强度，不向上游发请求', async () => {
    upstreamCalls = [];
    const response = await postChat({
      workflowId: DIRECT_WORKFLOW_ID,
      message: '使用非法推理参数',
      provider: 'openai',
      apiKey: 'key-openai',
      baseUrl: `${serverOrigin}/v1`,
      model: 'o3',
      reasoningEffort: 'extreme',
    });
    assert.equal(response.status, 400);
    assert.equal(upstreamCalls.length, 0);
  });
});
