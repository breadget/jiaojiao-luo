'use strict';

const workflowNodes = {
  'urtoris-common-auth': ['When Executed by Another Workflow', '协议校验'],
  'urtoris-common-llm': [
    'When Executed by Another Workflow',
    '已配置密钥?',
    '调用模型',
    '模型错误归一',
  ],
  'urtoris-common-envelope': ['When Executed by Another Workflow', '构建信封'],
  'urtoris-common-log': [
    'When Executed by Another Workflow',
    '构建事件',
    '上报 Urtoris',
  ],
  'urtoris-global-error-handler': [
    'Error Trigger',
    '提取并分类错误',
    '写入执行日志',
  ],
  'urtoris-gateway': [
    'Webhook',
    '解析路由',
    '转发到目标工作流',
    'Respond to Webhook',
  ],
  'urtoris-wf-llm-smoke': ['准备模型入参', 'common-llm', '模型成功?'],
  'urtoris-wf-user-manager': ['提取用户信息', 'common-llm', '是主管?'],
  'urtoris-wf-security-analysis': ['提取目标', '按类型分流', '风险评分'],
  'urtoris-wf-api-gateway': ['解析网关请求', '方法路由', '整理响应'],
  'urtoris-wf-customer-insights': ['加载评论并聚类', 'common-llm', '整理洞察'],
};
const business = new Set(
  Object.keys(workflowNodes).filter((id) => id.startsWith('urtoris-wf-')),
);
const commonBusinessNodes = [
  'Webhook',
  '校验请求',
  '请求合法?',
  '绑定执行 (execution.bound)',
  '归一绑定结果',
  '绑定成功?',
  'common-envelope',
  'common-log',
  'Respond to Webhook',
];

class Database {
  constructor(_path, mode) {
    if (mode !== 1) throw new Error('checker must use OPEN_READONLY');
  }

  all(sql, params, callback) {
    const variant = process.env.UPGRADE_CLONE_STUB_MODE || 'ok';
    let rows;
    if (sql.includes('sqlite_master')) {
      rows = [
        'execution_data',
        'execution_entity',
        'migrations',
        'workflow_entity',
      ].map((name) => ({ name }));
    } else if (sql.includes('FROM workflow_entity')) {
      rows = Object.entries(workflowNodes).map(([id, required]) => ({
        id,
        name: id,
        active: 1,
        nodes: JSON.stringify(
          [...required, ...(business.has(id) ? commonBusinessNodes : [])].map(
            (name) => ({ name }),
          ),
        ),
        settings: JSON.stringify({
          saveDataSuccessExecution:
            variant === 'bad-settings' && id === 'urtoris-common-llm'
              ? 'none'
              : 'all',
          saveDataErrorExecution: 'all',
          ...(id === 'urtoris-global-error-handler'
            ? {}
            : { errorWorkflow: 'urtoris-global-error-handler' }),
        }),
      }));
      if (variant === 'missing-workflow') rows.pop();
    } else if (sql.includes('GROUP BY status')) {
      rows = [{ status: 'success', finished: 1, count: 12 }];
    } else if (sql.includes("datetime('now', '-10 minutes')")) {
      rows =
        variant === 'stale-running'
          ? [
              {
                id: '77',
                workflowId: 'urtoris-wf-llm-smoke',
                startedAt: '2026-09-11 00:00:00',
                waitTill: null,
              },
            ]
          : [];
    } else if (sql.includes('WHERE id IN')) {
      rows = params.map((id) => ({
        id,
        workflowId: 'urtoris-wf-llm-smoke',
        status: 'success',
        finished: 1,
        startedAt: '2026-09-11 00:00:00',
        stoppedAt: '2026-09-11 00:00:01',
        waitTill: null,
      }));
    } else {
      rows = [];
    }
    queueMicrotask(() => callback(null, rows));
  }

  close() {}
}

module.exports = { Database, OPEN_READONLY: 1 };
