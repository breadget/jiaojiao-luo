import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { ArtifactRejectedError } from './artifacts';
import { EXECUTOR_LIMITS } from './protocol';

export type CapturedOutput = {
  text: string;
  truncated: boolean;
  seenBytes: number;
};

export type SandboxRunRequest = {
  runId: string;
  sourcePath: string;
  inputDir: string;
  outputDir: string;
  timeoutSeconds: number;
  memoryBytes: number;
  cpuCount: number;
  processes: number;
  signal?: AbortSignal;
};

export type SandboxRunOutcome = {
  kind:
    | 'exited'
    | 'timed_out'
    | 'cancelled'
    | 'memory_limit'
    | 'output_limit'
    | 'worker_error';
  exitCode: number | null;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
  durationMs: number;
  cpuTimeMs: number | null;
  peakMemoryBytes: number | null;
  cleanupConfirmed: boolean;
  errorMessage: string | null;
};

export interface SandboxBackend {
  preflight(): Promise<void>;
  run(request: SandboxRunRequest): Promise<SandboxRunOutcome>;
  validatePng(path: string, maximumPixels: number): Promise<void>;
  validateXlsx(path: string): Promise<void>;
  validatePdf(path: string): Promise<void>;
  validateDocx(path: string): Promise<void>;
  validatePptx(path: string): Promise<void>;
}

export class SandboxInfrastructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxInfrastructureError';
  }
}

class DockerCommandError extends Error {
  readonly stderr: string;

  constructor(command: string[], stderr: string) {
    const detail = sanitizeLog(stderr).trim().slice(0, 1_000);
    super(
      `Docker command failed: docker ${command.join(' ')}${detail ? `: ${detail}` : ''}`,
    );
    this.name = 'DockerCommandError';
    this.stderr = stderr;
  }
}

type DockerInspect = {
  Id: string;
  AppArmorProfile?: string;
  ProcessLabel?: string;
  Config: {
    User: string;
  };
  HostConfig: {
    Privileged: boolean;
    ReadonlyRootfs: boolean;
    NetworkMode: string;
    IpcMode: string;
    Memory: number;
    MemorySwap: number;
    NanoCpus: number;
    PidsLimit: number | null;
    CapDrop: string[] | null;
    SecurityOpt: string[] | null;
    Tmpfs: Record<string, string> | null;
  };
  Mounts: Array<{
    Type: string;
    Source: string;
    Destination: string;
    RW: boolean;
  }>;
  State: {
    Pid: number;
    Status: string;
    Running: boolean;
    ExitCode: number;
    OOMKilled: boolean;
    Error: string;
  };
};

export type DockerRunnerConfig = {
  image: string;
  dockerBinary?: string;
  production?: boolean;
  requireLsm?: boolean;
};

class ByteCollector {
  private readonly chunks: Buffer[] = [];
  private retainedBytes = 0;
  private totalBytes = 0;

  constructor(private readonly maximumBytes: number) {}

  add(chunk: Uint8Array) {
    const buffer = Buffer.from(chunk);
    this.totalBytes += buffer.byteLength;
    const remaining = this.maximumBytes - this.retainedBytes;
    if (remaining <= 0) return;
    const retained = buffer.subarray(0, remaining);
    this.chunks.push(retained);
    this.retainedBytes += retained.byteLength;
  }

  result(): CapturedOutput {
    return {
      text: sanitizeLog(Buffer.concat(this.chunks).toString('utf8')),
      truncated: this.totalBytes > this.maximumBytes,
      seenBytes: this.totalBytes,
    };
  }
}

function sanitizeLog(value: string): string {
  let sanitized = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      const kind = value.charCodeAt(index + 1);
      if (kind === 91) {
        index += 2;
        while (index < value.length) {
          const finalByte = value.charCodeAt(index);
          if (finalByte >= 64 && finalByte <= 126) break;
          index += 1;
        }
      } else if (kind === 93) {
        index += 2;
        while (index < value.length) {
          const current = value.charCodeAt(index);
          if (current === 7) break;
          if (current === 27 && value.charCodeAt(index + 1) === 92) {
            index += 1;
            break;
          }
          index += 1;
        }
      }
      continue;
    }
    sanitized +=
      code === 9 || code === 10 || code === 13 || code >= 32
        ? value[index]
        : '\uFFFD';
  }
  return sanitized;
}

function safeMountSource(source: string): string {
  const normalized = resolve(source);
  if (
    normalized.includes(',') ||
    normalized.includes('\r') ||
    normalized.includes('\n') ||
    normalized.includes('\0')
  ) {
    throw new SandboxInfrastructureError('A bind mount path is unsafe.');
  }
  return normalized;
}

function bindMount(source: string, destination: string): string {
  return `type=bind,src=${safeMountSource(source)},dst=${destination},readonly,bind-propagation=rprivate`;
}

/**
 * 结果目录必须是可写挂载，不能是容器内的 tmpfs：tmpfs 随容器停止一起消失，
 * 停机后再 `docker cp` 只能拿到空目录（真实门禁就是在这里失败过一次）。
 * 输出体积上限改由 Worker 在执行期间监视并终止。
 */
function writableBindMount(source: string, destination: string): string {
  return `type=bind,src=${safeMountSource(source)},dst=${destination},bind-propagation=rprivate`;
}

async function directorySize(
  root: string,
  maximumBytes: number,
): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0 && total <= maximumBytes) {
    const current = pending.pop();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        pending.push(join(current, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        total += (await stat(join(current, entry.name))).size;
      } catch {
        // 文件在统计过程中被删除，忽略这一项即可。
      }
      if (total > maximumBytes) return total;
    }
  }
  return total;
}

/** 执行期间监视结果目录体积；超限时回调一次。返回停止函数。 */
function watchDirectorySize(
  root: string,
  maximumBytes: number,
  onExceeded: () => void,
): () => void {
  let stopped = false;
  const interval = setInterval(() => {
    if (stopped) return;
    void directorySize(root, maximumBytes)
      .then((size) => {
        if (!stopped && size > maximumBytes) {
          stopped = true;
          onExceeded();
        }
      })
      .catch(() => undefined);
  }, 500);
  return () => {
    stopped = true;
    clearInterval(interval);
  };
}

function commonSecurityArgs(options: {
  name: string;
  memoryBytes: number;
  cpuCount: number;
  processes: number;
}): string[] {
  return [
    '--name',
    options.name,
    '--label',
    'com.urtoris.python-executor=1',
    '--read-only',
    '--network',
    'none',
    '--ipc',
    'private',
    '--user',
    '65532:65532',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--pids-limit',
    String(options.processes),
    '--memory',
    String(options.memoryBytes),
    '--memory-swap',
    String(options.memoryBytes),
    '--cpus',
    String(options.cpuCount),
    '--ulimit',
    `nofile=${EXECUTOR_LIMITS.openFiles}:${EXECUTOR_LIMITS.openFiles}`,
    '--stop-timeout',
    '1',
    '--init',
    '--hostname',
    'sandbox',
    '--log-driver',
    'local',
    '--log-opt',
    'max-size=3m',
    '--log-opt',
    'max-file=1',
    // `local` 驱动默认压缩轮转文件；max-file=1 时没有可轮转的文件，
    // Docker 29 会直接拒绝创建容器（"compression cannot be enabled when
    // max file count is 1"）。关掉压缩后单文件上限仍然成立。
    '--log-opt',
    'compress=false',
    '--env',
    'HOME=/tmp',
    '--env',
    'MPLCONFIGDIR=/tmp/matplotlib',
    '--env',
    'TZ=UTC',
    '--env',
    'LANG=C.UTF-8',
  ];
}

export function buildDockerCreateArgs(options: {
  image: string;
  containerName: string;
  sourcePath: string;
  inputDir: string;
  outputDir: string;
  memoryBytes: number;
  cpuCount: number;
  processes: number;
}): string[] {
  return [
    'create',
    ...commonSecurityArgs({
      name: options.containerName,
      memoryBytes: options.memoryBytes,
      cpuCount: options.cpuCount,
      processes: options.processes,
    }),
    '--mount',
    bindMount(options.sourcePath, '/workspace/main.py'),
    '--mount',
    bindMount(options.inputDir, '/workspace/input'),
    '--mount',
    writableBindMount(options.outputDir, '/workspace/output'),
    '--tmpfs',
    `/tmp:rw,noexec,nosuid,nodev,size=${64 * 1024 * 1024},mode=1777`,
    options.image,
  ];
}

function verifyCreatedContainer(
  inspect: DockerInspect,
  request: SandboxRunRequest,
  requireLsm: boolean,
  daemonLsmVerified: boolean,
) {
  const host = inspect.HostConfig;
  const securityOptions = host.SecurityOpt ?? [];
  const capabilities = (host.CapDrop ?? []).map((value) => value.toUpperCase());
  const mounts = new Map(
    inspect.Mounts.map((mount) => [mount.Destination, mount]),
  );
  const sourceMount = mounts.get('/workspace/main.py');
  const inputMount = mounts.get('/workspace/input');
  const outputMount = mounts.get('/workspace/output');
  const hasForbiddenMount = inspect.Mounts.some((mount) =>
    ['/var/run/docker.sock', '/run/docker.sock', '/'].includes(
      mount.Destination,
    ),
  );
  const hasUnexpectedMount = inspect.Mounts.some(
    (mount) =>
      mount.Destination !== '/workspace/main.py' &&
      mount.Destination !== '/workspace/input' &&
      mount.Destination !== '/workspace/output',
  );
  const tmpfs = host.Tmpfs ?? {};
  const lsmApplied =
    (Boolean(inspect.AppArmorProfile) &&
      inspect.AppArmorProfile !== 'unconfined') ||
    Boolean(inspect.ProcessLabel) ||
    // Docker 29 起不再把 AppArmor profile 写进 inspect，但启动探针已经确认过
    // 容器进程真的被 LSM 限制住了（见 verifyHostLsm）。
    daemonLsmVerified;

  const valid =
    inspect.Config.User === '65532:65532' &&
    host.Privileged === false &&
    host.ReadonlyRootfs === true &&
    host.NetworkMode === 'none' &&
    host.IpcMode === 'private' &&
    host.Memory === request.memoryBytes &&
    host.MemorySwap === request.memoryBytes &&
    host.NanoCpus === request.cpuCount * 1_000_000_000 &&
    host.PidsLimit === request.processes &&
    capabilities.includes('ALL') &&
    securityOptions.some((value) => value.includes('no-new-privileges')) &&
    Boolean(sourceMount) &&
    sourceMount?.RW === false &&
    sourceMount?.Source === resolve(request.sourcePath) &&
    Boolean(inputMount) &&
    inputMount?.RW === false &&
    inputMount?.Source === resolve(request.inputDir) &&
    Boolean(outputMount) &&
    outputMount?.RW === true &&
    outputMount?.Source === resolve(request.outputDir) &&
    Boolean(tmpfs['/tmp']) &&
    !tmpfs['/workspace/output'] &&
    !hasForbiddenMount &&
    !hasUnexpectedMount &&
    (!requireLsm || lsmApplied);

  if (!valid) {
    throw new SandboxInfrastructureError(
      'Docker did not apply the required sandbox policy.',
    );
  }
}

export class DockerSandboxBackend implements SandboxBackend {
  private readonly image: string;
  private readonly dockerBinary: string;
  private readonly production: boolean;
  private readonly requireLsm: boolean;
  /** 启动探针确认过宿主机真的会给容器套上 LSM 之后才为 true。 */
  private daemonLsmVerified = false;

  constructor(config: DockerRunnerConfig) {
    this.image = config.image;
    this.dockerBinary = config.dockerBinary ?? 'docker';
    this.production = config.production ?? false;
    this.requireLsm = config.requireLsm ?? this.production;
    // 生产必须按内容摘要固定镜像：`name@sha256:...`（registry 拉取）或本机构建
    // 出来的镜像 ID（`sha256:...`）都算固定，普通 tag 一律拒绝。
    if (this.production && !/(?:@)?sha256:[a-f0-9]{64}$/.test(this.image)) {
      throw new SandboxInfrastructureError(
        'Production executor images must be pinned by sha256 digest.',
      );
    }
  }

  private async docker(
    arguments_: string[],
    maximumBytes = 1024 * 1024,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(this.dockerBinary, arguments_, {
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = new ByteCollector(maximumBytes);
      const stderr = new ByteCollector(maximumBytes);
      child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
      child.once('error', (cause) => reject(cause));
      child.once('close', (code) => {
        const output = {
          stdout: stdout.result().text,
          stderr: stderr.result().text,
        };
        if (code === 0) resolvePromise(output);
        else reject(new DockerCommandError(arguments_, output.stderr));
      });
    });
  }

  /**
   * 启动时用一次性探针确认宿主机真的会把容器套进 LSM。
   *
   * Docker 29 起 `docker inspect` 的 `AppArmorProfile` / `ProcessLabel` 不再反映
   * 真实生效的 profile，所以这里直接读容器进程的 `/proc/<pid>/attr/current` 与
   * Seccomp 状态；核验不过就拒绝启动，绝不带着 unconfined 的容器继续跑。
   */
  private async verifyHostLsm(): Promise<void> {
    const name = `urtoris-lsm-probe-${Date.now()}`;
    let containerId: string | null = null;
    let failure: unknown = null;
    try {
      const created = await this.docker(
        [
          'create',
          ...commonSecurityArgs({
            name,
            memoryBytes: 64 * 1024 * 1024,
            cpuCount: 1,
            processes: 16,
          }),
          '--tmpfs',
          `/tmp:rw,noexec,nosuid,nodev,size=${8 * 1024 * 1024},mode=1777`,
          this.image,
          '-c',
          'import time; time.sleep(5)',
        ],
        64 * 1024,
      );
      containerId = created.stdout.trim();
      if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
        throw new SandboxInfrastructureError(
          'Docker returned an invalid LSM probe container ID.',
        );
      }
      await this.docker(['start', containerId], 64 * 1024);
      const inspect = await this.inspect(containerId);
      const pid = inspect.State.Pid;
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new SandboxInfrastructureError(
          'The LSM probe container did not produce a running process.',
        );
      }
      const label = (
        await readFile(`/proc/${pid}/attr/current`, 'utf8')
      ).trim();
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const confined =
        Boolean(label) &&
        !label.startsWith('unconfined') &&
        !label.includes('(complain)');
      const seccompFiltered = /^Seccomp:\s*2$/m.test(status);
      if (!confined || !seccompFiltered) {
        throw new SandboxInfrastructureError(
          'The sandbox process is not confined by an LSM and a seccomp filter.',
        );
      }
      this.daemonLsmVerified = true;
    } catch (cause) {
      failure = cause;
    }

    const cleanedUp = containerId
      ? await this.removeAndVerify(containerId)
      : true;
    if (failure) throw failure;
    if (!cleanedUp) {
      throw new SandboxInfrastructureError(
        'The LSM probe container could not be removed.',
      );
    }
  }

  async preflight(): Promise<void> {
    try {
      await this.docker(
        ['version', '--format', '{{.Server.Version}}'],
        16 * 1024,
      );
      const { stdout } = await this.docker(
        ['info', '--format', '{{json .SecurityOptions}}'],
        64 * 1024,
      );
      const options = JSON.parse(stdout) as string[];
      const hasSeccomp = options.some((value) => value.includes('seccomp'));
      const hasLsm = options.some(
        (value) => value.includes('apparmor') || value.includes('selinux'),
      );
      if (!hasSeccomp || (this.requireLsm && !hasLsm)) {
        throw new Error('Required seccomp/LSM protection is unavailable.');
      }
      if (this.requireLsm) {
        await this.verifyHostLsm();
      }
      await this.docker(['image', 'inspect', this.image], 64 * 1024);
      const { stdout: orphanOutput } = await this.docker(
        [
          'ps',
          '--all',
          '--quiet',
          '--filter',
          'label=com.urtoris.python-executor=1',
        ],
        64 * 1024,
      );
      const orphanIds = orphanOutput
        .split('\n')
        .map((value) => value.trim())
        .filter((value) => /^[a-f0-9]{12,64}$/.test(value));
      for (const orphanId of orphanIds) {
        if (!(await this.removeAndVerify(orphanId))) {
          throw new Error(
            'An orphaned executor container could not be removed.',
          );
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      throw new SandboxInfrastructureError(
        `Docker sandbox preflight failed: ${message}`,
      );
    }
  }

  private attach(
    containerId: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{
    stdout: CapturedOutput;
    stderr: CapturedOutput;
    timedOut: boolean;
    cancelled: boolean;
  }> {
    return new Promise((resolvePromise, reject) => {
      const child = spawn(
        this.dockerBinary,
        ['start', '--attach', containerId],
        { shell: false, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      const stdout = new ByteCollector(EXECUTOR_LIMITS.streamBytes);
      const stderr = new ByteCollector(EXECUTOR_LIMITS.streamBytes);
      let finished = false;
      let timedOut = false;
      let cancelled = false;
      let forceTimer: NodeJS.Timeout | undefined;
      child.stdout.on('data', (chunk: Buffer) => stdout.add(chunk));
      child.stderr.on('data', (chunk: Buffer) => stderr.add(chunk));
      child.once('error', (cause) => reject(cause));

      const stopContainer = () => {
        if (finished) return;
        void this.docker(['kill', containerId], 64 * 1024).catch(
          () => undefined,
        );
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      };
      const handleAbort = () => {
        cancelled = true;
        stopContainer();
      };
      if (signal?.aborted) handleAbort();
      else signal?.addEventListener('abort', handleAbort, { once: true });

      const timeout = setTimeout(() => {
        timedOut = true;
        stopContainer();
      }, timeoutMs);

      child.once('close', () => {
        finished = true;
        clearTimeout(timeout);
        if (forceTimer) clearTimeout(forceTimer);
        signal?.removeEventListener('abort', handleAbort);
        resolvePromise({
          stdout: stdout.result(),
          stderr: stderr.result(),
          timedOut,
          cancelled,
        });
      });
    });
  }

  /**
   * Docker 在容器退出后不保留峰值字段，所以运行期间以有界频率采样
   * `docker stats`。采样失败不影响任务终态，只会让峰值保持 null。
   */
  private watchPeakMemory(containerId: string): () => Promise<number | null> {
    let peak: number | null = null;
    let stopped = false;
    let sampling: Promise<void> | null = null;
    const parseSize = (value: string): number | null => {
      const matched = value.trim().match(/^([0-9.]+)\s*([kmgt]?i?b)$/i);
      if (!matched) return null;
      const amount = Number(matched[1]);
      if (!Number.isFinite(amount)) return null;
      const unit = matched[2].toLowerCase();
      const powers: Record<string, number> = {
        b: 0,
        kb: 1,
        kib: 1,
        mb: 2,
        mib: 2,
        gb: 3,
        gib: 3,
        tb: 4,
        tib: 4,
      };
      const power = powers[unit];
      return power === undefined ? null : Math.round(amount * 1024 ** power);
    };
    const sample = () => {
      if (stopped || sampling) return;
      sampling = this.docker(
        ['stats', '--no-stream', '--format', '{{.MemUsage}}', containerId],
        16 * 1024,
      )
        .then(({ stdout }) => {
          const used = parseSize(stdout.split('/')[0] ?? '');
          if (used !== null) peak = Math.max(peak ?? 0, used);
        })
        .catch(() => undefined)
        .finally(() => {
          sampling = null;
        });
    };
    sample();
    const interval = setInterval(sample, 500);
    return async () => {
      stopped = true;
      clearInterval(interval);
      await sampling;
      return peak;
    };
  }

  private async inspect(containerId: string): Promise<DockerInspect> {
    const { stdout } = await this.docker(['inspect', containerId], 1024 * 1024);
    const parsed = JSON.parse(stdout) as DockerInspect[];
    if (!parsed[0]) throw new Error('Docker inspect returned no container.');
    return parsed[0];
  }

  private async removeAndVerify(containerId: string): Promise<boolean> {
    try {
      await this.docker(['rm', '--force', containerId], 64 * 1024);
    } catch {
      return false;
    }
    try {
      await this.docker(['inspect', containerId], 64 * 1024);
      return false;
    } catch (cause) {
      return (
        cause instanceof DockerCommandError &&
        /no such (?:object|container)/i.test(cause.stderr)
      );
    }
  }

  async run(request: SandboxRunRequest): Promise<SandboxRunOutcome> {
    const started = Date.now();
    const empty = (): CapturedOutput => ({
      text: '',
      truncated: false,
      seenBytes: 0,
    });
    let stdout = empty();
    let stderr = empty();
    let containerId: string | null = null;
    let inspect: DockerInspect | null = null;
    let timedOut = false;
    let cancelled = request.signal?.aborted ?? false;
    let outputLimitExceeded = false;
    let infrastructureError: string | null = null;
    let peakMemoryBytes: number | null = null;

    if (cancelled) {
      return {
        kind: 'cancelled',
        exitCode: null,
        stdout,
        stderr,
        durationMs: 0,
        cpuTimeMs: null,
        peakMemoryBytes: null,
        cleanupConfirmed: true,
        errorMessage: null,
      };
    }

    try {
      // 容器固定以非 root UID 运行，而 bind 挂载保留宿主权限，所以结果目录必须
      // 对该 UID 可写。目录只属于这一次 run，且只能通过这次 run 的挂载进入。
      await mkdir(request.outputDir, { recursive: true, mode: 0o777 });
      await chmod(request.outputDir, 0o777);
      const name = `urtoris-${request.runId}`;
      const created = await this.docker(
        buildDockerCreateArgs({
          image: this.image,
          containerName: name,
          sourcePath: request.sourcePath,
          inputDir: request.inputDir,
          outputDir: request.outputDir,
          memoryBytes: request.memoryBytes,
          cpuCount: request.cpuCount,
          processes: request.processes,
        }),
      );
      containerId = created.stdout.trim();
      if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
        throw new SandboxInfrastructureError(
          'Docker returned an invalid container ID.',
        );
      }
      inspect = await this.inspect(containerId);
      verifyCreatedContainer(
        inspect,
        request,
        this.requireLsm,
        this.daemonLsmVerified,
      );

      // 结果目录现在是可写挂载，所以体积上限在执行期间由 Worker 兜住。
      const stopWatching = watchDirectorySize(
        request.outputDir,
        EXECUTOR_LIMITS.outputVolumeBytes,
        () => {
          outputLimitExceeded = true;
          void this.docker(['kill', containerId as string], 64 * 1024).catch(
            () => undefined,
          );
        },
      );

      const stopWatchingMemory = this.watchPeakMemory(containerId);
      if (request.signal?.aborted) {
        cancelled = true;
        stopWatching();
        peakMemoryBytes = await stopWatchingMemory();
      } else {
        let attached: {
          stdout: CapturedOutput;
          stderr: CapturedOutput;
          timedOut: boolean;
          cancelled: boolean;
        };
        try {
          attached = await this.attach(
            containerId,
            request.timeoutSeconds * 1000,
            request.signal,
          );
        } finally {
          stopWatching();
          peakMemoryBytes = await stopWatchingMemory();
        }
        stdout = attached.stdout;
        stderr = attached.stderr;
        timedOut = attached.timedOut;
        cancelled = attached.cancelled;
        inspect = await this.inspect(containerId);
        if (
          (!attached.cancelled && inspect.State.Running) ||
          (!attached.cancelled &&
            !['exited', 'dead'].includes(inspect.State.Status))
        ) {
          throw new SandboxInfrastructureError(
            'Docker attach ended before the container reached a terminal state.',
          );
        }
      }
    } catch (cause) {
      infrastructureError =
        cause instanceof Error ? cause.message : String(cause);
    }

    const cleanupConfirmed = containerId
      ? await this.removeAndVerify(containerId)
      : true;
    const durationMs = Date.now() - started;
    if (infrastructureError || !inspect || !cleanupConfirmed) {
      return {
        kind: 'worker_error',
        exitCode: inspect?.State.ExitCode ?? null,
        stdout,
        stderr,
        durationMs,
        cpuTimeMs: null,
        peakMemoryBytes,
        cleanupConfirmed,
        errorMessage:
          infrastructureError ?? 'Container cleanup could not be confirmed.',
      };
    }
    if (cancelled) {
      return {
        kind: 'cancelled',
        exitCode: inspect.State.ExitCode,
        stdout,
        stderr,
        durationMs,
        cpuTimeMs: null,
        peakMemoryBytes,
        cleanupConfirmed,
        errorMessage: null,
      };
    }
    if (timedOut) {
      return {
        kind: 'timed_out',
        exitCode: inspect.State.ExitCode,
        stdout,
        stderr,
        durationMs,
        cpuTimeMs: null,
        peakMemoryBytes,
        cleanupConfirmed,
        errorMessage: null,
      };
    }
    if (inspect.State.OOMKilled) {
      return {
        kind: 'memory_limit',
        exitCode: inspect.State.ExitCode,
        stdout,
        stderr,
        durationMs,
        cpuTimeMs: null,
        peakMemoryBytes: Math.max(peakMemoryBytes ?? 0, request.memoryBytes),
        cleanupConfirmed,
        errorMessage: null,
      };
    }
    if (outputLimitExceeded) {
      return {
        kind: 'output_limit',
        exitCode: inspect.State.ExitCode,
        stdout,
        stderr,
        durationMs,
        cpuTimeMs: null,
        peakMemoryBytes,
        cleanupConfirmed,
        errorMessage: null,
      };
    }
    return {
      kind: 'exited',
      exitCode: inspect.State.ExitCode,
      stdout,
      stderr,
      durationMs,
      cpuTimeMs: null,
      peakMemoryBytes,
      cleanupConfirmed,
      errorMessage: inspect.State.Error || null,
    };
  }

  /**
   * 在第二个一次性容器里完整解析产物，不采信沙箱自述。PNG、XLSX 与 PDF 共用同一套
   * 隔离、超时与清理流程，只是脚本和参数不同。
   */
  private async runIsolatedValidator(options: {
    label: string;
    path: string;
    mountedName: string;
    script: string;
    extraArguments: string[];
    memoryBytes: number;
    processes: number;
    timeoutMs: number;
    failureMessage: string;
  }): Promise<void> {
    const name = `urtoris-${options.label}-${basename(options.path)
      .replaceAll(/[^A-Za-z0-9]/g, '')
      .slice(0, 20)}-${Date.now()}`;
    const createArguments = [
      'create',
      ...commonSecurityArgs({
        name,
        memoryBytes: options.memoryBytes,
        cpuCount: 1,
        processes: options.processes,
      }),
      '--mount',
      bindMount(options.path, `/input/${options.mountedName}`),
      '--tmpfs',
      `/tmp:rw,noexec,nosuid,nodev,size=${32 * 1024 * 1024},mode=1777`,
      this.image,
      options.script,
      `/input/${options.mountedName}`,
      ...options.extraArguments,
    ];

    let containerId: string | null = null;
    let rejected = false;
    let message = options.failureMessage;
    let infrastructureError: unknown = null;
    try {
      const created = await this.docker(createArguments, 64 * 1024);
      containerId = created.stdout.trim();
      const attached = await this.attach(containerId, options.timeoutMs);
      const inspect = await this.inspect(containerId);
      if (
        inspect.State.Running ||
        !['exited', 'dead'].includes(inspect.State.Status)
      ) {
        throw new SandboxInfrastructureError(
          'Artifact validator did not reach a terminal state.',
        );
      }
      rejected =
        attached.timedOut ||
        inspect.State.OOMKilled ||
        inspect.State.ExitCode !== 0;
      if (attached.stderr.text.trim()) message = attached.stderr.text.trim();
    } catch (cause) {
      infrastructureError = cause;
    }
    if (containerId && !(await this.removeAndVerify(containerId))) {
      throw new SandboxInfrastructureError(
        'Artifact validator container cleanup could not be confirmed.',
      );
    }
    if (infrastructureError) {
      throw new SandboxInfrastructureError(
        infrastructureError instanceof Error
          ? infrastructureError.message
          : 'Artifact validator infrastructure failed.',
      );
    }
    if (rejected) throw new ArtifactRejectedError(message);
  }

  async validatePng(path: string, maximumPixels: number): Promise<void> {
    await this.runIsolatedValidator({
      label: 'png',
      path,
      mountedName: 'image.png',
      script: '/opt/executor/validate_png.py',
      extraArguments: [String(maximumPixels)],
      memoryBytes: 256 * 1024 * 1024,
      processes: 32,
      timeoutMs: 5_000,
      failureMessage: 'PNG failed isolated decoding.',
    });
  }

  async validateXlsx(path: string): Promise<void> {
    await this.runIsolatedValidator({
      label: 'xlsx',
      path,
      mountedName: 'book.xlsx',
      script: '/opt/executor/validate_xlsx.py',
      extraArguments: [],
      memoryBytes: 384 * 1024 * 1024,
      processes: 32,
      timeoutMs: 8_000,
      failureMessage: 'XLSX failed isolated parsing.',
    });
  }

  async validatePdf(path: string): Promise<void> {
    await this.runIsolatedValidator({
      label: 'pdf',
      path,
      mountedName: 'document.pdf',
      script: '/opt/executor/validate_pdf.py',
      extraArguments: [],
      memoryBytes: 384 * 1024 * 1024,
      processes: 32,
      timeoutMs: 8_000,
      failureMessage: 'PDF failed isolated parsing.',
    });
  }

  async validateDocx(path: string): Promise<void> {
    await this.runIsolatedValidator({
      label: 'docx',
      path,
      mountedName: 'document.docx',
      script: '/opt/executor/validate_ooxml.py',
      extraArguments: ['docx'],
      memoryBytes: 384 * 1024 * 1024,
      processes: 32,
      timeoutMs: 8_000,
      failureMessage: 'DOCX failed isolated parsing.',
    });
  }

  async validatePptx(path: string): Promise<void> {
    await this.runIsolatedValidator({
      label: 'pptx',
      path,
      mountedName: 'presentation.pptx',
      script: '/opt/executor/validate_ooxml.py',
      extraArguments: ['pptx'],
      memoryBytes: 384 * 1024 * 1024,
      processes: 32,
      timeoutMs: 8_000,
      failureMessage: 'PPTX failed isolated parsing.',
    });
  }
}
