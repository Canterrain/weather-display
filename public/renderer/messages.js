const MESSAGE_POLL_INTERVAL_MS = 15 * 1000;
const NON_TOUCH_INTERVAL_MS = 3 * 60 * 1000;
const NON_TOUCH_DURATION_MS = 30 * 1000;

const VIEW_MODES = {
  DASHBOARD: 'dashboard',
  MESSAGE: 'message'
};

const messageState = {
  deviceId: 'default-clock',
  roomName: '',
  inputMode: 'touch',
  unreadCount: 0,
  messages: [],
  activeMessage: null,
  currentViewMode: VIEW_MODES.DASHBOARD,
  messageVisibleUntil: 0,
  nextResurfaceAt: 0
};

function isImportantMessage(message) {
  return String(message?.priority || '').trim().toLowerCase() === 'important';
}

function formatMessageTime(isoString) {
  if (!isoString) return '';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  });
}

function buildMessageMeta(message) {
  if (!message) return '';
  const bits = [];
  if (message.sender) {
    bits.push(`-${message.sender}`);
  }
  const timeLabel = formatMessageTime(message.createdAt);
  if (timeLabel) {
    bits.push(timeLabel);
  }
  return bits.join(', ');
}

function setViewMode(mode) {
  const appShell = document.querySelector('.app-shell');
  const dashboardView = document.querySelector('.view-dashboard');
  const messageView = document.querySelector('.view-message');
  if (!appShell || !dashboardView || !messageView) return;

  messageState.currentViewMode = mode === VIEW_MODES.MESSAGE ? VIEW_MODES.MESSAGE : VIEW_MODES.DASHBOARD;
  appShell.classList.toggle('mode-dashboard', messageState.currentViewMode === VIEW_MODES.DASHBOARD);
  appShell.classList.toggle('mode-message', messageState.currentViewMode === VIEW_MODES.MESSAGE);
  dashboardView.setAttribute('aria-hidden', String(messageState.currentViewMode !== VIEW_MODES.DASHBOARD));
  messageView.setAttribute('aria-hidden', String(messageState.currentViewMode !== VIEW_MODES.MESSAGE));
}

function renderIndicator() {
  const indicator = document.getElementById('message-indicator');
  if (!indicator) return;

  const hasUnread = messageState.unreadCount > 0;
  const active = messageState.activeMessage;
  const hasImportant = isImportantMessage(active);

  indicator.classList.toggle('has-unread', hasUnread);
  indicator.classList.toggle('has-important', hasImportant);
}

function renderMessageScreen() {
  const card = document.getElementById('message-card');
  const empty = document.getElementById('message-empty');
  const text = document.getElementById('message-text');
  const meta = document.getElementById('message-meta');
  const dismiss = document.querySelector('.message-dismiss');

  if (!card || !empty || !text || !meta || !dismiss) return;
  dismiss.textContent = messageState.inputMode === 'touch'
    ? 'Tap message to dismiss'
    : 'Use your phone to dismiss messages';

  if (!messageState.activeMessage) {
    card.hidden = true;
    empty.hidden = false;
    return;
  }

  const active = messageState.activeMessage;
  text.textContent = active.text;
  meta.textContent = buildMessageMeta(active);
  card.hidden = false;
  empty.hidden = true;
}

function updateNonTouchViewSchedule() {
  if (messageState.inputMode !== 'non-touch') {
    messageState.messageVisibleUntil = 0;
    messageState.nextResurfaceAt = 0;
    return;
  }

  if (!messageState.activeMessage) {
    messageState.messageVisibleUntil = 0;
    messageState.nextResurfaceAt = 0;
    setViewMode(VIEW_MODES.DASHBOARD);
    return;
  }

  const now = Date.now();

  if (!messageState.nextResurfaceAt) {
    messageState.messageVisibleUntil = 0;
    messageState.nextResurfaceAt = now + NON_TOUCH_INTERVAL_MS;
  } else if (now >= messageState.nextResurfaceAt) {
    messageState.messageVisibleUntil = now + NON_TOUCH_DURATION_MS;
    messageState.nextResurfaceAt = now + NON_TOUCH_INTERVAL_MS;
  }

  if (now < messageState.messageVisibleUntil) {
    setViewMode(VIEW_MODES.MESSAGE);
  } else {
    setViewMode(VIEW_MODES.DASHBOARD);
  }
}

async function fetchMessageConfig() {
  try {
    const response = await fetch('/config', { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok || data.error) return;

    if (typeof data.deviceId === 'string' && data.deviceId.trim()) {
      messageState.deviceId = data.deviceId.trim();
    }
    if (typeof data.roomName === 'string') {
      messageState.roomName = data.roomName.trim();
    }
    messageState.inputMode = data.inputMode === 'non-touch' ? 'non-touch' : 'touch';
  } catch (error) {
    console.error('Failed to load message config:', error);
  }
}

async function fetchMessages() {
  try {
    const response = await fetch(`/api/messages?deviceId=${encodeURIComponent(messageState.deviceId)}`, {
      cache: 'no-store'
    });
    const data = await response.json();

    if (!response.ok || data.error) {
      console.error('Message fetch failed:', data.error || response.statusText);
      return;
    }

    const previousActiveId = messageState.activeMessage?.id || null;
    messageState.messages = Array.isArray(data.messages) ? data.messages : [];
    messageState.unreadCount = Number.isFinite(data.unreadCount) ? data.unreadCount : 0;
    messageState.activeMessage = messageState.messages[0] || null;

    if (messageState.activeMessage?.id !== previousActiveId) {
      messageState.messageVisibleUntil = 0;
      messageState.nextResurfaceAt = 0;
    }

    if (messageState.inputMode === 'non-touch') {
      updateNonTouchViewSchedule();
    }

    renderIndicator();
    renderMessageScreen();
  } catch (error) {
    console.error('Failed to fetch messages:', error);
  }
}

async function acknowledgeActiveMessage() {
  if (!messageState.activeMessage || messageState.inputMode !== 'touch') return;

  try {
    const response = await fetch(`/api/messages/${encodeURIComponent(messageState.activeMessage.id)}/ack`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        deviceId: messageState.deviceId
      })
    });

    const data = await response.json();
    if (!response.ok || data.error) {
      console.error('Failed to acknowledge message:', data.error || response.statusText);
      return;
    }

    await fetchMessages();
    setViewMode(VIEW_MODES.DASHBOARD);
  } catch (error) {
    console.error('Failed to acknowledge active message:', error);
  }
}

function setupSwipeNavigation() {
  const stage = document.querySelector('.display-stage');
  if (!stage) return;

  let startX = null;
  let startY = null;

  function begin(x, y) {
    startX = x;
    startY = y;
  }

  function end(x, y) {
    if (messageState.inputMode !== 'touch') {
      startX = null;
      startY = null;
      return;
    }

    if (startX == null || startY == null) return;

    const deltaX = x - startX;
    const deltaY = y - startY;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    if (absX >= 70 && absX > absY * 1.5) {
      if (messageState.currentViewMode === VIEW_MODES.DASHBOARD && deltaX > 0) {
        setViewMode(VIEW_MODES.MESSAGE);
      } else if (messageState.currentViewMode === VIEW_MODES.MESSAGE && deltaX < 0) {
        setViewMode(VIEW_MODES.DASHBOARD);
      }
    }

    startX = null;
    startY = null;
  }

  stage.addEventListener('touchstart', (event) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    begin(touch.clientX, touch.clientY);
  }, { passive: true });

  stage.addEventListener('touchend', (event) => {
    const touch = event.changedTouches[0];
    if (!touch) return;
    end(touch.clientX, touch.clientY);
  }, { passive: true });

  stage.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return;
    begin(event.clientX, event.clientY);
  });

  stage.addEventListener('mouseup', (event) => {
    if (event.button !== 0) return;
    end(event.clientX, event.clientY);
  });
}

function setupMessageDismiss() {
  const card = document.getElementById('message-card');
  if (!card) return;

  let pointerStart = null;

  card.addEventListener('pointerdown', (event) => {
    pointerStart = {
      x: event.clientX,
      y: event.clientY
    };
  });

  card.addEventListener('pointerup', (event) => {
    if (!pointerStart) return;

    const deltaX = event.clientX - pointerStart.x;
    const deltaY = event.clientY - pointerStart.y;
    pointerStart = null;

    if (Math.abs(deltaX) <= 12 && Math.abs(deltaY) <= 12) {
      acknowledgeActiveMessage();
    }
  });

  card.addEventListener('pointercancel', () => {
    pointerStart = null;
  });
}

function startResurfaceTicker() {
  window.setInterval(() => {
    updateNonTouchViewSchedule();
  }, 1000);
}

window.appView = {
  VIEW_MODES,
  getCurrentViewMode: () => messageState.currentViewMode,
  setViewMode
};

async function initializeMessages() {
  setViewMode(VIEW_MODES.DASHBOARD);
  await fetchMessageConfig();
  setupSwipeNavigation();
  setupMessageDismiss();
  await fetchMessages();
  startResurfaceTicker();
  window.setInterval(fetchMessages, MESSAGE_POLL_INTERVAL_MS);
  window.addEventListener('focus', fetchMessages);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      fetchMessages();
    }
  });
}

initializeMessages();
