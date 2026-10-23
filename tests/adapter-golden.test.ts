import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { compileGraphToN8n } from '@/lib/workflow-graph/adapter/n8n-v1';
import { canonicalJson, hashGraphContent } from '@/lib/workflow-graph/hash';
import type { N8nWorkflow } from '@/lib/workflow-graph/adapter/types';
import type { WorkflowGraphV1 } from '@/lib/workflow-graph/types';

/**
 * Golden fixture 回归。
 *
 * 夹具是"Adapter 的输出长什么样"的冻结证据：任何一次改动只要动了产物结构，
 * 这里就会红，逼着改动者明确说清是"有意升级"还是"手滑改坏"。
 * 升级夹具的姿势：重新生成 tests/fixtures/ 三个文件，并在提交里说明原因
 * （同时要更新 docs/N8N-NODE-REFERENCE-2.38.md 的版本表）。
 */
const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const OPTIONS = { workflowId: 'wf_canary', version: 1 };

function readFixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(FIXTURE_DIR, name), 'utf8')) as T;
}

describe('Adapter golden fixture', () => {
  const graph = readFixture<WorkflowGraphV1>('canary-graph.json');
  const expectedWorkflow = readFixture<N8nWorkflow>('canary-compiled.n8n.json');
  const expectedMeta = readFixture<{
    graphHash: string;
    compiledHash: string;
    bindings: {
      internalNodeId: string;
      externalNodeId: string;
      externalNodeName: string;
      role: string;
    }[];
    requiredCredentialRefs: string[];
  }>('canary-compiled.meta.json');

  it('夹具里的图本身是合法的（否则夹具会掩盖真实问题）', async () => {
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.issues.filter((issue) => issue.level === 'error'),
      [],
    );
  });

  it('产物与夹具逐字节一致', async () => {
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(canonicalJson(result.workflow), canonicalJson(expectedWorkflow));
  });

  it('哈希与夹具一致', async () => {
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.equal(result.graphHash, expectedMeta.graphHash);
    assert.equal(result.compiledHash, expectedMeta.compiledHash);
    assert.equal(result.graphHash, await hashGraphContent(graph));
  });

  it('节点绑定与夹具一致', async () => {
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.deepEqual(result.bindings, expectedMeta.bindings);
  });

  it('需要手工挂载的凭据引用与夹具一致', async () => {
    const result = await compileGraphToN8n(graph, OPTIONS);
    assert.deepEqual(result.requiredCredentialRefs, expectedMeta.requiredCredentialRefs);
  });

  it('夹具产物不含任何凭据字段（可安全进克隆环境）', () => {
    const json = readFileSync(
      join(FIXTURE_DIR, 'canary-compiled.n8n.json'),
      'utf8',
    );
    for (const forbidden of ['"credentials"', 'apiKey', 'Authorization', 'sk-']) {
      assert.ok(!json.includes(forbidden), `夹具不应包含 ${forbidden}`);
    }
  });
});
