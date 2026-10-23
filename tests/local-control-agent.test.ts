import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LOCAL_CONTROL_PROTOCOL,
  type LocalControlInfo,
  type LocalControlRunObservation,
} from '@/lib/local-control-protocol';
import {
  LOCAL_CONTROL_TOOL_NAME,
  runLocalControlAgentTask,
  type LocalControlAgentTurn,
} from '@/lib/server/local-control-agent';

const taskId = `localtask_${'a'.repeat(32)}`;
const machine: LocalControlInfo = {
  protocol: LOCAL_CONTROL_PROTOCOL,
  mode: 'local-user-shell',
  username: 'bird',
  uid: 501,
  hostname: 'bird-mac',
  platform: 'darwin',
  shell: '/bin/zsh',
  default_cwd: '/Users/bird/project',
  concurrency: 1,
  maximum_timeout_seconds: 86_400,
  started_at: '2026-09-15T00:00:00.000Z',
};

function observation(
  overrides: Partial<LocalControlRunObservation> = {},
): LocalControlRunObservation {
  return {
    protocol: LOCAL_CONTROL_PROTOCOL,
    task_id: taskId,
    run_id: `shell_${'b'.repeat(32)}`,
    idempotency_key: 'step-1',
    status: 'succeeded',
    command: 'pwd',
    cwd: '/Users/bird/project',
    shell: '/bin/zsh',
    timeout_seconds: 3600,
    reason: '确认工作目录',
    pid: null,
    exit_code: 0,
    signal: null,
    stdout: '/Users/bird/project\n',
    stderr: '',
    stdout_truncated: false,
    stderr_truncated: false,
    cancellation_requested: false,
    created_at: '2026-09-15T00:00:00.000Z',
    started_at: '2026-09-15T00:00:00.010Z',
    finished_at: '2026-09-15T00:00:00.020Z',
    error: null,
    ...overrides,
  };
}

describe('Local Control Agent', () => {
  it('把当前用户身份写进提示，执行结构化命令后只按真实终态收尾', async () => {
    const calls: Parameters<LocalControlAgentTurn>[0][] = [];
    const turns: Awaited<ReturnType<LocalControlAgentTurn>>[] = [
      {
        ok: true,
        model: 'qwen-plus',
        text: null,
        toolCalls: [
          {
            id: 'call_1',
            name: LOCAL_CONTROL_TOOL_NAME,
            arguments: JSON.stringify({
              protocol: LOCAL_CONTROL_PROTOCOL,
              task_id: taskId,
              idempotency_key: 'step-1',
              command: 'pwd',
              reason: '确认工作目录',
            }),
          },
        ],
      },
      {
        ok: true,
        model: 'qwen-plus',
        text: '已确认当前目录。审计运行号 shell_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb。',
        toolCalls: [],
      },
    ];
    const result = await runLocalControlAgentTask({
      taskId,
      task: '告诉我当前目录',
      machine,
      turn: async (input) => {
        calls.push(input);
        return turns.shift()!;
      },
      execute: async () => ({ kind: 'result', observation: observation() }),
    });

    assert.equal(result.succeeded, true);
    assert.equal(result.usedShell, true);
    assert.equal(result.commands, 1);
    assert.equal(result.stopReason, 'completed');
    const systemMessage = calls[0].messages[0];
    assert.equal(systemMessage.role, 'system');
    assert.match(systemMessage.content ?? '', /bird/);
    assert.match(systemMessage.content ?? '', /不是容器、不是沙箱/);
    assert.equal(calls[0].tools[0]?.function.name, 'run_shell');
    assert.equal(calls[1].messages.at(-1)?.role, 'tool');
    assert.match(
      calls[1].messages.at(-1)?.content ?? '',
      /"status":"succeeded"/,
    );
  });

  it('取消后下一轮不再给模型工具', async () => {
    const toolCounts: number[] = [];
    const result = await runLocalControlAgentTask({
      taskId,
      task: '运行一个任务',
      machine,
      turn: async (input) => {
        toolCounts.push(input.tools.length);
        if (toolCounts.length === 1) {
          return {
            ok: true,
            model: 'qwen-plus',
            text: null,
            toolCalls: [
              {
                id: 'call_cancel',
                name: 'run_shell',
                arguments: JSON.stringify({
                  protocol: LOCAL_CONTROL_PROTOCOL,
                  task_id: taskId,
                  idempotency_key: 'cancelled-step',
                  command: 'sleep 30',
                  reason: '测试取消',
                }),
              },
            ],
          };
        }
        return {
          ok: true,
          model: 'qwen-plus',
          text: '命令已被取消，没有继续执行。',
          toolCalls: [],
        };
      },
      execute: async () => ({
        kind: 'result',
        observation: observation({
          run_id: `shell_${'c'.repeat(32)}`,
          idempotency_key: 'cancelled-step',
          status: 'cancelled',
          command: 'sleep 30',
          exit_code: null,
          cancellation_requested: true,
          error: { code: 'CANCELLED', message: 'The command was cancelled.' },
        }),
      }),
    });
    assert.deepEqual(toolCounts, [1, 0]);
    assert.equal(result.stopReason, 'cancelled');
    assert.equal(result.succeeded, false);
  });

  it('伪造 task_id 的工具调用不会到达执行器', async () => {
    let executed = false;
    const responses = [
      {
        ok: true as const,
        model: 'qwen-plus',
        text: null,
        toolCalls: [
          {
            id: 'bad',
            name: 'run_shell',
            arguments: JSON.stringify({
              protocol: LOCAL_CONTROL_PROTOCOL,
              task_id: `localtask_${'f'.repeat(32)}`,
              idempotency_key: 'bad-task',
              command: 'pwd',
              reason: '试图越权',
            }),
          },
        ],
      },
      {
        ok: true as const,
        model: 'qwen-plus',
        text: '任务编号不匹配，未执行。',
        toolCalls: [],
      },
    ];
    const result = await runLocalControlAgentTask({
      taskId,
      task: '检查',
      machine,
      turn: async () => responses.shift()!,
      execute: async () => {
        executed = true;
        return { kind: 'result', observation: observation() };
      },
    });
    assert.equal(executed, false);
    assert.equal(result.stopReason, 'tool_rejected');
  });
});
