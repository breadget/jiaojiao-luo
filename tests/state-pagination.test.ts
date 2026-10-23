import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { installDatabaseMock, seedWorkflow } from './helpers/api';
import { createTestDatabase } from './helpers/d1';

const database = createTestDatabase();
installDatabaseMock(database.d1);

type StateRoute = typeof import('@/app/api/state/route');
let route!: StateRoute;

describe('GET /api/state · 运行台账分页', () => {
  before(async () => {
    await seedWorkflow(database.d1, {
      id: 'wf_state_pages',
      version: 1,
      publishedSteps: [
        {
          id: 'step_output',
          title: '输出',
          detail: '完成',
          kind: 'output',
        },
      ],
    });
    for (let index = 0; index < 10; index += 1) {
      await database.d1
        .prepare(
          `INSERT INTO runs (
            id, workflow_id, workflow_name, workflow_version, status,
            steps_json, logs_json, output_json, started_at, finished_at,
            engine, degraded
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `run_page_${String(index).padStart(2, '0')}`,
          'wf_state_pages',
          '分页工作流',
          1,
          'completed',
          '[]',
          '[]',
          JSON.stringify({
            summary: `#${index}`,
            processed: 1,
            result: '完成',
          }),
          1_800_000_000_000 + index,
          1_800_000_000_100 + index,
          'simulated',
          0,
        )
        .run();
    }
    route = await import('@/app/api/state/route');
  });

  after(() => database.close());

  it('每页 8 条，上下页标记与窗口一致', async () => {
    const first = (await (
      await route.GET(new Request('http://localhost:3000/api/state?runPage=0'))
    ).json()) as {
      runs: Array<{ id: string }>;
      runPagination: {
        page: number;
        hasPrevious: boolean;
        hasNext: boolean;
      };
    };
    const second = (await (
      await route.GET(new Request('http://localhost:3000/api/state?runPage=1'))
    ).json()) as typeof first;

    assert.equal(first.runs.length, 8);
    assert.deepEqual(first.runPagination, {
      page: 0,
      hasPrevious: false,
      hasNext: true,
    });
    assert.equal(second.runs.length, 2);
    assert.deepEqual(second.runPagination, {
      page: 1,
      hasPrevious: true,
      hasNext: false,
    });
    assert.equal(
      first.runs.some((run) => second.runs.some((item) => item.id === run.id)),
      false,
    );
  });
});
