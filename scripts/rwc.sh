#!/bin/bash
export DISPLAY=:0
cd /home/$USER/weather-display || exit 1

# Wait a little to make sure X server is fully up
sleep 3

# Start unclutter-xfixes to hide the cursor
unclutter-xfixes --timeout 0 --jitter 0 --ignore-scrolling &

# Start the Express server
node server.js &

# Wait for server to be ready (max ~30s)
for i in {1..30}; do
  if curl -fsS http://localhost:3000/weather >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

# Launch Electron
./node_modules/.bin/electron .
