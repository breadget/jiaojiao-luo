import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const setupPath = fileURLToPath(
  new URL('../deploy/setup-workflow-program.py', import.meta.url),
);

function setupFixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), 'workflow-program-setup-'),
  );
  for (const path of ['app', 'etc', 'systemd', 'state'])
    mkdirSync(join(root, path));
  writeFileSync(
    join(root, 'app', '.dev.vars'),
    'EXISTING_SITE_SETTING=preserve-me\n',
    { mode: 0o600 },
  );
  writeFileSync(
    join(root, 'state', 'completed-job.json'),
    '{"status":"completed"}',
  );
  return root;
}

function runSetup(root: string, operation: string) {
  const script = `import importlib.util, os, pathlib, types, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('program_setup', sys.argv[1])
setup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(setup)
root = pathlib.Path(sys.argv[2])
setup.APP_DIR = root / 'app'
setup.STATE_DIR = root / 'state'
setup.ENV_FILE = root / 'etc' / 'workflow-program.env'
setup.UNIT_FILE = root / 'systemd' / 'urtoris-workflow-program.service'
setup.pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
setup.grp.getgrnam = lambda name: types.SimpleNamespace(gr_gid=os.getgid())
# Ownership changes need root in production; fixture permissions and writes remain real.
setup.os.chown = lambda *args: None
setup.os.fchown = lambda *args: None
calls = []
setup.subprocess.run = lambda args, **kwargs: calls.append(args)
${operation}
assert all('start' not in call and 'restart' not in call for call in calls)
assert all('token' not in str(call).lower() for call in calls)
`;
  return spawnSync('python3', ['-c', script, setupPath, root], {
    encoding: 'utf8',
  });
}

test('root preparation works before worker source exists, preserves job state, and is idempotent without printing keys', (t) => {
  const root = setupFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = runSetup(
    root,
    `setup.prepare()
first = setup.ENV_FILE.read_text()
setup.prepare()
assert setup.ENV_FILE.read_text() == first
assert ['systemctl', 'enable', 'urtoris-workflow-program.service'] in calls
`,
  );
  assert.equal(result.status, 0, result.stderr);
  const workerEnvironment = readFileSync(
    join(root, 'etc', 'workflow-program.env'),
    'utf8',
  );
  const siteEnvironment = readFileSync(join(root, 'app', '.dev.vars'), 'utf8');
  const token = /^WORKFLOW_PROGRAM_TOKEN=(.+)$/m.exec(workerEnvironment)![1];
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(siteEnvironment.includes(`WORKFLOW_PROGRAM_TOKEN=${token}`));
  assert.ok(siteEnvironment.includes('EXISTING_SITE_SETTING=preserve-me'));
  assert.ok(!result.stdout.includes(token) && !result.stderr.includes(token));
  assert.equal(
    readFileSync(join(root, 'state', 'completed-job.json'), 'utf8'),
    '{"status":"completed"}',
  );
  assert.equal(statSync(join(root, 'state')).mode & 0o777, 0o700);
  assert.equal(
    statSync(join(root, 'etc', 'workflow-program.env')).mode & 0o777,
    0o640,
  );
  assert.equal(statSync(join(root, 'app', '.dev.vars')).mode & 0o777, 0o600);
  assert.match(
    readFileSync(
      join(root, 'systemd', 'urtoris-workflow-program.service'),
      'utf8',
    ),
    /ConditionPathExists=.*services\/workflow-program\/server\.ts/,
  );
});

test('preparation refuses mismatched existing credentials without rotating or exposing either value', (t) => {
  const root = setupFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const siteToken = 'a'.repeat(64);
  const workerToken = 'b'.repeat(64);
  const sitePath = join(root, 'app', '.dev.vars');
  const workerPath = join(root, 'etc', 'workflow-program.env');
  writeFileSync(sitePath, `WORKFLOW_PROGRAM_TOKEN=${siteToken}\n`);
  writeFileSync(workerPath, `WORKFLOW_PROGRAM_TOKEN=${workerToken}\n`);
  const previousSite = readFileSync(sitePath, 'utf8');
  const previousWorker = readFileSync(workerPath, 'utf8');
  const result = runSetup(
    root,
    `try:
    setup.prepare()
except ValueError:
    print('configuration mismatch rejected')
else:
    raise AssertionError('mismatched tokens must be rejected')
assert calls == []
`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(sitePath, 'utf8'), previousSite);
  assert.equal(readFileSync(workerPath, 'utf8'), previousWorker);
  assert.ok(
    !result.stdout.includes(siteToken) && !result.stdout.includes(workerToken),
  );
});
