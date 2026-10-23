#!/usr/bin/env node
/**
 * 把 n8n 侧的 5 个工作流登记进 Urtoris 站点，形成「网站 → n8n」的真实绑定。
 *
 * 通过站点自己的 /api/workflows 写入（而不是直接改 D1 文件），
 * 保证走的是和生产一致的那条写入路径（版本号、发布状态都由应用维护）。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SSH_KEY = `${process.env.HOME}/.ssh/urtoris-ecs`;
const ECS = process.env.URTORIS_ECS ?? 'root@8.133.252.143';

/** 站点展示用的工作流定义：步骤链要能真实反映 n8n 里干了什么。 */
const SITE_WORKFLOWS = [
  {
    id: 'wf_n8n_llm_smoke',
    name: 'W1 · Agent LLM 连通性冒烟',
    description: '网站 → n8n → common-llm → 大模型。用你自己的 Key 验证全链路是否通。',
    webhook: 'urtoris/llm-smoke',
    steps: [
      { title: '校验协议', detail: 'Bearer 鉴权 + urtoris.v1 请求体校验', kind: 'input' },
      { title: '调用 common-llm', detail: 'Execute Sub-workflow 走统一模型出口', kind: 'transform' },
      { title: '模型推理', detail: 'BYO Key 随请求透传，n8n 不落盘密钥', kind: 'compose' },
      { title: '信封 + 日志', detail: 'common-envelope 统一响应，common-log 回写执行事件', kind: 'output' },
    ],
  },
  {
    id: 'wf_n8n_user_manager',
    name: 'W2 · 建用户：AI 主管 Agent',
    description: '解析新同事资料 → AI 判定职级 → 分流到主管频道或普通成员登记。',
    webhook: 'urtoris/user-manager',
    steps: [
      { title: '提取用户信息', detail: '从消息或 input 里解析姓名/邮箱/部门/职位', kind: 'input' },
      { title: 'AI 判定职级', detail: '有 Key 走模型，没 Key 自动退回规则判定', kind: 'decision' },
      { title: '分支动作', detail: '主管 → 加入主管频道；普通成员 → 更新个人资料', kind: 'compose' },
      { title: '信封 + 日志', detail: '统一响应结构并回写执行事件', kind: 'output' },
    ],
  },
  {
    id: 'wf_n8n_security_analysis',
    name: 'W3 · 安全分析：IP/域名情报',
    description: '真实情报采集：ip-api.com + AliDNS 解析 + RDAP 注册信息，自动算风险分。',
    webhook: 'urtoris/security-analysis',
    steps: [
      { title: '提取目标', detail: '从文本中提取 IP 与域名并去重', kind: 'transform' },
      { title: '采集情报', detail: 'IP 归属/ASN、DNS 解析、域名注册时间', kind: 'transform' },
      { title: '风险评分', detail: '数据中心段/代理出口/新注册域名等特征加权', kind: 'decision' },
      { title: '信封 + 日志', detail: '统一响应结构并回写执行事件', kind: 'output' },
    ],
  },
  {
    id: 'wf_n8n_api_gateway',
    name: 'W4 · API 网关：HTTP 方法路由',
    description: '按 GET/POST/DELETE 路由到真实上游并回传结果，原 Proxmox 节点保留未启用。',
    webhook: 'urtoris/api-gateway',
    steps: [
      { title: '解析网关请求', detail: '校验方法与目标地址（仅允许 https）', kind: 'input' },
      { title: '方法路由', detail: 'Switch 按 HTTP 方法分发', kind: 'decision' },
      { title: '真实转发', detail: 'HTTP Request 打到上游并取回响应', kind: 'transform' },
      { title: '信封 + 日志', detail: '统一响应结构并回写执行事件', kind: 'output' },
    ],
  },
  {
    id: 'wf_n8n_customer_insights',
    name: 'W5 · 客户洞察：评论聚类 + AI 总结',
    description: '真实 K-means（k-means++ / 3 seeds）聚类客户评论，再交给模型产出改进建议。',
    webhook: 'urtoris/customer-insights',
    steps: [
      { title: '加载评论', detail: '内置样本集，或由 context.input.reviews 传入', kind: 'input' },
      { title: 'K-means 聚类', detail: 'k-means++ 初始化 + 多随机种子取最优', kind: 'transform' },
      { title: '生成洞察', detail: '有 Key 走模型总结，没有则按簇给出规则建议', kind: 'compose' },
      { title: '信封 + 日志', detail: '统一响应结构并回写执行事件', kind: 'output' },
    ],
  },
];

function ssh(remoteCommand) {
  return execFileSync(
    'ssh',
    ['-i', SSH_KEY, '-o', 'ConnectTimeout=15', ECS, remoteCommand],
    { encoding: 'utf8', stdio: 'pipe' },
  );
}

function main() {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'generated', 'manifest.json'), 'utf8'));
  const base = manifest.containers.internalBaseUrl;

  const payloads = SITE_WORKFLOWS.map((workflow) => ({
    action: 'publish',
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    steps: workflow.steps.map((step, index) => ({
      id: `${workflow.id}-step-${index + 1}`,
      title: step.title,
      detail: step.detail,
      kind: step.kind,
    })),
    n8nWebhookUrl: `${base}/webhook/${workflow.webhook}`,
    // 留空 = 显式清空，让 Urtoris 客户端走服务端共享令牌（N8N_WEBHOOK_TOKEN）
    n8nAuthHeader: '',
  }));

  const remote = `
import json, urllib.request, urllib.error
payloads = json.loads(${JSON.stringify(JSON.stringify(payloads))})
results = []
for payload in payloads:
    data = json.dumps(payload).encode()
    request = urllib.request.Request(
        'http://127.0.0.1:3000/api/workflows', data=data,
        headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            body = json.loads(response.read().decode())
            workflow = body.get('workflow') or {}
            results.append({'id': payload['id'], 'status': response.status, 'version': workflow.get('version'), 'webhook': workflow.get('n8nWebhookUrl')})
    except urllib.error.HTTPError as error:
        results.append({'id': payload['id'], 'status': error.code, 'error': error.read().decode()[:300]})
print(json.dumps(results, ensure_ascii=False))
`;

  const output = ssh(`python3 - <<'PYEOF'\n${remote}\nPYEOF`);
  const results = JSON.parse(output.trim().split('\n').pop());

  console.log('== 登记站点工作流 ==');
  let failed = 0;
  for (const result of results) {
    if (result.status === 200 && result.webhook) {
      console.log(`  ✓ ${result.id}  v${result.version}  → ${result.webhook}`);
    } else {
      failed += 1;
      console.log(`  ✗ ${result.id}  HTTP ${result.status}  ${result.error ?? ''}`);
    }
  }
  if (failed) process.exit(1);
  console.log(`\n✅ ${results.length} 个工作流已绑定到 n8n webhook`);
}

main();
