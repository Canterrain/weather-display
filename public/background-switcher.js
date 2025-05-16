(function () {
  const hour = new Date().getHours();
  const body = document.body;

  if (hour >= 7 && hour < 21) {
    // Between 7am and 8:59pm = Day
    body.classList.remove('night-background');
    body.classList.add('day-background');
  } else {
    // Between 9pm and 6:59am = Night
    body.classList.remove('day-background');
    body.classList.add('night-background');
  }
})();