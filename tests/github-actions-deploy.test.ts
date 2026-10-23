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
    assert.ok(stop > migration, 'D1 migration must finish before the current site is stopped');
    assert.match(script, /--persist-to \/var\/lib\/urtoris\/data/);
    assert.match(script, /\) < \/dev\/null/);
    assert.doesNotMatch(script, /^npm\s+.*\brun\s+build/m);
  });
});
