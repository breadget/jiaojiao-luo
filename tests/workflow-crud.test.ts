import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  installDatabaseMock,
  adminRequest,
  graphContext,
  readJson,
  seedWorkflow,
} from './helpers/api';
import { resetEnv } from './helpers/cloudflare-workers-stub';
import { createTestDatabase, type TestDatabase } from './helpers/d1';

const database: TestDatabase = createTestDatabase();
installDatabaseMock(database.d1);

type DeleteRoute = typeof import('@/app/api/workflows/[id]/route');
type WorkflowRoute = typeof import('@/app/api/workflows/route');
type WorkflowStore = typeof import('@/lib/server/workflow-store');

let deleteRoute!: DeleteRoute;
let workflowRoute!: WorkflowRoute;
let workflowStore!: WorkflowStore;

const step = {
  id: 'step_input',
  title: '接收请求',
  detail: '接收用户输入',
  kind: 'input' as const,
};

before(async () => {
  resetEnv({ URTORIS_ADMIN_TOKEN: 'test-admin-token' });
  await seedWorkflow(database.d1, {
    id: 'wf_keep',
    name: '保留工作流',
    draftSteps: [step],
  });
  await seedWorkflow(database.d1, {
    id: 'wf_remove',
    name: '待删除工作流',
    draftSteps: [step],
  });
  deleteRoute = await import('@/app/api/workflows/[id]/route');
  workflowRoute = await import('@/app/api/workflows/route');
  workflowStore = await import('@/lib/server/workflow-store');
});

after(() => database.close());

describe('工作流列表 CRUD', () => {
  it('删除需要管理员权限，软删除后从活动列表隐藏且不能被旧表单复活', async () => {
    const unauthorized = await deleteRoute.DELETE(
      adminRequest('https://urtoris.test/api/workflows/wf_remove', {
        method: 'DELETE',
        token: null,
      }),
      graphContext('wf_remove'),
    );
    assert.equal(unauthorized.status, 401);

    const deleted = await deleteRoute.DELETE(
      adminRequest('https://urtoris.test/api/workflows/wf_remove', {
        method: 'DELETE',
      }),
      graphContext('wf_remove'),
    );
    assert.equal(deleted.status, 200);
    assert.deepEqual(await readJson(deleted), {
      deleted: true,
      workflowId: 'wf_remove',
    });

    assert.equal(await workflowStore.getWorkflowById('wf_remove'), null);
    assert.deepEqual(
      (await workflowStore.listWorkflows()).map((item) => item.id),
      ['wf_keep'],
    );
    const stored = await database.d1
      .prepare(`SELECT deleted_at FROM workflows WHERE id = ?`)
      .bind('wf_remove')
      .first<{ deleted_at: number | null }>();
    assert.equal(typeof stored?.deleted_at, 'number');

    const staleSave = await workflowRoute.POST(
      adminRequest('https://urtoris.test/api/workflows', {
        method: 'POST',
        body: {
          id: 'wf_remove',
          name: '不应复活',
          description: '旧页面提交',
          steps: [step],
          action: 'save',
        },
      }),
    );
    assert.equal(staleSave.status, 404);
    assert.equal(await workflowStore.getWorkflowById('wf_remove'), null);
  });

  it('保护最后一个活动工作流并对未知编号返回 404', async () => {
    const last = await deleteRoute.DELETE(
      adminRequest('https://urtoris.test/api/workflows/wf_keep', {
        method: 'DELETE',
      }),
      graphContext('wf_keep'),
    );
    assert.equal(last.status, 409);
    assert.match((await readJson<{ error: string }>(last)).error, /至少保留/);

    const missing = await deleteRoute.DELETE(
      adminRequest('https://urtoris.test/api/workflows/wf_missing', {
        method: 'DELETE',
      }),
      graphContext('wf_missing'),
    );
    assert.equal(missing.status, 404);
  });
});
