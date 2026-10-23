#!/usr/bin/env node
/**
 * Urtoris ↔ n8n 工作流生成器。
 *
 * 为什么用生成器而不是手写 15 个 JSON：
 *   1. 协议层（鉴权 / 校验 / 信封 / 日志）在所有工作流里必须**逐字一致**，
 *      手写必然漂移；改一处重新生成，5 个工作流同时升级。
 *   2. 工作流 id 是硬引用（settings.errorWorkflow、Execute Sub-workflow），
 *      字符串常量在这里集中定义，不可能写错。
 *   3. 原始蓝图节点以 disabled 形式保留进工作流，不会因为重构而丢东西。
 *
 * 产物：generated/*.json + generated/manifest.json
 * 部署：tools/deploy.mjs（导入 → 发布 → 绑定）
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  BINDING_CODE_NAME,
  BINDING_ERROR_CODE,
  BINDING_ERROR_FIELD,
  BINDING_EVENT_TYPE,
  BINDING_GUARD_LEFT_VALUE,
  BINDING_GUARD_NAME,
  BINDING_HTTP_NAME,
  BINDING_OK_FIELD,
  bindingNodeIds,
} from './binding-graph.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'generated');

// ─────────────────────────── 工作流 id（硬引用，集中定义） ───────────────────────────
export const IDS = {
  commonAuth: 'urtoris-common-auth',
  commonLlm: 'urtoris-common-llm',
  commonEnvelope: 'urtoris-common-envelope',
  commonLog: 'urtoris-common-log',
  errorHandler: 'urtoris-global-error-handler',
  gateway: 'urtoris-gateway',
  llmSmoke: 'urtoris-wf-llm-smoke',
  userManager: 'urtoris-wf-user-manager',
  securityAnalysis: 'urtoris-wf-security-analysis',
  apiGateway: 'urtoris-wf-api-gateway',
  customerInsights: 'urtoris-wf-customer-insights',
};

/** 站点数据库里的工作流 id；与上面的 n8n workflow id 是两套命名空间。 */
export const SITE_WORKFLOW_IDS = {
  llmSmoke: 'wf_n8n_llm_smoke',
  userManager: 'wf_n8n_user_manager',
  securityAnalysis: 'wf_n8n_security_analysis',
  apiGateway: 'wf_n8n_api_gateway',
  customerInsights: 'wf_n8n_customer_insights',
};

export const WEBHOOK_PATH_BASE = 'urtoris';

function configuredUrl(envName, fallback, { originOnly = false, pathname = null } = {}) {
  const raw = String(process.env[envName] || fallback).trim();
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${envName} 不是合法 URL：${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`${envName} 只允许 http/https：${parsed.protocol}`);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`${envName} 不允许内联凭据、query 或 hash`);
  }
  if (originOnly && parsed.pathname !== '/') {
    throw new Error(`${envName} 必须是纯 origin，不能带路径：${parsed.pathname}`);
  }
  if (pathname && parsed.pathname !== pathname) {
    throw new Error(`${envName} 路径必须是 ${pathname}，实际 ${parsed.pathname}`);
  }
  return originOnly ? parsed.origin : `${parsed.origin}${parsed.pathname}`;
}

const INTERNAL_BASE_URL = configuredUrl(
  'URTORIS_N8N_INTERNAL_BASE_URL',
  'http://127.0.0.1:5678',
  { originOnly: true },
);
const EVENTS_URL = configuredUrl(
  'URTORIS_EVENTS_URL',
  'http://127.0.0.1:3000/api/n8n/events',
  { pathname: '/api/n8n/events' },
);

/**
 * 绑定上报的插入点与取值约定（旧实现的两个缺陷都在这里收口）：
 *
 *   1. 上报节点挂在「请求合法?」的 true 分支之后，所以它的输入**已经是**
 *      `校验请求` 的输出：`{ ok: true, requestId: <非空 string>, payload: <原始协议 body>, executionId, … }`。
 *      因此 requestId 直接写 `$json.requestId`，**不给任何兜底值** ——
 *      requestId 缺失的请求在上游就被判成 VALIDATION_ERROR 并直接返回，
 *      根本不会走到上报节点，更不会调用站点 `/api/n8n/events`。
 *   2. workflowId 取 `$json.payload.workflowId`（站点侧的工作流 id，站点在
 *      `app/api/v1/run` 里按 `workflowId: workflow.id` 下发），**不写死 n8n 侧 id**。
 *      写死会让 n8n_execution_map.workflow_id 混进另一套 id 命名空间，
 *      站点现在会直接拒绝未知工作流 id。
 */

/** webhook 鉴权凭证：由 tools/deploy-n8n.mjs 通过 REST 建立，这里只引用 id。 */
const WEBHOOK_CREDENTIAL = {
  id: 'urtoris-webhook-auth',
  name: 'Urtoris Webhook Bearer',
};

/**
 * n8n → Urtoris 的回传凭证。
 *
 * 刻意不用 `$env.XXX`：n8n 2.x 默认禁止在表达式/Code 节点里读环境变量，
 * 而且凭证是加密落库的，比明文环境变量更安全，也不用为了改令牌重启 n8n。
 */
const INTERNAL_CREDENTIAL = {
  id: 'urtoris-internal-token',
  name: 'Urtoris Internal Token',
};

// ─────────────────────────────── 节点工厂 ───────────────────────────────
//
// 关于 fixedId：绑定阶段的三个节点 id 必须是**固定字面量**（见 tools/binding-graph.mjs）。
// nid() 是递增序号，插入新节点会把后面所有节点的 id 整体平移，导致每次改动都是全量 diff。
// 所以三个工厂都支持传入 fixedId —— 传了就完全跳过 nid()，连序号都不消耗。

let nodeSeq = 0;
function nid(prefix) {
  nodeSeq += 1;
  return `${prefix}-${nodeSeq}`;
}

function webhook(path, position) {
  return {
    parameters: {
      httpMethod: 'POST',
      path,
      responseMode: 'responseNode',
      authentication: 'headerAuth',
      options: {},
    },
    id: nid('webhook'),
    name: 'Webhook',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position,
    webhookId: path.replace(/\//g, '-'),
    credentials: { httpHeaderAuth: { ...WEBHOOK_CREDENTIAL } },
  };
}

function code(name, jsCode, position, extra = {}, fixedId = null) {
  return {
    // 注意大小写：n8n 的枚举值是 `javaScript`，写成 `javascript` 会在运行时抛
    // "Unsupported language: javascript"，而且报错位置在 Code 节点里，很难联想。
    parameters: { mode: 'runOnceForAllItems', language: 'javaScript', jsCode },
    id: fixedId ?? nid('code'),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    ...extra,
  };
}

function ifNode(
  name,
  leftValue,
  position,
  { operation = 'true', rightValue = true, fixedId = null } = {},
) {
  const operator =
    operation === 'true'
      ? { type: 'boolean', operation: 'true', singleValue: true }
      : { type: 'boolean', operation: 'false', singleValue: true };
  const condition = {
    id: fixedId ? `${fixedId}-cond` : nid('cond'),
    leftValue,
    rightValue,
    operator,
  };
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 },
        conditions: [condition],
        combinator: 'and',
      },
      options: {},
    },
    id: fixedId ?? nid('if'),
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2.2,
    position,
  };
}

function switchByString(name, leftValue, keys, position) {
  return {
    parameters: {
      rules: {
        // Switch v3 的每条规则里的 conditions 必须是**过滤器对象**
        // （options + conditions[] + combinator），不是单个条件。
        // 写成 V1 那种 {leftValue, rightValue, operator} 不会报错，
        // 但所有项都会落到 output 0 —— 表现为"分流没生效"，极难排查。
        values: keys.map((key) => ({
          outputKey: key,
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'loose' },
            conditions: [
              {
                leftValue,
                rightValue: key,
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
        })),
      },
      // fallbackOutput 必须是数字：-1 = None
      options: { fallbackOutput: -1 },
    },
    id: nid('switch'),
    name,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3,
    position,
  };
}

function merge(name, position) {
  return {
    parameters: { mode: 'append', options: {} },
    id: nid('merge'),
    name,
    type: 'n8n-nodes-base.merge',
    typeVersion: 3,
    position,
  };
}

function executeWorkflow(name, workflowId, cachedResultName, position) {
  return {
    parameters: {
      source: 'database',
      workflowId: {
        __rl: true,
        value: workflowId,
        mode: 'id',
        cachedResultName,
      },
      mode: 'once',
      options: { waitForSubWorkflow: true },
    },
    id: nid('exec'),
    name,
    type: 'n8n-nodes-base.executeWorkflow',
    typeVersion: 1.2,
    position,
  };
}

function httpRequest(name, position, parameters, extra = {}, fixedId = null) {
  return {
    parameters,
    id: fixedId ?? nid('http'),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.2,
    position,
    ...extra,
  };
}

function respond(position) {
  return {
    parameters: { respondWith: 'firstIncomingItem', options: {} },
    id: nid('respond'),
    name: 'Respond to Webhook',
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.5,
    position,
  };
}

function noOp(name, position, extra = {}) {
  return {
    parameters: {},
    id: nid('noop'),
    name,
    type: 'n8n-nodes-base.noOp',
    typeVersion: 1,
    position,
    ...extra,
  };
}

function trigger(position) {
  return {
    parameters: { inputSource: 'passthrough' },
    id: nid('trigger'),
    name: 'When Executed by Another Workflow',
    type: 'n8n-nodes-base.executeWorkflowTrigger',
    typeVersion: 1.1,
    position,
  };
}

function errorTrigger(position) {
  return {
    parameters: {},
    id: nid('errtrigger'),
    name: 'Error Trigger',
    type: 'n8n-nodes-base.errorTrigger',
    typeVersion: 1,
    position,
  };
}

/** 把原始蓝图里需要外部凭证的节点搬进来，标 disabled，保留在旁边。 */
function disabledOriginals(blueprintPath, keepTypes, basePosition) {
  if (!existsSync(blueprintPath)) return [];
  const raw = JSON.parse(readFileSync(blueprintPath, 'utf8'));
  const nodes = [];
  let row = 0;
  for (const original of raw.nodes ?? []) {
    const short = original.type.split('.').pop();
    if (!keepTypes.includes(short)) continue;
    nodes.push({
      ...original,
      id: nid('legacy'),
      name: `[保留·未启用] ${original.name}`,
      disabled: true,
      position: [basePosition[0], basePosition[1] + row * 160],
    });
    row += 1;
  }
  return nodes;
}

// ─────────────── 前置执行绑定（请求校验通过之后的第一道闸门） ───────────────

/**
 * 前置执行绑定阶段：请求校验通过之后、**任何危险节点之前**的唯一一道闸门。
 *
 * 为什么必须 fail-closed：站点要在执行开始时就拿到 requestId ↔ executionId 的绑定，
 * 才能在事后把「哪一次执行」对回「哪一条请求」。如果上报失败还继续往下跑，
 * 就会出现「机器人已经把动作做完了、站点却不知道是谁让它做的」的黑洞。
 *
 * 插入点是**校验闸门的 true 分支之后**，不是 Webhook 的直连下游：
 *   · requestId 缺失的请求在上游 `校验请求` / `请求合法?` 就被判成 VALIDATION_ERROR，
 *     绝不带着空 requestId 调站点 /api/n8n/events（否则绑定表会被脏行污染，
 *     而且请求得到的错误码会从 VALIDATION_ERROR 变成 BINDING_FAILED）；
 *   · 只有 requestId 合法（且协议字段齐全）的请求才会走到绑定上报。
 *
 * 三个节点：
 *   A 绑定执行 (execution.bound)  httpRequest 4.2   POST 事件（neverError + 失败不抛）
 *   B 归一绑定结果                 code 2           压成 __bindingOk / __bindingError
 *   C 绑定成功?                    if 2.2           true → 校验闸门原来的 true 分支目标；false → Respond
 *
 * 注意：A/B/C 的 id 全部是固定字面量（不走 nid()），所以插入这一阶段
 * **不会**让任何既有节点的 id 发生变化。
 *
 * @param {object} options
 * @param {string} options.workflowKey     绑定 id 区间 / 信封 workflow 字段用的键
 * @param {string} options.triggerNodeId   Webhook 节点 id（写进上报的 triggerNodeId）
 * @param {object} options.positions       三个节点的画布坐标
 * @param {string} options.sourceNode      校验解析 Code 节点的名字（校验请求 / 解析路由）
 * @param {string} options.onPass          校验闸门 true 分支原来的目标（绑定成功后进入它）
 */
function bindingStage({ workflowKey, triggerNodeId, positions, sourceNode, onPass }) {
  const ids = bindingNodeIds(workflowKey);

  const reporter = httpRequest(
    BINDING_HTTP_NAME,
    positions.http,
    {
      method: 'POST',
      url: `${EVENTS_URL}`,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      // 整段 body 写成一个表达式再 JSON.stringify：与文件里其他三处回传
      // （common-log / 全局错误处理 / 网关）完全同一种写法。
      // 不能把 ={{ }} 塞进 JSON 的各个值里 —— n8n 只在「字符串以 = 开头」时才解析表达式，
      // 那样整个 jsonBody 不以 = 开头，运行期会把表达式字符串原样当值发出去。
      //
      // 输入来自「请求合法?」的 true 分支，即校验节点的成功输出：
      //   requestId → 顶层 $json.requestId（一定有值）
      //   workflowId → $json.payload.workflowId（站点侧 id，payload 就是原始协议体）
      jsonBody: `={{ JSON.stringify({ requestId: $json.requestId, executionId: String($execution.id), workflowId: $json.payload.workflowId, triggerNodeId: '${triggerNodeId}', eventType: '${BINDING_EVENT_TYPE}' }) }}`,
      options: { timeout: 5000, response: { response: { fullResponse: true, neverError: true } } },
    },
    {
      // neverError 只兜住「非 2xx」，连接被拒 / 超时仍然会抛；挂 continueRegularOutput
      // 才能保证任何失败都变成一条可判断的数据，而不是中断执行（中断会绕过 Respond，
      // 站点收到的是 n8n 的 500，而不是 binding_failed 信封）。
      onError: 'continueRegularOutput',
      alwaysOutputData: true,
      retryOnFail: true,
      maxTries: 2,
      waitBetweenTries: 400,
      credentials: { httpHeaderAuth: { ...INTERNAL_CREDENTIAL } },
    },
    ids.http,
  );

  const normalize = code(
    BINDING_CODE_NAME,
    `
// ── 前置执行绑定：把上报节点的响应归一成「放行 / 拦下」两种形状 ──
// 上报节点取了 fullResponse + neverError，于是只有四种可能的输入：
//   · 响应是 JSON（任意状态码）→ item = { body, headers, statusCode }
//   · 响应头不是 application/json → 原文落在 data（见 README 第 6 节第 5 条）
//   · 连接层失败（拒绝/超时）→ item = { error: {...} }
//   · 什么都没回来 → 空对象
const raw = $input.first().json || {};
let payload = null;
if (raw.body !== undefined) payload = raw.body;
else if (raw.data !== undefined) payload = raw.data;
if (typeof payload === 'string') { try { payload = JSON.parse(payload); } catch (e) { payload = null; } }
if (!payload || typeof payload !== 'object') payload = null;

const status = Number(raw.statusCode || 0);
// 站点约定：成功返回 { ok: true, bound: true, ... }；失败返回非 2xx + { ok: false, error }
const ok = status >= 200 && status < 300 && !!payload && payload.ok === true && payload.bound === true;

// 校验节点的成功输出（requestId / payload / sessionId / executionId）必须原样传下去：
// 下游业务节点的第一个入参就是它，绑定失败的信封也用它取 requestId / sessionId。
// 这个名字由生成器按工作流类型写死（业务 = 校验请求，网关 = 解析路由）。
const source = $('${sourceNode}').first().json || {};
// payload 是原始协议体，body 是 Webhook 原始 item 的形态；两种都兜住。
const original = (source.payload && typeof source.payload === 'object')
  ? source.payload
  : ((source.body && typeof source.body === 'object') ? source.body : source);

if (ok) {
  return { json: Object.assign({}, source, { ${BINDING_OK_FIELD}: true, ${BINDING_ERROR_FIELD}: null }) };
}

// 失败：直接给出**完整**的 v1 失败信封，由闸门送到 Respond to Webhook。
// 这里刻意不经过 common-envelope —— 多走一步就多一次「出错链路本身出错」的机会，
// 而绑定失败必须无条件返回。
const headers = source.headers || {};
const requestId = (typeof original.requestId === 'string' && original.requestId)
  ? original.requestId
  : (headers['x-urtoris-request-id'] || headers['X-Urtoris-Request-Id'] || null);
const sessionId = (typeof source.sessionId === 'string' && source.sessionId)
  ? source.sessionId
  : ((typeof original.sessionId === 'string') ? original.sessionId : null);
const executionId = ($execution && $execution.id !== undefined && $execution.id !== null) ? String($execution.id) : null;
const startedAt = Date.now();

let detail = 'HTTP ' + (status || '无响应');
if (raw.error) {
  detail = String(raw.error.message || raw.error.description || JSON.stringify(raw.error)).slice(0, 300);
} else if (payload && payload.error) {
  detail = String(typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error)).slice(0, 300);
}

return { json: {
  protocol: 'urtoris.v1', success: false, requestId: requestId, engine: 'n8n', workflow: '${workflowKey}', data: null,
  error: {
    code: '${BINDING_ERROR_CODE}',
    message: '执行绑定失败：requestId 未能绑定到 executionId，已阻止进入下游节点',
    detail: detail,
    node: '${BINDING_HTTP_NAME}',
    retryable: true
  },
  meta: { executionId: executionId, sessionId: sessionId, durationMs: Math.max(0, Date.now() - startedAt),
    attempt: 1, startedAt: startedAt, finishedAt: Date.now() },
  ${BINDING_OK_FIELD}: false, ${BINDING_ERROR_FIELD}: detail
} };
`.trim(),
    positions.code,
    {},
    ids.code,
  );

  const guard = ifNode(BINDING_GUARD_NAME, BINDING_GUARD_LEFT_VALUE, positions.if, {
    fixedId: ids.if,
  });

  return {
    nodes: [reporter, normalize, guard],
    connections: {
      [BINDING_HTTP_NAME]: { main: [[{ node: BINDING_CODE_NAME, type: 'main', index: 0 }]] },
      [BINDING_CODE_NAME]: { main: [[{ node: BINDING_GUARD_NAME, type: 'main', index: 0 }]] },
      [BINDING_GUARD_NAME]: {
        // true → 校验闸门 true 分支原来的目标（业务核心 / 网关转发）
        // false → 直接 Respond，返回归一节点给出的 BINDING_FAILED 信封
        main: [
          [{ node: onPass, type: 'main', index: 0 }],
          [{ node: 'Respond to Webhook', type: 'main', index: 0 }],
        ],
      },
    },
  };
}

// ─────────────────────────── 共享代码片段（唯一来源） ───────────────────────────

/** 请求校验：任何业务工作流的第一道关。 */
function validationCode(workflowKey) {
  return `
// ── 协议 v1 请求校验（由 tools/build-workflows.mjs 统一生成，勿手改） ──
const item = $input.first().json || {};
const body = (item.body && typeof item.body === 'object') ? item.body : item;
const headers = item.headers || {};
const headerRequestId = headers['x-urtoris-request-id'] || headers['X-Urtoris-Request-Id'] || null;
const requestId = (typeof body.requestId === 'string' && body.requestId) ? body.requestId : (headerRequestId || 'unknown');
const executionId = ($execution && $execution.id !== undefined && $execution.id !== null) ? String($execution.id) : null;
const startedAt = Date.now();
const workflow = ${JSON.stringify(workflowKey)};

const issues = [];
if (body.protocol !== 'urtoris.v1') issues.push('protocol 必须是 "urtoris.v1"，实际收到 ' + JSON.stringify(body.protocol));
if (typeof body.requestId !== 'string' || !body.requestId) issues.push('requestId 缺失');
if (typeof body.workflowId !== 'string' || !body.workflowId) issues.push('workflowId 缺失');
if (typeof body.sessionId !== 'string' || !body.sessionId) issues.push('sessionId 缺失');
if (typeof body.message !== 'string') issues.push('message 必须是字符串');
if (body.message && body.message.length > 2000) issues.push('message 超过 2000 字');

if (issues.length) {
  return { json: {
    ok: false, requestId: requestId, workflow: workflow, startedAt: startedAt, executionId: executionId,
    error: { code: 'VALIDATION_ERROR', message: '请求体不符合 urtoris.v1 协议', detail: issues.join('；'), node: '校验请求', retryable: false }
  } };
}

const context = (body.context && typeof body.context === 'object') ? body.context : {};
let llm = (context.llm && typeof context.llm === 'object') ? context.llm : null;
if (llm) {
  llm = {
    apiKey: typeof llm.apiKey === 'string' ? llm.apiKey.trim() : '',
    baseUrl: (typeof llm.baseUrl === 'string' && llm.baseUrl.trim() ? llm.baseUrl.trim() : 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\\/+$/, ''),
    model: (typeof llm.model === 'string' && llm.model.trim() ? llm.model.trim() : 'qwen-plus')
  };
}

return { json: {
  ok: true,
  requestId: body.requestId,
  workflow: workflow,
  sessionId: body.sessionId,
  message: body.message || '',
  user: body.user || { id: 'anonymous' },
  context: context,
  llm: llm,
  payload: body,
  meta: body.meta || {},
  startedAt: startedAt,
  executionId: executionId
} };
`.trim();
}

/** 节点异常 / 校验失败 → 统一的 error 对象。 */
const BUILD_ERROR_CODE = `
// ── 组装错误（由 tools/build-workflows.mjs 统一生成，勿手改） ──
const KNOWN = ['VALIDATION_ERROR','UNAUTHORIZED','FORBIDDEN','NOT_FOUND','RATE_LIMITED','TIMEOUT',
  'NETWORK_ERROR','UPSTREAM_ERROR','UPSTREAM_TIMEOUT','CREDENTIAL_MISSING','LLM_NOT_CONFIGURED',
  'LLM_ERROR','LLM_TIMEOUT','NODE_ERROR','INTENT_UNKNOWN','INTERNAL_ERROR'];

function classify(err) {
  if (!err || typeof err !== 'object') return { code: 'INTERNAL_ERROR', message: '未知错误', detail: null, node: null, retryable: true };
  if (typeof err.code === 'string' && KNOWN.indexOf(err.code) >= 0) {
    return { code: err.code, message: err.message || '执行失败', detail: err.detail || null, node: err.node || null, retryable: err.retryable !== false };
  }
  const text = String(err.message || err.description || '执行失败');
  const httpCode = Number(err.httpCode || (err.response && err.response.status) || 0);
  let code = 'NODE_ERROR';
  if (/timeout|ETIMEDOUT|ECONNABORTED|aborted/i.test(text)) code = 'UPSTREAM_TIMEOUT';
  else if (httpCode === 429) code = 'RATE_LIMITED';
  else if (httpCode === 401 || httpCode === 403) code = 'CREDENTIAL_MISSING';
  else if (httpCode >= 500) code = 'UPSTREAM_ERROR';
  else if (httpCode >= 400) code = 'UPSTREAM_ERROR';
  else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text)) code = 'NETWORK_ERROR';
  const node = (err.node && err.node.name) ? err.node.name : (err.nodeName || null);
  return { code: code, message: text, detail: httpCode ? ('HTTP ' + httpCode) : null, node: node, retryable: code !== 'NODE_ERROR' };
}

const out = [];
for (const item of $input.all()) {
  const j = item.json || {};
  const requestId = j.requestId || 'unknown';
  const workflow = j.workflow || 'unknown';
  const startedAt = j.startedAt || Date.now();
  const executionId = j.executionId || null;
  const error = classify(j.error || j);
  const mode = j.mode === 'llm' || j.mode === 'simulated' ? j.mode : 'rules';
  const degraded = typeof j.degraded === 'boolean' ? j.degraded : mode === 'simulated';
  out.push({ json: { requestId: requestId, workflow: workflow, success: false, data: null, error: error,
    startedAt: startedAt, executionId: executionId, sessionId: j.sessionId || null,
    mode: mode, degraded: degraded } });
}
if (out.length === 0) {
  out.push({ json: { requestId: 'unknown', workflow: 'unknown', success: false, data: null, startedAt: Date.now(), executionId: null,
    error: { code: 'INTERNAL_ERROR', message: '错误分支没有收到任何数据', detail: null, node: null, retryable: true } } });
}
return out;
`.trim();

/** 成功结果 → common-envelope 的入参；已经是失败形状的直接透传。 */
const BUILD_SUCCESS_CODE = `
// ── 组装成功入参（由 tools/build-workflows.mjs 统一生成，勿手改） ──
// 约定：核心节点报告失败时必须输出 { success: false, error: {...} }，
// 这里把两种形状统一成 common-envelope 能吃的入参。
const out = [];
for (const item of $input.all()) {
  const j = item.json || {};
  const requestId = j.requestId || 'unknown';
  const sessionId = j.sessionId || null;
  const workflow = j.workflow || 'unknown';
  const startedAt = typeof j.startedAt === 'number' ? j.startedAt : Date.now();
  const executionId = j.executionId || null;
  const attempt = (j.meta && typeof j.meta.attempt === 'number') ? j.meta.attempt : 1;
  const mode = j.mode === 'llm' || j.mode === 'simulated' ? j.mode : 'rules';
  const degraded = typeof j.degraded === 'boolean' ? j.degraded : mode === 'simulated';

  if (j.success === false || j.error) {
    out.push({ json: { requestId: requestId, sessionId: sessionId, workflow: workflow, success: false,
      data: null, error: j.error || { code: 'INTERNAL_ERROR', message: '未知错误' }, startedAt: startedAt,
      executionId: executionId, attempt: attempt, mode: mode, degraded: degraded } });
    continue;
  }

  const data = (j.result && typeof j.result === 'object') ? j.result : j;
  out.push({ json: { requestId: requestId, sessionId: sessionId, workflow: workflow, success: true,
    data: data, error: null, startedAt: startedAt, executionId: executionId, attempt: attempt,
    mode: mode, degraded: degraded } });
}
return out;
`.trim();

export { validationCode, BUILD_ERROR_CODE, BUILD_SUCCESS_CODE };

// ─────────────────────────────── 公共子工作流 ───────────────────────────────

/** common-auth：令牌已由 Webhook 节点的 Header Auth 挡在门外，这里做协议级校验。 */
function buildCommonAuth() {
  const nodes = [
    trigger([-260, 0]),
    code(
      '协议校验',
      `
// ── common-auth：协议级校验（边界鉴权由 Webhook 节点的 Header Auth 完成） ──
const item = $input.first().json || {};
const issues = [];
if (item.protocol !== 'urtoris.v1') issues.push('protocol 不是 urtoris.v1');
if (typeof item.requestId !== 'string' || !item.requestId) issues.push('requestId 缺失');
if (typeof item.workflowId !== 'string' || !item.workflowId) issues.push('workflowId 缺失');
if (typeof item.message !== 'string') issues.push('message 必须是字符串');
if (typeof item.sessionId !== 'string' || !item.sessionId) issues.push('sessionId 缺失');
if (typeof item.meta !== 'object' || item.meta === null) issues.push('meta 缺失');

if (issues.length) {
  return { json: { ok: false, code: 'VALIDATION_ERROR', message: '请求体不符合 urtoris.v1 协议', detail: issues.join('；'), requestId: item.requestId || 'unknown', workflowId: item.workflowId || 'unknown' } };
}
return { json: { ok: true, code: null, message: null, detail: null, requestId: item.requestId, workflowId: item.workflowId, sessionId: item.sessionId, attempt: (item.meta && item.meta.attempt) ? item.meta.attempt : 1 } };
`.trim(),
      [0, 0],
    ),
  ];
  return {
    id: IDS.commonAuth,
    name: 'common-auth · 协议校验',
    active: false,
    nodes,
    connections: {
      'When Executed by Another Workflow': {
        main: [[{ node: '协议校验', type: 'main', index: 0 }]],
      },
    },
    settings: workflowSettings(),
    meta: { urtorisRole: 'common-auth', urtorisBinding: 'legacy' },
    tags: [],
  };
}

/** common-envelope：响应信封的唯一来源。改这里，5 个工作流的返回同时变。 */
function buildCommonEnvelope() {
  const nodes = [
    trigger([-260, 0]),
    code(
      '构建信封',
      `
// ── common-envelope：v1 响应信封的唯一生成点 ──
const CATALOG = {
  VALIDATION_ERROR:   { label: '请求内容不符合协议',       retryable: false, status: 400 },
  UNAUTHORIZED:       { label: '缺少或错误的访问令牌',     retryable: false, status: 401 },
  FORBIDDEN:          { label: '令牌有效但无权调用',       retryable: false, status: 403 },
  NOT_FOUND:          { label: '找不到这个工作流',         retryable: false, status: 404 },
  RATE_LIMITED:       { label: '触发限流，请稍后重试',     retryable: true,  status: 429 },
  TIMEOUT:            { label: '工作流执行超时',           retryable: true,  status: 504 },
  NETWORK_ERROR:      { label: '无法连接下游服务',         retryable: true,  status: 502 },
  UPSTREAM_ERROR:     { label: '下游服务返回错误',         retryable: true,  status: 502 },
  UPSTREAM_TIMEOUT:   { label: '下游服务响应超时',         retryable: true,  status: 504 },
  CREDENTIAL_MISSING: { label: '外部服务凭证尚未配置',     retryable: false, status: 424 },
  LLM_NOT_CONFIGURED: { label: '尚未配置大模型密钥',       retryable: false, status: 424 },
  LLM_ERROR:          { label: '模型返回错误',             retryable: true,  status: 502 },
  LLM_TIMEOUT:        { label: '模型响应超时',             retryable: true,  status: 504 },
  NODE_ERROR:         { label: '工作流节点执行失败',       retryable: false, status: 500 },
  INTENT_UNKNOWN:     { label: '无法识别意图',             retryable: false, status: 422 },
  INTERNAL_ERROR:     { label: '引擎内部错误',             retryable: true,  status: 500 }
};

return $input.all().map((item) => {
  const j = item.json || {};
  const requestId = j.requestId || 'unknown';
  const workflow = j.workflow || 'unknown';
  const success = j.success === true;
  const startedAt = typeof j.startedAt === 'number' ? j.startedAt : Date.now();
  const finishedAt = Date.now();
  const now = Date.now();
  const durationMs = typeof j.durationMs === 'number' ? j.durationMs : Math.max(0, finishedAt - startedAt);
  const attempt = typeof j.attempt === 'number' && j.attempt > 0 ? j.attempt : 1;
  const mode = j.mode === 'llm' || j.mode === 'simulated' ? j.mode : 'rules';
  const degraded = typeof j.degraded === 'boolean' ? j.degraded : mode === 'simulated';

  const meta = {
    executionId: j.executionId ? String(j.executionId) : null,
    sessionId: j.sessionId || null,
    durationMs: durationMs,
    attempt: attempt,
    startedAt: startedAt,
    finishedAt: finishedAt
  };

  if (success) {
    return { json: { protocol: 'urtoris.v1', success: true, requestId: requestId, engine: 'n8n', workflow: workflow,
      mode: mode, degraded: degraded,
      data: (j.data && typeof j.data === 'object') ? j.data : {}, error: null, meta: meta } };
  }

  const raw = j.error || {};
  const code = CATALOG[raw.code] ? raw.code : 'INTERNAL_ERROR';
  const def = CATALOG[code];
  return { json: { protocol: 'urtoris.v1', success: false, requestId: requestId, engine: 'n8n', workflow: workflow,
    mode: mode, degraded: degraded,
    data: null,
    error: {
      code: code,
      message: raw.message || def.label,
      detail: raw.detail || null,
      node: raw.node || null,
      retryable: typeof raw.retryable === 'boolean' ? raw.retryable : def.retryable
    },
    meta: meta } };
});
`.trim(),
      [0, 0],
    ),
  ];
  return {
    id: IDS.commonEnvelope,
    name: 'common-envelope · 响应信封',
    active: false,
    nodes,
    connections: {
      'When Executed by Another Workflow': { main: [[{ node: '构建信封', type: 'main', index: 0 }]] },
    },
    settings: workflowSettings(),
    meta: { urtorisRole: 'common-envelope', urtorisBinding: 'legacy' },
    tags: [],
  };
}

/** common-llm：唯一一处真正调用大模型的地方（BYO Key，随请求透传）。 */
function buildCommonLlm() {
  const nodes = [
    trigger([-460, 0]),
    code(
      '准备模型入参',
      `
// ── common-llm：入参整理 ──
const j = $input.first().json || {};
const llm = j.llm || {};
const messages = Array.isArray(j.messages) && j.messages.length
  ? j.messages
  : [{ role: 'system', content: j.system || '你是一个严谨、简洁的中文助理。' }, { role: 'user', content: String(j.prompt || j.message || '') }];

if (!llm.apiKey) {
  return { json: { ok: false, requestId: j.requestId || 'unknown', startedAt: Date.now(), llm: llm,
    mode: 'rules', degraded: true,
    error: { code: 'LLM_NOT_CONFIGURED', message: '请求未携带 context.llm.apiKey（BYO Key）', detail: '请在使用端填入模型密钥', node: 'common-llm', retryable: false } } };
}
return { json: { ok: true, requestId: j.requestId || 'unknown', startedAt: Date.now(), llm: {
  apiKey: llm.apiKey,
  baseUrl: String(llm.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\\/+$/, ''),
  model: llm.model || 'qwen-plus'
}, messages: messages, temperature: (typeof j.temperature === 'number') ? j.temperature : 0.3, timeoutMs: j.timeoutMs || 30000,
  mode: 'llm', degraded: false } };
`.trim(),
      [-240, 0],
    ),
    ifNode('已配置密钥?', '={{ $json.ok }}', [-20, 0]),
    httpRequest(
      '调用模型',
      [200, -120],
      {
        method: 'POST',
        url: "={{ $json.llm.baseUrl + '/chat/completions' }}",
        sendHeaders: true,
        headerParameters: {
          parameters: [
            { name: 'Authorization', value: '=Bearer {{ $json.llm.apiKey }}' },
            { name: 'Content-Type', value: 'application/json' },
          ],
        },
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ model: $json.llm.model, messages: $json.messages, temperature: $json.temperature }) }}",
        options: { timeout: '={{ $json.timeoutMs }}', response: { response: { fullResponse: true } } },
      },
      { onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 500 },
    ),
    code(
      '解析模型回复',
      `
// ── common-llm：解析回复 ──
const j = $input.first().json || {};
const startedAt = j.startedAt || Date.now();
const latencyMs = Math.max(0, Date.now() - startedAt);
const body = j.body !== undefined ? j.body : j;
const choices = body && Array.isArray(body.choices) ? body.choices : [];
const content = choices.length && choices[0].message ? choices[0].message.content : null;
let text = '';
if (typeof content === 'string') text = content;
else if (Array.isArray(content)) text = content.map((p) => (p && typeof p.text === 'string') ? p.text : '').join('');

if (!text || !text.trim()) {
  return { json: { ok: false, requestId: j.requestId || 'unknown', startedAt: startedAt, latencyMs: latencyMs,
    mode: 'llm', degraded: false,
    error: { code: 'LLM_ERROR', message: '模型没有返回任何文本内容', detail: JSON.stringify(body).slice(0, 300), node: 'common-llm', retryable: true } } };
}
return { json: { ok: true, requestId: j.requestId || 'unknown', startedAt: startedAt, latencyMs: latencyMs,
  mode: 'llm', degraded: false,
  text: text.trim(), model: body.model || (j.llm ? j.llm.model : null), usage: body.usage || null,
  statusCode: j.statusCode || 200 } };
`.trim(),
      [420, -120],
    ),
    code(
      '模型错误归一',
      `
// ── common-llm：把 HTTP/网络异常映射成协议错误码 ──
// 注意：上游（准备模型入参）已经给出的协议错误码必须原样保留，
// 否则 LLM_NOT_CONFIGURED 会被重新归类成 LLM_ERROR，网站就分不出该提示什么。
const j = $input.first().json || {};
const err = j.error || {};
const startedAt = j.startedAt || Date.now();
const PASSTHROUGH = ['LLM_NOT_CONFIGURED','LLM_ERROR','LLM_TIMEOUT','CREDENTIAL_MISSING',
  'RATE_LIMITED','NETWORK_ERROR','UPSTREAM_ERROR','UPSTREAM_TIMEOUT','VALIDATION_ERROR'];

if (typeof err.code === 'string' && PASSTHROUGH.indexOf(err.code) >= 0) {
  const noKey = err.code === 'LLM_NOT_CONFIGURED';
  return { json: { ok: false, requestId: j.requestId || 'unknown', startedAt: startedAt,
    latencyMs: Math.max(0, Date.now() - startedAt),
    mode: noKey ? 'rules' : 'llm', degraded: noKey,
    error: { code: err.code, message: err.message || '模型调用失败', detail: err.detail || null,
      node: 'common-llm', retryable: err.retryable !== false } } };
}

const detail = [err.message || '', err.description || ''].filter(Boolean).join(' | ');
const status = Number(err.httpCode || 0);
let code = 'LLM_ERROR';
if (/timeout|ETIMEDOUT|ECONNABORTED|aborted|socket hang up/i.test(detail)) code = 'LLM_TIMEOUT';
else if (status === 401 || status === 403) code = 'CREDENTIAL_MISSING';
else if (status === 429) code = 'RATE_LIMITED';
else if (status >= 500) code = 'UPSTREAM_ERROR';
else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(detail)) code = 'NETWORK_ERROR';
return { json: { ok: false, requestId: j.requestId || 'unknown', startedAt: startedAt,
  latencyMs: Math.max(0, Date.now() - startedAt),
  mode: 'llm', degraded: false,
  error: { code: code, message: '模型调用失败：' + (err.message || '未知错误'), detail: detail.slice(0, 400), node: 'common-llm', retryable: code !== 'CREDENTIAL_MISSING' } } };
`.trim(),
      [420, 120],
    ),
  ];
  return {
    id: IDS.commonLlm,
    name: 'common-llm · 统一模型调用',
    active: false,
    nodes,
    connections: {
      'When Executed by Another Workflow': { main: [[{ node: '准备模型入参', type: 'main', index: 0 }]] },
      准备模型入参: { main: [[{ node: '已配置密钥?', type: 'main', index: 0 }]] },
      '已配置密钥?': {
        main: [
          [{ node: '调用模型', type: 'main', index: 0 }],
          [{ node: '模型错误归一', type: 'main', index: 0 }],
        ],
      },
      调用模型: {
        main: [
          [{ node: '解析模型回复', type: 'main', index: 0 }],
          [{ node: '模型错误归一', type: 'main', index: 0 }],
        ],
      },
    },
    settings: workflowSettings(),
    meta: { urtorisRole: 'common-llm', urtorisBinding: 'legacy' },
    tags: [],
  };
}

/** common-log：把一次执行的结局写回 Urtoris，形成可观测闭环。 */
function buildCommonLog() {
  const nodes = [
    trigger([-460, 0]),
    code(
      '构建事件',
      `
// ── common-log：把信封压成一条结构化事件 ──
return $input.all().map((item) => {
  const env = item.json || {};
  const ok = env.success === true;
  const meta = env.meta || {};
  const error = env.error || null;
  let message = ok ? 'n8n 执行完成' : 'n8n 执行失败';
  if (ok && env.data && typeof env.data.message === 'string') message = env.data.message;
  if (!ok && error && error.message) message = '[' + (error.code || 'ERROR') + '] ' + error.message;

  return { json: {
    envelope: env,
    event: {
      requestId: env.requestId || null,
      sessionId: meta.sessionId || null,
      workflow: env.workflow || null,
      executionId: meta.executionId ? String(meta.executionId) : null,
      level: ok ? 'info' : 'error',
      eventType: ok ? 'run.completed' : 'run.failed',
      node: (error && error.node) ? error.node : null,
      message: String(message).slice(0, 2000),
      payload: ok ? (env.data || null) : error,
      durationMs: typeof meta.durationMs === 'number' ? meta.durationMs : null
    }
  } };
});
`.trim(),
      [-240, 0],
    ),
    httpRequest(
      '上报 Urtoris',
      [-20, 0],
      {
        method: 'POST',
        url: `${EVENTS_URL}`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.event) }}',
        options: { timeout: 5000, response: { response: { neverError: true } } },
      },
      {
        onError: 'continueRegularOutput',
        alwaysOutputData: true,
        credentials: { httpHeaderAuth: { ...INTERNAL_CREDENTIAL } },
      },
    ),
    code(
      '返回原信封',
      `
// ── common-log：日志失败不能影响业务，原样吐回信封 ──
const source = $('构建事件').all();
return source.map((item) => ({ json: item.json.envelope || {} }));
`.trim(),
      [200, 0],
    ),
  ];
  return {
    id: IDS.commonLog,
    name: 'common-log · 执行日志上报',
    active: false,
    nodes,
    connections: {
      'When Executed by Another Workflow': { main: [[{ node: '构建事件', type: 'main', index: 0 }]] },
      构建事件: { main: [[{ node: '上报 Urtoris', type: 'main', index: 0 }]] },
      '上报 Urtoris': { main: [[{ node: '返回原信封', type: 'main', index: 0 }]] },
    },
    settings: workflowSettings(),
    meta: { urtorisRole: 'common-log', urtorisBinding: 'legacy' },
    tags: [],
  };
}

/** 全局 Error Workflow：所有正式工作流的 settings.errorWorkflow 都指向它。 */
function buildErrorHandler() {
  const nodes = [
    errorTrigger([-460, 0]),
    code(
      '提取并分类错误',
      `
// ── 全局 Error Workflow ──
// 输入来自 n8n 的 Error Trigger：{ execution: {...}, workflow: {...}, trigger: {...} }
const item = $input.first().json || {};
const execution = item.execution || {};
const workflow = item.workflow || {};
const err = execution.error || {};
const text = String(err.message || err.description || '未知错误');
const status = Number(err.httpCode || 0);

let code = 'NODE_ERROR';
if (/timeout|ETIMEDOUT|ECONNABORTED|aborted/i.test(text)) code = 'TIMEOUT';
else if (status === 429) code = 'RATE_LIMITED';
else if (status === 401 || status === 403) code = 'CREDENTIAL_MISSING';
else if (status >= 500) code = 'UPSTREAM_ERROR';
else if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i.test(text)) code = 'NETWORK_ERROR';
else if (/model|llm|openai|dashscope|qwen/i.test(text)) code = 'LLM_ERROR';

// requestId 从触发数据里捞 —— 这是全链路贯穿的关键。
// n8n 的 Error Trigger 在不同触发方式下给的字段不完全一样，
// 所以这里把已知的几个位置都试一遍，并把现场一起留下来便于排查。
const trigger = item.trigger || {};
const body = (trigger.body && typeof trigger.body === 'object') ? trigger.body : {};
const headers = (trigger.headers && typeof trigger.headers === 'object') ? trigger.headers : {};
const requestId =
  body.requestId ||
  headers['x-urtoris-request-id'] ||
  (item.requestId || null) ||
  (execution.requestId || null) ||
  null;

return { json: {
  workflowId: workflow.id || null,
  workflowName: workflow.name || '未知工作流',
  executionId: execution.id !== undefined ? String(execution.id) : null,
  executionUrl: execution.url || null,
  node: execution.lastNodeExecuted || null,
  mode: execution.mode || null,
  requestId: requestId,
  sessionId: body.sessionId || null,
  code: code,
  message: text,
  detail: String(err.stack || err.description || '').slice(0, 800),
  elapsedMs: (execution.startedAt && execution.stoppedAt) ? (new Date(execution.stoppedAt).getTime() - new Date(execution.startedAt).getTime()) : null,
  triggerKeys: Object.keys(trigger),
  triggerPreview: JSON.stringify(trigger).slice(0, 600)
} };
`.trim(),
      [-240, 0],
    ),
    httpRequest(
      '写入执行日志',
      [-20, 0],
      {
        method: 'POST',
        url: `${EVENTS_URL}`,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody:
          "={{ JSON.stringify({ requestId: $json.requestId, sessionId: $json.sessionId, workflow: $json.workflowName, executionId: $json.executionId, level: 'error', eventType: 'workflow.error', node: $json.node, message: '[' + $json.code + '] ' + $json.message, payload: $json, durationMs: $json.elapsedMs }) }}",
        options: { timeout: 5000, response: { response: { neverError: true } } },
      },
      {
        onError: 'continueRegularOutput',
        alwaysOutputData: true,
        credentials: { httpHeaderAuth: { ...INTERNAL_CREDENTIAL } },
      },
    ),
    code(
      '汇总错误摘要',
      `
// ── 排错摘要：这一段就是比赛现场你要读的东西 ──
const info = $('提取并分类错误').first().json;
const summary = [
  'Execution #' + (info.executionId || '?'),
  'Workflow: ' + info.workflowName,
  'Node: ' + (info.node || '未知'),
  'Error: ' + info.code,
  'Message: ' + info.message,
  'Elapsed: ' + (info.elapsedMs !== null ? (info.elapsedMs / 1000).toFixed(2) + ' s' : '未知'),
  'requestId: ' + (info.requestId || '未携带')
].join('\\n');
console.log('[Urtoris Global Error Handler]\\n' + summary);
return { json: { ...info, summary: summary } };
`.trim(),
      [200, 0],
    ),
  ];
  return {
    id: IDS.errorHandler,
    name: 'Urtoris Global Error Handler',
    active: true,
    nodes,
    connections: {
      'Error Trigger': { main: [[{ node: '提取并分类错误', type: 'main', index: 0 }]] },
      提取并分类错误: { main: [[{ node: '写入执行日志', type: 'main', index: 0 }]] },
      写入执行日志: { main: [[{ node: '汇总错误摘要', type: 'main', index: 0 }]] },
    },
    settings: { executionOrder: 'v1', saveDataSuccessExecution: 'all', saveDataErrorExecution: 'all' },
    meta: { urtorisRole: 'global-error-handler', urtorisBinding: 'legacy' },
    tags: [],
  };
}

// ─────────────────────────── 业务工作流骨架 ───────────────────────────

function workflowSettings(extra = {}) {
  return {
    executionOrder: 'v1',
    // ⚠️ 不要改成 'none'：n8n 2.35.7 在「不保存成功数据」时会连 execution_entity
    // 的最终状态更新一起跳过，执行行永远停在 status='running'（实测：100+ 条悬挂）。
    // 真正的磁盘控制交给 pruning（EXECUTIONS_DATA_MAX_AGE=72h / PRUNE_MAX_COUNT=2000），
    // 2000 条 × 约 8KB ≈ 16MB，对 40G 盘毫无压力。
    saveDataSuccessExecution: 'all',
    saveDataErrorExecution: 'all',
    saveExecutionProgress: false,
    saveManualExecutions: false,
    errorWorkflow: IDS.errorHandler,
    ...extra,
  };
}

/**
 * 业务工作流的统一骨架：
 *
 *   Webhook(Header Auth) → 校验请求 → 请求合法? ─┬─ ok  → [前置绑定 A→B→C] ─┬─ 绑定成功 → [业务核心] ─┐
 *                                              │                         └─ 绑定失败 → Respond（BINDING_FAILED 信封）
 *                                              └─ 否  → 组装错误 ───────────────────────────────────┤
 *                                                                                                  ├→ 归并 → 组装成功入参
 *                                         业务核心的异常输出 ───────────────────────────────────────┘
 *   → common-envelope → common-log → Respond
 *
 * 顺序不可颠倒：requestId / 协议字段校验（VALIDATION_ERROR）必须在绑定上报之前。
 * 否则 requestId 缺失的请求会先打站点 /api/n8n/events —— 绑定表被脏行污染，
 * 而且站点先看到 BINDING_FAILED、看不到真正的 VALIDATION_ERROR。
 *
 * 绑定失败的分支由 Node B 直接给出完整的 v1 失败信封，不再经过 common-envelope/common-log：
 * 闸门存在的意义就是「上游不可信时不进危险节点」，这条链路越短越可靠。
 */
function buildBusinessWorkflow(config) {
  const { id, name, path, workflowKey, coreNodes, coreConnections, legacyFrom, legacyTypes } = config;

  const entry = coreNodes.find((node) => node.__entry);
  if (!entry) throw new Error(`${id} 的业务核心缺少 __entry 节点`);

  // 业务核心的解析节点可能直接判定「这个请求我处理不了」。
  // 统一在它后面插一道闸门：解析成功才进业务分支，解析失败直接走错误信封。
  const [entryX, entryY] = entry.position;
  const gateName = '解析成功?';
  const entryTargets = coreConnections[entry.name]?.main?.[0] ?? [];
  const connections = { ...coreConnections };
  delete connections[entry.name];

  // Webhook 先建（保持原来「第一个 nid() 就是 webhook」的序号顺序），
  // 它的 id 要写进绑定上报的 triggerNodeId 里。
  const hook = webhook(`${WEBHOOK_PATH_BASE}/${path}`, [-880, 0]);
  // 绑定阶段挂在「请求合法?」的 true 分支之后；绑定成功后进入校验闸门原来的目标（业务核心入口）。
  const binding = bindingStage({
    workflowKey,
    triggerNodeId: hook.id,
    positions: { http: [-440, -280], code: [-220, -280], if: [0, -280] },
    sourceNode: '校验请求',
    onPass: entry.name,
  });

  const nodes = [
    hook,
    code('校验请求', validationCode(workflowKey), [-660, 0]),
    ifNode('请求合法?', '={{ $json.ok }}', [-440, 0]),
    ...binding.nodes,
    ...coreNodes,
    ifNode(gateName, '={{ $json.ok !== false }}', [entryX + 240, entryY + 360]),
    code('组装错误', BUILD_ERROR_CODE, [-220, 320]),
    merge('归并结果', [Math.max(entryX + 460, 260), 0]),
    code('组装成功入参', BUILD_SUCCESS_CODE, [Math.max(entryX + 680, 480), 0]),
    executeWorkflow('common-envelope', IDS.commonEnvelope, 'common-envelope · 响应信封', [
      Math.max(entryX + 900, 700),
      0,
    ]),
    executeWorkflow('common-log', IDS.commonLog, 'common-log · 执行日志上报', [
      Math.max(entryX + 1120, 920),
      0,
    ]),
    respond([Math.max(entryX + 1340, 1140), 0]),
  ];

  if (legacyTypes && legacyFrom) {
    nodes.push(...disabledOriginals(join(ROOT, legacyFrom), legacyTypes, [-880, 560]));
  }

  const allConnections = {
    Webhook: { main: [[{ node: '校验请求', type: 'main', index: 0 }]] },
    校验请求: { main: [[{ node: '请求合法?', type: 'main', index: 0 }]] },
    '请求合法?': {
      main: [
        // true → 绑定上报；false → 组装错误（VALIDATION_ERROR，保持原样）
        [{ node: BINDING_HTTP_NAME, type: 'main', index: 0 }],
        [{ node: '组装错误', type: 'main', index: 0 }],
      ],
    },
    ...binding.connections,
    [entry.name]: { main: [[{ node: gateName, type: 'main', index: 0 }]] },
    [gateName]: {
      main: [entryTargets, [{ node: '组装错误', type: 'main', index: 0 }]],
    },
    组装错误: { main: [[{ node: '归并结果', type: 'main', index: 1 }]] },
    ...connections,
    归并结果: { main: [[{ node: '组装成功入参', type: 'main', index: 0 }]] },
    组装成功入参: { main: [[{ node: 'common-envelope', type: 'main', index: 0 }]] },
    'common-envelope': { main: [[{ node: 'common-log', type: 'main', index: 0 }]] },
    'common-log': { main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]] },
  };

  return {
    id,
    name,
    active: false,
    nodes,
    connections: allConnections,
    settings: workflowSettings(),
    meta: {
      urtorisRole: 'business',
      urtorisWebhookPath: `${WEBHOOK_PATH_BASE}/${path}`,
      // prebound = 请求校验通过之后必有绑定闸门；legacy = 没有闸门的老工作流（common-* 等）。
      // 站点按这个字段决定「这次执行能不能信任 executionId 已经绑定过」。
      urtorisBinding: 'prebound',
    },
    tags: [],
  };
}

// 生成的 JSON 里不能带内部标记
function stripInternal(node) {
  const clone = { ...node };
  delete clone.__entry;
  delete clone.__errorSink;
  return clone;
}

// ─────────────────────────────── 5 个业务工作流 ───────────────────────────────

export function buildLlmSmoke() {
  const core = [
    code(
      '准备模型入参',
      `
// ── W1：Agent ↔ 大模型连通性冒烟 ──
const j = $input.first().json;
const system = [
  '你正在执行「Agent LLM 连通性冒烟测试」。',
  '请用中文回答用户的问题，控制在 120 字以内。'
].join('\\n');
return { json: { ok: true, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt,
  executionId: j.executionId, meta: j.meta,
  system: system, prompt: j.message, llm: j.llm, temperature: 0.3, timeoutMs: 30000 } };
`.trim(),
      [-220, -160],
      { __entry: true },
    ),
    executeWorkflow('common-llm', IDS.commonLlm, 'common-llm · 统一模型调用', [0, -160]),
    ifNode('模型成功?', '={{ $json.ok }}', [220, -160]),
    code(
      '整理结果',
      `
const llm = $input.first().json;
const ctx = $('校验请求').first().json;
if (!llm.ok) {
  return { json: { requestId: ctx.requestId, sessionId: ctx.sessionId, workflow: ctx.workflow, startedAt: ctx.startedAt,
    executionId: ctx.executionId, error: llm.error } };
}
return { json: { requestId: ctx.requestId, sessionId: ctx.sessionId, workflow: ctx.workflow, startedAt: ctx.startedAt,
  executionId: ctx.executionId,
  mode: 'llm', degraded: false,
  result: {
    message: llm.text,
    model: llm.model,
    latencyMs: llm.latencyMs,
    usage: llm.usage,
    llmConfigured: true,
    engine: 'n8n → common-llm'
  } } };
`.trim(),
      [440, -220],
    ),
    code(
      '透传模型错误',
      `
const llm = $input.first().json;
const ctx = $('校验请求').first().json;
if (llm.error && llm.error.code === 'LLM_NOT_CONFIGURED') {
  return { json: { requestId: ctx.requestId, sessionId: ctx.sessionId, workflow: ctx.workflow,
    startedAt: ctx.startedAt, executionId: ctx.executionId, mode: 'rules', degraded: true,
    result: {
      message: '模型密钥未配置；n8n 工作流、鉴权、执行绑定与协议链路已连通，未执行真实模型。',
      llmConfigured: false, engine: 'n8n → rules', llmError: llm.error
    } } };
}
return { json: { success: false, requestId: ctx.requestId, sessionId: ctx.sessionId, workflow: ctx.workflow,
  startedAt: ctx.startedAt, executionId: ctx.executionId, mode: 'llm', degraded: false, error: llm.error } };
`.trim(),
      [440, -60],
      { __errorSink: true },
    ),
  ];

  const connections = {
    准备模型入参: { main: [[{ node: 'common-llm', type: 'main', index: 0 }]] },
    'common-llm': { main: [[{ node: '模型成功?', type: 'main', index: 0 }]] },
    '模型成功?': {
      main: [
        [{ node: '整理结果', type: 'main', index: 0 }],
        [{ node: '透传模型错误', type: 'main', index: 0 }],
      ],
    },
    整理结果: { main: [[{ node: '归并结果', type: 'main', index: 0 }]] },
    透传模型错误: { main: [[{ node: '归并结果', type: 'main', index: 0 }]] },
  };

  return buildBusinessWorkflow({
    id: IDS.llmSmoke,
    name: 'W1 · Agent LLM 连通性冒烟',
    path: 'llm-smoke',
    workflowKey: 'llm-smoke',
    coreNodes: core,
    coreConnections: connections,
    legacyFrom: 'workflows/00-llm-test.json',
    legacyTypes: ['lmChatOpenAi', 'agent'],
  });
}

export function buildUserManager() {
  const core = [
    code(
      '提取用户信息',
      `
// ── W2：建用户 + AI 主管判断 ──
const j = $input.first().json;
const input = (j.context && j.context.input) ? j.context.input : {};
const text = j.message || '';
function pick(key, patterns) {
  if (typeof input[key] === 'string' && input[key].trim()) return input[key].trim();
  for (const re of patterns) { const m = text.match(re); if (m) return m[1].trim(); }
  return '';
}
const profile = {
  name: pick('name', [/姓名[:：\\s]*([^\\s,，。]+)/, /我是([^\\s,，。]{1,12})/]),
  email: pick('email', [/([\\w.+-]+@[\\w-]+\\.[\\w.]+)/]),
  department: pick('department', [/部门[:：\\s]*([^\\s,，。]+)/, /(研发|市场|销售|人事|财务|运维|产品)/]),
  role: pick('role', [/职位[:：\\s]*([^\\s,，。]+)/, /(主管|经理|总监|组长|CEO|CTO|工程师|专员|实习生)/i])
};
const filled = Object.keys(profile).filter((k) => profile[k]);
if (!filled.length) {
  return { json: { ok: false, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt,
    executionId: j.executionId,
    error: { code: 'VALIDATION_ERROR', message: '没能从消息或 input 里解析出任何用户信息',
      detail: '至少提供 name / email / department / role 之一', node: '提取用户信息', retryable: false } } };
}
const system = ['你在做入职资料审核。判断这位新同事是否是管理人员（主管/经理/总监/组长及以上）。',
  '只输出一行 JSON，不要任何解释：{"isManager": true|false, "reason": "一句话理由"}'].join('\\n');
const prompt = ['新同事资料：', JSON.stringify(profile, null, 2), '', '请判断他是否是管理人员。'].join('\\n');
return { json: { ok: true, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt,
  executionId: j.executionId, meta: j.meta, profile: profile, system: system, prompt: prompt,
  llm: j.llm, temperature: 0, timeoutMs: 30000 } };
`.trim(),
      [-220, -200],
      { __entry: true },
    ),
    executeWorkflow('common-llm', IDS.commonLlm, 'common-llm · 统一模型调用', [0, -260]),
    code(
      '判定职级',
      `
// ── 有 Key 用模型判定，没 Key 用规则判定（保证端到端永远跑得通） ──
const llm = $input.first().json;
const ctx = $('提取用户信息').first().json;
const profile = ctx.profile || {};
const MANAGER_WORDS = ['主管','经理','总监','组长','负责人','head','lead','manager','director','ceo','cto','vp'];
const blob = [profile.role, profile.department, ctx.prompt].filter(Boolean).join(' ').toLowerCase();
const ruleHit = MANAGER_WORDS.some((w) => blob.indexOf(w) >= 0);

let isManager = ruleHit;
let decidedBy = 'rule';
let reason = ruleHit ? '职位/部门命中管理岗关键词' : '未命中管理岗关键词';
let raw = null;

if (llm.ok && typeof llm.text === 'string') {
  const match = llm.text.match(/\\{[\\s\\S]*\\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (typeof parsed.isManager === 'boolean') {
        isManager = parsed.isManager;
        decidedBy = 'llm';
        reason = parsed.reason || reason;
        raw = parsed;
      }
    } catch (e) { /* 解析失败则退回规则判定 */ }
  }
} else if (llm.error) {
  reason = '模型不可用（' + llm.error.code + '），已用规则判定';
}

return { json: { requestId: ctx.requestId, sessionId: ctx.sessionId, workflow: ctx.workflow, startedAt: ctx.startedAt,
  executionId: ctx.executionId, profile: profile, isManager: isManager, decidedBy: decidedBy, reason: reason,
  mode: decidedBy === 'llm' ? 'llm' : 'rules', degraded: decidedBy !== 'llm',
  modelRaw: raw, llmError: llm.error || null, model: llm.model || null, latencyMs: llm.latencyMs || null } };
`.trim(),
      [220, -260],
    ),
    ifNode('是主管?', '={{ $json.isManager }}', [440, -260]),
    code(
      '加入主管频道',
      `
// ── 动作 A：邀请进主管频道 ──
// 说明：Slack / Entra ID 节点已保留为 disabled（见画布左下角），配好凭证后把这里的
// HTTP 上报换成对应节点即可，协议层与判定逻辑都不用动。
const j = $input.first().json;
return { json: { requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt,
  executionId: j.executionId,
  mode: j.mode, degraded: j.degraded,
  result: {
    message: '已把 ' + (j.profile.name || j.profile.email || '新同事') + ' 加入主管频道，并同步邀请到管理群。',
    isManager: true, decidedBy: j.decidedBy, reason: j.reason, profile: j.profile,
    actions: [{ name: 'slack.addToChannel', status: 'simulated', note: 'Slack 凭证未配置，已按协议返回动作意图' }]
  } } };
`.trim(),
      [660, -340],
    ),
    code(
      '更新个人资料',
      `
// ── 动作 B：更新个人资料 ──
const j = $input.first().json;
return { json: { requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt,
  executionId: j.executionId,
  mode: j.mode, degraded: j.degraded,
  result: {
    message: (j.profile.name || j.profile.email || '新同事') + ' 已登记为普通成员，个人资料已更新。',
    isManager: false, decidedBy: j.decidedBy, reason: j.reason, profile: j.profile,
    actions: [{ name: 'directory.updateProfile', status: 'simulated', note: '目录服务凭证未配置，已按协议返回动作意图' }]
  } } };
`.trim(),
      [660, -180],
    ),
  ];

  const connections = {
    提取用户信息: {
      main: [
        [{ node: 'common-llm', type: 'main', index: 0 }],
        [{ node: '组装错误', type: 'main', index: 0 }],
      ],
    },
    'common-llm': { main: [[{ node: '判定职级', type: 'main', index: 0 }]] },
    判定职级: { main: [[{ node: '是主管?', type: 'main', index: 0 }]] },
    '是主管?': {
      main: [
        [{ node: '加入主管频道', type: 'main', index: 0 }],
        [{ node: '更新个人资料', type: 'main', index: 0 }],
      ],
    },
    加入主管频道: { main: [[{ node: '归并结果', type: 'main', index: 0 }]] },
    更新个人资料: { main: [[{ node: '归并结果', type: 'main', index: 0 }]] },
  };

  return buildBusinessWorkflow({
    id: IDS.userManager,
    name: 'W2 · 建用户：AI 主管 Agent',
    path: 'user-manager',
    workflowKey: 'user-manager',
    coreNodes: core,
    coreConnections: connections,
    legacyFrom: 'workflows/01-create-user-manager.json',
    legacyTypes: ['slack', 'toolHttpRequest', 'memoryPostgresChat', 'lmChatAnthropic'],
  });
}

export function buildSecurityAnalysis() {
  const core = [
    code(
      '提取目标',
      `
// ── W3：从文本里提取 IP 与域名 ──
const j = $input.first().json;
const input = (j.context && j.context.input) ? j.context.input : {};
const text = [j.message || '', typeof input.target === 'string' ? input.target : ''].join(' ');
const ips = (text.match(/\\b(?:\\d{1,3}\\.){3}\\d{1,3}\\b/g) || []).filter((ip) => ip.split('.').every((p) => Number(p) <= 255));
const domains = (text.match(/\\b(?:(?!\\d+\\.\\d+\\.\\d+\\.\\d+)[a-z0-9-]+\\.)+[a-z]{2,24}\\b/gi) || [])
  .map((d) => d.toLowerCase())
  .filter((d) => d.indexOf('.') > 0 && ['com','cn','net','org','io','dev','xyz','top','info','co','me','app','site','online'].some((t) => d.endsWith('.' + t)));

const uniqueIps = Array.from(new Set(ips)).slice(0, 5);
const uniqueDomains = Array.from(new Set(domains)).slice(0, 5);
if (!uniqueIps.length && !uniqueDomains.length) {
  return { json: { ok: false, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt, executionId: j.executionId,
    error: { code: 'VALIDATION_ERROR', message: '没能在文本里找到 IP 或域名', detail: '请在消息或 context.input.target 里给出目标', node: '提取目标', retryable: false } } };
}
const items = [];
for (const ip of uniqueIps) items.push({ json: { ok: true, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt, executionId: j.executionId, kind: 'ip', target: ip } });
for (const domain of uniqueDomains) items.push({ json: { ok: true, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt, executionId: j.executionId, kind: 'domain', target: domain } });
return items;
`.trim(),
      [-220, -180],
      { __entry: true },
    ),
    switchByString('按类型分流', '={{ $json.kind }}', ['ip', 'domain'], [0, -180]),
    httpRequest(
      'IP 情报',
      [240, -300],
      {
        method: 'GET',
        url: '=http://ip-api.com/json/{{ $json.target }}?fields=status,message,country,countryCode,regionName,city,isp,org,as,proxy,hosting,mobile,query',
        options: { timeout: 8000, response: { response: { neverError: true, fullResponse: true } } },
      },
      { onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 400 },
    ),
    httpRequest(
      '域名 DNS 解析',
      [240, -60],
      {
        method: 'GET',
        // 不取 fullResponse：让 DoH 的 JSON 直接成为当前 item，
        // 下一个节点才能用 $json.Question.name 拼 RDAP 地址。
        // （取 fullResponse 会把 item 换成 {body,headers,statusCode}，target 就丢了）
        url: '=https://223.5.5.5/resolve?name={{ $json.target }}&type=A',
        options: { timeout: 8000, response: { response: { neverError: true } } },
      },
      { onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 400 },
    ),
    httpRequest(
      '域名注册信息(RDAP)',
      [460, -60],
      {
        method: 'GET',
        url: "=https://rdap.org/domain/{{ ($json.Question && $json.Question.name) ? $json.Question.name.replace(/\\.$/, '') : 'invalid.invalid' }}",
        options: {
          timeout: 10000,
          response: {
            response: {
              neverError: true,
              fullResponse: true,
              // RDAP 返回的是 application/rdap+json，自动探测认不出来，
              // 会把响应体塞进 data（字符串）而不是 body —— 必须显式指定 JSON。
              responseFormat: 'json',
            },
          },
        },
      },
      { onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 400 },
    ),
    code(
      '合并域名情报',
      `
// ── 把 DNS 与 RDAP 两个真实来源合成一条域名记录 ──
const rdapResponse = $input.first().json || {};
const dns = $('域名 DNS 解析').first().json || {};
const answers = Array.isArray(dns.Answer) ? dns.Answer.filter((a) => a.type === 1).map((a) => a.data) : [];
const rdapBody = (rdapResponse.body && typeof rdapResponse.body === 'object') ? rdapResponse.body : null;
const name = (dns.Question && dns.Question.name)
  ? String(dns.Question.name).replace(/\\.$/, '')
  : (rdapBody && rdapBody.ldhName ? String(rdapBody.ldhName).toLowerCase() : 'unknown');
return { json: { domainReport: {
  target: name,
  addresses: answers,
  dnsStatus: (typeof dns.Status === 'number') ? dns.Status : null,
  rdap: rdapBody,
  rdapStatus: rdapResponse.statusCode || null
} } };
`.trim(),
      [680, -60],
    ),
    merge('汇总情报', [920, -180]),
    code(
      '风险评分',
      `
// ── W3：真实数据 → 风险评分（全部来自上面三个真实 HTTP 调用） ──
function toList(value) {
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.items)) return value.items;
  if (value && typeof value === 'object') return Object.keys(value).map((k) => value[k]);
  return [];
}
// HTTP 节点的产出有三种可能形状：裸 body / {body,...} / {data:"json 文本",...}。
// 最后一种出现在响应头不是 application/json 的时候，必须自己解析。
function payloadOf(row) {
  let raw = row;
  if (row && typeof row === 'object') {
    if (row.body !== undefined) raw = row.body;
    else if (row.data !== undefined) raw = row.data;
  }
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  return raw && typeof raw === 'object' ? raw : {};
}
const ctx = $('提取目标').first().json;
const rows = toList($input.all().map((i) => i.json));
const results = [];
for (const row of rows) {
  const status = row.statusCode || 200;

  // 域名：DNS + RDAP 已在上游合成一条记录
  if (row.domainReport) {
    const report = row.domainReport;
    const addresses = Array.isArray(report.addresses) ? report.addresses : [];
    const rdap = report.rdap || {};
    const events = Array.isArray(rdap.events) ? rdap.events : [];
    const registration = events.find((e) => e.eventAction === 'registration');
    let ageDays = null;
    if (registration && registration.eventDate) {
      ageDays = Math.floor((Date.now() - new Date(registration.eventDate).getTime()) / 86400000);
    }
    const reasons = [];
    let score = 0;
    if (!addresses.length) { score += 20; reasons.push('没有 A 记录，域名未解析'); }
    if (ageDays !== null && ageDays < 30) { score += 45; reasons.push('域名注册不足 30 天'); }
    else if (ageDays !== null && ageDays < 180) { score += 20; reasons.push('域名注册不足半年'); }
    if (!rdap.ldhName) { score += 10; reasons.push('RDAP 未返回注册信息'); }
    results.push({ kind: 'domain', target: report.target, status: 'ok', addresses: addresses,
      dnsStatus: report.dnsStatus, registeredAt: registration ? registration.eventDate : null,
      ageDays: ageDays, registrarStatus: rdap.status || [], risk: Math.min(100, score),
      reasons: reasons.length ? reasons : ['DNS 解析正常，注册信息正常'] });
    continue;
  }

  const body = payloadOf(row);
  const target = (body && body.query) ? body.query : ((body && body.Question) ? body.Question.name.replace(/\\.$/, '') : null);
  if (body && body.status === 'success') {
    const reasons = [];
    let score = 0;
    if (body.proxy) { score += 40; reasons.push('被标记为代理出口'); }
    if (body.hosting) { score += 25; reasons.push('属于数据中心/云主机段'); }
    if (!body.country) { score += 10; reasons.push('无法归属国家'); }
    results.push({ kind: 'ip', target: body.query, status: 'ok', country: body.country, countryCode: body.countryCode,
      city: body.city, isp: body.isp, org: body.org, asn: body.as, hosting: !!body.hosting, proxy: !!body.proxy,
      risk: Math.min(100, score), reasons: reasons.length ? reasons : ['未命中已知风险特征'] });
    continue;
  }
  if (body && body.Question) {
    const answers = Array.isArray(body.Answer) ? body.Answer : [];
    const name = body.Question.name.replace(/\\.$/, '');
    const ips = answers.filter((a) => a.type === 1).map((a) => a.data);
    const reasons = [];
    let score = 0;
    if (!ips.length) { score += 20; reasons.push('没有 A 记录，域名未解析'); }
    results.push({ kind: 'domain', target: name, status: 'dns-ok', addresses: ips, risk: Math.min(100, score),
      reasons: reasons.length ? reasons : ['DNS 解析正常'] });
    continue;
  }
  if (body && body.ldhName) {
    const events = Array.isArray(body.events) ? body.events : [];
    const reg = events.find((e) => e.eventAction === 'registration');
    let ageDays = null;
    if (reg && reg.eventDate) ageDays = Math.floor((Date.now() - new Date(reg.eventDate).getTime()) / 86400000);
    const reasons = [];
    let score = 0;
    if (ageDays !== null && ageDays < 30) { score += 45; reasons.push('域名注册不足 30 天'); }
    else if (ageDays !== null && ageDays < 180) { score += 20; reasons.push('域名注册不足半年'); }
    if (Array.isArray(body.status) && body.status.length === 0) { score += 10; reasons.push('注册状态异常'); }
    results.push({ kind: 'domain-rdap', target: body.ldhName.toLowerCase(), status: 'rdap-ok', registeredAt: reg ? reg.eventDate : null,
      ageDays: ageDays, registrarStatus: body.status || [], risk: Math.min(100, score),
      reasons: reasons.length ? reasons : ['注册信息正常'] });
    continue;
  }
  results.push({ kind: 'unknown', target: target, status: 'error', httpStatus: status, risk: 30,
    reasons: ['情报接口未返回可识别数据（HTTP ' + status + '）'] });
}

const overall = results.reduce((max, r) => Math.max(max, r.risk || 0), 0);
const level = overall >= 60 ? '高' : overall >= 30 ? '中' : '低';
return { json: { requestId: ctx.requestId, sessionId: ctx.sessionId, workflow: ctx.workflow, startedAt: ctx.startedAt,
  executionId: ctx.executionId,
  result: {
    message: '已对 ' + results.length + ' 个目标完成情报采集，整体风险：' + level + '（' + overall + '/100）。',
    riskLevel: level, riskScore: overall, targets: results,
    sources: ['ip-api.com（真实 IP 情报）', '223.5.5.5（真实 DNS 解析）', 'rdap.org（真实域名注册信息）']
  } } };
`.trim(),
      [920, -180],
    ),
  ];

  const connections = {
    提取目标: {
      main: [
        [{ node: '按类型分流', type: 'main', index: 0 }],
        [{ node: '组装错误', type: 'main', index: 0 }],
      ],
    },
    按类型分流: {
      main: [
        [{ node: 'IP 情报', type: 'main', index: 0 }],
        [{ node: '域名 DNS 解析', type: 'main', index: 0 }],
      ],
    },
    'IP 情报': { main: [[{ node: '汇总情报', type: 'main', index: 0 }]] },
    '域名 DNS 解析': { main: [[{ node: '域名注册信息(RDAP)', type: 'main', index: 0 }]] },
    '域名注册信息(RDAP)': { main: [[{ node: '合并域名情报', type: 'main', index: 0 }]] },
    合并域名情报: { main: [[{ node: '汇总情报', type: 'main', index: 1 }]] },
    汇总情报: { main: [[{ node: '风险评分', type: 'main', index: 0 }]] },
    风险评分: { main: [[{ node: '归并结果', type: 'main', index: 0 }]] },
  };

  return buildBusinessWorkflow({
    id: IDS.securityAnalysis,
    name: 'W3 · 安全分析：IP/域名情报',
    path: 'security-analysis',
    workflowKey: 'security-analysis',
    coreNodes: core,
    coreConnections: connections,
    legacyFrom: 'workflows/02-security-analysis.json',
    legacyTypes: ['github', 'githubTrigger'],
  });
}

export function buildApiGateway() {
  const core = [
    code(
      '解析网关请求',
      `
// ── W4：HTTP 方法路由网关 ──
const j = $input.first().json;
const input = (j.context && j.context.input) ? j.context.input : {};
const method = String(input.method || 'GET').toUpperCase();
// 演示后端 postman-echo 的根路径只对 GET 友好，POST/DELETE 需要各自的方法路径；
// 没显式给 target 时按方法取默认路径，避免"网关看起来通了其实是 404"。
const DEFAULT_PATH = { GET: '/get', POST: '/post', DELETE: '/delete' };
const target = String(input.target || input.path || DEFAULT_PATH[method] || '/get').trim();
const base = String(input.baseUrl || 'https://postman-echo.com').replace(/\\/+$/, '');
if (['GET','POST','DELETE'].indexOf(method) < 0) {
  return { json: { ok: false, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt, executionId: j.executionId,
    error: { code: 'VALIDATION_ERROR', message: '不支持的方法 ' + method, detail: '支持 GET / POST / DELETE', node: '解析网关请求', retryable: false } } };
}
// W4 是固定的 Postman Echo 演示，不是任意 URL 代理。只比较完整 origin，
// 这样 http(s) loopback、私网 IP、userinfo、换端口和 DNS 重绑定入口都会在
// 任何 HTTP Request 节点运行之前被拒绝。
if (base !== 'https://postman-echo.com') {
  return { json: { ok: false, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt, executionId: j.executionId,
    error: { code: 'VALIDATION_ERROR', message: '网关只允许固定的 Postman Echo 演示端点', detail: 'baseUrl 已拒绝', node: '解析网关请求', retryable: false } } };
}
const expectedTarget = DEFAULT_PATH[method];
if (target !== expectedTarget) {
  return { json: { ok: false, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt, executionId: j.executionId,
    error: { code: 'VALIDATION_ERROR', message: '目标路径不在 W4 固定白名单中', detail: method + ' 只允许 ' + expectedTarget, node: '解析网关请求', retryable: false } } };
}
return { json: { ok: true, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt, executionId: j.executionId,
  method: method, url: base + expectedTarget,
  body: input.body || { from: 'urtoris', requestId: j.requestId }, note: input.note || null } };
`.trim(),
      [-220, -180],
      { __entry: true },
    ),
    switchByString('方法路由', '={{ $json.method }}', ['GET', 'POST', 'DELETE'], [0, -180]),
    httpRequest(
      'GET 读取',
      [240, -320],
      { method: 'GET', url: '={{ $json.url }}', options: { timeout: 10000, response: { response: { neverError: true, fullResponse: true } } } },
      { onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 400 },
    ),
    httpRequest(
      'POST 提交',
      [240, -160],
      {
        method: 'POST',
        url: '={{ $json.url }}',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.body) }}',
        options: { timeout: 10000, response: { response: { neverError: true, fullResponse: true } } },
      },
      { onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 400 },
    ),
    httpRequest(
      'DELETE 删除',
      [240, 0],
      { method: 'DELETE', url: '={{ $json.url }}', options: { timeout: 10000, response: { response: { neverError: true, fullResponse: true } } } },
      { onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 400 },
    ),
    merge('归并响应', [520, -180]),
    code(
      '整理响应',
      `
// ── W4：把真实往返结果整理成协议 data ──
const ctx = $('解析网关请求').first().json;
const rows = $input.all().map((i) => i.json);
const row = rows[0] || {};
let body = row;
if (row && typeof row === 'object') {
  if (row.body !== undefined) body = row.body;
  else if (row.data !== undefined) body = row.data;
}
if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* 保持原文 */ } }
const status = row.statusCode || 200;
return { json: { requestId: ctx.requestId, sessionId: ctx.sessionId, workflow: ctx.workflow, startedAt: ctx.startedAt,
  executionId: ctx.executionId,
  result: {
    message: '网关已按 ' + ctx.method + ' 转发到 ' + ctx.url + '，目标返回 HTTP ' + status + '。',
    method: ctx.method, url: ctx.url, status: status,
    upstream: body,
    routedBy: 'n8n Switch → HTTP Request'
  } } };
`.trim(),
      [740, -180],
    ),
  ];

  const connections = {
    解析网关请求: {
      main: [
        [{ node: '方法路由', type: 'main', index: 0 }],
        [{ node: '组装错误', type: 'main', index: 0 }],
      ],
    },
    方法路由: {
      main: [
        [{ node: 'GET 读取', type: 'main', index: 0 }],
        [{ node: 'POST 提交', type: 'main', index: 0 }],
        [{ node: 'DELETE 删除', type: 'main', index: 0 }],
      ],
    },
    'GET 读取': { main: [[{ node: '归并响应', type: 'main', index: 0 }]] },
    'POST 提交': { main: [[{ node: '归并响应', type: 'main', index: 1 }]] },
    'DELETE 删除': { main: [[{ node: '归并响应', type: 'main', index: 1 }]] },
    归并响应: { main: [[{ node: '整理响应', type: 'main', index: 0 }]] },
    整理响应: { main: [[{ node: '归并结果', type: 'main', index: 0 }]] },
  };

  return buildBusinessWorkflow({
    id: IDS.apiGateway,
    name: 'W4 · API 网关：HTTP 方法路由',
    path: 'api-gateway',
    workflowKey: 'api-gateway',
    coreNodes: core,
    coreConnections: connections,
    legacyFrom: 'workflows/03-proxmox-api.json',
    legacyTypes: ['noOp', 'outputParserStructured', 'outputParserAutofixing', 'toolHttpRequest', 'lmChatGoogleGemini', 'lmChatGroq'],
  });
}

export function buildCustomerInsights() {
  const core = [
    code(
      '加载评论并聚类',
      `
// ── W5：内置样本评论 → 真实 K-means 聚类 ──
// 说明：原版的 Qdrant 取数与 Google Sheets 写入节点已保留为 disabled（见画布左下角）。
// 没配这些服务时，用内置样本 + Urtoris 日志落盘，保证端到端真能跑通。
const j = $input.first().json;
const input = (j.context && j.context.input) ? j.context.input : {};
const reviews = Array.isArray(input.reviews) && input.reviews.length ? input.reviews : [
  '发货太慢了，等了五天才到', '物流信息一直不更新，客服也联系不上', '快递很快就到了，包装完好',
  '东西不错，但是发货速度还可以再快点', '配送员态度很好，提前打电话确认', '下单三天了还没发货，很失望',
  '产品质量很好，用起来很顺手', '用了两天就坏了，质量太差', '做工精细，比想象中好',
  '性价比很高，会推荐给朋友', '价格有点贵，但质量对得起', '和描述不符，有点失望',
  '客服回复很快，问题解决了', '客服态度很差，答非所问', '售后处理很及时，满意',
  '退款流程太慢了，等了一周', '申请退款很快就到账了', '包装有点简陋，东西被压坏了',
  'APP 经常闪退，体验很差', '界面很好看，操作也简单', '功能挺好用，就是偶尔卡顿',
  '登录总是失败，重置密码也没用', '更新后好用了很多，点赞', '希望增加批量导出功能'
].map((text, index) => ({ id: 'R' + String(index + 1).padStart(3, '0'), text: text }));

// 真实 K-means（k-means++ 初始化 + 3 个种子做 bagging 取最优）
function tokenize(text) {
  const dict = ['发货','物流','快递','配送','包装','态度','质量','做工','性价比','价格','客服','售后','退款','闪退','卡顿','登录','界面','功能','更新','推荐','失望','满意','快','慢'];
  const hits = dict.filter((w) => text.indexOf(w) >= 0);
  return hits.length ? hits : [text.slice(0, 2)];
}
const vocab = Array.from(new Set(reviews.flatMap((r) => tokenize(r.text))));
const vectors = reviews.map((r) => {
  const tokens = tokenize(r.text);
  const vec = vocab.map((w) => (tokens.indexOf(w) >= 0 ? 1 : 0));
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
});
const K = Math.min(4, Math.max(2, Math.round(Math.sqrt(reviews.length / 2))));

function dist2(a, b) { let s = 0; for (let i = 0; i < a.length; i += 1) { const d = a[i] - b[i]; s += d * d; } return s; }
function kmeans(seed) {
  let state = seed;
  const rnd = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff; };
  const centroids = [vectors[Math.floor(rnd() * vectors.length)].slice()];
  while (centroids.length < K) {
    const d = vectors.map((v) => Math.min.apply(null, centroids.map((c) => dist2(v, c))));
    const total = d.reduce((s, v) => s + v, 0) || 1;
    let acc = 0; const r = rnd();
    let pick = vectors.length - 1;
    for (let i = 0; i < d.length; i += 1) { acc += d[i] / total; if (acc >= r) { pick = i; break; } }
    centroids.push(vectors[pick].slice());
  }
  let assign = new Array(vectors.length).fill(0);
  for (let iter = 0; iter < 25; iter += 1) {
    let moved = false;
    for (let i = 0; i < vectors.length; i += 1) {
      let best = 0; let bestD = Infinity;
      for (let c = 0; c < centroids.length; c += 1) { const dd = dist2(vectors[i], centroids[c]); if (dd < bestD) { bestD = dd; best = c; } }
      if (assign[i] !== best) { assign[i] = best; moved = true; }
    }
    const sums = centroids.map(() => new Array(vocab.length).fill(0));
    const counts = centroids.map(() => 0);
    for (let i = 0; i < vectors.length; i += 1) { counts[assign[i]] += 1; for (let d = 0; d < vocab.length; d += 1) sums[assign[i]][d] += vectors[i][d]; }
    for (let c = 0; c < centroids.length; c += 1) {
      if (!counts[c]) continue;
      centroids[c] = sums[c].map((s) => s / counts[c]);
    }
    if (!moved) break;
  }
  let inertia = 0;
  for (let i = 0; i < vectors.length; i += 1) inertia += dist2(vectors[i], centroids[assign[i]]);
  return { assign: assign, centroids: centroids, inertia: inertia };
}

let best = null;
for (const seed of [7, 42, 2026]) {
  const run = kmeans(seed);
  if (!best || run.inertia < best.inertia) best = run;
}

const clusters = [];
for (let c = 0; c < K; c += 1) {
  const members = reviews.filter((r, i) => best.assign[i] === c);
  if (!members.length) continue;
  const weights = vocab.map((w, d) => ({ word: w, weight: best.centroids[c][d] })).sort((a, b) => b.weight - a.weight);
  clusters.push({
    id: 'cluster-' + (c + 1),
    size: members.length,
    share: Math.round((members.length / reviews.length) * 100),
    keywords: weights.slice(0, 4).filter((w) => w.weight > 0).map((w) => w.word),
    samples: members.slice(0, 3).map((m) => m.text)
  });
}
clusters.sort((a, b) => b.size - a.size);

const summaryLines = clusters.map((c, i) => (i + 1) + '. 【' + (c.keywords.join('、') || '综合') + '】' + c.size + ' 条评论，例如：' + (c.samples[0] || ''));
const prompt = ['请阅读下列客户评论聚类结果，给出 3 条可执行的产品/服务改进建议，每条一句话，用中文。',
  '', '评论总数：' + reviews.length, '聚类数：' + clusters.length, '', summaryLines.join('\\n')].join('\\n');

return { json: { ok: true, requestId: j.requestId, sessionId: j.sessionId, workflow: j.workflow, startedAt: j.startedAt,
  executionId: j.executionId, meta: j.meta, clusters: clusters, reviewCount: reviews.length, k: K,
  inertia: Math.round(best.inertia * 1000) / 1000,
  system: '你是资深的客户体验分析师，回答必须具体、可执行、不要客套。',
  prompt: prompt, llm: j.llm, temperature: 0.2, timeoutMs: 30000 } };
`.trim(),
      [-220, -200],
      { __entry: true },
    ),
    executeWorkflow('common-llm', IDS.commonLlm, 'common-llm · 统一模型调用', [0, -200]),
    code(
      '整理洞察',
      `
const llm = $input.first().json;
const ctx = $('加载评论并聚类').first().json;
let insights;
let summarizedBy = 'llm';
if (llm.ok && llm.text) {
  insights = llm.text.split('\\n').map((line) => line.replace(/^\\s*[-\\d.、]+\\s*/, '').trim()).filter(Boolean).slice(0, 6);
} else {
  summarizedBy = 'rule';
  insights = ctx.clusters.map((c) => '针对「' + (c.keywords.join('、') || '综合问题') + '」类反馈（占 ' + c.share + '%），优先排查并给出改进方案。');
}
return { json: { requestId: ctx.requestId, sessionId: ctx.sessionId, workflow: ctx.workflow, startedAt: ctx.startedAt,
  executionId: ctx.executionId,
  mode: summarizedBy === 'llm' ? 'llm' : 'rules', degraded: summarizedBy !== 'llm',
  result: {
    message: '已对 ' + ctx.reviewCount + ' 条评论完成 K-means 聚类（k=' + ctx.k + '），得到 ' + ctx.clusters.length + ' 个主题。',
    reviewCount: ctx.reviewCount, k: ctx.k, inertia: ctx.inertia, clusters: ctx.clusters,
    insights: insights, summarizedBy: summarizedBy,
    llmError: llm.error || null, model: llm.model || null,
    algorithm: 'k-means++ / 3 seeds / 25 iters（真实实现，非模拟）'
  } } };
`.trim(),
      [240, -200],
    ),
  ];

  const connections = {
    加载评论并聚类: {
      main: [
        [{ node: 'common-llm', type: 'main', index: 0 }],
        [{ node: '组装错误', type: 'main', index: 0 }],
      ],
    },
    'common-llm': { main: [[{ node: '整理洞察', type: 'main', index: 0 }]] },
    整理洞察: { main: [[{ node: '归并结果', type: 'main', index: 0 }]] },
  };

  return buildBusinessWorkflow({
    id: IDS.customerInsights,
    name: 'W5 · 客户洞察：评论聚类 + AI 总结',
    path: 'customer-insights',
    workflowKey: 'customer-insights',
    coreNodes: core,
    coreConnections: connections,
    legacyFrom: 'workflows/04-customer-insights.json',
    legacyTypes: ['googleSheets'],
  });
}

/** 统一入口网关：按 workflowId 路由到对应工作流的 webhook（零逻辑重复）。 */
export function buildGateway() {
  const routes = [
    { key: 'llm-smoke', path: 'llm-smoke', workflowId: SITE_WORKFLOW_IDS.llmSmoke },
    { key: 'user-manager', path: 'user-manager', workflowId: SITE_WORKFLOW_IDS.userManager },
    { key: 'security-analysis', path: 'security-analysis', workflowId: SITE_WORKFLOW_IDS.securityAnalysis },
    { key: 'api-gateway', path: 'api-gateway', workflowId: SITE_WORKFLOW_IDS.apiGateway },
    { key: 'customer-insights', path: 'customer-insights', workflowId: SITE_WORKFLOW_IDS.customerInsights },
  ];

  const routeMap = {};
  for (const route of routes) {
    routeMap[route.key] = { path: route.path, workflowId: route.workflowId };
  }

  // ⚠️ 网关**刻意不做前置执行绑定**（meta.urtorisBinding = 'legacy'），原因：
  //   1. 它没有协议校验链（链路是 Webhook → 解析路由 → 路由有效?），
  //      解析路由不保证 requestId 非空（仍有 'unknown' 兜底），无法满足
  //      「requestId 缺失就绝不调用站点 /api/n8n/events」；
  //   2. 它只是转发器，真正执行业务的是目标工作流自己那次执行；
  //      给网关绑定 executionId 会让 runs.execution_id 指向调度器执行，而不是真实业务执行；
  //   3. `urtoris/gateway` 不在站点的已注册工作流清单里。
  // 所以这里保持最原始的形态：Webhook → 解析路由 → 路由有效? → 转发。
  const hook = webhook(`${WEBHOOK_PATH_BASE}/gateway`, [-660, 0]);

  const nodes = [
    hook,
    code(
      '解析路由',
      `
// ── Urtoris Gateway：一个入口调用任意工作流 ──
// 关键设计：网关不复制业务逻辑；只把外部短 workflowId 归一成站点 workflowId，
// 再把请求转发给目标 webhook。这样目标工作流能建立精确绑定，其余字段保持原样。
const ROUTES = ${JSON.stringify(routeMap, null, 2)};
const item = $input.first().json || {};
const body = (item.body && typeof item.body === 'object') ? item.body : item;
const headers = item.headers || {};
const requestId = (typeof body.requestId === 'string' && body.requestId) ? body.requestId : (headers['x-urtoris-request-id'] || 'unknown');
const startedAt = Date.now();
const workflow = 'gateway';
const executionId = ($execution && $execution.id !== undefined && $execution.id !== null) ? String($execution.id) : null;

if (body.protocol !== 'urtoris.v1') {
  return { json: { requestId: requestId, workflow: workflow, startedAt: startedAt, executionId: executionId,
    error: { code: 'VALIDATION_ERROR', message: '请求体不符合 urtoris.v1 协议', detail: 'protocol=' + JSON.stringify(body.protocol), node: '解析路由', retryable: false } } };
}
const route = ROUTES[body.workflowId];
if (!route) {
  return { json: { requestId: requestId, workflow: workflow, startedAt: startedAt, executionId: executionId,
    error: { code: 'NOT_FOUND', message: '网关没有注册这个 workflowId', detail: '可用：' + Object.keys(ROUTES).join('、') + '（收到 ' + body.workflowId + '）', node: '解析路由', retryable: false } } };
}
const base = '${INTERNAL_BASE_URL}';
const payload = Object.assign({}, body, { workflowId: route.workflowId });
return { json: { requestId: requestId, sessionId: body.sessionId || null, workflow: workflow, target: route.path,
  url: base + '/webhook/urtoris/' + route.path, payload: payload, startedAt: startedAt, executionId: executionId } };
`.trim(),
      [-440, 0],
    ),
    ifNode('路由有效?', '={{ !$json.error }}', [-220, 0]),
    httpRequest(
      '转发到目标工作流',
      [0, -140],
      {
        method: 'POST',
        url: '={{ $json.url }}',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: '={{ JSON.stringify($json.payload) }}',
        options: { timeout: 38000, response: { response: { neverError: true, fullResponse: true } } },
      },
      {
        onError: 'continueErrorOutput',
        alwaysOutputData: true,
        credentials: { httpHeaderAuth: { ...WEBHOOK_CREDENTIAL } },
      },
    ),
    code(
      '透传子工作流信封',
      `
// ── 网关把子工作流的 v1 信封原样透传（网关自己不是业务方，不重新包装） ──
const j = $input.first().json;
const body = (j.body !== undefined) ? j.body : j;
if (body && body.protocol === 'urtoris.v1') return { json: body };
const ctx = $('解析路由').first().json;
return { json: { protocol: 'urtoris.v1', success: false, requestId: ctx.requestId, engine: 'n8n', workflow: 'gateway', data: null,
  error: { code: 'UPSTREAM_ERROR', message: '目标工作流没有返回协议响应', detail: JSON.stringify(body).slice(0, 400), node: '转发到目标工作流', retryable: true },
  meta: { executionId: ctx.executionId, sessionId: ctx.sessionId, durationMs: Math.max(0, Date.now() - ctx.startedAt), attempt: 1 } } };
`.trim(),
      [240, -140],
    ),
    code('组装网关错误', BUILD_ERROR_CODE, [-220, 280], { __errorSink: true }),
    executeWorkflow(
      'common-envelope',
      IDS.commonEnvelope,
      'common-envelope · 响应信封',
      [0, 280],
    ),
    merge('归并网关结果', [520, 0]),
    respond([760, 0]),
  ];

  return {
    id: IDS.gateway,
    name: 'Urtoris Gateway · 统一入口',
    active: false,
    nodes,
    connections: {
      Webhook: { main: [[{ node: '解析路由', type: 'main', index: 0 }]] },
      解析路由: { main: [[{ node: '路由有效?', type: 'main', index: 0 }]] },
      '路由有效?': {
        main: [
          [{ node: '转发到目标工作流', type: 'main', index: 0 }],
          [{ node: '组装网关错误', type: 'main', index: 0 }],
        ],
      },
      转发到目标工作流: {
        main: [
          [{ node: '透传子工作流信封', type: 'main', index: 0 }],
          [{ node: '透传子工作流信封', type: 'main', index: 0 }],
        ],
      },
      透传子工作流信封: { main: [[{ node: '归并网关结果', type: 'main', index: 0 }]] },
      组装网关错误: { main: [[{ node: 'common-envelope', type: 'main', index: 0 }]] },
      'common-envelope': { main: [[{ node: '归并网关结果', type: 'main', index: 1 }]] },
      归并网关结果: { main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]] },
    },
    settings: workflowSettings(),
    meta: {
      urtorisRole: 'gateway',
      urtorisWebhookPath: `${WEBHOOK_PATH_BASE}/gateway`,
      // 网关没有前置执行绑定：它只是转发器，真正执行业务的是目标工作流自己那次执行。
      // 站点按这个字段决定「这次执行能不能信任 executionId 已经绑定过」。
      urtorisBinding: 'legacy',
    },
    tags: [],
  };
}

// ─────────────────────────────── 输出 ───────────────────────────────

function finalize(workflow) {
  return {
    ...workflow,
    nodes: workflow.nodes.map(stripInternal),
    pinData: {},
    versionId: undefined,
    tags: workflow.tags ?? [],
  };
}

export function buildAll() {
  const workflows = [
    buildCommonAuth(),
    buildCommonLlm(),
    buildCommonEnvelope(),
    buildCommonLog(),
    buildErrorHandler(),
    buildLlmSmoke(),
    buildUserManager(),
    buildSecurityAnalysis(),
    buildApiGateway(),
    buildCustomerInsights(),
    buildGateway(),
  ].map(finalize);

  const manifest = {
    protocol: 'urtoris.v1',
    generatedBy: 'tools/build-workflows.mjs',
    webhookPathBase: WEBHOOK_PATH_BASE,
    containers: {
      authCredentialId: WEBHOOK_CREDENTIAL.id,
      authCredentialName: WEBHOOK_CREDENTIAL.name,
      internalCredentialId: INTERNAL_CREDENTIAL.id,
      internalCredentialName: INTERNAL_CREDENTIAL.name,
      internalBaseUrl: INTERNAL_BASE_URL,
      eventsUrl: EVENTS_URL,
    },
    ids: IDS,
    /** 发布顺序：必须先发 common-*，因为业务工作流引用它们；errorWorkflow 也要先存在。 */
    publishOrder: [
      IDS.commonAuth,
      IDS.commonLlm,
      IDS.commonEnvelope,
      IDS.commonLog,
      IDS.errorHandler,
      IDS.llmSmoke,
      IDS.userManager,
      IDS.securityAnalysis,
      IDS.apiGateway,
      IDS.customerInsights,
      IDS.gateway,
    ],
    workflows: workflows.map((w) => ({
      id: w.id,
      name: w.name,
      active: w.active,
      role: w.meta?.urtorisRole ?? 'business',
      webhookPath: w.meta?.urtorisWebhookPath ?? null,
      // 前置执行绑定：prebound = 请求校验通过之后必有绑定闸门；legacy = 没有闸门的老工作流。
      // 站点按这个字段决定「能不能信任 executionId 已经绑定过」。
      binding: w.meta?.urtorisBinding ?? 'legacy',
      nodeCount: w.nodes.length,
      errorWorkflow: w.settings?.errorWorkflow ?? null,
      subWorkflows: w.nodes
        .filter((n) => n.type === 'n8n-nodes-base.executeWorkflow')
        .map((n) => n.parameters.workflowId.value),
    })),
  };

  return { workflows, manifest };
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const { workflows, manifest } = buildAll();
  const written = [];
  for (const workflow of workflows) {
    const file = join(OUT, `${workflow.id}.json`);
    writeFileSync(file, `${JSON.stringify(workflow, null, 2)}\n`, 'utf8');
    written.push(file);
  }
  writeFileSync(join(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  writeFileSync(join(OUT, 'all-workflows.json'), `${JSON.stringify(workflows, null, 2)}\n`, 'utf8');

  console.log(`已生成 ${workflows.length} 个工作流 → generated/`);
  for (const workflow of workflows) {
    const role = workflow.meta?.urtorisRole ?? 'business';
    const hook = workflow.meta?.urtorisWebhookPath ? `  webhook=${workflow.meta.urtorisWebhookPath}` : '';
    console.log(`  · ${workflow.id.padEnd(34)} ${String(role).padEnd(20)} ${workflow.nodes.length} 节点${hook}`);
  }
  console.log(`\n发布顺序：${manifest.publishOrder.join(' → ')}`);
  console.log(`文件数：${written.length + 2}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
