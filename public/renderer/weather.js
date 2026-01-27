async function fetchWeather() {
  try {
    const response = await fetch('/weather');
    const data = await response.json();

    if (data.error) {
      console.error('Weather fetch error:', data.error);
      return;
    }

    const { current, forecast } = data;

    // Update current weather
    document.getElementById('current-temp').textContent = `${current.temp}°`;
    document.getElementById('high').textContent = `${current.high}°`;
    document.getElementById('low').textContent = `${current.low}°`;


    let iconKey = mapIcon(current.main, current.icon);
    document.getElementById('current-icon').src = `assets/icons/${iconKey}.svg`;

    // Update forecast
    const forecastContainer = document.getElementById('forecast');
    forecastContainer.innerHTML = '';

    forecast.forEach((day, index) => {
      const dayDiv = document.createElement('div');
      dayDiv.className = 'forecast-day';

      const dayName = new Date();
      dayName.setDate(dayName.getDate() + index + 1); // Tomorrow + following
      const weekday = dayName.toLocaleDateString('en-US', { weekday: 'short' });

      let forecastIconKey = mapIcon(day.main, day.icon);

      dayDiv.innerHTML = `
        <div>${weekday}</div>
        <img src="assets/icons/${forecastIconKey}.svg" alt="Weather Icon"/>
        <div>${day.temp}°</div>
      `;
      forecastContainer.appendChild(dayDiv);
    });

  } catch (error) {
    console.error('Weather fetch failed:', error);
  }
}

function mapIcon(main, iconCode) {
  if (main === "Clear") {
    return iconCode.endsWith("n") ? "clear-night" : "clear-day";
  } else if (main === "Clouds") {
    if (iconCode.startsWith("02")) return iconCode.endsWith("n") ? "partlycloudy-night" : "partlycloudy-day";
    else return "cloudy";
  } else if (main === "Rain" || main === "Drizzle") {
    if (iconCode.startsWith("09")) return iconCode.endsWith("n") ? "showers-night" : "showers-day";
    else return "rain";
  } else if (main === "Thunderstorm") {
    return "thunderstorm";
  } else if (main === "Snow") {
    return "snow";
  } else if (["Mist", "Fog", "Smoke", "Haze"].includes(main)) {
    return "fog";
  } else if (main === "Sleet") {
    return "sleet";
  } else {
    return "cloudy"; // fallback
  }
}

fetchWeather();
setInterval(fetchWeather, 30 * 60 * 1000); // Update every 30 minutes
