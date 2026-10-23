import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';

const deploymentSource = readFileSync(
  new URL('../deploy/github-actions/urtoris-runtime-deploy', import.meta.url),
  'utf8',
);
const restoreStart = deploymentSource.indexOf('restore_after_failure() {');
const restoreEnd = deploymentSource.indexOf('\ncleanup() {', restoreStart);
assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, 'deployment rollback function is present');
const restoreFunction = deploymentSource.slice(restoreStart, restoreEnd);

const stateItems = ['index', 'db.sqlite3', 'db.sqlite3-journal', 'db.sqlite3-wal', 'db.sqlite3-shm'];

function put(directory: string, name: string, content: string | Buffer) {
  const path = join(directory, name);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
}

function tree(directory: string): Record<string, { content: string; mode: number }> {
  const result: Record<string, { content: string; mode: number }> = {};
  function visit(path: string) {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const metadata = statSync(child);
      if (metadata.isDirectory()) visit(child);
      else result[relative(directory, child)] = {
        content: readFileSync(child).toString('base64'),
        mode: metadata.mode & 0o777,
      };
    }
  }
  visit(directory);
  return result;
}

function fixture(includeJournal = true) {
  const root = mkdtempSync(join(tmpdir(), 'urtoris-course-rollback-'));
  const state = join(root, 'course-state');
  const staging = join(root, 'staging');
  const backup = join(staging, 'course-state-before');
  const app = join(root, 'app');
  const previousApp = join(root, 'previous-app');
  const calls = join(root, 'systemctl-calls');
  mkdirSync(backup, { recursive: true });
  put(app, 'revision', 'old-runtime');
  put(state, 'index/CURRENT', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  put(state, 'index/generations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/manifest.json',
    JSON.stringify({ documents: [{ name: 'course.pdf', mtime_ns: 'original-pdf-timestamp' }] }));
  put(state, 'index/generations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/index.faiss', Buffer.from([0, 255, 7, 9]));
  put(state, 'index/generations/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/chunks.json', '[{"text":"old source"}]');
  put(state, 'db.sqlite3', Buffer.from([83, 81, 76, 105, 116, 101, 0, 1, 2]));
  put(state, 'db.sqlite3-wal', Buffer.from([0, 1, 254, 255]));
  put(state, 'db.sqlite3-shm', Buffer.from([8, 6, 4, 2]));
  if (includeJournal) put(state, 'db.sqlite3-journal', Buffer.from([9, 8, 7, 6]));
  put(state, 'models/cached-model', 'unchanged-offline-model');
  const oldState = tree(state);
  const oldApp = tree(app);
  for (const item of stateItems) {
    if (existsSync(join(state, item))) cpSync(join(state, item), join(backup, item), { recursive: true });
  }
  return { root, state, staging, backup, app, previousApp, calls, oldState, oldApp };
}

function mutateState(state: string) {
  rmSync(join(state, 'index'), { recursive: true });
  put(state, 'index/CURRENT', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  put(state, 'index/generations/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/manifest.json',
    '{"documents":[{"mtime_ns":"new-release-timestamp"}]}');
  put(state, 'db.sqlite3', 'new schema and query records');
  put(state, 'db.sqlite3-wal', 'new WAL');
  put(state, 'db.sqlite3-shm', 'new SHM');
  put(state, 'db.sqlite3-journal', 'new journal');
}

function runRestore(
  data: ReturnType<typeof fixture>,
  options: { result: number; appMoved?: boolean; releaseActive?: boolean; courseActive?: boolean; n8nActive?: boolean; failCopy?: boolean },
) {
  const shell = `set -Eeuo pipefail
staging_dir=$ROLLBACK_TEST_STAGING
app_dir=$ROLLBACK_TEST_APP
previous_app=$ROLLBACK_TEST_PREVIOUS_APP
course_state_dir=$ROLLBACK_TEST_STATE
course_backup_dir=$ROLLBACK_TEST_BACKUP
app_moved=$ROLLBACK_TEST_APP_MOVED
release_active=$ROLLBACK_TEST_RELEASE_ACTIVE
course_state_saved=1
course_was_active=$ROLLBACK_TEST_COURSE_ACTIVE
n8n_was_active=$ROLLBACK_TEST_N8N_ACTIVE
course_state_items=(index db.sqlite3 db.sqlite3-journal db.sqlite3-wal db.sqlite3-shm)
systemctl() { printf '%s\\n' "$*" >> "$ROLLBACK_TEST_CALLS"; }
chown() { return 0; }
cp() {
  if [[ "$ROLLBACK_TEST_FAIL_COPY" == 1 && "$3" == "$course_state_dir/db.sqlite3" ]]; then
    return 74
  fi
  command cp "$@"
}
${restoreFunction}
restore_after_failure "$ROLLBACK_TEST_RESULT"
`;
  const result = spawnSync('bash', ['-c', shell], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ROLLBACK_TEST_STAGING: data.staging,
      ROLLBACK_TEST_APP: data.app,
      ROLLBACK_TEST_PREVIOUS_APP: data.previousApp,
      ROLLBACK_TEST_STATE: data.state,
      ROLLBACK_TEST_BACKUP: data.backup,
      ROLLBACK_TEST_CALLS: data.calls,
      ROLLBACK_TEST_APP_MOVED: options.appMoved ? '1' : '0',
      ROLLBACK_TEST_RELEASE_ACTIVE: options.releaseActive ? '1' : '0',
      ROLLBACK_TEST_COURSE_ACTIVE: options.courseActive === false ? '0' : '1',
      ROLLBACK_TEST_N8N_ACTIVE: options.n8nActive ? '1' : '0',
      ROLLBACK_TEST_RESULT: String(options.result),
      ROLLBACK_TEST_FAIL_COPY: options.failCopy ? '1' : '0',
    },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, options.result, result.stderr);
  assert.equal(existsSync(data.staging), Boolean(options.failCopy),
    'recovery failures retain the backup; completed recovery removes temporary release artifacts');
  if (options.failCopy) {
    assert.ok(result.stderr.includes(`Recovery backup retained at ${data.backup}`),
      'failed recovery identifies the retained backup path');
  }
  return existsSync(data.calls) ? readFileSync(data.calls, 'utf8').trim().split('\n') : [];
}

test('course preparation failure before website swap restores SQLite sidecars and exact previous index', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  mutateState(data.state);
  const calls = runRestore(data, { result: 17, n8nActive: true });
  assert.deepEqual(tree(data.state), data.oldState);
  assert.deepEqual(tree(data.app), data.oldApp);
  assert.deepEqual(calls, [
    'stop urtoris-course-assistant', 'start urtoris-course-assistant', 'start n8n',
  ]);
});

test('post-swap health failure restores the old website and course state, removing newly created sidecars', (t) => {
  const data = fixture(false);
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  cpSync(data.app, data.previousApp, { recursive: true });
  put(data.app, 'revision', 'new-runtime');
  put(data.app, 'new-release-only', 'must not survive rollback');
  mutateState(data.state);
  const calls = runRestore(data, { result: 23, appMoved: true, releaseActive: true });
  assert.deepEqual(tree(data.app), data.oldApp);
  assert.deepEqual(tree(data.state), data.oldState);
  assert.equal(existsSync(data.previousApp), false);
  assert.deepEqual(calls, [
    'stop urtoris', 'start urtoris',
    'stop urtoris-course-assistant', 'start urtoris-course-assistant',
  ]);
});

test('failure between the two website moves recovers the missing application directory', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  cpSync(data.app, data.previousApp, { recursive: true });
  rmSync(data.app, { recursive: true });
  mutateState(data.state);
  runRestore(data, { result: 29, appMoved: true, releaseActive: false });
  assert.deepEqual(tree(data.app), data.oldApp);
  assert.deepEqual(tree(data.state), data.oldState);
});

test('rollback stops a newly started course service but does not start an originally inactive service', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  mutateState(data.state);
  const calls = runRestore(data, { result: 31, courseActive: false });
  assert.deepEqual(tree(data.state), data.oldState);
  assert.deepEqual(calls, ['stop urtoris-course-assistant']);
});

test('successful deployment retains its new website, migrated database and index', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  cpSync(data.app, data.previousApp, { recursive: true });
  put(data.app, 'revision', 'new-runtime');
  mutateState(data.state);
  const newState = tree(data.state);
  const newApp = tree(data.app);
  const calls = runRestore(data, { result: 0, appMoved: true, releaseActive: true });
  assert.deepEqual(tree(data.state), newState);
  assert.deepEqual(tree(data.app), newApp);
  assert.equal(existsSync(data.previousApp), true, 'successful deployment keeps its previous release archive');
  assert.deepEqual(calls, []);
});

test('failed database restoration retains the exact recovery backup and leaves the course service stopped', (t) => {
  const data = fixture();
  t.after(() => rmSync(data.root, { recursive: true, force: true }));
  const savedBackup = tree(data.backup);
  mutateState(data.state);
  const calls = runRestore(data, { result: 37, failCopy: true, n8nActive: true });
  assert.deepEqual(tree(data.backup), savedBackup, 'all original SQLite and index files remain recoverable');
  assert.equal(existsSync(join(data.state, 'db.sqlite3')), false, 'the simulated database copy actually failed');
  assert.deepEqual(tree(join(data.state, 'index')), tree(join(data.backup, 'index')),
    'other restore items continue even after one copy fails');
  assert.deepEqual(calls, ['stop urtoris-course-assistant', 'start n8n']);
});
