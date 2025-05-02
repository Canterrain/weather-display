const { contextBridge } = require('electron');
const fs = require('fs').promises;
const path = require('path');

async function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.json');
    const data = await fs.readFile(configPath, 'utf-8');
    const config = JSON.parse(data);
    contextBridge.exposeInMainWorld('config', config);
  } catch (err) {
    console.error("Failed to load config.json in preload:", err);
    contextBridge.exposeInMainWorld('config', {}); // fallback
  }
}

loadConfig();
