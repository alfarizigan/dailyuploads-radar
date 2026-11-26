'use strict';

const { config } = require('./config');
const { RadarDB } = require('./db');
const { DailyUploadsScraper } = require('./scraper');
const { Notifier } = require('./notifier');
const { SyncManager } = require('./sync-manager');
const { TelegramBotRunner } = require('./telegram');
const { createAppServer } = require('./api');

async function startServer(options = {}) {
  const dbPath = options.dbPath || config.dbPath;
  const host = options.host || config.host;
  const port = options.port !== undefined ? options.port : config.port;
  const autoSyncOnStart = options.autoSyncOnStart !== undefined ? options.autoSyncOnStart : true;

  const db = new RadarDB(dbPath);
  const scraper = options.scraper || new DailyUploadsScraper();
  const notifier = new Notifier(db, { enableOsToast: options.enableOsToast !== false });
  const syncManager = new SyncManager({ db, scraper, notifier });
  const telegramBot = new TelegramBotRunner({ db, syncManager });

  const server = createAppServer({ db, syncManager, notifier, telegramBot });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${actualPort}`;

  console.log(`\n🛰️  DailyUploads Radar running at ${url}`);
  console.log(`📦 Default source: https://dailyuploads.net/users/${config.defaultSourceUser}`);
  console.log(`💾 Database: ${dbPath}\n`);

  syncManager.startScheduler();
  telegramBot.start().catch((err) => console.error('[Telegram] Init error:', err.message));

  if (autoSyncOnStart) {
    // Non-blocking startup sync (full on first run, quick on subsequent runs)
    syncManager
      .syncAllSources({ mode: 'auto' })
      .then((results) => {
        for (const r of results) {
          if (r.ok) {
            console.log(
              `[Sync] ${r.sourceUser} (${r.mode}): ${r.totalFetched} files processed, +${r.newFilesCount} new, ${r.alertsTriggered} alerts (${(r.durationMs / 1000).toFixed(1)}s)`
            );
          } else {
            console.error(`[Sync] ${r.sourceUser} failed:`, r.error);
          }
        }
      })
      .catch((err) => console.error('[Sync] Startup error:', err.message));
  }

  const shutdown = async () => {
    syncManager.stopScheduler();
    telegramBot.stop();
    for (const client of notifier.sseClients) {
      try {
        client.end();
      } catch {
        // ignore
      }
    }
    await new Promise((resolve) => server.close(() => resolve()));
    db.close();
  };

  return { server, db, scraper, notifier, syncManager, telegramBot, url, port: actualPort, shutdown };
}

if (require.main === module) {
  startServer()
    .then(({ shutdown }) => {
      const handleSignal = () => {
        console.log('\nShutting down DailyUploads Radar...');
        shutdown().finally(() => process.exit(0));
      };
      process.on('SIGINT', handleSignal);
      process.on('SIGTERM', handleSignal);
    })
    .catch((err) => {
      console.error('Failed to start server:', err);
      process.exit(1);
    });
}

module.exports = { startServer };
