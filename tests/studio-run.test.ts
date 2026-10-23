import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  describeStudioRunResult,
  planStudioRun,
} from '@/lib/workflow-graph/studio-run';

describe('Studio 运行通道分类', () => {
  it('没有发布版本时才进入本地 Graph 预演', () => {
    const plan = planStudioRun({ publishedSteps: null, n8nWebhookUrl: null });
    assert.equal(plan.kind, 'preview');
    assert.equal(plan.executePublished, false);
    assert.equal(plan.trace, 'local-preview');
  });

  it('已发布但无 webhook 是内置模拟，不得冒充 n8n 绑定', () => {
    const plan = planStudioRun({ publishedSteps: [], n8nWebhookUrl: null });
    assert.equal(plan.kind, 'simulated');
    assert.equal(plan.executePublished, true);
    assert.equal(plan.engine, 'built-in simulator');
    assert.equal(plan.trace, 'simulated-run');
    assert.match(plan.message, /未绑定 n8n/);
  });

  it('只有配置 webhook 的发布版本才声称调用服务器 n8n', () => {
    const plan = planStudioRun({
      publishedSteps: [],
      n8nWebhookUrl: 'http://127.0.0.1:5679/webhook/urtoris/demo',
    });
    assert.equal(plan.kind, 'n8n');
    assert.equal(plan.engine, 'server n8n');
    assert.equal(plan.trace, 'run-envelope');
    assert.match(plan.message, /服务器 n8n/);
  });
});

describe('Studio 运行结果说明', () => {
  it('模拟 run 显示结果但不启动 n8n 节点遥测', () => {
    const description = describeStudioRunResult({
      engine: 'simulated',
      requestId: null,
      status: 'completed',
      errorMessage: null,
    });
    assert.equal(description.trace, 'simulated-run');
    assert.equal(description.shouldPollTelemetry, false);
    assert.match(description.message, /终端或输出页/);
    assert.match(description.message, /未调用服务器 n8n/);
  });

  it('n8n run 有 requestId 时才启动节点遥测', () => {
    const description = describeStudioRunResult({
      engine: 'n8n',
      requestId: 'req_studio_n8n',
      status: 'completed',
      errorMessage: null,
    });
    assert.equal(description.trace, 'run-envelope');
    assert.equal(description.shouldPollTelemetry, true);
    assert.equal(description.telemetryUnavailableMessage, undefined);
  });

  it('n8n run 缺 requestId 时说明具体原因', () => {
    const description = describeStudioRunResult({
      engine: 'n8n',
      requestId: null,
      status: 'completed',
      errorMessage: null,
    });
    assert.equal(description.shouldPollTelemetry, false);
    assert.match(description.message, /缺少 requestId/);
    assert.equal(description.telemetryUnavailableMessage, description.message);
  });
});
