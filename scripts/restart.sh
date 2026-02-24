#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RWC="$APP_DIR/scripts/rwc.sh"
STOP="$APP_DIR/scripts/stop.sh"

echo "[restart] Stopping..."
bash "$STOP"

sleep 1

echo "[restart] Starting..."
nohup bash "$RWC" >/tmp/weather-display-restart.log 2>&1 & disown

echo "[restart] Done. Log: /tmp/weather-display-restart.log"
