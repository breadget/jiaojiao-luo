#!/usr/bin/env node
/**
 * 生成结果的结构化校验 —— 在导入 n8n 之前把错误挡在本地。
 *
 * n8n 对非法连接是「静默接受、运行时才炸」，所以这里自己查：
 *   1. 节点名唯一、连接引用的节点存在
 *   2. 连接的输出索引不超过源节点的输出个数（IF=2，Switch=rules 数量，其余=1）
 *   3. 每个节点都从触发器可达（游离节点 = 白写的节点）
 *   4. Code 节点的 jsCode 至少能通过语法解析
 *   5. 子工作流引用、errorWorkflow 引用都在本次生成范围内
 *   6. 每个业务工作流恰好一个 Webhook 触发器和恰好一个响应出口
 *   7. 每个节点的 typeVersion 都在 n8n 2.38.6 的真实版本表里（见 n8n-node-versions.mjs）
 *   8. 危险节点（LLM / HTTP / Tool / 业务子工作流）绕不过前置执行绑定闸门（仅 business）
 *   9. 绑定阶段必须挂在「请求合法?」的 true 分支之后（requestId 校验在前、上报在后），
 *      绑定闸门的 false 分支必须止于 Respond 且摸不到任何危险节点
 *      （含 meta.urtorisBinding 一致性）—— 全部复用 binding-graph.mjs 的共享不变量
 *      （`urtoris-gateway` 是 legacy：它没有协议校验链，不参与绑定，也不在这里被要求补一个）
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { validateNodeTypeVersion } from './n8n-node-versions.mjs';
import {
  bindingTopologyProblems,
  findBindingGuardNode,
  findWebhookNode,
} from './binding-graph.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GEN = join(ROOT, 'generated');

const errors = [];
const warnings = [];

function outputCount(node) {
  // continueErrorOutput 会给节点多挂一个错误输出端口
  const errorPort = node.onError === 'continueErrorOutput' ? 1 : 0;
  if (node.type === 'n8n-nodes-base.if') return 2;
  if (node.type === 'n8n-nodes-base.switch') {
    const values = node.parameters?.rules?.values;
    return (Array.isArray(values) ? Math.max(1, values.length) : 1) + errorPort;
  }
  return 1 + errorPort;
}

const TRIGGER_TYPES = new Set([
  'webhook',
  'errorTrigger',
  'executeWorkflowTrigger',
  'scheduleTrigger',
  'manualTrigger',
  'formTrigger',
  'githubTrigger',
]);

function isTrigger(node) {
  const short = node.type.split('.').pop() ?? '';
  return TRIGGER_TYPES.has(short) || /Trigger$/.test(short);
}

/**
 * 8/9. 前置执行绑定（pre-node deterministic execution binding）的结构校验。
 *
 * 需求是「危险节点必须先绑定 executionId 才允许执行」，而且**绑定之前必须先校验 requestId**：
 *   (a) 从 Webhook 出发、**不允许穿过绑定闸门**的情况下，任何危险节点都不可达；
 *       （协议公共设施子工作流 common-envelope / common-log 不算危险节点 ——
 *        VALIDATION_ERROR 的 false 分支本来就要能回信封、落日志，见 binding-graph.mjs）
 *   (b) 绑定闸门的 false 分支必须终止于 Respond to Webhook，且沿途碰不到危险节点；
 *   (c) 绑定上报必须严格位于「请求合法?」的 true 分支之后（requestId 校验在前）；
 *   (d) 上报 body 的 requestId 不得兜底、workflowId 必须取 payload（站点侧 id）。
 *
 * 具体不变量与错误措辞都放在 binding-graph.mjs 的 bindingTopologyProblems 里，
 * 与 tools/test-execution-binding.mjs 共用同一份，避免「校验通过、回归没守」。
 *
 * 只对 meta.urtorisRole === 'business' 的工作流生效（它们有完整协议校验链）。
 * `urtoris-gateway` 按 legacy 处理：它没有协议校验链，给它的 executionId 绑定只会指向
 * 调度器执行而不是真实业务执行，所以它**不该**有绑定阶段 —— 这里也不为它放宽任何检查，
 * 它根本不进入这个函数。
 */
function validateExecutionBinding(workflow, tag) {
  if (!findWebhookNode(workflow)) {
    errors.push(`[${tag}] 业务/网关工作流没有 Webhook，无法校验前置执行绑定`);
    return;
  }
  for (const problem of bindingTopologyProblems(workflow)) {
    errors.push(`[${tag}] ${problem}`);
  }
}

function validate(workflow, allIds) {
  const tag = workflow.id;
  const names = new Set();
  for (const node of workflow.nodes) {
    if (names.has(node.name)) errors.push(`[${tag}] 节点名重复：${node.name}`);
    names.add(node.name);
    if (!node.type) errors.push(`[${tag}] 节点缺少 type：${node.name}`);
    if (!Array.isArray(node.position) || node.position.length !== 2) {
      errors.push(`[${tag}] 节点缺少合法 position：${node.name}`);
    }
    // 7. typeVersion 必须真实存在，否则 n8n 只会给一个 `?` 节点
    const versionCheck = validateNodeTypeVersion(node.type, node.typeVersion);
    if (!versionCheck.ok) {
      errors.push(
        `[${tag}] ${node.name}：${versionCheck.reason}` +
          (versionCheck.supported
            ? `（受支持：${versionCheck.supported.join(' / ')}）`
            : ''),
      );
    }
  }

  // 1/2. 连接合法性
  const targets = new Map();
  for (const [source, outputs] of Object.entries(workflow.connections ?? {})) {
    const sourceNode = workflow.nodes.find((n) => n.name === source);
    if (!sourceNode) {
      errors.push(`[${tag}] 连接来源不存在：${source}`);
      continue;
    }
    if (sourceNode.type === 'n8n-nodes-base.switch') {
      const fallback = sourceNode.parameters?.options?.fallbackOutput;
      if (fallback !== undefined && typeof fallback !== 'number' && fallback !== 'extra') {
        errors.push(
          `[${tag}] Switch 的 fallbackOutput 必须是数字（-1 = None），实际 ${JSON.stringify(fallback)}`,
        );
      }
      for (const rule of sourceNode.parameters?.rules?.values ?? []) {
        if (!Array.isArray(rule?.conditions?.conditions)) {
          errors.push(
            `[${tag}] Switch ${sourceNode.name} 的规则 conditions 必须是过滤器对象（含 conditions[]），否则所有项都会落到 output 0`,
          );
          break;
        }
      }
    }
    const max = outputCount(sourceNode);
    const branches = outputs.main ?? [];
    if (branches.length > max) {
      errors.push(`[${tag}] ${source} 声明了 ${branches.length} 个输出，但该节点只有 ${max} 个`);
    }
    branches.forEach((branch, index) => {
      for (const connection of branch ?? []) {
        if (!names.has(connection.node)) {
          errors.push(`[${tag}] ${source}[${index}] 指向不存在的节点：${connection.node}`);
          continue;
        }
        targets.set(connection.node, true);
      }
    });
  }

  // 3. 可达性
  const adjacency = new Map();
  for (const [source, outputs] of Object.entries(workflow.connections ?? {})) {
    const list = [];
    for (const branch of outputs.main ?? []) {
      for (const connection of branch ?? []) list.push(connection.node);
    }
    adjacency.set(source, list);
  }
  const roots = workflow.nodes.filter(isTrigger).map((n) => n.name);
  if (roots.length === 0) errors.push(`[${tag}] 没有任何触发器节点`);
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length) {
    const current = queue.shift();
    for (const next of adjacency.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  for (const node of workflow.nodes) {
    if (!seen.has(node.name) && !node.disabled) {
      warnings.push(`[${tag}] 节点不可达（游离）：${node.name}`);
    }
  }

  // 4. Code 节点语法 + 语言枚举
  for (const node of workflow.nodes) {
    const code = node.parameters?.jsCode;
    if (typeof code !== 'string') continue;
    const language = node.parameters?.language;
    if (language !== undefined && !['javaScript', 'python', 'pythonNative'].includes(language)) {
      errors.push(`[${tag}] Code 节点 language 非法（n8n 只认 javaScript）：${node.name} = ${language}`);
    }
    try {
      // eslint-disable-next-line no-new-func
      new Function('$input', '$json', '$execution', '$env', '$', code);
    } catch (cause) {
      errors.push(`[${tag}] Code 节点语法错误 ${node.name}：${cause.message}`);
    }
  }

  // 5. 子工作流 / 错误工作流引用
  for (const node of workflow.nodes) {
    if (node.type === 'n8n-nodes-base.executeWorkflow') {
      const sub = node.parameters?.workflowId?.value;
      if (!sub) errors.push(`[${tag}] ${node.name} 没有配置子工作流 id`);
      else if (!allIds.has(sub)) errors.push(`[${tag}] ${node.name} 引用了不存在的子工作流：${sub}`);
    }
  }
  const errorWorkflow = workflow.settings?.errorWorkflow;
  if (errorWorkflow && !allIds.has(errorWorkflow)) {
    errors.push(`[${tag}] settings.errorWorkflow 指向不存在的工作流：${errorWorkflow}`);
  }
  if (!errorWorkflow && workflow.meta?.urtorisRole !== 'global-error-handler') {
    warnings.push(`[${tag}] 未绑定全局 Error Workflow`);
  }

  // 6. 业务工作流的入口/出口
  if (workflow.meta?.urtorisRole === 'business' || workflow.meta?.urtorisRole === 'gateway') {
    const hooks = workflow.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
    if (hooks.length !== 1) errors.push(`[${tag}] webhook 节点数量应为 1，实际 ${hooks.length}`);
    for (const hook of hooks) {
      if (hook.parameters?.responseMode !== 'responseNode') {
        errors.push(`[${tag}] webhook.responseMode 必须是 responseNode`);
      }
      if (hook.parameters?.authentication !== 'headerAuth') {
        errors.push(`[${tag}] webhook 未启用 Header Auth —— 裸奔的 webhook 不允许进生产`);
      }
      if (!hook.parameters?.path?.startsWith('urtoris/')) {
        errors.push(`[${tag}] webhook path 必须以 urtoris/ 开头，实际 ${hook.parameters?.path}`);
      }
    }
    const responders = workflow.nodes.filter(
      (n) => n.type === 'n8n-nodes-base.respondToWebhook',
    );
    if (responders.length !== 1) errors.push(`[${tag}] Respond to Webhook 节点数量应为 1`);
    // 响应出口必须是唯一的「无出边」节点
    const noOutgoing = workflow.nodes.filter(
      (n) => !(workflow.connections ?? {})[n.name] && !n.disabled && !isTrigger(n),
    );
    if (noOutgoing.length !== 1) {
      errors.push(
        `[${tag}] 应当是唯一出口，实际有 ${noOutgoing.length} 个无出边节点：${noOutgoing.map((n) => n.name).join('、')}`,
      );
    }

    // 8/9. 前置执行绑定：只对 5 个业务工作流生效。
    // `urtoris-gateway` 是 legacy —— 它没有协议校验链，绑 executionId 会让
    // runs.execution_id 指向调度器执行而不是真实业务执行，所以它不该有绑定阶段。
    // 这不是给它开后门：它压根不参与绑定，检查对 5 个业务工作流一条都没放松。
    if (workflow.meta?.urtorisRole === 'business') {
      validateExecutionBinding(workflow, tag);
    }
  }

  // meta.urtorisBinding 是站点判断「这次执行能不能信任 executionId 已绑定过」的依据，
  // 写反了不会报错、只会让站点误判，所以必须与实际结构逐字对齐。
  const hasGuard = Boolean(findBindingGuardNode(workflow));
  const declaredBinding = workflow.meta?.urtorisBinding;
  if (declaredBinding !== (hasGuard ? 'prebound' : 'legacy')) {
    errors.push(
      `[${tag}] meta.urtorisBinding=${JSON.stringify(declaredBinding)} 与实际结构不符（绑定闸门：${hasGuard ? '有' : '无'}）`,
    );
  }

  // 执行记录必须定稿：n8n 2.35.7 在 saveDataSuccessExecution='none' 时不更新
  // execution_entity 的最终状态，执行行会永远停在 running（实测 100+ 条悬挂）。
  const successSave = workflow.settings?.saveDataSuccessExecution;
  if (successSave === 'none') {
    errors.push(
      `[${tag}] saveDataSuccessExecution 不能是 'none'：会导致执行行永远停在 running，磁盘控制请交给 pruning`,
    );
  }
}

function main() {
  const files = readdirSync(GEN).filter((f) => f.endsWith('.json') && f !== 'all-workflows.json');
  const workflows = files
    .filter((f) => f !== 'manifest.json')
    .map((f) => JSON.parse(readFileSync(join(GEN, f), 'utf8')));
  const allIds = new Set(workflows.map((w) => w.id));

  for (const workflow of workflows) validate(workflow, allIds);

  const total = workflows.reduce((sum, w) => sum + w.nodes.length, 0);
  console.log(`校验 ${workflows.length} 个工作流 / ${total} 个节点`);
  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} 条警告：`);
    for (const warning of warnings) console.log(`   · ${warning}`);
  }
  if (errors.length) {
    console.log(`\n❌ ${errors.length} 条错误：`);
    for (const error of errors) console.log(`   · ${error}`);
    process.exit(1);
  }
  console.log('\n✅ 结构校验全部通过');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
