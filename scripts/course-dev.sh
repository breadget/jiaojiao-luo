#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COURSE_DIR="${PROJECT_DIR}/course-assistant"
COURSE_PYTHON="${COURSE_DIR}/.venv/bin/python"
COURSE_PID=""

cleanup() {
  if [[ -n "${COURSE_PID}" ]] && kill -0 "${COURSE_PID}" 2>/dev/null; then
    kill "${COURSE_PID}" 2>/dev/null || true
    wait "${COURSE_PID}" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [[ ! -x "${COURSE_PYTHON}" ]]; then
  printf '正在准备课程助教运行环境…\n'
  python3 -m venv "${COURSE_DIR}/.venv"
  "${COURSE_PYTHON}" -m pip install -r "${COURSE_DIR}/requirements.lock.txt"
fi

if [[ ! -f "${COURSE_DIR}/.env" ]]; then
  cp "${COURSE_DIR}/.env.example" "${COURSE_DIR}/.env"
  chmod 600 "${COURSE_DIR}/.env"
fi

course_ready() {
  "${COURSE_PYTHON}" - <<'PY' >/dev/null 2>&1
import json
from urllib.request import urlopen
with urlopen('http://127.0.0.1:8001/api/status/', timeout=2) as response:
    data = json.load(response)
assert isinstance(data.get('ready'), bool)
assert isinstance(data.get('documents'), list)
assert 'embedding_model' in data and 'chunk_count' in data
PY
}

if course_ready; then
  printf '已连接正在运行的课程助教服务。\n'
else
  if command -v lsof >/dev/null 2>&1 &&
    lsof -nP -iTCP:8001 -sTCP:LISTEN >/dev/null 2>&1; then
    printf '8001 端口已被其他服务占用，请释放后重试。\n' >&2
    exit 1
  fi
  (
    cd "${COURSE_DIR}"
    "${COURSE_PYTHON}" manage.py migrate --noinput
    "${COURSE_PYTHON}" manage.py index_knowledge
  )
  mkdir -p "${COURSE_DIR}/var"
  (
    cd "${COURSE_DIR}"
    exec "${COURSE_PYTHON}" manage.py runserver 127.0.0.1:8001 --noreload
  ) >"${COURSE_DIR}/var/server.log" 2>&1 &
  COURSE_PID=$!
  for attempt in {1..30}; do
    if course_ready; then break; fi
    if ! kill -0 "${COURSE_PID}" 2>/dev/null; then break; fi
    sleep 0.3
  done
  if ! course_ready; then
    printf '课程助教未能启动，请查看 course-assistant/var/server.log。\n' >&2
    exit 1
  fi
fi

cd "${PROJECT_DIR}"
printf '正在启动 Urtoris；首页进入「询问 AI 智能体」，或访问 /ai。\n'
npm run dev -- "$@"
