#!/usr/bin/env node
/**
 * 把生成好的工作流体系部署到 ECS 上的 n8n。
 *
 *   1. 重新生成 + 结构校验（本地挡住错误，不把问题带上服务器）
 *   2. 打包 scp 到服务器
 *   3. 在服务器上执行 tools/remote/n8n_deploy.py（备份 → 环境变量 → 凭证 → 导入 → 发布 → 核对）
 *
 * 用法：node tools/deploy-n8n.mjs [--dry-run]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SECRETS = join(ROOT, '.secrets.json');
const SSH_KEY = `${process.env.HOME}/.ssh/urtoris-ecs`;
const ECS = process.env.URTORIS_ECS ?? 'root@8.133.252.143';
const REMOTE_BUNDLE = '/tmp/urtoris-bundle';

function sh(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: 'pipe', ...options });
}

function ssh(remoteCommand, { inherit = false } = {}) {
  const args = ['-i', SSH_KEY, '-o', 'ConnectTimeout=15', ECS, remoteCommand];
  if (inherit) {
    execFileSync('ssh', args, { stdio: 'inherit' });
    return '';
  }
  return sh('ssh', args);
}

function loadSecrets() {
  if (existsSync(SECRETS)) {
    return JSON.parse(readFileSync(SECRETS, 'utf8'));
  }
  const secrets = {
    webhookToken: randomBytes(24).toString('hex'),
    internalToken: randomBytes(24).toString('hex'),
  };
  writeFileSync(SECRETS, `${JSON.stringify(secrets, null, 2)}\n`, { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
  console.log('已生成新的共享令牌 → .secrets.json（600 权限，请勿提交）');
  return secrets;
}

function main() {
  const dryRun = process.argv.includes('--dry-run');
  const secrets = loadSecrets();

  console.log('== 生成工作流 ==');
  console.log(sh('node', [join(HERE, 'build-workflows.mjs')]).trim());

  console.log('\n== 结构校验 ==');
  console.log(sh('node', [join(HERE, 'validate-workflows.mjs')]).trim());

  console.log('\n== 节点版本回归 ==');
  console.log(sh('node', [join(HERE, 'test-node-versions.mjs')]).trim());

  console.log('\n== 前置执行绑定回归 ==');
  console.log(sh('node', [join(HERE, 'test-execution-binding.mjs')]).trim());

  console.log('\n== mode / degraded 协议语义回归 ==');
  console.log(sh('node', [join(HERE, 'test-mode-semantics.mjs')]).trim());

  if (dryRun) {
    console.log('\n--dry-run：跳过上传与部署');
    return;
  }

  console.log('\n== 打包并上传 ==');
  const bundleFiles = ['all-workflows.json', 'manifest.json'];
  ssh(`rm -rf ${REMOTE_BUNDLE} && mkdir -p ${REMOTE_BUNDLE}`);
  for (const file of bundleFiles) {
    sh('scp', ['-i', SSH_KEY, '-q', join(ROOT, 'generated', file), `${ECS}:${REMOTE_BUNDLE}/${file}`]);
  }
  sh('scp', [
    '-i',
    SSH_KEY,
    '-q',
    join(HERE, 'remote', 'n8n_deploy.py'),
    `${ECS}:${REMOTE_BUNDLE}/n8n_deploy.py`,
  ]);
  console.log(`已上传 ${bundleFiles.length + 1} 个文件 → ${REMOTE_BUNDLE}`);

  console.log('\n== 在 ECS 上执行部署 ==');
  ssh(
    `cd /opt/n8n && python3 ${REMOTE_BUNDLE}/n8n_deploy.py --bundle ${REMOTE_BUNDLE} ` +
      `--webhook-token ${secrets.webhookToken} --internal-token ${secrets.internalToken}`,
    { inherit: true },
  );

  // 把令牌同步给 Urtoris 应用（.dev.vars 只在服务器上，不进仓库/压缩包）
  console.log('\n== 同步令牌到 Urtoris 应用 ==');
  ssh(
    [
      'set -e',
      'V=/opt/urtoris/app/.dev.vars',
      'touch "$V"',
      `grep -v '^N8N_BASE_URL=' "$V" | grep -v '^N8N_WEBHOOK_TOKEN=' | grep -v '^URTORIS_INTERNAL_TOKEN=' > "$V.tmp" || true`,
      `printf 'N8N_BASE_URL=http://127.0.0.1:5678\\nN8N_WEBHOOK_TOKEN=${secrets.webhookToken}\\nURTORIS_INTERNAL_TOKEN=${secrets.internalToken}\\n' >> "$V.tmp"`,
      'mv "$V.tmp" "$V"',
      'chown urtoris:urtoris "$V"',
      'chmod 600 "$V"',
      'systemctl restart urtoris',
      'for i in $(seq 1 30); do curl -fsS http://127.0.0.1:3000/api/state >/dev/null 2>&1 && break; sleep 2; done',
      'curl -s -o /dev/null -w "urtoris /api/state -> HTTP %{http_code}\\n" http://127.0.0.1:3000/api/state',
    ].join('\n'),
    { inherit: true },
  );

  console.log('\n✅ n8n 侧部署完成');
}

main();
