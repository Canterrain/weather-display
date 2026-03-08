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

// --- helpers ---
function safeDailyValue(arr, i) {
  if (!Array.isArray(arr)) return null;
  if (i < 0 || i >= arr.length) return null;
  return arr[i];
}

function parseIsoMs(s) {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function findNearestIndexByTime(timeArr, targetIso) {
  if (!Array.isArray(timeArr) || timeArr.length === 0) return -1;
  const target = parseIsoMs(targetIso);
  if (target == null) return -1;

  let bestI = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < timeArr.length; i++) {
    const t = parseIsoMs(timeArr[i]);
    if (t == null) continue;
    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestI = i;
    }
  }
  return bestI;
}

function getTempThresholdForSnow(cfg, tempUnit) {
  // Default: 34F / 1C
  const thresholdF = typeof cfg.snowTempF === 'number' ? cfg.snowTempF : 34;
  const thresholdC = typeof cfg.snowTempC === 'number' ? cfg.snowTempC : 1;
  return tempUnit === 'fahrenheit' ? thresholdF : thresholdC;
}

// Hourly “recent snow wins” fallback (your existing logic, slightly tightened)
function applyRecentSnowOverrideHourly(cfg, currentCode, hourly, nowIso) {
  const recentHours = typeof cfg.recentSnowHours === 'number' ? cfg.recentSnowHours : 2;
  const snowThreshold = typeof cfg.recentSnowMm === 'number' ? cfg.recentSnowMm : 0;

  const times = hourly?.time;
  const snowfall = hourly?.snowfall;
  const codes = hourly?.weathercode;

  if (!Array.isArray(times) || !Array.isArray(snowfall) || !Array.isArray(codes)) {
    return { code: currentCode, used: false };
  }

  const bestI = findNearestIndexByTime(times, nowIso);
  if (bestI < 0) return { code: currentCode, used: false };

  const startI = Math.max(0, bestI - recentHours);

  let sawSnow = false;
  let sawSnowCode = false;

  for (let i = startI; i <= bestI; i++) {
    const s = Number(snowfall[i] ?? 0);
    const c = Number(codes[i] ?? -1);

    if (s > snowThreshold) sawSnow = true;
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) sawSnowCode = true;
  }

  if (!sawSnow && !sawSnowCode) return { code: currentCode, used: false };
  return { code: 73, used: true }; // moderate snow icon bucket
}

// NEW: Minutely 15 “it is actively precipitating right now” override
function applyActivePrecipOverrideMinutely(cfg, currentCode, tempNow, tempUnit, min15, nowIso) {
  const times = min15?.time;
  const precip = min15?.precipitation; // mm
  const snowfall = min15?.snowfall;    // mm

  if (!Array.isArray(times) || (!Array.isArray(precip) && !Array.isArray(snowfall))) {
    return { code: currentCode, used: false, reason: null };
  }

  const recentMinutes = typeof cfg.recentPrecipMinutes === 'number' ? cfg.recentPrecipMinutes : 60;
  // Open-Meteo minutely_15 is 15-min resolution => 4 samples per hour
  const samplesBack = Math.max(1, Math.ceil(recentMinutes / 15));

  const bestI = findNearestIndexByTime(times, nowIso);
  if (bestI < 0) return { code: currentCode, used: false, reason: null };

  const startI = Math.max(0, bestI - samplesBack);

  const precipThreshold = typeof cfg.recentPrecipMm === 'number' ? cfg.recentPrecipMm : 0; // any >0 by default
  const snowThreshold = typeof cfg.recentSnowMm15 === 'number' ? cfg.recentSnowMm15 : 0;   // any >0 by default

  let sawAnyPrecip = false;
  let sawAnySnowfall = false;

  for (let i = startI; i <= bestI; i++) {
    const p = Array.isArray(precip) ? Number(precip[i] ?? 0) : 0;
    const s = Array.isArray(snowfall) ? Number(snowfall[i] ?? 0) : 0;

    if (p > precipThreshold) sawAnyPrecip = true;
    if (s > snowThreshold) sawAnySnowfall = true;
  }

  if (!sawAnyPrecip && !sawAnySnowfall) {
    return { code: currentCode, used: false, reason: null };
  }

  // Decide rain vs snow based on temp
  const snowTemp = getTempThresholdForSnow(cfg, tempUnit);
  const isSnowByTemp = tempNow <= snowTemp;

  if (sawAnySnowfall || (sawAnyPrecip && isSnowByTemp)) {
    return { code: 73, used: true, reason: 'minutely_snow_or_cold_precip' };
  }

  // Otherwise treat as rain/showers (61 = slight rain, 63 moderate rain)
  // Pick 61 as a safe “rain” bucket for icons.
  return { code: 61, used: true, reason: 'minutely_rain' };
}

// Optional: expose config to frontend (for clock leading-zero option, etc.)
app.get('/config', (req, res) => {
  const cfg = loadConfig();
  if (!cfg) return res.status(500).json({ error: 'Missing config.json' });

  // Only return non-sensitive settings
  res.json({
    timeFormat: cfg.timeFormat || cfg.clockFormat || cfg.format || null, // tolerate older keys
    leadingZero12h: typeof cfg.leadingZero12h === 'boolean' ? cfg.leadingZero12h : true,
    units: cfg.units || null
  });
});

app.get('/weather', async (req, res) => {
  config = loadConfig();
  if (!config) return res.status(500).json({ error: 'Missing config.json' });

  try {
    const cfg = await ensureLatLonTimezone(config);
    const tempUnit = temperatureUnitFromCfg(cfg);

    // Need enough daily entries so we can build 5 forecast cards (tomorrow..+5)
    const forecastDays = 6;

    // minutely_15 helps detect active precip (snow/rain) between hourly marks
    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(cfg.lat)}` +
      `&longitude=${encodeURIComponent(cfg.lon)}` +
      `&current_weather=true` +
      `&hourly=weathercode,snowfall` +
      `&minutely_15=precipitation,snowfall` +
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
    const min15 = data.minutely_15;

    if (!cur || !daily) throw new Error('Open-Meteo response missing current_weather or daily');

    const highTodayRaw = safeDailyValue(daily.temperature_2m_max, 0);
    const lowTodayRaw = safeDailyValue(daily.temperature_2m_min, 0);

    const highToday = highTodayRaw == null ? null : Math.round(highTodayRaw);
    const lowToday = lowTodayRaw == null ? null : Math.round(lowTodayRaw);

    const currentTemp = Math.round(cur.temperature);
    let currentCode = Number(cur.weathercode);
    const isDay = cur.is_day === 1;

    // 1) Prefer minutely override for active precip (fixes “snowing but cloudy”)
    const minutelyOverride = applyActivePrecipOverrideMinutely(
      cfg,
      currentCode,
      currentTemp,
      tempUnit,
      min15,
      cur.time
    );

    if (minutelyOverride.used) {
      currentCode = minutelyOverride.code;
    } else {
      // 2) Fallback: your hourly “recent snow wins”
      const hourlyOverride = applyRecentSnowOverrideHourly(cfg, currentCode, hourly, cur.time);
      if (hourlyOverride.used) currentCode = hourlyOverride.code;
    }

    const currentThundersnow = isThundersnow(cfg, currentCode, currentTemp, tempUnit);

    // Clamp hi/lo so current isn’t visually above “high”
    const fixedHigh = highToday == null ? currentTemp : Math.max(highToday, currentTemp);
    const fixedLow = lowToday == null ? currentTemp : Math.min(lowToday, currentTemp);

    const sunriseToday = safeDailyValue(daily.sunrise, 0) || null;
    const sunsetToday = safeDailyValue(daily.sunset, 0) || null;

    const forecast = [];
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
        temp: max,
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
