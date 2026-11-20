#!/usr/bin/env bash
# Update the bot on the VPS: copy the NEW funnel-bot folder to the server, then
#   sudo bash funnel-bot/deploy/update.sh
# Code is replaced; .env on the server is kept. Lessons live in the database, so nothing else is lost.
set -euo pipefail

APP_DIR=/opt/funnel-bot
SRC_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE=funnel-bot
[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }
[ "$SRC_DIR" != "$APP_DIR" ] || { echo "Run the script from the NEW copy (not from $APP_DIR)."; exit 1; }

rsync -a --delete --exclude node_modules --exclude '.env' "$SRC_DIR"/ "$APP_DIR"/
cd "$APP_DIR/bot"
npm ci --omit=dev --no-audit --no-fund
chown -R funnel:funnel "$APP_DIR"
chmod 600 .env
sudo -u funnel node --test "test/unit/*.test.js" >/dev/null || { echo "unit tests FAILED"; exit 1; }
echo "unit tests: ok"
sudo -u funnel node --env-file=.env scripts/migrate.mjs
cp "$APP_DIR/deploy/$SERVICE.service" /etc/systemd/system/
systemctl daemon-reload
systemctl restart "$SERVICE"
sleep 5
journalctl -u "$SERVICE" -n 15 --no-pager
