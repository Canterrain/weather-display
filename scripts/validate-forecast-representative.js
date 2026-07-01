const assert = require('assert');
const {
  pickRepresentativeForecastCode,
  FORECAST_HEURISTIC_THRESHOLDS
} = require('../forecast-representative');

function buildHourly({ date, hours, code, precipitationProbability = 10, precipitation = 0, rain = 0, showers = 0, snowfall = 0, cloudCover = 20 }) {
  const hourly = {
    time: [],
    weathercode: [],
    precipitation_probability: [],
    precipitation: [],
    rain: [],
    showers: [],
    snowfall: [],
    cloud_cover: []
  };

  for (const hour of hours) {
    const pad = String(hour).padStart(2, '0');
    hourly.time.push(`${date}T${pad}:00`);
    hourly.weathercode.push(typeof code === 'function' ? code(hour) : code);
    hourly.precipitation_probability.push(typeof precipitationProbability === 'function' ? precipitationProbability(hour) : precipitationProbability);
    hourly.precipitation.push(typeof precipitation === 'function' ? precipitation(hour) : precipitation);
    hourly.rain.push(typeof rain === 'function' ? rain(hour) : rain);
    hourly.showers.push(typeof showers === 'function' ? showers(hour) : showers);
    hourly.snowfall.push(typeof snowfall === 'function' ? snowfall(hour) : snowfall);
    hourly.cloud_cover.push(typeof cloudCover === 'function' ? cloudCover(hour) : cloudCover);
  }

  return hourly;
}

function runCase(name, input, expectedCode) {
  const result = pickRepresentativeForecastCode(input);
  assert.strictEqual(result.code, expectedCode, `${name}: expected ${expectedCode}, got ${result.code}`);
  console.log(`PASS ${name}: ${result.code}`);
}

const date = '2026-07-02';

runCase(
  'dry thunder codes stay cloudy or partly cloudy',
  {
    date,
    dailyCode: 95,
    dailyHigh: 99,
    dailyLow: 73,
    snowTempThreshold: 34,
    hourly: buildHourly({
      date,
      hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      code: (hour) => ([10, 12, 13].includes(hour) ? 95 : (hour === 11 || hour === 14 ? 3 : 0)),
      precipitationProbability: (hour) => ({ 10: 1, 11: 1, 12: 1, 13: 1, 14: 2, 15: 3, 16: 2, 17: 1, 18: 3, 19: 6, 20: 2 }[hour] ?? 0),
      precipitation: 0,
      rain: 0,
      showers: 0,
      cloudCover: (hour) => ({ 8: 8, 9: 6, 10: 81, 11: 100, 12: 82, 13: 87, 14: 100, 15: 66, 16: 28, 17: 5, 18: 6, 19: 3, 20: 3 }[hour] ?? 0)
    })
  },
  2
);

runCase(
  'brief thunder risk stays partly cloudy',
  {
    date,
    dailyCode: 95,
    dailyHigh: 82,
    dailyLow: 67,
    snowTempThreshold: 34,
    hourly: buildHourly({
      date,
      hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      code: (hour) => (hour === 16 ? 95 : 2),
      precipitationProbability: (hour) => (hour === 16 ? 55 : 10),
      precipitation: (hour) => (hour === 16 ? 0.3 : 0),
      rain: (hour) => (hour === 16 ? 0.3 : 0),
      cloudCover: 45
    })
  },
  2
);

runCase(
  'several rainy hours becomes rain',
  {
    date,
    dailyCode: 3,
    dailyHigh: 74,
    dailyLow: 63,
    snowTempThreshold: 34,
    hourly: buildHourly({
      date,
      hours: [8, 9, 10, 11, 12, 13, 14, 15, 16],
      code: (hour) => (hour >= 10 && hour <= 13 ? 61 : 3),
      precipitationProbability: (hour) => (hour >= 10 && hour <= 13 ? 80 : 20),
      precipitation: (hour) => (hour >= 10 && hour <= 13 ? 0.6 : 0),
      rain: (hour) => (hour >= 10 && hour <= 13 ? 0.6 : 0),
      cloudCover: 88
    })
  },
  61
);

runCase(
  'cold snowy daytime becomes snow',
  {
    date,
    dailyCode: 71,
    dailyHigh: 31,
    dailyLow: 24,
    snowTempThreshold: 34,
    hourly: buildHourly({
      date,
      hours: [8, 9, 10, 11, 12, 13, 14],
      code: (hour) => (hour >= 10 && hour <= 12 ? 73 : 3),
      precipitationProbability: (hour) => (hour >= 10 && hour <= 12 ? 75 : 20),
      snowfall: (hour) => (hour >= 10 && hour <= 12 ? 0.3 : 0),
      cloudCover: 92
    })
  },
  73
);

runCase(
  'two thunder hours becomes thunderstorm',
  {
    date,
    dailyCode: 95,
    dailyHigh: 85,
    dailyLow: 70,
    snowTempThreshold: 34,
    hourly: buildHourly({
      date,
      hours: [8, 9, 10, 11, 12, 13, 14],
      code: (hour) => (hour === 11 || hour === 12 ? 95 : 3),
      precipitationProbability: (hour) => (hour === 11 || hour === 12 ? 80 : 20),
      precipitation: (hour) => (hour === 11 || hour === 12 ? 0.7 : 0),
      rain: (hour) => (hour === 11 || hour === 12 ? 0.7 : 0),
      cloudCover: 85
    })
  },
  95
);

console.log('Thresholds:', FORECAST_HEURISTIC_THRESHOLDS);
