import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { ConsumerMessage } from '@/lib/server/consumer-store';
import {
  buildConversationHistory,
  composeContextualMessage,
} from '@/lib/server/conversation-history';

let counter = 0;

function message(
  role: ConsumerMessage['role'],
  text: string,
  options: {
    id?: string;
    status?: ConsumerMessage['status'];
    metadata?: ConsumerMessage['metadata'];
  } = {},
): ConsumerMessage {
  counter += 1;
  return {
    id: options.id ?? `msg_${String(counter).padStart(4, '0')}`,
    sessionId: `session_${'a'.repeat(32)}`,
    role,
    status: options.status ?? 'completed',
    text,
    metadata: options.metadata ?? {},
    createdAt: counter,
    updatedAt: counter,
  };
}

describe('使用端会话记忆', () => {
  it('按时间顺序转成 user / assistant 轮次', () => {
    const history = buildConversationHistory([
      message('user', '帮我整理销售数据'),
      message('agent', '已经整理成表格。'),
    ]);

    assert.deepEqual(history, [
      { role: 'user', content: '帮我整理销售数据' },
      { role: 'assistant', content: '已经整理成表格。' },
    ]);
  });

  it('排除进行中的占位消息和空消息', () => {
    const history = buildConversationHistory([
      message('user', '第一句'),
      message('agent', '', { status: 'working' }),
      message('agent', '   ', { status: 'completed' }),
      message('agent', '第一句的回答'),
    ]);

    assert.deepEqual(history, [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第一句的回答' },
    ]);
  });

  it('当前这轮用户输入只出现一次', () => {
    const history = buildConversationHistory(
      [
        message('user', '第一句'),
        message('agent', '第一句的回答'),
        message('user', '这个聊天框里的所有的记录'),
        message('agent', '', { status: 'working', id: 'msg_working' }),
      ],
      {
        currentText: '这个聊天框里的所有的记录',
        excludeMessageId: 'msg_working',
      },
    );

    assert.deepEqual(history, [
      { role: 'user', content: '第一句' },
      { role: 'assistant', content: '第一句的回答' },
    ]);
  });

  it('完整保留超过 12 条、6000 字符的记录，包括第一条和末尾', () => {
    const messages = Array.from({ length: 250 }, (_, index) =>
      message(
        index % 2 === 0 ? 'user' : 'agent',
        `第 ${index} 条：${'完整'.repeat(100)}`,
      ),
    );
    const history = buildConversationHistory(messages);
    assert.deepEqual(
      history.map(({ content }) => content),
      messages.map(({ text }) => text),
    );
  });

  it('长正文和首尾空白原样保留，不截掉末尾的信息', () => {
    const long = `  开头\n${'长'.repeat(12_000)}\n关键结论在末尾  \n`;
    const history = buildConversationHistory([message('user', long)]);
    assert.equal(history[0].content, long);
    assert.doesNotMatch(history[0].content, /历史消息已截断/);
  });

  it('按消息编号排除当前轮，保留更早的同文消息，并排除稍后保存的轮次', () => {
    const history = buildConversationHistory(
      [
        message('user', '再试一次', { id: 'msg_old' }),
        message('user', '再试一次', { id: 'msg_current' }),
        message('agent', '', { status: 'working' }),
        message('user', '另一页稍后发送的消息'),
      ],
      { currentMessageId: 'msg_current', currentText: '再试一次' },
    );
    assert.deepEqual(history, [{ role: 'user', content: '再试一次' }]);
  });

  it('未保存、角色错误或文字不符的当前消息明确报错', () => {
    const messages = [
      message('agent', '回答', { id: 'msg_agent' }),
      message('user', '问题', { id: 'msg_user' }),
    ];
    for (const options of [
      { currentMessageId: 'msg_missing' },
      { currentMessageId: 'msg_agent' },
      { currentMessageId: 'msg_user', currentText: '不同的问题' },
    ]) {
      assert.throws(
        () => buildConversationHistory(messages, options),
        /当前消息未保存/,
      );
    }
  });

  it('附件和产物信息进入历史，不把文件名当成已读取的文件内容', () => {
    const history = buildConversationHistory([
      message('user', '', {
        metadata: {
          apiKey: 'secret-key',
          attachments: [
            {
              name: '销售.csv',
              size: 120,
              mimeType: 'text/csv',
              previewUrl: 'blob:private',
              token: 'secret-token',
            },
          ],
        },
      }),
      message('agent', '生成了文件', {
        metadata: {
          artifacts: [
            {
              name: '汇总.pdf',
              sizeBytes: 4000,
              mimeType: 'application/pdf',
              artifactId: 'artifact_123',
              runId: 'run_123',
            },
          ],
          python: {
            taskId: 'task_123',
            attempts: 1,
            succeeded: true,
            stopReason: 'succeeded',
            guarded: false,
          },
        },
      }),
    ]);
    assert.equal(history.length, 2);
    const transcript = JSON.stringify(history);
    assert.match(transcript, /销售.csv/);
    assert.match(transcript, /汇总.pdf/);
    assert.match(transcript, /task_123/);
    assert.doesNotMatch(transcript, /secret-key|secret-token|blob:private/);
  });

  it('完整保留已保存的命令输出、失败信息和输出截断状态', () => {
    const stdout = `开头${'输出'.repeat(2500)}末尾`;
    const history = buildConversationHistory([
      message('agent', '本次失败', {
        status: 'failed',
        metadata: {
          shell: {
            taskId: 'localtask_123',
            succeeded: false,
            stopReason: 'failed',
            runs: [
              {
                runId: 'shell_123',
                command: 'python report.py',
                stdout,
                stderr: 'ValueError: 数据无效',
                exitCode: 1,
                stdoutTruncated: true,
                stderrTruncated: false,
                error: { code: 'EXIT_NONZERO', message: '命令失败' },
              },
            ],
          },
        },
      }),
    ]);
    const metadata = JSON.parse(
      history[0].content.split('【聊天框附加信息（历史记录）】\n')[1],
    );
    assert.equal(metadata.shell.runs[0].stdout, stdout);
    assert.equal(metadata.shell.runs[0].exitCode, 1);
    assert.equal(metadata.shell.runs[0].stdoutTruncated, true);
    assert.equal(metadata.failed, true);
  });

  it('n8n 文本包含完整历史以及当前输入，空历史保持兼容', () => {
    const content = `开始${'长'.repeat(8000)}历史末尾`;
    const composed = composeContextualMessage('当前输入', [
      { role: 'assistant', content },
    ]);
    assert.ok(composed?.includes(content));
    assert.match(composed ?? '', /【当前消息】\n当前输入$/);
    assert.equal(composeContextualMessage('当前输入', []), null);
  });
});
