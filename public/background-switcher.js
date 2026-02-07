// public/background-switch.js
(() => {
  const DAY_CLASS = 'day-background';
  const NIGHT_CLASS = 'night-background';

  const CHECK_INTERVAL_MS = 15 * 60 * 1000;

  const candidates = {
    day: [
      'assets/background-day.jpg',
      'assets/background-day.png',
      'assets/background-day.webp'
    ],
    night: [
      'assets/background-night.jpg',
      'assets/background-night.png',
      'assets/background-night.webp'
    ],
    generic: [
      'assets/background.jpg',
      'assets/background.png',
      'assets/background.webp'
    ]
  };

  let resolved = {
    dayUrl: null,
    nightUrl: null,
    genericUrl: null,
    checked: false
  };

  function setMode(isDay) {
    const body = document.body;
    body.classList.remove(DAY_CLASS, NIGHT_CLASS);
    body.classList.add(isDay ? DAY_CLASS : NIGHT_CLASS);
  }

  function setBackgroundImage(urlOrNull) {
    const body = document.body;

    if (urlOrNull) {
      body.style.backgroundImage = `url('${urlOrNull}')`;
      body.style.backgroundSize = 'cover';
      body.style.backgroundPosition = 'center center';
      body.style.backgroundRepeat = 'no-repeat';
      return;
    }

    // Clear inline background-image so your existing CSS night behavior applies (black)
    body.style.backgroundImage = '';
  }

  function getForcedMode() {
    // URL override: ?force=day or ?force=night
    const p = new URLSearchParams(window.location.search);
    const q = (p.get('force') || '').toLowerCase();

    // localStorage override: localStorage.forceDayNight = "day" | "night"
    const ls = (localStorage.getItem('forceDayNight') || '').toLowerCase();

    const v = q || ls;
    if (v === 'day' || v === 'night') return v;
    return null;
  }

  // Optional helper for quick testing in DevTools:
  //   setDayNight('day') / setDayNight('night') / setDayNight(null)
  window.setDayNight = (mode) => {
    if (mode === null) {
      localStorage.removeItem('forceDayNight');
      console.log('forceDayNight cleared');
      return;
    }

    const v = String(mode).toLowerCase();
    if (v !== 'day' && v !== 'night') {
      console.warn("setDayNight expects 'day', 'night', or null");
      return;
    }

    localStorage.setItem('forceDayNight', v);
    console.log('forceDayNight set to', v);
  };

  function imageExists(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      // cache-bust so testing is reliable
      img.src = `${url}?v=${Date.now()}`;
    });
  }

  async function resolveAvailableBackgrounds() {
    if (resolved.checked) return resolved;

    // Day-specific
    for (const u of candidates.day) {
      if (await imageExists(u)) {
        resolved.dayUrl = u;
        break;
      }
    }

    // Night-specific
    for (const u of candidates.night) {
      if (await imageExists(u)) {
        resolved.nightUrl = u;
        break;
      }
    }

    // Generic (day-only fallback)
    for (const u of candidates.generic) {
      if (await imageExists(u)) {
        resolved.genericUrl = u;
        break;
      }
    }

    resolved.checked = true;
    return resolved;
  }

  function isDayByHours(now = new Date()) {
    const hour = now.getHours();
    return hour >= 7 && hour < 21;
  }

  function parseIsoLocal(s) {
    // Open-Meteo returns ISO like "2026-02-06T07:31" in the requested timezone.
    // new Date("YYYY-MM-DDTHH:mm") is treated as local time by most browsers.
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  async function getSunTimes() {
    try {
      const resp = await fetch('/weather', { cache: 'no-store' });
      if (!resp.ok) return null;

      const data = await resp.json();
      const sunriseStr = data?.current?.sunrise;
      const sunsetStr = data?.current?.sunset;

      if (!sunriseStr || !sunsetStr) return null;

      const sunrise = parseIsoLocal(sunriseStr);
      const sunset = parseIsoLocal(sunsetStr);
      if (!sunrise || !sunset) return null;

      return { sunrise, sunset };
    } catch (e) {
      return null;
    }
  }

  async function applyBackground() {
    const now = new Date();

    const bg = await resolveAvailableBackgrounds();
    const sun = await getSunTimes();

    const forced = getForcedMode();
    const isDay = forced
      ? forced === 'day'
      : (sun ? now >= sun.sunrise && now < sun.sunset : isDayByHours(now));

    setMode(isDay);

    // Priority rules:
    // 1) If BOTH day & night specific exist, use them accordingly
    // 2) Else if generic exists, use it for day only (night = none/black)
    // 3) Else no background at all
    if (bg.dayUrl && bg.nightUrl) {
      setBackgroundImage(isDay ? bg.dayUrl : bg.nightUrl);
      return;
    }

    if (bg.genericUrl) {
      setBackgroundImage(isDay ? bg.genericUrl : null);
      return;
    }

    setBackgroundImage(null);
  }

  // Run immediately
  applyBackground();

  // Re-check every 15 minutes
  setInterval(applyBackground, CHECK_INTERVAL_MS);
})();
