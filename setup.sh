#!/bin/bash
set -e

echo "-------------------------------"
echo "Clock Weather Display Setup"
echo "-------------------------------"

# 1. Prompt for config (NO OpenWeather key anymore)
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
import json, urllib.parse, urllib.request, sys

city = ${city@Q}
url = "https://geocoding-api.open-meteo.com/v1/search?name={}&count=1&language=en&format=json".format(
    urllib.parse.quote(city)
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

r = results[0]
out = {
  "lat": r.get("latitude"),
  "lon": r.get("longitude"),
  "timezone": r.get("timezone") or "auto"
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
  "thundersnowC": 1
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
echo " Setup complete! Please REBOOT to apply."
echo "---------------------------------------"
