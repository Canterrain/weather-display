#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/home/$USER/weather-display"
cd "$APP_DIR" || exit 1

SESSION="${XDG_SESSION_TYPE:-}"
IS_WAYLAND="false"
if [[ "$SESSION" == "wayland" || -n "${WAYLAND_DISPLAY:-}" ]]; then
  IS_WAYLAND="true"
fi

# Give the session a moment to settle (harmless on both)
sleep 2

# X11-only: hide cursor with unclutter
if [[ "$IS_WAYLAND" == "false" ]]; then
  export DISPLAY="${DISPLAY:-:0}"
  if command -v unclutter-xfixes >/dev/null 2>&1; then
    unclutter-xfixes --timeout 0 --jitter 0 --ignore-scrolling &
  fi
else
  # Wayland: nudge Electron to use Ozone automatically (Wayland where possible)
  export ELECTRON_OZONE_PLATFORM_HINT=auto
fi

# Start the Express server
node --network-family-autoselection-attempt-timeout=500 server.js &

# Wait for server to be ready (max ~30s)
for _ in {1..30}; do
  if curl -fsS http://localhost:3000/weather >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Launch Electron
exec ./node_modules/.bin/electron .
