import assert from 'node:assert/strict';
import { before, it, mock } from 'node:test';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { graphOf, makeEdge, makeNode } from './helpers/graph';
import type { ChatToolTurnRequest, ChatToolTurnResult } from '@/lib/server/llm';
import type { DatabaseAgentBinding } from '@/lib/server/database-agent';

let model: (request: ChatToolTurnRequest) => Promise<ChatToolTurnResult>;
const calls: ChatToolTurnRequest[] = [];
mock.module('@/lib/server/llm', {
  exports: {
    callChatModelTurn: async (request: ChatToolTurnRequest) => {
      calls.push(request);
      return model(request);
    },
  },
} as unknown as Parameters<typeof mock.module>[1]);
let agent: typeof import('@/lib/server/database-agent');
before(async () => {
  resetEnv({ URTORIS_API_TOKEN: 'database-budget-signing-token' });
  agent = await import('@/lib/server/database-agent');
});
const graph = graphOf(
  [
    makeNode('trigger', 'trigger'),
    makeNode('aiAgent', 'agent', {
      config: {
        strategy: 'tools',
        instructions: '读取真实数据库。',
        maxIterations: 6,
        fallbackPolicy: 'error',
        prompt: '$json.message',
      },
    }),
    makeNode('llmModel', 'model', {
      config: {
        provider: 'custom',
        model: 'selected-model',
        baseUrl: 'https://provider.test/v1',
      },
    }),
    makeNode('database', 'database_orders', {
      name: '订单库',
      config: {
        provider: 'sqlite',
        location: 'local',
        operation: 'select',
        filePath: '/Users/test/orders.db',
        maxRows: 2,
      },
    }),
    makeNode('output', 'output'),
  ],
  [
    makeEdge('trigger', 'main.out', 'agent', 'main.in'),
    makeEdge('agent', 'main.out', 'output', 'main.in'),
    makeEdge('agent', 'resource.model', 'model', 'model.provider', 'model'),
    makeEdge(
      'agent',
      'resource.tools',
      'database_orders',
      'tool.provider',
      'tool',
    ),
  ],
  { id: 'selected-db-workflow' },
);
const binding: DatabaseAgentBinding = {
  workflowId: 'selected-db-workflow',
  versionId: 'published-version',
  requestId: 'database-budget-request',
  sessionId: 'same-engine-session',
  consumerSessionId: null,
  agentMessageId: null,
  userMessageId: null,
  message: '查询订单数据库。',
  provider: 'custom',
  baseUrl: 'https://provider.test/v1',
  model: 'selected-model',
  reasoningEffort: 'high',
};
function input() {
  return {
    graph,
    binding,
    messages: [{ role: 'user' as const, content: binding.message }],
    llm: {
      apiKey: 'transient-only-key',
      provider: binding.provider,
      baseUrl: binding.baseUrl,
      model: binding.model,
      reasoningEffort: 'high' as const,
    },
  };
}
function invalidQuery(id: string) {
  return [
    {
      id,
      name: 'query_database',
      arguments: JSON.stringify({
        nodeId: 'database_orders',
        sql: '',
        parameters: [],
      }),
    },
  ];
}

it('shares one absolute HTTP deadline across SQL corrections and fails before a third model/tool execution', async () => {
  let now = 1_000_000;
  const clock = mock.method(Date, 'now', () => now);
  let beforeCalls = calls.length;
  let number = 0;
  const correctionsModel = async (): Promise<ChatToolTurnResult> => {
    number += 1;
    now += 20_000;
    let advanced = false;
    return {
      ok: true,
      model: 'selected-model',
      text: null,
      get toolCalls() {
        // Local parsing/validation can also consume the remaining deadline.
        if (number === 2 && !advanced) {
          now += 10_000;
          advanced = true;
        }
        return invalidQuery(`invalid_sql_${number}`);
      },
    };
  };
  try {
    model = async () => ({
      ok: true,
      model: 'selected-model',
      text: null,
      toolCalls: [
        {
          id: 'inspect_before_corrections',
          name: 'inspect_database',
          arguments: JSON.stringify({ nodeId: 'database_orders' }),
        },
      ],
    });
    const inspected = await agent.runDatabaseAgentTurn({
      ...input(),
      modelBudgetMs: 45_000,
    });
    assert.equal(inspected.kind, 'pending');
    if (inspected.kind !== 'pending')
      throw new Error('Expected signed inspection');
    beforeCalls = calls.length;
    model = correctionsModel;
    const result = await agent.runDatabaseAgentTurn({
      ...input(),
      modelBudgetMs: 45_000,
      databaseSession: inspected.database.session,
      databaseResults: [
        {
          id: inspected.database.requests[0].id,
          result: {
            protocol: 'urtoris.local-database.v1',
            filePath: '/Users/test/orders.db',
            tables: [],
            truncated: false,
          },
        },
      ],
    });
    assert.equal(result.kind, 'failed');
    if (result.kind !== 'failed') throw new Error('Unexpected tool execution');
    assert.equal(result.code, 'LLM_TIMEOUT');
    assert.equal(result.turns, 3);
    assert.equal(calls.length - beforeCalls, 2);
    assert.deepEqual(
      calls.slice(beforeCalls).map((call) => call.timeoutMs),
      [45_000, 25_000],
    );
    assert.equal(number, 2);
    assert.ok(
      !('database' in result),
      'Invalid SQL is never handed to the browser',
    );
    const corrections = calls
      .at(-1)!
      .messages.filter(
        (entry) =>
          entry.role === 'tool' &&
          typeof JSON.parse(entry.content).error === 'string',
      );
    assert.equal(corrections.length, 2);
    assert.ok(
      corrections.every(
        (entry) =>
          entry.role === 'tool' &&
          /SQL 必须/.test(String(JSON.parse(entry.content).error)),
      ),
    );
  } finally {
    clock.mock.restore();
  }
});

it('rejects a model answer returned after the HTTP deadline instead of accepting late success', async () => {
  let now = 2_000_000;
  const clock = mock.method(Date, 'now', () => now);
  const beforeCalls = calls.length;
  model = async () => {
    now += 45_001;
    return {
      ok: true,
      model: 'selected-model',
      text: 'A late answer',
      toolCalls: [],
    };
  };
  try {
    const result = await agent.runDatabaseAgentTurn({
      ...input(),
      modelBudgetMs: 45_000,
    });
    assert.equal(result.kind, 'failed');
    if (result.kind !== 'failed')
      throw new Error('Late model success was accepted');
    assert.equal(result.code, 'LLM_TIMEOUT');
    assert.equal(calls.length - beforeCalls, 1);
  } finally {
    clock.mock.restore();
  }
});

it('keeps the legacy loop unchanged when no per-request deadline is supplied', async () => {
  let now = 3_000_000;
  const clock = mock.method(Date, 'now', () => now);
  const beforeCalls = calls.length;
  let number = 0;
  model = async () => {
    number += 1;
    now += 20_000;
    return {
      ok: true,
      model: 'selected-model',
      text: null,
      toolCalls: invalidQuery(`legacy_sql_${number}`),
    };
  };
  try {
    const result = await agent.runDatabaseAgentTurn(input());
    assert.equal(result.kind, 'failed');
    if (result.kind !== 'failed')
      throw new Error('Invalid SQL unexpectedly executed');
    assert.equal(result.code, 'LOCAL_DATABASE_TOOL_LIMIT');
    assert.equal(calls.length - beforeCalls, 6);
    assert.ok(
      calls.slice(beforeCalls).every((call) => call.timeoutMs === undefined),
    );
  } finally {
    clock.mock.restore();
  }
});

it('starts a fresh model budget after a signed browser continuation while retaining the original session expiry', async () => {
  let now = 4_000_000;
  const clock = mock.method(Date, 'now', () => now);
  const beforeCalls = calls.length;
  const deadlines: number[] = [];
  model = async () => {
    now += 20_000;
    return {
      ok: true,
      model: 'selected-model',
      text: null,
      toolCalls: [
        {
          id: 'inspect_orders',
          name: 'inspect_database',
          arguments: JSON.stringify({ nodeId: 'database_orders' }),
        },
      ],
    };
  };
  try {
    const start = await agent.runDatabaseAgentTurn({
      ...input(),
      modelBudgetMs: 45_000,
      onProgress: async (deadline) => {
        deadlines.push(deadline);
      },
    });
    assert.equal(start.kind, 'pending');
    if (start.kind !== 'pending')
      throw new Error('Expected a signed browser inspection');
    now += 180_000;
    model = async () => {
      now += 30_000;
      return {
        ok: true,
        model: 'selected-model',
        text: '已经实际读取数据库结构。',
        toolCalls: [],
      };
    };
    const complete = await agent.runDatabaseAgentTurn({
      ...input(),
      modelBudgetMs: 45_000,
      databaseSession: start.database.session,
      databaseResults: [
        {
          id: start.database.requests[0].id,
          result: {
            protocol: 'urtoris.local-database.v1',
            filePath: '/Users/test/orders.db',
            tables: [],
            truncated: false,
          },
        },
      ],
      onProgress: async (deadline) => {
        deadlines.push(deadline);
      },
    });
    assert.equal(complete.kind, 'completed');
    assert.deepEqual(deadlines, [
      4_000_000 + agent.DATABASE_CHAT_SESSION_LIFETIME_MS,
      4_000_000 + agent.DATABASE_CHAT_SESSION_LIFETIME_MS,
    ]);
    assert.deepEqual(
      calls.slice(beforeCalls).map((call) => call.timeoutMs),
      [45_000, 45_000],
    );
    assert.equal(calls.length - beforeCalls, 2);
  } finally {
    clock.mock.restore();
  }
});
