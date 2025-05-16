#!/bin/bash

echo "-------------------------------"
echo "Clock Weather Display Setup"
echo "-------------------------------"

# 1. Prompt for config
read -p "Enter your OpenWeatherMap API key: " apiKey
read -p "Enter your city (e.g., Cincinnati,OH,US): " city
read -p "Choose time format (12 or 24): " timeFormat
read -p "Choose temperature units (imperial or metric): " units

# 2. Validate time format
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

# 4. Create config.json
cat <<EOF > ~/weather-display/config.json
{
  "apiKey": "$apiKey",
  "location": "$city",
  "units": "$units",
  "timeFormat": "$timeFormat"
}
EOF

# 5. Install system dependencies
echo "Installing system packages..."
sudo apt-get update
sudo apt-get install -y nodejs npm git xserver-xorg xinit wlr-randr
# Download and install Roboto Mono font manually
echo "Installing Roboto Mono font..."
mkdir -p ~/.fonts
wget -O ~/.fonts/RobotoMono-Regular.ttf https://github.com/google/fonts/raw/main/apache/robotomono/RobotoMono-Regular.ttf
fc-cache -fv
sudo apt-get remove -y unclutter || true
sudo apt-get install -y unclutter-xfixes


# 6. Install Node.js dependencies (MagicMirror matching versions)
cd ~/weather-display || exit 1
npm install electron@28 express@4 node-fetch@2

# 7. Install PM2 globally
sudo npm install -g pm2

# 8. Create rotate_display.sh (for portrait-to-landscape rotation)
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

# 9. Setup systemd user service for rotation
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

# 10. Make rwc.sh executable and start app via PM2
chmod +x ~/weather-display/scripts/rwc.sh
pm2 start ~/weather-display/scripts/rwc.sh --name weather-display

# 11. Enable PM2 to autostart at boot
pm2StartupCmd=$(pm2 startup systemd -u $USER --hp /home/$USER | grep sudo)
eval "$pm2StartupCmd"
pm2 save


echo "---------------------------------------"
echo " Setup complete! Please REBOOT to apply."
echo "---------------------------------------"
