import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout } from 'node:timers/promises';
const root = process.argv[2];
if (process.env.URTORIS_CLONE_CANARY !== '1' || !root || !isAbsolute(root))
  throw new Error('CLONE_MARKER_REQUIRED');
const cloneRoot = realpathSync(root);
const marker = JSON.parse(
  readFileSync(join(cloneRoot, 'graph-runtime-clone.json'), 'utf8'),
);
if (marker.marker !== 'isolated-urtoris-graph-canary')
  throw new Error('INVALID_CLONE_MARKER');
const path = realpathSync(join(cloneRoot, marker.database));
if (relative(cloneRoot, path).startsWith('..'))
  throw new Error('DATABASE_OUTSIDE_CLONE');
const db = new DatabaseSync(path, { readOnly: true });
const startedAt = Date.now();
const samples: Array<{ at: number; staleRunning: number; running: number }> =
  [];
try {
  do {
    const counts = db
      .prepare(`SELECT
      SUM(CASE WHEN status='running' AND stoppedAt IS NULL THEN 1 ELSE 0 END) running,
      SUM(CASE WHEN status='running' AND stoppedAt IS NULL AND julianday(startedAt) < julianday('now','-2 minutes') THEN 1 ELSE 0 END) stale
      FROM execution_entity`)
      .get()!;
    const sample = {
      at: Date.now(),
      running: Number(counts.running ?? 0),
      staleRunning: Number(counts.stale ?? 0),
    };
    samples.push(sample);
    const elapsedMs = sample.at - startedAt;
    const complete = elapsedMs >= 30 * 60 * 1000;
    writeFileSync(
      join(cloneRoot, 'observation.json'),
      JSON.stringify(
        {
          startedAt,
          elapsedMs,
          complete,
          pass:
            complete &&
            samples.every((item) => item.staleRunning === 0) &&
            sample.running === 0,
          samples,
        },
        null,
        2,
      ),
    );
    if (sample.staleRunning > 0) throw new Error('STALE_RUNNING_EXECUTIONS');
    if (complete) {
      console.log(
        JSON.stringify({
          complete: true,
          elapsedMs,
          samples: samples.length,
          running: sample.running,
        }),
      );
      break;
    }
    await setTimeout(15000);
  } while (Date.now() - startedAt < 31 * 60 * 1000);
} finally {
  db.close();
}
