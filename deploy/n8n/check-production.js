#!/usr/bin/env node

/**
 * Read-only production checks for the Urtoris n8n SQLite database.
 *
 * Run on the ECS as the n8n data owner:
 *   node check-production.js [executionId ...]
 *
 * This script never prints workflow JSON, credentials, or environment values.
 */

import { createRequire } from 'node:module';

const loadN8nDependency = createRequire(import.meta.url);
const sqlite3 = loadN8nDependency('/usr/lib/node_modules/n8n/node_modules/sqlite3');

const databasePath = process.env.N8N_DATABASE_PATH || '/root/.n8n/database.sqlite';
const executionIds = process.argv
  .slice(2)
  .filter((value) => /^[0-9]+$/.test(value));

const expected = {
  'urtoris-common-envelope': { defaultMode: true },
  'urtoris-gateway': { earlyBinding: true, defaultMode: true },
  'urtoris-wf-api-gateway': {
    earlyBinding: true,
    modeMarker: true,
    w4Allowlist: true,
  },
  'urtoris-wf-customer-insights': { earlyBinding: true, modeMarker: true },
  'urtoris-wf-llm-smoke': {
    earlyBinding: true,
    modeMarker: true,
    w1Fallback: true,
  },
  'urtoris-wf-security-analysis': { earlyBinding: true, modeMarker: true },
  'urtoris-wf-user-manager': { earlyBinding: true, modeMarker: true },
};

const db = new sqlite3.Database(databasePath, sqlite3.OPEN_READONLY);

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

async function main() {
  const workflowIds = Object.keys(expected);
  const placeholders = workflowIds.map(() => '?').join(', ');
  const workflowRows = await all(
    `SELECT id, name, active, nodes, settings
       FROM workflow_entity
      WHERE id IN (${placeholders})
      ORDER BY id`,
    workflowIds,
  );

  const workflows = workflowRows.map((row) => {
    const nodeNames = new Set(JSON.parse(row.nodes).map((node) => node.name));
    const settings = JSON.parse(row.settings || '{}');
    const requirements = expected[row.id];
    const checks = {
      active: Boolean(row.active),
      saveSuccessAll: settings.saveDataSuccessExecution === 'all',
      saveErrorAll: settings.saveDataErrorExecution === 'all',
      earlyBinding:
        nodeNames.has('建立 executionId 映射') &&
        nodeNames.has('上报执行映射') &&
        nodeNames.has('恢复 Webhook 请求'),
      modeMarker: nodeNames.has('标记执行模式'),
      defaultMode: nodeNames.has('补齐模式字段'),
      w1Fallback: row.nodes.includes('URTORIS_RULES_FALLBACK_V1'),
      w4Allowlist: row.nodes.includes('URTORIS_W4_ALLOWLIST_V1'),
    };
    const requiredChecks = Object.entries(requirements).every(
      ([key, value]) => checks[key] === value,
    );
    return {
      id: row.id,
      name: row.name,
      ok:
        checks.active &&
        checks.saveSuccessAll &&
        checks.saveErrorAll &&
        requiredChecks,
      checks,
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
        AND "startedAt" < datetime('now', '-10 minutes')
      ORDER BY id`,
  );

  let requestedExecutions = [];
  if (executionIds.length > 0) {
    const executionPlaceholders = executionIds.map(() => '?').join(', ');
    requestedExecutions = await all(
      `SELECT id, "workflowId", status, finished, "startedAt", "stoppedAt", "waitTill"
         FROM execution_entity
        WHERE id IN (${executionPlaceholders})
        ORDER BY id`,
      executionIds,
    );
  }

  const report = {
    ok:
      workflows.length === workflowIds.length &&
      workflows.every((workflow) => workflow.ok) &&
      staleRunning.length === 0,
    workflows,
    executions: {
      statusCounts,
      staleRunning,
      requested: requestedExecutions,
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
