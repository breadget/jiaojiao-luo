import { randomBytes } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdir,
  readdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import {
  LOCAL_CONTROL_RUN_ID_PATTERN,
  readLocalControlRunObservation,
  type LocalControlRunObservation,
} from '../../lib/local-control-protocol';

export class LocalControlStorage {
  private readonly runsDirectory: string;
  private readonly auditPath: string;

  constructor(private readonly root: string) {
    this.runsDirectory = join(root, 'runs');
    this.auditPath = join(root, 'audit.jsonl');
  }

  async init(): Promise<void> {
    await mkdir(this.runsDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    await chmod(this.runsDirectory, 0o700);
    await appendFile(this.auditPath, '', { encoding: 'utf8', mode: 0o600 });
    await chmod(this.auditPath, 0o600);
  }

  async loadRuns(): Promise<LocalControlRunObservation[]> {
    const names = await readdir(this.runsDirectory);
    const runs = await Promise.all(
      names
        .filter((name) => /^shell_[a-f0-9]{32}\.json$/.test(name))
        .map(async (name) => {
          try {
            const raw = await readFile(join(this.runsDirectory, name), 'utf8');
            return readLocalControlRunObservation(JSON.parse(raw));
          } catch {
            return null;
          }
        }),
    );
    return runs.filter(
      (run): run is LocalControlRunObservation => run !== null,
    );
  }

  async saveRun(run: LocalControlRunObservation): Promise<void> {
    if (!LOCAL_CONTROL_RUN_ID_PATTERN.test(run.run_id)) {
      throw new Error('Refusing to persist an invalid local-control run id.');
    }
    const destination = join(this.runsDirectory, `${run.run_id}.json`);
    const temporary = `${destination}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(run, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    await rename(temporary, destination);
    await chmod(destination, 0o600);
  }

  async appendAudit(
    event: 'submitted' | 'started' | 'finished' | 'cancel-requested',
    run: LocalControlRunObservation,
  ): Promise<void> {
    const record = {
      at: new Date().toISOString(),
      event,
      protocol: run.protocol,
      task_id: run.task_id,
      run_id: run.run_id,
      idempotency_key: run.idempotency_key,
      status: run.status,
      command: run.command,
      cwd: run.cwd,
      shell: run.shell,
      timeout_seconds: run.timeout_seconds,
      reason: run.reason,
      pid: run.pid,
      exit_code: run.exit_code,
      signal: run.signal,
      stdout_bytes: Buffer.byteLength(run.stdout, 'utf8'),
      stderr_bytes: Buffer.byteLength(run.stderr, 'utf8'),
      stdout_truncated: run.stdout_truncated,
      stderr_truncated: run.stderr_truncated,
      cancellation_requested: run.cancellation_requested,
      created_at: run.created_at,
      started_at: run.started_at,
      finished_at: run.finished_at,
      error: run.error,
    };
    await appendFile(this.auditPath, `${JSON.stringify(record)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }
}
