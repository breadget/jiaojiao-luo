#!/usr/bin/env node

/**
 * Fail-closed, read-only acceptance check for an n8n 2.38.6 upgrade clone.
 *
 * Required:
 *   URTORIS_CLONE_CANARY=1
 *   N8N_CLONE_DATABASE_PATH=/path/containing/clone-or-canary/database.sqlite
 *
 * Optional:
 *   N8N_SQLITE3_MODULE=/path/to/n8n/node_modules/sqlite3
 *   node check-upgrade-clone.js <executionId>...
 *
 * It never prints workflow JSON, credentials, environment values, or the full
 * database path. Opening SQLite with OPEN_READONLY is intentional.
 */

import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, isAbsolute, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const expected = {
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

const businessIds = new Set([
  'urtoris-wf-llm-smoke',
  'urtoris-wf-user-manager',
  'urtoris-wf-security-analysis',
  'urtoris-wf-api-gateway',
  'urtoris-wf-customer-insights',
]);
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

if (process.env.URTORIS_CLONE_CANARY !== '1') {
  throw new Error(
    'Refusing to run: set URTORIS_CLONE_CANARY=1 only inside the isolated clone.',
  );
}

const rawDatabasePath = process.env.N8N_CLONE_DATABASE_PATH ?? '';
if (!rawDatabasePath || !isAbsolute(rawDatabasePath)) {
  throw new Error('N8N_CLONE_DATABASE_PATH must be an absolute path.');
}
const databasePath = resolve(rawDatabasePath);
if (!/(?:clone|canary)/i.test(databasePath)) {
  throw new Error('Refusing database path without "clone" or "canary" in it.');
}
accessSync(databasePath, constants.R_OK);

const executionIds = process.argv.slice(2);
if (executionIds.some((value) => !/^[0-9]+$/.test(value))) {
  throw new Error('Execution ids must contain digits only.');
}

function loadSqlite3() {
  const candidates = [
    process.env.N8N_SQLITE3_MODULE,
    '/opt/n8n/releases/2.38.6/node_modules/sqlite3',
    '/opt/n8n/releases/2.38.6/node_modules/n8n/node_modules/sqlite3',
    '/usr/lib/node_modules/n8n/node_modules/sqlite3',
  ].filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (cause) {
      errors.push(
        `${candidate}: ${cause instanceof Error ? (cause.code ?? cause.message) : 'load failed'}`,
      );
    }
  }
  throw new Error(
    `Cannot load sqlite3. Set N8N_SQLITE3_MODULE. Tried ${errors.join('; ')}`,
  );
}

const sqlite3 = loadSqlite3();
const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);

function all(sql, params = []) {
  return new Promise((resolveRows, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolveRows(rows);
    });
  });
}

function parseObject(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function main() {
  const requiredTables = [
    'execution_data',
    'execution_entity',
    'migrations',
    'workflow_entity',
  ];
  const tableRows = await all(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${requiredTables
      .map(() => '?')
      .join(', ')}) ORDER BY name`,
    requiredTables,
  );
  const tableNames = new Set(tableRows.map((row) => row.name));
  const tables = requiredTables.map((name) => ({
    name,
    present: tableNames.has(name),
  }));

  const workflowIds = Object.keys(expected);
  const workflowRows = await all(
    `SELECT id, name, active, nodes, settings
       FROM workflow_entity
      WHERE id IN (${workflowIds.map(() => '?').join(', ')})
      ORDER BY id`,
    workflowIds,
  );
  const workflows = workflowRows.map((row) => {
    const nodes = parseObject(row.nodes);
    const nodeNames = new Set(
      Array.isArray(nodes)
        ? nodes
            .map((node) => node?.name)
            .filter((name) => typeof name === 'string')
        : [],
    );
    const settings = parseObject(row.settings);
    const requiredNodes = [
      ...expected[row.id],
      ...(businessIds.has(row.id) ? commonBusinessNodes : []),
    ];
    const missingNodes = [...new Set(requiredNodes)].filter(
      (name) => !nodeNames.has(name),
    );
    const checks = {
      active: Boolean(row.active),
      saveSuccessAll: settings.saveDataSuccessExecution === 'all',
      saveErrorAll: settings.saveDataErrorExecution === 'all',
      requiredNodes: missingNodes.length === 0,
      errorWorkflow:
        row.id === 'urtoris-global-error-handler' ||
        settings.errorWorkflow === 'urtoris-global-error-handler',
      binding:
        !businessIds.has(row.id) ||
        (nodeNames.has('绑定执行 (execution.bound)') &&
          nodeNames.has('归一绑定结果') &&
          nodeNames.has('绑定成功?')),
    };
    return {
      id: row.id,
      name: row.name,
      ok: Object.values(checks).every(Boolean),
      checks,
      missingNodes,
    };
  });

  const statusCounts = await all(
    `SELECT status, finished, COUNT(*) AS count
       FROM execution_entity
      GROUP BY status, finished
      ORDER BY status, finished`,
  );
  const staleRunning = await all(
    `SELECT id, "workflowId", "startedAt", "waitTill"
       FROM execution_entity
      WHERE status = 'running'
        AND "stoppedAt" IS NULL
        AND "startedAt" < datetime('now', '-10 minutes')
      ORDER BY id`,
  );

  let requestedExecutions = [];
  if (executionIds.length > 0) {
    requestedExecutions = await all(
      `SELECT id, "workflowId", status, finished, "startedAt", "stoppedAt", "waitTill"
         FROM execution_entity
        WHERE id IN (${executionIds.map(() => '?').join(', ')})
        ORDER BY id`,
      executionIds,
    );
  }
  const requestedFinal =
    requestedExecutions.length === executionIds.length &&
    requestedExecutions.every(
      (row) =>
        row.status !== 'running' &&
        row.stoppedAt !== null &&
        row.waitTill === null,
    );

  const report = {
    ok:
      tables.every((table) => table.present) &&
      workflows.length === workflowIds.length &&
      workflows.every((workflow) => workflow.ok) &&
      staleRunning.length === 0 &&
      requestedFinal,
    database: basename(databasePath),
    readonly: true,
    expectedWorkflowCount: workflowIds.length,
    tables,
    workflows,
    executions: {
      statusCounts,
      staleRunning,
      requested: requestedExecutions,
      requestedFinal,
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
