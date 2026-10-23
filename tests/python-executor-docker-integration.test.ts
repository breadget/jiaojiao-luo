import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, it } from 'node:test';
import { DockerSandboxBackend } from '@/services/python-executor/docker-runner';
import { PythonExecutor } from '@/services/python-executor/executor';
import { ExecutorStorage } from '@/services/python-executor/storage';

const dockerIntegration =
  process.env.PYTHON_EXECUTOR_DOCKER_TEST === '1' ? describe : describe.skip;
const executeFile = promisify(execFile);

dockerIntegration('Python Executor real Docker gate', () => {
  const image =
    process.env.PYTHON_EXECUTOR_IMAGE || 'urtoris/python-executor:dev';
  let root = '';
  let hostMarker = '';
  let executor: PythonExecutor;

  before(async () => {
    // Colima 默认只向 VM 共享用户目录；macOS 的 /var/folders
    // 对 Docker daemon 不可见。本机真实门禁因此放在已共享且被 git
    // 忽略的 work/ 下，Linux 仍使用系统临时目录。
    const temporaryParent =
      process.platform === 'darwin' ? join(process.cwd(), 'work') : tmpdir();
    await mkdir(temporaryParent, { recursive: true });
    root = await mkdtemp(join(temporaryParent, 'urtoris-executor-docker-'));
    hostMarker = `${root}-host-marker`;
    await writeFile(hostMarker, 'must-not-be-visible');
    executor = new PythonExecutor({
      storage: new ExecutorStorage(root),
      sandbox: new DockerSandboxBackend({ image }),
      sandboxImage: image,
    });
    await executor.init();
  });

  after(async () => {
    await executor?.shutdown();
    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(hostMarker, { force: true }),
    ]);
  });

  async function submitAndWait(request: Record<string, unknown>) {
    const accepted = await executor.submit(request);
    const result = await executor.waitForRun(accepted.task_id, accepted.run_id);
    assert.ok(result);
    return result;
  }

  function run(
    taskId: string,
    code: string,
    timeoutSeconds = 30,
    profile: 'short' | 'long' = 'short',
  ) {
    return submitAndWait({
      protocol: 'urtoris.python-executor.v1',
      task_id: taskId,
      idempotency_key: `${taskId}:attempt:1`,
      attempt: 1,
      code,
      input_files: [],
      profile,
      timeout_seconds: timeoutSeconds,
    });
  }

  it('1. runs ordinary Python', async () => {
    const result = await run('task_gate_normal', 'print(sum(range(1, 101)))');
    const audit = await readFile(
      join(
        root,
        'tasks',
        'task_gate_normal',
        'runs',
        result.run_id,
        'metadata.json',
      ),
      'utf8',
    );
    assert.equal(result.status, 'succeeded', audit);
    assert.equal(result.exit_code, 0);
    assert.equal(result.stdout, '5050\n');
  });

  it('2. returns a real syntax error', async () => {
    const result = await run('task_gate_syntax', 'if True print("bad")');
    assert.equal(result.status, 'failed');
    assert.equal(result.error?.code, 'PROCESS_EXIT_NONZERO');
    assert.match(result.stderr ?? '', /SyntaxError/);
  });

  it('3. terminates a busy loop at the wall-clock limit', async () => {
    const result = await run('task_gate_timeout', 'while True:\n    pass', 1);
    assert.equal(result.status, 'timed_out');
    assert.equal(result.error?.code, 'TIMEOUT');
  });

  it('4. terminates memory exhaustion', async () => {
    const result = await run(
      'task_gate_memory',
      'chunks = []\nwhile True:\n    chunks.append(bytearray(64 * 1024 * 1024))',
    );
    assert.equal(result.status, 'killed');
    assert.equal(result.error?.code, 'MEMORY_LIMIT');
  });

  it('5. cannot open a network connection', async () => {
    const result = await run(
      'task_gate_network',
      [
        'import socket',
        'try:',
        '    socket.create_connection(("1.1.1.1", 53), timeout=1)',
        'except OSError:',
        '    print("network blocked")',
        'else:',
        '    raise SystemExit("network unexpectedly available")',
      ].join('\n'),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.stdout, 'network blocked\n');
  });

  it('6. cannot read a known host marker outside the run mounts', async () => {
    const result = await run(
      'task_gate_host_file',
      [
        `path = ${JSON.stringify(hostMarker)}`,
        'try:',
        '    open(path, encoding="utf-8").read()',
        'except (FileNotFoundError, PermissionError):',
        '    print("host blocked")',
        'else:',
        '    raise SystemExit("host file unexpectedly visible")',
      ].join('\n'),
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.stdout, 'host blocked\n');
  });

  it('7. truncates oversized output without deadlocking', async () => {
    const result = await run(
      'task_gate_output',
      'import sys\nsys.stdout.write("x" * (2 * 1024 * 1024))',
    );
    assert.equal(result.status, 'succeeded');
    assert.equal(result.stdout_truncated, true);
    assert.ok(Buffer.byteLength(result.stdout ?? '') <= 1024 * 1024);
  });

  it('8. returns validated data, image, PDF, Word, and PowerPoint artifacts', async () => {
    const result = await run(
      'task_gate_artifacts',
      [
        'import csv',
        'import matplotlib.pyplot as plt',
        'with open("output/result.csv", "w", newline="", encoding="utf-8") as target:',
        '    writer = csv.writer(target)',
        '    writer.writerow(["value"])',
        '    writer.writerow([6])',
        'plt.plot([1, 2, 3], [1, 4, 9])',
        'plt.savefig("output/result.png")',
        'from reportlab.pdfgen import canvas',
        'pdf = canvas.Canvas("output/hello.pdf")',
        'pdf.drawString(72, 720, "Hello World")',
        'pdf.save()',
        'from docx import Document',
        'document = Document()',
        'document.add_heading("Hello World", level=1)',
        'document.save("output/hello.docx")',
        'from pptx import Presentation',
        'presentation = Presentation()',
        'slide = presentation.slides.add_slide(presentation.slide_layouts[5])',
        'slide.shapes.title.text = "Hello World"',
        'presentation.save("output/hello.pptx")',
      ].join('\n'),
    );
    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.artifacts.map((artifact) => artifact.name).sort(), [
      'hello.docx',
      'hello.pdf',
      'hello.pptx',
      'result.csv',
      'result.png',
    ]);
  });

  it('9. reads a controlled input file through input/<mount_name>', async () => {
    const stored = await executor.storeInput({
      taskId: 'task_gate_input',
      name: 'data.csv',
      bytes: Buffer.from('amount\n100\n200\n', 'utf8'),
    });
    const result = await submitAndWait({
      protocol: 'urtoris.python-executor.v1',
      task_id: 'task_gate_input',
      idempotency_key: 'task_gate_input:attempt:1',
      attempt: 1,
      code: [
        'import csv, pathlib',
        'rows = list(csv.DictReader(pathlib.Path("input/data.csv").open(encoding="utf-8")))',
        'print("rows=", len(rows))',
        'print("total=", sum(int(row["amount"]) for row in rows))',
      ].join('\n'),
      input_files: [{ file_id: stored.file_id, mount_name: 'data.csv' }],
      profile: 'short',
      timeout_seconds: 30,
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.stdout, 'rows= 2\ntotal= 300\n');
  });

  it('10. writes an Excel workbook and can read it back as a controlled input', async () => {
    const written = await run(
      'task_gate_xlsx',
      [
        'import openpyxl',
        'book = openpyxl.Workbook()',
        'sheet = book.active',
        'sheet.append(["amount"])',
        'sheet.append([600])',
        'book.save("output/book.xlsx")',
        'print("saved")',
      ].join('\n'),
    );
    assert.equal(written.status, 'succeeded');
    assert.deepEqual(
      written.artifacts.map((artifact) => artifact.name),
      ['book.xlsx'],
    );

    // 用刚发布的产物字节当作下一次运行的受控输入：既验证 XLSX 产物，
    // 也验证 XLSX 输入真的能被沙箱里的 openpyxl 读出来。
    const artifact = written.artifacts[0];
    assert.ok(artifact);
    const published = await readFile(
      join(
        root,
        'tasks',
        'task_gate_xlsx',
        'runs',
        written.run_id,
        'artifacts',
        artifact.artifact_id,
        'book.xlsx',
      ),
    );
    const stored = await executor.storeInput({
      taskId: 'task_gate_xlsx_read',
      name: 'book.xlsx',
      bytes: published,
    });
    const read = await submitAndWait({
      protocol: 'urtoris.python-executor.v1',
      task_id: 'task_gate_xlsx_read',
      idempotency_key: 'task_gate_xlsx_read:attempt:1',
      attempt: 1,
      code: [
        'import openpyxl',
        'book = openpyxl.load_workbook("input/book.xlsx")',
        'sheet = book.active',
        'print("cell=", sheet["A2"].value)',
      ].join('\n'),
      input_files: [{ file_id: stored.file_id, mount_name: 'book.xlsx' }],
      profile: 'short',
      timeout_seconds: 30,
    });
    assert.equal(read.status, 'succeeded');
    assert.equal(read.stdout, 'cell= 600\n');
  });

  it('11. leaves no labeled executor containers after terminal state', async () => {
    const { stdout } = await executeFile('docker', [
      'ps',
      '--all',
      '--quiet',
      '--filter',
      'label=com.urtoris.python-executor=1',
    ]);
    assert.equal(stdout.trim(), '');
  });
});
