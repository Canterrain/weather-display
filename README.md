# Clock Weather Display

A fullscreen clock and weather dashboard designed for Raspberry Pi with HDMI displays like the Wisecoco 8.8" IPS panel. The UI pulls real-time weather data from OpenWeatherMap and works great mounted under cabinets or as a minimalist desk display.



## ✨ Features

- Digital clock with configurable 12h or 24h format
- Day/date display
- Real-time weather via OpenWeatherMap API
- Custom SVG weather icons
- Auto screen rotation to landscape
- Optional background image (automatically detected)
- Auto-start with PM2 on boot
- Clean, modern layout designed for 1920×480 displays

## 🖥 Requirements

- Raspberry Pi 4 or Pi Zero 2 W
- HDMI display (e.g., Wisecoco 8.8" 1920×480 IPS screen)
- Raspberry Pi OS (Bookworm recommended)
- OpenWeatherMap API key

## 🚀 Quick Start

* Download the install script

```
wget https://raw.githubusercontent.com/Canterrain/weather-display/main/setup.sh
```
```
chmod +x setup.sh
```
* Install the software: 
```
./setup.sh
```

The setup script will:

- Prompt for your OpenWeatherMap API key and city
- Install all required system and Node.js dependencies
- Set up screen rotation for landscape-oriented displays
- Configure PM2 to auto-launch the app at boot

💡 After setup finishes, reboot your Pi to apply all changes.

---

## 🔑 Getting an OpenWeatherMap API Key

1. Visit [https://openweathermap.org/api](https://openweathermap.org/api)
2. Sign up for a free account
3. Go to your [API Keys dashboard](https://home.openweathermap.org/api_keys)
4. Copy your key and paste it into the `setup.sh` prompt

---

## 🖼️ Custom Backgrounds

You can display a background image instead of a black background by placing one of the following files in the `public/assets/` directory:

- `background.jpg`
- `background.webp`
- `background.png`

✅ The first valid file found in that order will be used. Recommended resolution: **1920×480**

---

## 🎨 Weather Icon Customization

All weather icons are SVG files stored in:

```
public/assets/icons/
```

To use your own custom icons:

- Replace existing files using the **same filenames** (e.g., `clear-day.svg`, `rain.svg`, etc.)
- Keep them in **SVG format**
- For consistent layout, aim for icons sized around **100×100 pixels**

---

## 🧠 Project Structure

| Path                        | Description                           |
|-----------------------------|---------------------------------------|
| `public/index.html`         | Main UI layout                        |
| `public/style.css`          | Display styles                        |
| `public/renderer/clock.js`  | Time and date logic                   |
| `public/renderer/weather.js`| Weather data fetch & rendering       |
| `server.js`                 | Express server for frontend           |
| `scripts/rwc.sh`            | Electron kiosk launch script          |
| `config.json`               | Created by `setup.sh` for API config  |

---

## 🛠️ Development Notes

To launch manually during development:

```
npm install
npm start
```

This opens the Electron app in a resizable window.

---

## 📦 Autostart via PM2

The setup script automatically configures PM2 to:

```
pm2 start scripts/rwc.sh --name weather-display
pm2 save
pm2 startup
```

This ensures the app runs on boot.

---

## 📃 License

This project is licensed under the [Creative Commons Attribution-NonCommercial 4.0 International License](https://creativecommons.org/licenses/by-nc/4.0/).

© 2025 Josh Hendrickson

---

Shout out to the [Magic Mirror](https://github.com/MagicMirrorOrg/MagicMirror) team for inspiring some of this project.

---

Made  by [Josh Hendrickson](https://anoraker.com)
