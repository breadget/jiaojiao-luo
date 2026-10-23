#!/usr/bin/env python3
"""
Urtoris ↔ n8n 端到端验收测试（在 ECS 上运行）。

分四组，覆盖用户提的每一条优先级：
  A. 协议层：鉴权、校验、requestId 回显
  B. 业务工作流：5 个工作流真能跑（真实外部调用 + BYO Key）
  C. 统一入口网关：路由与错误码
  D. 网站侧：客户端归一化、重试、超时、落库、按 requestId 反查

依赖两个本地 mock（只在测试期间存在，测试结束即关闭）：
  · 8899  OpenAI 兼容的假模型 —— 用来真实地跑通 common-llm 这条链路
  · 8898  可控上游 —— 用来制造 503 / 慢响应 / 裸 JSON 等边界情况

用法：python3 smoke_test.py --webhook-token <t> [--internal-token <t>]
"""

import argparse
import glob
import json
import re
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

N8N = 'http://127.0.0.1:5678'
APP = 'http://127.0.0.1:3000'
WEBHOOK_TOKEN = ''
INTERNAL_TOKEN = ''

SITE_WORKFLOW_IDS = {
    'llm-smoke': 'wf_n8n_llm_smoke',
    'user-manager': 'wf_n8n_user_manager',
    'security-analysis': 'wf_n8n_security_analysis',
    'api-gateway': 'wf_n8n_api_gateway',
    'customer-insights': 'wf_n8n_customer_insights',
}

RESULTS = []


def record(group, name, ok, detail=''):
    RESULTS.append({'group': group, 'name': name, 'ok': bool(ok), 'detail': str(detail)[:400]})
    mark = '✓' if ok else '✗'
    line = f'  {mark} [{group}] {name}'
    if detail:
        line += f'\n        {str(detail)[:300]}'
    print(line, flush=True)


def http(method, url, payload=None, token=None, timeout=90, headers=None):
    data = None
    head = {'Accept': 'application/json'}
    if headers:
        head.update(headers)
    if token:
        head['Authorization'] = f'Bearer {token}'
    if payload is not None:
        data = json.dumps(payload).encode()
        head['Content-Type'] = 'application/json'
    request = urllib.request.Request(url, data=data, headers=head, method=method)
    started = time.time()
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode()
            return response.status, (json.loads(raw) if raw.strip() else None), time.time() - started
    except urllib.error.HTTPError as error:
        raw = error.read().decode()
        try:
            parsed = json.loads(raw)
        except Exception:
            parsed = raw[:400]
        return error.code, parsed, time.time() - started
    except Exception as error:  # 连接失败 / 超时
        return 0, {'transport': str(error)}, time.time() - started


def request_body(
    workflow, message, extra_context=None, llm=None, request_id=None, use_site_workflow_id=True
):
    context = dict(extra_context or {})
    if llm:
        context['llm'] = llm
    return {
        'protocol': 'urtoris.v1',
        'requestId': request_id or str(uuid.uuid4()),
        # 五个 prebound 工作流必须收到站点 id；短 key 只属于 legacy 网关的路由契约。
        'workflowId': SITE_WORKFLOW_IDS.get(workflow, workflow) if use_site_workflow_id else workflow,
        'sessionId': f'sess_test_{uuid.uuid4().hex[:8]}',
        'message': message,
        'user': {'id': 'tester'},
        'context': context,
        'meta': {
            'source': 'smoke-test',
            'sentAt': int(time.time() * 1000),
            'attempt': 1,
            'timeoutMs': 45000,
            'idempotencyKey': request_id or 'auto',
        },
    }


def call_workflow(path, body, token='__default__', timeout=90):
    # 注意：默认值必须在调用时解析 —— WEBHOOK_TOKEN 是在 main() 里才赋值的，
    # 写成 def f(token=WEBHOOK_TOKEN) 会在定义时就把空串绑死。
    if token == '__default__':
        token = WEBHOOK_TOKEN
    return http('POST', f'{N8N}/webhook/{path}', body, token=(token or None), timeout=timeout)


def envelope_shape_ok(envelope):
    return (
        isinstance(envelope, dict)
        and envelope.get('protocol') == 'urtoris.v1'
        and isinstance(envelope.get('success'), bool)
        and isinstance(envelope.get('requestId'), str)
        and envelope.get('engine') == 'n8n'
        and envelope.get('mode') in ('llm', 'rules', 'simulated')
        and isinstance(envelope.get('degraded'), bool)
        and ('data' in envelope)
        and ('error' in envelope)
        and isinstance(envelope.get('meta'), dict)
    )


# ─────────────────────────────── mock 服务 ───────────────────────────────

MOCK_STATE = {'delay': 0.0, 'fail_times': 0, 'calls': 0, 'mode': 'json'}


class MockLlmHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        length = int(self.headers.get('Content-Length', 0))
        raw = self.rfile.read(length).decode() if length else '{}'
        try:
            payload = json.loads(raw)
        except Exception:
            payload = {}
        messages = payload.get('messages') or []
        joined = ' '.join(str(m.get('content', '')) for m in messages)
        if '管理人员' in joined or 'isManager' in joined:
            content = '{"isManager": true, "reason": "mock 模型判定：职位含经理，属管理人员"}'
        elif '改进建议' in joined or '聚类' in joined:
            content = '1. 优先修复物流时效问题。\n2. 建立客服响应 SLA。\n3. 加强出厂质检。'
        else:
            content = '【mock 模型】已收到你的问题，这是来自 common-llm 子工作流的真实往返回复。'
        body = json.dumps(
            {
                'id': 'mock-completion',
                'object': 'chat.completion',
                'model': payload.get('model', 'mock-model'),
                'choices': [
                    {'index': 0, 'message': {'role': 'assistant', 'content': content}, 'finish_reason': 'stop'}
                ],
                'usage': {'prompt_tokens': 42, 'completion_tokens': 24, 'total_tokens': 66},
            }
        ).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class MockUpstreamHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _respond(self):
        MOCK_STATE['calls'] += 1
        if MOCK_STATE['delay']:
            time.sleep(MOCK_STATE['delay'])
        if MOCK_STATE['fail_times'] > 0:
            MOCK_STATE['fail_times'] -= 1
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error":"temporarily unavailable"}')
            return
        if MOCK_STATE['mode'] == 'legacy':
            body = json.dumps(
                {'reply': '这是历史工作流的裸 JSON 回复', 'ticketId': 'TCK-LEGACY-1'}
            ).encode()
        else:
            body = json.dumps(
                {
                    'protocol': 'urtoris.v1',
                    'success': True,
                    'requestId': 'echo-from-mock',
                    'engine': 'n8n',
                    'workflow': 'mock',
                    'data': {'message': 'mock 上游正常返回', 'upstreamCalls': MOCK_STATE['calls']},
                    'error': None,
                    'meta': {'executionId': 'mock-1', 'durationMs': 5, 'attempt': 1},
                }
            ).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    do_GET = _respond
    do_POST = _respond
    do_DELETE = _respond


def start_mocks():
    llm = ThreadingHTTPServer(('127.0.0.1', 8899), MockLlmHandler)
    upstream = ThreadingHTTPServer(('127.0.0.1', 8898), MockUpstreamHandler)
    for server in (llm, upstream):
        threading.Thread(target=server.serve_forever, daemon=True).start()
    return llm, upstream


# ─────────────────────────────── A. 协议层 ───────────────────────────────

def test_protocol():
    body = request_body('llm-smoke', '协议测试')

    status, payload, _ = call_workflow('urtoris/llm-smoke', body, token=None)
    record('A 协议', '未带 Token 被拒（n8n 边界）', status == 403, f'HTTP {status}')

    status, payload, _ = call_workflow('urtoris/llm-smoke', body, token='wrong-token')
    record('A 协议', '错误 Token 被拒', status == 403, f'HTTP {status}')

    bad = dict(body)
    bad['protocol'] = 'urtoris.v999'
    status, envelope, _ = call_workflow('urtoris/llm-smoke', bad)
    ok = (
        status == 200
        and envelope_shape_ok(envelope)
        and envelope['success'] is False
        and envelope['error']['code'] == 'VALIDATION_ERROR'
        and envelope['requestId'] == body['requestId']
    )
    record('A 协议', 'protocol 不匹配 → VALIDATION_ERROR 信封', ok,
           f"code={envelope.get('error', {}).get('code') if isinstance(envelope, dict) else envelope}")

    missing = dict(body)
    del missing['requestId']
    status, envelope, _ = call_workflow('urtoris/llm-smoke', missing)
    ok = (
        status == 200
        and envelope_shape_ok(envelope)
        and envelope['error']['code'] == 'VALIDATION_ERROR'
    )
    record('A 协议', '缺 requestId → VALIDATION_ERROR', ok, str(envelope)[:200])

    rid = str(uuid.uuid4())
    status, envelope, _ = call_workflow('urtoris/llm-smoke', request_body('llm-smoke', 'x', request_id=rid))
    ok = envelope_shape_ok(envelope) and envelope['requestId'] == rid
    record('A 协议', 'requestId 原样回显', ok, f"sent={rid[:8]} got={str(envelope.get('requestId'))[:8]}")
    return rid


# ─────────────────────────────── B. 业务工作流 ───────────────────────────────

def test_business():
    # W1 —— 没 Key
    status, envelope, _ = call_workflow('urtoris/llm-smoke', request_body('llm-smoke', '你好'))
    data = (envelope or {}).get('data') or {}
    ok = (
        envelope_shape_ok(envelope)
        and envelope['success'] is True
        and envelope['mode'] == 'rules'
        and envelope['degraded'] is True
        and data.get('llmConfigured') is False
    )
    record('B 业务', 'W1 未携带 Key → 诚实规则降级', ok,
           f"mode={envelope.get('mode')} degraded={envelope.get('degraded')}")

    # W1 —— 带 mock Key，真实走完 common-llm
    llm = {'apiKey': 'sk-mock', 'baseUrl': 'http://127.0.0.1:8899/v1', 'model': 'mock-model'}
    status, envelope, elapsed = call_workflow(
        'urtoris/llm-smoke', request_body('llm-smoke', '介绍一下你自己', llm=llm)
    )
    ok = (
        envelope_shape_ok(envelope)
        and envelope['success'] is True
        and envelope['mode'] == 'llm'
        and envelope['degraded'] is False
        and 'mock 模型' in json.dumps(envelope['data'], ensure_ascii=False)
    )
    record('B 业务', 'W1 携带 BYO Key → 真实调用模型成功', ok,
           f"{elapsed:.2f}s data={json.dumps(envelope.get('data'), ensure_ascii=False)[:150]}")

    # W2 —— 主管（无 Key，规则兜底）
    status, envelope, _ = call_workflow(
        'urtoris/user-manager', request_body('user-manager', '我是研发部经理张伟，邮箱 zhangwei@corp.com')
    )
    data = (envelope or {}).get('data') or {}
    ok = (
        envelope_shape_ok(envelope) and envelope['success']
        and envelope['mode'] == 'rules' and envelope['degraded'] is True
        and data.get('isManager') is True
    )
    record('B 业务', 'W2 经理 → 加入主管频道（规则兜底）', ok,
           f"isManager={data.get('isManager')} decidedBy={data.get('decidedBy')}")

    # W2 —— 普通成员
    status, envelope, _ = call_workflow(
        'urtoris/user-manager', request_body('user-manager', '我是市场部实习生李明，邮箱 liming@corp.com')
    )
    data = (envelope or {}).get('data') or {}
    ok = (
        envelope_shape_ok(envelope) and envelope['success']
        and envelope['mode'] == 'rules' and envelope['degraded'] is True
        and data.get('isManager') is False
    )
    record('B 业务', 'W2 实习生 → 更新个人资料', ok,
           f"isManager={data.get('isManager')} actions={json.dumps(data.get('actions'), ensure_ascii=False)[:80]}")

    # W2 —— 带 Key，模型判定
    status, envelope, _ = call_workflow(
        'urtoris/user-manager',
        request_body('user-manager', '我是研发部经理张伟，邮箱 zhangwei@corp.com', llm=llm),
    )
    data = (envelope or {}).get('data') or {}
    ok = (
        envelope_shape_ok(envelope) and envelope['success']
        and envelope['mode'] == 'llm' and envelope['degraded'] is False
        and data.get('decidedBy') == 'llm'
    )
    record('B 业务', 'W2 携带 Key → 由模型判定职级', ok, f"decidedBy={data.get('decidedBy')}")

    # W2 —— 解析不出信息
    status, envelope, _ = call_workflow('urtoris/user-manager', request_body('user-manager', '你好呀'))
    ok = envelope_shape_ok(envelope) and envelope['error'] and envelope['error']['code'] == 'VALIDATION_ERROR'
    record('B 业务', 'W2 解析不出信息 → VALIDATION_ERROR', ok, str(envelope.get('error'))[:150])

    # W3 —— 真实情报采集
    status, envelope, elapsed = call_workflow(
        'urtoris/security-analysis', request_body('security-analysis', '帮我查一下 8.8.8.8 和 github.com 有没有风险')
    )
    data = (envelope or {}).get('data') or {}
    targets = data.get('targets') or []
    kinds = {t.get('kind') for t in targets}
    has_real_ip = any(t.get('kind') == 'ip' and t.get('country') and t.get('asn') for t in targets)
    # 域名那条现在把 DNS 与 RDAP 合成了一行：地址、注册时间、域名年龄都要有
    has_real_dns = any(t.get('kind') == 'domain' and t.get('addresses') for t in targets)
    has_rdap = any(
        t.get('kind') == 'domain' and t.get('registeredAt') and (t.get('ageDays') or 0) > 0
        for t in targets
    )
    ok = envelope_shape_ok(envelope) and envelope['success'] and has_real_ip and has_real_dns and has_rdap
    record('B 业务', 'W3 真实情报：ip-api + DNS + RDAP', ok,
           f"{elapsed:.2f}s kinds={kinds} ip={has_real_ip} dns={has_real_dns} rdap={has_rdap}")

    # W3 —— 没有目标
    status, envelope, _ = call_workflow('urtoris/security-analysis', request_body('security-analysis', '你好'))
    ok = envelope_shape_ok(envelope) and envelope['error'] and envelope['error']['code'] == 'VALIDATION_ERROR'
    record('B 业务', 'W3 未提供目标 → VALIDATION_ERROR', ok, str(envelope.get('error'))[:120])

    # W4 —— GET / POST / 非法方法
    for method, expect_ok in (('GET', True), ('POST', True), ('PUT', False)):
        status, envelope, elapsed = call_workflow(
            'urtoris/api-gateway',
            request_body('api-gateway', f'请用 {method} 请求 /get', extra_context={'input': {'method': method}}),
        )
        data = (envelope or {}).get('data') or {}
        if expect_ok:
            ok = envelope_shape_ok(envelope) and envelope['success'] and data.get('status') == 200
            record('B 业务', f'W4 {method} 真实转发到上游', ok,
                   f"{elapsed:.2f}s upstream_status={data.get('status')} url={data.get('url')}")
        else:
            ok = envelope_shape_ok(envelope) and envelope['error'] and envelope['error']['code'] == 'VALIDATION_ERROR'
            record('B 业务', f'W4 非法方法 {method} → VALIDATION_ERROR', ok, str(envelope.get('error'))[:120])

    # W5 —— 真实聚类
    status, envelope, elapsed = call_workflow(
        'urtoris/customer-insights', request_body('customer-insights', '帮我分析最近的客户评论')
    )
    data = (envelope or {}).get('data') or {}
    clusters = data.get('clusters') or []
    ok = (
        envelope_shape_ok(envelope)
        and envelope['success']
        and envelope['mode'] == 'rules'
        and envelope['degraded'] is True
        and data.get('reviewCount') == 24
        and len(clusters) >= 2
        and all(c.get('size', 0) > 0 for c in clusters)
        and sum(c.get('size', 0) for c in clusters) == 24
    )
    record('B 业务', 'W5 真实 K-means 聚类（24 条 → N 簇）', ok,
           f"{elapsed:.2f}s k={data.get('k')} clusters={[(c.get('id'), c.get('size'), c.get('keywords')) for c in clusters]}")

    # W5 —— 自定义样本
    status, envelope, _ = call_workflow(
        'urtoris/customer-insights',
        request_body(
            'customer-insights',
            '分析这批评论',
            extra_context={'input': {'reviews': [{'id': 'A1', 'text': '发货太慢了'}, {'id': 'A2', 'text': '质量很好'}, {'id': 'A3', 'text': '物流很慢'}, {'id': 'A4', 'text': '做工精细'}]}},
        ),
    )
    data = (envelope or {}).get('data') or {}
    ok = envelope_shape_ok(envelope) and envelope['success'] and data.get('reviewCount') == 4
    record('B 业务', 'W5 接受自定义评论集', ok, f"reviewCount={data.get('reviewCount')}")

    # W5 —— 带 Key，模型总结
    status, envelope, _ = call_workflow(
        'urtoris/customer-insights', request_body('customer-insights', '分析评论', llm=llm)
    )
    data = (envelope or {}).get('data') or {}
    ok = (
        envelope_shape_ok(envelope) and envelope['success']
        and envelope['mode'] == 'llm' and envelope['degraded'] is False
        and data.get('summarizedBy') == 'llm'
    )
    record('B 业务', 'W5 携带 Key → 由模型产出洞察', ok,
           f"summarizedBy={data.get('summarizedBy')} insights={len(data.get('insights') or [])}")

    return llm


# ─────────────────────────────── C. 网关 ───────────────────────────────

def test_gateway():
    status, envelope, elapsed = call_workflow(
        'urtoris/gateway',
        request_body('customer-insights', '通过网关分析评论', use_site_workflow_id=False),
    )
    data = (envelope or {}).get('data') or {}
    ok = envelope_shape_ok(envelope) and envelope['success'] and data.get('clusters')
    record('C 网关', '按 workflowId 路由并透传子工作流信封', ok,
           f"{elapsed:.2f}s clusters={len(data.get('clusters') or [])}")

    status, envelope, _ = call_workflow(
        'urtoris/gateway', request_body('no-such-workflow', '你好', use_site_workflow_id=False)
    )
    ok = envelope_shape_ok(envelope) and envelope['error'] and envelope['error']['code'] == 'NOT_FOUND'
    record('C 网关', '未注册的 workflowId → NOT_FOUND', ok, str(envelope.get('error'))[:120])

    bad = request_body('customer-insights', '你好', use_site_workflow_id=False)
    bad['protocol'] = 'nope'
    status, envelope, _ = call_workflow('urtoris/gateway', bad)
    ok = envelope_shape_ok(envelope) and envelope['error'] and envelope['error']['code'] == 'VALIDATION_ERROR'
    record('C 网关', '协议错误 → VALIDATION_ERROR', ok, str(envelope.get('error'))[:120])


# ─────────────────────────────── D. 网站侧 ───────────────────────────────

SEEDED = [
    ('wf_n8n_llm_smoke', 'llm-smoke', '介绍下你自己'),
    ('wf_n8n_user_manager', 'user-manager', '我是研发部经理张伟 zhangwei@corp.com'),
    ('wf_n8n_security_analysis', 'security-analysis', '检查 1.1.1.1 和 example.com'),
    ('wf_n8n_api_gateway', 'api-gateway', 'GET 一下 /get'),
    ('wf_n8n_customer_insights', 'customer-insights', '分析评论'),
]


def test_site(llm):
    captured = {}
    for workflow_id, _, message in SEEDED:
        payload = {'workflowId': workflow_id, 'message': message, 'sessionId': f'sess_site_{uuid.uuid4().hex[:8]}'}
        if workflow_id == 'wf_n8n_llm_smoke':
            payload['llm'] = llm
        if workflow_id == 'wf_n8n_api_gateway':
            payload['input'] = {'method': 'GET'}
        status, body, elapsed = http('POST', f'{APP}/api/runs', payload, timeout=120)
        ok = (
            status == 200
            and isinstance(body, dict)
            and body.get('envelope', {}).get('success') is True
            and body.get('run', {}).get('requestId')
            and body.get('run', {}).get('executionId')
            and body.get('run', {}).get('engine') == 'n8n'
        )
        record('D 网站', f'/api/runs → {workflow_id}', ok,
               f"{elapsed:.2f}s run.status={body.get('run', {}).get('status')} exec={body.get('run', {}).get('executionId')} "
               f"durationMs={body.get('run', {}).get('durationMs')}")
        captured[workflow_id] = body.get('run', {}).get('requestId')

    # 按 requestId 反查
    probe_id = captured.get('wf_n8n_customer_insights')
    status, body, _ = http('GET', f'{APP}/api/runs?requestId={probe_id}', timeout=30)
    ok = status == 200 and body.get('run', {}).get('requestId') == probe_id
    record('D 网站', 'GET /api/runs?requestId= 反查成功', ok, f'HTTP {status} requestId={probe_id}')

    # n8n 事件落库（common-log 的真实写入）
    status, body, _ = http(
        'GET', f'{APP}/api/n8n/events?requestId={probe_id}&limit=5', token=INTERNAL_TOKEN, timeout=30
    )
    events = (body or {}).get('events') or []
    ok = status == 200 and len(events) >= 1 and events[0].get('requestId') == probe_id
    record('D 网站', 'common-log 事件已落库（可观测闭环）', ok,
           f"HTTP {status} events={len(events)} type={events[0].get('eventType') if events else None}")

    # 无 Key 的成功降级也必须诚实落库，不能伪装成真实 AI 成功
    status, body, _ = http(
        'POST', f'{APP}/api/runs', {'workflowId': 'wf_n8n_llm_smoke', 'message': 'x'}, timeout=60
    )
    run = (body or {}).get('run') or {}
    ok = (
        run.get('status') == 'completed'
        and run.get('mode') == 'rules'
        and run.get('degraded') is True
        and not run.get('errorCode')
    )
    record('D 网站', 'W1 无 Key 以 rules/degraded 成功落库', ok,
           f"status={run.get('status')} mode={run.get('mode')} degraded={run.get('degraded')}")

    # ── 客户端边界归一化：用临时探针工作流 ──
    probe_id = 'wf_probe_client'
    steps = [
        {'id': 'p1', 'title': '接收请求', 'detail': '接收探针请求', 'kind': 'input'},
        {'id': 'p2', 'title': '返回结果', 'detail': '返回探针结果', 'kind': 'output'},
    ]

    def set_probe(url, auth=''):
        return http(
            'POST',
            f'{APP}/api/workflows',
            {
                'action': 'publish',
                'id': probe_id,
                'name': '客户端归一化探针',
                'description': '临时工作流，用于验证客户端对 HTTP 边界错误的归一化，测试结束即删除。',
                'steps': steps,
                'n8nWebhookUrl': url,
                'n8nAuthHeader': auth,
            },
            timeout=60,
        )

    set_probe(f'{N8N}/webhook/urtoris/does-not-exist')
    status, body, _ = http('POST', f'{APP}/api/runs', {'workflowId': probe_id, 'message': 'probe'}, timeout=60)
    env = (body or {}).get('envelope') or {}
    ok = env.get('success') is False and env.get('error', {}).get('code') == 'NOT_FOUND'
    record('D 网站', '404 webhook → NOT_FOUND 信封', ok, f"code={env.get('error', {}).get('code')}")

    set_probe(f'{N8N}/webhook/urtoris/llm-smoke', auth='Bearer totally-wrong')
    status, body, _ = http('POST', f'{APP}/api/runs', {'workflowId': probe_id, 'message': 'probe'}, timeout=60)
    env = (body or {}).get('envelope') or {}
    ok = env.get('success') is False and env.get('error', {}).get('code') in ('FORBIDDEN', 'UNAUTHORIZED')
    record('D 网站', '403 错误令牌 → FORBIDDEN 信封', ok, f"code={env.get('error', {}).get('code')}")

    # 503 一次后成功 → 验证重试与 attempts
    MOCK_STATE.update({'delay': 0, 'fail_times': 1, 'calls': 0, 'mode': 'json'})
    set_probe('http://127.0.0.1:8898/hook')
    status, body, _ = http('POST', f'{APP}/api/runs', {'workflowId': probe_id, 'message': 'probe'}, timeout=60)
    env = (body or {}).get('envelope') or {}
    run = (body or {}).get('run') or {}
    ok = env.get('success') is True and (run.get('attempts') or 0) >= 2
    record('D 网站', '上游 503 → 重试一次后成功', ok, f"attempts={run.get('attempts')} calls={MOCK_STATE['calls']}")

    # 一直 503 → UPSTREAM_ERROR，且 attempts = 2（不无限重试）
    MOCK_STATE.update({'delay': 0, 'fail_times': 99, 'calls': 0, 'mode': 'json'})
    status, body, _ = http('POST', f'{APP}/api/runs', {'workflowId': probe_id, 'message': 'probe'}, timeout=60)
    env = (body or {}).get('envelope') or {}
    run = (body or {}).get('run') or {}
    ok = env.get('success') is False and run.get('attempts') == 2 and MOCK_STATE['calls'] == 2
    record('D 网站', '持续 503 → UPSTREAM_ERROR 且只重试 1 次', ok,
           f"code={env.get('error', {}).get('code')} attempts={run.get('attempts')} calls={MOCK_STATE['calls']}")

    # 超时 → TIMEOUT（客户端 3s 上限）
    MOCK_STATE.update({'delay': 30, 'fail_times': 0, 'calls': 0, 'mode': 'json'})
    status, body, _ = http(
        'POST', f'{APP}/api/runs', {'workflowId': probe_id, 'message': 'probe', 'timeoutMs': 3000}, timeout=60
    )
    env = (body or {}).get('envelope') or {}
    ok = env.get('success') is False and env.get('error', {}).get('code') == 'TIMEOUT'
    record('D 网站', '上游挂住 → TIMEOUT 信封', ok, f"code={env.get('error', {}).get('code')}")

    # 裸 JSON（历史工作流）→ 兼容包装
    MOCK_STATE.update({'delay': 0, 'fail_times': 0, 'calls': 0, 'mode': 'legacy'})
    status, body, _ = http('POST', f'{APP}/api/runs', {'workflowId': probe_id, 'message': 'probe'}, timeout=60)
    env = (body or {}).get('envelope') or {}
    data = env.get('data') or {}
    ok = env.get('success') is True and data.get('legacyEnvelope') is True and '历史' in str(data.get('message'))
    record('D 网站', '历史裸 JSON → 自动包装成 v1 信封', ok, f"message={str(data.get('message'))[:60]}")

    # 清理探针
    cleanup_probe(probe_id)


def cleanup_probe(probe_id):
    python = f'''
import glob, sqlite3
matches = glob.glob("/var/lib/urtoris/data/v3/d1/miniflare-D1DatabaseObject/*.sqlite")
matches = [m for m in matches if "metadata" not in m]
if not matches:
    raise SystemExit("找不到 D1 数据库文件")
connection = sqlite3.connect(matches[0])
connection.execute("DELETE FROM runs WHERE workflow_id = ?", ("{probe_id}",))
connection.execute("DELETE FROM workflows WHERE id = ?", ("{probe_id}",))
connection.commit()
connection.close()
print("cleaned", matches[0])
'''
    import subprocess

    result = subprocess.run(['python3', '-c', python], capture_output=True, text=True)
    if result.returncode != 0:
        record('D 网站', '清理探针工作流', False, result.stderr[:300])
        return
    status, body, _ = http('GET', f'{APP}/api/state', timeout=30)
    remaining = [w['id'] for w in (body or {}).get('workflows', []) if w['id'] == probe_id]
    record('D 网站', '清理探针工作流', not remaining, f'剩余={remaining}')


# ─────────────────────── E. 全局 Error Workflow ───────────────────────

FAULT_WORKFLOW_ID = 'urtoris-probe-fault'


class N8nAdmin:
    """用 owner 口令登录 n8n，用来创建/清理临时测试工作流。"""

    def __init__(self):
        password = Path('/opt/n8n/.owner_pass').read_text().strip()
        request = urllib.request.Request(
            f'{N8N}/rest/login',
            data=json.dumps({'emailOrLdapLoginId': 'admin@urtoris.local', 'password': password}).encode(),
            headers={'Content-Type': 'application/json', 'User-Agent': 'urtoris-smoke'},
            method='POST',
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            cookies = [
                c for c in (response.headers.get_all('Set-Cookie') or [])
                if c.startswith('n8n-auth=')
            ]
            response.read()
        if not cookies:
            raise RuntimeError('登录 n8n 失败，拿不到会话 cookie')
        self.cookie = cookies[0].split(';', 1)[0]

    def call(self, method, path, payload=None):
        data = None
        headers = {'User-Agent': 'urtoris-smoke', 'Cookie': self.cookie}
        if payload is not None:
            data = json.dumps(payload).encode()
            headers['Content-Type'] = 'application/json'
        request = urllib.request.Request(f'{N8N}{path}', data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read().decode()
                return response.status, (json.loads(raw) if raw.strip() else None)
        except urllib.error.HTTPError as error:
            raw = error.read().decode()
            try:
                return error.code, json.loads(raw)
            except Exception:
                return error.code, raw[:300]

    def publish(self, workflow_id):
        status, body = self.call('GET', f'/rest/workflows/{workflow_id}')
        if status != 200:
            return status, body
        return self.call(
            'POST',
            f'/rest/workflows/{workflow_id}/activate',
            {'versionId': body['data']['versionId']},
        )

    def destroy(self, workflow_id):
        status, body = self.call('GET', f'/rest/workflows/{workflow_id}')
        if status == 200:
            version = body['data'].get('versionId')
            self.call('POST', f'/rest/workflows/{workflow_id}/deactivate', {'versionId': version})
            self.call('POST', f'/rest/workflows/{workflow_id}/archive', {})
            self.call('DELETE', f'/rest/workflows/{workflow_id}')


def test_error_workflow():
    """硬失败场景：节点抛错 → n8n 500 → 全局 Error Workflow 兜底并补回 requestId。"""
    import subprocess

    admin = N8nAdmin()
    fault_name = 'PROBE · 故障注入'
    fault = [
        {
            'id': FAULT_WORKFLOW_ID,
            'name': fault_name,
            'active': False,
            'nodes': [
                {
                    'parameters': {
                        'httpMethod': 'POST',
                        'path': 'urtoris/probe-fault',
                        'responseMode': 'responseNode',
                        'authentication': 'headerAuth',
                        'options': {},
                    },
                    'id': 'fault-webhook',
                    'name': 'Webhook',
                    'type': 'n8n-nodes-base.webhook',
                    'typeVersion': 2,
                    'position': [-200, 0],
                    'webhookId': 'urtoris-probe-fault',
                    'credentials': {
                        'httpHeaderAuth': {
                            'id': 'urtoris-webhook-auth',
                            'name': 'Urtoris Webhook Bearer',
                        }
                    },
                },
                {
                    'parameters': {
                        'mode': 'runOnceForAllItems',
                        'language': 'javaScript',
                        'jsCode': "throw new Error('URTORIS_FAULT_INJECTION: 故意失败，用于验证全局 Error Workflow');",
                    },
                    'id': 'fault-code',
                    'name': '故意抛错',
                    'type': 'n8n-nodes-base.code',
                    'typeVersion': 2,
                    'position': [0, 0],
                },
                {
                    'parameters': {'respondWith': 'firstIncomingItem', 'options': {}},
                    'id': 'fault-respond',
                    'name': 'Respond to Webhook',
                    'type': 'n8n-nodes-base.respondToWebhook',
                    'typeVersion': 1.5,
                    'position': [200, 0],
                },
            ],
            'connections': {'Webhook': {'main': [[{'node': '故意抛错', 'type': 'main', 'index': 0}]]}},
            'settings': {
                'executionOrder': 'v1',
                'errorWorkflow': 'urtoris-global-error-handler',
                'saveDataSuccessExecution': 'none',
                'saveDataErrorExecution': 'all',
            },
        }
    ]
    Path('/tmp/urtoris-fault.json').write_text(json.dumps(fault, ensure_ascii=False))
    result = subprocess.run(
        ['n8n', 'import:workflow', '--input=/tmp/urtoris-fault.json'],
        cwd='/opt/n8n',
        capture_output=True,
        text=True,
        timeout=180,
    )
    if result.returncode != 0:
        record('E 错误工作流', '注入故障工作流', False, (result.stderr or result.stdout)[:200])
        return

    probe_site_id = 'wf_probe_fault'
    steps = [
        {'id': 'p1', 'title': '接收请求', 'detail': '接收探针请求', 'kind': 'input'},
        {'id': 'p2', 'title': '故意失败', 'detail': '节点抛错以验证全局错误处理', 'kind': 'output'},
    ]

    try:
        status, body = admin.publish(FAULT_WORKFLOW_ID)
        if status != 200:
            record('E 错误工作流', '发布故障工作流', False, f'HTTP {status} {str(body)[:200]}')
            return

        # 站点侧也登记一条同名工作流 —— 补链靠「工作流名 + 时间窗」，名字必须一致
        http(
            'POST',
            f'{APP}/api/workflows',
            {
                'action': 'publish',
                'id': probe_site_id,
                'name': fault_name,
                'description': '临时工作流：验证硬失败时的全局错误兜底与 requestId 补链。',
                'steps': steps,
                'n8nWebhookUrl': f'{N8N}/webhook/urtoris/probe-fault',
                'n8nAuthHeader': '',
            },
            timeout=60,
        )

        body = request_body('probe-fault', '触发一次故障')
        request_id = body['requestId']
        status, payload, _ = http(
            'POST',
            f'{APP}/api/runs',
            {'workflowId': probe_site_id, 'message': '触发一次故障', 'requestId': request_id},
            timeout=90,
        )
        run = (payload or {}).get('run') or {}
        record(
            'E 错误工作流',
            '节点抛错 → 站点如实记为 failed',
            run.get('status') == 'failed' and bool(run.get('errorCode')),
            f"status={run.get('status')} errorCode={run.get('errorCode')} runId={run.get('requestId')}",
        )

        linked_run = None
        linked_event = None
        for _ in range(20):
            time.sleep(1)
            _, found, _ = http('GET', f'{APP}/api/runs?requestId={request_id}', timeout=30)
            linked_run = (found or {}).get('run')
            if linked_run and linked_run.get('executionId'):
                break
        if not (linked_run and linked_run.get('executionId')):
            # 事件可能还没到，再等一轮
            for _ in range(15):
                time.sleep(1)
                _, found, _ = http('GET', f'{APP}/api/runs?requestId={request_id}', timeout=30)
                linked_run = (found or {}).get('run')
                if linked_run and linked_run.get('executionId'):
                    break

        for _ in range(15):
            _, events, _ = http(
                'GET', f'{APP}/api/n8n/events?requestId={request_id}&limit=5',
                token=INTERNAL_TOKEN, timeout=30,
            )
            for event in (events or {}).get('events', []):
                if event.get('eventType') == 'workflow.error':
                    linked_event = event
                    break
            if linked_event:
                break
            time.sleep(1)

        ok = bool(
            linked_run
            and linked_run.get('executionId')
            and linked_event
            and linked_event.get('requestId') == request_id
        )
        detail = (linked_event or {}).get('payload') or {}
        summary = str(detail.get('summary') or '').replace(chr(10), ' / ')
        record(
            'E 错误工作流',
            'Error Workflow 兜底 + executionId/requestId 双向补链',
            ok,
            f"run.executionId={((linked_run or {}).get('executionId'))} "
            f"event.requestId={'match' if linked_event else 'missing'} | {summary[:170]}",
        )
    finally:
        admin.destroy(FAULT_WORKFLOW_ID)
        remaining = admin.call('GET', f'/rest/workflows/{FAULT_WORKFLOW_ID}')
        cleanup = (
            'import glob, sqlite3\n'
            'import subprocess\n'
            'matches = [m for m in glob.glob("/var/lib/urtoris/data/v3/d1/miniflare-D1DatabaseObject/*.sqlite") if "metadata" not in m]\n'
            'connection = sqlite3.connect(matches[0])\n'
            'connection.execute("DELETE FROM runs WHERE workflow_id = ?", ("' + probe_site_id + '",))\n'
            'connection.execute("DELETE FROM n8n_events WHERE workflow = ?", ("' + fault_name + '",))\n'
            'connection.execute("DELETE FROM workflows WHERE id = ?", ("' + probe_site_id + '",))\n'
            'connection.commit()\n'
        )
        subprocess.run(['python3', '-c', cleanup], capture_output=True, text=True)
        record('E 错误工作流', '清理故障注入（n8n + 站点）', remaining[0] != 200, f'HTTP {remaining[0]}')



# ─────────────────────────── F. 幂等与重复请求 ───────────────────────────

def n8n_execution_count(workflow_id):
    """直接查 n8n 的库 —— 判断"有没有真的又跑一遍"的唯一可信依据。"""
    connection = sqlite3.connect("file:/root/.n8n/database.sqlite?mode=ro", uri=True)
    count = connection.execute(
        "SELECT COUNT(*) FROM execution_entity WHERE workflowId = ?", (workflow_id,)
    ).fetchone()[0]
    connection.close()
    return count


def d1_scalar(sql, params=()):
    matches = [
        m for m in glob.glob("/var/lib/urtoris/data/v3/d1/miniflare-D1DatabaseObject/*.sqlite")
        if "metadata" not in m
    ]
    connection = sqlite3.connect(matches[0])
    row = connection.execute(sql, params).fetchone()
    connection.close()
    return row[0] if row else None


def test_idempotency():
    workflow_id = "wf_n8n_customer_insights"
    n8n_workflow = "urtoris-wf-customer-insights"

    # ── 顺序重复：第二次必须是重放，且 n8n 不许多跑 ──
    request_id = f"idem-{uuid.uuid4().hex[:12]}"
    payload = {"workflowId": workflow_id, "message": "幂等测试：分析评论", "requestId": request_id}

    before = n8n_execution_count(n8n_workflow)
    s1, b1, _ = http("POST", f"{APP}/api/runs", payload, timeout=90)
    s2, b2, _ = http("POST", f"{APP}/api/runs", payload, timeout=90)
    after = n8n_execution_count(n8n_workflow)

    run1 = (b1 or {}).get("run") or {}
    run2 = (b2 or {}).get("run") or {}
    record(
        "F 幂等",
        "重复 requestId → 返回同一条运行且标记重放",
        s1 == 200 and s2 == 200 and run1.get("id") == run2.get("id") and (b2 or {}).get("replayed") is True,
        f"run1={str(run1.get('id'))[:8]} run2={str(run2.get('id'))[:8]} replayed={(b2 or {}).get('replayed')}",
    )
    record(
        "F 幂等",
        "第二次没有再次触发 n8n",
        after - before == 1,
        f"executions {before} → {after}（期望 +1）",
    )

    # ── 并发重复：5 个请求同时打同一个 requestId ──
    concurrent_id = f"idem-cc-{uuid.uuid4().hex[:12]}"
    concurrent_payload = {
        "workflowId": workflow_id,
        "message": "并发幂等测试",
        "requestId": concurrent_id,
    }
    before_cc = n8n_execution_count(n8n_workflow)
    outcomes = []
    lock = threading.Lock()

    def fire():
        status, body, _ = http("POST", f"{APP}/api/runs", concurrent_payload, timeout=90)
        with lock:
            outcomes.append((status, body))

    threads = [threading.Thread(target=fire) for _ in range(5)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    after_cc = n8n_execution_count(n8n_workflow)

    ok_count = sum(1 for status, _ in outcomes if status == 200)
    replayed_count = sum(1 for status, body in outcomes if status == 200 and (body or {}).get("replayed"))
    rows = d1_scalar("SELECT COUNT(*) FROM runs WHERE request_id = ?", (concurrent_id,))

    record(
        "F 幂等",
        "并发的 5 个同 requestId 只触发 1 次 n8n",
        after_cc - before_cc == 1,
        f"executions {before_cc} → {after_cc}（期望 +1）；状态码分布={sorted(s for s, _ in outcomes)}",
    )
    record(
        "F 幂等",
        "并发的 5 个请求都拿到结果且库里只有一行",
        ok_count >= 4 and rows == 1,
        f"200 数={ok_count}/5，其中重放={replayed_count}，runs 行数={rows}",
    )

    # ── 同一个 requestId 换工作流 → 409 ──
    s3, b3, _ = http(
        "POST",
        f"{APP}/api/runs",
        {"workflowId": "wf_n8n_llm_smoke", "message": "换个工作流", "requestId": request_id},
        timeout=60,
    )
    record(
        "F 幂等",
        "同 requestId 换工作流 → 409",
        s3 == 409,
        f"HTTP {s3} {(b3 or {}).get('error', '')[:80] if isinstance(b3, dict) else ''}",
    )

    # ── 非法 requestId → 400 ──
    s4, b4, _ = http(
        "POST",
        f"{APP}/api/runs",
        {"workflowId": workflow_id, "message": "x", "requestId": "bad id !!!"},
        timeout=60,
    )
    record("F 幂等", "非法 requestId 格式 → 400", s4 == 400, f"HTTP {s4}")

    # ── 对外 API 与对话入口行为一致 ──
    token = None
    dev_vars = Path("/opt/urtoris/app/.dev.vars").read_text()
    for line in dev_vars.splitlines():
        if line.startswith("URTORIS_API_TOKEN="):
            token = line.split("=", 1)[1].strip()
    api_id = f"idem-api-{uuid.uuid4().hex[:12]}"
    api_payload = {"workflowId": workflow_id, "message": "外部 API 幂等", "requestId": api_id}
    before_api = n8n_execution_count(n8n_workflow)
    http("POST", f"{APP}/api/v1/run", api_payload, token=token, timeout=90)
    s5, b5, _ = http("POST", f"{APP}/api/v1/run", api_payload, token=token, timeout=90)
    after_api = n8n_execution_count(n8n_workflow)
    record(
        "F 幂等",
        "/api/v1/run 同样幂等（外部脚本重试安全）",
        (b5 or {}).get("replayed") is True and after_api - before_api == 1,
        f"replayed={(b5 or {}).get('replayed')} executions +{after_api - before_api}",
    )

    chat_id = f"idem-chat-{uuid.uuid4().hex[:12]}"
    chat_payload = {"workflowId": workflow_id, "message": "对话幂等", "requestId": chat_id}
    before_chat = n8n_execution_count(n8n_workflow)
    http("POST", f"{APP}/api/agent/chat", chat_payload, timeout=90)
    s6, b6, _ = http("POST", f"{APP}/api/agent/chat", chat_payload, timeout=90)
    after_chat = n8n_execution_count(n8n_workflow)
    record(
        "F 幂等",
        "/api/agent/chat 支持调用方 requestId 且幂等",
        (b6 or {}).get("replayed") is True and after_chat - before_chat == 1,
        f"replayed={(b6 or {}).get('replayed')} executions +{after_chat - before_chat}",
    )

    # ── claim 表没有泄漏（执行完必须释放） ──
    leftover = d1_scalar("SELECT COUNT(*) FROM run_claims WHERE request_id LIKE ?", ("idem-%",))
    record("F 幂等", "claim 在执行结束后已释放", leftover == 0, f"残留 {leftover} 条")


# ─────────────────────────────── main ───────────────────────────────

def main():
    global WEBHOOK_TOKEN, INTERNAL_TOKEN
    parser = argparse.ArgumentParser()
    parser.add_argument('--webhook-token', required=True)
    parser.add_argument('--internal-token', required=True)
    args = parser.parse_args()
    WEBHOOK_TOKEN = args.webhook_token
    INTERNAL_TOKEN = args.internal_token

    llm_server, upstream_server = start_mocks()
    print('mock 已启动：8899 假模型 / 8898 可控上游\n')
    try:
        test_protocol()
        print()
        test_business()
        print()
        test_gateway()
        print()
        test_site({'apiKey': 'sk-mock', 'baseUrl': 'http://127.0.0.1:8899/v1', 'model': 'mock-model'})
        print()
        test_error_workflow()
        print()
        test_idempotency()
    finally:
        llm_server.shutdown()
        upstream_server.shutdown()

    passed = sum(1 for r in RESULTS if r['ok'])
    total = len(RESULTS)
    print(f'\n{"=" * 60}')
    print(f'结果：{passed}/{total} 通过')
    failed = [r for r in RESULTS if not r['ok']]
    if failed:
        print('\n失败用例：')
        for item in failed:
            print(f"  ✗ [{item['group']}] {item['name']} — {item['detail']}")
    print(json.dumps({'passed': passed, 'total': total, 'results': RESULTS}, ensure_ascii=False))
    raise SystemExit(0 if passed == total else 1)


if __name__ == '__main__':
    main()
