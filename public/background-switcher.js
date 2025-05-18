function applyTimeBasedBackground() {
  const hour = new Date().getHours();
  const body = document.body;

  const isDaytime = hour >= 7 && hour < 21;
	// Between 7am and 6:59pm = Day
	// Between 7pm and 6:59am = Night
  // Remove both classes first
  body.classList.remove('day-background', 'night-background');

  // Then apply the appropriate one
  if (isDaytime) {
    body.classList.add('day-background');
  } else {
    body.classList.add('night-background');
  }
}

// Run immediately
applyTimeBasedBackground();

// Then re-check every 15 minutes (900,000ms)
setInterval(applyTimeBasedBackground, 15 * 60 * 1000);
