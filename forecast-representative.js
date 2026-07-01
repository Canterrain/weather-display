const DAYTIME_START_HOUR = 8;
const DAYTIME_END_HOUR = 20;

const FORECAST_HEURISTIC_THRESHOLDS = {
  thunderHours: 2,
  thunderProbability: 60,
  rainHours: 3,
  rainProbability: 60,
  rainTotalMm: 1.5,
  snowHours: 2,
  snowTotalMm: 0.5,
  fogHours: 3
};

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function isHourInDaytime(hour) {
  return Number.isInteger(hour) && hour >= DAYTIME_START_HOUR && hour <= DAYTIME_END_HOUR;
}

function isThunderCode(code) {
  return code === 95 || code === 96 || code === 99;
}

function isDrizzleCode(code) {
  return code >= 51 && code <= 57;
}

function isRainCode(code) {
  return (code >= 61 && code <= 65) || (code >= 80 && code <= 82);
}

function isFreezingCode(code) {
  return code === 56 || code === 57 || code === 66 || code === 67;
}

function isSnowCode(code) {
  return (code >= 71 && code <= 77) || code === 85 || code === 86;
}

function isFogCode(code) {
  return code === 45 || code === 48;
}

function isCloudyCode(code) {
  return code === 3;
}

function isPartlyCode(code) {
  return code === 1 || code === 2;
}

function isClearCode(code) {
  return code === 0;
}

function getDaytimeSamples(hourly, date) {
  const times = Array.isArray(hourly?.time) ? hourly.time : [];
  const samples = [];

  for (let i = 0; i < times.length; i++) {
    const time = String(times[i] || '');
    if (!time.startsWith(`${date}T`)) continue;

    const hour = Number(time.slice(11, 13));
    if (!isHourInDaytime(hour)) continue;

    samples.push({
      hour,
      code: toNumber(hourly?.weathercode?.[i], -1),
      precipitationProbability: toNumber(hourly?.precipitation_probability?.[i], 0),
      precipitation: toNumber(hourly?.precipitation?.[i], 0),
      rain: toNumber(hourly?.rain?.[i], 0),
      showers: toNumber(hourly?.showers?.[i], 0),
      snowfall: toNumber(hourly?.snowfall?.[i], 0),
      cloudCover: toNumber(hourly?.cloud_cover?.[i], 0)
    });
  }

  return samples;
}

function summarizeDaytime(samples) {
  const summary = {
    sampleCount: samples.length,
    thunderHours: 0,
    wetHours: 0,
    rainHours: 0,
    showerHours: 0,
    snowHours: 0,
    freezingHours: 0,
    fogHours: 0,
    cloudyHours: 0,
    partlyHours: 0,
    clearHours: 0,
    totalPrecipitation: 0,
    totalSnowfall: 0,
    maxPrecipitationProbability: 0,
    averageCloudCover: 0
  };

  if (!samples.length) return summary;

  let cloudCoverTotal = 0;

  for (const sample of samples) {
    const code = sample.code;
    const precip = sample.precipitation;
    const rain = sample.rain;
    const showers = sample.showers;
    const snowfall = sample.snowfall;
    const precipProbability = sample.precipitationProbability;
    const cloudCover = sample.cloudCover;
    const wetAmount = Math.max(precip, rain + showers);

    if (isThunderCode(code)) summary.thunderHours += 1;
    if (isSnowCode(code) || snowfall > 0) summary.snowHours += 1;
    if (isFreezingCode(code)) summary.freezingHours += 1;
    if (isFogCode(code)) summary.fogHours += 1;
    if (isCloudyCode(code) || cloudCover >= 75) summary.cloudyHours += 1;
    else if (isPartlyCode(code) || cloudCover >= 35) summary.partlyHours += 1;
    else if (isClearCode(code) || cloudCover < 35) summary.clearHours += 1;

    if (isRainCode(code) || isDrizzleCode(code) || wetAmount > 0) {
      summary.wetHours += 1;
    }
    if ((code >= 80 && code <= 82) || isDrizzleCode(code) || showers > 0) {
      summary.showerHours += 1;
    }
    if ((code >= 61 && code <= 65) || rain > 0) {
      summary.rainHours += 1;
    }

    summary.totalPrecipitation += precip;
    summary.totalSnowfall += snowfall;
    summary.maxPrecipitationProbability = Math.max(summary.maxPrecipitationProbability, precipProbability);
    cloudCoverTotal += cloudCover;
  }

  summary.averageCloudCover = cloudCoverTotal / samples.length;
  return summary;
}

function pickRepresentativeForecastCode({
  date,
  dailyCode,
  dailyHigh,
  dailyLow,
  hourly,
  snowTempThreshold
}) {
  const samples = getDaytimeSamples(hourly, date);
  if (!samples.length) {
    return {
      code: toNumber(dailyCode, 3),
      usedFallback: true,
      summary: summarizeDaytime(samples)
    };
  }

  const summary = summarizeDaytime(samples);
  const midTemp = (toNumber(dailyHigh, 0) + toNumber(dailyLow, 0)) / 2;
  const coldEnoughForSnow = Number.isFinite(snowTempThreshold) && midTemp <= snowTempThreshold;

  if (
    summary.thunderHours >= FORECAST_HEURISTIC_THRESHOLDS.thunderHours ||
    (
      summary.thunderHours >= 1 &&
      summary.wetHours >= 2 &&
      summary.maxPrecipitationProbability >= FORECAST_HEURISTIC_THRESHOLDS.thunderProbability
    )
  ) {
    return { code: 95, usedFallback: false, summary };
  }

  if (
    summary.freezingHours >= 1 &&
    (
      summary.wetHours >= 2 ||
      summary.totalPrecipitation >= 1 ||
      summary.maxPrecipitationProbability >= FORECAST_HEURISTIC_THRESHOLDS.rainProbability
    )
  ) {
    return { code: 66, usedFallback: false, summary };
  }

  if (
    summary.snowHours >= FORECAST_HEURISTIC_THRESHOLDS.snowHours ||
    summary.totalSnowfall >= FORECAST_HEURISTIC_THRESHOLDS.snowTotalMm ||
    (
      coldEnoughForSnow &&
      summary.wetHours >= FORECAST_HEURISTIC_THRESHOLDS.rainHours &&
      summary.maxPrecipitationProbability >= FORECAST_HEURISTIC_THRESHOLDS.rainProbability
    )
  ) {
    return { code: 73, usedFallback: false, summary };
  }

  if (
    summary.wetHours >= FORECAST_HEURISTIC_THRESHOLDS.rainHours ||
    (
      summary.maxPrecipitationProbability >= FORECAST_HEURISTIC_THRESHOLDS.rainProbability &&
      summary.totalPrecipitation >= FORECAST_HEURISTIC_THRESHOLDS.rainTotalMm
    )
  ) {
    return {
      code: summary.showerHours >= summary.rainHours ? 80 : 61,
      usedFallback: false,
      summary
    };
  }

  if (
    summary.fogHours >= FORECAST_HEURISTIC_THRESHOLDS.fogHours &&
    summary.wetHours <= 1 &&
    summary.averageCloudCover >= 70
  ) {
    return { code: 45, usedFallback: false, summary };
  }

  if (summary.averageCloudCover >= 70 || summary.cloudyHours >= Math.max(summary.clearHours, summary.partlyHours)) {
    return { code: 3, usedFallback: false, summary };
  }

  if (summary.averageCloudCover >= 35 || summary.partlyHours >= summary.clearHours) {
    return { code: 2, usedFallback: false, summary };
  }

  return { code: 0, usedFallback: false, summary };
}

module.exports = {
  DAYTIME_START_HOUR,
  DAYTIME_END_HOUR,
  FORECAST_HEURISTIC_THRESHOLDS,
  getDaytimeSamples,
  summarizeDaytime,
  pickRepresentativeForecastCode
};
