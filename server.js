const express = require('express');
const fetch = require('node-fetch');
const AbortController = global.AbortController || require('abort-controller');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

const configPath = path.join(__dirname, 'config.json');

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

// --- Open-Meteo geocoding: "City,ST,CC" -> {lat, lon, timezone} ---
async function geocodeLocation(location) {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search` +
    `?name=${encodeURIComponent(location)}` +
    `&count=1&language=en&format=json`;

  const resp = await fetchWithTimeout(url, 10000);
  const data = await resp.json();

  if (!resp.ok || !data || !Array.isArray(data.results) || data.results.length === 0) {
    throw new Error(`Geocoding failed for location "${location}"`);
  }

  const r = data.results[0];

  if (typeof r.latitude !== 'number' || typeof r.longitude !== 'number') {
    throw new Error(`Geocoding returned invalid lat/lon for "${location}"`);
  }

  return {
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone || 'auto',
    resolvedName: [r.name, r.admin1, r.country_code].filter(Boolean).join(', ')
  };
}

async function ensureLatLonTimezone(cfg) {
  const hasLatLon = typeof cfg.lat === 'number' && typeof cfg.lon === 'number';
  const hasTz = typeof cfg.timezone === 'string' && cfg.timezone.length > 0;

  if (hasLatLon && hasTz) return cfg;

  const geo = await geocodeLocation(cfg.location);

  const updated = {
    ...cfg,
    lat: geo.lat,
    lon: geo.lon,
    timezone: geo.timezone || 'auto'
  };

  // Persist so future runs don’t need geocoding
  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
  return updated;
}

function temperatureUnitFromCfg(cfg) {
  return cfg.units === 'metric' ? 'celsius' : 'fahrenheit';
}

// Infer "thundersnow":
// If Open-Meteo says thunderstorm (95/96/99) AND it's cold enough,
// show thundersnow icon. Threshold is configurable via config.thundersnowF / thundersnowC.
function isThundersnow(cfg, weathercode, tempNow, tempUnit) {
  const thunderCodes = [95, 96, 99];
  if (!thunderCodes.includes(weathercode)) return false;

  // default threshold: <= 34°F (or <= 1°C) is a decent “likely snow mix” heuristic
  const thresholdF = typeof cfg.thundersnowF === 'number' ? cfg.thundersnowF : 34;
  const thresholdC = typeof cfg.thundersnowC === 'number' ? cfg.thundersnowC : 1;

  if (tempUnit === 'fahrenheit') return tempNow <= thresholdF;
  return tempNow <= thresholdC;
}

app.get('/weather', async (req, res) => {
  config = loadConfig();
  if (!config) return res.status(500).json({ error: 'Missing config.json' });

  try {
    const cfg = await ensureLatLonTimezone(config);
    const tempUnit = temperatureUnitFromCfg(cfg);

    // We request:
    // - current: temp, weathercode, is_day
    // - daily: max/min and weathercode (today + next 4)
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(cfg.lat)}` +
      `&longitude=${encodeURIComponent(cfg.lon)}` +
      `&current_weather=true` +
      `&daily=temperature_2m_max,temperature_2m_min,weathercode` +
      `&temperature_unit=${encodeURIComponent(tempUnit)}` +
      `&timezone=${encodeURIComponent(cfg.timezone || 'auto')}` +
      `&forecast_days=5`;

    const resp = await fetchWithTimeout(url, 10000);
    const data = await resp.json();

    if (!resp.ok) {
      console.error('Open-Meteo fetch error', data);
      if (lastGoodPayload) {
        return res.json({ ...lastGoodPayload, stale: true, staleAgeMs: Date.now() - lastGoodAt });
      }
      return res.status(500).json({ error: 'Weather fetch failed' });
    }

    const cur = data.current_weather;
    const daily = data.daily;

    if (!cur || !daily) {
      throw new Error('Open-Meteo response missing current_weather or daily');
    }

    const highToday = Math.round(daily.temperature_2m_max[0]);
    const lowToday = Math.round(daily.temperature_2m_min[0]);

    const currentTemp = Math.round(cur.temperature);
    const currentCode = Number(cur.weathercode);
    const isDay = cur.is_day === 1;

    const currentThundersnow = isThundersnow(cfg, currentCode, currentTemp, tempUnit);

    // OPTIONAL: prevent visually-odd “current > high” by clamping high/low to include current
    const fixedHigh = Math.max(highToday, currentTemp);
    const fixedLow = Math.min(lowToday, currentTemp);

    const forecast = [];
    for (let i = 1; i <= 4; i++) {
      const max = Math.round(daily.temperature_2m_max[i]);
      const min = Math.round(daily.temperature_2m_min[i]);
      const mid = Math.round((max + min) / 2);
      const code = Number(daily.weathercode[i]);

      // For daily forecast icons, use day-style icons (is_day=true).
      // Thundersnow for forecast: infer using the *mid* temp (you could choose min instead).
      const thundersnow = isThundersnow(cfg, code, mid, tempUnit);

      forecast.push({
        temp: mid,
        high: max,
        low: min,
        code,
        is_day: true,
        thundersnow
      });
    }

    const payload = {
      current: {
        temp: currentTemp,
        high: fixedHigh,
        low: fixedLow,
        code: currentCode,
        is_day: isDay,
        thundersnow: currentThundersnow
      },
      forecast
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
