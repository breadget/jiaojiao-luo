import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { POST } from '@/app/api/python/agent/route';
import { createPythonTaskCapability } from '@/lib/server/python-task-capability';
import { resetEnv } from './helpers/cloudflare-workers-stub';

const API_TOKEN = 'test-api-token-for-python-agent';
const EXECUTOR_TOKEN = 'p'.repeat(48);
const SIGNING_KEY = 's'.repeat(48);
const EXECUTOR_BASE = 'http://127.0.0.1:3010';
const MODEL_BASE = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const originalFetch = globalThis.fetch;

let addressCounter = 0;
function nextAddress(): string {
  addressCounter += 1;
  return `10.1.0.${(addressCounter % 250) + 1}`;
}

type FetchCall = { url: string; init: RequestInit | undefined; body: unknown };

function installFetch(handler: {
  executor: (call: FetchCall) => Response | Promise<Response>;
  model: (call: FetchCall, index: number) => Response | Promise<Response>;
}): FetchCall[] {
  const calls: FetchCall[] = [];
  let modelIndex = 0;
  globalThis.fetch = (async (input, init) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const call: FetchCall = {
      url,
      init: init ?? undefined,
      body: rawBody ? JSON.parse(rawBody) : null,
    };
    calls.push(call);
    if (url.startsWith(EXECUTOR_BASE)) return handler.executor(call);
    modelIndex += 1;
    return handler.model(call, modelIndex);
  }) as typeof fetch;
  return calls;
}

function executorRunResult(options: {
  taskId: string;
  attempt: number;
  status?: string;
  exitCode?: number | null;
  errorCode?: string | null;
  retryable?: boolean;
  artifact?: boolean;
  profile?: 'short' | 'long';
}): Response {
  const status = options.status ?? 'succeeded';
  const succeeded = status === 'succeeded';
  const pending = status === 'queued' || status === 'running';
  return Response.json({
    protocol: 'urtoris.python-executor.v1',
    task_id: options.taskId,
    run_id: `run_${'1'.repeat(32)}`,
    attempt: options.attempt,
    parent_run_id: null,
    profile: options.profile ?? 'short',
    status,
    exit_code:
      options.exitCode !== undefined
        ? options.exitCode
        : pending
          ? null
          : succeeded
            ? 0
            : 1,
    stdout: pending ? null : 'rows=3\n',
    stderr: pending
      ? null
      : succeeded
      ? ''
      : 'Traceback (most recent call last):\nValueError: boom',
    stdout_truncated: false,
    stderr_truncated: false,
    artifacts: options.artifact
      ? [
          {
            artifact_id: `artifact_${'2'.repeat(32)}`,
            name: 'summary.csv',
            mime_type: 'text/csv',
            size_bytes: 21,
            sha256: `sha256:${'3'.repeat(64)}`,
          },
        ]
      : [],
    error: options.errorCode
      ? {
          code: options.errorCode,
          message: 'Simulated failure.',
          retryable: options.retryable ?? true,
          error_fingerprint: 'sha256:fingerprint',
        }
      : null,
    metrics: {
      queued_ms: 3,
      duration_ms: 40,
      cpu_time_ms: null,
      peak_memory_bytes: null,
    },
    limits: {
      timeout_seconds: 30,
      cpu_count: 1,
      memory_bytes: 536870912,
      processes: 64,
      stdout_bytes: 1048576,
      stderr_bytes: 1048576,
    },
    created_at: '2026-09-14T10:00:00.000Z',
    started_at:
      status === 'queued' ? null : '2026-09-14T10:00:00.010Z',
    finished_at: pending ? null : '2026-09-14T10:00:00.050Z',
    cleanup_status: pending ? 'pending' : 'succeeded',
  });
}

function toolCallResponse(argumentsValue: unknown): Response {
  return Response.json({
    model: 'qwen-plus',
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'run_python',
                arguments: JSON.stringify(argumentsValue),
              },
            },
          ],
        },
      },
    ],
  });
}

function textResponse(text: string): Response {
  return Response.json({
    model: 'qwen-plus',
    choices: [{ message: { content: text } }],
  });
}

async function agentRequest(options: {
  body: Record<string, unknown>;
  taskToken?: string | null;
}): Promise<Response> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json',
    'X-Real-IP': nextAddress(),
  };
  if (options.taskToken) headers['X-Urtoris-Task-Token'] = options.taskToken;
  return POST(
    new Request('https://studio.example.com/api/python/agent', {
      method: 'POST',
      headers,
      body: JSON.stringify(options.body),
    }),
  );
}

const ENABLED_ENV = {
  URTORIS_API_TOKEN: API_TOKEN,
  PYTHON_EXECUTOR_URL: EXECUTOR_BASE,
  PYTHON_EXECUTOR_TOKEN: EXECUTOR_TOKEN,
  PYTHON_TASK_SIGNING_KEY: SIGNING_KEY,
  PYTHON_AGENT_ENABLED: '1',
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetEnv();
});

describe('网站 → Python Agent 入口', () => {
  it('默认关闭：没有显式开关就不授予 run_python，也不调用任何外部服务', async () => {
    resetEnv({ ...ENABLED_ENV, PYTHON_AGENT_ENABLED: undefined });
    const calls = installFetch({
      executor: () => Response.json({}),
      model: () => Response.json({}),
    });
    const capability = await createPythonTaskCapability();
    const response = await agentRequest({
      taskToken: capability.taskToken,
      body: { taskId: capability.taskId, message: '统计一下这份 CSV' },
    });
    assert.equal(response.status, 503);
    const payload = (await response.json()) as { code?: string };
    assert.equal(payload.code, 'PYTHON_AGENT_DISABLED');
    assert.equal(calls.length, 0);
  });

  it('没有 task capability 时拒绝，且不调用执行器', async () => {
    resetEnv(ENABLED_ENV);
    const calls = installFetch({
      executor: () => Response.json({}),
      model: () => Response.json({}),
    });
    const capability = await createPythonTaskCapability();
    const response = await agentRequest({
      body: { taskId: capability.taskId, message: '统计' },
    });
    assert.equal(response.status, 403);
    assert.equal(calls.length, 0);
  });

  it('任务编号非法时返回 400', async () => {
    resetEnv(ENABLED_ENV);
    installFetch({
      executor: () => Response.json({}),
      model: () => Response.json({}),
    });
    const response = await agentRequest({
      body: { taskId: 'not-a-task', message: '统计' },
    });
    assert.equal(response.status, 400);
  });

  it('成功链路：工具调用 → 执行器 succeeded → 收尾文本，并把每次尝试暴露给网页', async () => {
    resetEnv(ENABLED_ENV);
    const capability = await createPythonTaskCapability();
    const fileId = `file_${'4'.repeat(32)}`;
    const calls = installFetch({
      executor: (call) =>
        executorRunResult({
          taskId: capability.taskId,
          attempt: (call.body as { attempt: number }).attempt,
          artifact: true,
        }),
      model: (_call, index) =>
        index === 1
          ? toolCallResponse({
              protocol: 'urtoris.python-executor.v1',
              task_id: capability.taskId,
              idempotency_key: `${capability.taskId}:attempt:1`,
              attempt: 1,
              code: 'print("rows=3")',
              input_files: [{ file_id: fileId, mount_name: 'sales.csv' }],
              timeout_seconds: 30,
            })
          : textResponse(
              '已完成。运行了行数统计脚本，共执行 1 次。生成文件：summary.csv（下载入口见页面）。',
            ),
    });

    const response = await agentRequest({
      taskToken: capability.taskToken,
      body: {
        taskId: capability.taskId,
        message: '统计 sales.csv 的行数并输出 summary.csv',
        inputs: [
          {
            fileId,
            mountName: 'sales.csv',
            displayName: '销售数据.csv',
            sizeBytes: 4096,
          },
        ],
        provider: 'qwen',
        apiKey: 'sk-test-key',
      },
    });

    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      reply: string;
      replySource: string;
      attempts: number;
      succeeded: boolean;
      stopReason: string;
      artifacts: Array<{ artifactId: string; name: string }>;
      runs: Array<{ status: string; artifactIds: string[] }>;
      provider: string;
      model: string;
    };
    assert.equal(payload.replySource, 'model');
    assert.equal(payload.attempts, 1);
    assert.equal(payload.succeeded, true);
    assert.equal(payload.stopReason, 'succeeded');
    assert.deepEqual(
      payload.artifacts.map((artifact) => artifact.name),
      ['summary.csv'],
    );
    assert.equal(payload.runs.length, 1);
    assert.equal(payload.runs[0]?.status, 'succeeded');
    assert.equal(payload.runs[0]?.artifactIds.length, 1);
    assert.equal(payload.provider, 'qwen');

    const executorCall = calls.find((call) =>
      call.url.startsWith(EXECUTOR_BASE),
    );
    assert.ok(executorCall);
    assert.equal(
      new Headers(executorCall.init?.headers).get('Authorization'),
      `Bearer ${EXECUTOR_TOKEN}`,
    );
    assert.equal(executorCall.url, `${EXECUTOR_BASE}/v1/runs`);
    assert.equal(
      (executorCall.body as { task_id: string }).task_id,
      capability.taskId,
    );

    const modelCalls = calls.filter((call) => call.url.startsWith(MODEL_BASE));
    assert.equal(modelCalls.length, 2);
    const firstModelBody = modelCalls[0]?.body as {
      tools?: Array<{ function: { name: string } }>;
      tool_choice?: string;
      messages: Array<{ role: string }>;
    };
    assert.equal(firstModelBody.tools?.[0]?.function.name, 'run_python');
    assert.equal(firstModelBody.tool_choice, 'auto');
    assert.equal(firstModelBody.messages[0]?.role, 'system');
    const secondModelBody = modelCalls[1]?.body as {
      tools?: unknown;
      messages: Array<{ role: string; content?: string }>;
    };
    assert.equal(secondModelBody.tools, undefined);
    assert.equal(secondModelBody.messages.at(-1)?.role, 'tool');

    // 页面拿到的响应里不能出现内部 token 或宿主路径。
    const serialized = JSON.stringify(payload);
    assert.doesNotMatch(serialized, new RegExp(EXECUTOR_TOKEN));
    assert.doesNotMatch(serialized, /\/workspace|\/var\/lib|python-executor/);
  });

  it('异步链路：POST 只接收 queued，之后轮询 running 到 succeeded', async () => {
    resetEnv(ENABLED_ENV);
    const capability = await createPythonTaskCapability();
    let reads = 0;
    const calls = installFetch({
      executor: (call) => {
        if ((call.init?.method ?? 'GET') === 'POST') {
          return executorRunResult({
            taskId: capability.taskId,
            attempt: 1,
            status: 'queued',
            exitCode: null,
            profile: 'long',
          });
        }
        reads += 1;
        return executorRunResult({
          taskId: capability.taskId,
          attempt: 1,
          status: reads === 1 ? 'running' : 'succeeded',
          exitCode: reads === 1 ? null : 0,
          profile: 'long',
        });
      },
      model: (_call, index) =>
        index === 1
          ? toolCallResponse({
              protocol: 'urtoris.python-executor.v1',
              task_id: capability.taskId,
              idempotency_key: `${capability.taskId}:attempt:1`,
              attempt: 1,
              code: 'print("done")',
              input_files: [],
              profile: 'long',
              timeout_seconds: 600,
            })
          : textResponse('运行已完成。'),
    });

    const response = await agentRequest({
      taskToken: capability.taskToken,
      body: {
        taskId: capability.taskId,
        message: '运行长任务',
        provider: 'qwen',
        apiKey: 'sk-test-key',
      },
    });
    const payload = (await response.json()) as {
      succeeded: boolean;
      runs: Array<{ profile: string; status: string }>;
    };

    assert.equal(response.status, 200);
    assert.equal(payload.succeeded, true);
    assert.equal(payload.runs[0]?.profile, 'long');
    assert.equal(payload.runs[0]?.status, 'succeeded');
    const executorCalls = calls.filter((call) =>
      call.url.startsWith(EXECUTOR_BASE),
    );
    assert.deepEqual(
      executorCalls.map((call) => call.init?.method),
      ['POST', 'GET', 'GET'],
    );
    assert.match(executorCalls[1]?.url ?? '', /\/v1\/runs\/run_/);
  });

  it('模型把失败说成成功时，页面拿到的是被替换过的诚实结论', async () => {
    resetEnv(ENABLED_ENV);
    const capability = await createPythonTaskCapability();
    installFetch({
      executor: (call) =>
        executorRunResult({
          taskId: capability.taskId,
          attempt: (call.body as { attempt: number }).attempt,
          status: 'failed',
          errorCode: 'PROCESS_EXIT_NONZERO',
          retryable: false,
        }),
      model: (_call, index) =>
        index === 1
          ? toolCallResponse({
              protocol: 'urtoris.python-executor.v1',
              task_id: capability.taskId,
              idempotency_key: `${capability.taskId}:attempt:1`,
              attempt: 1,
              code: 'raise ValueError("boom")',
              input_files: [],
              timeout_seconds: 30,
            })
          : textResponse(
              '已完成。运行了统计脚本，生成文件：summary.csv（下载入口见页面）。',
            ),
    });

    const response = await agentRequest({
      taskToken: capability.taskToken,
      body: {
        taskId: capability.taskId,
        message: '统计',
        provider: 'qwen',
        apiKey: 'sk-test-key',
      },
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      reply: string;
      replySource: string;
      guardViolations: string[];
      succeeded: boolean;
      lastError: { code: string } | null;
    };
    assert.equal(payload.replySource, 'guard');
    assert.equal(payload.succeeded, false);
    assert.ok(payload.guardViolations.length >= 1);
    assert.match(payload.reply, /这次没有成功完成/);
    assert.equal(payload.lastError?.code, 'PROCESS_EXIT_NONZERO');
  });

  it('执行器拒绝入队时如实回传 ATTEMPT_LIMIT，不换 key 绕过', async () => {
    resetEnv(ENABLED_ENV);
    const capability = await createPythonTaskCapability();
    installFetch({
      executor: () =>
        Response.json(
          {
            protocol: 'urtoris.python-executor.v1',
            task_id: capability.taskId,
            run_id: null,
            status: null,
            error: {
              code: 'ATTEMPT_LIMIT',
              message: 'The task has already used all three Python attempts.',
              retryable: false,
            },
          },
          { status: 409 },
        ),
      model: (_call, index) =>
        index === 1
          ? toolCallResponse({
              protocol: 'urtoris.python-executor.v1',
              task_id: capability.taskId,
              idempotency_key: `${capability.taskId}:attempt:1`,
              attempt: 1,
              code: 'print(1)',
              input_files: [],
              timeout_seconds: 30,
            })
          : textResponse(
              '这个任务已经不能再执行新的 Python 尝试，需要开始一个新任务。',
            ),
    });

    const response = await agentRequest({
      taskToken: capability.taskToken,
      body: {
        taskId: capability.taskId,
        message: '再来一次',
        provider: 'qwen',
        apiKey: 'sk-test-key',
      },
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as {
      attempts: number;
      stopReason: string;
      rejection: { code: string; action: string } | null;
    };
    assert.equal(payload.attempts, 0);
    assert.equal(payload.stopReason, 'tool_rejected');
    assert.equal(payload.rejection?.code, 'ATTEMPT_LIMIT');
    assert.match(payload.rejection?.action ?? '', /新任务/);
  });

  it('模型服务一开始就失败时返回 502，不假装跑过 Python', async () => {
    resetEnv(ENABLED_ENV);
    const capability = await createPythonTaskCapability();
    const calls = installFetch({
      executor: () => Response.json({}, { status: 500 }),
      model: () =>
        Response.json(
          { error: { message: 'quota exceeded' } },
          { status: 429 },
        ),
    });
    const response = await agentRequest({
      taskToken: capability.taskToken,
      body: {
        taskId: capability.taskId,
        message: '统计',
        provider: 'qwen',
        apiKey: 'sk-test-key',
      },
    });
    assert.equal(response.status, 502);
    const payload = (await response.json()) as {
      errorCode?: string;
      attempts: number;
      reply: string;
    };
    assert.equal(payload.errorCode, 'RATE_LIMITED');
    assert.equal(payload.attempts, 0);
    assert.match(payload.reply, /模型服务调用失败/);
    assert.equal(
      calls.filter((call) => call.url.startsWith(EXECUTOR_BASE)).length,
      0,
    );
  });
});
