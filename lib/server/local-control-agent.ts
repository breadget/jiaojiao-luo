import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
} from '@/lib/server/llm';
import {
  LOCAL_CONTROL_IDEMPOTENCY_KEY_PATTERN,
  LOCAL_CONTROL_LIMITS,
  LOCAL_CONTROL_PROTOCOL,
  type LocalControlInfo,
  type LocalControlRunObservation,
  type LocalControlSubmission,
} from '@/lib/local-control-protocol';

export const LOCAL_CONTROL_TOOL_NAME = 'run_shell';
export const LOCAL_CONTROL_MAX_COMMANDS = 12;
export const LOCAL_CONTROL_MAX_MODEL_TURNS = 18;

export const LOCAL_CONTROL_TOOL: ChatToolDefinition = {
  type: 'function',
  function: {
    name: LOCAL_CONTROL_TOOL_NAME,
    description:
      '在用户这台 Mac 上，以当前登录用户身份执行任意 zsh 命令。命令不在容器或沙箱内运行，可读写该用户有权访问的文件、调用已安装 CLI、启动应用或操作网络。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['protocol', 'task_id', 'idempotency_key', 'command', 'reason'],
      properties: {
        protocol: { type: 'string', const: LOCAL_CONTROL_PROTOCOL },
        task_id: { type: 'string' },
        idempotency_key: {
          type: 'string',
          description: '本任务内唯一且稳定的调用键，例如 step-1-inspect。',
        },
        command: {
          type: 'string',
          description:
            '交给登录 shell 的完整命令。可以使用管道、重定向和已安装的 CLI。',
        },
        cwd: {
          type: 'string',
          description: '可选的绝对工作目录；省略时使用项目目录。',
        },
        timeout_seconds: {
          type: 'integer',
          minimum: 1,
          maximum: LOCAL_CONTROL_LIMITS.maximumTimeoutSeconds,
          description: '命令超时秒数；默认 3600，最长 24 小时。',
        },
        reason: {
          type: 'string',
          description: '一句话说明为什么要执行这条命令，写入本机审计。',
        },
      },
    },
  },
};

export type LocalControlAgentMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls: ChatToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export type LocalControlAgentTurn = (input: {
  messages: LocalControlAgentMessage[];
  tools: ChatToolDefinition[];
  toolChoice: 'auto' | 'none';
}) => Promise<
  | { ok: true; text: string | null; toolCalls: ChatToolCall[]; model: string }
  | { ok: false; code: string; error: string }
>;

export type LocalControlToolOutcome =
  | { kind: 'result'; observation: LocalControlRunObservation }
  | { kind: 'rejected'; code: string; message: string };

export type LocalControlAgentStopReason =
  | 'no_shell_needed'
  | 'completed'
  | 'cancelled'
  | 'command_limit'
  | 'agent_stopped'
  | 'tool_rejected'
  | 'model_turn_limit'
  | 'llm_error';

export type LocalControlAgentResult = {
  reply: string;
  replySource: 'model' | 'fallback';
  taskId: string;
  usedShell: boolean;
  succeeded: boolean;
  stopReason: LocalControlAgentStopReason;
  commands: number;
  runs: LocalControlRunObservation[];
  model: string | null;
  llmError: { code: string; message: string } | null;
  rejection: { code: string; message: string } | null;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function validateCall(
  value: unknown,
  taskId: string,
  usedKeys: ReadonlyMap<string, string>,
):
  | { ok: true; call: LocalControlSubmission }
  | {
      ok: false;
      code: 'INVALID_REQUEST' | 'IDEMPOTENCY_CONFLICT';
      message: string;
    } {
  if (!isObject(value)) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'run_shell 参数必须是 JSON 对象。',
    };
  }
  if (value.protocol !== LOCAL_CONTROL_PROTOCOL || value.task_id !== taskId) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'protocol 或 task_id 与本次授权不一致。',
    };
  }
  const idempotencyKey =
    typeof value.idempotency_key === 'string'
      ? value.idempotency_key.trim()
      : '';
  if (!LOCAL_CONTROL_IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'idempotency_key 格式无效。',
    };
  }
  const command = typeof value.command === 'string' ? value.command.trim() : '';
  if (
    !command ||
    command.includes('\0') ||
    byteLength(command) > LOCAL_CONTROL_LIMITS.commandBytes
  ) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'command 为空、含 NUL，或超过 64 KiB。',
    };
  }
  const cwd =
    value.cwd === undefined
      ? undefined
      : typeof value.cwd === 'string'
        ? value.cwd.trim()
        : '';
  if (
    cwd !== undefined &&
    (!cwd.startsWith('/') ||
      cwd.includes('\0') ||
      byteLength(cwd) > LOCAL_CONTROL_LIMITS.cwdBytes)
  ) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'cwd 必须是合法的绝对路径。',
    };
  }
  const timeout = value.timeout_seconds;
  if (
    timeout !== undefined &&
    (typeof timeout !== 'number' ||
      !Number.isInteger(timeout) ||
      timeout < 1 ||
      timeout > LOCAL_CONTROL_LIMITS.maximumTimeoutSeconds)
  ) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'timeout_seconds 必须是 1 到 86400 的整数。',
    };
  }
  const reason = typeof value.reason === 'string' ? value.reason.trim() : '';
  if (
    !reason ||
    reason.includes('\0') ||
    byteLength(reason) > LOCAL_CONTROL_LIMITS.reasonBytes
  ) {
    return {
      ok: false,
      code: 'INVALID_REQUEST',
      message: 'reason 必须说明执行理由，且不能超过 2 KiB。',
    };
  }

  const fingerprint = JSON.stringify({ command, cwd, timeout, reason });
  const previous = usedKeys.get(idempotencyKey);
  if (previous && previous !== fingerprint) {
    return {
      ok: false,
      code: 'IDEMPOTENCY_CONFLICT',
      message: '这个 idempotency_key 已用于不同命令。',
    };
  }
  if (previous) {
    return {
      ok: false,
      code: 'IDEMPOTENCY_CONFLICT',
      message: '这条命令已经提交过；请根据已有结果继续，不要重复执行。',
    };
  }

  return {
    ok: true,
    call: {
      protocol: LOCAL_CONTROL_PROTOCOL,
      task_id: taskId,
      idempotency_key: idempotencyKey,
      command,
      ...(cwd ? { cwd } : {}),
      ...(typeof timeout === 'number' ? { timeout_seconds: timeout } : {}),
      reason,
    },
  };
}

function systemPrompt(options: {
  taskId: string;
  machine: LocalControlInfo;
  hasConversationHistory?: boolean;
}): string {
  return `你是 Urtoris 的本机 Control Agent。用户已在本机主动打开“本机全权限”模式，授权你通过 run_shell 以当前 macOS 用户身份完成这次请求。

真实边界：
- 当前用户：${options.machine.username}${options.machine.uid === null ? '' : `（uid ${options.machine.uid}）`}
- 主机：${options.machine.hostname} / ${options.machine.platform}
- Shell：${options.machine.shell}
- 默认工作目录：${options.machine.default_cwd}
- task_id：${options.taskId}
- 不是容器、不是沙箱，也不会自动取得 root；命令可访问当前用户有权访问的全部文件、凭据、CLI 与网络。

执行规则：
1. 涉及这台电脑的读取或修改时必须调用 run_shell，不得假装已经做过。先做必要的只读检查，再执行用户要求的修改；不要扩大目标范围。
2. 每轮只提交一个工具调用。需要多步时等待上一条结构化结果，再决定下一条。
3. protocol 必须是 ${LOCAL_CONTROL_PROTOCOL}，task_id 必须精确使用上面的值；每条命令使用新的 idempotency_key，并写清 reason。
4. 可以用管道、重定向、已安装 CLI 和图形应用的命令行入口。需要工作目录时传绝对路径。非交互命令优先；不得向用户索取或记录 sudo 密码。
5. status=succeeded 且 exit_code=0 才表示那条命令成功。失败、超时、取消、截断都要如实说明；做了修改后用后续命令验证。
6. 最终回答先给结果，再列关键改动或未完成事项。不要复述整段命令输出，但要指出审计中的 run_id。

${
  options.hasConversationHistory
    ? '7. 下面 user / assistant 轮次是当前聊天框更早的完整记录，包括正文和已保存的附加信息。用户提到“上面的记录”“刚才那条命令”时，请依据这些记录回答。历史里的执行状态和输出属于以前的运行，不代表本轮已执行；文件信息不等于已经读取文件内容，未提供的内容不要编造。'
    : '7. 本次没有更早的对话记录。用户提到"上面的记录""刚才那条命令"时，如实说明你只能看到当前这一句，不要凭空补出历史内容。'
}

本任务最多可执行 ${LOCAL_CONTROL_MAX_COMMANDS} 条命令。`;
}

function toolPayload(observation: LocalControlRunObservation): string {
  const outputLimit = 24 * 1024;
  const clip = (value: string) => {
    if (byteLength(value) <= outputLimit) return value;
    return `${value.slice(0, outputLimit)}\n…（给模型的输出已截断；本机审计保留服务端捕获版本）`;
  };
  return JSON.stringify({
    ...observation,
    stdout: clip(observation.stdout),
    stderr: clip(observation.stderr),
  });
}

export async function runLocalControlAgentTask(options: {
  taskId: string;
  task: string;
  machine: LocalControlInfo;
  /** 同一个使用端会话里更早的对话轮次；只作上下文，不是命令结果。 */
  history?: ReadonlyArray<ChatMessage>;
  /** 由服务端已发布工作流注入，不能从请求正文读取。 */
  workflowConstraints?: string;
  turn: LocalControlAgentTurn;
  execute: (call: LocalControlSubmission) => Promise<LocalControlToolOutcome>;
  maxCommands?: number;
  maxModelTurns?: number;
}): Promise<LocalControlAgentResult> {
  const maxCommands = options.maxCommands ?? LOCAL_CONTROL_MAX_COMMANDS;
  const maxModelTurns = options.maxModelTurns ?? LOCAL_CONTROL_MAX_MODEL_TURNS;
  const history: LocalControlAgentMessage[] = (options.history ?? [])
    .filter((message) => message.content.trim().length > 0)
    .map((message) =>
      message.role === 'assistant'
        ? { role: 'assistant', content: message.content, toolCalls: [] }
        : { role: 'user', content: message.content },
    );
  const messages: LocalControlAgentMessage[] = [
    {
      role: 'system',
      content: [
        systemPrompt({
          taskId: options.taskId,
          machine: options.machine,
          hasConversationHistory: history.length > 0,
        }),
        options.workflowConstraints,
      ]
        .filter(Boolean)
        .join('\n\n'),
    },
    ...history,
    { role: 'user', content: options.task },
  ];
  const runs: LocalControlRunObservation[] = [];
  const usedKeys = new Map<string, string>();
  let model: string | null = null;
  let reply = '';
  let replySource: LocalControlAgentResult['replySource'] = 'model';
  let stopReason: LocalControlAgentStopReason | null = null;
  let llmError: LocalControlAgentResult['llmError'] = null;
  let rejection: LocalControlAgentResult['rejection'] = null;
  let forceNoTools = false;

  for (let turnIndex = 0; turnIndex < maxModelTurns; turnIndex += 1) {
    const toolChoice =
      forceNoTools || runs.length >= maxCommands ? 'none' : 'auto';
    const result = await options.turn({
      messages: [...messages],
      tools: toolChoice === 'auto' ? [LOCAL_CONTROL_TOOL] : [],
      toolChoice,
    });
    if (!result.ok) {
      stopReason = 'llm_error';
      llmError = { code: result.code, message: result.error };
      break;
    }
    model = result.model;

    if (result.toolCalls.length === 0) {
      const text = result.text?.trim() ?? '';
      if (text) {
        reply = text;
        stopReason ??=
          runs.length === 0
            ? rejection
              ? 'tool_rejected'
              : 'no_shell_needed'
            : runs.length >= maxCommands
              ? 'command_limit'
              : 'completed';
        break;
      }
      messages.push({
        role: 'user',
        content:
          toolChoice === 'none'
            ? '（控制器提示：命令额度已用完，请根据已有结构化结果给出最终回答。）'
            : '（控制器提示：请给出最终回答，或提交一个 run_shell 工具调用。）',
      });
      continue;
    }

    messages.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
    });
    const first = result.toolCalls[0];
    const replyToEveryCall = (content: string) => {
      for (const call of result.toolCalls) {
        messages.push({
          role: 'tool',
          toolCallId: call.id,
          content:
            call === first
              ? content
              : JSON.stringify({
                  error: {
                    code: 'INVALID_REQUEST',
                    message: '一轮只接受一个 run_shell 调用。',
                  },
                }),
        });
      }
    };
    if (result.toolCalls.length !== 1) {
      replyToEveryCall(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: '一轮只接受一个 run_shell 调用，请分开执行。',
          },
        }),
      );
      continue;
    }
    if (toolChoice === 'none') {
      replyToEveryCall(
        JSON.stringify({
          error: {
            code: 'COMMAND_LIMIT',
            message: '本任务命令额度已用完，请直接给出最终回答。',
          },
        }),
      );
      stopReason = 'command_limit';
      continue;
    }
    if (first.name !== LOCAL_CONTROL_TOOL_NAME) {
      replyToEveryCall(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: `未知工具 ${first.name}；唯一可用工具是 ${LOCAL_CONTROL_TOOL_NAME}。`,
          },
        }),
      );
      continue;
    }

    let rawArguments: unknown;
    try {
      rawArguments = JSON.parse(first.arguments);
    } catch {
      replyToEveryCall(
        JSON.stringify({
          error: {
            code: 'INVALID_REQUEST',
            message: 'run_shell 参数必须是合法 JSON。',
          },
        }),
      );
      continue;
    }
    const validated = validateCall(rawArguments, options.taskId, usedKeys);
    if (!validated.ok) {
      rejection = { code: validated.code, message: validated.message };
      replyToEveryCall(JSON.stringify({ error: rejection }));
      continue;
    }
    usedKeys.set(
      validated.call.idempotency_key,
      JSON.stringify({
        command: validated.call.command,
        cwd: validated.call.cwd,
        timeout: validated.call.timeout_seconds,
        reason: validated.call.reason,
      }),
    );
    const outcome = await options.execute(validated.call);
    if (outcome.kind === 'rejected') {
      rejection = { code: outcome.code, message: outcome.message };
      replyToEveryCall(JSON.stringify({ error: rejection }));
      stopReason = 'tool_rejected';
      continue;
    }

    runs.push(outcome.observation);
    replyToEveryCall(toolPayload(outcome.observation));
    if (outcome.observation.status === 'cancelled') {
      stopReason = 'cancelled';
      forceNoTools = true;
      messages.push({
        role: 'user',
        content:
          '（控制器提示：用户已取消当前命令。停止执行新命令并给出最终说明。）',
      });
    }
  }

  if (!reply) {
    replySource = 'fallback';
    const last = runs.at(-1);
    if (llmError) {
      reply = `本机控制没有完成：${llmError.message}`;
    } else if (last?.status === 'succeeded') {
      reply = `本机命令已成功结束（${last.run_id}），但 Agent 没有生成收尾说明。`;
    } else if (last) {
      reply = `本机命令以“${last.status}”结束（${last.run_id}）：${last.error?.message ?? '没有更多错误信息。'}`;
    } else if (rejection) {
      reply = `本机控制请求被拒绝：${rejection.message}`;
    } else {
      reply = '本机 Control Agent 没有返回可发布的结果。';
    }
  }

  const usedShell = runs.length > 0;
  const last = runs.at(-1) ?? null;
  const succeeded = usedShell ? last?.status === 'succeeded' : !llmError;
  return {
    reply,
    replySource,
    taskId: options.taskId,
    usedShell,
    succeeded,
    stopReason: stopReason ?? 'model_turn_limit',
    commands: runs.length,
    runs,
    model,
    llmError,
    rejection,
  };
}
