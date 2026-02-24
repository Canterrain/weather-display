#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RWC="$APP_DIR/scripts/rwc.sh"

echo "[stop] Stopping weather display..."

# 1) Stop PM2 if it’s managing it (Bookworm/X11 path)
if command -v pm2 >/dev/null 2>&1; then
  # Stop only if this process exists in pm2
  if pm2 jlist 2>/dev/null | grep -q "\"name\":\"weather-display\""; then
    pm2 stop weather-display >/dev/null 2>&1 || true
  fi
fi

# 2) Kill Electron launched from THIS app directory only
# This matches the command line that includes ".../weather-display/..."
pkill -f "${APP_DIR//\//\\/}.*node_modules\/\.bin\/electron" 2>/dev/null || true
pkill -f "${APP_DIR//\//\\/}.*electron" 2>/dev/null || true

# 3) Kill the Express server that was started as: node server.js from THIS app directory
pkill -f "node .*${APP_DIR//\//\\/}\/server\.js" 2>/dev/null || true

# 4) Kill the launcher script itself if it's still running
pkill -f "${RWC//\//\\/}" 2>/dev/null || true

# 5) Clean up X11 cursor hider if it’s running (safe/no-op on Wayland)
pkill -f "unclutter-xfixes" 2>/dev/null || true

echo "[stop] Done."
