/** Uses an ephemeral headless Edge profile; all requests stay on loopback. No response mocks. */
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root)
  throw new Error('CLONE_MARKER_REQUIRED');
const marker = JSON.parse(
  readFileSync(join(root, 'graph-runtime-clone.json'), 'utf8'),
);
assert.equal(marker.marker, 'isolated-urtoris-graph-canary');
const secrets = JSON.parse(
  readFileSync(join(root, 'test-secrets.json'), 'utf8'),
);
const require = createRequire(
  realpathSync(join(root, 'node_modules/playwright/package.json')),
);
const { chromium } = require('playwright');
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CANARY_EDGE_PATH,
});
try {
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1050 },
  });
  page.on('pageerror', (error: Error) =>
    console.log('BROWSER_ERROR', error.message),
  );
  page.on('requestfailed', (request: { url(): string; failure(): unknown }) =>
    console.log('FAILED', request.url(), request.failure()),
  );
  page.on('console', (message: { type(): string; text(): string }) => {
    if (message.type() === 'error') console.log('CONSOLE', message.text());
  });
  await page.addInitScript(
    (token: string) => sessionStorage.setItem('urtoris.admin.token.v1', token),
    secrets.admin,
  );
  await page.route(
    '**/*',
    async (route: {
      request(): { url(): string };
      abort(): Promise<void>;
      continue(): Promise<void>;
    }) => {
      const url = new URL(route.request().url());
      if (!['127.0.0.1', 'localhost'].includes(url.hostname))
        await route.abort();
      else await route.continue();
    },
  );
  // Studio's Run button currently has no prompt field. Supply synthetic request input;
  // the request, n8n response, telemetry HTTP and DOM are all real.
  await page.route(
    '**/api/runs',
    async (route: {
      request(): { method(): string; postDataJSON(): object };
      continue(options?: object): Promise<void>;
    }) => {
      if (route.request().method() === 'POST')
        await route.continue({
          postData: JSON.stringify({
            ...route.request().postDataJSON(),
            message: 'Studio browser canary',
            input: { channel: 'web', urgency: 'high' },
          }),
        });
      else await route.continue();
    },
  );
  await fetch('http://127.0.0.1:5690/canary/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"mode":"success"}',
  });
  await page.goto('http://127.0.0.1:3000/studio');
  await page
    .getByRole('button', { name: '运行既有发布绑定', exact: true })
    .waitFor({ timeout: 60000 });
  await page.waitForFunction(() =>
    document.body.innerText.includes('D1 graph'),
  );
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page
    .locator('select:has(option[value="wf_n8n_graph_canary"])')
    .selectOption('wf_n8n_graph_canary');
  await page.getByLabel('工作流名称', { exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      (document.querySelector('[aria-label="工作流名称"]') as HTMLInputElement)
        ?.value === 'Graph runtime clone canary',
  );
  const responsePromise = page.waitForResponse(
    (r: { url(): string; request(): { method(): string } }) =>
      r.url().endsWith('/api/runs') && r.request().method() === 'POST',
    { timeout: 90000 },
  );
  await page
    .getByRole('button', { name: '运行既有发布绑定', exact: true })
    .click();
  const response = await responsePromise;
  const run = await response.json();
  assert.equal(run.envelope.success, true);
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.studio-node-state-success').length === 6 &&
      document.querySelectorAll('.studio-node-state-skipped').length === 1,
    undefined,
    { timeout: 60000 },
  );
  const locked = await page
    .getByRole('button', {
      name: '部署锁定：Adapter canary 未通过前不导入 n8n',
      exact: true,
    })
    .isDisabled();
  assert.equal(locked, true);
  const states = await page
    .locator('.react-flow__node')
    .evaluateAll((nodes: Element[]) =>
      nodes.map((node) => ({
        nodeId: node.getAttribute('data-id'),
        state: node
          .querySelector('.studio-node')
          ?.className.match(/studio-node-state-(\w+)/)?.[1],
      })),
    );
  assert.equal(
    states.find((n: { nodeId: string }) => n.nodeId === 'node_high')?.state,
    'success',
  );
  assert.equal(
    states.find((n: { nodeId: string }) => n.nodeId === 'node_normal')?.state,
    'skipped',
  );
  await page.waitForFunction(() => document.body.innerText.includes('已定稿'));
  await page.screenshot({
    path: join(root, 'studio-canary.png'),
    fullPage: true,
  });
  await fetch('http://127.0.0.1:5690/canary/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"mode":"wrong-key"}',
  });
  const failureResponse = page.waitForResponse(
    (r: { url(): string; request(): { method(): string } }) =>
      r.url().endsWith('/api/runs') && r.request().method() === 'POST',
    { timeout: 90000 },
  );
  await page
    .getByRole('button', { name: '运行既有发布绑定', exact: true })
    .click();
  const failed = await (await failureResponse).json();
  assert.equal(failed.envelope.success, false);
  await page.waitForFunction(
    () => document.querySelectorAll('.studio-node-state-error').length === 2,
    undefined,
    { timeout: 60000 },
  );
  await page.locator('.react-flow__node[data-id="node_model"]').click();
  const inspector = await page.locator('.studio-inspector').innerText();
  assert.ok(inspector.includes('LLM_ERROR'));
  assert.ok(inspector.includes('n8n execution failed.'));
  assert.ok(
    inspector.includes('Raw upstream content and credentials withheld'),
  );
  for (const secret of Object.values(secrets) as string[])
    assert.ok(!inspector.includes(secret));
  await page.waitForFunction(() => document.body.innerText.includes('已定稿'));
  await page.screenshot({
    path: join(root, 'studio-failure.png'),
    fullPage: true,
  });
  const failure = {
    requestId: failed.envelope.requestId,
    executionId: failed.envelope.meta.executionId,
    errorNodes: 2,
    code: 'LLM_ERROR',
    messageAndRedactedDetailVisible: true,
  };
  writeFileSync(
    join(root, 'studio-result.json'),
    JSON.stringify(
      {
        passed: true,
        requestId: run.envelope.requestId,
        executionId: run.envelope.meta.executionId,
        adapterLocked: locked,
        states,
        failure,
        input:
          'Synthetic prompt supplied in outgoing request; no HTTP responses or telemetry mocked.',
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: true, states, failure }));
} finally {
  await fetch('http://127.0.0.1:5690/canary/control', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"mode":"success"}',
  });
  await browser.close();
}
