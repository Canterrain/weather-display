#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Clock Weather Display Setup
#
# Supports:
#   - Raspberry Pi OS Bookworm (X11 or Wayland)
#   - Raspberry Pi OS Trixie (Wayland/labwc default)
#
# Goals:
#   - Easy install: "paste commands and you're done"
#   - Re-running setup refreshes the install by wiping ~/weather-display
#   - Wayland/labwc: use labwc autostart for rotation, cursor hide, and app start
#   - X11: keep PM2 + unclutter-xfixes behavior
#   - Keep Bookworm rotation working (systemd user service calling rotate_display.sh)
# -----------------------------------------------------------------------------

echo "-------------------------------"
echo "Clock Weather Display Setup"
echo "-------------------------------"

# -----------------------------------------------------------------------------
# Guardrails
# -----------------------------------------------------------------------------
if [[ "${EUID}" -eq 0 ]]; then
  echo "ERROR: Do not run this script with sudo."
  echo "Run: bash setup.sh"
  exit 1
fi

ARCH="$(uname -m)"
if [[ "$ARCH" == "armv7l" ]]; then
  echo "WARNING: 32-bit Raspberry Pi OS detected (armv7l)."
  echo "Electron installs can fail on 32-bit. Strongly recommend 64-bit Raspberry Pi OS (aarch64)."
  echo "Continuing anyway..."
fi

# -----------------------------------------------------------------------------
# Config prompts
# -----------------------------------------------------------------------------
read -r -p "Enter your city (e.g., Cincinnati,OH,US): " city
read -r -p "Choose time format (12 or 24): " timeFormat
read -r -p "Choose temperature units (imperial or metric): " units

leadingZero12h="true"

if [[ "$timeFormat" != "12" && "$timeFormat" != "24" ]]; then
  timeFormat="12"
fi
if [[ "$units" != "imperial" && "$units" != "metric" ]]; then
  units="imperial"
fi

if [[ "$timeFormat" == "12" ]]; then
  read -r -p "Show leading zero in 12-hour mode, 07:00 AM instead of 7:00 AM? (Y/n) [Y]: " lz
  lz="${lz:-Y}"
  case "$lz" in
    Y|y) leadingZero12h="true" ;;
    N|n) leadingZero12h="false" ;;
    *)   leadingZero12h="true" ;;
  esac
fi

# -----------------------------------------------------------------------------
# Detect session (Wayland vs X11)
# -----------------------------------------------------------------------------
detect_session_type() {
  if [[ "${XDG_SESSION_TYPE:-}" == "wayland" || -n "${WAYLAND_DISPLAY:-}" ]]; then
    echo "wayland"
    return
  fi
  if [[ "${XDG_SESSION_TYPE:-}" == "x11" || -n "${DISPLAY:-}" ]]; then
    echo "x11"
    return
  fi

  # If run over SSH, infer from OS codename
  if [[ -f /etc/os-release ]]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    if [[ "${VERSION_CODENAME:-}" == "trixie" ]]; then
      echo "wayland"
      return
    fi
    if [[ "${VERSION_CODENAME:-}" == "bookworm" ]]; then
      echo "x11"
      return
    fi
  fi

  echo "x11"
}

SESSION_TYPE="$(detect_session_type)"
echo "Detected session type: $SESSION_TYPE"

# -----------------------------------------------------------------------------
# Install system dependencies
# -----------------------------------------------------------------------------
echo "Installing system packages..."
sudo apt-get update
sudo apt-get install -y \
  git \
  python3 \
  python3-venv \
  curl \
  ca-certificates \
  gnupg \
  fontconfig \
  unzip \
  wlr-randr

# X11 packages only when needed
if [[ "$SESSION_TYPE" == "x11" ]]; then
  sudo apt-get install -y \
    xserver-xorg \
    xinit \
    x11-xserver-utils
fi

# Cursor hide dependencies
if [[ "$SESSION_TYPE" == "x11" ]]; then
  sudo apt-get remove -y unclutter || true
  sudo apt-get install -y unclutter-xfixes
else
  sudo apt-get install -y wtype
fi

# -----------------------------------------------------------------------------
# Node.js 18 LTS (matches repo engines and avoids EBADENGINE on Bookworm)
# -----------------------------------------------------------------------------
ensure_node18() {
  local major="0"
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]')"
  fi

  if [[ "$major" != "18" ]]; then
    echo "Installing Node.js 18 LTS..."
    sudo apt-get remove -y nodejs npm || true
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

  echo "Node: $(node -v)"
  echo "npm:  $(npm -v)"
}

ensure_node18

# Make npm downloads more resilient on flaky networks
npm config set fetch-retries 5 >/dev/null 2>&1 || true
npm config set fetch-retry-maxtimeout 120000 >/dev/null 2>&1 || true

# -----------------------------------------------------------------------------
# Backup existing config.json before refresh
# -----------------------------------------------------------------------------
TARGET_DIR="$HOME/weather-display"

if [[ -f "$TARGET_DIR/config.json" ]]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$HOME/weather-display-backups"
  cp -f "$TARGET_DIR/config.json" "$HOME/weather-display-backups/config.json.$ts.bak"
  echo "Backed up existing config.json to: ~/weather-display-backups/config.json.$ts.bak"
fi

# -----------------------------------------------------------------------------
# Refresh install: wipe + clone latest
# Safe even if user ran setup from inside the folder
# -----------------------------------------------------------------------------
if [[ "$(pwd -P)" == "$TARGET_DIR"* ]]; then
  echo "Setup is running from inside $TARGET_DIR."
  echo "Re-launching from HOME so refresh can proceed safely..."
  tmp="/tmp/weather-display-setup.sh"
  cp -f "$0" "$tmp"
  chmod +x "$tmp"
  cd "$HOME"
  exec bash "$tmp"
fi

echo "Cloning latest version of weather-display from GitHub..."
rm -rf "$TARGET_DIR"
git clone https://github.com/Canterrain/weather-display.git "$TARGET_DIR"

# -----------------------------------------------------------------------------
# Resolve city -> lat/lon/timezone via Open-Meteo Geocoding API
# -----------------------------------------------------------------------------
echo "Resolving location to latitude/longitude/timezone..."
geo_json="$(python3 - <<PY
import json, urllib.parse, urllib.request, sys, re

raw = ${city@Q}

parts = [p.strip() for p in raw.split(",") if p.strip()]
name = parts[0] if parts else raw.strip()

state = parts[1] if len(parts) >= 2 else None
country = parts[2] if len(parts) >= 3 else None

countryCodeParam = ""
if country and re.fullmatch(r"[A-Za-z]{2}", country):
  countryCodeParam = f"&countryCode={urllib.parse.quote(country.upper())}"

url = (
  "https://geocoding-api.open-meteo.com/v1/search"
  f"?name={urllib.parse.quote(name)}"
  "&count=10&language=en&format=json"
  f"{countryCodeParam}"
)

try:
  with urllib.request.urlopen(url, timeout=10) as r:
    data = json.load(r)
except Exception:
  data = {}

results = data.get("results") or []
if not results:
  print("")
  sys.exit(0)

US_STATE = {
  "AL":"Alabama","AK":"Alaska","AZ":"Arizona","AR":"Arkansas","CA":"California","CO":"Colorado","CT":"Connecticut",
  "DE":"Delaware","FL":"Florida","GA":"Georgia","HI":"Hawaii","ID":"Idaho","IL":"Illinois","IN":"Indiana","IA":"Iowa",
  "KS":"Kansas","KY":"Kentucky","LA":"Louisiana","ME":"Maine","MD":"Maryland","MA":"Massachusetts","MI":"Michigan",
  "MN":"Minnesota","MS":"Mississippi","MO":"Missouri","MT":"Montana","NE":"Nebraska","NV":"Nevada","NH":"New Hampshire",
  "NJ":"New Jersey","NM":"New Mexico","NY":"New York","NC":"North Carolina","ND":"North Dakota","OH":"Ohio","OK":"Oklahoma",
  "OR":"Oregon","PA":"Pennsylvania","RI":"Rhode Island","SC":"South Carolina","SD":"South Dakota","TN":"Tennessee","TX":"Texas",
  "UT":"Utah","VT":"Vermont","VA":"Virginia","WA":"Washington","WV":"West Virginia","WI":"Wisconsin","WY":"Wyoming",
  "DC":"District of Columbia"
}

want_state_name = None
if state:
  s = state.strip()
  if len(s) == 2 and s.upper() in US_STATE:
    want_state_name = US_STATE[s.upper()]
  else:
    want_state_name = s

want_name = name.strip().lower()

def score(r):
  sc = 0
  r_name = (r.get("name") or "").strip().lower()
  r_admin1 = (r.get("admin1") or "").strip()
  r_cc = (r.get("country_code") or "").strip().upper()

  if r_name == want_name:
    sc += 100
  elif want_name and r_name and want_name in r_name:
    sc += 30

  if want_state_name and r_admin1 and r_admin1.lower() == want_state_name.lower():
    sc += 80

  if country and re.fullmatch(r"[A-Za-z]{2}", country) and r_cc == country.upper():
    sc += 20

  pop = r.get("population") or 0
  try:
    pop = int(pop)
  except Exception:
    pop = 0
  sc += min(pop // 1000, 25)

  return sc

best = max(results, key=score)

out = {
  "lat": best.get("latitude"),
  "lon": best.get("longitude"),
  "timezone": best.get("timezone") or "auto"
}
print(json.dumps(out))
PY
)"

lat="$(echo "$geo_json" | python3 -c "import sys, json; s=sys.stdin.read().strip(); print(json.loads(s).get('lat','') if s else '')")"
lon="$(echo "$geo_json" | python3 -c "import sys, json; s=sys.stdin.read().strip(); print(json.loads(s).get('lon','') if s else '')")"
tz="$(echo "$geo_json" | python3 -c "import sys, json; s=sys.stdin.read().strip(); print(json.loads(s).get('timezone','auto') if s else 'auto')")"

if [[ -z "$lat" || -z "$lon" ]]; then
  echo "ERROR: Could not resolve lat/lon for '$city'."
  echo "Double-check the format (City,ST,CC) and try again."
  exit 1
fi

cat <<EOF > "$TARGET_DIR/config.json"
{
  "location": "$city",
  "lat": $lat,
  "lon": $lon,
  "timezone": "$tz",
  "units": "$units",
  "timeFormat": "$timeFormat",
  "leadingZero12h": $leadingZero12h,
  "thundersnowF": 34,
  "thundersnowC": 1,
  "recentSnowHours": 2,
  "recentSnowMm": 0
}
EOF

# -----------------------------------------------------------------------------
# Fonts
# -----------------------------------------------------------------------------
echo "Installing Roboto Mono font..."
mkdir -p "$HOME/.local/share/fonts/RobotoMono"
cp -f "$TARGET_DIR/fonts/RobotoMono/"*.ttf "$HOME/.local/share/fonts/RobotoMono/" 2>/dev/null || true
fc-cache -fv >/dev/null || true

# -----------------------------------------------------------------------------
# Node dependencies
# -----------------------------------------------------------------------------
echo "Installing Node dependencies..."
cd "$TARGET_DIR"
if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

# -----------------------------------------------------------------------------
# Ensure scripts are executable
# -----------------------------------------------------------------------------
chmod +x "$TARGET_DIR/scripts/rwc.sh" || true

# -----------------------------------------------------------------------------
# X11 rotation: restore the old working model (rotate_display.sh + user service)
# -----------------------------------------------------------------------------
setup_x11_rotation_service() {
  cat <<'EOF' > "$TARGET_DIR/rotate_display.sh"
#!/bin/bash
set -e

sleep 6

# Wayland (harmless if present)
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
EOF
  chmod +x "$TARGET_DIR/rotate_display.sh"

  mkdir -p "$HOME/.config/systemd/user"
  cat <<'EOF' > "$HOME/.config/systemd/user/rotate-display.service"
[Unit]
Description=Rotate Display on Boot
After=graphical-session.target

[Service]
Type=simple
Environment=DISPLAY=:0
Environment=XAUTHORITY=%h/.Xauthority
ExecStart=%h/weather-display/rotate_display.sh
TimeoutSec=30
Restart=on-failure

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable rotate-display.service >/dev/null 2>&1 || true
}

# -----------------------------------------------------------------------------
# Helper scripts (Wayland rotation + restart) - DO NOT COMMIT restart.sh long-term
# -----------------------------------------------------------------------------
cat <<'EOF' > "$TARGET_DIR/scripts/rotate_wayland.sh"
#!/usr/bin/env bash
set -euo pipefail

if ! command -v wlr-randr >/dev/null 2>&1; then
  exit 0
fi

out="$(wlr-randr | awk '
  /^[^ ]/ {o=$1}
  /Enabled: yes/ {print o; exit}
')"

if [[ -n "${out:-}" ]]; then
  wlr-randr --output "$out" --transform 90 || true
fi
EOF
chmod +x "$TARGET_DIR/scripts/rotate_wayland.sh"

cat <<'EOF' > "$TARGET_DIR/scripts/restart.sh"
#!/usr/bin/env bash
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RWC="$APP_DIR/scripts/rwc.sh"

echo "[restart] Stopping weather display..."
pkill -f "$RWC" 2>/dev/null || true
pkill -f "electron.*localhost:3000" 2>/dev/null || true
pkill -f "node .*${APP_DIR}.*server\.js" 2>/dev/null || true

sleep 1

echo "[restart] Starting weather display..."
nohup bash "$RWC" >/tmp/weather-display-restart.log 2>&1 & disown

echo "[restart] Done. Log: /tmp/weather-display-restart.log"
EOF
chmod +x "$TARGET_DIR/scripts/restart.sh"

# -----------------------------------------------------------------------------
# Autostart configuration
# -----------------------------------------------------------------------------
configure_labwc_wayland() {
  echo "Configuring labwc (Wayland) autostart, rotation, and cursor hiding..."

  mkdir -p "$HOME/.config/labwc"

  rc="$HOME/.config/labwc/rc.xml"
  if [[ -f "$rc" ]]; then
    ts="$(date +%Y%m%d-%H%M%S)"
    cp -f "$rc" "$rc.bak.$ts"
  else
    cat <<'XML' > "$rc"
<?xml version="1.0"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
</openbox_config>
XML
  fi

  if ! grep -q 'action name="HideCursor"' "$rc"; then
    tmp_rc="$(mktemp)"
    awk '
      BEGIN { inserted=0 }
      /<\/openbox_config>/ && inserted==0 {
        print ""
        print "  <keyboard>"
        print "    <keybind key=\"A-W-h\">"
        print "      <action name=\"HideCursor\" />"
        print "      <action name=\"WarpCursor\" x=\"-1\" y=\"-1\" />"
        print "    </keybind>"
        print "  </keyboard>"
        print ""
        inserted=1
      }
      { print }
    ' "$rc" > "$tmp_rc"
    mv "$tmp_rc" "$rc"
  fi

  aut="$HOME/.config/labwc/autostart"
  touch "$aut"

  add_line() {
    local line="$1"
    grep -Fqx "$line" "$aut" 2>/dev/null || echo "$line" >> "$aut"
  }

  add_line "bash \"$TARGET_DIR/scripts/rotate_wayland.sh\" &"
  add_line "wtype -M alt -M logo h -m alt -m logo &"
  add_line "bash \"$TARGET_DIR/scripts/rwc.sh\" &"

  echo "labwc configuration updated:"
  echo "  $rc"
  echo "  $aut"
}

configure_x11_pm2() {
  echo "Configuring X11 autostart via PM2..."

  echo "Installing PM2..."
  sudo npm install -g pm2

  pm2 start "$TARGET_DIR/scripts/rwc.sh" --name weather-display || true

  pm2StartupCmd="$(pm2 startup systemd -u "$USER" --hp "/home/$USER" | grep sudo || true)"
  if [[ -n "$pm2StartupCmd" ]]; then
    eval "$pm2StartupCmd"
  fi
  pm2 save
}

if [[ "$SESSION_TYPE" == "wayland" ]]; then
  sudo systemctl disable pm2-"$USER" >/dev/null 2>&1 || true
  configure_labwc_wayland
else
  setup_x11_rotation_service
  configure_x11_pm2
fi

echo "---------------------------------------"
echo " Setup complete!"
echo "---------------------------------------"
echo "Installed to: $TARGET_DIR"
echo "Restart script: $TARGET_DIR/scripts/restart.sh"
echo "If you ever re-run setup.sh, your previous config.json backups are in:"
echo "  ~/weather-display-backups/"
echo ""

if [[ "$SESSION_TYPE" == "wayland" ]]; then
  echo "NOTE: On Wayland/labwc, the display auto-starts via labwc autostart."
fi

echo ""
echo "IMPORTANT:"
echo "A reboot is required to start the display automatically."
echo "Run: sudo reboot"
echo ""
