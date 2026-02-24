#!/usr/bin/env bash
set -euo pipefail

# Rotate the active display to 90 degrees (right).
# Supports:
#   - Wayland: wlr-randr
#   - X11:     xrandr
#
# Boot can be racy, especially on Bookworm: X/Wayland may not be ready
# when systemd tries to run this, so we retry for a while.

MAX_WAIT_SECONDS=60

# Prefer explicit env if already set, but provide sane defaults for systemd.
export DISPLAY="${DISPLAY:-:0}"
export XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"

try_wayland() {
  command -v wlr-randr >/dev/null 2>&1 || return 1

  # Find first enabled output
  local out=""
  out="$(wlr-randr 2>/dev/null | awk '
    /^[^ ]/ {o=$1}
    /Enabled: yes/ {print o; exit}
  ' || true)"

  [[ -n "$out" ]] || return 1

  wlr-randr --output "$out" --transform 90 >/dev/null 2>&1
}

try_x11() {
  command -v xrandr >/dev/null 2>&1 || return 1

  # If X isn't ready, xrandr will error ("Can't open display")
  xrandr >/dev/null 2>&1 || return 1

  local out=""
  out="$(xrandr 2>/dev/null | awk '/ connected/ {print $1; exit}' || true)"
  [[ -n "$out" ]] || return 1

  xrandr --output "$out" --rotate right >/dev/null 2>&1
}

for ((i=1; i<=MAX_WAIT_SECONDS; i++)); do
  if try_wayland; then
    exit 0
  fi
  if try_x11; then
    exit 0
  fi
  sleep 1
done

echo "Could not rotate display after ${MAX_WAIT_SECONDS}s."
echo "Debug hints:"
echo "  - Wayland: wlr-randr"
echo "  - X11:     DISPLAY=:0 XAUTHORITY=\$HOME/.Xauthority xrandr"
exit 1
