import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDatabaseBridge } from './server';

/** Private local state; never follow a token symlink or print the token. */
export async function loadDatabaseBridgeToken(
  runtimeDirectory: string,
): Promise<string> {
  await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
  if (!(await lstat(runtimeDirectory)).isDirectory())
    throw new Error('数据库助手状态位置必须是普通文件夹。');
  await chmod(runtimeDirectory, 0o700);
  const tokenFile = resolve(runtimeDirectory, 'connection-token');
  const readToken = async (): Promise<string> => {
    const file = await open(
      tokenFile,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 256)
        throw new Error('数据库助手连接代码文件无效。');
      await file.chmod(0o600);
      const token = (await file.readFile('utf8')).trim();
      if (!/^[a-f0-9]{64}$/.test(token))
        throw new Error(
          '数据库助手连接代码文件无效。请移除本机 connection-token 文件后重启助手。',
        );
      return token;
    } finally {
      await file.close();
    }
  };
  try {
    return await readToken();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') throw cause;
  }
  const token = randomBytes(32).toString('hex');
  try {
    const file = await open(
      tokenFile,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(token, 'utf8');
      await file.chmod(0o600);
    } finally {
      await file.close();
    }
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return readToken();
    throw cause;
  }
  return token;
}

export async function startDatabaseBridge(): Promise<void> {
  const token = await loadDatabaseBridgeToken(resolve('work/local-database'));
  const bridge = createDatabaseBridge({ token });
  bridge.on('error', (error) => {
    process.stderr.write(`数据库连接助手启动失败：${error.message}\n`);
    process.exitCode = 1;
  });
  bridge.listen(3022, '127.0.0.1', () => {
    process.stdout.write(
      '本机数据库连接助手已启动（只读 SQLite）。\n打开 http://127.0.0.1:3022/connect ，点击“打开工作台并连接”。\n保持这个窗口开启；Ctrl+C 停止助手。\n',
    );
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => bridge.close(() => process.exit(0)));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void startDatabaseBridge().catch((cause: unknown) => {
    process.stderr.write(
      `数据库连接助手启动失败：${cause instanceof Error ? cause.message : '无法初始化本机状态。'}\n`,
    );
    process.exitCode = 1;
  });
}
