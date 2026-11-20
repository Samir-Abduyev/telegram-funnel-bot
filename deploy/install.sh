#!/usr/bin/env bash
# One-time setup of the funnel bot on a fresh Ubuntu 22.04/24.04 VPS.
# 1) copy the funnel-bot folder to the server, 2) ssh in, 3) run as root:
#      sudo bash funnel-bot/deploy/install.sh
# Safe to run again. Secrets stay in /opt/funnel-bot/bot/.env (mode 600).
set -euo pipefail

APP_DIR=/opt/funnel-bot
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=funnel-bot

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }

echo "== 1/6 Node.js 24, rsync"
apt-get update -qq
apt-get install -y -qq curl ca-certificates rsync >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 24 ]; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v

echo "== 2/6 service user"
id funnel >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin funnel

echo "== 3/6 files → $APP_DIR"
mkdir -p "$APP_DIR"
if [ "$SRC_DIR" != "$APP_DIR" ]; then
  rsync -a --exclude node_modules --exclude '.env' "$SRC_DIR"/ "$APP_DIR"/
  [ -f "$SRC_DIR/bot/.env" ] && [ ! -f "$APP_DIR/bot/.env" ] && cp "$SRC_DIR/bot/.env" "$APP_DIR/bot/.env"
fi
cd "$APP_DIR/bot"
npm ci --omit=dev --no-audit --no-fund

echo "== 4/6 secrets (.env)"
if [ ! -f .env ]; then
  cp .env.example .env
  chown funnel:funnel .env; chmod 600 .env
  echo "Fill in $APP_DIR/bot/.env (nano $APP_DIR/bot/.env), then run this script again."
  exit 0
fi
chown -R funnel:funnel "$APP_DIR"
chmod 600 .env

echo "== 5/6 checks and database migrations"
sudo -u funnel node --test "test/unit/*.test.js" >/dev/null || { echo "unit tests FAILED"; exit 1; }
echo "unit tests: ok"
sudo -u funnel node --env-file=.env scripts/migrate.mjs

echo "== 6/6 systemd service (starts on boot, restarts after crashes)"
cp "$APP_DIR/deploy/$SERVICE.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now "$SERVICE"
sleep 5
systemctl --no-pager --lines=15 status "$SERVICE" || true
echo
echo "Done. Logs: journalctl -u $SERVICE -f   Restart: systemctl restart $SERVICE"
echo "IMPORTANT: stop the bot on your PC — two copies of one bot cannot run at the same time (Telegram 409)."
