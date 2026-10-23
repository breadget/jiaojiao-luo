import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  ADMIN_TOKEN,
  adminRequest,
  graphContext,
  installDatabaseMock,
  readJson,
  seedWorkflow,
} from './helpers/api';
import { env } from './helpers/cloudflare-workers-stub';
import { createTestDatabase } from './helpers/d1';
import { localDatabaseGraph } from './helpers/local-database-graph';
import { canaryGraph } from './helpers/graph';
import { hashGraphContent } from '@/lib/workflow-graph/hash';

const database = createTestDatabase();
installDatabaseMock(database.d1);
let graphs!: typeof import('@/lib/server/workflow-graph-store');
let versions!: typeof import('@/lib/server/workflow-version-store');
let workflows!: typeof import('@/lib/server/workflow-store');
let previewRoute!: typeof import('@/app/api/workflows/[id]/graph/preview/route');
let publishRoute!: typeof import('@/app/api/workflows/[id]/graph/publish/route');
let rollbackRoute!: typeof import('@/app/api/workflows/[id]/graph/versions/[versionId]/rollback/route');

async function seedLocal(
  id: string,
  filePath = '/Users/me/data/orders.sqlite',
) {
  await seedWorkflow(database.d1, {
    id,
    n8nWebhookUrl: 'https://n8n.example.com/webhook/old',
  });
  return graphs.saveWorkflowGraphDraft({
    workflowId: id,
    graph: localDatabaseGraph(id, filePath),
    expectedRevision: 0,
  });
}

describe('本机 SQLite 工作流发布快照', () => {
  before(async () => {
    env.URTORIS_ADMIN_TOKEN = ADMIN_TOKEN;
    graphs = await import('@/lib/server/workflow-graph-store');
    versions = await import('@/lib/server/workflow-version-store');
    workflows = await import('@/lib/server/workflow-store');
    previewRoute = await import('@/app/api/workflows/[id]/graph/preview/route');
    publishRoute = await import('@/app/api/workflows/[id]/graph/publish/route');
    rollbackRoute =
      await import('@/app/api/workflows/[id]/graph/versions/[versionId]/rollback/route');
  });
  after(() => database.close());

  it('预览与发布识别 local adapter，生成相同 hash，无 n8n 凭据/绑定', async () => {
    const id = 'wf_local_preview_publish';
    const draft = await seedLocal(id);
    const preview = await readJson<{
      ok: boolean;
      adapter: string;
      adapterLocked: boolean;
      compiledHash: string;
      compiledJson: string;
    }>(
      await previewRoute.POST(
        adminRequest(`https://urtoris.test/api/workflows/${id}/graph/preview`, {
          method: 'POST',
          body: {},
        }),
        graphContext(id),
      ),
    );
    assert.equal(preview.ok, true);
    assert.equal(preview.adapter, 'local-sqlite');
    assert.equal(preview.adapterLocked, false);
    assert.equal(
      JSON.parse(preview.compiledJson).format,
      'urtoris.local-sqlite.v1',
    );
    const response = await publishRoute.POST(
      adminRequest(`https://urtoris.test/api/workflows/${id}/graph/publish`, {
        method: 'POST',
        body: {
          expectedRevision: draft.graph.revision,
          expectedGraphHash: draft.hash,
          webhookPath: 'ignored-for-local',
        },
      }),
      graphContext(id),
    );
    assert.equal(response.status, 200);
    const published = await readJson<{
      version: import('@/lib/server/workflow-version-store').PublishedVersion;
      adapterLocked: boolean;
      imported: boolean;
    }>(response);
    assert.equal(published.adapterLocked, false);
    assert.equal(published.imported, false);
    assert.equal(published.version.compiledHash, preview.compiledHash);
    assert.equal(published.version.graph.runtime.engine, 'local-sqlite');
    assert.equal(
      published.version.graphHash,
      await hashGraphContent(published.version.graph),
    );
    assert.equal(published.version.webhookPath, null);
    assert.deepEqual(published.version.bindings, []);
    const workflow = await workflows.getWorkflowById(id);
    assert.ok(workflow?.publishedSteps?.length);
    assert.equal(
      workflow?.publishedSteps?.some((step) => step.title === '订单数据库'),
      true,
    );
    assert.equal(workflow?.n8nWebhookUrl, null);
    assert.equal(workflow?.hasUnpublishedChanges, false);
    assert.equal(workflow?.version, 1);
    assert.ok(workflow?.publishedAt);
    assert.equal(
      JSON.stringify(workflow?.publishedSteps).includes('/Users/me'),
      false,
    );
  });

  it('编辑草稿不会改已发布文件位置，重新发布新增版本，回滚恢复对应发布投影', async () => {
    const id = 'wf_local_immutable';
    const saved = await seedLocal(id);
    const original = (
      await versions.publishWorkflowGraph({
        workflowId: id,
        expectedRevision: saved.graph.revision,
      })
    ).version;
    const graph = localDatabaseGraph(id, '/Users/me/data/new.sqlite');
    graph.name = '新的数据库助手';
    graph.nodes.find((node) => node.type === 'database')!.name = '新的数据库';
    const next = await graphs.saveWorkflowGraphDraft({
      workflowId: id,
      graph,
      expectedRevision: saved.graph.revision,
    });
    assert.equal(
      (await versions.getActiveWorkflowVersion(id))?.graph.nodes.find(
        (node) => node.type === 'database',
      )?.config.filePath,
      '/Users/me/data/orders.sqlite',
    );
    const latest = (
      await versions.publishWorkflowGraph({
        workflowId: id,
        expectedRevision: next.graph.revision,
      })
    ).version;
    assert.equal(latest.version, 2);
    assert.notEqual(original.compiledHash, latest.compiledHash);
    await versions.rollbackWorkflowGraph({
      workflowId: id,
      versionId: original.id,
    });
    assert.equal((await workflows.getWorkflowById(id))?.name, '本机订单助手');
    assert.equal(
      (await workflows.getWorkflowById(id))?.publishedSteps?.some(
        (step) => step.title === '订单数据库',
      ),
      true,
    );
    assert.equal((await versions.listWorkflowVersions(id)).length, 2);
    assert.equal(
      (await versions.getWorkflowVersion(latest.id))?.graph.nodes.find(
        (node) => node.type === 'database',
      )?.config.filePath,
      '/Users/me/data/new.sqlite',
    );
  });

  it('未填文件位置的草稿可保存，发布失败没有版本和使用端发布步骤', async () => {
    const id = 'wf_local_incomplete';
    const saved = await seedLocal(id, '');
    await assert.rejects(
      () =>
        versions.publishWorkflowGraph({
          workflowId: id,
          expectedRevision: saved.graph.revision,
        }),
      versions.GraphPublishRejected,
    );
    assert.equal((await versions.listWorkflowVersions(id)).length, 0);
    assert.equal((await workflows.getWorkflowById(id))?.publishedSteps, null);
  });

  it('投影和发布版本在同一事务中，投影失败不会留下半个发布', async () => {
    const id = 'wf_local_atomic';
    const saved = await seedLocal(id);
    await database.d1
      .exec(`CREATE TRIGGER reject_local_projection BEFORE UPDATE OF published_steps_json ON workflows
      WHEN NEW.id = '${id}' BEGIN SELECT RAISE(ABORT, 'projection rejected'); END;`);
    await assert.rejects(
      () =>
        versions.publishWorkflowGraph({
          workflowId: id,
          expectedRevision: saved.graph.revision,
        }),
      /projection rejected/,
    );
    assert.equal((await versions.listWorkflowVersions(id)).length, 0);
    assert.equal(await versions.getActiveGraphVersionId(id), null);
    assert.equal((await workflows.getWorkflowById(id))?.publishedSteps, null);
  });

  it('旧 n8n 图继续使用原编译器和发布 hash', async () => {
    const id = 'wf_n8n_still_n8n';
    await seedWorkflow(database.d1, { id });
    const saved = await graphs.saveWorkflowGraphDraft({
      workflowId: id,
      graph: canaryGraph(id),
      expectedRevision: 0,
    });
    const preview = await versions.previewWorkflowGraph({
      workflowId: id,
      graph: saved.graph,
    });
    const published = (
      await versions.publishWorkflowGraph({
        workflowId: id,
        expectedRevision: saved.graph.revision,
      })
    ).version;
    assert.equal(published.adapter, 'n8n-v1');
    assert.equal(published.compiledHash, preview.compiledHash);
    assert.ok(published.bindings.length);
    assert.equal(published.graph.runtime.engine, 'n8n');
  });

  it('本机版本回滚到缺少执行配置的历史 n8n 明确返回422，指针和所有工作流数据保持原样', async () => {
    const id = 'wf_cross_adapter_rollback';
    await seedWorkflow(database.d1, {
      id,
      n8nWebhookUrl: 'https://n8n.example.com/webhook/original',
    });
    const n8nDraft = await graphs.saveWorkflowGraphDraft({
      workflowId: id,
      graph: canaryGraph(id),
      expectedRevision: 0,
    });
    const n8nVersion = (
      await versions.publishWorkflowGraph({
        workflowId: id,
        expectedRevision: n8nDraft.graph.revision,
      })
    ).version;
    const localDraft = await graphs.saveWorkflowGraphDraft({
      workflowId: id,
      graph: localDatabaseGraph(id),
      expectedRevision: n8nDraft.graph.revision,
    });
    const localVersion = (
      await versions.publishWorkflowGraph({
        workflowId: id,
        expectedRevision: localDraft.graph.revision,
      })
    ).version;
    const before = await database.d1
      .prepare('SELECT * FROM workflows WHERE id = ?')
      .bind(id)
      .first();
    const beforeVersions = await database.d1
      .prepare(
        'SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version',
      )
      .bind(id)
      .all();
    await assert.rejects(
      () =>
        versions.rollbackWorkflowGraph({
          workflowId: id,
          versionId: n8nVersion.id,
        }),
      (cause: unknown) => {
        assert.ok(cause instanceof versions.GraphPublishRejected);
        assert.match(cause.message, /重新发布 n8n 草稿并重新绑定 Webhook/);
        return true;
      },
    );
    const response = await rollbackRoute.POST(
      adminRequest(
        `https://urtoris.test/api/workflows/${id}/graph/versions/${n8nVersion.id}/rollback`,
        { method: 'POST' },
      ),
      { params: Promise.resolve({ id, versionId: n8nVersion.id }) },
    );
    assert.equal(response.status, 422);
    const body = await readJson<{
      error: string;
      issues: { level: string; message: string }[];
    }>(response);
    assert.match(body.error, /旧 n8n 版本缺少恢复执行配置/);
    assert.equal(body.issues[0].level, 'error');
    assert.equal(await versions.getActiveGraphVersionId(id), localVersion.id);
    assert.deepEqual(
      await database.d1
        .prepare('SELECT * FROM workflows WHERE id = ?')
        .bind(id)
        .first(),
      before,
    );
    assert.deepEqual(
      (
        await database.d1
          .prepare(
            'SELECT * FROM workflow_versions WHERE workflow_id = ? ORDER BY version',
          )
          .bind(id)
          .all()
      ).results,
      beforeVersions.results,
    );
  });
});
