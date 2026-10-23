import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { installDatabaseMock, nextAddress, seedWorkflow } from './helpers/api';
import { createTestDatabase } from './helpers/d1';
import { legacyWorkflow } from './helpers/graph';
import type { PublicWorkflowRecord } from '@/lib/workflow-types';

const database = createTestDatabase();
installDatabaseMock(database.d1);
let route: typeof import('@/app/api/state/route');
let toPublicWorkflow: typeof import('@/lib/server/workflow-store').toPublicWorkflow;

async function seedVersion(
  workflowId: string,
  id: string,
  version: number,
  adapter: string,
) {
  await database.d1
    .prepare(
      `INSERT INTO workflow_versions (
      id, workflow_id, version, schema_version, graph_json, graph_hash,
      adapter, adapter_version, published_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      workflowId,
      version,
      1,
      JSON.stringify({
        filePath: '/Users/private/secret-orders.db',
        pairingToken: 'never-public-local-token',
      }),
      `hash-${id}`,
      adapter,
      '1.0.0',
      1_800_000_000_000,
    )
    .run();
}

async function setActive(workflowId: string, versionId: string) {
  await database.d1
    .prepare('UPDATE workflows SET active_graph_version_id = ? WHERE id = ?')
    .bind(versionId, workflowId)
    .run();
}

async function readState(): Promise<{ workflows: PublicWorkflowRecord[] }> {
  const response = await route.GET(
    new Request('https://urtoris.cn/api/state', {
      headers: { 'X-Real-IP': nextAddress() },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return (await response.json()) as { workflows: PublicWorkflowRecord[] };
}

describe('public state · published local database capability', () => {
  before(async () => {
    for (const id of [
      'wf_db_active',
      'wf_db_history',
      'wf_db_draft',
      'wf_db_wrong_owner',
      'wf_db_ordinary',
    ]) {
      await seedWorkflow(database.d1, {
        id,
        version: 2,
        publishedSteps: [
          { id: 'output', title: '输出', detail: '完成', kind: 'output' },
        ],
      });
    }
    await seedVersion('wf_db_active', 'active_db_old_n8n', 1, 'n8n-v1');
    await seedVersion('wf_db_active', 'active_db_sqlite', 2, 'local-sqlite');
    await setActive('wf_db_active', 'active_db_sqlite');
    await seedVersion('wf_db_history', 'history_db_sqlite', 1, 'local-sqlite');
    await seedVersion('wf_db_history', 'history_db_n8n', 2, 'n8n-v1');
    await setActive('wf_db_history', 'history_db_n8n');
    await seedVersion('wf_db_draft', 'draft_db_n8n', 1, 'n8n-v1');
    await setActive('wf_db_draft', 'draft_db_n8n');
    await database.d1
      .prepare(
        `INSERT INTO workflow_graph_drafts (workflow_id, schema_version, revision, graph_json, graph_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        'wf_db_draft',
        1,
        5,
        JSON.stringify({
          runtime: { adapter: 'local-sqlite' },
          filePath: '/Users/private/unpublished.db',
        }),
        'draft-hash',
        1_800_000_000_000,
      )
      .run();
    await setActive('wf_db_wrong_owner', 'active_db_sqlite');
    route = await import('@/app/api/state/route');
    ({ toPublicWorkflow } = await import('@/lib/server/workflow-store'));
  });

  after(() => database.close());

  it('only flags the matching active published local-sqlite version', async () => {
    const state = await readState();
    const records = new Map(
      state.workflows.map((workflow) => [workflow.id, workflow]),
    );
    assert.equal(records.get('wf_db_active')?.databaseRuntime, 'local-sqlite');
    for (const id of [
      'wf_db_history',
      'wf_db_draft',
      'wf_db_wrong_owner',
      'wf_db_ordinary',
    ]) {
      assert.ok(records.has(id));
      assert.equal(
        Object.hasOwn(records.get(id)!, 'databaseRuntime'),
        false,
        id,
      );
    }
    const serialized = JSON.stringify(state);
    assert.ok(!serialized.includes('/Users/private/'));
    assert.ok(!serialized.includes('never-public-local-token'));
    assert.ok(!serialized.includes('graph_json'));
    assert.ok(!serialized.includes('databaseSession'));
  });

  it('the DTO explicitly permits only the known database runtime flag', () => {
    const internal = {
      ...legacyWorkflow(),
      databaseRuntime: 'local-sqlite' as const,
      filePath: '/Users/private/dto.sqlite',
      graph: { internal: true },
      databaseSession: 'private-signed-session',
      pairingToken: 'private-pairing-token',
    };
    const publicRecord = toPublicWorkflow(internal);
    assert.equal(publicRecord.databaseRuntime, 'local-sqlite');
    for (const property of [
      'filePath',
      'graph',
      'databaseSession',
      'pairingToken',
    ]) {
      assert.equal(Object.hasOwn(publicRecord, property), false);
    }
    assert.equal(
      Object.hasOwn(toPublicWorkflow(legacyWorkflow()), 'databaseRuntime'),
      false,
    );
    const invalid = { ...legacyWorkflow(), databaseRuntime: 'server' };
    assert.equal(
      Object.hasOwn(
        toPublicWorkflow(invalid as Parameters<typeof toPublicWorkflow>[0]),
        'databaseRuntime',
      ),
      false,
    );
  });

  it('switching the active version changes the flag without inspecting graph contents', async () => {
    await setActive('wf_db_active', 'active_db_old_n8n');
    let record = (await readState()).workflows.find(
      (workflow) => workflow.id === 'wf_db_active',
    );
    assert.equal(Object.hasOwn(record!, 'databaseRuntime'), false);
    await setActive('wf_db_active', 'active_db_sqlite');
    record = (await readState()).workflows.find(
      (workflow) => workflow.id === 'wf_db_active',
    );
    assert.equal(record?.databaseRuntime, 'local-sqlite');
  });
});
