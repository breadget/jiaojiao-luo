import assert from 'node:assert/strict';
import { before, it, mock } from 'node:test';
import type { WorkflowRecord } from '@/lib/workflow-types';

const modelRequests: Array<Record<string, unknown>> = [];
const retrievalQuestions: string[] = [];
const retrievalTimeouts: Array<number | undefined> = [];
mock.module('@/lib/server/llm', {
  exports: {
    callChatModelTurn: async (request: Record<string, unknown>) => {
      modelRequests.push(request);
      return {
        ok: true,
        model: 'actual-model',
        text: '普通对话回答。',
        toolCalls: [],
      };
    },
    callChatModel: async (request: Record<string, unknown>) => {
      modelRequests.push(request);
      return { ok: true, model: 'actual-model', text: '普通对话回答。' };
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);
mock.module('@/lib/server/course-assistant-client', {
  exports: {
    retrieveCourseSources: async (question: string, timeoutMs?: number) => {
      retrievalQuestions.push(question);
      retrievalTimeouts.push(timeoutMs);
      return { sources: [] };
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);
let assistant: typeof import('@/lib/server/unified-assistant');
before(async () => {
  assistant = await import('@/lib/server/unified-assistant');
});
const workflow: WorkflowRecord = {
  id: 'selected-workflow',
  name: '测试工作流',
  description: '处理消息',
  draftSteps: [],
  publishedSteps: [],
  version: 1,
  hasUnpublishedChanges: false,
  createdAt: 0,
  updatedAt: 0,
  publishedAt: 0,
  n8nWebhookUrl: null,
};

for (const provider of ['openai', 'anthropic', 'gemini']) {
  it(`bounds ${provider} retrieval plus first model turn below claim/browser lifetime`, async () => {
    const result = await assistant.runUnifiedAssistant({
      message: '你好',
      workflow,
      history: [],
      shouldCallModel: true,
      llm: {
        provider,
        apiKey: 'transient-key',
        baseUrl: 'https://provider.test/v1',
        model: 'selected-model',
        reasoningEffort: 'high',
      },
    });
    assert.equal(result.kind, 'answer');
    assert.equal(retrievalTimeouts.at(-1), 8_000);
    assert.equal(modelRequests.at(-1)?.timeoutMs, 30_000);
    assert.equal(modelRequests.at(-1)?.model, 'selected-model');
    assert.equal(modelRequests.at(-1)?.apiKey, 'transient-key');
    assert.equal(modelRequests.at(-1)?.reasoningEffort, 'high');
    assert.ok(
      8_000 + Number(modelRequests.at(-1)?.timeoutMs) + 45_000 < 100_000,
    );
  });
}

for (const message of ['你是谁？', '你好，帮我想一个周末计划。']) {
  it(`keeps an independent new question separate from earlier course retrieval: ${message}`, async () => {
    const earlier = '队列和栈的区别是什么？';
    await assistant.runUnifiedAssistant({
      message,
      workflow,
      history: [
        { role: 'user', content: earlier },
        { role: 'assistant', content: '队列先进先出，栈后进先出。' },
      ],
      shouldCallModel: true,
      llm: {
        provider: 'openai',
        apiKey: 'transient',
        baseUrl: 'https://provider.test/v1',
        model: 'shared-model',
        reasoningEffort: 'auto',
      },
    });
    assert.equal(retrievalQuestions.at(-1), message);
    assert.match(
      JSON.stringify(modelRequests.at(-1)?.messages),
      /队列和栈的区别/,
    );
  });
}
for (const message of [
  '那它的复杂度呢？',
  '继续',
  '再举个例子',
  '这个为什么是 O(1)？',
]) {
  it(`expands a clear referential follow-up for course retrieval: ${message}`, async () => {
    const earlier = '队列入队的时间复杂度是什么？';
    await assistant.runUnifiedAssistant({
      message,
      workflow,
      history: [{ role: 'user', content: earlier }],
      shouldCallModel: true,
      llm: {
        provider: 'openai',
        apiKey: 'transient',
        baseUrl: 'https://provider.test/v1',
        model: 'shared-model',
        reasoningEffort: 'auto',
      },
    });
    assert.match(retrievalQuestions.at(-1) ?? '', /前一问题：队列入队/);
    assert.ok(retrievalQuestions.at(-1)?.includes(`当前问题：${message}`));
  });
}
