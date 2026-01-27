#!/bin/bash
set -e
export DISPLAY=:0
sleep 8
DISPLAY_ID=$(wlr-randr | awk '/^[^ ]/ {output=$1} /Enabled: yes/ {print output; exit}')
if [[ -z "$DISPLAY_ID" ]]; then
  echo "Could not detect display for rotation."
  exit 1
fi
/usr/bin/wlr-randr --output "$DISPLAY_ID" --transform 90
