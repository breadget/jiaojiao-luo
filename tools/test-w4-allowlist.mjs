#!/usr/bin/env node
/** W4 must remain a fixed demo endpoint, never an arbitrary URL proxy. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
execFileSync(process.execPath, [join(here, 'build-workflows.mjs')], {
  stdio: 'pipe',
});

const workflow = JSON.parse(
  readFileSync(join(root, 'generated', 'urtoris-wf-api-gateway.json'), 'utf8'),
);
const parser = workflow.nodes.find((node) => node.name === '解析网关请求');
assert.equal(parser?.type, 'n8n-nodes-base.code');

function execute(input) {
  const $input = {
    first: () => ({
      json: {
        requestId: 'req-w4-allowlist',
        sessionId: 'session-w4-allowlist',
        workflow: 'api-gateway',
        startedAt: 1,
        executionId: '77',
        context: { input },
      },
    }),
  };
  return new Function('$input', parser.parameters.jsCode)($input).json;
}

let assertions = 0;
function allowed(method, path) {
  const result = execute({
    method,
    baseUrl: 'https://postman-echo.com',
    target: path,
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, method);
  assert.equal(result.url, `https://postman-echo.com${path}`);
  assertions += 3;
}

function blocked(label, input) {
  const result = execute(input);
  assert.equal(result.ok, false, `${label} was allowed`);
  assert.equal(result.error?.code, 'VALIDATION_ERROR', label);
  assert.equal(result.error?.node, '解析网关请求', label);
  assertions += 3;
}

allowed('GET', '/get');
allowed('POST', '/post');
allowed('DELETE', '/delete');

for (const [label, baseUrl] of [
  ['HTTP public origin', 'http://example.com'],
  ['HTTP loopback', 'http://127.0.0.1:3000'],
  ['HTTPS loopback', 'https://127.0.0.1'],
  ['localhost', 'https://localhost'],
  ['private IPv4', 'https://10.0.0.1'],
  ['link-local metadata', 'https://169.254.169.254'],
  ['userinfo host confusion', 'https://postman-echo.com@127.0.0.1'],
  ['alternate port', 'https://postman-echo.com:8443'],
  ['base path', 'https://postman-echo.com/admin'],
  ['arbitrary HTTPS origin', 'https://example.com'],
]) {
  blocked(label, { method: 'GET', baseUrl, target: '/get' });
}

blocked('protocol-relative target', {
  method: 'GET',
  baseUrl: 'https://postman-echo.com',
  target: '//127.0.0.1/admin',
});
blocked('method/path mismatch', {
  method: 'POST',
  baseUrl: 'https://postman-echo.com',
  target: '/get',
});
blocked('unsupported method', {
  method: 'TRACE',
  baseUrl: 'https://postman-echo.com',
  target: '/get',
});

for (const name of ['GET 读取', 'POST 提交', 'DELETE 删除']) {
  const node = workflow.nodes.find((candidate) => candidate.name === name);
  assert.equal(node?.parameters?.url, '={{ $json.url }}');
  assertions += 1;
}

console.log(`${assertions}/${assertions} assertions passed`);
console.log('W4 fixed-origin and fixed-path allowlist is intact');
