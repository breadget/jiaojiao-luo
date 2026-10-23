#!/usr/bin/env node
/**
 * mode / degraded 协议语义回归。
 *
 * 守护三件事：
 *  1. 无 BYO Key 的规则兜底必须显式标记 mode=rules、degraded=true；
 *  2. 真实模型路径（包括模型报错）必须标记 mode=llm、degraded=false；
 *  3. 业务节点 → 组装成功入参 → common-envelope 的整条链不能丢字段。
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GEN = join(ROOT, 'generated');

let assertions = 0;
const failures = [];

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

function build() {
  execFileSync(process.execPath, [join(HERE, 'build-workflows.mjs')], {
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function workflow(id) {
  return JSON.parse(readFileSync(join(GEN, `${id}.json`), 'utf8'));
}

function codeNode(doc, name) {
  const node = doc.nodes.find((candidate) => candidate.name === name);
  assert.ok(node, `${doc.id} 缺少节点「${name}」`);
  assert.equal(node.type, 'n8n-nodes-base.code', `${name} 不是 Code 节点`);
  return node.parameters.jsCode;
}

function execute(jsCode, input, named = {}) {
  const items = (Array.isArray(input) ? input : [input]).map((json) => ({ json }));
  const $input = {
    first: () => items[0],
    all: () => items,
  };
  const select = (name) => {
    assert.ok(Object.hasOwn(named, name), `测试缺少命名节点上下文「${name}」`);
    return { first: () => ({ json: named[name] }) };
  };
  return new Function('$input', '$', jsCode)($input, select);
}

build();

const commonLlm = workflow('urtoris-common-llm');
const commonEnvelope = workflow('urtoris-common-envelope');
const w1 = workflow('urtoris-wf-llm-smoke');
const w2 = workflow('urtoris-wf-user-manager');
const w5 = workflow('urtoris-wf-customer-insights');

console.log('mode / degraded 协议语义回归\n');

console.log('1) common-llm 明确区分无 Key 与真实模型路径');
const prepareModel = codeNode(commonLlm, '准备模型入参');
check('无 Key → mode=rules, degraded=true', () => {
  const result = execute(prepareModel, { requestId: 'req-no-key', llm: null });
  assert.equal(result.json.ok, false);
  assert.equal(result.json.error.code, 'LLM_NOT_CONFIGURED');
  assert.equal(result.json.mode, 'rules');
  assert.equal(result.json.degraded, true);
});
check('有 Key → mode=llm, degraded=false', () => {
  const result = execute(prepareModel, {
    requestId: 'req-key',
    llm: { apiKey: 'fixture-key', baseUrl: 'http://example.invalid/v1', model: 'fixture' },
  });
  assert.equal(result.json.ok, true);
  assert.equal(result.json.mode, 'llm');
  assert.equal(result.json.degraded, false);
});

console.log('\n2) W1 无 Key 是诚实的成功降级，模型错误仍是模型错误');
const w1Error = codeNode(w1, '透传模型错误');
const w1Context = {
  requestId: 'req-w1',
  sessionId: 'session-w1',
  workflow: 'llm-smoke',
  startedAt: 1,
  executionId: '11',
};
check('W1 无 Key → success 路径 + rules/degraded', () => {
  const result = execute(
    w1Error,
    { error: { code: 'LLM_NOT_CONFIGURED', message: 'missing', retryable: false } },
    { 校验请求: w1Context },
  );
  assert.equal(result.json.success, undefined);
  assert.equal(result.json.result.llmConfigured, false);
  assert.equal(result.json.mode, 'rules');
  assert.equal(result.json.degraded, true);
});
check('W1 真实模型鉴权错误 → success=false + llm/non-degraded', () => {
  const result = execute(
    w1Error,
    { error: { code: 'CREDENTIAL_MISSING', message: 'bad key', retryable: false } },
    { 校验请求: w1Context },
  );
  assert.equal(result.json.success, false);
  assert.equal(result.json.mode, 'llm');
  assert.equal(result.json.degraded, false);
});

console.log('\n3) W2 / W5 规则兜底显式带 degraded=true');
const w2Decision = codeNode(w2, '判定职级');
const w2Action = codeNode(w2, '加入主管频道');
let w2Rule;
check('W2 无 Key 的规则判断标记正确', () => {
  w2Rule = execute(
    w2Decision,
    { ok: false, error: { code: 'LLM_NOT_CONFIGURED' } },
    {
      提取用户信息: {
        requestId: 'req-w2',
        sessionId: 'session-w2',
        workflow: 'user-manager',
        startedAt: 1,
        executionId: '12',
        profile: { name: '张三', role: '经理', department: '研发' },
        prompt: '研发经理',
      },
    },
  ).json;
  assert.equal(w2Rule.decidedBy, 'rule');
  assert.equal(w2Rule.mode, 'rules');
  assert.equal(w2Rule.degraded, true);
});
check('W2 后续动作不会丢 mode/degraded', () => {
  const result = execute(w2Action, w2Rule).json;
  assert.equal(result.mode, 'rules');
  assert.equal(result.degraded, true);
});

const w5Insights = codeNode(w5, '整理洞察');
let w5Rule;
check('W5 无 Key 的规则总结标记正确', () => {
  w5Rule = execute(
    w5Insights,
    { ok: false, error: { code: 'LLM_NOT_CONFIGURED' } },
    {
      加载评论并聚类: {
        requestId: 'req-w5',
        sessionId: 'session-w5',
        workflow: 'customer-insights',
        startedAt: 1,
        executionId: '13',
        reviewCount: 1,
        k: 1,
        inertia: 0,
        clusters: [{ keywords: ['物流'], share: 100 }],
      },
    },
  ).json;
  assert.equal(w5Rule.result.summarizedBy, 'rule');
  assert.equal(w5Rule.mode, 'rules');
  assert.equal(w5Rule.degraded, true);
});

console.log('\n4) 公共信封全链路保留 mode/degraded');
const assemble = codeNode(w5, '组装成功入参');
const envelope = codeNode(commonEnvelope, '构建信封');
check('组装成功入参保留 rules/degraded', () => {
  const result = execute(assemble, w5Rule)[0].json;
  assert.equal(result.success, true);
  assert.equal(result.mode, 'rules');
  assert.equal(result.degraded, true);
});
check('最终成功信封保留 rules/degraded', () => {
  const assembled = execute(assemble, w5Rule)[0].json;
  const result = execute(envelope, assembled)[0].json;
  assert.equal(result.protocol, 'urtoris.v1');
  assert.equal(result.success, true);
  assert.equal(result.mode, 'rules');
  assert.equal(result.degraded, true);
});
check('最终模型错误信封保留 llm/non-degraded', () => {
  const result = execute(envelope, {
    requestId: 'req-error',
    workflow: 'llm-smoke',
    success: false,
    mode: 'llm',
    degraded: false,
    error: { code: 'CREDENTIAL_MISSING', message: 'bad key' },
  })[0].json;
  assert.equal(result.success, false);
  assert.equal(result.mode, 'llm');
  assert.equal(result.degraded, false);
});

if (failures.length) {
  console.error(`\n${failures.length}/${assertions} 断言失败：`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`\n${assertions}/${assertions} 断言通过`);
console.log('\n✅ mode / degraded 协议语义完整');
