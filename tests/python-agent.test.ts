import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatToolCall, ChatToolDefinition } from '@/lib/server/llm';
import {
  PYTHON_AGENT_MAX_ATTEMPTS,
  findReplyViolations,
  runPythonAgentTask,
  validateRunPythonCall,
  type PythonAgentInputFile,
  type PythonAgentMessage,
  type PythonAgentToolOutcome,
  type PythonAgentTurn,
  type PythonRunArtifact,
  type PythonRunErrorCode,
  type PythonRunObservation,
  type PythonRunStatus,
} from '@/lib/server/python-agent';

const TASK_ID = `task_${'e'.repeat(32)}`;
const AUTHORIZED_FILE: PythonAgentInputFile = {
  fileId: `file_${'a'.repeat(32)}`,
  mountName: 'data.csv',
  displayName: '销售数据.csv',
  sizeBytes: 2048,
};
const SECOND_FILE: PythonAgentInputFile = {
  fileId: `file_${'b'.repeat(32)}`,
  mountName: 'orders.json',
  displayName: '订单.json',
  sizeBytes: 512,
};

function makeObservation(input: {
  attempt: number;
  runId?: string;
  status: PythonRunStatus;
  exitCode?: number | null;
  errorCode?: PythonRunErrorCode | null;
  retryable?: boolean;
  fingerprint?: string;
  stdout?: string;
  artifacts?: PythonRunArtifact[];
  cleanupStatus?: 'pending' | 'succeeded' | 'failed';
}): PythonRunObservation {
  const code = input.errorCode ?? null;
  return {
    runId: input.runId ?? `run_${String(input.attempt).padStart(32, '0')}`,
    attempt: input.attempt,
    profile: 'short',
    status: input.status,
    exitCode: input.exitCode ?? (input.status === 'succeeded' ? 0 : 1),
    stdout: input.stdout ?? '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    cleanupStatus: input.cleanupStatus ?? 'succeeded',
    createdAt: '2026-09-15T00:00:00.000Z',
    startedAt: '2026-09-15T00:00:00.005Z',
    finishedAt: '2026-09-15T00:00:00.025Z',
    artifacts: input.artifacts ?? [],
    error: code
      ? {
          code,
          message: `模拟错误 ${code}`,
          retryable: input.retryable ?? true,
          fingerprint: input.fingerprint ?? `sha256:${input.attempt}`,
        }
      : null,
    metrics: {
      queuedMs: 5,
      durationMs: 20,
      cpuTimeMs: null,
      peakMemoryBytes: null,
    },
    limits: {
      timeoutSeconds: 30,
      cpuCount: 1,
      memoryBytes: 512 * 1024 * 1024,
      processes: 64,
      stdoutBytes: 1024 * 1024,
      stderrBytes: 1024 * 1024,
    },
  };
}

type ScriptStep =
  | { text: string }
  | {
      text?: string;
      toolCalls: Array<{ name?: string; arguments: unknown }>;
    };

type ScriptedTurn = {
  turn: PythonAgentTurn;
  seen: Array<{
    messages: PythonAgentMessage[];
    tools: ChatToolDefinition[];
    toolChoice: 'auto' | 'none';
  }>;
};

/** 按脚本逐轮回放模型输出，并记录每轮看到的 messages/tools。 */
function scriptedTurn(steps: ScriptStep[]): ScriptedTurn {
  const seen: ScriptedTurn['seen'] = [];
  let index = 0;
  return {
    seen,
    turn: async (input) => {
      seen.push({
        messages: input.messages,
        tools: input.tools,
        toolChoice: input.toolChoice,
      });
      const step = steps[index];
      index += 1;
      if (!step)
        return {
          ok: true,
          text: '（脚本已用完）',
          toolCalls: [],
          model: 'test-model',
        };
      if (!('toolCalls' in step)) {
        return {
          ok: true,
          text: step.text,
          toolCalls: [],
          model: 'test-model',
        };
      }
      const toolCalls: ChatToolCall[] = step.toolCalls.map(
        (call, callIndex) => ({
          id: `call_${index}_${callIndex}`,
          name: call.name ?? 'run_python',
          arguments:
            typeof call.arguments === 'string'
              ? call.arguments
              : JSON.stringify(call.arguments),
        }),
      );
      return {
        ok: true,
        text: step.text ?? null,
        toolCalls,
        model: 'test-model',
      };
    },
  };
}

function runCall(options: {
  attempt: number;
  code?: string;
  idempotencyKey?: string;
  inputFiles?: Array<{ file_id: string; mount_name: string }>;
  timeoutSeconds?: number;
  taskId?: string;
  protocol?: string;
}): Record<string, unknown> {
  return {
    protocol: options.protocol ?? 'urtoris.python-executor.v1',
    task_id: options.taskId ?? TASK_ID,
    idempotency_key:
      options.idempotencyKey ?? `${TASK_ID}:attempt:${options.attempt}`,
    attempt: options.attempt,
    code: options.code ?? 'print("hi")',
    input_files: options.inputFiles ?? [],
    timeout_seconds: options.timeoutSeconds ?? 30,
  };
}

function validate(
  value: unknown,
  overrides: Partial<{
    inputs: PythonAgentInputFile[];
    nextAttempt: number;
    idempotencyKeys: Map<string, number>;
  }> = {},
) {
  return validateRunPythonCall(value, {
    taskId: TASK_ID,
    inputs: overrides.inputs ?? [AUTHORIZED_FILE, SECOND_FILE],
    nextAttempt: overrides.nextAttempt ?? 1,
    idempotencyKeys: overrides.idempotencyKeys ?? new Map(),
  });
}

describe('run_python 参数校验', () => {
  it('接受合法调用，并把缺省 timeout 补成 30', () => {
    const withoutTimeout = runCall({ attempt: 1 });
    delete withoutTimeout.timeout_seconds;
    const result = validate(withoutTimeout);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.call.timeout_seconds, 30);
    assert.equal(result.call.task_id, TASK_ID);
  });

  it('拒绝伪造的 task_id、未知字段和错误协议', () => {
    const forged = validate(runCall({ attempt: 1, taskId: 'task_other' }));
    assert.equal(forged.ok, false);
    assert.equal(
      forged.ok === false && forged.rejection.code,
      'INVALID_REQUEST',
    );

    const unknown = validate({ ...runCall({ attempt: 1 }), extra: 1 });
    assert.equal(unknown.ok, false);
    assert.match(
      unknown.ok === false ? unknown.rejection.message : '',
      /extra/,
    );

    const protocol = validate(runCall({ attempt: 1, protocol: 'urtoris.v1' }));
    assert.equal(protocol.ok, false);
  });

  it('拒绝未授权的 file_id，并拒绝改名的 mount_name', () => {
    const unauthorized = validate(
      runCall({
        attempt: 1,
        inputFiles: [
          { file_id: `file_${'c'.repeat(32)}`, mount_name: 'data.csv' },
        ],
      }),
    );
    assert.equal(unauthorized.ok, false);
    assert.equal(
      unauthorized.ok === false && unauthorized.rejection.code,
      'FILE_UNAVAILABLE',
    );

    const renamed = validate(
      runCall({
        attempt: 1,
        inputFiles: [
          { file_id: AUTHORIZED_FILE.fileId, mount_name: 'other.csv' },
        ],
      }),
    );
    assert.equal(renamed.ok, false);
    assert.match(
      renamed.ok === false ? renamed.rejection.message : '',
      /data\.csv/,
    );
  });

  it('一次只接受一个合法挂载：重复文件、非法扩展名都拒绝', () => {
    const duplicated = validate(
      runCall({
        attempt: 1,
        inputFiles: [
          { file_id: AUTHORIZED_FILE.fileId, mount_name: 'data.csv' },
          { file_id: AUTHORIZED_FILE.fileId, mount_name: 'data2.csv' },
        ],
      }),
    );
    assert.equal(duplicated.ok, false);

    const badExtension = validate(
      runCall({
        attempt: 1,
        inputFiles: [
          { file_id: AUTHORIZED_FILE.fileId, mount_name: 'data.xlsx' },
        ],
      }),
    );
    assert.equal(badExtension.ok, false);
  });

  it('接受 xlsx 与图片挂载名，拒绝其他扩展名', () => {
    const workbook: PythonAgentInputFile = {
      fileId: `file_${'f'.repeat(32)}`,
      mountName: 'book.xlsx',
      displayName: '台账.xlsx',
      sizeBytes: 4096,
    };
    const accepted = validate(
      runCall({
        attempt: 1,
        inputFiles: [{ file_id: workbook.fileId, mount_name: 'book.xlsx' }],
      }),
      { inputs: [workbook] },
    );
    assert.equal(accepted.ok, true);

    const rejected = validate(
      runCall({
        attempt: 1,
        inputFiles: [{ file_id: workbook.fileId, mount_name: 'book.exe' }],
      }),
      { inputs: [workbook] },
    );
    assert.equal(rejected.ok, false);
    assert.equal(
      rejected.ok === false && rejected.rejection.code,
      'INVALID_REQUEST',
    );
  });

  it('attempt 必须等于下一次可用次数，超过三次直接 ATTEMPT_LIMIT', () => {
    const wrongAttempt = validate(runCall({ attempt: 2 }), { nextAttempt: 1 });
    assert.equal(wrongAttempt.ok, false);
    assert.match(
      wrongAttempt.ok === false ? wrongAttempt.rejection.message : '',
      /attempt 必须等于 1/,
    );

    const exhausted = validate(runCall({ attempt: 4 }), { nextAttempt: 4 });
    assert.equal(exhausted.ok, false);
    assert.equal(
      exhausted.ok === false && exhausted.rejection.code,
      'ATTEMPT_LIMIT',
    );
  });

  it('超时、代码体积和幂等键都按限额拒绝', () => {
    assert.equal(
      validate(runCall({ attempt: 1, timeoutSeconds: 31 })).ok,
      false,
    );
    assert.equal(
      validate(runCall({ attempt: 1, timeoutSeconds: 0 })).ok,
      false,
    );
    assert.equal(
      validate(runCall({ attempt: 1, code: 'x'.repeat(64 * 1024 + 1) })).ok,
      false,
    );
    assert.equal(
      validate(runCall({ attempt: 1, idempotencyKey: 'bad key' })).ok,
      false,
    );

    const reused = validate(runCall({ attempt: 2, idempotencyKey: 'k' }), {
      nextAttempt: 2,
      idempotencyKeys: new Map([['k', 1]]),
    });
    assert.equal(reused.ok, false);
    assert.equal(
      reused.ok === false && reused.rejection.code,
      'IDEMPOTENCY_CONFLICT',
    );
  });
});

describe('Python Agent 自动修复状态机', () => {
  it('把同一会话更早的轮次放在系统提示之后、当前任务之前', async () => {
    const script = scriptedTurn([{ text: '这次不需要 Python。' }]);
    await runPythonAgentTask({
      taskId: TASK_ID,
      task: '把这份聊天记录写成 PDF',
      inputs: [],
      artifactsAllowed: true,
      history: [
        { role: 'user', content: '先帮我把销售数据整理成表' },
        { role: 'assistant', content: '已经整理成表，共 12 行。' },
      ],
      turn: script.turn,
      execute: async () => {
        throw new Error('这条路径不应该执行代码');
      },
    });

    const first = script.seen[0].messages;
    assert.equal(first.length, 4);
    assert.equal(first[0].role, 'system');
    assert.match(first[0].content as string, /更早的对话记录：已注入/);
    assert.deepEqual(first.slice(1), [
      { role: 'user', content: '先帮我把销售数据整理成表' },
      { role: 'assistant', content: '已经整理成表，共 12 行。', toolCalls: [] },
      { role: 'user', content: '把这份聊天记录写成 PDF' },
    ]);
  });

  it('没有历史时明确写「无」，不注入空的轮次', async () => {
    const script = scriptedTurn([{ text: '这次不需要 Python。' }]);
    await runPythonAgentTask({
      taskId: TASK_ID,
      task: '这个聊天框里的所有的记录',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async () => {
        throw new Error('这条路径不应该执行代码');
      },
    });

    const first = script.seen[0].messages;
    assert.equal(first.length, 2);
    assert.match(first[0].content as string, /更早的对话记录：无/);
    assert.equal(first[1].content, '这个聊天框里的所有的记录');
  });

  it('一次成功即停：只执行一次，并把 artifact 和收尾文本如实返回', async () => {
    const script = scriptedTurn([
      { toolCalls: [{ arguments: runCall({ attempt: 1 }) }] },
      {
        text: '已完成。运行了统计脚本，共执行 1 次。生成文件：summary.csv（下载入口见页面）。',
      },
    ]);
    const calls: number[] = [];
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '统计 CSV 行数并输出 summary.csv',
      inputs: [AUTHORIZED_FILE],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async (call) => {
        calls.push(call.attempt);
        return {
          kind: 'result',
          observation: makeObservation({
            attempt: call.attempt,
            status: 'succeeded',
            exitCode: 0,
            stdout: 'rows=3\n',
            artifacts: [
              {
                artifactId: `artifact_${'d'.repeat(32)}`,
                name: 'summary.csv',
                mimeType: 'text/csv',
                sizeBytes: 21,
              },
            ],
          }),
        };
      },
    });

    assert.deepEqual(calls, [1]);
    assert.equal(result.attempts, 1);
    assert.equal(result.succeeded, true);
    assert.equal(result.stopReason, 'succeeded');
    assert.equal(result.replySource, 'model');
    assert.deepEqual(
      result.artifacts.map((artifact) => artifact.name),
      ['summary.csv'],
    );
    // 成功之后不再给工具，模型只能收尾。
    assert.equal(script.seen[1]?.tools.length, 0);
    assert.equal(script.seen[1]?.toolChoice, 'none');
    assert.equal(script.seen[1]?.messages.at(-1)?.role, 'tool');
  });

  it('明确要求文件时，不接受只给命令的回答，会再次要求实际执行', async () => {
    const script = scriptedTurn([
      { text: '请先运行 pip install reportlab，然后执行下面的代码。' },
      {
        toolCalls: [
          {
            arguments: runCall({
              attempt: 1,
              code: 'open("output/hello.pdf", "wb").write(b"%PDF-1.4\\n%%EOF\\n")',
            }),
          },
        ],
      },
      { text: '已完成。已生成文件：hello.pdf。' },
    ]);
    let executed = 0;
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '生成一个 PDF，在里面写 Hello World',
      inputs: [],
      artifactsAllowed: true,
      requireArtifact: true,
      turn: script.turn,
      execute: async (call) => {
        executed += 1;
        return {
          kind: 'result',
          observation: makeObservation({
            attempt: call.attempt,
            status: 'succeeded',
            artifacts: [
              {
                artifactId: `artifact_${'f'.repeat(32)}`,
                name: 'hello.pdf',
                mimeType: 'application/pdf',
                sizeBytes: 512,
              },
            ],
          }),
        };
      },
    });

    assert.equal(executed, 1);
    assert.equal(result.succeeded, true);
    assert.equal(result.artifacts[0]?.name, 'hello.pdf');
    assert.equal(script.seen.length, 3);
    assert.match(
      String(script.seen[1]?.messages.at(-1)?.content),
      /必须现在调用 run_python/,
    );
  });

  it('可修复错误会带着真实结果重试，最多三次', async () => {
    const script = scriptedTurn([
      { toolCalls: [{ arguments: runCall({ attempt: 1 }) }] },
      { toolCalls: [{ arguments: runCall({ attempt: 2 }) }] },
      { toolCalls: [{ arguments: runCall({ attempt: 3 }) }] },
      {
        text: '已完成。修正了列名后重跑，共执行 3 次。生成文件：summary.csv（下载入口见页面）。',
      },
    ]);
    const attempts: number[] = [];
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '统计',
      inputs: [AUTHORIZED_FILE],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async (call) => {
        attempts.push(call.attempt);
        if (call.attempt < 3) {
          return {
            kind: 'result',
            observation: makeObservation({
              attempt: call.attempt,
              status: 'failed',
              errorCode: 'PROCESS_EXIT_NONZERO',
              retryable: true,
              fingerprint: `sha256:fingerprint-${call.attempt}`,
              stdout: 'traceback',
            }),
          };
        }
        return {
          kind: 'result',
          observation: makeObservation({
            attempt: call.attempt,
            status: 'succeeded',
            exitCode: 0,
            artifacts: [
              {
                artifactId: `artifact_${'d'.repeat(32)}`,
                name: 'summary.csv',
                mimeType: 'text/csv',
                sizeBytes: 21,
              },
            ],
          }),
        };
      },
    });

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.equal(result.attempts, PYTHON_AGENT_MAX_ATTEMPTS);
    assert.equal(result.succeeded, true);
    assert.equal(result.stopReason, 'succeeded');
    assert.equal(result.lastError, null);
  });

  it('超时等不可修复错误立即停止并只让模型收尾', async () => {
    const script = scriptedTurn([
      { toolCalls: [{ arguments: runCall({ attempt: 1 }) }] },
      {
        text: '这次没有成功完成。已执行 1 次，最后状态为 timed_out，错误为 TIMEOUT：超过 30 秒上限。',
      },
    ]);
    let executed = 0;
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '跑一个死循环',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async (call) => {
        executed += 1;
        return {
          kind: 'result',
          observation: makeObservation({
            attempt: call.attempt,
            status: 'timed_out',
            exitCode: null,
            errorCode: 'TIMEOUT',
            retryable: false,
          }),
        };
      },
    });

    assert.equal(executed, 1);
    assert.equal(result.stopReason, 'non_retryable_failure');
    assert.equal(script.seen[1]?.toolChoice, 'none');
    assert.equal(script.seen[1]?.tools.length, 0);
    assert.equal(result.replySource, 'model');
    assert.match(result.reply, /最后状态为 timed_out/);
  });

  it('停止后模型没写收尾时，用确定性失败模板兜底', async () => {
    let turnIndex = 0;
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '跑一个死循环',
      inputs: [],
      artifactsAllowed: true,
      maxModelTurns: 2,
      turn: async () => {
        turnIndex += 1;
        if (turnIndex === 1) {
          return {
            ok: true,
            text: null,
            toolCalls: [
              {
                id: 'call_1',
                name: 'run_python',
                arguments: JSON.stringify(runCall({ attempt: 1 })),
              },
            ],
            model: 'test-model',
          };
        }
        return { ok: true, text: null, toolCalls: [], model: 'test-model' };
      },
      execute: async (call) => ({
        kind: 'result',
        observation: makeObservation({
          attempt: call.attempt,
          status: 'timed_out',
          exitCode: null,
          errorCode: 'TIMEOUT',
          retryable: false,
        }),
      }),
    });

    assert.equal(result.stopReason, 'non_retryable_failure');
    assert.equal(result.replySource, 'fallback');
    assert.match(
      result.reply,
      /这次没有成功完成。已执行 1 次，最后状态为 timed_out，错误为 TIMEOUT/,
    );
    assert.match(result.reply, /在 30 秒墙钟上限内被终止/);
  });

  it('同一个 error_fingerprint 连续两次就停止，不再消耗第三次', async () => {
    const script = scriptedTurn([
      { toolCalls: [{ arguments: runCall({ attempt: 1 }) }] },
      { toolCalls: [{ arguments: runCall({ attempt: 2 }) }] },
      { text: '这次没有成功完成。已执行 2 次，最后状态为 failed。' },
    ]);
    const attempts: number[] = [];
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '同一处语法错误重跑',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async (call) => {
        attempts.push(call.attempt);
        return {
          kind: 'result',
          observation: makeObservation({
            attempt: call.attempt,
            status: 'failed',
            errorCode: 'PROCESS_EXIT_NONZERO',
            retryable: true,
            fingerprint: 'sha256:same',
          }),
        };
      },
    });

    assert.deepEqual(attempts, [1, 2]);
    assert.equal(result.stopReason, 'repeated_fingerprint');
    assert.equal(result.replySource, 'model');
  });

  it('第三次失败后即使模型继续要跑也不会执行第四次', async () => {
    const script = scriptedTurn([
      { toolCalls: [{ arguments: runCall({ attempt: 1 }) }] },
      { toolCalls: [{ arguments: runCall({ attempt: 2 }) }] },
      { toolCalls: [{ arguments: runCall({ attempt: 3 }) }] },
      { toolCalls: [{ arguments: runCall({ attempt: 3 }) }] },
      {
        text: '这次没有成功完成。已执行 3 次，最后状态为 failed，错误为 PROCESS_EXIT_NONZERO。',
      },
    ]);
    const attempts: number[] = [];
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '连续失败',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async (call) => {
        attempts.push(call.attempt);
        return {
          kind: 'result',
          observation: makeObservation({
            attempt: call.attempt,
            status: 'failed',
            errorCode: 'PROCESS_EXIT_NONZERO',
            retryable: true,
            fingerprint: `sha256:fingerprint-${call.attempt}`,
          }),
        };
      },
    });

    assert.deepEqual(attempts, [1, 2, 3]);
    assert.equal(result.attempts, 3);
    assert.equal(result.stopReason, 'attempt_limit');
    // 第 4 次请求被拒：返回 ATTEMPT_LIMIT，但不创建新的运行。
    const lastToolMessage = script.seen[4]?.messages.at(-1);
    assert.equal(lastToolMessage?.role, 'tool');
    assert.match(
      lastToolMessage?.role === 'tool' ? lastToolMessage.content : '',
      /ATTEMPT_LIMIT/,
    );
  });

  it('工具级拒绝（存在与越权都是 FILE_UNAVAILABLE）会停止并给出一句可执行建议', async () => {
    const script = scriptedTurn([
      { toolCalls: [{ arguments: runCall({ attempt: 1 }) }] },
      { text: '这次没有运行 Python：需要先重新上传数据文件。' },
    ]);
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '统计一份还没上传的 CSV',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async (): Promise<PythonAgentToolOutcome> => ({
        kind: 'rejected',
        code: 'FILE_UNAVAILABLE',
        message: 'The file is not available for this task.',
        retryable: false,
      }),
    });

    assert.equal(result.attempts, 0);
    assert.equal(result.stopReason, 'tool_rejected');
    assert.equal(result.rejection?.code, 'FILE_UNAVAILABLE');
    assert.match(result.rejection?.action ?? '', /重新上传/);
    assert.equal(script.seen[1]?.toolChoice, 'none');
  });

  it('伪造 task_id 被拒后模型改口直接回答时，仍记为 tool_rejected', async () => {
    const script = scriptedTurn([
      {
        toolCalls: [
          { arguments: runCall({ attempt: 1, taskId: 'task_forged' }) },
        ],
      },
      { text: '我没有执行代码：工具拒绝了这次调用。' },
    ]);
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '统计',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async () => {
        throw new Error('伪造参数不应该触达执行器');
      },
    });
    assert.equal(result.attempts, 0);
    assert.equal(result.stopReason, 'tool_rejected');
    assert.equal(result.rejection?.code, 'INVALID_REQUEST');
  });

  it('不需要 Python 时直接回答，不调用工具', async () => {
    const script = scriptedTurn([
      { text: '这个问题不需要计算，直接回答即可。' },
    ]);
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '解释一下什么是 CSV',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async () => {
        throw new Error('不应该调用执行器');
      },
    });
    assert.equal(result.attempts, 0);
    assert.equal(result.usedPython, false);
    assert.equal(result.stopReason, 'no_python_needed');
    assert.equal(result.reply, '这个问题不需要计算，直接回答即可。');
  });

  it('模型把失败写成成功时，叙述被确定性模板替换', async () => {
    const script = scriptedTurn([
      { toolCalls: [{ arguments: runCall({ attempt: 1 }) }] },
      {
        text: '已完成。运行了统计脚本，生成文件：summary.csv（下载入口见页面）。',
      },
    ]);
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '统计',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async (call) => ({
        kind: 'result',
        observation: makeObservation({
          attempt: call.attempt,
          status: 'failed',
          errorCode: 'PROCESS_EXIT_NONZERO',
          retryable: false,
          fingerprint: 'sha256:x',
        }),
      }),
    });

    assert.equal(result.replySource, 'guard');
    assert.ok(result.replyViolations.length >= 1);
    assert.match(result.reply, /这次没有成功完成/);
    assert.doesNotMatch(result.reply, /已完成/);
  });

  it('退出码为 0 但容器清理失败时不算成功', async () => {
    const script = scriptedTurn([
      { toolCalls: [{ arguments: runCall({ attempt: 1 }) }] },
      { text: '已完成。运行了统计脚本，共执行 1 次。' },
    ]);
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '统计',
      inputs: [],
      artifactsAllowed: true,
      turn: script.turn,
      execute: async (call) => ({
        kind: 'result',
        observation: makeObservation({
          attempt: call.attempt,
          status: 'succeeded',
          exitCode: 0,
          cleanupStatus: 'failed',
        }),
      }),
    });

    assert.equal(result.stopReason, 'cleanup_failed');
    assert.equal(result.succeeded, false);
    assert.equal(result.replySource, 'guard');
    assert.match(result.reply, /这次没有成功完成/);
  });

  it('回答诚实性检查拦得住「应该已经生成」这类措辞', () => {
    assert.deepEqual(
      findReplyViolations('文件应该已经生成了。', {
        usedPython: true,
        successfulRuns: 1,
        artifactCount: 1,
      }).length,
      1,
    );
    assert.deepEqual(
      findReplyViolations('已完成。', {
        usedPython: false,
        successfulRuns: 0,
        artifactCount: 0,
      }),
      [],
    );
    assert.equal(
      findReplyViolations('已生成文件：a.csv', {
        usedPython: true,
        successfulRuns: 1,
        artifactCount: 0,
      }).length,
      1,
    );
  });

  it('模型既不给文本也不给工具调用时，按轮次上限兜底成失败模板', async () => {
    const script = scriptedTurn([]);
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '做点什么',
      inputs: [],
      artifactsAllowed: true,
      maxModelTurns: 2,
      turn: async (input) => {
        script.seen.push(input);
        return { ok: true, text: null, toolCalls: [], model: 'test-model' };
      },
      execute: async () => {
        throw new Error('不应该调用执行器');
      },
    });

    assert.equal(script.seen.length, 2);
    assert.equal(result.attempts, 0);
    assert.equal(result.stopReason, 'model_turn_limit');
    assert.match(result.reply, /没有提交 run_python 调用/);
  });

  it('模型服务失败时如实返回 llm_error，不伪造成运行结果', async () => {
    const result = await runPythonAgentTask({
      taskId: TASK_ID,
      task: '算一下',
      inputs: [],
      artifactsAllowed: true,
      turn: async () => ({
        ok: false,
        code: 'RATE_LIMITED',
        error: '模型服务返回 429。',
      }),
      execute: async () => {
        throw new Error('不应该调用执行器');
      },
    });
    assert.equal(result.stopReason, 'llm_error');
    assert.equal(result.llmError?.code, 'RATE_LIMITED');
    assert.equal(result.attempts, 0);
    assert.match(result.reply, /模型服务调用失败/);
  });
});
