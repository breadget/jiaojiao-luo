import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';

// Exercise the actual Code-node source shipped to n8n, not a canned webhook.
const source = readFileSync(new URL('../deploy/n8n/patch-conversation-history.mjs', import.meta.url), 'utf8');
const constants = runInNewContext(`${source
  .replace(/^import .*;\n/gm, '')
  .replace(/^export /gm, '')
  .replace(/^if \(process\.argv\[1\].*$/m, '')}\n({ HISTORY_LENGTH_CHECK, CHAT_PREPARATION, patchConversationHistory });`, { structuredClone });

function run(code: string, json: unknown) {
  return runInNewContext(`(function () { ${code} })()`, {
    $input: { first: () => ({ json }) },
  });
}

describe('published n8n conversation contract', () => {
  it('accepts a full transcript above 2000 characters while checking the current input', () => {
    const body = {
      message: '历史'.repeat(12000),
      context: { currentMessage: '复述整个聊天框', conversationHistory: [{ role: 'user', content: '历史'.repeat(12000) }] },
    };
    const validate = `const body = $input.first().json; const issues = []; ${constants.HISTORY_LENGTH_CHECK}; return issues;`;
    assert.equal(run(validate, body).length, 0);
    assert.equal(run(validate, { ...body, context: { ...body.context, currentMessage: '新'.repeat(2001) } }).length, 1);
    assert.equal(run(validate, { message: '新'.repeat(2001) }).length, 1);
    assert.equal(run(validate, { ...body, context: { ...body.context, conversationHistory: [{ role: 'system', content: '非法角色' }] } }).length, 2);
  });

  it('sends every historical role and content once and preserves the final user question', () => {
    const history = Array.from({ length: 31 }, (_, i) => ({
      role: i % 2 ? 'assistant' : 'user',
      content: i === 0 ? `${'长内容'.repeat(4000)}最早消息末尾` : `第 ${i} 条正文\n附加信息`,
    }));
    const result = run(constants.CHAT_PREPARATION, {
      requestId: 'history-test', context: { conversationHistory: history, currentMessage: '把全部记录再输出一遍' },
      message: '兼容旧节点的完整历史文本', llm: { apiKey: 'synthetic-key' },
    }).json;
    assert.equal(result.messages.length, 33);
    assert.deepEqual(JSON.parse(JSON.stringify(result.messages.slice(1, -1))), history);
    assert.equal(result.messages.at(-1).content, '把全部记录再输出一遍');
    assert.equal(result.prompt, '把全部记录再输出一遍');
    assert.equal(result.system.includes('控制在 120 字以内'), false);
  });

  it('preserves the surrounding workflow and patches idempotently', () => {
    const workflow = { id: 'urtoris-wf-llm-smoke', active: true, credentials: { opaque: true }, nodes: [
      { name: '校验请求', parameters: { jsCode: "if (body.message && body.message.length > 2000) issues.push('message 超过 2000 字');" } },
      { name: '准备模型入参', parameters: { jsCode: 'old' } },
      { name: '上报执行映射', parameters: { preserved: true } },
    ] };
    const first = constants.patchConversationHistory(workflow);
    assert.equal(first.changed, true);
    assert.deepEqual(first.workflow.nodes[2], workflow.nodes[2]);
    assert.deepEqual(first.workflow.credentials, workflow.credentials);
    assert.equal(constants.patchConversationHistory(first.workflow).changed, false);
    assert.equal(workflow.nodes[1].parameters.jsCode, 'old');
  });
});
