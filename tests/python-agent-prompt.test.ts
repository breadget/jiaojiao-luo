import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import {
  PYTHON_AGENT_BASE_PROMPT,
  PYTHON_AGENT_TOOL,
  buildPythonAgentSystemPrompt,
} from '@/lib/server/python-agent-prompt';

const documentUrl = new URL(
  '../docs/python-agent-system-prompt.md',
  import.meta.url,
);

/** 取出文档里 ```text 代码块的正文；找不到围栏就报错，绝不静默通过。 */
function extractPromptBlock(markdown: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '```text');
  assert.notEqual(start, -1, '文档里应该有 ```text 代码块');
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() === '```',
  );
  assert.notEqual(end, -1, '代码块应该有结束围栏');
  return lines.slice(start + 1, end).join('\n');
}

describe('Python Agent 系统提示词', () => {
  it('与 docs/python-agent-system-prompt.md 的正文逐字一致', async () => {
    const markdown = await readFile(documentUrl, 'utf8');
    assert.equal(PYTHON_AGENT_BASE_PROMPT, extractPromptBlock(markdown));
  });

  it('只按注入约定追加本次任务上下文，不夹带 task token', () => {
    const prompt = buildPythonAgentSystemPrompt({
      taskId: `task_${'a'.repeat(32)}`,
      artifactsAllowed: true,
      inputs: [
        {
          fileId: `file_${'b'.repeat(32)}`,
          mountName: 'sales.csv',
          displayName: '销售\n数据.csv',
          sizeBytes: 4096,
        },
      ],
      previousAttempts: [
        {
          attempt: 1,
          runId: `run_${'c'.repeat(32)}`,
          status: 'failed',
          errorCode: 'PROCESS_EXIT_NONZERO',
          retryable: true,
        },
      ],
    });

    assert.ok(prompt.startsWith(PYTHON_AGENT_BASE_PROMPT));
    assert.match(prompt, /## 本次任务上下文（由 Orchestrator 注入）/);
    assert.match(prompt, /- task_id：task_a{32}/);
    assert.match(prompt, /file_id=file_b{32}；mount_name=sales\.csv/);
    assert.match(prompt, /展示名=销售 数据\.csv/);
    assert.match(prompt, /大小=4096 字节/);
    assert.match(prompt, /是否允许生成文件：允许/);
    assert.match(prompt, /attempt 1；run_id=run_c{32}；status=failed/);
    assert.doesNotMatch(prompt, /X-Urtoris-Task-Token/);
    assert.doesNotMatch(prompt, /PYTHON_EXECUTOR_TOKEN/);
    assert.match(prompt, /ReportLab/);
    assert.match(prompt, /\.pdf/);
  });

  it('没有输入文件时明确写「无」，并支持禁止产物', () => {
    const prompt = buildPythonAgentSystemPrompt({
      taskId: `task_${'d'.repeat(32)}`,
      artifactsAllowed: false,
      inputs: [],
      previousAttempts: [],
    });
    assert.match(prompt, /- 无（本次任务没有已授权的输入文件）/);
    assert.match(prompt, /是否允许生成文件：不允许/);
    assert.match(prompt, /本次任务不允许产出文件/);
  });

  it('工具定义钉死协议字段，不允许额外字段', () => {
    const parameters = PYTHON_AGENT_TOOL.function.parameters as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { maximum?: number; enum?: string[] }>;
    };
    assert.equal(PYTHON_AGENT_TOOL.function.name, 'run_python');
    assert.deepEqual(parameters.required, [
      'protocol',
      'task_id',
      'idempotency_key',
      'attempt',
      'code',
      'input_files',
      'profile',
      'timeout_seconds',
    ]);
    assert.equal(parameters.additionalProperties, false);
    assert.deepEqual(parameters.properties.protocol.enum, [
      'urtoris.python-executor.v1',
    ]);
    assert.equal(parameters.properties.attempt.maximum, 3);
    assert.deepEqual(parameters.properties.profile.enum, ['short', 'long']);
    assert.equal(parameters.properties.timeout_seconds.maximum, 600);
  });
});
