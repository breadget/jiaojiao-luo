import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { callChatModelTurn } from '@/lib/server/llm';
import { PYTHON_AGENT_TOOL } from '@/lib/server/python-agent-prompt';
import { resetEnv } from './helpers/cloudflare-workers-stub';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetEnv();
});

function captureFetch(response: Response): {
  body: Record<string, unknown> | null;
} {
  const captured: { body: Record<string, unknown> | null } = { body: null };
  globalThis.fetch = (async (_input, init) => {
    captured.body =
      typeof init?.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    return response;
  }) as typeof fetch;
  return captured;
}

describe('带工具的模型回合', () => {
  it('把 assistant tool_calls 与 tool 结果编码成 OpenAI 兼容格式', async () => {
    const captured = captureFetch(
      Response.json({
        model: 'qwen-plus',
        choices: [{ message: { content: '已完成。' } }],
      }),
    );
    const result = await callChatModelTurn({
      apiKey: 'sk-test',
      provider: 'qwen',
      messages: [
        { role: 'system', content: '系统提示' },
        { role: 'user', content: '统计一下' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'call_1', name: 'run_python', arguments: '{"attempt":1}' },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'call_1',
          content: '{"status":"succeeded"}',
        },
      ],
      tools: [PYTHON_AGENT_TOOL],
      toolChoice: 'auto',
    });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.text, '已完成。');
    assert.equal(result.ok && result.model, 'qwen-plus');

    const body = captured.body as {
      tools: Array<{ function: { name: string } }>;
      tool_choice: string;
      messages: Array<Record<string, unknown>>;
    };
    assert.equal(body.tools[0]?.function.name, 'run_python');
    assert.equal(body.tool_choice, 'auto');
    const assistant = body.messages[2] as {
      role: string;
      content: string;
      tool_calls: Array<{
        id: string;
        type: string;
        function: { name: string; arguments: string };
      }>;
    };
    assert.equal(assistant.role, 'assistant');
    assert.equal(assistant.content, '');
    assert.equal(assistant.tool_calls[0]?.type, 'function');
    assert.equal(assistant.tool_calls[0]?.function.name, 'run_python');
    assert.equal(body.messages[3]?.role, 'tool');
    assert.equal(body.messages[3]?.tool_call_id, 'call_1');
  });

  it('解析模型返回的 tool_calls，并支持数组形式的 content', async () => {
    captureFetch(
      Response.json({
        choices: [
          {
            message: {
              content: [{ text: '先跑一次' }],
              tool_calls: [
                {
                  id: 'call_9',
                  type: 'function',
                  function: { name: 'run_python', arguments: '{"attempt":1}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const result = await callChatModelTurn({
      apiKey: 'sk-test',
      provider: 'qwen',
      messages: [{ role: 'user', content: '统计' }],
      tools: [PYTHON_AGENT_TOOL],
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.text, '先跑一次');
    assert.equal(result.ok && result.toolCalls.length, 1);
    assert.equal(result.ok && result.toolCalls[0]?.id, 'call_9');
    assert.equal(result.ok && result.toolCalls[0]?.name, 'run_python');
  });

  it('不带工具时不发送 tools 字段', async () => {
    const captured = captureFetch(
      Response.json({ choices: [{ message: { content: '直接回答。' } }] }),
    );
    await callChatModelTurn({
      apiKey: 'sk-test',
      provider: 'qwen',
      messages: [{ role: 'user', content: '你好' }],
      tools: [],
      toolChoice: 'none',
    });
    assert.equal(captured.body?.tools, undefined);
    assert.equal(captured.body?.tool_choice, undefined);
  });

  it('Anthropic / Gemini 协议 fail closed，不退化成纯文本对话', async () => {
    globalThis.fetch = (async () => {
      throw new Error('不应该发起请求');
    }) as typeof fetch;
    const anthropic = await callChatModelTurn({
      apiKey: 'sk-ant',
      provider: 'anthropic',
      messages: [{ role: 'user', content: '统计' }],
      tools: [PYTHON_AGENT_TOOL],
    });
    assert.equal(anthropic.ok, false);
    assert.equal(
      anthropic.ok === false && anthropic.code,
      'LLM_TOOLS_UNSUPPORTED',
    );

    const gemini = await callChatModelTurn({
      apiKey: 'key',
      provider: 'gemini',
      messages: [{ role: 'user', content: '统计' }],
      tools: [PYTHON_AGENT_TOOL],
    });
    assert.equal(gemini.ok, false);
    assert.equal(gemini.ok === false && gemini.code, 'LLM_TOOLS_UNSUPPORTED');
  });

  it('认不出的服务商直接报错，缺 Key 也报错', async () => {
    const unknown = await callChatModelTurn({
      apiKey: 'sk-test',
      provider: 'not-a-provider',
      messages: [{ role: 'user', content: '统计' }],
    });
    assert.equal(unknown.ok, false);
    assert.equal(
      unknown.ok === false && unknown.code,
      'LLM_UNSUPPORTED_PROVIDER',
    );

    const missingKey = await callChatModelTurn({
      apiKey: '',
      provider: 'qwen',
      messages: [{ role: 'user', content: '统计' }],
    });
    assert.equal(missingKey.ok, false);
    assert.equal(
      missingKey.ok === false && missingKey.code,
      'LLM_NOT_CONFIGURED',
    );
  });

  it('上游 429 与空响应都如实映射成稳定错误码', async () => {
    captureFetch(
      Response.json({ error: { message: 'slow down' } }, { status: 429 }),
    );
    const limited = await callChatModelTurn({
      apiKey: 'sk-test',
      provider: 'qwen',
      messages: [{ role: 'user', content: '统计' }],
    });
    assert.equal(limited.ok, false);
    assert.equal(limited.ok === false && limited.code, 'RATE_LIMITED');

    captureFetch(Response.json({ choices: [{ message: { content: '' } }] }));
    const empty = await callChatModelTurn({
      apiKey: 'sk-test',
      provider: 'qwen',
      messages: [{ role: 'user', content: '统计' }],
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.ok === false && empty.code, 'LLM_ERROR');
  });
});
