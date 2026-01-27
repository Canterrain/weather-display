const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const configPath = path.join(__dirname, 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : null;

// --- ADD: last-good cache ---
let lastGoodPayload = null;
let lastGoodAt = 0;

// --- ADD: fetch with timeout ---
async function fetchWithTimeout(url, ms = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

app.get('/weather', async (req, res) => {
  if (!config) return res.status(500).json({ error: 'Missing config.json' });

  try {
    const currentUrl = `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(config.location)}&appid=${config.apiKey}&units=${config.units}`;
    const forecastUrl = `http://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(config.location)}&appid=${config.apiKey}&units=${config.units}`;

    const [currentResp, forecastResp] = await Promise.all([
      fetchWithTimeout(currentUrl, 10000),
      fetchWithTimeout(forecastUrl, 10000),
    ]);

    const currentData = await currentResp.json();
    const forecastData = await forecastResp.json();

    if (!currentResp.ok || !forecastResp.ok) {
      console.error('Weather fetch error', currentData, forecastData);

      // Serve last good data instead of "freezing"
      if (lastGoodPayload) {
        return res.json({ ...lastGoodPayload, stale: true, staleAgeMs: Date.now() - lastGoodAt });
      }

      return res.status(500).json({ error: 'Weather fetch failed' });
    }

    // Build simplified forecast (next 4 days, skip today)
    const dailyForecast = [];
    const now = new Date();
    const todayDate = now.getDate();

    const forecastsByDay = {};
    forecastData.list.forEach(entry => {
      const entryDate = new Date(entry.dt * 1000);
      const dateKey = `${entryDate.getFullYear()}-${entryDate.getMonth()+1}-${entryDate.getDate()}`; // month+1

      (forecastsByDay[dateKey] ??= []).push(entry);
    });

    const forecastKeys = Object.keys(forecastsByDay).sort();

    for (const dateKey of forecastKeys) {
      const entries = forecastsByDay[dateKey];

      const entryDate = new Date(entries[0].dt * 1000);
      if (entryDate.getDate() === todayDate) continue;

      const middayEntry =
        entries.find(e => {
          const hour = new Date(e.dt * 1000).getHours();
          return hour >= 11 && hour <= 13;
        }) || entries[Math.floor(entries.length / 2)];

      dailyForecast.push({
        temp: Math.round(middayEntry.main.temp),
        icon: middayEntry.weather[0].icon,
        main: middayEntry.weather[0].main
      });

      if (dailyForecast.length >= 4) break;
    }

    const payload = {
      current: {
        temp: Math.round(currentData.main.temp),
        high: Math.round(currentData.main.temp_max),
        low: Math.round(currentData.main.temp_min),
        main: currentData.weather[0].main,
        icon: currentData.weather[0].icon
      },
      forecast: dailyForecast
    };

    lastGoodPayload = payload;
    lastGoodAt = Date.now();

    res.json(payload);
  } catch (error) {
    console.error('Server error fetching weather', error);

    // Serve last good data if available
    if (lastGoodPayload) {
      return res.json({ ...lastGoodPayload, stale: true, staleAgeMs: Date.now() - lastGoodAt });
    }

    res.status(500).json({ error: 'Weather server error' });
  }
});

app.listen(PORT, () => console.log(`Weather server running at http://localhost:${PORT}`));
