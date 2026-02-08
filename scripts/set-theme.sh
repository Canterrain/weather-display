#!/usr/bin/env bash
set -euo pipefail

THEME="${1:-}"
ROOT="$HOME/weather-display"
BASE="$ROOT/public/assets"
THEMES="$BASE/icon-themes"
ICONS_DIR="$BASE/icons"
ICONS_BASE="$BASE/icons.base"

usage() {
  echo "Usage: set-theme.sh <theme>"
  echo
  echo "Special theme: normal (restore default icons and clear backgrounds)"
  echo
  echo "If themes are installed, available themes are:"
  if [[ -d "$THEMES" ]]; then
    ls "$THEMES"
  else
    echo "(no $THEMES folder yet)"
  fi
}

err() { echo "ERROR: $*" >&2; }

copy_icons() {
  local src="$1"

  if command -v rsync >/dev/null 2>&1; then
    rsync -a --delete \
      --exclude="background-day.jpg" \
      --exclude="background-night.jpg" \
      --exclude="*.DS_Store" \
      "$src/" "$ICONS_DIR/"
  else
    # crude fallback: delete svg files then copy
    find "$ICONS_DIR" -maxdepth 1 -type f -name "*.svg" -delete
    cp -f "$src"/*.svg "$ICONS_DIR/" 2>/dev/null || true
  fi
}

ensure_not_symlink_dir() {
  local p="$1"
  if [[ -L "$p" ]]; then
    err "$p is a symlink. This project expects a real directory there."
    echo "Fix with:"
    echo "  rm -f \"$p\" && mkdir -p \"$p\" && git checkout -- public/assets/icons"
    exit 1
  fi
  mkdir -p "$p"
}

make_default_backup_if_missing() {
  # Create a backup of default icons the first time we run (if missing)
  if [[ -d "$ICONS_BASE" ]]; then
    return 0
  fi

  mkdir -p "$ICONS_BASE"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --exclude="*.DS_Store" "$ICONS_DIR/" "$ICONS_BASE/"
  else
    cp -a "$ICONS_DIR/." "$ICONS_BASE/" 2>/dev/null || true
    rm -f "$ICONS_BASE/.DS_Store" 2>/dev/null || true
  fi
}

# ---- Entry ----
if [[ -z "$THEME" ]]; then
  usage
  exit 1
fi

# Ensure icons directory exists (and is NOT a symlink)
ensure_not_symlink_dir "$ICONS_DIR"

# Ensure we have a "known-good" baseline to restore to
make_default_backup_if_missing

echo "Switching to theme: $THEME"

if [[ "$THEME" == "normal" ]]; then
  if [[ ! -d "$ICONS_BASE" ]]; then
    err "Missing $ICONS_BASE so I can't restore defaults."
    exit 1
  fi

  # Restore default icons
  copy_icons "$ICONS_BASE"

  # Clear any themed backgrounds so the display truly returns to baseline
  rm -f "$BASE/background-day.jpg" "$BASE/background-night.jpg"

  echo "Normal theme restored: icons reset and backgrounds cleared."
  echo "Theme '$THEME' active."
  exit 0
fi

# Theme mode
if [[ ! -d "$THEMES/$THEME/icons" ]]; then
  err "Theme '$THEME' not found or missing icons folder: $THEMES/$THEME/icons"
  echo
  echo "Available themes:"
  if [[ -d "$THEMES" ]]; then ls "$THEMES"; else echo "(no $THEMES folder)"; fi
  exit 1
fi

# Apply themed icons
copy_icons "$THEMES/$THEME/icons"

# Apply themed backgrounds (copy/overwrite if present)
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
