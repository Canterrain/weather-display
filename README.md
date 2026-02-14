# Clock Weather Display

![Clock Weather Display](https://github.com/user-attachments/assets/b909da12-5851-4d60-9017-aa0ce8f040c7)

A fullscreen clock and weather dashboard designed for Raspberry Pi the Wisecoco 8.8" IPS HDMI display. The UI pulls real-time weather data from Open-Meteo and works great mounted under cabinets or as a minimalist desk display.

## ✨ Features

- Digital clock with configurable 12h or 24h format
- Day/date display
- Real-time weather via Open-Meteo (no API key required)
- Custom SVG weather icons
- Auto screen rotation to landscape
- Optional background images with day/night support
- Auto-start with PM2 on boot
- Clean, modern layout designed for 1920×480 displays

## 🖥 Requirements

- [Raspberry Pi 4](https://amzn.to/40en56s) (affiliate)
- or
- [Raspberry Pi 5](https://amzn.to/3ZEJUQH) (affiliate)
- [Rasperry Pi Power Supply](https://amzn.to/3MvrPBF) (affiliate)
- [Wisecoco HDMI display](https://amzn.to/4cuofSN) (affiliate)
- [Micro HDMI to HDMI adapter](https://amzn.to/3ZyFOJZ) (affiliate)
- Raspberry Pi OS (Bookworm recommended)

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

- Install all required system and Node.js dependencies
- Set up screen rotation for landscape-oriented displays
- Configure PM2 to auto-launch the app at boot

💡 After setup finishes, everything should work automatically without reboot.


---

## 🖼️ Custom Backgrounds

You can display background images by placing files in the `public/assets/` directory.

### Generic (day-only)
If only a generic background is present, it will be shown during the day and hidden at night:

- `background.jpg`
- `background.webp`
- `background.png`

### Day / Night backgrounds
You can also provide separate backgrounds for day and night:

- `background-day.jpg`
- `background-day.webp`
- `background-day.png`
- `background-night.jpg`
- `background-night.webp`
- `background-night.png`

✅ The first valid file found in each category will be used.  
Recommended resolution: **1920×480**

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

| Path                        | Description                                  |
|-----------------------------|----------------------------------------------|
| `public/index.html`         | Main UI layout                               |
| `public/style.css`          | Display styles                               |
| `public/renderer/clock.js`  | Time and date logic                          |
| `public/renderer/weather.js`| Weather data fetch & rendering               |
| `server.js`                 | Express server for frontend                  |
| `scripts/rwc.sh`            | PM2 launch script                            |
| `config.json`               | Created by `setup.sh` for user configuration |



---

## 🛠️ Development Notes

This project runs as a Node.js server (Express) and is typically launched via PM2 on a Raspberry Pi.

For development and testing, you can access the UI directly in a browser:

http://<pi-ip>:3000/

The following developer-only query parameters are available for testing:

- `?force=day` / `?force=night`  
  Forces day or night mode without waiting for real sunrise/sunset.

These testing features are opt-in and do not affect normal operation.

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

Made by [Josh Hendrickson](https://anoraker.com)
