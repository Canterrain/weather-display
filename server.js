const express = require('express');
const fetch = require('node-fetch');
const AbortController = global.AbortController || require('abort-controller');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dgram = require('dgram');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const configPath = path.join(__dirname, 'config.json');
const messagesPath = path.join(__dirname, 'messages.json');
const DISCOVERY_PORT = 41234;
const DISCOVERY_TIMEOUT_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 5000;
const HEARTBEAT_STALE_MS = 15000;
const DISCOVERY_VERSION = 1;

function loadConfig() {
  if (!fs.existsSync(configPath)) return null;
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

let config = loadConfig();

let lastGoodPayload = null;
let lastGoodAt = 0;

const messageRuntime = {
  sharingMode: 'single',
  role: 'single',
  deviceId: '',
  roomName: '',
  localIp: null,
  localHubUrl: null,
  hubUrl: null,
  hubDeviceId: null,
  hubRoomName: null,
  lastHubHeartbeatAt: 0,
  knownDevices: new Map(),
  socket: null,
  discoveryTimer: null,
  heartbeatInterval: null,
  monitorInterval: null
};

function ensureMessagesStore() {
  if (!fs.existsSync(messagesPath)) {
    fs.writeFileSync(messagesPath, JSON.stringify({ messages: [] }, null, 2));
  }
}

function readMessagesStore() {
  ensureMessagesStore();
  try {
    const raw = fs.readFileSync(messagesPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      messages: Array.isArray(parsed?.messages) ? parsed.messages : []
    };
  } catch (error) {
    console.error('Failed to read messages store:', error);
    return { messages: [] };
  }
}

function writeMessagesStore(store) {
  ensureMessagesStore();
  fs.writeFileSync(messagesPath, JSON.stringify({
    messages: Array.isArray(store?.messages) ? store.messages : []
  }, null, 2));
}

function getLocalIpv4Address() {
  const interfaces = os.networkInterfaces();
  for (const addresses of Object.values(interfaces)) {
    for (const addr of addresses || []) {
      if (addr && addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '127.0.0.1';
}

function nowIso() {
  return new Date().toISOString();
}

function isMessageExpired(message) {
  if (!message?.expiresAt) return false;
  const expires = Date.parse(message.expiresAt);
  return Number.isFinite(expires) && expires <= Date.now();
}

function isMessageVisibleToDevice(message, deviceId) {
  if (!message || !message.active || isMessageExpired(message)) return false;
  if (message.target === 'all') return true;
  return !!deviceId && message.target === deviceId;
}

function isMessageAcknowledged(message, deviceId) {
  if (!deviceId) return false;
  return Array.isArray(message?.acknowledgedBy) && message.acknowledgedBy.includes(deviceId);
}

function sortMessages(messages) {
  return [...messages].sort((a, b) => {
    const priorityA = a.priority === 'important' ? 1 : 0;
    const priorityB = b.priority === 'important' ? 1 : 0;
    if (priorityA !== priorityB) return priorityB - priorityA;
    return Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0);
  });
}

function normalizeMessagePayload(body = {}) {
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const sender = typeof body.sender === 'string' ? body.sender.trim() : '';
  const target = typeof body.target === 'string' && body.target.trim() ? body.target.trim() : 'all';
  const priority = body.priority === 'important' ? 'important' : 'normal';
  const expiresAt = typeof body.expiresAt === 'string' && body.expiresAt.trim() ? body.expiresAt.trim() : null;

  if (!text) {
    throw new Error('Message text is required');
  }

  if (text.length > 180) {
    throw new Error('Message text must be 180 characters or fewer');
  }

  if (sender.length > 40) {
    throw new Error('Sender must be 40 characters or fewer');
  }

  return { text, sender, target, priority, expiresAt };
}

function mergeMessages(baseMessages, incomingMessages) {
  const merged = new Map();

  for (const message of baseMessages || []) {
    if (message?.id) {
      merged.set(message.id, {
        ...message,
        acknowledgedBy: Array.isArray(message.acknowledgedBy) ? [...new Set(message.acknowledgedBy)] : []
      });
    }
  }

  for (const message of incomingMessages || []) {
    if (!message?.id) continue;

    if (!merged.has(message.id)) {
      merged.set(message.id, {
        ...message,
        acknowledgedBy: Array.isArray(message.acknowledgedBy) ? [...new Set(message.acknowledgedBy)] : []
      });
      continue;
    }

    const existing = merged.get(message.id);
    existing.acknowledgedBy = [...new Set([
      ...(Array.isArray(existing.acknowledgedBy) ? existing.acknowledgedBy : []),
      ...(Array.isArray(message.acknowledgedBy) ? message.acknowledgedBy : [])
    ])];

    existing.active = existing.active !== false && message.active !== false;
    existing.expiresAt = existing.expiresAt || message.expiresAt || null;
  }

  return Array.from(merged.values());
}

function updateKnownDevice(deviceId, roomName) {
  const normalizedDeviceId = String(deviceId || '').trim();
  if (!normalizedDeviceId || normalizedDeviceId === 'all' || normalizedDeviceId === 'default-clock') return;

  const existing = messageRuntime.knownDevices.get(normalizedDeviceId);
  const nextRoomName = (roomName || '').trim();
  const resolvedRoomName = nextRoomName || existing?.roomName || normalizedDeviceId;

  messageRuntime.knownDevices.set(normalizedDeviceId, {
    deviceId: normalizedDeviceId,
    roomName: resolvedRoomName,
    lastSeenAt: nowIso()
  });
}

function getKnownTargets() {
  const targets = [{ id: 'all', label: 'All clocks' }];
  const devices = Array.from(messageRuntime.knownDevices.values())
    .filter((device) => device.deviceId !== 'all' && device.deviceId !== 'default-clock')
    .sort((a, b) => a.roomName.localeCompare(b.roomName));

  devices.forEach((device) => {
    targets.push({
      id: device.deviceId,
      label: device.roomName || device.deviceId
    });
  });

  return targets;
}

function compareHubPriority(deviceIdA, deviceIdB) {
  return String(deviceIdA || '').localeCompare(String(deviceIdB || ''));
}

function buildDiscoveryPayload(type) {
  return JSON.stringify({
    type,
    version: DISCOVERY_VERSION,
    deviceId: messageRuntime.deviceId,
    roomName: messageRuntime.roomName,
    hubUrl: messageRuntime.localHubUrl
  });
}

function sendDiscoveryPacket(payload, address = '255.255.255.255', port = DISCOVERY_PORT) {
  if (!messageRuntime.socket) return;
  const buffer = Buffer.from(payload);
  messageRuntime.socket.send(buffer, port, address, (error) => {
    if (error) {
      console.error('Discovery send failed:', error.message);
    }
  });
}

function clearDiscoveryTimer() {
  if (messageRuntime.discoveryTimer) {
    clearTimeout(messageRuntime.discoveryTimer);
    messageRuntime.discoveryTimer = null;
  }
}

async function syncLocalStoreToHub(hubUrl) {
  if (!hubUrl || hubUrl === messageRuntime.localHubUrl) return;
  try {
    const store = readMessagesStore();
    await fetch(`${hubUrl}/api/messages/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: store.messages
      })
    });
  } catch (error) {
    console.error('Failed to sync local messages to hub:', error.message);
  }
}

async function becomeSharedClient(hubInfo) {
  clearDiscoveryTimer();
  if (messageRuntime.role === 'shared-hub') {
    await syncLocalStoreToHub(hubInfo.hubUrl);
  }

  messageRuntime.role = 'shared-client';
  messageRuntime.hubUrl = hubInfo.hubUrl;
  messageRuntime.hubDeviceId = hubInfo.deviceId;
  messageRuntime.hubRoomName = hubInfo.roomName || hubInfo.deviceId;
  messageRuntime.lastHubHeartbeatAt = Date.now();
  updateKnownDevice(hubInfo.deviceId, hubInfo.roomName);
}

function becomeSharedHub() {
  clearDiscoveryTimer();
  messageRuntime.role = 'shared-hub';
  messageRuntime.hubUrl = messageRuntime.localHubUrl;
  messageRuntime.hubDeviceId = messageRuntime.deviceId;
  messageRuntime.hubRoomName = messageRuntime.roomName;
  messageRuntime.lastHubHeartbeatAt = Date.now();
  updateKnownDevice(messageRuntime.deviceId, messageRuntime.roomName);
}

function startDiscovery() {
  clearDiscoveryTimer();
  if (messageRuntime.sharingMode !== 'shared') return;
  if (messageRuntime.role !== 'shared-hub') {
    messageRuntime.role = 'shared-discovering';
  }

  sendDiscoveryPacket(buildDiscoveryPayload('weather-clock-message-discovery'));

  messageRuntime.discoveryTimer = setTimeout(() => {
    if (messageRuntime.role === 'shared-discovering') {
      becomeSharedHub();
    }
  }, DISCOVERY_TIMEOUT_MS);
}

async function handleHubSignal(payload) {
  if (!payload?.deviceId || payload.deviceId === messageRuntime.deviceId || !payload.hubUrl) return;

  updateKnownDevice(payload.deviceId, payload.roomName);

  if (messageRuntime.role === 'shared-hub') {
    if (compareHubPriority(payload.deviceId, messageRuntime.deviceId) < 0) {
      await becomeSharedClient(payload);
    }
    return;
  }

  if (
    !messageRuntime.hubDeviceId ||
    compareHubPriority(payload.deviceId, messageRuntime.hubDeviceId) < 0 ||
    messageRuntime.role === 'shared-discovering'
  ) {
    await becomeSharedClient(payload);
  } else if (payload.deviceId === messageRuntime.hubDeviceId) {
    messageRuntime.lastHubHeartbeatAt = Date.now();
  }
}

function setupDiscoverySocket() {
  if (messageRuntime.sharingMode !== 'shared') return;
  if (messageRuntime.socket) return;

  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  socket.on('error', (error) => {
    console.error('Discovery socket error:', error.message);
  });

  socket.on('message', async (buffer, rinfo) => {
    let payload;
    try {
      payload = JSON.parse(buffer.toString());
    } catch {
      return;
    }

    if (payload?.version !== DISCOVERY_VERSION) return;

    if (payload.type === 'weather-clock-message-discovery') {
      updateKnownDevice(payload.deviceId, payload.roomName);
      if (messageRuntime.role === 'shared-hub') {
        sendDiscoveryPacket(buildDiscoveryPayload('weather-clock-message-hub'), rinfo.address, rinfo.port);
      }
      return;
    }

    if (
      payload.type === 'weather-clock-message-hub' ||
      payload.type === 'weather-clock-message-heartbeat'
    ) {
      await handleHubSignal(payload);
    }
  });

  socket.bind(DISCOVERY_PORT, () => {
    socket.setBroadcast(true);
    messageRuntime.socket = socket;
    startDiscovery();
  });
}

function startSharedRuntime() {
  if (messageRuntime.sharingMode !== 'shared') return;

  setupDiscoverySocket();

  if (!messageRuntime.heartbeatInterval) {
    messageRuntime.heartbeatInterval = setInterval(() => {
      if (messageRuntime.role === 'shared-hub') {
        sendDiscoveryPacket(buildDiscoveryPayload('weather-clock-message-heartbeat'));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  if (!messageRuntime.monitorInterval) {
    messageRuntime.monitorInterval = setInterval(() => {
      if (
        messageRuntime.role === 'shared-client' &&
        Date.now() - messageRuntime.lastHubHeartbeatAt > HEARTBEAT_STALE_MS
      ) {
        messageRuntime.hubUrl = null;
        messageRuntime.hubDeviceId = null;
        messageRuntime.hubRoomName = null;
        startDiscovery();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}

function initializeMessageRuntime() {
  const cfg = loadConfig() || {};
  messageRuntime.sharingMode = cfg.messageSharing === 'shared' ? 'shared' : 'single';
  messageRuntime.deviceId = cfg.deviceId || `${os.hostname().toLowerCase()}-clock`;
  messageRuntime.roomName = cfg.roomName || os.hostname();
  messageRuntime.localIp = getLocalIpv4Address();
  messageRuntime.localHubUrl = `http://${messageRuntime.localIp}:${PORT}`;
  updateKnownDevice(messageRuntime.deviceId, messageRuntime.roomName);

  if (messageRuntime.sharingMode === 'shared') {
    messageRuntime.role = 'shared-discovering';
    startSharedRuntime();
  } else {
    messageRuntime.role = 'single';
    messageRuntime.hubUrl = messageRuntime.localHubUrl;
    messageRuntime.hubDeviceId = messageRuntime.deviceId;
    messageRuntime.hubRoomName = messageRuntime.roomName;
  }
}

function shouldProxyMessages() {
  return (
    messageRuntime.sharingMode === 'shared' &&
    messageRuntime.role === 'shared-client' &&
    !!messageRuntime.hubUrl &&
    messageRuntime.hubUrl !== messageRuntime.localHubUrl
  );
}

function getRequestKnownDevice(req) {
  const headerDeviceId = typeof req.headers['x-clock-device-id'] === 'string'
    ? req.headers['x-clock-device-id'].trim()
    : '';
  const headerRoomName = typeof req.headers['x-clock-room-name'] === 'string'
    ? req.headers['x-clock-room-name'].trim()
    : '';

  return {
    deviceId: headerDeviceId,
    roomName: headerRoomName
  };
}

async function proxyMessageRequest(req, res) {
  if (!shouldProxyMessages()) return false;

  try {
    const proxied = await fetch(`${messageRuntime.hubUrl}${req.originalUrl}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'x-clock-device-id': messageRuntime.deviceId,
        'x-clock-room-name': messageRuntime.roomName
      },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {})
    });

    const data = await proxied.json();
    res.status(proxied.status).json(data);
    return true;
  } catch (error) {
    console.error('Failed to proxy message request:', error.message);
    res.status(502).json({ error: 'Message hub unavailable' });
    return true;
  }
}

async function fetchWithTimeout(url, ms = 10000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function geocodeLocation(location) {
  const url =
    `https://geocoding-api.open-meteo.com/v1/search` +
    `?name=${encodeURIComponent(location)}` +
    `&count=1&language=en&format=json`;

  const resp = await fetchWithTimeout(url, 10000);
  const data = await resp.json();

  if (!resp.ok || !data || !Array.isArray(data.results) || data.results.length === 0) {
    throw new Error(`Geocoding failed for location "${location}"`);
  }

  const r = data.results[0];

  if (typeof r.latitude !== 'number' || typeof r.longitude !== 'number') {
    throw new Error(`Geocoding returned invalid lat/lon for "${location}"`);
  }

  return {
    lat: r.latitude,
    lon: r.longitude,
    timezone: r.timezone || 'auto',
    resolvedName: [r.name, r.admin1, r.country_code].filter(Boolean).join(', ')
  };
}

async function ensureLatLonTimezone(cfg) {
  const hasLatLon = typeof cfg.lat === 'number' && typeof cfg.lon === 'number';
  const hasTz = typeof cfg.timezone === 'string' && cfg.timezone.length > 0;

  if (hasLatLon && hasTz) return cfg;

  const geo = await geocodeLocation(cfg.location);

  const updated = {
    ...cfg,
    lat: geo.lat,
    lon: geo.lon,
    timezone: geo.timezone || 'auto'
  };

  fs.writeFileSync(configPath, JSON.stringify(updated, null, 2));
  return updated;
}

function temperatureUnitFromCfg(cfg) {
  return cfg.units === 'metric' ? 'celsius' : 'fahrenheit';
}

function isThundersnow(cfg, weathercode, tempNow, tempUnit) {
  const thunderCodes = [95, 96, 99];
  if (!thunderCodes.includes(weathercode)) return false;

  const thresholdF = typeof cfg.thundersnowF === 'number' ? cfg.thundersnowF : 34;
  const thresholdC = typeof cfg.thundersnowC === 'number' ? cfg.thundersnowC : 1;

  if (tempUnit === 'fahrenheit') return tempNow <= thresholdF;
  return tempNow <= thresholdC;
}

function safeDailyValue(arr, i) {
  if (!Array.isArray(arr)) return null;
  if (i < 0 || i >= arr.length) return null;
  return arr[i];
}

function parseIsoMs(s) {
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : null;
}

function findNearestIndexByTime(timeArr, targetIso) {
  if (!Array.isArray(timeArr) || timeArr.length === 0) return -1;
  const target = parseIsoMs(targetIso);
  if (target == null) return -1;

  let bestI = -1;
  let bestDiff = Infinity;
  for (let i = 0; i < timeArr.length; i++) {
    const t = parseIsoMs(timeArr[i]);
    if (t == null) continue;
    const diff = Math.abs(t - target);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestI = i;
    }
  }
  return bestI;
}

function getTempThresholdForSnow(cfg, tempUnit) {
  const thresholdF = typeof cfg.snowTempF === 'number' ? cfg.snowTempF : 34;
  const thresholdC = typeof cfg.snowTempC === 'number' ? cfg.snowTempC : 1;
  return tempUnit === 'fahrenheit' ? thresholdF : thresholdC;
}

function applyRecentSnowOverrideHourly(cfg, currentCode, hourly, nowIso) {
  const recentHours = typeof cfg.recentSnowHours === 'number' ? cfg.recentSnowHours : 2;
  const snowThreshold = typeof cfg.recentSnowMm === 'number' ? cfg.recentSnowMm : 0;

  const times = hourly?.time;
  const snowfall = hourly?.snowfall;
  const codes = hourly?.weathercode;

  if (!Array.isArray(times) || !Array.isArray(snowfall) || !Array.isArray(codes)) {
    return { code: currentCode, used: false };
  }

  const bestI = findNearestIndexByTime(times, nowIso);
  if (bestI < 0) return { code: currentCode, used: false };

  const startI = Math.max(0, bestI - recentHours);

  let sawSnow = false;
  let sawSnowCode = false;

  for (let i = startI; i <= bestI; i++) {
    const s = Number(snowfall[i] ?? 0);
    const c = Number(codes[i] ?? -1);

    if (s > snowThreshold) sawSnow = true;
    if ((c >= 71 && c <= 77) || c === 85 || c === 86) sawSnowCode = true;
  }

  if (!sawSnow && !sawSnowCode) return { code: currentCode, used: false };
  return { code: 73, used: true };
}

function applyActivePrecipOverrideMinutely(cfg, currentCode, tempNow, tempUnit, min15, nowIso) {
  const times = min15?.time;
  const precip = min15?.precipitation;
  const snowfall = min15?.snowfall;

  if (!Array.isArray(times) || (!Array.isArray(precip) && !Array.isArray(snowfall))) {
    return { code: currentCode, used: false, reason: null };
  }

  const recentMinutes = typeof cfg.recentPrecipMinutes === 'number' ? cfg.recentPrecipMinutes : 60;
  const samplesBack = Math.max(1, Math.ceil(recentMinutes / 15));

  const bestI = findNearestIndexByTime(times, nowIso);
  if (bestI < 0) return { code: currentCode, used: false, reason: null };

  const startI = Math.max(0, bestI - samplesBack);
  const precipThreshold = typeof cfg.recentPrecipMm === 'number' ? cfg.recentPrecipMm : 0;
  const snowThreshold = typeof cfg.recentSnowMm15 === 'number' ? cfg.recentSnowMm15 : 0;

  let sawAnyPrecip = false;
  let sawAnySnowfall = false;

  for (let i = startI; i <= bestI; i++) {
    const p = Array.isArray(precip) ? Number(precip[i] ?? 0) : 0;
    const s = Array.isArray(snowfall) ? Number(snowfall[i] ?? 0) : 0;

    if (p > precipThreshold) sawAnyPrecip = true;
    if (s > snowThreshold) sawAnySnowfall = true;
  }

  if (!sawAnyPrecip && !sawAnySnowfall) {
    return { code: currentCode, used: false, reason: null };
  }

  const snowTemp = getTempThresholdForSnow(cfg, tempUnit);
  const isSnowByTemp = tempNow <= snowTemp;

  if (sawAnySnowfall || (sawAnyPrecip && isSnowByTemp)) {
    return { code: 73, used: true, reason: 'minutely_snow_or_cold_precip' };
  }

  return { code: 61, used: true, reason: 'minutely_rain' };
}

app.get('/config', (req, res) => {
  const cfg = loadConfig();
  if (!cfg) return res.status(500).json({ error: 'Missing config.json' });

  res.json({
    timeFormat: cfg.timeFormat || cfg.clockFormat || cfg.format || null,
    leadingZero12h: typeof cfg.leadingZero12h === 'boolean' ? cfg.leadingZero12h : true,
    units: cfg.units || null,
    deviceId: cfg.deviceId || null,
    roomName: cfg.roomName || null,
    messageSharing: cfg.messageSharing || 'single',
    inputMode: cfg.inputMode === 'non-touch' ? 'non-touch' : 'touch'
  });
});

app.get('/messages', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'messages.html'));
});

app.get('/api/message-runtime', (req, res) => {
  res.json({
    sharingMode: messageRuntime.sharingMode,
    role: messageRuntime.role,
    deviceId: messageRuntime.deviceId,
    roomName: messageRuntime.roomName,
    hubUrl: messageRuntime.hubUrl,
    hubDeviceId: messageRuntime.hubDeviceId
  });
});

app.get('/api/message-targets', async (req, res) => {
  if (await proxyMessageRequest(req, res)) return;
  res.json({ targets: getKnownTargets() });
});

app.get('/api/messages', async (req, res) => {
  if (await proxyMessageRequest(req, res)) return;
  const deviceId = typeof req.query.deviceId === 'string' ? req.query.deviceId : '';
  const includeDismissed = req.query.includeDismissed === 'true';
  const store = readMessagesStore();
  const knownDevice = getRequestKnownDevice(req);

  if (deviceId !== 'all') {
    const resolvedRoomName = deviceId === messageRuntime.deviceId
      ? messageRuntime.roomName
      : (knownDevice.deviceId === deviceId ? knownDevice.roomName : '');
    updateKnownDevice(deviceId, resolvedRoomName);
  }

  const visible = sortMessages(
    deviceId === 'all'
      ? store.messages.filter((message) => message.active && !isMessageExpired(message))
      : store.messages.filter((message) => isMessageVisibleToDevice(message, deviceId))
  );

  const filtered = includeDismissed
    ? visible
    : visible.filter((message) => !isMessageAcknowledged(message, deviceId));

  const unreadCount = visible.filter((message) => !isMessageAcknowledged(message, deviceId)).length;

  res.json({
    deviceId,
    unreadCount,
    messages: filtered
  });
});

app.post('/api/messages', async (req, res) => {
  if (await proxyMessageRequest(req, res)) return;
  try {
    const normalized = normalizeMessagePayload(req.body);
    const store = readMessagesStore();
    const message = {
      id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      text: normalized.text,
      sender: normalized.sender,
      createdAt: nowIso(),
      expiresAt: normalized.expiresAt,
      target: normalized.target,
      priority: normalized.priority,
      active: true,
      acknowledgedBy: []
    };

    store.messages.unshift(message);
    writeMessagesStore(store);

    res.status(201).json(message);
  } catch (error) {
    res.status(400).json({ error: error.message || 'Invalid message payload' });
  }
});

app.post('/api/messages/:id/ack', async (req, res) => {
  if (await proxyMessageRequest(req, res)) return;
  const { id } = req.params;
  const deviceId = typeof req.body?.deviceId === 'string' ? req.body.deviceId.trim() : '';
  const knownDevice = getRequestKnownDevice(req);

  if (!deviceId) {
    return res.status(400).json({ error: 'deviceId is required' });
  }

  const store = readMessagesStore();
  const message = store.messages.find((item) => item.id === id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  if (!Array.isArray(message.acknowledgedBy)) {
    message.acknowledgedBy = [];
  }

  if (!message.acknowledgedBy.includes(deviceId)) {
    message.acknowledgedBy.push(deviceId);
    writeMessagesStore(store);
  }

  const resolvedRoomName = deviceId === messageRuntime.deviceId
    ? messageRuntime.roomName
    : (knownDevice.deviceId === deviceId ? knownDevice.roomName : '');
  updateKnownDevice(deviceId, resolvedRoomName);

  res.json({ ok: true, id, deviceId });
});

app.post('/api/messages/:id/deactivate', async (req, res) => {
  if (await proxyMessageRequest(req, res)) return;
  const { id } = req.params;
  const store = readMessagesStore();
  const message = store.messages.find((item) => item.id === id);
  if (!message) {
    return res.status(404).json({ error: 'Message not found' });
  }

  message.active = false;
  writeMessagesStore(store);

  res.json({ ok: true, id });
});

app.post('/api/messages/sync', (req, res) => {
  if (messageRuntime.role !== 'shared-hub' && messageRuntime.role !== 'single') {
    return res.status(409).json({ error: 'Only the current message hub can accept sync data' });
  }

  const incomingMessages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const store = readMessagesStore();
  store.messages = sortMessages(mergeMessages(store.messages, incomingMessages));
  writeMessagesStore(store);

  res.json({ ok: true, count: store.messages.length });
});

app.get('/weather', async (req, res) => {
  config = loadConfig();
  if (!config) return res.status(500).json({ error: 'Missing config.json' });

  try {
    const cfg = await ensureLatLonTimezone(config);
    const tempUnit = temperatureUnitFromCfg(cfg);
    const forecastDays = 6;

    const url =
      `https://api.open-meteo.com/v1/forecast` +
      `?latitude=${encodeURIComponent(cfg.lat)}` +
      `&longitude=${encodeURIComponent(cfg.lon)}` +
      `&current_weather=true` +
      `&hourly=weathercode,snowfall` +
      `&minutely_15=precipitation,snowfall` +
      `&daily=sunrise,sunset,temperature_2m_max,temperature_2m_min,weathercode` +
      `&temperature_unit=${encodeURIComponent(tempUnit)}` +
      `&timezone=${encodeURIComponent(cfg.timezone || 'auto')}` +
      `&forecast_days=${forecastDays}`;

    const resp = await fetchWithTimeout(url, 10000);
    const data = await resp.json();

    if (!resp.ok) {
      console.error('Open-Meteo fetch error', data);
      if (lastGoodPayload) {
        return res.json({ ...lastGoodPayload, stale: true, staleAgeMs: Date.now() - lastGoodAt });
      }
      return res.status(500).json({ error: 'Weather fetch failed' });
    }

    const cur = data.current_weather;
    const daily = data.daily;
    const hourly = data.hourly;
    const min15 = data.minutely_15;

    if (!cur || !daily) throw new Error('Open-Meteo response missing current_weather or daily');

    const highTodayRaw = safeDailyValue(daily.temperature_2m_max, 0);
    const lowTodayRaw = safeDailyValue(daily.temperature_2m_min, 0);
    const highToday = highTodayRaw == null ? null : Math.round(highTodayRaw);
    const lowToday = lowTodayRaw == null ? null : Math.round(lowTodayRaw);

    const currentTemp = Math.round(cur.temperature);
    let currentCode = Number(cur.weathercode);
    const isDay = cur.is_day === 1;

    const minutelyOverride = applyActivePrecipOverrideMinutely(
      cfg,
      currentCode,
      currentTemp,
      tempUnit,
      min15,
      cur.time
    );

    if (minutelyOverride.used) {
      currentCode = minutelyOverride.code;
    } else {
      const hourlyOverride = applyRecentSnowOverrideHourly(cfg, currentCode, hourly, cur.time);
      if (hourlyOverride.used) currentCode = hourlyOverride.code;
    }

    const currentThundersnow = isThundersnow(cfg, currentCode, currentTemp, tempUnit);
    const fixedHigh = highToday == null ? currentTemp : Math.max(highToday, currentTemp);
    const fixedLow = lowToday == null ? currentTemp : Math.min(lowToday, currentTemp);
    const sunriseToday = safeDailyValue(daily.sunrise, 0) || null;
    const sunsetToday = safeDailyValue(daily.sunset, 0) || null;

    const forecast = [];
    for (let i = 1; i <= 5; i++) {
      const maxRaw = safeDailyValue(daily.temperature_2m_max, i);
      const minRaw = safeDailyValue(daily.temperature_2m_min, i);
      const codeRaw = safeDailyValue(daily.weathercode, i);

      if (maxRaw == null || minRaw == null || codeRaw == null) continue;

      const max = Math.round(maxRaw);
      const min = Math.round(minRaw);
      const mid = Math.round((max + min) / 2);
      const code = Number(codeRaw);
      const thundersnow = isThundersnow(cfg, code, mid, tempUnit);

      forecast.push({
        temp: max,
        high: max,
        low: min,
        code,
        is_day: true,
        thundersnow
      });
    }

    const payload = {
      current: {
        temp: currentTemp,
        high: fixedHigh,
        low: fixedLow,
        code: currentCode,
        is_day: isDay,
        thundersnow: currentThundersnow,
        sunrise: sunriseToday,
        sunset: sunsetToday
      },
      forecast
    };

    lastGoodPayload = payload;
    lastGoodAt = Date.now();

    res.json(payload);
  } catch (error) {
    console.error('Server error fetching weather', error);

    if (lastGoodPayload) {
      return res.json({ ...lastGoodPayload, stale: true, staleAgeMs: Date.now() - lastGoodAt });
    }

    res.status(500).json({ error: 'Weather server error' });
  }
});

app.listen(PORT, () => {
  initializeMessageRuntime();
  console.log(`Weather server running at http://localhost:${PORT}`);
});
