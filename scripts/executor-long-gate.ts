import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const baseUrl =
  process.env.PYTHON_EXECUTOR_URL?.trim() || 'http://127.0.0.1:3010';
const token = process.env.PYTHON_EXECUTOR_TOKEN?.trim() ?? '';
if (token.length < 32) {
  throw new Error('Set PYTHON_EXECUTOR_TOKEN before running the long gate.');
}

type RunResult = {
  run_id: string;
  status:
    | 'queued'
    | 'running'
    | 'succeeded'
    | 'failed'
    | 'timed_out'
    | 'killed';
  profile: 'short' | 'long';
  artifacts: Array<{
    artifact_id: string;
    name: string;
    mime_type: string;
    size_bytes: number;
  }>;
  error: { code: string; message: string } | null;
  metrics: {
    queued_ms: number | null;
    duration_ms: number | null;
    cpu_time_ms: number | null;
    peak_memory_bytes: number | null;
  };
  limits: { timeout_seconds: number; cpu_count: number; memory_bytes: number };
};

const authorization = { Authorization: `Bearer ${token}` };

async function jsonRequest<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(new URL(path, baseUrl), init);
  const payload = (await response.json()) as T & { error?: unknown };
  if (!response.ok) {
    throw new Error(
      `Executor request failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

async function waitForTerminal(taskId: string, initial: RunResult) {
  let current = initial;
  while (current.status === 'queued' || current.status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 500));
    current = await jsonRequest<RunResult>(
      `/v1/runs/${encodeURIComponent(current.run_id)}`,
      {
        method: 'GET',
        headers: { ...authorization, 'X-Urtoris-Task-Id': taskId },
      },
    );
  }
  return current;
}

async function generateCsv(path: string) {
  const stream = createWriteStream(path, { encoding: 'utf8', mode: 0o600 });
  stream.write('group,value\n');
  for (let index = 0; index < 1_000_000; index += 1) {
    if (
      !stream.write(
        `${String.fromCharCode(65 + (index % 20))},${index % 997}\n`,
      )
    ) {
      await once(stream, 'drain');
    }
  }
  stream.end();
  await once(stream, 'finish');
}

async function upload(taskId: string, path: string) {
  return jsonRequest<{ file: { file_id: string } }>('/v1/files', {
    method: 'POST',
    headers: {
      ...authorization,
      'Content-Type': 'application/octet-stream',
      'X-Urtoris-Task-Id': taskId,
      'X-Urtoris-File-Name': 'million.csv',
    },
    body: createReadStream(path) as unknown as BodyInit,
    // Node fetch 的 Readable body 需要 duplex，DOM 类型暂未包含该字段。
    duplex: 'half',
  } as RequestInit);
}

async function submit(
  taskId: string,
  attempt: number,
  code: string,
  inputFiles: Array<{ file_id: string; mount_name: string }>,
) {
  const startedAt = Date.now();
  const result = await jsonRequest<RunResult>('/v1/runs', {
    method: 'POST',
    headers: { ...authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocol: 'urtoris.python-executor.v1',
      task_id: taskId,
      idempotency_key: `${taskId}:attempt:${attempt}`,
      attempt,
      code,
      input_files: inputFiles,
      profile: 'long',
      timeout_seconds: 600,
    }),
  });
  return { result, submissionMs: Date.now() - startedAt };
}

const workDir = join(process.cwd(), 'work', 'long-gate');
await mkdir(workDir, { recursive: true });
const csvPath = join(workDir, 'million.csv');
await generateCsv(csvPath);
const csvBytes = (await stat(csvPath)).size;

const taskId = `task_${randomUUID().replaceAll('-', '')}`;
const uploaded = await upload(taskId, csvPath);
const longCode = [
  'import time',
  'import pandas as pd',
  'import matplotlib',
  'matplotlib.use("Agg")',
  'import matplotlib.pyplot as plt',
  'started = time.monotonic()',
  'frame = pd.read_csv("input/million.csv")',
  'summary = frame.groupby("group", as_index=False).agg(rows=("value", "size"), total=("value", "sum"), average=("value", "mean"))',
  'summary.to_csv("output/summary.csv", index=False)',
  'figure, axis = plt.subplots(figsize=(9, 4.5))',
  'axis.bar(summary["group"], summary["total"], color="#e96f35")',
  'axis.set_title("One million rows: total by group")',
  'axis.set_xlabel("Group")',
  'axis.set_ylabel("Total")',
  'figure.tight_layout()',
  'figure.savefig("output/chart.png", dpi=140)',
  'plt.close(figure)',
  'checksum = 0',
  'while time.monotonic() - started < 65:',
  '    for value in range(250000):',
  '        checksum = (checksum * 33 + value) % 1000000007',
  'print(f"rows={len(frame)} groups={len(summary)} checksum={checksum}")',
].join('\n');

const submitted = await submit(taskId, 1, longCode, [
  { file_id: uploaded.file.file_id, mount_name: 'million.csv' },
]);
if (submitted.result.status !== 'queued') {
  throw new Error(
    `Async submit must return queued, got ${submitted.result.status}.`,
  );
}
if (submitted.submissionMs >= 5_000) {
  throw new Error(
    `Submission took ${submitted.submissionMs}ms; expected <5000ms.`,
  );
}
const completed = await waitForTerminal(taskId, submitted.result);
if (completed.status !== 'succeeded') {
  throw new Error(
    `Long run failed: ${completed.status} ${JSON.stringify(completed.error)}`,
  );
}
if ((completed.metrics.duration_ms ?? 0) < 60_000) {
  throw new Error('Long run did not actually cross the one-minute gate.');
}
if ((completed.metrics.peak_memory_bytes ?? 0) <= 0) {
  throw new Error('Peak memory was not measured.');
}
for (const expected of ['summary.csv', 'chart.png']) {
  if (!completed.artifacts.some((artifact) => artifact.name === expected)) {
    throw new Error(`Missing artifact: ${expected}.`);
  }
}

const cancelTaskId = `task_${randomUUID().replaceAll('-', '')}`;
const cancelSubmission = await submit(
  cancelTaskId,
  1,
  'while True:\n    pass',
  [],
);
let cancellable = cancelSubmission.result;
while (cancellable.status === 'queued') {
  await new Promise((resolve) => setTimeout(resolve, 100));
  cancellable = await jsonRequest<RunResult>(
    `/v1/runs/${encodeURIComponent(cancellable.run_id)}`,
    {
      method: 'GET',
      headers: {
        ...authorization,
        'X-Urtoris-Task-Id': cancelTaskId,
      },
    },
  );
}
if (cancellable.status !== 'running') {
  throw new Error(
    `Cancellation gate never reached running: ${cancellable.status}.`,
  );
}
await jsonRequest<RunResult>(
  `/v1/runs/${encodeURIComponent(cancellable.run_id)}`,
  {
    method: 'DELETE',
    headers: {
      ...authorization,
      'X-Urtoris-Task-Id': cancelTaskId,
    },
  },
);
const cancelled = await waitForTerminal(cancelTaskId, cancellable);
if (cancelled.status !== 'killed' || cancelled.error?.code !== 'CANCELLED') {
  throw new Error(`Cancellation gate failed: ${JSON.stringify(cancelled)}`);
}

process.stdout.write(
  `${JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      executorUrl: baseUrl,
      csv: { rows: 1_000_000, bytes: csvBytes },
      asyncSubmission: {
        runId: completed.run_id,
        submissionMs: submitted.submissionMs,
        initialStatus: submitted.result.status,
      },
      longRun: {
        status: completed.status,
        profile: completed.profile,
        durationMs: completed.metrics.duration_ms,
        peakMemoryBytes: completed.metrics.peak_memory_bytes,
        cpuTimeMs: completed.metrics.cpu_time_ms,
        limits: completed.limits,
        artifacts: completed.artifacts.map(
          ({ name, mime_type, size_bytes }) => ({
            name,
            mimeType: mime_type,
            sizeBytes: size_bytes,
          }),
        ),
      },
      cancellationGate: {
        runId: cancelled.run_id,
        status: cancelled.status,
        errorCode: cancelled.error?.code,
        cleanupVerified: true,
      },
      lidBehavior: {
        exercised: false,
        reason: '不主动强制用户设备休眠',
        expected:
          '合盖/休眠会中断 Colima 内的运行；重启执行器后持久化的 queued/running 会定稿为 failed/WORKER_ERROR',
      },
    },
    null,
    2,
  )}\n`,
);
