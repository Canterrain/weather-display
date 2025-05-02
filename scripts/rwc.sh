#!/bin/bash
export DISPLAY=:0
cd /home/$USER/weather-display || exit 1

# Wait a little to make sure X server is fully up
sleep 3

# Start unclutter-xfixes to hide the cursor
unclutter-xfixes --timeout 0 --jitter 0 --ignore-scrolling &

# Start the Express server
node server.js &

# Wait for server to fully start
sleep 2

# Launch Electron
./node_modules/.bin/electron .