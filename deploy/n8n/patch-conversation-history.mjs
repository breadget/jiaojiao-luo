#!/usr/bin/env node

// Run against a fresh, server-local published workflow export. Never print
// workflow JSON: production exports can contain inline service credentials.
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const OLD_LENGTH_CHECK =
  "if (body.message && body.message.length > 2000) issues.push('message 超过 2000 字');";

export const HISTORY_LENGTH_CHECK = `// URTORIS_CONVERSATION_HISTORY_V1
const historyContext = body.context && typeof body.context === 'object' ? body.context : {};
const history = historyContext.conversationHistory;
const validHistory = Array.isArray(history) && history.every(m =>
  m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string');
if (history !== undefined && !validHistory) issues.push('conversationHistory 格式无效');
// 2000 字限制只适用于本轮用户输入，完整历史不得按这一限制丢弃。
const currentMessage = validHistory && typeof historyContext.currentMessage === 'string'
  ? historyContext.currentMessage : body.message;
if (currentMessage && currentMessage.length > 2000) issues.push('message 超过 2000 字');`;

export const CHAT_PREPARATION = `// URTORIS_CONVERSATION_HISTORY_V1
const j = $input.first().json;
const system = [
  '你是这个聊天框里的中文 AI 助手，请直接回答用户当前的问题。',
  'messages 中的历史消息按时间顺序来自同一聊天框，包含用户、助手以及已保存的可见附加信息。',
  '用户要求回顾、复述或列出聊天记录时，请依据全部历史逐条回答，并按用户要求保留原文。不要声称只能看到当前消息，也不要使用固定的冒烟测试身份或固定字数限制。',
  '历史执行状态和输出属于以前的运行，不代表本轮已经执行；附件和产物信息不等于文件内容，未提供的内容不要编造。'
].join('\\n');
const history = Array.isArray(j.context?.conversationHistory) ? j.context.conversationHistory : [];
const currentMessage = typeof j.context?.currentMessage === 'string' ? j.context.currentMessage : j.message;
return { json: {
  ok: true, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow,
  startedAt: j.startedAt, executionId: j.executionId, meta: j.meta,
  system, prompt: currentMessage,
  messages: [{ role: 'system', content: system }, ...history, { role: 'user', content: currentMessage }],
  llm: j.llm, temperature: 0.3, timeoutMs: 30000
} };`;

export function patchConversationHistory(original) {
  const workflow = structuredClone(original);
  if (!workflow.id || !Array.isArray(workflow.nodes)) {
    throw new Error('Expected one exported workflow object');
  }
  let changed = false;
  for (const node of workflow.nodes) {
    if (node.name !== '校验请求') continue;
    const code = node.parameters?.jsCode;
    if (typeof code !== 'string') throw new Error(`${workflow.id}: validator is not a Code node`);
    if (code.includes('URTORIS_CONVERSATION_HISTORY_V1')) continue;
    if (!code.includes(OLD_LENGTH_CHECK)) throw new Error(`${workflow.id}: unexpected request validator`);
    node.parameters.jsCode = code.replace(OLD_LENGTH_CHECK, HISTORY_LENGTH_CHECK);
    changed = true;
  }
  if (workflow.id === 'urtoris-wf-llm-smoke') {
    const nodes = workflow.nodes.filter(node => node.name === '准备模型入参');
    if (nodes.length !== 1) throw new Error('W1: expected exactly one model preparation node');
    if (nodes[0].parameters.jsCode !== CHAT_PREPARATION) {
      nodes[0].parameters.jsCode = CHAT_PREPARATION;
      changed = true;
    }
  }
  return { workflow, changed };
}

function main() {
  const [input, output] = process.argv.slice(2);
  if (!input || !output || resolve(input) === resolve(output)) {
    throw new Error('Usage: patch-conversation-history.mjs <published-export-dir> <new-output-dir>');
  }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const filename of readdirSync(input).filter(name => name.endsWith('.json'))) {
    const result = patchConversationHistory(JSON.parse(readFileSync(join(input, filename), 'utf8')));
    if (!result.changed) continue;
    writeFileSync(join(output, filename), `${JSON.stringify(result.workflow)}\n`, { mode: 0o600 });
    process.stdout.write(`Patched ${result.workflow.id}\n`);
    count++;
  }
  if (!count) throw new Error('No workflows required a patch');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
