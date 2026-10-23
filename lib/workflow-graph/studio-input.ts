import type { StudioNodeType } from './types';

export type StudioRunInput = {
  message: string;
  input?: Record<string, unknown>;
  sessionId?: string;
};

/** Terminal text becomes the prompt; a JSON object retains every business field. */
export function parseStudioRunInput(text: string): StudioRunInput {
  const value = text.trim();
  if (!value) throw new Error('请输入内容，再按 Enter 运行。');
  if (value.length > 16_000)
    throw new Error('输入过长，请控制在 16000 字符以内。');

  if (!value.startsWith('{') && !value.startsWith('[')) {
    if (value.length > 2000) throw new Error('文本输入最多 2000 字符。');
    return { message: value };
  }

  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new Error('JSON 格式有误，请检查引号、逗号和括号后重试。');
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('JSON 输入需要是一个对象，例如 {"message":"你好"}。');
  }
  const fields = input as Record<string, unknown>;
  const message = fields.message ?? fields.question ?? '';
  if (typeof message !== 'string') {
    throw new Error('message 或 question 必须是文本。');
  }
  if (message.length > 2000)
    throw new Error('message 或 question 最多 2000 字符。');
  if (
    fields.sessionId !== undefined &&
    (typeof fields.sessionId !== 'string' ||
      !fields.sessionId.trim() ||
      fields.sessionId.length > 80)
  ) {
    throw new Error('sessionId 需要是 1–80 字符的文本。');
  }
  return {
    message: message.trim(),
    input: fields,
    ...(typeof fields.sessionId === 'string'
      ? { sessionId: fields.sessionId.trim() }
      : {}),
  };
}

export function studioNodeRole(type: StudioNodeType) {
  if (type === 'trigger') return '输入接口';
  if (type === 'output') return '输出接口';
  if (['llmModel', 'memory', 'tool', 'subworkflow'].includes(type))
    return '辅助工具';
  return '处理';
}
