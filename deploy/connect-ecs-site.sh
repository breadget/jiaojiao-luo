#!/usr/bin/env bash
set -euo pipefail

# 备案完成前的私有管理通道：浏览器只连本机，ECS 端只暴露给 SSH。
# 网站后端仍在 ECS 内通过 127.0.0.1:5678 调用 n8n，不需要公开 n8n 端口。

ecs_target="${URTORIS_ECS_HOST:-root@8.133.252.143}"
key_path="${URTORIS_ECS_KEY:-${HOME}/.ssh/urtoris-ecs}"
local_site_port="${URTORIS_LOCAL_SITE_PORT:-13000}"
remote_site_port="${URTORIS_REMOTE_SITE_PORT:-3000}"

if [[ ! "$local_site_port" =~ ^[0-9]+$ ]] ||
  ((local_site_port < 1024 || local_site_port > 65535)); then
  echo "URTORIS_LOCAL_SITE_PORT 必须是 1024–65535 之间的端口。" >&2
  exit 2
fi

if [[ ! "$remote_site_port" =~ ^[0-9]+$ ]] ||
  ((remote_site_port < 1 || remote_site_port > 65535)); then
  echo "URTORIS_REMOTE_SITE_PORT 必须是 1–65535 之间的端口。" >&2
  exit 2
fi

if [[ ! -f "$key_path" ]]; then
  echo "找不到 ECS SSH 私钥：$key_path" >&2
  echo "可通过 URTORIS_ECS_KEY 指定其他路径。" >&2
  exit 2
fi

if nc -z 127.0.0.1 "$local_site_port" >/dev/null 2>&1; then
  echo "本机端口 $local_site_port 已被占用。" >&2
  echo "可换用：URTORIS_LOCAL_SITE_PORT=13001 npm run ecs:site" >&2
  exit 2
fi

echo "正在建立 Urtoris 私有通道…"
echo "连通后请打开：http://127.0.0.1:${local_site_port}"
echo "该页面运行在 ECS，并从服务器内部调用 n8n。按 Ctrl+C 关闭通道。"

exec ssh \
  -NT \
  -i "$key_path" \
  -o BatchMode=yes \
  -o IdentitiesOnly=yes \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -L "127.0.0.1:${local_site_port}:127.0.0.1:${remote_site_port}" \
  "$ecs_target"
