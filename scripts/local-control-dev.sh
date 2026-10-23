#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTROL_SCRIPT="${PROJECT_DIR}/scripts/local-control.sh"
CONTROL_ENV_NAME="urtoris-control-runtime"
DEV_VARS_FILE="${PROJECT_DIR}/.dev.vars.${CONTROL_ENV_NAME}"
DEV_VARS_MARKER="# generated-by-urtoris-local-control"
STARTED_HERE=0

if [[ -f "${DEV_VARS_FILE}" ]] &&
  [[ "$(sed -n '1p' "${DEV_VARS_FILE}")" != "${DEV_VARS_MARKER}" ]]; then
  printf '拒绝覆盖已有文件：%s\n' "${DEV_VARS_FILE}" >&2
  exit 1
fi

# 已经有一个站点在跑时，它会用自己的（缺少 Control Agent 配置的）环境变量继续
# 服务，而 vinext 会直接退出——本次启动出来的 Control Agent 随即被清理掉，
# 结果就是"看起来启动了，实际全权限模式没生效"。所以在动手之前先拒绝。
dev_server_port=3000
if command -v lsof >/dev/null 2>&1 &&
  lsof -nP -iTCP:"${dev_server_port}" -sTCP:LISTEN >/dev/null 2>&1; then
  printf '端口 %s 上已经有站点在运行，本机全权限模式不会生效。\n' "${dev_server_port}" >&2
  printf '先停掉它（例如：kill %s），再重新运行 npm run dev:control。\n' \
    "$(lsof -nP -iTCP:"${dev_server_port}" -sTCP:LISTEN -t 2>/dev/null | head -1)" >&2
  exit 1
fi

if ! "${CONTROL_SCRIPT}" status >/dev/null 2>&1; then
  "${CONTROL_SCRIPT}" start
  STARTED_HERE=1
fi

ENV_FILE="$(${CONTROL_SCRIPT} env)"
set -a
# shellcheck disable=SC1090 -- 该文件由 local-control.sh 以 0600 生成。
source "${ENV_FILE}"
set +a

umask 077
printf '%s\n' "${DEV_VARS_MARKER}" > "${DEV_VARS_FILE}"
if [[ -f "${PROJECT_DIR}/.dev.vars" ]]; then
  while IFS= read -r dev_vars_line || [[ -n "${dev_vars_line}" ]]; do
    printf '%s\n' "${dev_vars_line}" >> "${DEV_VARS_FILE}"
  done < "${PROJECT_DIR}/.dev.vars"
fi
{
  printf '\n# Local Control Agent（本文件退出时自动删除）\n'
  printf 'LOCAL_CONTROL_ENABLED=%s\n' "${LOCAL_CONTROL_ENABLED}"
  printf 'LOCAL_CONTROL_URL=%s\n' "${LOCAL_CONTROL_URL}"
  printf 'LOCAL_CONTROL_TOKEN=%s\n' "${LOCAL_CONTROL_TOKEN}"
} >> "${DEV_VARS_FILE}"
chmod 0600 "${DEV_VARS_FILE}"
export CLOUDFLARE_ENV="${CONTROL_ENV_NAME}"

cleanup() {
  if [[ -f "${DEV_VARS_FILE}" ]] &&
    [[ "$(sed -n '1p' "${DEV_VARS_FILE}")" == "${DEV_VARS_MARKER}" ]]; then
    rm -f "${DEV_VARS_FILE}"
  fi
  if [[ "${STARTED_HERE}" == "1" ]]; then
    "${CONTROL_SCRIPT}" stop || true
  fi
}
trap cleanup EXIT INT TERM

cd "${PROJECT_DIR}"
printf '正在启动本机网页；关闭开发服务器时，本次启动的全权限 Control Agent 也会停止。\n'
npm run dev
