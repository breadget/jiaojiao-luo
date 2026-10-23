#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${PROJECT_DIR}/work/local-control"
ENV_FILE="${RUNTIME_DIR}/control.env"
PID_FILE="${RUNTIME_DIR}/control.pid"
LOG_FILE="${RUNTIME_DIR}/control.log"
STORAGE_DIR="${RUNTIME_DIR}/state"

mkdir -p "${RUNTIME_DIR}" "${STORAGE_DIR}"
chmod 0700 "${RUNTIME_DIR}" "${STORAGE_DIR}"

read_pid() {
  if [[ ! -f "${PID_FILE}" ]]; then
    return 1
  fi
  local candidate
  candidate="$(tr -d '[:space:]' < "${PID_FILE}")"
  if [[ ! "${candidate}" =~ ^[0-9]+$ ]]; then
    return 1
  fi
  printf '%s' "${candidate}"
}

is_running() {
  local pid
  pid="$(read_pid 2>/dev/null || true)"
  [[ -n "${pid}" ]] && kill -0 "${pid}" 2>/dev/null
}

write_env_once() {
  if [[ -f "${ENV_FILE}" ]]; then
    chmod 0600 "${ENV_FILE}"
    return
  fi
  local control_token
  control_token="$(openssl rand -hex 32)"
  umask 077
  {
    printf 'LOCAL_CONTROL_ENABLED=1\n'
    printf 'LOCAL_CONTROL_URL=http://127.0.0.1:3020\n'
    printf 'LOCAL_CONTROL_TOKEN=%s\n' "${control_token}"
    printf 'LOCAL_CONTROL_DEFAULT_CWD=%q\n' "${PROJECT_DIR}"
    printf 'LOCAL_CONTROL_STORAGE_ROOT=%q\n' "${STORAGE_DIR}"
    printf 'LOCAL_CONTROL_MAX_QUEUED_RUNS=20\n'
  } > "${ENV_FILE}"
  chmod 0600 "${ENV_FILE}"
}

start_control() {
  if is_running; then
    printf 'Local Control Agent 已在运行（PID %s）。\n' "$(read_pid)"
    return
  fi
  write_env_once
  set -a
  # shellcheck disable=SC1090 -- 该文件由本脚本以 0600 生成。
  source "${ENV_FILE}"
  set +a
  (
    cd "${PROJECT_DIR}"
    nohup node --import tsx services/local-control/server.ts >> "${LOG_FILE}" 2>&1 &
    printf '%s\n' "$!" > "${PID_FILE}"
  )

  local attempt
  for attempt in {1..40}; do
    if curl --fail --silent \
      -H "Authorization: Bearer ${LOCAL_CONTROL_TOKEN}" \
      "${LOCAL_CONTROL_URL}/v1/info" >/dev/null; then
      printf 'Local Control Agent 已启动：http://127.0.0.1:3020\n'
      printf '权限：当前 macOS 用户（非沙箱、非 root）\n'
      printf '审计：%s/audit.jsonl\n' "${STORAGE_DIR}"
      return
    fi
    sleep 0.25
  done
  printf 'Local Control Agent 启动超时，请查看 %s\n' "${LOG_FILE}" >&2
  exit 1
}

stop_control() {
  if ! is_running; then
    printf 'Local Control Agent 当前未运行。\n'
    return
  fi
  local pid
  pid="$(read_pid)"
  kill "${pid}"
  local attempt
  for attempt in {1..30}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${PID_FILE}"
      printf 'Local Control Agent 已停止。\n'
      return
    fi
    sleep 0.25
  done
  printf 'Local Control Agent 未在 7.5 秒内退出，请查看 %s\n' "${LOG_FILE}" >&2
  exit 1
}

show_status() {
  write_env_once
  set -a
  # shellcheck disable=SC1090 -- 该文件由本脚本以 0600 生成。
  source "${ENV_FILE}"
  set +a
  if is_running && curl --fail --silent \
    -H "Authorization: Bearer ${LOCAL_CONTROL_TOKEN}" \
    "${LOCAL_CONTROL_URL}/v1/info" >/dev/null; then
    printf 'Local Control Agent：运行中（PID %s）\n' "$(read_pid)"
    printf '控制范围：当前 macOS 用户（非沙箱、非 root）\n'
    return
  fi
  printf 'Local Control Agent：未运行\n'
  return 1
}

case "${1:-start}" in
  start) start_control ;;
  stop) stop_control ;;
  restart) stop_control; start_control ;;
  status) show_status ;;
  env) write_env_once; printf '%s\n' "${ENV_FILE}" ;;
  audit) write_env_once; printf '%s\n' "${STORAGE_DIR}/audit.jsonl" ;;
  *)
    printf '用法：%s {start|stop|restart|status|env|audit}\n' "$0" >&2
    exit 2
    ;;
esac
