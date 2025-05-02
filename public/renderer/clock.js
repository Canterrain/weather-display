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

  this.update = function(val){
    val = ('0' + val).slice(-2);
    if (val !== this.currentValue) {
      this.currentValue = val;
      top.textContent = this.currentValue;
    }
  }
  
  this.update(value);
}

function getTime() {
  const now = new Date();
  let hours = now.getHours();
  const minutes = now.getMinutes();
  const isPM = hours >= 12;

  // Convert to 12-hour format
  if (hours === 0) {
    hours = 12;
  } else if (hours > 12) {
    hours = hours - 12;
  }

  return {
    'Hours': hours,
    'Minutes': minutes,
    'AMPM': isPM ? 'PM' : 'AM'
  };
}

function Clock() {
  const updateFn = getTime;
  const clockContainer = document.getElementById('time');

  const trackers = {
    'Hours': new CountdownTracker('Hours', 0),
    'Minutes': new CountdownTracker('Minutes', 0),
    'AMPM': new CountdownTracker('AMPM', 'AM')
  };

  clockContainer.innerHTML = '';

  clockContainer.appendChild(trackers['Hours'].el);

  const colon = document.createElement('span');
  colon.className = 'flip-clock__colon';
  colon.textContent = ':';
  clockContainer.appendChild(colon);

  clockContainer.appendChild(trackers['Minutes'].el);

  const spacer = document.createElement('span');
  spacer.className = 'flip-clock__spacer';
  spacer.textContent = '';
  clockContainer.appendChild(spacer);

  clockContainer.appendChild(trackers['AMPM'].el);

  function updateClock() {
    const t = updateFn();
    trackers['Hours'].update(t.Hours);
    trackers['Minutes'].update(t.Minutes);
    trackers['AMPM'].update(t.AMPM);
  }

  setInterval(updateClock, 1000);
  updateClock();

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

  updateDay();
  setInterval(updateDay, 60 * 60 * 1000);
}

Clock();
