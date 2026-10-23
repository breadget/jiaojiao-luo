#!/usr/bin/env node
/**
 * n8n 2.38.6 的节点版本表 —— 用于在导入前挡住"版本号根本不存在"的节点。
 *
 * 为什么需要它：n8n 对**不存在的 typeVersion 是静默的**（界面显示 `?`、
 * 运行时才报 Unrecognized node type），而生成器会从蓝图里整块搬用带版本的节点。
 * 2026-09-11 实测就发现 6 个节点的版本号是错的（见 FIXED_DEFECTS）。
 *
 * 数据来源（不是文档推测，是包内文件）：
 *   - `n8n-nodes-base@2.38.2`（`n8n@2.38.6` 的依赖）
 *   - `@n8n/n8n-nodes-langchain@2.38.2`
 *   逐个节点读 `Xxx.node.js` / `vN/` 子版本文件 / `versionDescription.js` 里的
 *   `version:` 与 `defaultVersion:` 声明。
 *
 * 维护方式：换了 n8n 版本就按 `docs/N8N-NODE-REFERENCE-2.38.md` 第 14 节的复核脚本
 * 重新生成这张表；**不要凭印象加版本号**。
 *
 * 校验语义（`validateNodeTypeVersion`）：
 *   - 表里没有这个 type          → error（未登记，先核实再登记）
 *   - type 有版本列表但不在其中  → error
 *   - 版本在列表中              → ok
 */

/** 与 n8n@2.38.6 对应的包版本。 */
export const N8N_VERSION = '2.38.6';
export const NODE_PACKAGES = {
  base: 'n8n-nodes-base@2.38.2',
  langchain: '@n8n/n8n-nodes-langchain@2.38.2',
};

/** type → 该节点在 2.38.6 支持的 typeVersion 列表（字符串形式，便于精确比较）。 */
export const NODE_VERSION_TABLE = {
  // ---- n8n-nodes-base ----
  'n8n-nodes-base.code': ['1', '2'],
  'n8n-nodes-base.errorTrigger': ['1'],
  'n8n-nodes-base.executeWorkflow': ['1', '1.1', '1.2', '1.3'],
  'n8n-nodes-base.executeWorkflowTrigger': ['1', '1.1', '1.2'],
  'n8n-nodes-base.github': ['1', '1.1'],
  'n8n-nodes-base.githubTrigger': ['1'],
  'n8n-nodes-base.googleSheets': ['1', '2', '3', '4', '4.1', '4.2', '4.3', '4.4', '4.5', '4.6', '4.7'],
  'n8n-nodes-base.httpRequest': ['1', '2', '3', '4', '4.1', '4.2', '4.3', '4.4', '4.5'],
  'n8n-nodes-base.if': ['1', '2', '2.1', '2.2', '2.3'],
  'n8n-nodes-base.merge': ['1', '2', '2.1', '3', '3.1', '3.2'],
  'n8n-nodes-base.noOp': ['1'],
  'n8n-nodes-base.respondToWebhook': ['1', '1.1', '1.2', '1.3', '1.4', '1.5'],
  'n8n-nodes-base.slack': ['2', '2.1', '2.2', '2.3', '2.4', '2.5', '2.6', '2.7'],
  'n8n-nodes-base.switch': ['1', '2', '3', '3.1', '3.2', '3.3', '3.4'],
  'n8n-nodes-base.webhook': ['1', '1.1', '2', '2.1'],
  // ---- @n8n/n8n-nodes-langchain ----
  '@n8n/n8n-nodes-langchain.agent': [
    '1', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9',
    '2', '2.1', '2.2', '3', '3.1',
  ],
  '@n8n/n8n-nodes-langchain.lmChatAnthropic': ['1', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6'],
  '@n8n/n8n-nodes-langchain.lmChatGoogleGemini': ['1', '1.1'],
  '@n8n/n8n-nodes-langchain.lmChatGroq': ['1'],
  '@n8n/n8n-nodes-langchain.lmChatOpenAi': ['1', '1.1', '1.2', '1.3'],
  '@n8n/n8n-nodes-langchain.memoryPostgresChat': ['1', '1.1', '1.2', '1.3', '1.4'],
  '@n8n/n8n-nodes-langchain.outputParserAutofixing': ['1'],
  '@n8n/n8n-nodes-langchain.outputParserStructured': ['1', '1.1', '1.2', '1.3'],
  '@n8n/n8n-nodes-langchain.toolHttpRequest': ['1', '1.1'],
};

/**
 * 两个 HTTP 系节点的版本空间必须分开。
 *
 * `n8n-nodes-base.httpRequest` 与 `@n8n/n8n-nodes-langchain.toolHttpRequest`
 * 长得像、用途不同，历史上就是因为把 httpRequest 的 4.2 抄进了 toolHttpRequest
 * 才产出无效节点。这里把"不能混用"写成可执行断言。
 */
export const HTTP_NODE_TYPES = {
  httpRequest: 'n8n-nodes-base.httpRequest',
  toolHttpRequest: '@n8n/n8n-nodes-langchain.toolHttpRequest',
};

/** 2026-09-11 修掉的实际缺陷，留作回归证据。 */
export const FIXED_DEFECTS = [
  { type: 'n8n-nodes-base.github', from: 2, to: 1 },
  { type: 'n8n-nodes-base.githubTrigger', from: 2, to: 1 },
  { type: '@n8n/n8n-nodes-langchain.lmChatGoogleGemini', from: 1.2, to: 1 },
  { type: '@n8n/n8n-nodes-langchain.lmChatGroq', from: 1.3, to: 1 },
  { type: '@n8n/n8n-nodes-langchain.outputParserAutofixing', from: 1.2, to: 1 },
  { type: '@n8n/n8n-nodes-langchain.toolHttpRequest', from: 4.2, to: 1 },
];

/** 数值化比较，避免 '2' 与 '2.0'、'4.10' 与 '4.1' 这类字符串坑。 */
export function normalizeVersion(value) {
  const n = Number(value);
  return Number.isFinite(n) ? String(n) : String(value);
}

/**
 * @returns {{ ok: true } | { ok: false, reason: string, supported?: string[] }}
 */
export function validateNodeTypeVersion(type, typeVersion) {
  const supported = NODE_VERSION_TABLE[type];
  if (!supported) {
    return {
      ok: false,
      reason: `未登记节点类型「${type}」：先在 tools/n8n-node-versions.mjs 里核实 n8n ${N8N_VERSION} 的版本表再登记`,
    };
  }
  if (typeVersion === undefined || typeVersion === null) {
    return { ok: false, reason: `节点 ${type} 缺少 typeVersion`, supported };
  }
  if (!supported.map(normalizeVersion).includes(normalizeVersion(typeVersion))) {
    return {
      ok: false,
      reason: `节点 ${type} 的 typeVersion=${typeVersion} 在 n8n ${N8N_VERSION} 不存在`,
      supported,
    };
  }
  return { ok: true };
}

/** 供测试与文档使用：某个类型的全部受支持版本。 */
export function supportedVersions(type) {
  return NODE_VERSION_TABLE[type] ?? null;
}
