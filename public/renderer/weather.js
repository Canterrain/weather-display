const WEATHER_REFRESH_INTERVAL_MS = 10 * 60 * 1000;

function setWeatherStatus(message) {
  const el = document.getElementById('weather-status');
  if (!el) return;

  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  el.hidden = false;
  el.textContent = message;
}

function formatAgeMs(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 0) return '';

  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (ageMs >= dayMs) return `${Math.round(ageMs / dayMs)}d ago`;
  if (ageMs >= hourMs) return `${Math.round(ageMs / hourMs)}h ago`;

  const minutes = Math.max(1, Math.round(ageMs / minuteMs));
  return `${minutes}m ago`;
}

async function fetchWeather() {
  try {
    const response = await fetch('/weather', { cache: 'no-store' });
    const data = await response.json();

    if (data.error) {
      console.error('Weather fetch error:', data.error);
      setWeatherStatus('Weather data stale');
      return;
    }

    const { current, forecast, stale, staleAgeMs, updatedAt } = data;

    // Update current weather
    document.getElementById('current-temp').textContent = `${current.temp}°`;
    document.getElementById('high').textContent = `${current.high}°`;
    document.getElementById('low').textContent = `${current.low}°`;

    const currentIconKey = mapIconFromMeteo(current.code, current.is_day, current.thundersnow);
    document.getElementById('current-icon').src = `assets/icons/${currentIconKey}.svg`;

    // Update forecast
    const forecastContainer = document.getElementById('forecast');
    forecastContainer.innerHTML = '';

    forecast.forEach((day, index) => {
      const dayDiv = document.createElement('div');
      dayDiv.className = 'forecast-day';

      const dayName = new Date();
      dayName.setDate(dayName.getDate() + index + 1);
      const weekday = dayName.toLocaleDateString('en-US', { weekday: 'short' });

      const iconKey = mapIconFromMeteo(day.code, day.is_day, day.thundersnow);

      dayDiv.innerHTML = `
        <div>${weekday}</div>
        <img src="assets/icons/${iconKey}.svg" alt="Weather Icon"/>
        <div>${day.temp}°</div>
      `;
      forecastContainer.appendChild(dayDiv);
    });

    if (stale) {
      const updatedAtMs = Date.parse(updatedAt);
      const derivedAgeMs = Number.isFinite(updatedAtMs) ? Date.now() - updatedAtMs : staleAgeMs;
      const ageLabel = formatAgeMs(derivedAgeMs);
      setWeatherStatus(ageLabel ? `Weather updated ${ageLabel}` : 'Weather data stale');
    } else {
      setWeatherStatus('');
    }

  } catch (error) {
    console.error('Weather fetch failed:', error);
    setWeatherStatus('Weather data stale');
  }
}

// Map Open-Meteo weathercode (+ is_day) to your icon filenames.
// Your existing names used below:
// clear-day, clear-night, partlycloudy-day, partlycloudy-night, cloudy,
// fog, rain, showers-day, showers-night, sleet, snow, thunderstorm, thundersnow
function mapIconFromMeteo(code, isDay, thundersnow) {
  // If we inferred thundersnow, override everything.
  if (thundersnow) return "thundersnow";

  // 0: Clear sky
  if (code === 0) return isDay ? "clear-day" : "clear-night";

  // 1-2: Mainly clear, partly cloudy
  if (code === 1 || code === 2) return isDay ? "partlycloudy-day" : "partlycloudy-night";

  // 3: Overcast
  if (code === 3) return "cloudy";

  // 45,48: Fog / depositing rime fog
  if (code === 45 || code === 48) return "fog";

  // 51-57: Drizzle (incl freezing drizzle) -> treat as showers
  if (code >= 51 && code <= 57) return isDay ? "showers-day" : "showers-night";

  // 61-65: Rain
  if (code >= 61 && code <= 65) return "rain";

  // 66-67: Freezing rain -> sleet icon (closest you have)
  if (code === 66 || code === 67) return "sleet";

  // 71-77: Snow fall / snow grains
  if (code >= 71 && code <= 77) return "snow";

  // 80-82: Rain showers
  if (code >= 80 && code <= 82) return isDay ? "showers-day" : "showers-night";

  // 85-86: Snow showers
  if (code === 85 || code === 86) return "snow";

  // 95: Thunderstorm (slight/moderate)
  // 96-99: Thunderstorm with hail
  if (code === 95 || code === 96 || code === 99) return "thunderstorm";

  return "cloudy";
}

fetchWeather();
setInterval(fetchWeather, WEATHER_REFRESH_INTERVAL_MS);
