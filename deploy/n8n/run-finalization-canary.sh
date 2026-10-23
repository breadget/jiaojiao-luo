#!/usr/bin/env bash
set -Eeuo pipefail

# Run three concurrent, no-key W1 requests through the website API. The test
# verifies protocol semantics, unique request/execution binding, and the final
# SQLite state without printing any token or workflow payload containing keys.

APP_VARS="${URTORIS_APP_VARS:-/opt/urtoris/app/.dev.vars}"
DATABASE="${N8N_DATABASE_PATH:-/root/.n8n/database.sqlite}"
ENDPOINT="${URTORIS_RUN_ENDPOINT:-http://127.0.0.1:3000/api/v1/run}"
N8N_BASE_URL="${N8N_CANARY_BASE_URL:-http://127.0.0.1:5678}"
PREFIX="${1:-req_w1_finalization_$(date -u +%Y%m%dT%H%M%SZ)}"

if [[ ! -r "$APP_VARS" ]]; then
  echo "Cannot read $APP_VARS" >&2
  exit 1
fi

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
        --request POST "$N8N_BASE_URL/webhook/urtoris/llm-smoke" \
        --header 'Content-Type: application/json' \
        --data-binary '{}' || true
    )"
    if [[ "$status" == '401' || "$status" == '403' ]]; then
      return 0
    fi
    sleep 1
  done
  echo "W1 webhook was not registered within 45 seconds" >&2
  return 1
}

wait_for_n8n_webhooks

temp_dir="$(mktemp -d /tmp/urtoris-w1-canary.XXXXXX)"
trap 'rm -rf "$temp_dir"' EXIT

run_one() {
  local request_id="$1"
  local output="$2"
  printf '{"workflowId":"wf_n8n_llm_smoke","requestId":"%s","message":"规则模式定稿检查","input":{}}' "$request_id" |
    curl --fail-with-body --silent --show-error \
      --request POST "$ENDPOINT" \
      --header 'Content-Type: application/json' \
      --header "Authorization: Bearer $URTORIS_API_TOKEN" \
      --data-binary @- \
      --output "$output"
}

request_a="${PREFIX}_a"
request_b="${PREFIX}_b"
request_c="${PREFIX}_c"

run_one "$request_a" "$temp_dir/a.json" &
pid_a=$!
run_one "$request_b" "$temp_dir/b.json" &
pid_b=$!
run_one "$request_c" "$temp_dir/c.json" &
pid_c=$!

wait "$pid_a"
wait "$pid_b"
wait "$pid_c"

N8N_DATABASE_PATH="$DATABASE" node - \
  "$request_a" "$temp_dir/a.json" \
  "$request_b" "$temp_dir/b.json" \
  "$request_c" "$temp_dir/c.json" <<'NODE'
'use strict';

const fs = require('fs');
const sqlite3 = require(
  process.env.N8N_SQLITE3_MODULE ||
    '/usr/lib/node_modules/n8n/node_modules/sqlite3',
);

const pairs = [];
for (let index = 2; index < process.argv.length; index += 2) {
  pairs.push({ requestId: process.argv[index], file: process.argv[index + 1] });
}

const responses = pairs.map(({ requestId, file }) => {
  const body = JSON.parse(fs.readFileSync(file, 'utf8'));
  const envelope = body.envelope ?? body;
  const executionId = String(envelope.meta?.executionId ?? '');
  const runExecutionId = String(body.run?.executionId ?? '');
  const checks = {
    apiOk: body.ok === true,
    success: envelope.success === true,
    engine: envelope.engine === 'n8n',
    mode: envelope.mode === 'rules',
    degraded: envelope.degraded === true,
    requestId: envelope.requestId === requestId,
    executionId: /^[0-9]+$/.test(executionId),
    runCompleted: body.run?.status === 'completed',
    runBinding: runExecutionId === executionId,
  };
  return {
    requestId,
    executionId,
    runId: body.run?.id ?? null,
    ok: Object.values(checks).every(Boolean),
    checks,
    error: envelope.error ?? null,
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
  const uniqueBindings = new Set(executionIds).size === responses.length;
  const placeholders = executionIds.map(() => '?').join(', ');
  const rows = await all(
    `SELECT id, "workflowId", status, finished, "startedAt", "stoppedAt", "waitTill"
       FROM execution_entity
      WHERE id IN (${placeholders})
      ORDER BY id`,
    executionIds,
  );
  const finalized = rows.map((row) => ({
    ...row,
    ok:
      row.status === 'success' &&
      row.finished === 1 &&
      row.stoppedAt !== null &&
      row.waitTill === null,
  }));
  const ok =
    responses.every((response) => response.ok) &&
    uniqueBindings &&
    finalized.length === responses.length &&
    finalized.every((row) => row.ok);
  process.stdout.write(
    `${JSON.stringify({ ok, uniqueBindings, responses, finalized }, null, 2)}\n`,
  );
  if (!ok) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => db.close());
NODE
