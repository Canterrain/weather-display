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

// --- Open-Meteo geocoding: location -> {lat, lon, timezone} ---
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

  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
  return updated;
}

function temperatureUnitFromCfg(cfg) {
  return cfg.units === 'metric' ? 'celsius' : 'fahrenheit';
}

// If Open-Meteo says thunderstorm (95/96/99) AND it's cold enough, show thundersnow icon.
function isThundersnow(cfg, weathercode, tempNow, tempUnit) {
  const thunderCodes = [95, 96, 99];
  if (!thunderCodes.includes(weathercode)) return false;

  const thresholdF = typeof cfg.thundersnowF === 'number' ? cfg.thundersnowF : 34;
  const thresholdC = typeof cfg.thundersnowC === 'number' ? cfg.thundersnowC : 1;

  if (tempUnit === 'fahrenheit') return tempNow <= thresholdF;
  return tempNow <= thresholdC;
}

// Recent snow override:
// If snowfall > 0 in the last N hours, force current weathercode to "snow" family
function applyRecentSnowOverride(cfg, currentCode, hourly, nowIso) {
  const recentHours = typeof cfg.recentSnowHours === 'number' ? cfg.recentSnowHours : 2;
  const snowThreshold = typeof cfg.recentSnowMm === 'number' ? cfg.recentSnowMm : 0;

  const times = hourly?.time;
  const snowfall = hourly?.snowfall;
  const codes = hourly?.weathercode;

  if (!Array.isArray(times) || !Array.isArray(snowfall) || !Array.isArray(codes)) {
    return currentCode;
  }

  const parse = (s) => new Date(s).getTime();
  const nowT = parse(nowIso);
  if (!Number.isFinite(nowT)) return currentCode;

  let bestI = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < times.length; i++) {
    const t = parse(times[i]);
    if (!Number.isFinite(t)) continue;
    const diff = Math.abs(t - nowT);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestI = i;
    }
  }
  if (bestI < 0) return currentCode;

  const startI = Math.max(0, bestI - recentHours);

  let sawSnow = false;
  let sawSnowCode = false;

  for (let i = startI; i <= bestI; i++) {
    const s = Number(snowfall[i] ?? 0);
    const c = Number(codes[i] ?? -1);

    if (s > snowThreshold) sawSnow = true;

    // Snow-ish codes in Open-Meteo: 71-77, 85-86
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) sawSnowCode = true;
  }

  if (!sawSnow && !sawSnowCode) return currentCode;

  // 73 = moderate snow fall (works with your mapping -> snow)
  return 73;
}

function safeDailyValue(arr, i) {
  if (!Array.isArray(arr)) return null;
  if (i < 0 || i >= arr.length) return null;
  return arr[i];
}

app.get('/weather', async (req, res) => {
  config = loadConfig();
  if (!config) return res.status(500).json({ error: 'Missing config.json' });

  try {
    const cfg = await ensureLatLonTimezone(config);
    const tempUnit = temperatureUnitFromCfg(cfg);

    // We want: today + next 5 days available so we can build 5 forecast entries (tomorrow..+5)
    // => need at least 6 days total in the daily arrays (index 0..5)
    const forecastDays = 6;

    // Include sunrise/sunset so the frontend can do true day/night backgrounds.
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(cfg.lat)}` +
      `&longitude=${encodeURIComponent(cfg.lon)}` +
      `&current_weather=true` +
      `&hourly=weathercode,snowfall` +
      `&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,weathercode` +
      `&temperature_unit=${encodeURIComponent(tempUnit)}` +
      `&timezone=${encodeURIComponent(cfg.timezone || 'auto')}` +
      `&forecast_days=${forecastDays}`;

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
    const hourly = data.hourly;

    if (!cur || !daily) throw new Error('Open-Meteo response missing current_weather or daily');

    const highTodayRaw = safeDailyValue(daily.temperature_2m_max, 0);
    const lowTodayRaw = safeDailyValue(daily.temperature_2m_min, 0);

    const highToday = highTodayRaw == null ? null : Math.round(highTodayRaw);
    const lowToday = lowTodayRaw == null ? null : Math.round(lowTodayRaw);

    const currentTemp = Math.round(cur.temperature);
    let currentCode = Number(cur.weathercode);
    const isDay = cur.is_day === 1;

    // Apply “recent snow wins” to the CURRENT icon code
    currentCode = applyRecentSnowOverride(cfg, currentCode, hourly, cur.time);

    const currentThundersnow = isThundersnow(cfg, currentCode, currentTemp, tempUnit);

    // Clamp hi/lo so current isn’t visually above “high”
    const fixedHigh = highToday == null ? currentTemp : Math.max(highToday, currentTemp);
    const fixedLow = lowToday == null ? currentTemp : Math.min(lowToday, currentTemp);

    // Today sunrise/sunset (ISO strings from Open-Meteo in the requested timezone)
    const sunriseToday = safeDailyValue(daily.sunrise, 0) || null;
    const sunsetToday = safeDailyValue(daily.sunset, 0) || null;

    const forecast = [];
    // Build exactly 5 forecast entries: tomorrow (1) through +5 (5)
    for (let i = 1; i <= 5; i++) {
      const maxRaw = safeDailyValue(daily.temperature_2m_max, i);
      const minRaw = safeDailyValue(daily.temperature_2m_min, i);
      const codeRaw = safeDailyValue(daily.weathercode, i);

      if (maxRaw == null || minRaw == null || codeRaw == null) continue;

      const max = Math.round(maxRaw);
      const min = Math.round(minRaw);
      const mid = Math.round((max + min) / 2);
      const code = Number(codeRaw);

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
        thundersnow: currentThundersnow,

        // Additive fields (non-breaking):
        sunrise: sunriseToday,
        sunset: sunsetToday
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
