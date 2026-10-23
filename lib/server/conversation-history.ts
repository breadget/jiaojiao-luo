import {
  ConsumerSessionError,
  listConsumerMessages,
  type ConsumerMessage,
} from '@/lib/server/consumer-store';
import type { ChatMessage } from '@/lib/server/llm';

/**
 * 四条执行路径（直连模型 / n8n / Python / 本机 Shell）共用完整会话记录。
 * 保留正文和聊天框里的附加信息，不按轮数或字符预算静默裁剪。
 */

export type ConversationHistoryOptions = {
  /** 当前正在生成的 Agent 消息 id：它还是 working 占位，必须排除。 */
  excludeMessageId?: string;
  /** 当前用户消息的编号：只取它之前的消息，保留用户重复发送的相同文字。 */
  currentMessageId?: string;
  /** 兼容未传消息编号的旧调用方，只去掉末尾与本轮输入相同的一条。 */
  currentText?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pickFields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    keys.flatMap((key) => {
      const field = value[key];
      return field === null ||
        ['string', 'number', 'boolean'].includes(typeof field)
        ? [[key, field]]
        : [];
    }),
  );
}

/** 只加入聊天框会展示的字段；不传密钥、blob 地址或任意隐藏 metadata。 */
function messageContent(message: ConsumerMessage): string {
  const metadata = message.metadata;
  const visible = pickFields(metadata, [
    'runId',
    'intent',
    'priority',
    'mode',
    'executionMode',
    'degraded',
    'failed',
  ]);
  for (const [key, fields] of [
    ['attachments', ['name', 'size', 'mimeType']],
    ['artifacts', ['name', 'sizeBytes', 'mimeType', 'artifactId', 'runId']],
  ] as const) {
    const items = metadata[key];
    if (Array.isArray(items) && items.length) {
      visible[key] = items.map((item) => pickFields(item, [...fields]));
    }
  }
  if (isRecord(metadata.python)) {
    visible.python = pickFields(metadata.python, [
      'taskId',
      'attempts',
      'succeeded',
      'stopReason',
      'guarded',
    ]);
  }
  if (isRecord(metadata.shell)) {
    const shell = pickFields(metadata.shell, [
      'taskId',
      'succeeded',
      'stopReason',
    ]);
    if (Array.isArray(metadata.shell.runs)) {
      shell.runs = metadata.shell.runs.map((item) => {
        const run = pickFields(item, [
          'runId',
          'status',
          'command',
          'cwd',
          'timeoutSeconds',
          'reason',
          'exitCode',
          'signal',
          'stdout',
          'stderr',
          'stdoutTruncated',
          'stderrTruncated',
          'cancellationRequested',
          'createdAt',
          'startedAt',
          'finishedAt',
        ]);
        if (isRecord(item) && isRecord(item.error)) {
          run.error = pickFields(item.error, ['code', 'message']);
        }
        return run;
      });
    }
    visible.shell = shell;
  }
  if (message.status === 'failed') visible.failed = true;
  return Object.keys(visible).length
    ? `${message.text}\n\n【聊天框附加信息（历史记录）】\n${JSON.stringify(visible)}`
    : message.text;
}

/** 纯函数部分：把已落库的消息整理成模型可用的历史轮次。 */
export function buildConversationHistory(
  messages: ReadonlyArray<ConsumerMessage>,
  options: ConversationHistoryOptions = {},
): ChatMessage[] {
  const currentText = options.currentText?.trim();
  const currentIndex = options.currentMessageId
    ? messages.findIndex((message) => message.id === options.currentMessageId)
    : -1;
  if (
    options.currentMessageId &&
    (currentIndex < 0 ||
      messages[currentIndex].role !== 'user' ||
      (currentText !== undefined &&
        messages[currentIndex].text.trim() !== currentText))
  ) {
    throw new ConsumerSessionError(
      '当前消息未保存在这条对话中，请重新发送。',
      409,
    );
  }
  const earlierMessages =
    currentIndex >= 0 ? messages.slice(0, currentIndex) : messages;

  const candidates: Array<{ message: ChatMessage; raw: string }> = [];
  for (const message of earlierMessages) {
    if (options.excludeMessageId && message.id === options.excludeMessageId) {
      continue;
    }
    // working 是进行中的占位消息，内容为空，不能当成历史。
    if (message.status === 'working') continue;
    const content = messageContent(message);
    if (!content.trim()) continue;
    candidates.push({
      message: {
        role: message.role === 'user' ? 'user' : 'assistant',
        content,
      },
      raw: message.text.trim(),
    });
  }

  // 当前这一轮的用户输入由调用方单独传入，历史里去掉重复的那一条。
  const last = candidates.at(-1);
  if (
    !options.currentMessageId &&
    currentText &&
    last?.message.role === 'user' &&
    last.raw === currentText
  ) {
    candidates.pop();
  }

  return candidates.map(({ message }) => message);
}

/** 读取完整历史；失败时明确报错，不能把读库失败伪装成一段新对话。 */
export async function loadConversationHistory(
  sessionId: string | undefined,
  options: ConversationHistoryOptions = {},
): Promise<ChatMessage[]> {
  if (!sessionId) return [];
  try {
    const messages = await listConsumerMessages(sessionId);
    return buildConversationHistory(messages, options);
  } catch (cause) {
    if (cause instanceof ConsumerSessionError) throw cause;
    throw new ConsumerSessionError('无法读取完整聊天记录，请稍后重试。', 503);
  }
}

/** 拼给 n8n 的上下文块标题；工作流侧只读 message 时也能一眼看出边界。 */
export const CONVERSATION_CONTEXT_HEADING = '【同一会话更早的对话记录】';
export const CONVERSATION_CURRENT_HEADING = '【当前消息】';

function indentContinuation(text: string): string {
  return text
    .split('\n')
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
}

/**
 * 把历史轮次和历史拼成一段可直接交给 n8n 的输入。
 *
 * n8n 侧的提示词节点通常只读信封的 `message`（归一后是 `question`），既看不到
 * `context.conversationHistory`，也不一定挂了 Memory 节点。所以站点在这里把
 * 「更早的对话记录 + 当前消息」拼成一段文本放进 `message`，让任何绑定的 n8n
 * 工作流都能接上上下文。没有历史时返回 null，调用方保持原样发送。
 *
 * 历史里的 assistant 内容只是上下文，**不是执行证据**：这一点必须写在块里，
 * 否则模型会把历史里的「已完成」当成这次 n8n 执行做过的事情。
 */
export function composeContextualMessage(
  rawMessage: string,
  history: ReadonlyArray<ChatMessage>,
): string | null {
  const usable = history.filter((message) => message.content.trim().length > 0);
  if (usable.length === 0) return null;
  const transcript = usable
    .map(
      (message) =>
        `${message.role === 'user' ? '用户' : '助手'}：${indentContinuation(
          message.content,
        )}`,
    )
    .join('\n\n');
  return [
    CONVERSATION_CONTEXT_HEADING,
    '下面是当前聊天框更早的完整记录，包括正文和已保存的附加信息。用户提到“这个聊天框里的记录”“刚才的内容”时，请依据这些记录回答。历史执行状态和输出属于以前的运行，不代表本轮已执行；附件/产物信息不等于已读取文件内容，未提供的内容不要编造。',
    '',
    transcript,
    '',
    CONVERSATION_CURRENT_HEADING,
    rawMessage,
  ].join('\n');
}
