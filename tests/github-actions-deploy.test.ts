import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const deployScriptUrl = new URL(
  '../deploy/github-actions/urtoris-runtime-deploy',
  import.meta.url,
);

describe('GitHub Actions production deploy script', () => {
  it('validates the runtime manifest and applies D1 migrations before stopping the current site', async () => {
    const script = await readFile(deployScriptUrl, 'utf8');
    const migration = script.indexOf('d1 migrations apply DB --local');
    const stop = script.indexOf('systemctl stop urtoris', migration);

    assert.match(script, /URTORIS_RUNTIME_V1/);
    assert.match(script, /URTORIS_RELEASE_SHA/);
    assert.ok(migration >= 0, 'D1 migration step is missing');
    assert.ok(
      stop > migration,
      'D1 migration must finish before the current site is stopped',
    );
    assert.match(script, /--persist-to \/var\/lib\/urtoris\/data/);
    assert.match(script, /\) < \/dev\/null/);
    assert.doesNotMatch(script, /^npm\s+.*\brun\s+build/m);
  });

  it('checks program dependencies and private setup before any service interruption, then requires worker health after the atomic swap', async () => {
    const script = await readFile(deployScriptUrl, 'utf8');
    const preparation = script.indexOf(
      'Workflow program service is not prepared',
    );
    const importCheck = script.indexOf(
      'await import("./services/workflow-program/server.ts")',
    );
    const migrate = script.indexOf('d1 migrations apply DB --local');
    const workerStop = script.indexOf(
      'systemctl stop urtoris-workflow-program',
      migrate,
    );
    const courseStop = script.indexOf(
      'systemctl stop urtoris-course-assistant',
      migrate,
    );
    const swap = script.indexOf('mv "$release_dir" "$app_dir"');
    const workerStart = script.indexOf(
      'systemctl start urtoris-workflow-program',
      swap,
    );
    const workerHealth = script.indexOf(
      'http://127.0.0.1:8030/health',
      workerStart,
    );
    const deployed = script.indexOf('echo "DEPLOYED=$deploy_sha"');
    assert.ok(
      preparation > 0 && preparation < importCheck && importCheck < migrate,
    );
    assert.ok(
      workerStop > migrate && workerStop < courseStop && courseStop < swap,
    );
    assert.ok(
      workerStart > swap &&
        workerHealth > workerStart &&
        workerHealth < deployed,
    );
    assert.match(script, /node_modules\/tsx\/package\.json/);
    assert.match(script, /tsconfig\.json/);
    assert.match(script, /lib\/workflow-program\/engine\.ts/);
    assert.match(script, /program_was_active=1/);
  });

  it('packages and imports the portable worker on the production Node 22 runtime', async () => {
    const workflow = await readFile(
      new URL('../.github/workflows/deploy-urtoris.yml', import.meta.url),
      'utf8',
    );
    const node22 = workflow.indexOf('node-version: 22.13.0');
    const importCheck = workflow.indexOf(
      'await import("./services/workflow-program/server.ts")',
      node22,
    );
    const archive = workflow.indexOf('git ls-files -z', importCheck);
    assert.ok(node22 > 0 && importCheck > node22 && archive > importCheck);
    assert.match(workflow, /node_modules\\0dist\\0URTORIS_RELEASE_SHA\\0/);
  });
});
