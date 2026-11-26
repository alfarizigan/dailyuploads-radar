'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { config } = require('./config');
const { RadarDB } = require('./db');
const { DailyUploadsScraper } = require('./scraper');
const { Notifier } = require('./notifier');
const { SyncManager } = require('./sync-manager');
const { TelegramBotRunner } = require('./telegram');
const { extractUsernameFromInput } = require('./api');

function writeFileAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, content, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function exportSqliteToCloudState(sqlitePath = config.dbPath, outPath = config.cloudStatePath) {
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`SQLite database not found at ${sqlitePath}`);
  }
  const db = new RadarDB(sqlitePath);
  try {
    const state = db.exportCloudState();
    writeFileAtomic(outPath, JSON.stringify(state));
    return {
      outPath,
      sources: state.sources.length,
      files: state.files.length,
      watchlist: state.watchlist.length,
      alerts: state.alerts.length,
    };
  } finally {
    db.close();
  }
}

function appendGithubOutput(kv) {
  const outFile = process.env.GITHUB_OUTPUT;
  if (!outFile) return;
  const lines = Object.entries(kv).map(([k, v]) => `${k}=${String(v)}`);
  fs.appendFileSync(outFile, `${lines.join('\n')}\n`, 'utf8');
}

function writeGithubSummary(summaryMarkdown) {
  const summaryFile = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return;
  fs.appendFileSync(summaryFile, `${summaryMarkdown}\n`, 'utf8');
}

async function runCloudSync(options = {}) {
  const t0 = Date.now();
  const statePath = options.statePath || config.cloudStatePath;
  const watchlistFile =
    options.watchlistFile !== undefined ? options.watchlistFile : config.watchlistFilePath;
  const syncMode = ['auto', 'quick', 'full'].includes(options.mode || process.env.SYNC_MODE)
    ? options.mode || process.env.SYNC_MODE
    : 'auto';
  const fetchFn = options.fetchFn || globalThis.fetch;

  const db = new RadarDB(':memory:');
  try {
    let hadPreviousState = false;
    let prevWatchCount = 0;

    if (statePath && fs.existsSync(statePath)) {
      const raw = fs.readFileSync(statePath, 'utf8').trim();
      if (raw) {
        const parsed = JSON.parse(raw);
        db.importCloudState(parsed);
        hadPreviousState = true;
        prevWatchCount = Array.isArray(parsed.watchlist) ? parsed.watchlist.length : 0;
      }
    }

    // Ensure default & extra sources exist
    const desiredSources = [
      config.defaultSourceUser,
      ...(options.extraSources || config.extraSources || []),
    ]
      .map((s) => extractUsernameFromInput(s))
      .filter(Boolean);

    for (const username of desiredSources) {
      if (!db.getSource(username)) {
        db.addSource(username, username);
      }
    }

    // Reconcile declarative watchlist.json if present (honors additions & removals without resurrecting Telegram unwatches)
    let wlReconcile = { added: 0, removed: 0, changed: false };
    if (watchlistFile && fs.existsSync(watchlistFile)) {
      try {
        const rawWl = fs.readFileSync(watchlistFile, 'utf8');
        wlReconcile = db.reconcileWatchlistFile(rawWl);
      } catch (err) {
        console.warn(`[CloudSync] Warning reading ${watchlistFile}: ${err.message}`);
      }
    }

    const scraper = options.scraper || new DailyUploadsScraper();
    const notifier = new Notifier(db, { fetchFn, enableOsToast: false });
    const syncManager = new SyncManager({ db, scraper, notifier });
    const telegramBot = new TelegramBotRunner({ db, syncManager, fetchFn });

    // 1. Drain pending Telegram commands BEFORE syncing DailyUploads so newly added /watch rules apply immediately
    let tgPre = { enabled: false, processed: 0, manualSyncResults: null };
    try {
      tgPre = await telegramBot.processPendingUpdates({
        registerCommands: !hadPreviousState,
      });
    } catch (err) {
      console.error(`[CloudSync] Telegram pre-sync queue error: ${err.message}`);
    }

    // 2. Sync all enabled DailyUploads sources & send alerts (reuse if /sync in Telegram just ran quick sync and full wasn't requested)
    const syncResults =
      Array.isArray(tgPre.manualSyncResults) && tgPre.manualSyncResults.length > 0 && syncMode !== 'full'
        ? tgPre.manualSyncResults
        : await syncManager.syncAllSources({ mode: syncMode });
    const okResults = syncResults.filter((r) => r.ok);
    const failedResults = syncResults.filter((r) => !r.ok);

    if (syncResults.length > 0 && okResults.length === 0) {
      // Preserve pre-sync Telegram bot_offset & watchlist changes so acknowledged updates are never lost or re-spammed
      if (statePath && (tgPre.processed > 0 || wlReconcile.changed)) {
        writeFileAtomic(statePath, JSON.stringify(db.exportCloudState()));
        appendGithubOutput({
          state_changed: 'false',
          preserve_user_state: 'true',
          pages_needs_deploy: 'false',
        });
      }
      const reasons = failedResults.map((f) => `${f.sourceUser}: ${f.error}`).join('; ');
      throw new Error(`All DailyUploads sources failed to sync (${reasons})`);
    }

    const totalNewFiles = okResults.reduce((acc, r) => acc + (r.newFilesCount || 0), 0);
    const totalDeactivated = okResults.reduce((acc, r) => acc + (r.deactivatedCount || 0), 0);
    const totalAlerts = okResults.reduce((acc, r) => acc + (r.alertsTriggered || 0), 0);
    const ranFullSync = okResults.some((r) => r.mode === 'full');

    // 3. Quick post-alert Telegram check if alerts were just dispatched
    let tgPost = { processed: 0 };
    if (tgPre.enabled && totalAlerts > 0 && !options.skipPostDelay) {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        tgPost = await telegramBot.processPendingUpdates();
      } catch (err) {
        console.error(`[CloudSync] Telegram post-sync queue error: ${err.message}`);
      }
    }

    const tgProcessed = (tgPre.processed || 0) + (tgPost.processed || 0);
    const nextState = db.exportCloudState();
    const stats = db.getStats();
    const watchlistChanged =
      wlReconcile.changed ||
      tgProcessed > 0 ||
      nextState.watchlist.length !== prevWatchCount;

    if (statePath) {
      writeFileAtomic(statePath, JSON.stringify(nextState));
    }

    const pagesNeedsDeploy =
      !hadPreviousState ||
      totalNewFiles > 0 ||
      totalDeactivated > 0 ||
      totalAlerts > 0 ||
      watchlistChanged ||
      ranFullSync;

    const totalDurationMs = Date.now() - t0;

    appendGithubOutput({
      state_changed: 'true',
      pages_needs_deploy: pagesNeedsDeploy ? 'true' : 'false',
      new_files: totalNewFiles,
      alerts_triggered: totalAlerts,
      telegram_processed: tgProcessed,
      total_files: stats.total_files || 0,
    });

    const webUrl = config.getEnvOverrides().cloud_web_url || config.cloudWebUrl;
    const summaryLines = [
      `## 🛰️ DailyUploads Radar — Cloud Sync Summary`,
      webUrl ? `🌐 **Live Web Searcher:** [${webUrl}](${webUrl})\n` : '',
      `| Source | Mode | Status | Checked | New Uploads | Alerts | Duration |`,
      `| --- | --- | --- | ---: | ---: | ---: | ---: |`,
      ...syncResults.map((r) =>
        r.ok
          ? `| \`${r.sourceUser}\` | \`${r.mode}\` | ✅ OK | ${r.totalFetched} | **+${r.newFilesCount}** | ${r.alertsTriggered} | ${(r.durationMs / 1000).toFixed(1)}s |`
          : `| \`${r.sourceUser}\` | \`-\` | ❌ Error | 0 | 0 | 0 | — |`
      ),
      ``,
      `- **Total Active Catalog:** ${(stats.total_files || 0).toLocaleString()} files (${(stats.total_apps || 0).toLocaleString()} unique apps)`,
      `- **Active Watchlist Rules:** ${nextState.watchlist.length}`,
      `- **Telegram Commands Processed:** ${tgProcessed}${tgPre.enabled ? '' : ' *(Telegram token not configured yet)*'}`,
      `- **GitHub Pages Update Needed:** \`${pagesNeedsDeploy}\``,
      `- **Total Run Time:** ${(totalDurationMs / 1000).toFixed(2)}s`,
    ].filter(Boolean);

    writeGithubSummary(summaryLines.join('\n'));

    return {
      ok: true,
      syncResults,
      totalNewFiles,
      totalDeactivated,
      totalAlerts,
      tgProcessed,
      pagesNeedsDeploy,
      totalFiles: stats.total_files || 0,
      totalApps: stats.total_apps || 0,
      watchlistCount: nextState.watchlist.length,
      durationMs: totalDurationMs,
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--export-from-sqlite')) {
    try {
      const info = exportSqliteToCloudState();
      console.log(
        `[CloudSync] Exported SQLite -> ${info.outPath} (${info.files} files, ${info.sources} sources, ${info.watchlist} watches)`
      );
      process.exit(0);
    } catch (err) {
      console.error('[CloudSync] Export failed:', err.message);
      process.exit(1);
    }
  }

  const modeArgIdx = args.indexOf('--mode');
  const cliMode = modeArgIdx !== -1 && args[modeArgIdx + 1] ? args[modeArgIdx + 1] : undefined;

  runCloudSync({ mode: cliMode })
    .then((res) => {
      console.log(
        `[CloudSync] Done in ${(res.durationMs / 1000).toFixed(2)}s — catalog=${res.totalFiles} files (${res.totalApps} apps), +${res.totalNewFiles} new, ${res.totalAlerts} alerts, ${res.tgProcessed} tg cmds, deployPages=${res.pagesNeedsDeploy}`
      );
      process.exit(0);
    })
    .catch((err) => {
      console.error('[CloudSync] Fatal error:', err.message || err);
      process.exit(1);
    });
}

module.exports = { runCloudSync, exportSqliteToCloudState };
