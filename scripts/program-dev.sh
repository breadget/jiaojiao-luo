#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROGRAM_TOKEN="${WORKFLOW_PROGRAM_TOKEN:-}"
if [[ ${#PROGRAM_TOKEN} -lt 32 ]]; then
  printf '请设置 WORKFLOW_PROGRAM_TOKEN（至少 32 字符），并与站点使用相同的令牌。\n' >&2
  exit 1
fi
export WORKFLOW_PROGRAM_STATE_DIR="${WORKFLOW_PROGRAM_STATE_DIR:-${PROJECT_DIR}/work/workflow-program}"
export WORKFLOW_PROGRAM_PORT="${WORKFLOW_PROGRAM_PORT:-8030}"
export COURSE_ASSISTANT_URL="${COURSE_ASSISTANT_URL:-http://127.0.0.1:8001}"
cd "${PROJECT_DIR}"
exec node --import tsx services/workflow-program/server.ts
