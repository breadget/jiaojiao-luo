#!/usr/bin/env bash
set -Eeuo pipefail

ARCHIVE_PATH="${1:-/root/urtoris-deploy.tar.gz}"
APP_ROOT="/opt/urtoris"
APP_DIR="$APP_ROOT/app"
BACKUP_DIR="$APP_ROOT/backups"
PERSIST_DIR="/var/lib/urtoris"
WRANGLER_STATE_DIR="$PERSIST_DIR/data"
LOG_DIR="/var/log/urtoris"
STAMP="$(date +%Y%m%d-%H%M%S)"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "请用 root 执行此脚本。" >&2
  exit 1
fi

if [[ ! -f "$ARCHIVE_PATH" ]]; then
  echo "找不到部署包：$ARCHIVE_PATH" >&2
  exit 1
fi

if ! id -u urtoris >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$PERSIST_DIR" --shell /usr/sbin/nologin urtoris
fi

install -d -m 0755 "$APP_ROOT" "$BACKUP_DIR" "$PERSIST_DIR" "$WRANGLER_STATE_DIR" "$LOG_DIR"
systemctl stop urtoris.service 2>/dev/null || true

if [[ -d "$APP_DIR" ]]; then
  mv "$APP_DIR" "$BACKUP_DIR/app-$STAMP"
fi
install -d -m 0755 "$APP_DIR"
tar -xzf "$ARCHIVE_PATH" -C "$APP_DIR"

cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --no-audit --no-fund
else
  npm install --no-audit --no-fund
fi
npm run build

# Vinext places the bundled Drizzle migrations under dist/.openai/drizzle,
# while Wrangler looks for migrations beside its generated config. Copy only
# the real migration files and discard macOS AppleDouble metadata.
install -d -m 0755 "$APP_DIR/dist/server/migrations"
cp -a "$APP_DIR/drizzle/." "$APP_DIR/dist/server/migrations/"
find "$APP_DIR/dist/server/migrations" -type f -name '._*' -delete
find "$APP_DIR/dist/server/migrations" -type f -name '.__*' -delete

if [[ ! -s "$APP_DIR/.dev.vars" ]]; then
  API_TOKEN="$(openssl rand -hex 32)"
  ADMIN_TOKEN="$(openssl rand -hex 32)"
  printf 'URTORIS_API_TOKEN=%s\nURTORIS_ADMIN_TOKEN=%s\n' "$API_TOKEN" "$ADMIN_TOKEN" > "$APP_DIR/.dev.vars"
  printf '%s\n' "$API_TOKEN" > /root/urtoris-api-token.txt
  printf '%s\n' "$ADMIN_TOKEN" > /root/urtoris-admin-token.txt
  chmod 600 /root/urtoris-api-token.txt
  chmod 600 /root/urtoris-admin-token.txt
else
  API_TOKEN="$(sed -n 's/^URTORIS_API_TOKEN=//p' "$APP_DIR/.dev.vars" | head -n 1)"
  ADMIN_TOKEN="$(sed -n 's/^URTORIS_ADMIN_TOKEN=//p' "$APP_DIR/.dev.vars" | head -n 1)"
  if [[ -z "$ADMIN_TOKEN" ]]; then
    ADMIN_TOKEN="$(openssl rand -hex 32)"
    printf '\nURTORIS_ADMIN_TOKEN=%s\n' "$ADMIN_TOKEN" >> "$APP_DIR/.dev.vars"
    printf '%s\n' "$ADMIN_TOKEN" > /root/urtoris-admin-token.txt
    chmod 600 /root/urtoris-admin-token.txt
  fi
fi

chown -R urtoris:urtoris "$APP_ROOT" "$PERSIST_DIR" "$LOG_DIR"
chmod 600 "$APP_DIR/.dev.vars"

runuser -u urtoris -- env HOME="$PERSIST_DIR" \
  /usr/bin/node "$APP_DIR/node_modules/wrangler/bin/wrangler.js" \
  d1 migrations apply DB --local --config "$APP_DIR/dist/server/wrangler.json" \
  --persist-to "$WRANGLER_STATE_DIR" <<< 'y'

install -m 0644 "$APP_DIR/deploy/urtoris.service" /etc/systemd/system/urtoris.service

if [[ -f /etc/nginx/sites-available/urtoris.cn ]]; then
  cp -a /etc/nginx/sites-available/urtoris.cn \
    "/etc/nginx/sites-available/urtoris.cn.before-$STAMP"
fi
install -m 0644 "$APP_DIR/deploy/urtoris.nginx.conf" /etc/nginx/sites-available/urtoris.cn
ln -sfn /etc/nginx/sites-available/urtoris.cn /etc/nginx/sites-enabled/urtoris.cn

systemctl daemon-reload
systemctl enable --now urtoris.service
nginx -t
systemctl reload nginx

for attempt in {1..20}; do
  if curl -fsS http://127.0.0.1:3000/api/state >/dev/null; then
    break
  fi
  sleep 2
done

curl -fsS -X POST http://127.0.0.1:3000/api/workflows \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  --data-binary @"$APP_DIR/deploy/seed-workflow.json" >/dev/null

echo "部署完成。"
echo "API 密钥已保存到 /root/urtoris-api-token.txt"
echo "管理员密钥已保存到 /root/urtoris-admin-token.txt"
echo "公网 API 地址：https://urtoris.cn/api/v1/run"
echo "请勿把 API 密钥提交到代码仓库或公开页面。"
