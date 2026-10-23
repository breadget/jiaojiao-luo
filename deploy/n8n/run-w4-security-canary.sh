#!/usr/bin/env bash
set -Eeuo pipefail

# Verify that W4 can reach only the fixed Postman Echo demo endpoint and that
# rejected URLs never execute an HTTP Request node.

APP_VARS="${URTORIS_APP_VARS:-/opt/urtoris/app/.dev.vars}"
DATABASE="${N8N_DATABASE_PATH:-/root/.n8n/database.sqlite}"
ENDPOINT="${URTORIS_RUN_ENDPOINT:-http://127.0.0.1:3000/api/v1/run}"
N8N_BASE_URL="${N8N_CANARY_BASE_URL:-http://127.0.0.1:5678}"
PREFIX="${1:-req_w4_allowlist_$(date -u +%Y%m%dT%H%M%SZ)}"

set -a
# shellcheck disable=SC1090
source "$APP_VARS"
set +a

if [[ -z "${URTORIS_API_TOKEN:-}" ]]; then
  echo "URTORIS_API_TOKEN is not configured" >&2
  exit 1
fi

wait_for_n8n_webhooks() {
  local status
  for _ in {1..45}; do
    status="$(
      curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
        --request POST "$N8N_BASE_URL/webhook/urtoris/api-gateway" \
        --header 'Content-Type: application/json' \
        --data-binary '{}' || true
    )"
    if [[ "$status" == '401' || "$status" == '403' ]]; then
      return 0
    fi
    sleep 1
  done
  echo "W4 webhook was not registered within 45 seconds" >&2
  return 1
}

wait_for_n8n_webhooks

temp_dir="$(mktemp -d /tmp/urtoris-w4-canary.XXXXXX)"
trap 'rm -rf "$temp_dir"' EXIT

post_case() {
  local request_id="$1"
  local input_json="$2"
  local output="$3"
  printf '{"workflowId":"wf_n8n_api_gateway","requestId":"%s","message":"W4 allowlist check","input":%s}' "$request_id" "$input_json" |
    curl --fail-with-body --silent --show-error \
      --request POST "$ENDPOINT" \
      --header 'Content-Type: application/json' \
      --header "Authorization: Bearer $URTORIS_API_TOKEN" \
      --data-binary @- \
      --output "$output"
}

ADMIN_TOKEN="${URTORIS_ADMIN_TOKEN:?URTORIS_ADMIN_TOKEN is not configured}"

allowed_id="${PREFIX}_allowed"
public_blocked_id="${PREFIX}_public_blocked"
local_blocked_id="${PREFIX}_local_blocked"

post_case \
  "$allowed_id" \
  '{"method":"GET","baseUrl":"https://postman-echo.com","target":"/get"}' \
  "$temp_dir/allowed.json"
post_case \
  "$public_blocked_id" \
  '{"method":"GET","baseUrl":"https://example.com","target":"/get"}' \
  "$temp_dir/public-blocked.json"
post_case \
  "$local_blocked_id" \
  "{\"method\":\"POST\",\"baseUrl\":\"http://127.0.0.1:3000\",\"target\":\"/api/workflows\",\"headers\":{\"Authorization\":\"Bearer $ADMIN_TOKEN\"},\"body\":{\"action\":\"create\"}}" \
  "$temp_dir/local-blocked.json"

N8N_DATABASE_PATH="$DATABASE" node - \
  "$allowed_id" "$temp_dir/allowed.json" allowed \
  "$public_blocked_id" "$temp_dir/public-blocked.json" blocked \
  "$local_blocked_id" "$temp_dir/local-blocked.json" blocked <<'NODE'
'use strict';

const fs = require('fs');
const sqlite3 = require(
  process.env.N8N_SQLITE3_MODULE ||
    '/usr/lib/node_modules/n8n/node_modules/sqlite3',
);
const { parse } = require(
  process.env.N8N_FLATTED_MODULE ||
    '/usr/lib/node_modules/n8n/node_modules/flatted',
);

const cases = [];
for (let index = 2; index < process.argv.length; index += 3) {
  cases.push({
    requestId: process.argv[index],
    file: process.argv[index + 1],
    kind: process.argv[index + 2],
  });
}

const responses = cases.map((testCase) => {
  const body = JSON.parse(fs.readFileSync(testCase.file, 'utf8'));
  const envelope = body.envelope ?? body;
  const executionId = String(envelope.meta?.executionId ?? '');
  const commonChecks = {
    requestId: envelope.requestId === testCase.requestId,
    executionId: /^[0-9]+$/.test(executionId),
    runBinding: String(body.run?.executionId ?? '') === executionId,
    mode: envelope.mode === 'rules',
    degraded: envelope.degraded === false,
  };
  const outcomeChecks =
    testCase.kind === 'allowed'
      ? {
          apiOk: body.ok === true,
          success: envelope.success === true,
          noError: envelope.error === null,
        }
      : {
          apiRejected: body.ok === false,
          failed: envelope.success === false,
          validationError: envelope.error?.code === 'VALIDATION_ERROR',
          rejectedAtParser: envelope.error?.node === '解析网关请求',
        };
  const checks = { ...commonChecks, ...outcomeChecks };
  return {
    requestId: testCase.requestId,
    kind: testCase.kind,
    executionId,
    ok: Object.values(checks).every(Boolean),
    checks,
  };
});

const db = new sqlite3.Database(
  process.env.N8N_DATABASE_PATH,
  sqlite3.OPEN_READONLY,
);

function all(sql, params) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

async function main() {
  const executionIds = responses.map((response) => response.executionId);
  const placeholders = executionIds.map(() => '?').join(', ');
  const rows = await all(
    `SELECT e.id, e.status, e.finished, e."stoppedAt", d.data
       FROM execution_entity e
       JOIN execution_data d ON d.executionId = e.id
      WHERE e.id IN (${placeholders})
      ORDER BY e.id`,
    executionIds,
  );
  const paths = rows.map((row) => {
    const runNodes = Object.keys(parse(row.data).resultData?.runData || {});
    const response = responses.find(
      (candidate) => candidate.executionId === String(row.id),
    );
    const httpNodes = ['GET 读取', 'POST 提交', 'DELETE 删除'].filter((name) =>
      runNodes.includes(name),
    );
    const pathOk =
      response?.kind === 'allowed'
        ? httpNodes.length === 1 && httpNodes[0] === 'GET 读取'
        : httpNodes.length === 0;
    return {
      executionId: String(row.id),
      kind: response?.kind ?? null,
      status: row.status,
      finished: row.finished,
      stoppedAt: row.stoppedAt,
      httpNodes,
      ok:
        row.status === 'success' &&
        row.finished === 1 &&
        row.stoppedAt !== null &&
        pathOk,
    };
  });
  const ok =
    responses.every((response) => response.ok) &&
    new Set(executionIds).size === responses.length &&
    paths.length === responses.length &&
    paths.every((path) => path.ok);
  process.stdout.write(`${JSON.stringify({ ok, responses, paths }, null, 2)}\n`);
  if (!ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
NODE
