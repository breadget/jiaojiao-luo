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
import { createTestDatabase, type TestDatabase } from './helpers/d1';
import { canaryGraph } from './helpers/graph';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

// 这两个模块会 import `@/db`，必须在 mock 注册之后动态加载，
// 否则拿到的是真实（workerd 专属）实现。
type GraphStore = typeof import('@/lib/server/workflow-graph-store');
type VersionStore = typeof import('@/lib/server/workflow-version-store');
let graphStore!: GraphStore;
let versionStore!: VersionStore;
const saveWorkflowGraphDraft: GraphStore['saveWorkflowGraphDraft'] = (
  ...args
) => graphStore.saveWorkflowGraphDraft(...args);
const previewWorkflowGraph: VersionStore['previewWorkflowGraph'] = (...args) =>
  versionStore.previewWorkflowGraph(...args);

type PublishRoute =
  typeof import('@/app/api/workflows/[id]/graph/publish/route');
type VersionsRoute =
  typeof import('@/app/api/workflows/[id]/graph/versions/route');
type RollbackRoute =
  typeof import('@/app/api/workflows/[id]/graph/versions/[versionId]/rollback/route');
type PreviewRoute =
  typeof import('@/app/api/workflows/[id]/graph/preview/route');

let publishRoute!: PublishRoute;
let versionsRoute!: VersionsRoute;
let rollbackRoute!: RollbackRoute;
let previewRoute!: PreviewRoute;

type VersionSummary = {
  id: string;
  version: number;
  graphRevision: number;
  graphHash: string;
  compiledHash: string | null;
  nodeCount: number;
  connectionCount: number;
  active: boolean;
};

async function countVersions(workflowId: string) {
  const row = await database.d1
    .prepare(
      `SELECT COUNT(*) AS total FROM workflow_versions WHERE workflow_id = ?`,
    )
    .bind(workflowId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function countBindings(versionId: string) {
  const row = await database.d1
    .prepare(
      `SELECT COUNT(*) AS total FROM workflow_node_bindings WHERE workflow_version_id = ?`,
    )
    .bind(versionId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function activePointer(workflowId: string) {
  const row = await database.d1
    .prepare(`SELECT active_graph_version_id FROM workflows WHERE id = ?`)
    .bind(workflowId)
    .first<{ active_graph_version_id: string | null }>();
  return row?.active_graph_version_id ?? null;
}

function urlFor(id: string, suffix = '') {
  // 非本机域名：本机访问免令牌（见 admin-trust.test.ts），这里守的是公网入口的令牌要求。
  return `https://urtoris.test/api/workflows/${id}/graph${suffix}`;
}

/** 建工作流 + 存一份草稿，返回草稿 revision。 */
async function seedDraft(id: string, graph: WorkflowGraphV1 = canaryGraph(id)) {
  await seedWorkflow(database.d1, { id, draftSteps: [] });
  const saved = await saveWorkflowGraphDraft({
    workflowId: id,
    graph,
    expectedRevision: 0,
    updatedBy: 'test',
  });
  return saved.graph.revision;
}

async function publish(id: string, body: Record<string, unknown>) {
  return publishRoute.POST(
    adminRequest(urlFor(id, '/publish'), { method: 'POST', body }),
    graphContext(id),
  );
}

async function listVersions(id: string) {
  const response = await versionsRoute.GET(
    adminRequest(urlFor(id, '/versions'), {
      headers: { 'X-Real-IP': '10.4.4.4' },
    }),
    graphContext(id),
  );
  return readJson<{
    versions: VersionSummary[];
    activeVersionId: string | null;
  }>(response);
}

async function rollback(id: string, versionId: string) {
  return rollbackRoute.POST(
    adminRequest(urlFor(id, `/versions/${versionId}/rollback`), {
      method: 'POST',
    }),
    { params: Promise.resolve({ id, versionId }) },
  );
}

describe('不可变发布版本', () => {
  before(async () => {
    env.URTORIS_ADMIN_TOKEN = ADMIN_TOKEN;
    graphStore = await import('@/lib/server/workflow-graph-store');
    versionStore = await import('@/lib/server/workflow-version-store');
    publishRoute = await import('@/app/api/workflows/[id]/graph/publish/route');
    versionsRoute =
      await import('@/app/api/workflows/[id]/graph/versions/route');
    rollbackRoute =
      await import('@/app/api/workflows/[id]/graph/versions/[versionId]/rollback/route');
    previewRoute = await import('@/app/api/workflows/[id]/graph/preview/route');
  });

  after(() => {
    database.close();
  });

  it('四条路由都要求管理员令牌', async () => {
    const anonymous = { token: null };
    assert.equal(
      (
        await publishRoute.POST(
          adminRequest(urlFor('wf_x', '/publish'), {
            ...anonymous,
            method: 'POST',
            body: {},
          }),
          graphContext('wf_x'),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await versionsRoute.GET(
          adminRequest(urlFor('wf_x', '/versions'), anonymous),
          graphContext('wf_x'),
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await rollbackRoute.POST(
          adminRequest(urlFor('wf_x', '/versions/v1/rollback'), {
            ...anonymous,
            method: 'POST',
          }),
          { params: Promise.resolve({ id: 'wf_x', versionId: 'v1' }) },
        )
      ).status,
      401,
    );
    assert.equal(
      (
        await previewRoute.POST(
          adminRequest(urlFor('wf_x', '/preview'), {
            ...anonymous,
            method: 'POST',
            body: {},
          }),
          graphContext('wf_x'),
        )
      ).status,
      401,
    );
  });

  it('没有草稿时拒绝发布，且不写任何行', async () => {
    await seedWorkflow(database.d1, { id: 'wf_nodraft', draftSteps: [] });
    const response = await publish('wf_nodraft', { expectedRevision: 0 });
    assert.equal(response.status, 422);
    const body = await readJson<{ issues: { message: string }[] }>(response);
    assert.ok(
      body.issues.some((issue) => issue.message.includes('还没有保存过')),
    );
    assert.equal(await countVersions('wf_nodraft'), 0);
    assert.equal(await activePointer('wf_nodraft'), null);
  });

  it('发布成功：写入版本快照、绑定行，并移动发布指针', async () => {
    const revision = await seedDraft('wf_pub');
    const response = await publish('wf_pub', { expectedRevision: revision });
    assert.equal(response.status, 200);
    const body = await readJson<{
      version: VersionSummary & { id: string };
      imported: boolean;
      adapterLocked: boolean;
    }>(response);
    assert.equal(body.version.version, 1);
    assert.equal(body.version.graphRevision, revision);
    assert.equal(body.version.nodeCount, 9);
    assert.equal(body.version.active, true);
    assert.equal(body.imported, false);
    assert.equal(body.adapterLocked, true);
    // Adapter v1.1 adds deterministic input/envelope Code nodes while the
    // published graph still contains the original nine internal nodes.
    assert.equal(await countBindings(body.version.id), 13);
    assert.equal(await activePointer('wf_pub'), body.version.id);
  });

  it('内容哈希与 revision / 保存时间无关（"预览即承诺"的前提）', async () => {
    const id = 'wf_hashstable';
    await seedWorkflow(database.d1, { id, draftSteps: [] });
    const first = await saveWorkflowGraphDraft({
      workflowId: id,
      graph: canaryGraph(id),
      expectedRevision: 0,
      updatedBy: 'test',
    });
    const second = await saveWorkflowGraphDraft({
      workflowId: id,
      graph: canaryGraph(id),
      expectedRevision: 1,
      updatedBy: 'test',
    });
    assert.equal(second.graph.revision, 2, 'revision 照常递增');
    assert.equal(first.hash, second.hash, '内容没变，哈希就不该变');

    const preview = await previewWorkflowGraph({
      workflowId: id,
      graph: canaryGraph(id),
    });
    assert.equal(preview.graphHash, second.hash);
    assert.equal(preview.nextVersion, 1, '还没发布过，预览用版本 1');
  });

  it('发布写入的 compiled_hash 与编译预览一致（预览即承诺）', async () => {
    await seedDraft('wf_preview');
    const preview = await previewRoute.POST(
      adminRequest(urlFor('wf_preview', '/preview'), {
        method: 'POST',
        body: { graph: canaryGraph('wf_preview') },
      }),
      graphContext('wf_preview'),
    );
    assert.equal(preview.status, 200);
    const previewBody = await readJson<{
      nextVersion: number;
      compiledHash: string;
      ok: boolean;
    }>(preview);

    const response = await publish('wf_preview', {
      expectedRevision: 1,
    });
    const published = await readJson<{
      version: VersionSummary & { id: string };
    }>(response);
    assert.equal(published.version.version, previewBody.nextVersion);
    assert.equal(published.version.compiledHash, previewBody.compiledHash);
  });

  it('已发布版本不可被覆盖：再发布一次只新增版本', async () => {
    const id = 'wf_immutable';
    await seedDraft(id);
    const first = await readJson<{ version: VersionSummary & { id: string } }>(
      await publish(id, { expectedRevision: 1 }),
    );

    // 草稿继续改（revision 2），再发布 → v2
    await saveWorkflowGraphDraft({
      workflowId: id,
      graph: { ...canaryGraph(id), name: '改过名字的工作流' },
      expectedRevision: 1,
      updatedBy: 'test',
    });
    const second = await readJson<{ version: VersionSummary & { id: string } }>(
      await publish(id, { expectedRevision: 2 }),
    );

    assert.equal(first.version.version, 1);
    assert.equal(second.version.version, 2);
    assert.notEqual(first.version.id, second.version.id);
    // v1 的内容与哈希逐字未变
    const stored = await database.d1
      .prepare(
        `SELECT graph_hash, compiled_hash, graph_json FROM workflow_versions WHERE id = ?`,
      )
      .bind(first.version.id)
      .first<{
        graph_hash: string;
        compiled_hash: string;
        graph_json: string;
      }>();
    assert.equal(stored?.graph_hash, first.version.graphHash);
    assert.equal(stored?.compiled_hash, first.version.compiledHash);
    assert.equal(JSON.parse(stored?.graph_json ?? '{}').name, 'Canary 工作流');

    const list = await listVersions(id);
    assert.deepEqual(
      list.versions.map((version) => version.version),
      [2, 1],
    );
    assert.equal(list.activeVersionId, second.version.id);
    assert.equal(list.versions.filter((version) => version.active).length, 1);
  });

  it('草稿 revision 与发布 version 是两套编号', async () => {
    const id = 'wf_counters';
    await seedDraft(id);
    const published = await readJson<{ version: VersionSummary }>(
      await publish(id, { expectedRevision: 1 }),
    );
    assert.equal(published.version.version, 1);
    assert.equal(published.version.graphRevision, 1);

    // 连改两次草稿都不发布：version 仍停在 1
    await saveWorkflowGraphDraft({
      workflowId: id,
      graph: canaryGraph(id),
      expectedRevision: 1,
      updatedBy: 'test',
    });
    await saveWorkflowGraphDraft({
      workflowId: id,
      graph: canaryGraph(id),
      expectedRevision: 2,
      updatedBy: 'test',
    });
    const list = await listVersions(id);
    assert.equal(list.versions.length, 1);
    assert.equal(list.versions[0].graphRevision, 1);
  });

  it('expectedRevision 过期返回 409 与当前 revision', async () => {
    const id = 'wf_stale';
    await seedDraft(id);
    const response = await publish(id, { expectedRevision: 0 });
    assert.equal(response.status, 409);
    const body = await readJson<{ currentRevision: number }>(response);
    assert.equal(body.currentRevision, 1);
    assert.equal(await countVersions(id), 0);
  });

  it('expectedGraphHash 不匹配返回 409（本地有未保存修改）', async () => {
    const id = 'wf_hashmismatch';
    await seedDraft(id);
    const response = await publish(id, {
      expectedRevision: 1,
      expectedGraphHash: 'deadbeef',
    });
    assert.equal(response.status, 409);
    assert.equal(await countVersions(id), 0);
  });

  it('编译被拒时发布失败，库里不留半成品', async () => {
    const id = 'wf_reject';
    const graph = canaryGraph(id);
    graph.nodes.push({
      ...graph.nodes[0],
      id: 'node_db',
      type: 'database',
      name: '数据库',
      config: {},
    });
    await seedDraft(id, graph);
    const response = await publish(id, { expectedRevision: 1 });
    assert.equal(response.status, 422);
    const body = await readJson<{
      issues: { level: string; message: string }[];
    }>(response);
    assert.ok(body.issues.some((issue) => issue.message.includes('database')));
    assert.equal(await countVersions(id), 0);
    assert.equal(await activePointer(id), null);
  });

  it('写库中途失败会清理掉已写入的版本行（不留下孤儿版本）', async () => {
    const id = 'wf_atomic';
    await seedDraft(id);

    const patched = database.d1 as unknown as {
      batch: (statements: { run(): Promise<unknown> }[]) => Promise<unknown>;
    };
    const original = patched.batch.bind(database.d1);
    patched.batch = async (statements) => {
      // 模拟"非原子 batch"：先真的写进第一句，然后失败
      await statements[0].run();
      throw new Error('simulated batch failure');
    };
    try {
      await assert.rejects(() => publish(id, { expectedRevision: 1 }));
    } finally {
      patched.batch = original;
    }
    assert.equal(await countVersions(id), 0, '失败后不应留下版本行');
    assert.equal(await activePointer(id), null);
  });

  it('一键回滚把指针移回旧版本，且不移除新版本', async () => {
    const id = 'wf_rollback';
    await seedDraft(id);
    const v1 = await readJson<{ version: VersionSummary & { id: string } }>(
      await publish(id, { expectedRevision: 1 }),
    );
    await saveWorkflowGraphDraft({
      workflowId: id,
      graph: { ...canaryGraph(id), name: 'v2 草稿' },
      expectedRevision: 1,
      updatedBy: 'test',
    });
    const v2 = await readJson<{ version: VersionSummary & { id: string } }>(
      await publish(id, { expectedRevision: 2 }),
    );

    const response = await rollback(id, v1.version.id);
    assert.equal(response.status, 200);
    const body = await readJson<{
      version: VersionSummary;
      previousVersionId: string;
    }>(response);
    assert.equal(body.version.version, 1);
    assert.equal(body.previousVersionId, v2.version.id);
    assert.equal(await activePointer(id), v1.version.id);

    const list = await listVersions(id);
    assert.equal(list.versions.length, 2, '回滚不删除任何版本');
    assert.equal(list.versions.find((item) => item.active)?.version, 1);
  });

  it('回滚后可以再切回更新的版本', async () => {
    const id = 'wf_rollback2';
    await seedDraft(id);
    const v1 = await readJson<{ version: VersionSummary & { id: string } }>(
      await publish(id, { expectedRevision: 1 }),
    );
    await saveWorkflowGraphDraft({
      workflowId: id,
      graph: canaryGraph(id),
      expectedRevision: 1,
      updatedBy: 'test',
    });
    const v2 = await readJson<{ version: VersionSummary & { id: string } }>(
      await publish(id, { expectedRevision: 2 }),
    );

    assert.equal((await rollback(id, v1.version.id)).status, 200);
    assert.equal((await rollback(id, v2.version.id)).status, 200);
    assert.equal(await activePointer(id), v2.version.id);
  });

  it('回滚到不存在的版本返回 404，指针不动', async () => {
    const id = 'wf_rollback404';
    await seedDraft(id);
    const v1 = await readJson<{ version: VersionSummary & { id: string } }>(
      await publish(id, { expectedRevision: 1 }),
    );
    const response = await rollback(id, 'wfv_does_not_exist');
    assert.equal(response.status, 404);
    assert.equal(await activePointer(id), v1.version.id);
  });

  it('回滚不能跨工作流（版本属于别的工作流则 404）', async () => {
    const a = 'wf_cross_a';
    const b = 'wf_cross_b';
    await seedDraft(a);
    await seedDraft(b);
    const versionA = await readJson<{
      version: VersionSummary & { id: string };
    }>(await publish(a, { expectedRevision: 1 }));
    const response = await rollback(b, versionA.version.id);
    assert.equal(response.status, 404);
    assert.equal(await activePointer(b), null);
  });

  it('版本列表对未知工作流返回 404', async () => {
    const response = await versionsRoute.GET(
      adminRequest(urlFor('wf_unknown', '/versions')),
      graphContext('wf_unknown'),
    );
    assert.equal(response.status, 404);
  });

  it('发布接口的请求体上限是 64 KB', async () => {
    const id = 'wf_bigbody';
    await seedDraft(id);
    const response = await publish(id, {
      expectedRevision: 1,
      padding: 'x'.repeat(80 * 1024),
    });
    assert.equal(response.status, 413);
  });

  it('预览不写库：多次预览不产生任何版本', async () => {
    const id = 'wf_previewonly';
    await seedWorkflow(database.d1, { id, draftSteps: [] });
    for (let index = 0; index < 3; index += 1) {
      const response = await previewRoute.POST(
        adminRequest(urlFor(id, '/preview'), {
          method: 'POST',
          body: { graph: canaryGraph(id) },
        }),
        graphContext(id),
      );
      assert.equal(response.status, 200);
    }
    assert.equal(await countVersions(id), 0);
    assert.equal(await activePointer(id), null);
  });

  it('预览拒绝带凭据的图，并给出版本号与统计', async () => {
    const id = 'wf_previewsecret';
    await seedWorkflow(database.d1, { id, draftSteps: [] });
    const graph = canaryGraph(id);
    graph.nodes[1] = {
      ...graph.nodes[1],
      config: {
        ...graph.nodes[1].config,
        authorization: 'Bearer abcdefghijklmnop1234',
      },
    };
    const response = await previewRoute.POST(
      adminRequest(urlFor(id, '/preview'), { method: 'POST', body: { graph } }),
      graphContext(id),
    );
    assert.equal(response.status, 400);
  });

  it('previewWorkflowGraph 用下一个版本号，因此可重复得到同一个 hash', async () => {
    const id = 'wf_previewstable';
    await seedWorkflow(database.d1, { id, draftSteps: [] });
    const first = await previewWorkflowGraph({
      workflowId: id,
      graph: canaryGraph(id),
    });
    const second = await previewWorkflowGraph({
      workflowId: id,
      graph: canaryGraph(id),
    });
    assert.equal(first.nextVersion, 1);
    assert.equal(first.compiledHash, second.compiledHash);
  });
});
