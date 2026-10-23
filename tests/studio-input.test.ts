import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseStudioRunInput } from '@/lib/workflow-graph/studio-input';

describe('Studio 终端输入契约', () => {
  it('把普通文本作为实际运行提示词', () => {
    assert.deepEqual(parseStudioRunInput('  分析这条工单\n  '), {
      message: '分析这条工单',
    });
  });

  it('保留 JSON 业务参数，并提取 question 和会话编号', () => {
    const input = {
      question: '服务无法访问',
      channel: 'web',
      urgency: 'high',
      sessionId: 'session_test',
      count: 0,
      options: { retry: false },
    };
    assert.deepEqual(parseStudioRunInput(JSON.stringify(input)), {
      message: input.question,
      input,
      sessionId: input.sessionId,
    });
  });

  it('message 优先于 question；纯业务对象不凭空生成提示词', () => {
    assert.equal(
      parseStudioRunInput('{"message":"文本","question":"其他"}').message,
      '文本',
    );
    assert.deepEqual(parseStudioRunInput('{"count":5}'), {
      message: '',
      input: { count: 5 },
    });
  });

  it('空输入、损坏的 JSON、数组和非法字段都在运行前报错', () => {
    for (const value of [
      '',
      '  ',
      '{"message":',
      '[1,2]',
      '{"message":7}',
      '{"sessionId":""}',
    ]) {
      assert.throws(() => parseStudioRunInput(value));
    }
  });

  it('拒绝会被服务器截断的提示词和过长的业务对象', () => {
    assert.throws(() => parseStudioRunInput('文'.repeat(2001)), /2000/);
    assert.throws(
      () =>
        parseStudioRunInput(JSON.stringify({ question: '文'.repeat(2001) })),
      /2000/,
    );
    assert.throws(
      () => parseStudioRunInput(JSON.stringify({ data: '文'.repeat(16000) })),
      /16000/,
    );
    assert.throws(
      () => parseStudioRunInput(JSON.stringify({ sessionId: 'a'.repeat(81) })),
      /sessionId/,
    );
  });
});
