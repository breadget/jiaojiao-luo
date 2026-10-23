import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checker = join(repositoryRoot, 'deploy/n8n/check-upgrade-clone.js');
const sqliteStub = join(
  repositoryRoot,
  'tests/fixtures/sqlite3-upgrade-clone-stub.cjs',
);
const canaryRoot = mkdtempSync(join(tmpdir(), 'n8n-canary-check-'));
const databasePath = join(canaryRoot, 'database.sqlite');
writeFileSync(databasePath, 'stub');

after(() => rmSync(canaryRoot, { recursive: true, force: true }));

function run(input?: { mode?: string; executionIds?: string[] }) {
  return spawnSync(
    process.execPath,
    [checker, ...(input?.executionIds ?? [])],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        URTORIS_CLONE_CANARY: '1',
        N8N_CLONE_DATABASE_PATH: databasePath,
        N8N_SQLITE3_MODULE: sqliteStub,
        UPGRADE_CLONE_STUB_MODE: input?.mode ?? 'ok',
      },
    },
  );
}

describe('n8n 2.38.6 clone upgrade checker', () => {
  it('拒绝没有显式 clone 标记的调用', () => {
    const env = { ...process.env };
    delete env.URTORIS_CLONE_CANARY;
    delete env.N8N_CLONE_DATABASE_PATH;
    const result = spawnSync(process.execPath, [checker], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to run/);
  });

  it('11 个 workflow、表、策略与指定执行终态齐全时通过', () => {
    const result = run({ executionIds: ['101', '102'] });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      readonly: boolean;
      expectedWorkflowCount: number;
      workflows: unknown[];
      executions: { requestedFinal: boolean };
    };
    assert.equal(report.ok, true);
    assert.equal(report.readonly, true);
    assert.equal(report.expectedWorkflowCount, 11);
    assert.equal(report.workflows.length, 11);
    assert.equal(report.executions.requestedFinal, true);
  });

  for (const [mode, label] of [
    ['missing-workflow', '缺 workflow'],
    ['bad-settings', '成功保存策略不是 all'],
    ['stale-running', '存在陈旧 running'],
  ] as const) {
    it(`${label} 时 fail closed`, () => {
      const result = run({ mode });
      assert.equal(result.status, 1, result.stderr);
      const report = JSON.parse(result.stdout) as { ok: boolean };
      assert.equal(report.ok, false);
    });
  }
});
