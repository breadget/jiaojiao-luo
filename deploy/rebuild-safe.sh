#!/usr/bin/env bash
# 在 ECS 上安全地重建 Urtoris 站点。
#
# 背景：这台机器只有 2 核 / 1.6G 内存，n8n 常驻占 ~500M。
# 2026-09-10 直接在跑着 n8n 的情况下执行 `npm run build`，
# 内存耗尽触发 swap 抖动，整机（含 SSH 与 80 端口）失联约 36 分钟。
# 这个脚本把三件事做对：先腾内存、限制 node 堆、构建完再恢复 n8n。
set -Eeuo pipefail

APP_DIR="/opt/urtoris/app"
PERSIST_DIR="/var/lib/urtoris"
WRANGLER_STATE_DIR="$PERSIST_DIR/data"
N8N_WAS_ACTIVE=0

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行。" >&2
  exit 1
fi

restore_n8n() {
  if [[ "$N8N_WAS_ACTIVE" == "1" ]]; then
    echo "==> 恢复 n8n"
    systemctl start n8n 2>/dev/null || true
    local status
    for _ in {1..45}; do
      status="$(
        curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
          --request POST http://127.0.0.1:5678/webhook/urtoris/llm-smoke \
          --header 'Content-Type: application/json' \
          --data-binary '{}' || true
      )"
      if [[ "$status" == '401' || "$status" == '403' ]]; then
        echo "==> n8n Webhook 已注册"
        N8N_WAS_ACTIVE=0
        return 0
      fi
      sleep 1
    done
    echo "警告：n8n 进程已启动，但 W1 Webhook 在 45 秒内未注册。" >&2
  fi
}
trap restore_n8n EXIT

echo "==> 当前内存"
free -h | head -2

# 1. 先停 n8n 腾出内存（这是上次事故的直接原因）
if systemctl is-active --quiet n8n; then
  N8N_WAS_ACTIVE=1
  echo "==> 暂停 n8n 以腾出内存"
  systemctl stop n8n
  sleep 2
fi

# 2. 限堆构建
echo "==> 构建（NODE_OPTIONS=--max-old-space-size=512）"
cd "$APP_DIR"
runuser -u urtoris -- env HOME="$PERSIST_DIR" PATH=/usr/bin:/bin \
  NODE_OPTIONS="--max-old-space-size=512" \
  /usr/bin/npm run build

# 3. 迁移文件搬进 dist，剔除 macOS 元数据
echo "==> 同步 Drizzle 迁移到 dist"
install -d -m 0755 "$APP_DIR/dist/server/migrations"
cp -a "$APP_DIR/drizzle/." "$APP_DIR/dist/server/migrations/"
find "$APP_DIR/dist/server/migrations" -type f -name '._*' -delete 2>/dev/null || true
find "$APP_DIR/dist/server/migrations" -type f -name '.__*' -delete 2>/dev/null || true

# 4. 应用本地 D1 迁移（幂等）
echo "==> 应用 D1 迁移"
runuser -u urtoris -- env HOME="$PERSIST_DIR" PATH=/usr/bin:/bin \
  /usr/bin/node "$APP_DIR/node_modules/wrangler/bin/wrangler.js" \
  d1 migrations apply DB --local --config "$APP_DIR/dist/server/wrangler.json" \
  --persist-to "$WRANGLER_STATE_DIR" <<< 'y'

chown -R urtoris:urtoris "$APP_DIR/dist" "$PERSIST_DIR"

# 5. 重启站点
echo "==> 重启站点"
systemctl restart urtoris.service

for _ in {1..30}; do
  if curl -fsS http://127.0.0.1:3000/api/state >/dev/null 2>&1; then
    echo "==> 站点已就绪"
    break
  fi
  sleep 2
done

echo "==> 完成"
curl -s -o /dev/null -w "  /api/state -> %{http_code}\n" http://127.0.0.1:3000/api/state
