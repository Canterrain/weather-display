let CLOCK_CFG = {
  timeFormat: '12',
  leadingZero12h: true
};

async function loadClockConfig() {
  try {
    const resp = await fetch('/config', { cache: 'no-store' });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && typeof data === 'object') {
      if (data.timeFormat) CLOCK_CFG.timeFormat = String(data.timeFormat);
      if (typeof data.leadingZero12h === 'boolean') CLOCK_CFG.leadingZero12h = data.leadingZero12h;
    }
  } catch (e) {
    // ignore; fall back to defaults
  }
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
    const t = getTime();

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

  setInterval(updateClock, 1000);
  setInterval(updateDay, 60 * 60 * 1000);

  // Re-fetch config occasionally in case you change it (safe, low cost)
  setInterval(async () => {
    await loadClockConfig();
    setAmPmVisibility();
  }, 10 * 60 * 1000);
}

// Boot
(async () => {
  await loadClockConfig();
  Clock();
})();
