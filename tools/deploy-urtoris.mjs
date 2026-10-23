#!/usr/bin/env node
/**
 * 把 Urtoris 应用源码同步到 ECS 并在服务器上重建。
 *
 * 为什么必须在服务器上构建：这台 2C/1.6G 的机器内存很紧，deploy/rebuild-safe.sh
 * 会先停掉 n8n 腾内存、限制 node 堆大小再构建 —— 这是踩过一次整机失联 36 分钟
 * 之后固化下来的流程，不要在本地构建后上传 dist。
 *
 * 用法：node tools/deploy-urtoris.mjs [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.env.URTORIS_APP_DIR ?? '/Users/bird/Documents/ChatGPT/机器人';
const SSH_KEY = `${process.env.HOME}/.ssh/urtoris-ecs`;
const ECS = process.env.URTORIS_ECS ?? 'root@8.133.252.143';
const REMOTE_DIR = '/opt/urtoris/app';
const TARBALL = '/tmp/urtoris-src.tar.gz';

const EXCLUDES = [
  'node_modules',
  'dist',
  '.git',
  '.next',
  '.vinext',
  '.wrangler',
  'tsconfig.tsbuildinfo',
  'urtoris-deploy.tar.gz',
  '.dev.vars',
  '.impeccable',
];

function sh(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function ssh(remoteCommand) {
  execFileSync(
    'ssh',
    ['-i', SSH_KEY, '-o', 'ConnectTimeout=15', ECS, remoteCommand],
    { stdio: 'inherit' },
  );
}

function main() {
  if (!existsSync(APP_DIR)) {
    throw new Error(`找不到应用目录：${APP_DIR}`);
  }

  const args = ['-czf', TARBALL, '-C', APP_DIR];
  for (const pattern of EXCLUDES) {
    args.push(`--exclude=./${pattern}`, `--exclude=${pattern}`);
  }
  args.push('.');
  console.log('== 打包源码 ==');
  // COPYFILE_DISABLE 防止 macOS 把 ._* 资源分叉文件塞进 tar
  sh('tar', args, { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  const size = Number(sh('stat', ['-f', '%z', TARBALL]).trim());
  console.log(`已打包 ${(size / 1024 / 1024).toFixed(2)} MB → ${TARBALL}`);

  if (process.argv.includes('--dry-run')) {
    console.log('--dry-run：跳过上传与构建');
    return;
  }

  console.log('\n== 上传 ==');
  sh('scp', ['-i', SSH_KEY, '-q', TARBALL, `${ECS}:${TARBALL}`]);

  console.log('\n== 解包（保留 .dev.vars / node_modules / dist） ==');
  ssh(
    [
      'set -e',
      `cd ${REMOTE_DIR}`,
      // 只覆盖源码，别把 node_modules 和 .dev.vars 冲掉
      `tar -xzf ${TARBALL} --exclude=./.dev.vars --exclude=./node_modules`,
      // tar 以 root 解包会保留本地 uid（501:staff），必须整体交还给 urtoris，
      // 否则构建时连 dist 都 rmdir 不掉（会报 EACCES）
      `chown -R urtoris:urtoris ${REMOTE_DIR}`,
      `find ${REMOTE_DIR} -name '.DS_Store' -delete 2>/dev/null || true`,
      `find ${REMOTE_DIR} -name '._*' -delete 2>/dev/null || true`,
      `ls -la ${REMOTE_DIR} | head -5`,
    ].join('\n'),
  );

  console.log('\n== 在服务器上重建（会短暂停 n8n 腾内存） ==');
  ssh(`bash ${REMOTE_DIR}/deploy/rebuild-safe.sh`);

  console.log('\n== 验证 ==');
  ssh(
    [
      'for i in $(seq 1 45); do curl -fsS -o /dev/null http://127.0.0.1:5678/rest/settings && break; sleep 2; done',
      'curl -s -o /dev/null -w "  urtoris /api/state          -> HTTP %{http_code}\\n" http://127.0.0.1:3000/api/state',
      // /api/workflows 只有 POST，用 405 判断可达即可
      'curl -s -o /dev/null -w "  urtoris /api/workflows      -> HTTP %{http_code}（405 = 可达）\\n" http://127.0.0.1:3000/api/workflows',
      'curl -s -o /dev/null -w "  urtoris /api/n8n/events     -> HTTP %{http_code}（503 = 端点已就位但未配令牌）\\n" -X POST -H "Content-Type: application/json" -d "{}" http://127.0.0.1:3000/api/n8n/events',
      'curl -s -o /dev/null -w "  n8n     /rest/settings      -> HTTP %{http_code}\\n" http://127.0.0.1:5678/rest/settings',
      'systemctl is-active n8n urtoris | tr "\\n" " "; echo',
      'true',
    ].join('\n'),
  );

  console.log('\n✅ Urtoris 应用已重建');
}

main();
