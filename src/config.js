'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadDotEnv(envPath = path.join(ROOT_DIR, '.env')) {
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

function parseBool(val, fallback) {
  if (val === undefined || val === null || val === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(val).toLowerCase());
}

function parseIntSafe(val, fallback) {
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}

const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');

const config = {
  rootDir: ROOT_DIR,
  dataDir: DATA_DIR,
  publicDir: path.join(ROOT_DIR, 'public'),
  dbPath: process.env.DB_PATH || path.join(DATA_DIR, 'radar.sqlite'),
  cloudStatePath: process.env.CLOUD_STATE_PATH || path.join(DATA_DIR, 'cloud-state.json'),
  watchlistFilePath: process.env.WATCHLIST_FILE || path.join(ROOT_DIR, 'watchlist.json'),
  cloudMode: parseBool(process.env.CLOUD_MODE, false),
  cloudWebUrl: (process.env.CLOUD_WEB_URL || '').trim(),
  host: process.env.HOST || '127.0.0.1',
  port: parseIntSafe(process.env.PORT, 3456),
  defaultSourceUser: (process.env.DEFAULT_SOURCE_USER || 'user_hidden').trim(),
  extraSources: (process.env.EXTRA_SOURCES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  syncIntervalMinutes: Math.max(0, parseIntSafe(process.env.SYNC_INTERVAL_MINUTES, 20)),
  perPageFull: 500,
  perPageQuick: 100,
  requestTimeoutMs: 25000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  // Safe non-secret defaults persisted in SQLite settings table
  defaults: {
    telegram_bot_token: '',
    telegram_chat_id: '',
    telegram_bot_enabled: false,
    webhook_url: '',
    windows_toast_enabled: parseBool(process.env.WINDOWS_TOAST_ENABLED, process.platform === 'win32'),
    sync_interval_minutes: Math.max(0, parseIntSafe(process.env.SYNC_INTERVAL_MINUTES, 20)),
  },
  // Runtime environment overrides (never persisted into SQLite or cloud-state.json)
  getEnvOverrides() {
    return {
      telegram_bot_token: (process.env.TELEGRAM_BOT_TOKEN || '').trim(),
      telegram_chat_id: (process.env.TELEGRAM_CHAT_ID || '').trim(),
      telegram_bot_enabled:
        process.env.TELEGRAM_BOT_ENABLED !== undefined && process.env.TELEGRAM_BOT_ENABLED !== ''
          ? parseBool(process.env.TELEGRAM_BOT_ENABLED, false)
          : undefined,
      webhook_url: (process.env.WEBHOOK_URL || '').trim(),
      cloud_mode: parseBool(process.env.CLOUD_MODE, false),
      cloud_web_url: (process.env.CLOUD_WEB_URL || '').trim(),
    };
  },
};

module.exports = { config, loadDotEnv, parseBool, parseIntSafe };
