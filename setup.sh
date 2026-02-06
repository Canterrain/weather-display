#!/bin/bash
set -e

echo "-------------------------------"
echo "Clock Weather Display Setup"
echo "-------------------------------"

# 1. Prompt for config 
read -p "Enter your city (e.g., Cincinnati,OH,US): " city
read -p "Choose time format (12 or 24): " timeFormat
read -p "Choose temperature units (imperial or metric): " units

# 2. Validate inputs
if [[ "$timeFormat" != "12" && "$timeFormat" != "24" ]]; then
  timeFormat="12"
fi

if [[ "$units" != "imperial" && "$units" != "metric" ]]; then
  units="imperial"
fi

# 3. Ensure fresh copy of weather-display
echo "Cloning latest version of weather-display from GitHub..."
rm -rf ~/weather-display
git clone https://github.com/Canterrain/weather-display.git ~/weather-display

# 4. Resolve city -> lat/lon/timezone using Open-Meteo Geocoding API (no key)
echo "Resolving location to latitude/longitude/timezone..."
geo_json=$(python3 - <<PY
import json, urllib.parse, urllib.request, sys, re

raw = ${city@Q}

# Parse inputs like:
# "Loveland,OH,US"  -> name="Loveland", state="OH", country="US"
# "Aurora,IN,US"
# If user enters something else (e.g., "Loveland Ohio"), we still try, but state/country matching may be weaker.
parts = [p.strip() for p in raw.split(",") if p.strip()]
name = parts[0] if parts else raw.strip()

state = None
country = None
if len(parts) >= 2:
  state = parts[1]
if len(parts) >= 3:
  country = parts[2]

# Only pass countryCode if it looks like a 2-letter code (US, CA, etc.)
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

# Helper: normalize state input.
# Open-Meteo returns admin1 as full state name (e.g., "Ohio"), not "OH".
# So we map common US abbreviations to names for better matching.
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
    # If they typed "Indiana" etc.
    want_state_name = s

want_name = name.strip().lower()

def score(r):
  # Higher score wins.
  sc = 0
  r_name = (r.get("name") or "").strip().lower()
  r_admin1 = (r.get("admin1") or "").strip()
  r_cc = (r.get("country_code") or "").strip().upper()

  # Exact name match strongly preferred
  if r_name == want_name:
    sc += 100
  elif want_name and r_name and want_name in r_name:
    sc += 30

  # State match (admin1) if provided
  if want_state_name and r_admin1 and r_admin1.lower() == want_state_name.lower():
    sc += 80

  # Country match if provided
  if country and re.fullmatch(r"[A-Za-z]{2}", country) and r_cc == country.upper():
    sc += 20

  # Prefer more "place-like" entries and higher population when tied
  pop = r.get("population") or 0
  try:
    pop = int(pop)
  except Exception:
    pop = 0
  sc += min(pop // 1000, 25)  # cap the bonus

  return sc

best = max(results, key=score)

out = {
  "lat": best.get("latitude"),
  "lon": best.get("longitude"),
  "timezone": best.get("timezone") or "auto"
}
print(json.dumps(out))
PY
)


lat=$(echo "$geo_json" | python3 -c "import sys, json; s=sys.stdin.read().strip(); print(json.loads(s).get('lat','') if s else '')")
lon=$(echo "$geo_json" | python3 -c "import sys, json; s=sys.stdin.read().strip(); print(json.loads(s).get('lon','') if s else '')")
tz=$(echo "$geo_json" | python3 -c "import sys, json; s=sys.stdin.read().strip(); print(json.loads(s).get('timezone','auto') if s else 'auto')")

if [[ -z "$lat" || -z "$lon" ]]; then
  echo "ERROR: Could not resolve lat/lon for '$city'."
  echo "Double-check the format (City,ST,CC) and try again."
  exit 1
fi

# 5. Create config.json
cat <<EOF > ~/weather-display/config.json
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

# 6. Install system dependencies
echo "Installing system packages..."
sudo apt-get update
sudo apt-get install -y nodejs npm git xserver-xorg xinit wlr-randr fontconfig unzip

# 7. Fonts (Roboto Mono from repo folder)
echo "Installing Roboto Mono font..."
mkdir -p ~/.local/share/fonts/RobotoMono
cp -f ~/weather-display/fonts/RobotoMono/*.ttf ~/.local/share/fonts/RobotoMono/ 2>/dev/null || true
fc-cache -fv

# 8. Hide mouse cursor (kiosk mode)
sudo apt-get remove -y unclutter || true
sudo apt-get install -y unclutter-xfixes

# 9. Install Node.js dependencies
cd ~/weather-display || exit 1
npm install electron@28 express@4 node-fetch@2 abort-controller

# 10. Install PM2 globally
sudo npm install -g pm2

# 11. Create rotate_display.sh
cat <<EOF > ~/weather-display/rotate_display.sh
#!/bin/bash
set -e
export DISPLAY=:0
sleep 8
DISPLAY_ID=\$(wlr-randr | awk '/^[^ ]/ {output=\$1} /Enabled: yes/ {print output; exit}')
if [[ -z "\$DISPLAY_ID" ]]; then
  echo "Could not detect display for rotation."
  exit 1
fi
/usr/bin/wlr-randr --output "\$DISPLAY_ID" --transform 90
EOF
chmod +x ~/weather-display/rotate_display.sh

# 12. Setup systemd user service for rotation
mkdir -p ~/.config/systemd/user
cat <<EOF > ~/.config/systemd/user/rotate-display.service
[Unit]
Description=Rotate Display on Boot (Wayland)
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

# 13. Start app via PM2
chmod +x ~/weather-display/scripts/rwc.sh
pm2 start ~/weather-display/scripts/rwc.sh --name weather-display

# 14. Enable PM2 to autostart at boot
pm2StartupCmd=$(pm2 startup systemd -u $USER --hp /home/$USER | grep sudo || true)
if [[ -n "$pm2StartupCmd" ]]; then
  eval "$pm2StartupCmd"
fi
pm2 save

echo "---------------------------------------"
echo " Setup complete!
echo "---------------------------------------"
