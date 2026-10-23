#!/usr/bin/env node
/**
 * 前置执行绑定（pre-node deterministic execution binding）回归测试。
 *
 * 守护的是这条不变量：**requestId 先校验通过、再绑定 requestId ↔ executionId，
 * 然后才允许进入危险节点；上报失败就绝不进入危险节点。**
 *
 * 适用范围：恰好 5 个业务工作流（llm-smoke / user-manager / security-analysis /
 * api-gateway / customer-insights）。`urtoris-gateway` 按 **legacy** 处理 ——
 * 它只是转发器，真正执行业务的是目标工作流自己那次执行，给网关绑 executionId 会让
 * runs.execution_id 指向调度器执行；它也没有协议校验链。这里显式断言网关**没有**绑定阶段。
 *
 * 断言分组：
 *   1. 每个 business 工作流都有完整的绑定阶段（上报 → 归一 → 闸门）
 *   1b. 网关必须是 legacy（零绑定节点、Webhook 直连解析路由）
 *   2. **顺序**：绑定阶段挂在「请求合法?」的 true 分支之后，
 *      不存在任何「不经过校验闸门就能到达上报节点」的路径
 *   3. execution.bound 先于任何危险节点（图上绕不过绑定闸门）
 *   4. 绑定失败不会执行危险节点（false 分支止于 Respond，且摸不到危险节点）
 *   5. 上报 body 的五个字段、目标地址、凭证、neverError 都符合约定，
 *      且 requestId 没有 'unknown' 兜底、workflowId 没有写死 n8n 侧 id
 *   6. 归一节点的运行期行为：成功透传校验结果，失败给出 BINDING_FAILED 信封
 *   7. 生成结果确定（连续生成两次逐字节一致）
 *   8. legacy 工作流仍被正确标记（meta.urtorisBinding），且数量与结构一致
 *   9. 既有回归仍然通过（test-node-versions 的 19 条断言 + validate-workflows）
 *
 * 用法：node tools/test-execution-binding.mjs
 * 退出码非 0 表示回归。CI / 部署前都可以跑。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BINDING_CODE_NAME,
  BINDING_ERROR_CODE,
  BINDING_ERROR_FIELD,
  BINDING_EVENT_TYPE,
  BINDING_GUARD_NAME,
  BINDING_HTTP_NAME,
  BINDING_ID_PREFIX,
  BINDING_OK_FIELD,
  bindingTopologyProblems,
  branchTargetNames,
  dangerousNodes,
  findBindingGuardNode,
  findBindingReporterNode,
  findResponderNode,
  findValidityGateNode,
  findValidityParserNode,
  findWebhookNode,
  inboundNames,
  reachableNodes,
} from './binding-graph.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GEN = join(ROOT, 'generated');

const failures = [];
let assertions = 0;

function check(label, fn) {
  assertions += 1;
  try {
    fn();
    console.log(`  ✔ ${label}`);
  } catch (cause) {
    failures.push(`${label}：${cause.message}`);
    console.log(`  ✖ ${label}\n      ${cause.message}`);
  }
}

function generatedWorkflows() {
  return readdirSync(GEN)
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json' && f !== 'all-workflows.json')
    .sort()
    .map((f) => ({ file: f, doc: JSON.parse(readFileSync(join(GEN, f), 'utf8')) }));
}

function generatedHashes() {
  return readdirSync(GEN)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      file: f,
      sha256: createHash('sha256').update(readFileSync(join(GEN, f))).digest('hex'),
    }));
}

function nodeFingerprint() {
  return generatedWorkflows().map(({ file, doc }) => ({
    file,
    nodes: (doc.nodes ?? []).map((n) => `${n.id}|${n.name}|${n.type}|${n.typeVersion}`),
  }));
}

function build() {
  execFileSync(process.execPath, [join(HERE, 'build-workflows.mjs')], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

/** 绑定阶段的三个节点 + 它上游的校验闸门/解析节点（新拓扑）。 */
function bindingChain(workflow) {
  const hook = findWebhookNode(workflow);
  const reporter = findBindingReporterNode(workflow);
  const guard = findBindingGuardNode(workflow);
  const normalize = (workflow.nodes ?? []).find((n) => n.name === BINDING_CODE_NAME) ?? null;
  const gate = findValidityGateNode(workflow);
  const parser = findValidityParserNode(workflow, gate);
  return { hook, reporter, normalize, guard, gate, parser };
}

const PREBOUND = () => generatedWorkflows().filter((w) => w.doc.meta?.urtorisBinding === 'prebound');

/** 需要绑定的工作流 = 有完整协议校验链的业务工作流（网关按 legacy，不在内）。 */
const BOUND_WORKFLOWS = () =>
  generatedWorkflows().filter((w) => w.doc.meta?.urtorisRole === 'business');

/** 网关：刻意不做前置执行绑定。 */
const GATEWAY = () => generatedWorkflows().find((w) => w.doc.id === 'urtoris-gateway') ?? null;

console.log('前置执行绑定回归测试（Webhook → 校验请求 → 请求合法? → 绑定闸门 → 危险节点）\n');

// 先重新生成：保证下面断言的是**当前生成器**的产物，而不是上一次残留的 generated/。
build();

const workflows = generatedWorkflows();
const manifest = JSON.parse(readFileSync(join(GEN, 'manifest.json'), 'utf8'));
const eventsUrl = manifest.containers?.eventsUrl;

console.log('1) 每个业务工作流都有完整的绑定阶段（校验闸门之后）');
check('恰好 5 个 business 工作流 prebound，且没有多出来的', () => {
  const prebound = PREBOUND();
  assert.equal(prebound.length, 5, `prebound 工作流应为 5 个，实际 ${prebound.length}`);
  const business = BOUND_WORKFLOWS();
  assert.equal(
    prebound.length,
    business.length,
    '每个 business 工作流都必须 prebound，不允许漏掉；也不允许 business 之外的工作流 prebound',
  );
  assert.deepEqual(
    prebound.map((w) => w.doc.id).sort(),
    [
      'urtoris-wf-api-gateway',
      'urtoris-wf-customer-insights',
      'urtoris-wf-llm-smoke',
      'urtoris-wf-security-analysis',
      'urtoris-wf-user-manager',
    ],
    'prebound 清单不对',
  );
});
for (const { file, doc } of BOUND_WORKFLOWS()) {
  check(`${file}：校验闸门 → 上报 → 归一 → 绑定闸门 首尾相连`, () => {
    const { hook, reporter, normalize, guard, gate, parser } = bindingChain(doc);
    assert.ok(hook, '缺少 Webhook');
    assert.ok(reporter, `缺少上报节点「${BINDING_HTTP_NAME}」`);
    assert.ok(normalize, `缺少归一节点「${BINDING_CODE_NAME}」`);
    assert.ok(guard, `缺少闸门节点「${BINDING_GUARD_NAME}」`);
    assert.ok(gate, `没有任何 IF 的 true 分支连到「${BINDING_HTTP_NAME}」`);
    assert.ok(parser, `校验闸门「${gate.name}」的入边不唯一，找不到解析节点`);
    assert.notEqual(parser.name, 'Webhook', 'Webhook 不能直接充当校验解析节点');
    assert.deepEqual(
      branchTargetNames(doc, hook.name, 0),
      [parser.name],
      `Webhook 的下游必须是校验解析节点「${parser.name}」`,
    );
    assert.deepEqual(
      branchTargetNames(doc, parser.name, 0),
      [gate.name],
      `解析节点「${parser.name}」之后必须是校验闸门「${gate.name}」`,
    );
    assert.deepEqual(
      branchTargetNames(doc, gate.name, 0),
      [BINDING_HTTP_NAME],
      `校验闸门「${gate.name}」的 true 分支必须是上报节点`,
    );
    assert.deepEqual(branchTargetNames(doc, BINDING_HTTP_NAME, 0), [BINDING_CODE_NAME], '上报节点之后必须是归一节点');
    assert.deepEqual(branchTargetNames(doc, BINDING_CODE_NAME, 0), [BINDING_GUARD_NAME], '归一节点之后必须是绑定闸门');
  });
  check(`${file}：共享结构不变量（validator 与 test 同一份）零问题`, () => {
    const problems = bindingTopologyProblems(doc);
    assert.deepEqual(problems, [], `bindingTopologyProblems 报出问题：\n      ${problems.join('\n      ')}`);
  });
  check(`${file}：绑定节点用固定 id，不占用递增序号`, () => {
    const { reporter, normalize, guard } = bindingChain(doc);
    const ids = [reporter.id, normalize.id, guard.id];
    for (const id of ids) {
      assert.ok(id.startsWith(BINDING_ID_PREFIX), `绑定节点 id 必须以 ${BINDING_ID_PREFIX} 开头，实际 ${id}`);
      assert.match(id.slice(BINDING_ID_PREFIX.length), /^\d{12}$/, `id 尾段应是 12 位数字：${id}`);
    }
    assert.equal(new Set(ids).size, 3, `同一条链上的绑定 id 不能重复：${ids.join('、')}`);
    assert.equal(new Set((doc.nodes ?? []).map((n) => n.id)).size, doc.nodes.length, '工作流内 node id 必须唯一');
  });
}

console.log('\n1b) 网关是 legacy：零绑定节点，Webhook 直连解析路由');
check('urtoris-gateway：没有绑定节点，meta.urtorisBinding=legacy，Webhook → 解析路由', () => {
  const gateway = GATEWAY();
  assert.ok(gateway, 'generated/ 里缺少 urtoris-gateway.json');
  const doc = gateway.doc;
  for (const name of [BINDING_HTTP_NAME, BINDING_CODE_NAME, BINDING_GUARD_NAME]) {
    assert.equal(
      (doc.nodes ?? []).some((n) => n.name === name),
      false,
      `网关不允许出现绑定节点「${name}」：它只是转发器，绑 executionId 会指向调度器执行`,
    );
  }
  assert.equal(doc.meta?.urtorisBinding, 'legacy', '网关必须按 legacy 处理');
  assert.equal(findBindingGuardNode(doc), null, '网关不允许有绑定闸门');
  assert.equal(findBindingReporterNode(doc), null, '网关不允许有绑定上报节点');
  assert.equal(findValidityGateNode(doc), null, '网关不允许有绑定阶段上游的校验闸门');
  assert.equal(
    (doc.nodes ?? []).some((n) => String(n.id).startsWith(BINDING_ID_PREFIX)),
    false,
    '网关不允许占用绑定节点 id 段（BINDING_ID_SCOPE 里已经没有 gateway）',
  );
  const hook = findWebhookNode(doc);
  assert.ok(hook, '网关缺少 Webhook');
  assert.deepEqual(
    branchTargetNames(doc, hook.name, 0),
    ['解析路由'],
    '网关 Webhook 必须直连「解析路由」（不得插进绑定阶段）',
  );
  assert.deepEqual(
    branchTargetNames(doc, '路由有效?', 0),
    ['转发到目标工作流'],
    '网关「路由有效?」的 true 分支必须直接转发，不得经过绑定上报',
  );
  const inManifest = manifest.workflows.find((w) => w.id === doc.id);
  assert.equal(inManifest?.binding, 'legacy', 'manifest 里网关的 binding 必须是 legacy');
});
check('urtoris-gateway：短 workflowId 转发前必须改写为站点 workflowId', () => {
  const gateway = GATEWAY();
  assert.ok(gateway, 'generated/ 里缺少 urtoris-gateway.json');
  const parser = gateway.doc.nodes.find((node) => node.name === '解析路由');
  assert.ok(parser, '网关缺少「解析路由」');
  const execute = new Function('$input', '$execution', parser.parameters.jsCode);
  const result = execute(
    {
      first: () => ({
        json: {
          body: {
            protocol: 'urtoris.v1',
            requestId: 'req_gateway_route',
            workflowId: 'customer-insights',
            sessionId: 'sess_gateway_route',
            message: 'test',
          },
        },
      }),
    },
    { id: 'exec-gateway' },
  ).json;
  assert.equal(result.target, 'customer-insights');
  assert.equal(result.payload.workflowId, 'wf_n8n_customer_insights');
  assert.equal(result.payload.requestId, 'req_gateway_route', '除 workflowId 外必须保留原请求');
});
check('urtoris-gateway：转发的成功与连接错误端口都进入统一响应归一节点', () => {
  const gateway = GATEWAY();
  assert.ok(gateway, 'generated/ 里缺少 urtoris-gateway.json');
  const doc = gateway.doc;
  const forward = doc.nodes.find((node) => node.name === '转发到目标工作流');
  assert.ok(forward, '网关缺少转发节点');
  assert.equal(forward.onError, 'continueErrorOutput');
  assert.equal(forward.alwaysOutputData, true);
  assert.deepEqual(branchTargetNames(doc, forward.name, 0), ['透传子工作流信封']);
  assert.deepEqual(branchTargetNames(doc, forward.name, 1), ['透传子工作流信封']);
});

console.log('\n2) 顺序：绑定上报严格位于 requestId 校验之后');
for (const { file, doc } of BOUND_WORKFLOWS()) {
  check(`${file}：不经过校验闸门就摸不到上报节点`, () => {
    const { hook, gate, reporter } = bindingChain(doc);
    const beforeGate = reachableNodes(doc, [hook.name], { stopAt: new Set([gate.name]) });
    assert.equal(
      beforeGate.has(reporter.name),
      false,
      `「${reporter.name}」能在校验闸门「${gate.name}」之前到达：requestId 缺失时会先调用站点 ${eventsUrl}`,
    );
    assert.deepEqual(
      inboundNames(doc, reporter.name),
      [gate.name],
      `上报节点的唯一入边必须是校验闸门「${gate.name}」`,
    );
  });
  check(`${file}：校验节点保证 requestId 存在且给出 payload（VAL 在 BIND 之前）`, () => {
    const { parser } = bindingChain(doc);
    const src = String(parser.parameters?.jsCode ?? '');
    assert.match(src, /requestId/, `解析节点「${parser.name}」不再处理 requestId`);
    assert.match(src, /payload\s*:/, `解析节点「${parser.name}」不再输出 payload`);
    assert.match(src, /VALIDATION_ERROR/, `解析节点「${parser.name}」不再产出 VALIDATION_ERROR`);
  });
}

console.log('\n3) execution.bound 先于任何危险节点');
for (const { file, doc } of BOUND_WORKFLOWS()) {
  check(`${file}：绕过闸门的路径摸不到任何危险节点`, () => {
    const { hook, reporter, guard } = bindingChain(doc);
    const dangerous = dangerousNodes(doc, { exclude: new Set([reporter.name]) });
    assert.ok(dangerous.length > 0, '该工作流没有危险节点，断言会变成空转');
    const bypass = reachableNodes(doc, [hook.name], { stopAt: new Set([guard.name]) });
    const leaked = dangerous.filter((n) => bypass.has(n.name)).map((n) => `${n.name}(${n.type})`);
    assert.deepEqual(leaked, [], `这些危险节点可以绕过闸门：${leaked.join('、')}`);
    // 绑定成功后的第一个节点必须只由闸门喂入，否则存在不绑定就能到达它的路径
    for (const target of branchTargetNames(doc, guard.name, 0)) {
      assert.deepEqual(
        inboundNames(doc, target),
        [guard.name],
        `「${target}」除了绑定闸门还有别的入边，可以不经过绑定阶段到达`,
      );
    }
  });
}

console.log('\n4) 绑定失败不会执行危险节点');
for (const { file, doc } of BOUND_WORKFLOWS()) {
  check(`${file}：false 分支止于 Respond，且碰不到危险节点`, () => {
    const { guard } = bindingChain(doc);
    const responder = findResponderNode(doc);
    assert.ok(responder, '缺少 Respond to Webhook');
    const falseTargets = branchTargetNames(doc, guard.name, 1);
    assert.deepEqual(falseTargets, [responder.name], 'false 分支必须且只能连到 Respond to Webhook');
    const failedPath = reachableNodes(doc, falseTargets, { stopAt: new Set([guard.name]) });
    assert.ok(failedPath.has(responder.name), `false 分支到不了 Respond，实际到达：${[...failedPath].join('、')}`);
    assert.deepEqual(
      [...failedPath].filter((name) => name !== responder.name),
      [],
      `false 分支必须止于 Respond，却还经过：${[...failedPath].filter((n) => n !== responder.name).join('、')}`,
    );
    const leaked = dangerousNodes(doc)
      .filter((n) => failedPath.has(n.name))
      .map((n) => `${n.name}(${n.type})`);
    assert.deepEqual(leaked, [], `fail-closed 被破坏，失败分支能到：${leaked.join('、')}`);
  });
}

console.log('\n5) 上报 body 与节点参数');
check('事件地址与 manifest 声明的 eventsUrl 一致', () => {
  assert.ok(eventsUrl, 'manifest.containers.eventsUrl 缺失');
});
for (const { file, doc } of BOUND_WORKFLOWS()) {
  check(`${file}：body 含五个约定字段，且凭证/neverError 配置正确`, () => {
    const { hook, reporter } = bindingChain(doc);
    const body = reporter.parameters.jsonBody;
    assert.equal(typeof body, 'string', 'jsonBody 必须是字符串表达式');
    for (const field of ['requestId', 'executionId', 'workflowId', 'triggerNodeId', 'eventType']) {
      assert.ok(body.includes(field), `body 缺少字段 ${field}`);
    }
    assert.ok(body.includes(BINDING_EVENT_TYPE), `body 缺少事件类型 ${BINDING_EVENT_TYPE}`);
    assert.equal(reporter.parameters.method, 'POST', '必须是 POST');
    assert.equal(reporter.parameters.url, eventsUrl, `目标地址应为 ${eventsUrl}`);
    assert.equal(reporter.parameters.authentication, 'genericCredentialType', '必须走通用凭证');
    assert.equal(reporter.parameters.genericAuthType, 'httpHeaderAuth', '凭证类型应为 httpHeaderAuth');
    assert.ok(
      reporter.credentials?.httpHeaderAuth?.id,
      '必须挂上 Header Auth 凭证（与其他回传调用同一套）',
    );
    assert.equal(
      reporter.credentials?.httpHeaderAuth?.id,
      manifest.containers?.internalCredentialId,
      '必须使用 manifest 声明的内部回传凭证',
    );
    const response = reporter.parameters.options?.response?.response;
    assert.equal(response?.neverError, true, '必须 neverError，非 2xx 不能抛');
    assert.equal(response?.fullResponse, true, '必须 fullResponse，否则读不到状态码和 body');
    assert.equal(reporter.onError, 'continueRegularOutput', '连接层失败也必须继续，不能中断执行');
    assert.equal(reporter.alwaysOutputData, true, '必须 alwaysOutputData，保证闸门总能拿到一项数据');
    assert.equal(reporter.typeVersion, 4.2, 'httpRequest 固定 4.2');
    // triggerNodeId 必须真的是本工作流 Webhook 的 id，写错就永远绑不上
    assert.ok(body.includes(`triggerNodeId: '${hook.id}'`), `triggerNodeId 必须等于 webhook 节点 id ${hook.id}`);
  });
  check(`${file}：requestId 不兜底、workflowId 取站点侧 id（Defect 1/2 不复发）`, () => {
    const { reporter } = bindingChain(doc);
    const body = reporter.parameters.jsonBody;
    assert.ok(body.includes('requestId: $json.requestId'), 'requestId 必须直接取 $json.requestId（校验结果）');
    assert.equal(body.includes("'unknown'"), false, "body 里不允许有 'unknown' 兜底值");
    assert.equal(
      body.includes('$json.body.requestId'),
      false,
      'requestId 不应再去 Webhook 原始 body 里取（此时 $json 已是校验结果）',
    );
    assert.ok(body.includes('workflowId: $json.payload.workflowId'), 'workflowId 必须取 $json.payload.workflowId');
    assert.equal(/workflowId\s*:\s*'/.test(body), false, 'workflowId 不允许写死成字面量');
    for (const hardcoded of ['urtoris-wf-', 'urtoris-gateway']) {
      assert.equal(body.includes(hardcoded), false, `body 里不允许出现写死的 n8n 侧工作流 id：${hardcoded}`);
    }
  });
  check(`${file}：归一/闸门节点的类型与版本`, () => {
    const { normalize, guard } = bindingChain(doc);
    assert.equal(normalize.type, 'n8n-nodes-base.code');
    assert.equal(normalize.typeVersion, 2);
    assert.equal(normalize.parameters.language, 'javaScript', 'language 必须是 javaScript（大写 S）');
    assert.equal(guard.type, 'n8n-nodes-base.if');
    assert.equal(guard.typeVersion, 2.2);
    assert.equal(guard.parameters.conditions.options.version, 2, 'IF 2.2 必须配 options.version=2');
    assert.equal(
      guard.parameters.conditions.conditions[0].leftValue,
      `={{ $json.${BINDING_OK_FIELD} }}`,
      '闸门条件必须是 __bindingOk',
    );
  });
}

console.log('\n5b) 归一节点从校验结果（而不是 Webhook 原始 item）取数据');
for (const { file, doc } of BOUND_WORKFLOWS()) {
  check(`${file}：归一节点引用校验解析节点`, () => {
    const { normalize, parser } = bindingChain(doc);
    const src = normalize.parameters.jsCode;
    assert.ok(src.includes(`$('${parser.name}')`), `归一节点必须从「${parser.name}」取校验结果`);
    assert.equal(src.includes("$('Webhook')"), false, '归一节点不应再直接读 Webhook 原始 item');
  });
}

console.log('\n6) 归一节点的运行期行为');
/** 校验节点的成功输出形状（business 与 gateway 的字段都覆盖）。 */
function validatedItem() {
  return {
    ok: true,
    requestId: 'req-1',
    sessionId: 'sess-1',
    workflow: 'llm-smoke',
    startedAt: 1,
    executionId: '413',
    payload: { protocol: 'urtoris.v1', requestId: 'req-1', sessionId: 'sess-1', message: '你好' },
  };
}

/** 五种站点响应形态（成功 + 四种失败），逐个断言归一结果。 */
const SITE_RESPONSES = [
  { label: '站点 ok:true/bound:true（HTTP 200）', raw: { body: { ok: true, bound: true }, headers: {}, statusCode: 200 }, expectPass: true },
  { label: '站点 ok:false（HTTP 200）', raw: { body: { ok: false, error: 'unknown execution' }, headers: {}, statusCode: 200 }, expectPass: false },
  { label: '站点非 2xx（HTTP 503）', raw: { body: { ok: false, error: 'db down' }, headers: {}, statusCode: 503 }, expectPass: false },
  { label: '连接层失败（ECONNREFUSED）', raw: { error: { message: 'connect ECONNREFUSED 127.0.0.1:3000' } }, expectPass: false },
  { label: '空 item（什么都没回来）', raw: {}, expectPass: false },
];

for (const { file, doc } of BOUND_WORKFLOWS()) {
  check(`${file}：成功透传校验结果；失败给出完整 BINDING_FAILED 信封`, () => {
    const { normalize } = bindingChain(doc);
    const run = (raw, sourceItem) =>
      new Function(
        '$input',
        '$json',
        '$execution',
        '$env',
        '$',
        normalize.parameters.jsCode,
      )(
        { first: () => ({ json: raw }) },
        {},
        { id: 413 },
        {},
        () => ({ first: () => ({ json: sourceItem }) }),
      ).json;

    const sourceItem = validatedItem();
    for (const { label, raw, expectPass } of SITE_RESPONSES) {
      const out = run(raw, sourceItem);
      if (expectPass) {
        assert.equal(out[BINDING_OK_FIELD], true, `${label}：__bindingOk 应为 true`);
        assert.equal(out[BINDING_ERROR_FIELD], null, `${label}：__bindingError 应为 null`);
        assert.equal(out.requestId, 'req-1', `${label}：requestId 必须原样保留`);
        assert.deepEqual(out.payload, sourceItem.payload, `${label}：payload 必须原样保留（下游业务节点依赖它）`);
        continue;
      }
      assert.equal(out[BINDING_OK_FIELD], false, `${label}：必须判为绑定失败`);
      assert.equal(out.protocol, 'urtoris.v1', `${label}：失败也必须是 v1 信封`);
      assert.equal(out.success, false, `${label}：fail 信封 success 必须为 false`);
      assert.equal(out.data, null, `${label}：fail 信封 data 必须为 null`);
      assert.equal(out.error?.code, BINDING_ERROR_CODE, `${label}：error.code 必须是 ${BINDING_ERROR_CODE}`);
      assert.equal(out.error?.retryable, true, `${label}：绑定失败可重试`);
      assert.equal(out.requestId, 'req-1', `${label}：requestId 必须从校验结果取到`);
      assert.equal(out.meta?.executionId, '413', `${label}：meta.executionId 必须是本次执行`);
      assert.equal(out.meta?.sessionId, 'sess-1', `${label}：meta.sessionId 必须保留`);
      assert.equal(typeof out.workflow, 'string', `${label}：workflow 字段必须是本工作流标识`);
      assert.ok(out.workflow.length > 0, `${label}：workflow 字段不能为空`);
    }

    // 兼容老形状：Webhook 原始 item 直接进来时（body 形态）也要能取到 requestId
    const legacyShape = run({}, { headers: { 'x-urtoris-request-id': 'hdr-only' }, body: { sessionId: 's' } });
    assert.equal(legacyShape[BINDING_OK_FIELD], false, '兼容形状也必须判为绑定失败');
    assert.equal(legacyShape.requestId, 'hdr-only', 'requestId 应回退到 x-urtoris-request-id 头');
  });
}

console.log('\n7) 生成结果确定性');
check('连续生成两次，generated/*.json 逐字节一致', () => {
  build();
  const first = generatedHashes();
  const firstNodes = nodeFingerprint();
  build();
  const second = generatedHashes();
  const secondNodes = nodeFingerprint();
  assert.ok(first.length > 0, 'generated/ 是空的');
  assert.deepEqual(second, first, '两次生成的产物不一致：存在非确定性（时间戳 / 随机 id / 顺序漂移）');
  assert.deepEqual(secondNodes, firstNodes, '两次生成的节点 id/name/type 不一致');
});

console.log('\n8) legacy 工作流标记');
check('没有闸门的工作流一律 meta.urtorisBinding = legacy', () => {
  for (const { file, doc } of workflows) {
    const hasGuard = Boolean(findBindingGuardNode(doc));
    const declared = doc.meta?.urtorisBinding;
    assert.ok(['prebound', 'legacy'].includes(declared), `${file} 的 meta.urtorisBinding 非法：${declared}`);
    assert.equal(declared, hasGuard ? 'prebound' : 'legacy', `${file} 的标记与实际结构不符`);
    const inManifest = manifest.workflows.find((w) => w.id === doc.id);
    assert.equal(inManifest?.binding, declared, `${file} 在 manifest 里的 binding 与 meta 不一致`);
  }
});
check('全局计数：11 个工作流 = 5 prebound + 6 legacy', () => {
  const prebound = PREBOUND().map((w) => w.doc.id);
  const legacy = workflows
    .filter((w) => w.doc.meta?.urtorisBinding === 'legacy')
    .map((w) => w.doc.id)
    .sort();
  // 4 个 common-* + 全局错误处理 + 网关 = 6 个 legacy（网关刻意不做前置绑定）
  assert.deepEqual(
    legacy,
    [
      'urtoris-common-auth',
      'urtoris-common-envelope',
      'urtoris-common-llm',
      'urtoris-common-log',
      'urtoris-gateway',
      'urtoris-global-error-handler',
    ],
    `legacy 清单不对：${legacy.join('、')}`,
  );
  assert.equal(prebound.length, 5, `prebound 应恰好 5 个，实际 ${prebound.length}`);
  assert.equal(
    workflows.length,
    11,
    `generated/ 应恰好 11 个工作流，实际 ${workflows.length} —— 多出来的文件必须先查清来源，不能默认接受`,
  );
  assert.equal(prebound.length + legacy.length, workflows.length, 'prebound + legacy 必须覆盖全部工作流');
  // manifest 必须与实际逐条一致，且 binding 只会是 prebound / legacy
  assert.equal(
    manifest.workflows.length,
    11,
    `manifest.workflows 应恰好 11 条，实际 ${manifest.workflows.length}`,
  );
  const manifestPrebound = manifest.workflows.filter((w) => w.binding === 'prebound');
  const manifestLegacy = manifest.workflows.filter((w) => w.binding === 'legacy');
  assert.equal(
    manifestPrebound.length + manifestLegacy.length,
    manifest.workflows.length,
    'manifest 里有 binding 不是 prebound/legacy 的条目',
  );
  assert.equal(manifestPrebound.length, 5, `manifest prebound 应为 5，实际 ${manifestPrebound.length}`);
  assert.equal(manifestLegacy.length, 6, `manifest legacy 应为 6，实际 ${manifestLegacy.length}`);
  assert.deepEqual(
    manifest.workflows.find((w) => w.id === 'urtoris-gateway')?.binding,
    'legacy',
    'manifest 里 urtoris-gateway 必须是 legacy',
  );
});
check('legacy 工作流仍保留 settings.errorWorkflow（老路径没被削弱）', () => {
  for (const { file, doc } of workflows.filter((w) => w.doc.meta?.urtorisBinding === 'legacy')) {
    if (doc.meta?.urtorisRole === 'global-error-handler') continue;
    assert.equal(doc.settings?.errorWorkflow, 'urtoris-global-error-handler', `${file} 丢掉了 errorWorkflow`);
  }
});
check('prebound 工作流同样保留 errorWorkflow（双保险）', () => {
  for (const { file, doc } of PREBOUND()) {
    assert.equal(doc.settings?.errorWorkflow, 'urtoris-global-error-handler', `${file} 丢掉了 errorWorkflow`);
  }
});

console.log('\n9) 既有回归仍然通过');
check('tools/validate-workflows.mjs 退出码 0', () => {
  const out = execFileSync(process.execPath, [join(HERE, 'validate-workflows.mjs')], {
    encoding: 'utf8',
  });
  assert.match(out, /结构校验全部通过/, out.trim());
});
check('tools/test-node-versions.mjs 仍是 19/19 断言通过', () => {
  const out = execFileSync(process.execPath, [join(HERE, 'test-node-versions.mjs')], {
    encoding: 'utf8',
  });
  assert.match(out, /19\/19 断言通过/, `节点版本回归输出不符合预期：\n${out.trim()}`);
});

console.log(
  `\n${assertions - failures.length}/${assertions} 断言通过` +
    (failures.length
      ? `\n\n❌ 前置执行绑定回归失败：\n   · ${failures.join('\n   · ')}`
      : '\n\n✅ 前置执行绑定结构完整，且失败时不会进入危险节点'),
);

if (failures.length) process.exit(1);
