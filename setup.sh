#!/bin/bash
set -euo pipefail

echo "-------------------------------"
echo "Clock Weather Display Setup"
echo "-------------------------------"

# ---------------------------------------------------------------------------
# Guardrails
# ---------------------------------------------------------------------------

# Do not run the whole script as root (breaks npm/pm2 paths and installs into /root)
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

# ---------------------------------------------------------------------------
# 1) Prompt for config
# ---------------------------------------------------------------------------
read -r -p "Enter your city (e.g., Cincinnati,OH,US): " city
read -r -p "Choose time format (12 or 24): " timeFormat
read -r -p "Choose temperature units (imperial or metric): " units

# ---------------------------------------------------------------------------
# 2) Validate inputs
# ---------------------------------------------------------------------------
if [[ "$timeFormat" != "12" && "$timeFormat" != "24" ]]; then
  timeFormat="12"
fi

if [[ "$units" != "imperial" && "$units" != "metric" ]]; then
  units="imperial"
fi

# ---------------------------------------------------------------------------
# 3) Install system dependencies (base)
# ---------------------------------------------------------------------------
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
  xserver-xorg \
  xinit \
  x11-xserver-utils \
  wlr-randr

# Hide mouse cursor (kiosk mode)
sudo apt-get remove -y unclutter || true
sudo apt-get install -y unclutter-xfixes

# ---------------------------------------------------------------------------
# 4) Ensure Node.js 18 LTS (better Electron compatibility)
# ---------------------------------------------------------------------------
ensure_node18() {
  local major="0"
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]')"
  fi

  if [[ "$major" != "18" ]]; then
    echo "Installing Node.js 18 LTS..."
    # Remove distro node/npm if present to avoid conflicts
    sudo apt-get remove -y nodejs npm || true
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi

  echo "Node: $(node -v)"
  echo "npm:  $(npm -v)"
}

ensure_node18

# Make npm downloads more resilient on flaky networks
npm config set fetch-retries 5 >/dev/null
npm config set fetch-retry-maxtimeout 120000 >/dev/null

# ---------------------------------------------------------------------------
# 5) Backup existing config.json (do not reuse automatically)
# ---------------------------------------------------------------------------
if [[ -f "$HOME/weather-display/config.json" ]]; then
  ts="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$HOME/weather-display-backups"
  cp -f "$HOME/weather-display/config.json" "$HOME/weather-display-backups/config.json.$ts.bak"
  echo "Backed up existing config.json to: ~/weather-display-backups/config.json.$ts.bak"
fi

# ---------------------------------------------------------------------------
# 6) Ensure fresh copy of weather-display
# ---------------------------------------------------------------------------
echo "Cloning latest version of weather-display from GitHub..."
rm -rf "$HOME/weather-display"
git clone https://github.com/Canterrain/weather-display.git "$HOME/weather-display"

# ---------------------------------------------------------------------------
# 7) Resolve city -> lat/lon/timezone using Open-Meteo Geocoding API (no key)
# ---------------------------------------------------------------------------
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

# ---------------------------------------------------------------------------
# 8) Create config.json
# ---------------------------------------------------------------------------
cat <<EOF > "$HOME/weather-display/config.json"
{
  "location": "$city",
  "lat": $lat,
  "lon": $lon,
  "timezone": "$tz",
  "units": "$units",
  "timeFormat": "$timeFormat",
  "thundersnowF": 34,
  "thundersnowC": 1,
  "recentSnowHours": 2,
  "recentSnowMm": 0
}
EOF

# ---------------------------------------------------------------------------
# 9) Fonts (Roboto Mono from repo folder)
# ---------------------------------------------------------------------------
echo "Installing Roboto Mono font..."
mkdir -p "$HOME/.local/share/fonts/RobotoMono"
cp -f "$HOME/weather-display/fonts/RobotoMono/"*.ttf "$HOME/.local/share/fonts/RobotoMono/" 2>/dev/null || true
fc-cache -fv >/dev/null || true

# ---------------------------------------------------------------------------
# 10) Install Node dependencies (reproducible when lockfile exists)
# ---------------------------------------------------------------------------
echo "Installing Node dependencies..."
cd "$HOME/weather-display"

if [[ -f package-lock.json ]]; then
  npm ci
else
  npm install
fi

# ---------------------------------------------------------------------------
# 11) Install PM2 globally
# ---------------------------------------------------------------------------
echo "Installing PM2..."
sudo npm install -g pm2

# ---------------------------------------------------------------------------
# 12) Create rotate_display.sh (supports Wayland or X11)
# ---------------------------------------------------------------------------
cat <<'EOF' > "$HOME/weather-display/rotate_display.sh"
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
EOF
chmod +x "$HOME/weather-display/rotate_display.sh"

# ---------------------------------------------------------------------------
# 13) Setup systemd user service for rotation
# ---------------------------------------------------------------------------
mkdir -p "$HOME/.config/systemd/user"
cat <<EOF > "$HOME/.config/systemd/user/rotate-display.service"
[Unit]
Description=Rotate Display on Boot
After=graphical-session.target

[Service]
Type=simple
ExecStart=/home/$USER/weather-display/rotate_display.sh
TimeoutSec=30
Restart=on-failure

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reexec
systemctl --user daemon-reload
systemctl --user enable rotate-display.service

# ---------------------------------------------------------------------------
# 14) Start app via PM2
# ---------------------------------------------------------------------------
chmod +x "$HOME/weather-display/scripts/rwc.sh"
pm2 start "$HOME/weather-display/scripts/rwc.sh" --name weather-display

# ---------------------------------------------------------------------------
# 15) Enable PM2 to autostart at boot
# ---------------------------------------------------------------------------
pm2StartupCmd="$(pm2 startup systemd -u "$USER" --hp "/home/$USER" | grep sudo || true)"
if [[ -n "$pm2StartupCmd" ]]; then
  eval "$pm2StartupCmd"
fi
pm2 save

echo "---------------------------------------"
echo " Setup complete!"
echo "---------------------------------------"
echo "If you ever re-run setup.sh, your previous config.json backups are in:"
echo "  ~/weather-display-backups/"
