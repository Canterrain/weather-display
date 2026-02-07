#!/usr/bin/env bash
set -euo pipefail

THEME="${1:-}"
BASE="$HOME/weather-display/public/assets"
THEMES="$BASE/icon-themes"

if [[ -z "$THEME" ]]; then
  echo "Usage: set-theme.sh <theme>"
  echo
  echo "Available themes:"
  ls "$THEMES"
  exit 1
fi

if [[ ! -d "$THEMES/$THEME" ]]; then
  echo "Theme '$THEME' not found."
  echo
  echo "Available themes:"
  ls "$THEMES"
  exit 1
fi

if [[ ! -d "$THEMES/$THEME/icons" ]]; then
  echo "Theme '$THEME' is missing an icons/ folder."
  exit 1
fi

echo "Switching to theme: $THEME"

# Switch icons (symlink)
rm -f "$BASE/icons"
ln -s "icon-themes/$THEME/icons" "$BASE/icons"

# Switch backgrounds (copy/overwrite)
DAY_BG="$THEMES/$THEME/icons/background-day.jpg"
NIGHT_BG="$THEMES/$THEME/icons/background-night.jpg"

if [[ -f "$DAY_BG" ]]; then
  cp -f "$DAY_BG" "$BASE/background-day.jpg"
else
  echo "Warning: missing $DAY_BG (day background not updated)"
fi

if [[ -f "$NIGHT_BG" ]]; then
  cp -f "$NIGHT_BG" "$BASE/background-night.jpg"
else
  echo "Warning: missing $NIGHT_BG (night background not updated)"
fi

echo "Theme '$THEME' active."
