import type { WorkflowRecord, WorkflowRun } from '@/lib/workflow-types';

export type StudioRunTrace = 'local-preview' | 'simulated-run' | 'run-envelope';

export type StudioRunPlan = {
  kind: 'preview' | 'simulated' | 'n8n';
  executePublished: boolean;
  engine: string;
  mode: string;
  degraded: boolean;
  trace: StudioRunTrace;
  message: string;
};

/**
 * Studio 的“发布版本”不等于“已绑定 n8n”。
 *
 * 这个分类同 `/api/runs` 的真实分流保持一致：有 webhook 才是
 * 服务器 n8n；只有旧发布步骤时使用内置模拟器；连发布版本都没有
 * 才播放明确标注的本地 Graph 预演。
 */
export function planStudioRun(
  workflow: Pick<WorkflowRecord, 'publishedSteps' | 'n8nWebhookUrl'>,
): StudioRunPlan {
  const hasPublishedVersion = workflow.publishedSteps !== null;
  if (!hasPublishedVersion) {
    return {
      kind: 'preview',
      executePublished: false,
      engine: 'studio preview',
      mode: 'simulated',
      degraded: true,
      trace: 'local-preview',
      message: '启动本地 Graph 预演；节点状态和耗时均为明确标注的演示数据。',
    };
  }

  if (!workflow.n8nWebhookUrl) {
    return {
      kind: 'simulated',
      executePublished: true,
      engine: 'built-in simulator',
      mode: 'simulated',
      degraded: true,
      trace: 'simulated-run',
      message:
        '当前工作流未绑定 n8n，正在运行内置模拟器；结果可用，但不会产生服务器节点遥测。',
    };
  }

  return {
    kind: 'n8n',
    executePublished: true,
    engine: 'server n8n',
    mode: 'pending',
    degraded: false,
    trace: 'run-envelope',
    message:
      '正在调用服务器 n8n 的已绑定 Webhook；Studio Graph 尚未部署到该绑定。',
  };
}

export type StudioRunResultDescription = {
  trace: Exclude<StudioRunTrace, 'local-preview'>;
  shouldPollTelemetry: boolean;
  message: string;
  telemetryUnavailableMessage?: string;
};

/** 根据 API 回传的真实 engine 决定是否有资格声称“正在读 n8n 遥测”。 */
export function describeStudioRunResult(
  run: Pick<WorkflowRun, 'engine' | 'requestId' | 'status' | 'errorMessage'>,
): StudioRunResultDescription {
  if (run.engine !== 'n8n') {
    return {
      trace: 'simulated-run',
      shouldPollTelemetry: false,
      message:
        run.status === 'failed'
          ? `内置模拟执行失败：${run.errorMessage ?? '未返回错误详情'}。`
          : '内置模拟执行已完成。结果可在终端或输出页查看；本次未调用服务器 n8n，不产生节点级遥测。',
    };
  }

  if (!run.requestId) {
    const message =
      '服务器 n8n 已返回运行结果，但缺少 requestId，无法关联节点遥测。';
    return {
      trace: 'run-envelope',
      shouldPollTelemetry: false,
      message,
      telemetryUnavailableMessage: message,
    };
  }

  return {
    trace: 'run-envelope',
    shouldPollTelemetry: true,
    message:
      run.status === 'failed'
        ? `服务器 n8n 执行失败：${run.errorMessage ?? '未返回公开错误详情'}。正在同步真实节点遥测。`
        : '服务器 n8n 已返回运行结果，正在同步真实节点遥测。',
  };
}
