#!/usr/bin/env node
/**
 * 节点版本回归测试（对应 2026-09-11 修的 6 个无效 typeVersion）。
 *
 * 断言三件事：
 *   1. toolHttpRequest 只能生成 1 或 1.1（不能出现 httpRequest 的 4.x）
 *   2. httpRequest 与 toolHttpRequest 的版本空间不重叠、不混用
 *   3. generated/ 下每个 JSON 的每个节点都通过版本校验
 *
 * 用法：node tools/test-node-versions.mjs
 * 退出码非 0 表示回归。CI / 部署前都可以跑。
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIXED_DEFECTS,
  HTTP_NODE_TYPES,
  NODE_VERSION_TABLE,
  N8N_VERSION,
  supportedVersions,
  validateNodeTypeVersion,
} from './n8n-node-versions.mjs';

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
    .filter((f) => f.endsWith('.json') && f !== 'manifest.json')
    .map((f) => ({ file: f, doc: JSON.parse(readFileSync(join(GEN, f), 'utf8')) }));
}

/** all-workflows.json 是 bundle，其余是单个工作流。 */
function nodesOf(doc) {
  const docs = Array.isArray(doc) ? doc : [doc];
  const out = [];
  for (const d of docs) {
    if (!d || typeof d !== 'object') continue;
    for (const n of d.nodes ?? []) out.push({ workflow: d.name ?? d.id ?? '?', node: n });
  }
  return out;
}

console.log(`节点版本回归测试（基线 n8n ${N8N_VERSION}）\n`);

console.log('1) toolHttpRequest 的版本空间');
check('toolHttpRequest 只支持 1 / 1.1', () => {
  assert.deepEqual(supportedVersions(HTTP_NODE_TYPES.toolHttpRequest), ['1', '1.1']);
});
check('toolHttpRequest 拒绝 4.2（历史错误值）', () => {
  const result = validateNodeTypeVersion(HTTP_NODE_TYPES.toolHttpRequest, 4.2);
  assert.equal(result.ok, false);
  assert.match(result.reason, /不存在/);
});
check('toolHttpRequest 接受 1 与 1.1', () => {
  assert.equal(validateNodeTypeVersion(HTTP_NODE_TYPES.toolHttpRequest, 1).ok, true);
  assert.equal(validateNodeTypeVersion(HTTP_NODE_TYPES.toolHttpRequest, '1.1').ok, true);
});

console.log('\n2) httpRequest 与 toolHttpRequest 不混用');
check('两个类型的版本表不相同（防止照抄）', () => {
  const a = supportedVersions(HTTP_NODE_TYPES.httpRequest);
  const b = supportedVersions(HTTP_NODE_TYPES.toolHttpRequest);
  assert.notDeepEqual(a, b, '两个节点的版本表不该完全一样，否则说明有一方被照抄');
});
check('唯一的交集是双方都真实存在的 v1', () => {
  const a = new Set(supportedVersions(HTTP_NODE_TYPES.httpRequest));
  const b = new Set(supportedVersions(HTTP_NODE_TYPES.toolHttpRequest));
  const shared = [...a].filter((v) => b.has(v)).sort();
  assert.deepEqual(shared, ['1'], `交集应为 ['1']，实际 ${JSON.stringify(shared)}`);
});
check('httpRequest 独有的 3.x/4.x 不能被 toolHttpRequest 接受', () => {
  const toolVersions = new Set(supportedVersions(HTTP_NODE_TYPES.toolHttpRequest));
  const httpOnly = supportedVersions(HTTP_NODE_TYPES.httpRequest).filter(
    (v) => !toolVersions.has(v),
  );
  assert.ok(httpOnly.length > 0, '应当存在 httpRequest 独有的版本');
  for (const version of httpOnly) {
    assert.equal(
      validateNodeTypeVersion(HTTP_NODE_TYPES.toolHttpRequest, version).ok,
      false,
      `toolHttpRequest 不应接受 httpRequest 独有的 ${version}`,
    );
  }
});
check('toolHttpRequest 独有的 1.1 不能被 httpRequest 接受', () => {
  const httpVersions = new Set(supportedVersions(HTTP_NODE_TYPES.httpRequest));
  const toolOnly = supportedVersions(HTTP_NODE_TYPES.toolHttpRequest).filter(
    (v) => !httpVersions.has(v),
  );
  assert.deepEqual(toolOnly, ['1.1'], 'toolHttpRequest 独有版本应当只有 1.1');
  for (const version of toolOnly) {
    assert.equal(
      validateNodeTypeVersion(HTTP_NODE_TYPES.httpRequest, version).ok,
      false,
      `httpRequest 不应接受 toolHttpRequest 独有的 ${version}`,
    );
  }
});
check('generated 里两个类型各自用的版本都在自己的表内', () => {
  for (const { file, doc } of generatedWorkflows()) {
    for (const { node } of nodesOf(doc)) {
      if (
        node.type !== HTTP_NODE_TYPES.httpRequest &&
        node.type !== HTTP_NODE_TYPES.toolHttpRequest
      ) {
        continue;
      }
      const result = validateNodeTypeVersion(node.type, node.typeVersion);
      assert.equal(result.ok, true, `${file} / ${node.name}：${result.reason ?? ''}`);
    }
  }
});

console.log('\n3) generated JSON 全量版本校验');
check('未登记的类型会被拒绝（防止悄悄放过新节点）', () => {
  const result = validateNodeTypeVersion('n8n-nodes-base.someBrandNewNode', 1);
  assert.equal(result.ok, false);
  assert.match(result.reason, /未登记/);
});
check('缺少 typeVersion 会被拒绝', () => {
  assert.equal(validateNodeTypeVersion('n8n-nodes-base.noOp', undefined).ok, false);
});
check('每个 generated JSON 的每个节点都通过版本校验', () => {
  const problems = [];
  let checked = 0;
  for (const { file, doc } of generatedWorkflows()) {
    for (const { workflow, node } of nodesOf(doc)) {
      checked += 1;
      const result = validateNodeTypeVersion(node.type, node.typeVersion);
      if (!result.ok) {
        problems.push(`${file} → ${workflow} → ${node.name}：${result.reason}`);
      }
    }
  }
  assert.ok(checked > 0, '没有扫描到任何节点，说明 generated/ 是空的');
  assert.deepEqual(problems, [], problems.join('\n      '));
  console.log(`      （本次校验 ${checked} 个节点）`);
});

console.log('\n4) 六个已修缺陷不会复发');
for (const { type } of FIXED_DEFECTS) {
  check(`${type} 的版本表在册`, () => {
    assert.ok(supportedVersions(type), `${type} 不在版本表里`);
  });
}
check('generated 里不再出现已修的无效版本', () => {
  for (const { type, from } of FIXED_DEFECTS) {
    for (const { file, doc } of generatedWorkflows()) {
      for (const { node } of nodesOf(doc)) {
        if (node.type !== type) continue;
        assert.notEqual(
          Number(node.typeVersion),
          Number(from),
          `${file} / ${node.name} 仍是无效版本 ${from}`,
        );
      }
    }
  }
});
check('版本表本身没有重复或空项', () => {
  for (const [type, versions] of Object.entries(NODE_VERSION_TABLE)) {
    assert.ok(Array.isArray(versions) && versions.length > 0, `${type} 版本列表为空`);
    assert.equal(
      new Set(versions).size,
      versions.length,
      `${type} 版本列表有重复项`,
    );
  }
});

console.log(
  `\n${assertions - failures.length}/${assertions} 断言通过` +
    (failures.length ? `\n\n❌ 回归失败：\n   · ${failures.join('\n   · ')}` : '\n\n✅ 节点版本全部合法'),
);

if (failures.length) process.exit(1);
