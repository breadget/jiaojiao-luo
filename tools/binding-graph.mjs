#!/usr/bin/env node
/**
 * 前置执行绑定（pre-node deterministic execution binding）的**共享契约**。
 *
 * 为什么单独一个文件：绑定这件事被三方同时依赖 ——
 *   1. tools/build-workflows.mjs      按这里的名字/id/字段生成三个绑定节点
 *   2. tools/validate-workflows.mjs   按这里的危险节点集合与图遍历规则做结构校验
 *   3. tools/test-execution-binding.mjs 按同一套规则做回归断言
 * 如果各写一份字符串常量，改一处漏一处就会「校验通过、线上不生效」，所以只留这一个来源。
 *
 * 设计约束（来自需求，不要放宽）：
 *   · 绑定上报的插入点是「请求合法?」的 **true 分支**，不是 Webhook 的直连下游 ——
 *     必须先做完 requestId / 协议字段校验，再谈绑定；顺序颠倒会让
 *     requestId 缺失的请求先打站点 /api/n8n/events（脏绑定行 + 错误码从
 *     VALIDATION_ERROR 变成 BINDING_FAILED）；
 *   · requestId 缺失由「请求合法?」在上游直接判成 VALIDATION_ERROR，
 *     **绝不**给 requestId 兜底成 'unknown'，也绝不为它调用站点；
 *   · 上报失败 → 直接返回 BINDING_FAILED 信封，**绝不**进入危险节点（fail-closed）；
 *   · 拓扑形状（唯一允许的形状）：
 *
 *       Webhook → 校验请求(code) → 请求合法?(if) ─┬─ true  → 绑定执行 → 归一绑定结果 → 绑定成功? ─┬─ true  → 原 true 分支目标
 *                                               │                                                  └─ false → Respond (BINDING_FAILED)
 *                                               └─ false → 原 false 分支目标 (VALIDATION_ERROR)
 *
 *   · 绑定阶段的节点 id 是**固定字面量**，不用 build-workflows.mjs 里的递增序号 ——
 *     序号方案下「插入新节点」会把后面所有节点的 id 整体平移，让每次改动变成全量 diff，
 *     也会让历史执行记录对不上号。固定 id 插入后既有节点一个都不动。
 */

// ─────────────────────────── 绑定阶段的常量 ───────────────────────────

/** 上报给 Urtoris 的事件类型：把 requestId 绑定到 executionId。 */
export const BINDING_EVENT_TYPE = 'execution.bound';

/** 绑定失败时的协议错误码（网站在错误码表里按它分支）。 */
export const BINDING_ERROR_CODE = 'BINDING_FAILED';

/** 三个绑定节点在 n8n 画布上的名字（同时是 connections 的 key，必须稳定）。 */
export const BINDING_HTTP_NAME = '绑定执行 (execution.bound)';
export const BINDING_CODE_NAME = '归一绑定结果';
export const BINDING_GUARD_NAME = '绑定成功?';

/** Node B 往数据里塞的两个内部字段（只在工作流内部传递，不是协议字段）。 */
export const BINDING_OK_FIELD = '__bindingOk';
export const BINDING_ERROR_FIELD = '__bindingError';

/** 闸门 IF 的判断表达式：只有 __bindingOk 为真才放行。 */
export const BINDING_GUARD_LEFT_VALUE = `={{ $json.${BINDING_OK_FIELD} }}`;

/**
 * 绑定节点 id 的命名空间前缀。
 * 形状与需求里给的稳定字面量一致（8-4-4-4-12，版本位 4、变体位 8），
 * 例如 f1a20001-0000-4000-8000-000000000011。
 */
export const BINDING_ID_PREFIX = 'f1a20001-0000-4000-8000-';

/**
 * 每个**需要前置绑定**的工作流一段固定的 id 区间（scope），段内三个槽位：
 * 1 = 上报节点，2 = 归一节点，3 = 闸门节点。
 *
 * 只有「有协议校验链、且 requestId 缺失时能不发上报就返回 VALIDATION_ERROR」的工作流
 * 才登记在这里（当前是 5 个业务工作流）。`urtoris-gateway` 刻意**不在**表里：
 * 它的链路是 `Webhook → 解析路由 → 路由有效?`，没有协议校验链，
 * 也不在站点的已注册工作流清单里，因此按 legacy 处理（见它的 meta.urtorisBinding）。
 *
 * 新增需要绑定的工作流必须在这里登记，否则 bindingNodeIds() 会直接抛错 ——
 * 宁可生成失败，也不要悄悄少一道闸门。
 */
const BINDING_ID_SCOPE = {
  'llm-smoke': 1,
  'user-manager': 2,
  'security-analysis': 3,
  'api-gateway': 4,
  'customer-insights': 5,
};

/** 该工作流绑定阶段三个节点的固定 id。 */
export function bindingNodeIds(workflowKey) {
  const scope = BINDING_ID_SCOPE[workflowKey];
  if (!scope) {
    throw new Error(
      `工作流 ${workflowKey} 没有登记绑定 id 区间：请在 tools/binding-graph.mjs 的 BINDING_ID_SCOPE 里补一段再生成`,
    );
  }
  const make = (slot) => `${BINDING_ID_PREFIX}${String(scope * 10 + slot).padStart(12, '0')}`;
  return { http: make(1), code: make(2), if: make(3), scope };
}

// ─────────────────────────── 危险节点集合 ───────────────────────────

/**
 * 「危险节点」= 会产生真实外部副作用或成本、或能触达外部系统的节点。
 * 从 Webhook 到它们的**每一条**路径都必须先穿过绑定闸门。
 *
 * 例外：协议公共设施子工作流（信封 / 日志 / 全局错误处理）不算危险节点 ——
 * 校验失败（VALIDATION_ERROR）的 false 分支本来就必须能回信封、能落日志，
 * 而它按需求**不经过**绑定闸门。把这三个也算成危险节点，
 * 「危险节点必须穿过绑定闸门」这条不变量在新拓扑下不可能成立（会恒假）。
 * 真正的危险节点是业务副作用节点：LLM / HTTP / Tool / 业务子工作流。
 */
export const PROTOCOL_INFRA_WORKFLOW_IDS = [
  'urtoris-common-envelope',
  'urtoris-common-log',
  'urtoris-global-error-handler',
];

export const DANGEROUS_NODE_TYPES = [
  '@n8n/n8n-nodes-langchain.agent',
  '@n8n/n8n-nodes-langchain.toolHttpRequest',
  'n8n-nodes-base.httpRequest',
  '@n8n/n8n-nodes-langchain.lmChatOpenAi',
  '@n8n/n8n-nodes-langchain.lmChatAnthropic',
  '@n8n/n8n-nodes-langchain.lmChatGroq',
  '@n8n/n8n-nodes-langchain.lmChatGoogleGemini',
  'n8n-nodes-base.executeWorkflow',
];

const DANGEROUS_SET = new Set(DANGEROUS_NODE_TYPES);

export function isDangerousType(type) {
  return DANGEROUS_SET.has(type);
}

/**
 * 单个节点是否危险：类型在表里，且不是协议公共设施子工作流。
 * （executeWorkflow 既可能调业务子工作流，也可能只是回信封 / 落日志，
 * 两者在图上必须区别对待，否则错误信封路径会被误判成「绕过了绑定」。）
 */
export function isDangerousNode(node) {
  if (!isDangerousType(node.type)) return false;
  if (node.type === 'n8n-nodes-base.executeWorkflow') {
    const target = node.parameters?.workflowId?.value;
    if (PROTOCOL_INFRA_WORKFLOW_IDS.includes(target)) return false;
  }
  return true;
}

// ─────────────────────────────── 图遍历 ───────────────────────────────

/** 禁用节点不参与执行，等价于不存在。 */
export function isDisabledNode(node) {
  return node?.disabled === true;
}

export function nodeByName(workflow, name) {
  return (workflow.nodes ?? []).find((n) => n.name === name) ?? null;
}

/** 工作流里唯一的 Webhook 触发节点（业务/网关工作流各一个）。 */
export function findWebhookNode(workflow) {
  return (workflow.nodes ?? []).find((n) => n.type === 'n8n-nodes-base.webhook') ?? null;
}

/** 唯一的响应出口。 */
export function findResponderNode(workflow) {
  return (
    (workflow.nodes ?? []).find((n) => n.type === 'n8n-nodes-base.respondToWebhook') ?? null
  );
}

/**
 * 绑定上报节点：type 是 httpRequest、body 里带 execution.bound 标记的那一个。
 * 刻意按「标记」而不是按名字找 —— 名字可以被改，标记改了就真的不再上报。
 */
export function findBindingReporterNode(workflow) {
  return (
    (workflow.nodes ?? []).find((n) => {
      if (n.type !== 'n8n-nodes-base.httpRequest') return false;
      const body = n.parameters?.jsonBody;
      return typeof body === 'string' && body.includes(BINDING_EVENT_TYPE);
    }) ?? null
  );
}

/** 绑定闸门节点：判断 __bindingOk 的那一个 IF。 */
export function findBindingGuardNode(workflow) {
  return (
    (workflow.nodes ?? []).find((n) => {
      if (n.type !== 'n8n-nodes-base.if') return false;
      return n.parameters?.conditions?.conditions?.[0]?.leftValue === BINDING_GUARD_LEFT_VALUE;
    }) ?? null
  );
}

/** 某节点某个输出分支上的目标节点名列表（默认只取 main）。 */
export function branchTargetNames(workflow, name, outputIndex, connectionType = 'main') {
  const branches = workflow.connections?.[name]?.[connectionType] ?? [];
  const branch = branches[outputIndex] ?? [];
  return branch.map((c) => c.node);
}

/** 某节点的全部出边目标（所有连接类型、所有分支）。 */
export function outgoingNames(workflow, name) {
  const outputs = workflow.connections?.[name] ?? {};
  const out = [];
  for (const branches of Object.values(outputs)) {
    if (!Array.isArray(branches)) continue;
    for (const branch of branches) {
      for (const connection of branch ?? []) out.push(connection.node);
    }
  }
  return out;
}

/**
 * 从若干起始节点做可达遍历，走 connections 里声明的**所有**出边
 * （main，以及 AI 子节点的 ai_* 连接类型 —— 漏掉任何一种都可能放过一条绕行路径）。
 *
 * @param {object} workflow 生成出来的工作流 JSON
 * @param {string[]} startNames 起始节点名
 * @param {{ stopAt?: Set<string> }} [options]
 *        stopAt 里的节点会被「访问到但不允许穿过」—— 正好用来表达闸门：
 *        从这里出发还能摸到的节点，就是可以绕过闸门执行的节点。
 * @returns {Set<string>} 可达节点名（含起始节点）
 */
export function reachableNodes(workflow, startNames, options = {}) {
  const stopAt = options.stopAt ?? new Set();
  const seen = new Set();
  const queue = [];
  for (const name of startNames) {
    if (!name || seen.has(name)) continue;
    seen.add(name);
    queue.push(name);
  }
  while (queue.length) {
    const current = queue.shift();
    if (stopAt.has(current)) continue; // 闸门：看得见，但过不去
    for (const next of outgoingNames(workflow, current)) {
      if (seen.has(next)) continue;
      const node = nodeByName(workflow, next);
      if (!node || isDisabledNode(node)) continue; // 禁用节点不执行
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** 工作流里所有未禁用的危险节点（协议公共设施子工作流不计入）。 */
export function dangerousNodes(workflow, options = {}) {
  const exclude = options.exclude ?? new Set();
  return (workflow.nodes ?? []).filter(
    (n) => isDangerousNode(n) && !isDisabledNode(n) && !exclude.has(n.name),
  );
}

/** 指向某节点的所有上游节点名（所有连接类型、所有分支；禁用节点不算）。 */
export function inboundNames(workflow, target) {
  const out = [];
  for (const node of workflow.nodes ?? []) {
    if (isDisabledNode(node)) continue;
    if (outgoingNames(workflow, node.name).includes(target)) out.push(node.name);
  }
  return out;
}

/**
 * 校验闸门 = 唯一一个「true 分支直连绑定上报节点」的 IF。
 *
 * 新拓扑下 Webhook 不再直连上报节点，所以「闸门紧跟 Webhook」这种校验已经作废：
 * 现在要守的是「上报节点一定挂在一个请求校验闸门的 true 分支之后」。
 * 这个 IF 就是 requestId 有效性与绑定上报之间的分界线。
 */
export function findValidityGateNode(workflow) {
  return (
    (workflow.nodes ?? []).find(
      (n) =>
        n.type === 'n8n-nodes-base.if' &&
        !isDisabledNode(n) &&
        branchTargetNames(workflow, n.name, 0).includes(BINDING_HTTP_NAME),
    ) ?? null
  );
}

/**
 * 校验闸门上游唯一的解析节点（`校验请求` / `解析路由`）：
 * 它保证 requestId 存在（否则返回 VALIDATION_ERROR）并给出 payload，
 * 是绑定上报两个关键字段（$json.requestId / $json.payload.workflowId）的唯一来源。
 */
export function findValidityParserNode(workflow, gate) {
  if (!gate) return null;
  const feeders = inboundNames(workflow, gate.name);
  if (feeders.length !== 1) return null;
  return nodeByName(workflow, feeders[0]);
}

/**
 * 前置执行绑定的**结构不变量**校验。
 *
 * 由 validate-workflows.mjs（导入前把关）与 test-execution-binding.mjs（回归）
 * 共用同一份实现 —— 两边各写一套的话，改一处漏一处就会出现
 * 「校验通过、线上不生效」。
 *
 * @param {object} workflow 生成出来的工作流 JSON
 * @returns {string[]} 问题列表；空数组 = 结构正确
 */
export function bindingTopologyProblems(workflow) {
  const problems = [];
  const hook = findWebhookNode(workflow);
  if (!hook) return ['业务/网关工作流没有 Webhook，无法校验前置执行绑定'];

  const reporter = findBindingReporterNode(workflow);
  const normalize = nodeByName(workflow, BINDING_CODE_NAME);
  const guard = findBindingGuardNode(workflow);
  const responder = findResponderNode(workflow);

  if (!guard) {
    problems.push(`缺少绑定闸门「${BINDING_GUARD_NAME}」：危险节点可能在 executionId 未绑定时执行`);
  }
  if (!reporter) {
    problems.push(`缺少绑定上报节点「${BINDING_HTTP_NAME}」（POST ${BINDING_EVENT_TYPE}）：闸门没有数据来源`);
  }
  if (!responder) problems.push('缺少 Respond to Webhook：绑定失败分支无处可去');
  if (!guard || !reporter || !responder) return problems;

  // ── 1. 顺序：Webhook → 校验请求(code) → 请求合法?(if) → 绑定上报 ──
  const gate = findValidityGateNode(workflow);
  const parser = findValidityParserNode(workflow, gate);
  if (!gate) {
    problems.push(
      `没有任何 IF 的 true 分支连到「${BINDING_HTTP_NAME}」：绑定上报不在请求校验闸门之后`,
    );
  } else {
    if (gate.name === guard.name) {
      problems.push(`「${BINDING_HTTP_NAME}」的上游是绑定闸门自己：上报与放行判断串成了环`);
    }
    if (!parser) {
      problems.push(`校验闸门「${gate.name}」的入边不唯一：requestId / payload 的来源不明确`);
    } else {
      const hookTargets = branchTargetNames(workflow, hook.name, 0);
      if (hookTargets.length !== 1 || hookTargets[0] !== parser.name) {
        problems.push(
          `Webhook 的第一个下游必须是校验解析节点「${parser.name}」，实际：${hookTargets.join('、') || '（空）'}`,
        );
      }
      const parserTargets = branchTargetNames(workflow, parser.name, 0);
      if (parserTargets.length !== 1 || parserTargets[0] !== gate.name) {
        problems.push(
          `校验解析节点「${parser.name}」之后必须是校验闸门「${gate.name}」，实际：${parserTargets.join('、') || '（空）'}`,
        );
      }
      const gateTrue = branchTargetNames(workflow, gate.name, 0);
      if (gateTrue.length !== 1 || gateTrue[0] !== BINDING_HTTP_NAME) {
        problems.push(
          `校验闸门「${gate.name}」的 true 分支必须唯一指向「${BINDING_HTTP_NAME}」，实际：${gateTrue.join('、') || '（空）'}`,
        );
      }
      // 静态证据：requestId 的存在性判断必须由这个解析节点完成（缺失 → VALIDATION_ERROR）。
      // 这样「未来把绑定挪回校验之前」会立刻在本地炸掉，而不是发到线上才发现。
      const src = typeof parser.parameters?.jsCode === 'string' ? parser.parameters.jsCode : '';
      if (!/requestId/.test(src)) {
        problems.push(`校验节点「${parser.name}」不再校验/输出 requestId：绑定上报拿不到 requestId`);
      }
      if (!/payload\s*:/.test(src)) {
        problems.push(`校验节点「${parser.name}」不再输出 payload：绑定上报拿不到 payload.workflowId`);
      }
      if (!/VALIDATION_ERROR/.test(src)) {
        problems.push(
          `校验节点「${parser.name}」里没有 VALIDATION_ERROR：requestId 缺失时无法在绑定之前拦下`,
        );
      }
    }
    // 从 Webhook 出发、不穿过校验闸门，绝不允许摸到绑定上报节点。
    const beforeGate = reachableNodes(workflow, [hook.name], { stopAt: new Set([gate.name]) });
    if (beforeGate.has(BINDING_HTTP_NAME)) {
      problems.push(
        `「${BINDING_HTTP_NAME}」在校验闸门「${gate.name}」之前就能到达：requestId 缺失时会先调用站点 /api/n8n/events`,
      );
    }
  }

  // ── 2. 上报 → 归一 → 绑定闸门 必须首尾相连 ──
  if (!normalize) {
    problems.push(`缺少绑定归一节点「${BINDING_CODE_NAME}」`);
  } else {
    const hop1 = branchTargetNames(workflow, BINDING_HTTP_NAME, 0);
    if (hop1.length !== 1 || hop1[0] !== BINDING_CODE_NAME) {
      problems.push(`「${BINDING_HTTP_NAME}」之后必须是「${BINDING_CODE_NAME}」，实际：${hop1.join('、') || '（空）'}`);
    }
    const hop2 = branchTargetNames(workflow, BINDING_CODE_NAME, 0);
    if (hop2.length !== 1 || hop2[0] !== guard.name) {
      problems.push(`「${BINDING_CODE_NAME}」之后必须是闸门「${guard.name}」，实际：${hop2.join('、') || '（空）'}`);
    }
  }

  // ── 3. 屏障：从 Webhook 出发、把绑定闸门当成穿不过的壁垒，摸不到任何危险节点 ──
  // 上报节点自身也是 httpRequest，但它就是闸门的上游，必须排除（否则这条检查会自我否证）。
  const withoutGuard = reachableNodes(workflow, [hook.name], { stopAt: new Set([guard.name]) });
  for (const node of dangerousNodes(workflow, { exclude: new Set([reporter.name]) })) {
    if (withoutGuard.has(node.name)) {
      problems.push(
        `危险节点「${node.name}」(${node.type}) 可以绕过绑定闸门「${guard.name}」直达：webhook → … → 该节点`,
      );
    }
  }

  // ── 4. 绑定成功后的第一个节点必须**只**由闸门喂入 ──
  // 只要它还有第二条入边，就存在一条「不经过绑定上报」的到达路径。
  const passTargets = branchTargetNames(workflow, guard.name, 0);
  if (passTargets.length === 0) {
    problems.push(`绑定闸门「${guard.name}」的 true 分支没有连到任何节点：绑定成功也进不了业务节点`);
  }
  if (passTargets.includes(responder.name)) {
    problems.push(`绑定闸门「${guard.name}」的 true 分支连到了「${responder.name}」：绑定成功反而直接返回`);
  }
  for (const target of passTargets) {
    const feeders = inboundNames(workflow, target);
    if (feeders.length !== 1 || feeders[0] !== guard.name) {
      const others = feeders.filter((f) => f !== guard.name);
      problems.push(
        `绑定闸门「${guard.name}」的 true 分支指向「${target}」，但该节点还有其它入边（${others.join('、') || '多路'}）：存在绕过绑定阶段的路径`,
      );
    }
  }

  // ── 5. false 分支：必须止于 Respond，且不得触及任何危险节点 ──
  // 同样把闸门当成壁垒 —— false 分支绕回闸门自己就说明接线错了（它会重新走一遍 true 分支）。
  const falseTargets = branchTargetNames(workflow, guard.name, 1);
  if (falseTargets.length === 0) {
    problems.push(`绑定闸门「${guard.name}」的 false 分支没有连到任何节点：绑定失败会静默返回空响应`);
  }
  const failedPath = reachableNodes(workflow, falseTargets, { stopAt: new Set([guard.name]) });
  if (falseTargets.length > 0 && !failedPath.has(responder.name)) {
    problems.push(
      `绑定闸门的 false 分支必须终止于「${responder.name}」，实际到达：${[...failedPath].join('、')}`,
    );
  }
  for (const node of dangerousNodes(workflow)) {
    if (failedPath.has(node.name)) {
      problems.push(
        `绑定失败的 false 分支居然能到达危险节点「${node.name}」(${node.type})：fail-closed 被破坏`,
      );
    }
  }

  // ── 6. 上报 body：requestId 直接取校验结果；workflowId 取 payload（站点侧 id）──
  const body = reporter.parameters?.jsonBody;
  if (typeof body !== 'string') {
    problems.push(`「${BINDING_HTTP_NAME}」的 jsonBody 必须是字符串表达式`);
  } else {
    if (!body.includes('$json.requestId')) {
      problems.push(
        `「${BINDING_HTTP_NAME}」的 requestId 必须直接取 $json.requestId（校验节点已保证它有值且非空）`,
      );
    }
    if (body.includes("'unknown'") || body.includes('"unknown"')) {
      problems.push(
        `「${BINDING_HTTP_NAME}」的 body 里还留着 'unknown' 兜底：会用脏 requestId 污染绑定表`,
      );
    }
    if (!body.includes('$json.payload.workflowId')) {
      problems.push(
        `「${BINDING_HTTP_NAME}」的 workflowId 必须取 $json.payload.workflowId（站点侧的工作流 id）`,
      );
    }
    if (/workflowId\s*:\s*'/.test(body)) {
      problems.push(
        `「${BINDING_HTTP_NAME}」的 workflowId 被写死成了字面量：站点侧 id 只能按请求传，否则与 n8n_execution_map 里的其它事件不在同一个 id 命名空间`,
      );
    }
  }

  return problems;
}
