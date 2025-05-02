const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Load config
const configPath = path.join(__dirname, 'config.json');
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath)) : null;

// Serve weather data
app.get('/weather', async (req, res) => {
  if (!config) {
    return res.status(500).json({ error: 'Missing config.json' });
  }

  try {
    const currentUrl = `http://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(config.location)}&appid=${config.apiKey}&units=${config.units}`;
    const forecastUrl = `http://api.openweathermap.org/data/2.5/forecast?q=${encodeURIComponent(config.location)}&appid=${config.apiKey}&units=${config.units}`;

    const [currentResp, forecastResp] = await Promise.all([
      fetch(currentUrl),
      fetch(forecastUrl)
    ]);

    const currentData = await currentResp.json();
    const forecastData = await forecastResp.json();

    if (!currentResp.ok || !forecastResp.ok) {
      console.error('Weather fetch error', currentData, forecastData);
      return res.status(500).json({ error: 'Weather fetch failed' });
    }

    // Build simplified forecast (next 4 days, skip today)
    const dailyForecast = [];
    const now = new Date();
    const todayDate = now.getDate();

    // Group forecast list by date
    const forecastsByDay = {};

    forecastData.list.forEach(entry => {
      const entryDate = new Date(entry.dt * 1000);
      const dateKey = `${entryDate.getFullYear()}-${entryDate.getMonth()}-${entryDate.getDate()}`;

      if (!forecastsByDay[dateKey]) {
        forecastsByDay[dateKey] = [];
      }
      forecastsByDay[dateKey].push(entry);
    });

    const forecastKeys = Object.keys(forecastsByDay).sort();

    forecastKeys.forEach(dateKey => {
      const entries = forecastsByDay[dateKey];

      // Skip today
      const entryDate = new Date(entries[0].dt * 1000);
      if (entryDate.getDate() === todayDate) {
        return;
      }

      // Pick an entry around midday if possible
      let middayEntry = entries.find(e => {
        const hour = new Date(e.dt * 1000).getHours();
        return hour >= 11 && hour <= 13;
      }) || entries[Math.floor(entries.length / 2)];

      dailyForecast.push({
        temp: Math.round(middayEntry.main.temp),
        icon: middayEntry.weather[0].icon,
        main: middayEntry.weather[0].main
      });

      if (dailyForecast.length >= 4) return;
    });

    res.json({
      current: {
        temp: Math.round(currentData.main.temp),
        high: Math.round(currentData.main.temp_max),
        low: Math.round(currentData.main.temp_min),
        main: currentData.weather[0].main,
        icon: currentData.weather[0].icon
      },
      forecast: dailyForecast
    });

  } catch (error) {
    console.error('Server error fetching weather', error);
    res.status(500).json({ error: 'Weather server error' });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Weather server running at http://localhost:${PORT}`);
});
