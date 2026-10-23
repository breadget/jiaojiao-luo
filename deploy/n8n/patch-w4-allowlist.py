#!/usr/bin/env python3
"""Restrict W4 to the fixed Postman Echo demo origin and method paths."""

from __future__ import annotations

import argparse
import json
import pathlib


WORKFLOW_ID = 'urtoris-wf-api-gateway'
NODE_NAME = '解析网关请求'
HTTP_NODES = {'GET 读取', 'POST 提交', 'DELETE 删除'}

W4_CODE = r"""// URTORIS_W4_ALLOWLIST_V1
const j = $input.first().json;
const input = (j.context && j.context.input) ? j.context.input : {};
const method = String(input.method || 'GET').toUpperCase();
const allowedOrigin = 'https://postman-echo.com';
const allowedPath = { GET: '/get', POST: '/post', DELETE: '/delete' };

function reject(message, detail) {
  return { json: {
    ok: false,
    requestId: j.requestId,
    sessionId: j.sessionId,
    workflow: j.workflow,
    startedAt: j.startedAt,
    executionId: j.executionId,
    error: {
      code: 'VALIDATION_ERROR',
      message,
      detail,
      node: '解析网关请求',
      retryable: false,
    },
  } };
}

if (!Object.hasOwn(allowedPath, method)) {
  return reject('不支持的方法 ' + method, '支持 GET / POST / DELETE');
}

const rawBase = String(input.baseUrl || allowedOrigin).trim();
// n8n Code nodes do not expose the browser URL constructor in every runtime.
// Exact string matching is also stricter here: it rejects credentials, ports,
// alternate paths, query strings, fragments, and redirect endpoints at once.
if (rawBase !== allowedOrigin && rawBase !== allowedOrigin + '/') {
  return reject(
    '网关目标不在允许列表',
    '比赛演示仅允许 https://postman-echo.com',
  );
}

const expectedPath = allowedPath[method];
const requestedPath = String(input.target || input.path || expectedPath).trim();
if (requestedPath !== expectedPath) {
  return reject(
    '网关路径不在允许列表',
    method + ' 仅允许 ' + expectedPath,
  );
}

return { json: {
  ok: true,
  requestId: j.requestId,
  sessionId: j.sessionId,
  workflow: j.workflow,
  startedAt: j.startedAt,
  executionId: j.executionId,
  method,
  url: allowedOrigin + expectedPath,
  body: input.body || { from: 'urtoris', requestId: j.requestId },
  note: input.note || null,
} };
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=pathlib.Path)
    parser.add_argument('output', type=pathlib.Path)
    args = parser.parse_args()

    raw = json.loads(args.source.read_text())
    workflows = raw if isinstance(raw, list) else [raw]
    if len(workflows) != 1 or workflows[0].get('id') != WORKFLOW_ID:
        raise ValueError(f'expected exactly workflow {WORKFLOW_ID}')

    workflow = workflows[0]
    matches = [node for node in workflow['nodes'] if node.get('name') == NODE_NAME]
    if len(matches) != 1:
        raise ValueError(f'expected exactly one node named {NODE_NAME}')
    matches[0].setdefault('parameters', {})['jsCode'] = W4_CODE

    http_nodes = {
        node.get('name'): node
        for node in workflow['nodes']
        if node.get('name') in HTTP_NODES
    }
    if set(http_nodes) != HTTP_NODES:
        raise ValueError('missing one or more W4 HTTP method nodes')
    for name, node in http_nodes.items():
        parameters = node.get('parameters', {})
        if parameters.get('url') != '={{ $json.url }}':
            raise ValueError(f'{name}: URL must come from the validated item')
        timeout = parameters.get('options', {}).get('timeout')
        if not isinstance(timeout, int) or timeout > 10_000:
            raise ValueError(f'{name}: timeout must be an integer <= 10000 ms')

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + '\n')
    args.output.chmod(0o600)
    print(json.dumps({'ok': True, 'workflowId': WORKFLOW_ID, 'output': str(args.output)}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
