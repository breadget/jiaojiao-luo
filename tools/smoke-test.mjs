#!/usr/bin/env node
/**
 * 端到端验收：在 ECS 上跑 tools/remote/smoke_test.py。
 *
 * 这个脚本本身不产生任何结论 —— 它只负责把测试脚本送上去、带上令牌执行、
 * 再把逐条结果透传出来。所有断言都在 PY 侧，读的是真实 HTTP 响应。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SECRETS = join(ROOT, '.secrets.json');
const SSH_KEY = `${process.env.HOME}/.ssh/urtoris-ecs`;
const ECS = process.env.URTORIS_ECS ?? 'root@8.133.252.143';
const REMOTE = '/tmp/urtoris-bundle/smoke_test.py';

function main() {
  if (!existsSync(SECRETS)) {
    throw new Error('缺少 .secrets.json（先跑一次 tools/deploy-n8n.mjs）');
  }
  const secrets = JSON.parse(readFileSync(SECRETS, 'utf8'));

  execFileSync(
    'ssh',
    ['-i', SSH_KEY, ECS, 'mkdir -p /tmp/urtoris-bundle'],
    { stdio: 'pipe' },
  );
  execFileSync('scp', ['-i', SSH_KEY, '-q', join(HERE, 'remote', 'smoke_test.py'), `${ECS}:${REMOTE}`]);

  console.log('== 端到端验收（在 ECS 上执行）==\n');
  try {
    execFileSync(
      'ssh',
      [
        '-i',
        SSH_KEY,
        ECS,
        `python3 ${REMOTE} --webhook-token ${secrets.webhookToken} --internal-token ${secrets.internalToken}`,
      ],
      { stdio: 'inherit' },
    );
  } catch (cause) {
    process.exit(cause.status ?? 1);
  }
}

main();
