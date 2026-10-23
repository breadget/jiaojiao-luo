import { randomUUID } from 'node:crypto';

const baseUrl =
  process.env.PYTHON_EXECUTOR_URL?.trim() || 'http://127.0.0.1:3010';
const token = process.env.PYTHON_EXECUTOR_TOKEN?.trim() ?? '';
if (token.length < 32) {
  throw new Error('Set PYTHON_EXECUTOR_TOKEN to the executor service token.');
}

const taskId = `task_canary_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
const authorization = { Authorization: `Bearer ${token}` };

async function request(path: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(new URL(path, baseUrl), init);
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(
      `Canary request failed (${response.status}): ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

const uploaded = (await request('/v1/files', {
  method: 'POST',
  headers: {
    ...authorization,
    'Content-Type': 'application/octet-stream',
    'X-Urtoris-Task-Id': taskId,
    'X-Urtoris-File-Name': 'numbers.csv',
  },
  body: 'value\n1\n2\n3\n',
})) as { file: { file_id: string } };

const submittedAt = Date.now();
const submitted = (await request('/v1/runs', {
  method: 'POST',
  headers: { ...authorization, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    protocol: 'urtoris.python-executor.v1',
    task_id: taskId,
    idempotency_key: `${taskId}:attempt:1`,
    attempt: 1,
    code: [
      'import csv',
      'with open("input/numbers.csv", newline="", encoding="utf-8") as source:',
      '    values = [int(row["value"]) for row in csv.DictReader(source)]',
      'with open("output/summary.csv", "w", newline="", encoding="utf-8") as target:',
      '    writer = csv.writer(target)',
      '    writer.writerow(["sum"])',
      '    writer.writerow([sum(values)])',
      'print(sum(values))',
    ].join('\n'),
    input_files: [
      {
        file_id: uploaded.file.file_id,
        mount_name: 'numbers.csv',
      },
    ],
    profile: 'short',
    timeout_seconds: 30,
  }),
})) as { run_id: string; status: string };

const submissionMs = Date.now() - submittedAt;
let result = submitted;
while (result.status === 'queued' || result.status === 'running') {
  await new Promise((resolve) => setTimeout(resolve, 200));
  result = (await request(`/v1/runs/${encodeURIComponent(result.run_id)}`, {
    method: 'GET',
    headers: {
      ...authorization,
      'X-Urtoris-Task-Id': taskId,
    },
  })) as typeof result;
}

if (result.status !== 'succeeded') {
  throw new Error(`Canary run ended as ${result.status}.`);
}

process.stdout.write(
  `${JSON.stringify({ task_id: taskId, submission_ms: submissionMs, result }, null, 2)}\n`,
);
