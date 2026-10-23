#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUNTIME_DIR="${PROJECT_DIR}/work/python-executor-local"
ENV_FILE="${RUNTIME_DIR}/executor.env"
PID_FILE="${RUNTIME_DIR}/executor.pid"
LOG_FILE="${RUNTIME_DIR}/executor.log"
STORAGE_DIR="${PROJECT_DIR}/work/python-executor"
IMAGE_NAME="urtoris/python-executor:dev"
LOCAL_BIN="${HOME}/.local/bin"
export PATH="${LOCAL_BIN}:${PATH}"

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
    return
  fi
  local executor_token task_key
  executor_token="$(openssl rand -hex 32)"
  task_key="$(openssl rand -hex 32)"
  umask 077
  {
    printf 'PYTHON_EXECUTOR_URL=http://127.0.0.1:3010\n'
    printf 'PYTHON_EXECUTOR_TOKEN=%s\n' "${executor_token}"
    printf 'PYTHON_TASK_SIGNING_KEY=%s\n' "${task_key}"
    printf 'PYTHON_AGENT_ENABLED=1\n'
  } > "${ENV_FILE}"
}

ensure_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    printf 'Docker CLI 未找到。请先安装 Colima + Docker CLI，再重试。\n' >&2
    exit 1
  fi
  if docker info >/dev/null 2>&1; then
    return
  fi
  if ! command -v colima >/dev/null 2>&1; then
    printf 'Docker daemon 未启动，且未找到 Colima。\n' >&2
    exit 1
  fi
  printf '正在启动 Colima（4 CPU / 4 GiB）…\n'
  colima start --vm-type vz --cpu 4 --memory 4 --disk 20
  docker info >/dev/null
}

start_executor() {
  if is_running; then
    printf 'Python Executor 已在运行（PID %s）。\n' "$(read_pid)"
    return
  fi
  ensure_docker
  if ! docker buildx version >/dev/null 2>&1; then
    printf 'Docker Buildx 未找到；运行镜像需要 BuildKit 才能保留文件权限。\n' >&2
    exit 1
  fi
  write_env_once
  printf '正在构建本机执行镜像…\n'
  docker buildx build --progress plain --load -t "${IMAGE_NAME}" "${PROJECT_DIR}/services/python-executor"

  set -a
  # shellcheck disable=SC1090 -- 该文件由本脚本以 0600 生成。
  source "${ENV_FILE}"
  set +a
  export PYTHON_EXECUTOR_IMAGE="${IMAGE_NAME}"
  export PYTHON_EXECUTOR_STORAGE_ROOT="${STORAGE_DIR}"
  export PYTHON_EXECUTOR_MAX_QUEUED_RUNS=1

  (
    cd "${PROJECT_DIR}"
    nohup node --import tsx services/python-executor/server.ts >> "${LOG_FILE}" 2>&1 &
    printf '%s\n' "$!" > "${PID_FILE}"
  )

  local attempt
  for attempt in {1..40}; do
    if curl --fail --silent http://127.0.0.1:3010/health >/dev/null; then
      printf 'Python Executor 已启动：http://127.0.0.1:3010\n'
      printf '站点本地启动前执行：set -a; source %s; set +a\n' "${ENV_FILE}"
      return
    fi
    sleep 0.25
  done
  printf '执行器启动超时，请查看 %s\n' "${LOG_FILE}" >&2
  exit 1
}

stop_executor() {
  if ! is_running; then
    printf 'Python Executor 当前未运行。\n'
    return
  fi
  local pid
  pid="$(read_pid)"
  kill "${pid}"
  local attempt
  for attempt in {1..20}; do
    if ! kill -0 "${pid}" 2>/dev/null; then
      rm -f "${PID_FILE}"
      printf 'Python Executor 已停止；Colima 保持运行。\n'
      return
    fi
    sleep 0.25
  done
  printf '执行器未在 5 秒内退出，请查看 %s\n' "${LOG_FILE}" >&2
  exit 1
}

show_status() {
  if is_running && curl --fail --silent http://127.0.0.1:3010/health >/dev/null; then
    printf 'Python Executor：运行中（PID %s）\n' "$(read_pid)"
    return
  fi
  printf 'Python Executor：未运行\n'
  return 1
}

case "${1:-start}" in
  start) start_executor ;;
  stop) stop_executor ;;
  restart) stop_executor; start_executor ;;
  status) show_status ;;
  env) write_env_once; printf '%s\n' "${ENV_FILE}" ;;
  *)
    printf '用法：%s {start|stop|restart|status|env}\n' "$0" >&2
    exit 2
    ;;
esac
