#!/bin/bash
set -e

sleep 6

# Wayland/Wayfire (Bookworm default)
if command -v wlr-randr >/dev/null 2>&1; then
  DISPLAY_ID=$(wlr-randr | awk '/^[^ ]/ {output=$1} /Enabled: yes/ {print output; exit}')
  if [[ -n "$DISPLAY_ID" ]]; then
    wlr-randr --output "$DISPLAY_ID" --transform 90
    exit 0
  fi
fi

# X11
if command -v xrandr >/dev/null 2>&1; then
  export DISPLAY=:0
  OUTPUT=$(xrandr | awk '/ connected/ {print $1; exit}')
  if [[ -n "$OUTPUT" ]]; then
    xrandr --output "$OUTPUT" --rotate right
    exit 0
  fi
fi

echo "Could not rotate display (no usable output detected)."
exit 1
