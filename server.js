const express = require('express');
const fetch = require('node-fetch');
const AbortController = global.AbortController || require('abort-controller');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const configPath = path.join(__dirname, 'config.json');

// Load config (we'll also re-read on demand if we update it)
function loadConfig() {
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

let config = loadConfig();

// --- last-good cache ---
let lastGoodPayload = null;
let lastGoodAt = 0;

// --- fetch with timeout ---
async function fetchWithTimeout(url, ms = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

// Format: YYYY-MM-DD for a unix timestamp shifted by tzOffsetSeconds
function dateKeyFromUnixWithTz(dtSeconds, tzOffsetSeconds) {
  const d = new Date((dtSeconds + tzOffsetSeconds) * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Geocode "City,ST,CC" -> {lat, lon} using OpenWeather geocoding (and persist to config.json)
async function ensureLatLon(cfg) {
  if (typeof cfg.lat === 'number' && typeof cfg.lon === 'number') return cfg;

  const geoUrl = `https://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(cfg.location)}&limit=1&appid=${cfg.apiKey}`;
  const geoResp = await fetchWithTimeout(geoUrl, 10000);
  const geoData = await geoResp.json();

  if (!geoResp.ok || !Array.isArray(geoData) || geoData.length === 0) {
    throw new Error(`Geocoding failed for location "${cfg.location}"`);
  }

  const lat = geoData[0].lat;
  const lon = geoData[0].lon;

  if (typeof lat !== 'number' || typeof lon !== 'number') {
    throw new Error(`Geocoding returned invalid lat/lon for "${cfg.location}"`);
  }

  // Persist to config.json so future runs don't need geocoding
  const updated = { ...cfg, lat, lon };
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
  return updated;
}

// Fetch daily hi/lo from Open-Meteo for "today"
async function fetchOpenMeteoTodayHiLo(cfg) {
  const tz = cfg.timezone || 'auto';

  // Map config.units -> Open-Meteo temperature_unit
  const temperatureUnit = cfg.units === 'metric' ? 'celsius' : 'fahrenheit';

  // One-day daily forecast is enough for today
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${encodeURIComponent(cfg.lat)}` +
    `&longitude=${encodeURIComponent(cfg.lon)}` +
    `&daily=temperature_2m_max,temperature_2m_min` +
    `&temperature_unit=${encodeURIComponent(temperatureUnit)}` +
    `&timezone=${encodeURIComponent(tz)}` +
    `&forecast_days=1`;

  const resp = await fetchWithTimeout(url, 10000);
  const data = await resp.json();

  if (!resp.ok) {
    throw new Error(`Open-Meteo fetch failed: ${JSON.stringify(data).slice(0, 200)}`);
  }

  const maxArr = data?.daily?.temperature_2m_max;
  const minArr = data?.daily?.temperature_2m_min;

  if (!Array.isArray(maxArr) || !Array.isArray(minArr) || maxArr.length < 1 || minArr.length < 1) {
    throw new Error('Open-Meteo response missing daily temperature arrays');
  }

  return {
    high: Math.round(maxArr[0]),
    low: Math.round(minArr[0]),
  };
}

app.get('/weather', async (req, res) => {
  config = loadConfig();
  if (!config) return res.status(500).json({ error: 'Missing config.json' });

  try {
    // Ensure lat/lon exist for Open-Meteo (writes back into config if needed)
    const cfg = await ensureLatLon(config);

    const currentUrl =
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(cfg.location)}` +
      `&appid=${cfg.apiKey}&units=${cfg.units}`;

    const forecastUrl =
      `https://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(cfg.location)}` +
      `&appid=${cfg.apiKey}&units=${cfg.units}`;

    // Parallel: OpenWeather current+forecast, and Open-Meteo daily hi/lo
    const [currentResp, forecastResp, meteoHiLo] = await Promise.all([
      fetchWithTimeout(currentUrl, 10000),
      fetchWithTimeout(forecastUrl, 10000),
      fetchOpenMeteoTodayHiLo(cfg),
    ]);

    const currentData = await currentResp.json();
    const forecastData = await forecastResp.json();

    if (!currentResp.ok || !forecastResp.ok) {
      console.error('OpenWeather fetch error', currentData, forecastData);

      if (lastGoodPayload) {
        return res.json({ ...lastGoodPayload, stale: true, staleAgeMs: Date.now() - lastGoodAt });
      }

      return res.status(500).json({ error: 'Weather fetch failed' });
    }

    // Build simplified forecast (next 4 days, skip "today" in the city's timezone)
    const dailyForecast = [];

    const tzOffset = (forecastData.city && typeof forecastData.city.timezone === 'number')
      ? forecastData.city.timezone
      : 0;

    const todayKey = dateKeyFromUnixWithTz(Math.floor(Date.now() / 1000), tzOffset);

    const forecastsByDay = {};
    (forecastData.list || []).forEach(entry => {
      const key = dateKeyFromUnixWithTz(entry.dt, tzOffset);
      (forecastsByDay[key] ??= []).push(entry);
    });

    const forecastKeys = Object.keys(forecastsByDay).sort();

    for (const dateKey of forecastKeys) {
      if (dateKey === todayKey) continue;

      const entries = forecastsByDay[dateKey];

      // Choose a midday-ish entry for that day
      const middayEntry =
        entries.find(e => {
          const hour = new Date((e.dt + tzOffset) * 1000).getUTCHours();
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
        // Hybrid: stable daily high/low from Open-Meteo
        high: meteoHiLo.high,
        low: meteoHiLo.low,
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

    if (lastGoodPayload) {
      return res.json({ ...lastGoodPayload, stale: true, staleAgeMs: Date.now() - lastGoodAt });
    }

    res.status(500).json({ error: 'Weather server error' });
  }
});

app.listen(PORT, () => console.log(`Weather server running at http://localhost:${PORT}`));
