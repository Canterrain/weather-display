let CLOCK_CFG = {
  timeFormat: '12',
  leadingZero12h: true,
  nightShift: false,
  nightShiftStart: '22:00',
  nightShiftEnd: '06:00'
};

const CLOCK_STALE_WARNING_MS = 2 * 60 * 1000 + 15 * 1000;

const clockHealth = {
  lastRenderAt: 0,
  lastDisplayedMinuteKey: '',
  lastMinuteAdvanceAt: 0
};

async function loadClockConfig() {
  try {
    const resp = await fetch('/config', { cache: 'no-store' });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && typeof data === 'object') {
      if (data.timeFormat) CLOCK_CFG.timeFormat = String(data.timeFormat);
      if (typeof data.leadingZero12h === 'boolean') CLOCK_CFG.leadingZero12h = data.leadingZero12h;
      if (typeof data.nightShift === 'boolean') CLOCK_CFG.nightShift = data.nightShift;
      if (typeof data.nightShiftStart === 'string') CLOCK_CFG.nightShiftStart = data.nightShiftStart;
      if (typeof data.nightShiftEnd === 'string') CLOCK_CFG.nightShiftEnd = data.nightShiftEnd;
    }
  } catch (e) {
    // ignore; fall back to defaults
  }
}

function setClockStatus(message) {
  const el = document.getElementById('clock-status');
  if (!el) return;

  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }

  el.hidden = false;
  el.textContent = message;
}

function parseTimeParts(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function isNightShiftActive(now = new Date()) {
  if (!CLOCK_CFG.nightShift) return false;

  const startMinutes = parseTimeParts(CLOCK_CFG.nightShiftStart);
  const endMinutes = parseTimeParts(CLOCK_CFG.nightShiftEnd);
  if (startMinutes == null || endMinutes == null) return false;

  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  if (startMinutes === endMinutes) return true;
  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
}

function applyNightShiftClass() {
  document.body.classList.toggle('night-shift-red', isNightShiftActive());
}

function isDashboardVisible() {
  const shell = document.querySelector('.app-shell');
  return !!shell && shell.classList.contains('mode-dashboard');
}

function resetClockHealth() {
  const now = Date.now();
  clockHealth.lastRenderAt = now;
  clockHealth.lastMinuteAdvanceAt = now;
  clockHealth.lastDisplayedMinuteKey = '';
  setClockStatus('');
}

function updateClockHealth(now, minuteKey) {
  const renderAt = now.getTime();
  clockHealth.lastRenderAt = renderAt;

  if (minuteKey !== clockHealth.lastDisplayedMinuteKey) {
    clockHealth.lastDisplayedMinuteKey = minuteKey;
    clockHealth.lastMinuteAdvanceAt = renderAt;
  }
}

function updateClockStaleWarning() {
  if (document.hidden || !isDashboardVisible()) {
    resetClockHealth();
    return;
  }

  const staleForMs = Date.now() - clockHealth.lastMinuteAdvanceAt;
  setClockStatus(staleForMs > CLOCK_STALE_WARNING_MS ? 'Clock paused' : '');
}

function CountdownTracker(label, value) {
  const el = document.createElement('span');
  el.className = 'flip-clock__piece';
  el.innerHTML = `
    <b class="flip-clock__card card">
      <b class="card__top"></b>
    </b>
  `;

  this.el = el;
  const top = el.querySelector('.card__top');

  this.update = function (val) {
    // If we get a string (e.g., AM/PM), show it as-is
    if (typeof val === 'string') {
      if (val !== this.currentValue) {
        this.currentValue = val;
        top.textContent = this.currentValue;
      }
      return;
    }

    // Numbers: by default zero-pad to 2 digits,
    // but Hours can be special-cased by the caller before it gets here.
    const s = ('0' + val).slice(-2);
    if (s !== this.currentValue) {
      this.currentValue = s;
      top.textContent = this.currentValue;
    }
  };

  this.update(value);
}

function getTime() {
  const now = new Date();
  const minutes = now.getMinutes();

  const format = CLOCK_CFG.timeFormat === '24' ? '24' : '12';

  if (format === '24') {
    const hours24 = now.getHours();
    return {
      Hours: hours24, // show as 2-digit via tracker (00-23)
      Minutes: minutes,
      AMPM: '' // not used in 24h mode (we’ll hide it)
    };
  }

  // 12-hour
  let hours = now.getHours();
  const isPM = hours >= 12;

  if (hours === 0) hours = 12;
  else if (hours > 12) hours -= 12;

  return {
    Hours: hours,
    Minutes: minutes,
    AMPM: isPM ? 'PM' : 'AM'
  };
}

function Clock() {
  const clockContainer = document.getElementById('time');

  const trackers = {
    Hours: new CountdownTracker('Hours', 0),
    Minutes: new CountdownTracker('Minutes', 0),
    AMPM: new CountdownTracker('AMPM', 'AM')
  };

  clockContainer.innerHTML = '';

  clockContainer.appendChild(trackers.Hours.el);

  const colon = document.createElement('span');
  colon.className = 'flip-clock__colon';
  colon.textContent = ':';
  clockContainer.appendChild(colon);

  clockContainer.appendChild(trackers.Minutes.el);

  const spacer = document.createElement('span');
  spacer.className = 'flip-clock__spacer';
  spacer.textContent = '';
  clockContainer.appendChild(spacer);

  clockContainer.appendChild(trackers.AMPM.el);

  function setAmPmVisibility() {
    const format = CLOCK_CFG.timeFormat === '24' ? '24' : '12';
    trackers.AMPM.el.style.display = format === '24' ? 'none' : '';
    spacer.style.display = format === '24' ? 'none' : '';
  }

  function updateClock() {
    const now = new Date();
    const t = getTime();
    const minuteKey = `${now.getHours()}:${now.getMinutes()}`;

    // Hours formatting:
    // - 24h: keep 2-digit (00-23)
    // - 12h: optionally suppress leading zero for 1-9 (only affects display)
    const format = CLOCK_CFG.timeFormat === '24' ? '24' : '12';
    if (format === '24') {
      trackers.Hours.update(t.Hours); // will pad to 2 digits
      trackers.AMPM.update('');       // hidden anyway
    } else {
      if (!CLOCK_CFG.leadingZero12h && t.Hours < 10) {
        // Send as string so tracker doesn't re-pad it
        trackers.Hours.update(String(t.Hours));
      } else {
        trackers.Hours.update(t.Hours); // padded to 2 digits
      }
      trackers.AMPM.update(t.AMPM);
    }

    trackers.Minutes.update(t.Minutes);
    updateClockHealth(now, minuteKey);
    updateClockStaleWarning();
    applyNightShiftClass();
  }

  function updateDay() {
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const now = new Date();
    const dayName = days[now.getDay()];
    const monthName = months[now.getMonth()];
    const dateNumber = now.getDate();
    document.getElementById('day').innerHTML =
      `<span class="day-name">${dayName},</span><span class="month-name">${monthName}</span><span class="date-number">${dateNumber}</span>`;
  }

  // Initial + intervals
  setAmPmVisibility();
  updateClock();
  updateDay();
  applyNightShiftClass();

  setInterval(updateClock, 1000);
  setInterval(updateDay, 60 * 1000);

  // Re-fetch config occasionally in case you change it (safe, low cost)
  setInterval(async () => {
    await loadClockConfig();
    setAmPmVisibility();
    applyNightShiftClass();
  }, 10 * 60 * 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      resetClockHealth();
      return;
    }

    updateClock();
  });
}

// Boot
(async () => {
  await loadClockConfig();
  Clock();
})();
