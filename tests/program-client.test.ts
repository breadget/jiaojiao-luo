import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  programDefaults,
  programInput,
  programStartPayload,
  programIsLive,
  fetchProgramJson,
} from '@/components/program/program-client';
import type {
  ProgramDescription,
  ProgramJob,
} from '@/lib/workflow-program/types';

const program: ProgramDescription = {
  workflowId: 'wf_course',
  name: '课程学习',
  versionId: 'version_2',
  workflowVersion: 2,
  requiresModel: true,
  nodes: [],
  inputFields: [
    { name: 'topic', label: '学习主题', type: 'text', required: true },
    {
      name: 'count',
      label: '练习数量',
      type: 'number',
      default: 5,
      min: 1,
      max: 20,
    },
    { name: 'answers', label: '包含答案', type: 'boolean', default: false },
  ],
};

describe('已发布程序的浏览器输入契约', () => {
  it('保留数字和 false 默认值，将表单按发布字段转换成实际类型', () => {
    const defaults = programDefaults(program.inputFields);
    assert.deepEqual(defaults, { topic: '', count: '5', answers: false });
    assert.deepEqual(
      programInput(program.inputFields, {
        ...defaults,
        topic: '  栈和队列  ',
        graph: 'ignored',
      }),
      { topic: '栈和队列', count: 5, answers: false },
    );
  });
  it('提交前拒绝缺失输入、非有限数字和越界数字', () => {
    assert.throws(
      () =>
        programInput(program.inputFields, programDefaults(program.inputFields)),
      /学习主题/,
    );
    for (const count of ['NaN', 'Infinity', '0', '21'])
      assert.throws(
        () => programInput(program.inputFields, { topic: '栈', count }),
        /练习数量/,
      );
  });
  it('只提交固定发布版本、用户参数与统一模型配置，不提交图覆盖', () => {
    const payload = programStartPayload(
      program,
      { topic: '栈', count: '3', answers: true, graph: 'ignored' },
      {
        provider: 'qwen',
        apiKey: ' key ',
        baseUrl: ' https://example.com/v1 ',
        model: ' qwen-plus ',
        reasoningEffort: 'medium',
      },
      'request_1',
      'session_1',
    );
    assert.deepEqual(Object.keys(payload).sort(), [
      'consumerSessionId',
      'input',
      'llm',
      'requestId',
      'versionId',
      'workflowId',
    ]);
    assert.equal(payload.versionId, 'version_2');
    assert.equal(payload.llm.apiKey, 'key');
    assert.deepEqual(payload.input, { topic: '栈', count: 3, answers: true });
  });
  it('遵守发布字段的文本长度范围', () => {
    const fields = [
      { name: 'topic', label: '主题', type: 'text' as const, min: 2, max: 4 },
    ];
    assert.throws(() => programInput(fields, { topic: '栈' }), /至少需要/);
    assert.throws(
      () => programInput(fields, { topic: '数据结构与算法' }),
      /最多可填写/,
    );
    assert.deepEqual(programInput(fields, { topic: '链表' }), {
      topic: '链表',
    });
  });
  it('只有服务端 queued/running 状态继续轮询', () => {
    for (const status of [
      'queued',
      'running',
      'completed',
      'failed',
      'cancelled',
    ] as const)
      assert.equal(
        programIsLive({ status } as ProgramJob),
        status === 'queued' || status === 'running',
      );
    assert.equal(programIsLive(null), false);
  });

  it('所有程序读取和提交都带浏览器身份标记，并保留取消信号', async (context) => {
    const controller = new AbortController();
    let observed: RequestInit | undefined;
    context.mock.method(
      globalThis,
      'fetch',
      async (_path: string, init: RequestInit) => {
        observed = init;
        return Response.json({ job: { id: 'job_1' } }, { status: 202 });
      },
    );
    const data = await fetchProgramJson<{ job: { id: string } }>(
      '/api/programs/runs',
      { method: 'POST', body: '{}', signal: controller.signal },
    );
    assert.equal(data.job.id, 'job_1');
    assert.equal(
      new Headers(observed?.headers).get('X-Urtoris-Consumer-Client'),
      '1',
    );
    assert.equal(
      new Headers(observed?.headers).get('Content-Type'),
      'application/json',
    );
    assert.equal(observed?.signal, controller.signal);
    assert.equal(observed?.cache, 'no-store');
  });

  it('服务端错误保留明确原因，不将拒绝的响应当成运行成功', async (context) => {
    context.mock.method(globalThis, 'fetch', async () =>
      Response.json({ error: '发布版本已更新，请重新读取。' }, { status: 409 }),
    );
    await assert.rejects(
      fetchProgramJson('/api/programs/runs'),
      /发布版本已更新/,
    );
  });
});
