'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { RadarDB } = require('../src/db');
const { TelegramBotRunner } = require('../src/telegram');
const { runCloudSync } = require('../src/cloud-sync');
const { parseFilename, parseSizeToBytes, buildDownloadUrl } = require('../src/parser');
const { CloudRadarEngine, detectGithubRepoFromLocation } = require('../public/cloud-engine');

function makeFile(code, rawFilename, { size = '80.0 MB', days = 0, downloads = 5, source = 'user_hidden' } = {}) {
  const meta = parseFilename(rawFilename);
  return {
    file_code: code,
    source_user: source,
    download_url: buildDownloadUrl(code, rawFilename),
    size_text: size,
    size_bytes: parseSizeToBytes(size),
    uploaded_days_ago: days,
    downloads,
    ...meta,
  };
}

test('Cloud state export/import preserves FTS5, IDs, bot_offset, and never leaks env secrets', () => {
  const prevToken = process.env.TELEGRAM_BOT_TOKEN;
  const prevChat = process.env.TELEGRAM_CHAT_ID;
  const prevHook = process.env.WEBHOOK_URL;
  const prevCloud = process.env.CLOUD_MODE;

  process.env.TELEGRAM_BOT_TOKEN = '999999:SUPER_SECRET_BOT_TOKEN';
  process.env.TELEGRAM_CHAT_ID = '777888999';
  process.env.WEBHOOK_URL = 'https://discord.com/api/webhooks/secret/hook';
  process.env.CLOUD_MODE = '1';

  const db1 = new RadarDB(':memory:');
  const db2 = new RadarDB(':memory:');
  try {
    // Runtime settings resolve secrets from env
    const runtimeSettings = db1.getSettings();
    assert.equal(runtimeSettings.telegram_bot_token, '999999:SUPER_SECRET_BOT_TOKEN');
    assert.equal(runtimeSettings.telegram_chat_id, '777888999');

    // Verify SQLite settings table itself did NOT persist the secret
    const rawSettingsDump = JSON.stringify(db1.db.prepare('SELECT * FROM settings').all());
    assert.ok(!rawSettingsDump.includes('SUPER_SECRET_BOT_TOKEN'));
    assert.ok(!rawSettingsDump.includes('777888999'));
    assert.ok(!rawSettingsDump.includes('webhooks/secret'));

    db1.saveSyncResult(
      'user_hidden',
      [
        makeFile('f1', 'Spotify-Shrubify_(v9.2.1_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 1, downloads: 12 }),
        makeFile('f2', 'Really_Bad_Chess+_(v1.7.2_FW_64bit_os150)-user_hidden.bfi.ipa', { days: 3, downloads: 4 }),
      ],
      { mode: 'full', totalReported: 2 }
    );

    const w = db1.addWatch({ watch_type: 'app', target_slug: 'spotify-shrubify' });
    assert.equal(w.created, true);
    db1.setBotOffset(54321);

    const alerts = db1.matchWatchlistForNewFiles([
      makeFile('f3', 'Spotify-Shrubify_(v9.2.2_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 0, downloads: 1 }),
    ]);
    assert.equal(alerts.length, 1);

    const exported = db1.exportCloudState();
    const serialized = JSON.stringify(exported);
    assert.ok(!serialized.includes('SUPER_SECRET_BOT_TOKEN'), 'Exported cloud state must never contain bot token');
    assert.ok(!serialized.includes('777888999'), 'Exported cloud state must never contain chat ID');
    assert.ok(!serialized.includes('webhooks/secret'), 'Exported cloud state must never contain webhook URL');
    assert.equal(exported.bot_offset, 54321);
    assert.equal(exported.files.length, 2);

    // Hydrate into a brand-new DB and verify FTS5 + autoincrement + bot_offset
    db2.importCloudState(JSON.parse(serialized));
    assert.equal(db2.getBotOffset(), 54321);
    assert.equal(db2.searchFiles({ q: 'Chess+' }).total, 1);
    assert.equal(db2.listAlerts().items.length, 1);

    // Adding another watch after import must not collide with imported IDs
    const wNext = db2.addWatch({ watch_type: 'keyword', keyword: 'Procreate' });
    assert.equal(wNext.created, true);
    assert.ok(wNext.item.id > w.item.id);
  } finally {
    db1.close();
    db2.close();
    if (prevToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = prevToken;
    if (prevChat === undefined) delete process.env.TELEGRAM_CHAT_ID;
    else process.env.TELEGRAM_CHAT_ID = prevChat;
    if (prevHook === undefined) delete process.env.WEBHOOK_URL;
    else process.env.WEBHOOK_URL = prevHook;
    if (prevCloud === undefined) delete process.env.CLOUD_MODE;
    else process.env.CLOUD_MODE = prevCloud;
  }
});

test('TelegramBotRunner.processPendingUpdates drains batches and persists offset across runs', async () => {
  const prevWeb = process.env.CLOUD_WEB_URL;
  process.env.CLOUD_WEB_URL = 'https://alfarizigan.github.io/dailyuploads-radar/';

  const db = new RadarDB(':memory:');
  try {
    db.updateSettings({ telegram_bot_token: '123:BOT', telegram_chat_id: '42' });
    db.saveSyncResult(
      'user_hidden',
      [makeFile('x1', 'LumaFusion_(v5.6.2_PI_FW_64bit_os270)-user_hidden.bfi3.ipa', { days: 0 })],
      { mode: 'full', totalReported: 1 }
    );

    const apiCalls = [];
    let queuedUpdates = [
      { update_id: 100, message: { chat: { id: 42 }, text: '/start' } },
      { update_id: 101, message: { chat: { id: 42 }, text: '/watch LumaFusion' } },
    ];

    const mockFetch = async (url, opts) => {
      const method = url.split('/').pop();
      const body = JSON.parse(opts.body);
      apiCalls.push({ method, body });
      if (method === 'getUpdates') {
        const batch = queuedUpdates.filter((u) => u.update_id >= (body.offset || 0));
        queuedUpdates = [];
        return { ok: true, status: 200, json: async () => ({ ok: true, result: batch }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };

    const bot = new TelegramBotRunner({ db, syncManager: null, fetchFn: mockFetch });
    const run1 = await bot.processPendingUpdates({ registerCommands: true });
    assert.equal(run1.enabled, true);
    assert.equal(run1.processed, 2);
    assert.equal(db.getBotOffset(), 102);

    // /start reply includes Cloud Web App link
    const startMsg = apiCalls.find((c) => c.method === 'sendMessage' && c.body.text.includes('Web Searcher Instan'));
    assert.ok(startMsg, 'Expected /start reply to include CLOUD_WEB_URL');

    // Second run uses persisted offset 102
    const bot2 = new TelegramBotRunner({ db, syncManager: null, fetchFn: mockFetch });
    const run2 = await bot2.processPendingUpdates();
    assert.equal(run2.processed, 0);
    const lastGetUpdates = apiCalls.filter((c) => c.method === 'getUpdates').pop();
    assert.equal(lastGetUpdates.body.offset, 102);
  } finally {
    db.close();
    if (prevWeb === undefined) delete process.env.CLOUD_WEB_URL;
    else process.env.CLOUD_WEB_URL = prevWeb;
  }
});

test('runCloudSync processes queued Telegram /watch BEFORE DailyUploads sync and protects state on scrape failure', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-cloud-test-'));
  const statePath = path.join(tmpDir, 'cloud-state.json');
  const watchlistPath = path.join(tmpDir, 'watchlist.json');
  const ghOutPath = path.join(tmpDir, 'gh-output.txt');
  const ghSumPath = path.join(tmpDir, 'gh-summary.md');

  const prevEnv = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    CLOUD_MODE: process.env.CLOUD_MODE,
    GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
    GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY,
  };

  process.env.TELEGRAM_BOT_TOKEN = '777:CLOUDTOK';
  process.env.TELEGRAM_CHAT_ID = '555';
  process.env.CLOUD_MODE = '1';
  process.env.GITHUB_OUTPUT = ghOutPath;
  process.env.GITHUB_STEP_SUMMARY = ghSumPath;

  try {
    fs.writeFileSync(
      watchlistPath,
      JSON.stringify([{ watch_type: 'keyword', keyword: 'Procreate', platform_filter: 'iOS' }]),
      'utf8'
    );

    const baselineItems = [
      makeFile('b1', 'Spotify-Shrubify_(v9.2.1_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 1 }),
    ];

    let tgQueue = [];
    const sentMessages = [];
    const mockFetch = async (url, opts) => {
      const method = url.split('/').pop();
      const body = JSON.parse(opts.body);
      if (method === 'getUpdates') {
        const items = tgQueue.filter((u) => u.update_id >= (body.offset || 0));
        tgQueue = [];
        return { ok: true, status: 200, json: async () => ({ ok: true, result: items }) };
      }
      if (method === 'sendMessage') {
        sentMessages.push(body);
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };

    let quickItems = baselineItems;
    const mockScraper = {
      fetchAllFiles: async () => ({ items: baselineItems, totalReported: 1, pagesFetched: 1 }),
      fetchRecentFiles: async () => ({ items: quickItems, totalReported: quickItems.length, pagesFetched: 1 }),
    };

    // Run 1: Baseline sync + merges watchlist.json
    const r1 = await runCloudSync({
      statePath,
      watchlistFile: watchlistPath,
      scraper: mockScraper,
      fetchFn: mockFetch,
      skipPostDelay: true,
    });
    assert.equal(r1.ok, true);
    assert.equal(r1.totalAlerts, 0);
    assert.equal(r1.watchlistCount, 1);

    // User queues "/watch Spotify" in Telegram AND user_hidden uploads Spotify v9.2.2 + Procreate v5.4!
    tgQueue = [{ update_id: 50, message: { chat: { id: 555 }, text: '/watch Spotify' } }];
    quickItems = [
      makeFile('b3', 'Procreate_(v5.4.0_iPad_64bit_os160)-user_hidden.bfi2.ipa', { days: 0 }),
      makeFile('b2', 'Spotify-Shrubify_(v9.2.2_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 0 }),
      ...baselineItems,
    ];

    const r2 = await runCloudSync({
      statePath,
      watchlistFile: watchlistPath,
      mode: 'quick',
      scraper: mockScraper,
      fetchFn: mockFetch,
      skipPostDelay: true,
    });
    assert.equal(r2.totalNewFiles, 2);
    assert.equal(r2.totalAlerts, 2, 'Both watchlist.json rule (Procreate) and pre-sync Telegram /watch (Spotify) must alert!');
    assert.equal(r2.pagesNeedsDeploy, true);
    assert.ok(sentMessages.some((m) => m.text.includes('v9.2.1 → v9.2.2')));
    assert.ok(fs.readFileSync(ghOutPath, 'utf8').includes('pages_needs_deploy=true'));
    assert.ok(fs.readFileSync(ghSumPath, 'utf8').includes('DailyUploads Radar — Cloud Sync Summary'));

    // Run 3: Total scraper failure throws non-zero and preserves previous state file intact
    const snapshotBeforeFail = fs.readFileSync(statePath, 'utf8');
    const failingScraper = {
      fetchAllFiles: async () => {
        throw new Error('HTTP 503 Cloudflare');
      },
      fetchRecentFiles: async () => {
        throw new Error('HTTP 503 Cloudflare');
      },
    };
    await assert.rejects(
      () =>
        runCloudSync({
          statePath,
          watchlistFile: watchlistPath,
          mode: 'quick',
          scraper: failingScraper,
          fetchFn: mockFetch,
          skipPostDelay: true,
        }),
      /All DailyUploads sources failed/
    );
    assert.equal(fs.readFileSync(statePath, 'utf8'), snapshotBeforeFail);
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CloudRadarEngine static client matches RadarDB search, filters, stale age, grouping, CSV safety, and watch updates', async () => {
  const db = new RadarDB(':memory:');
  try {
    const sample = [
      makeFile('c1', 'Spotify-Shrubify_(v9.2.2_Univ_64bit_os161)-user_hidden.bfi2.ipa', { size: '173.9 MB', days: 0, downloads: 15 }),
      makeFile('c2', 'AIOStreams_0.8.1.ipa', { size: '18.0 MB', days: 1, downloads: 8 }),
      makeFile('c3', 'AIOStreams_0.7.18.ipa', { size: '17.2 MB', days: 4, downloads: 20 }),
      makeFile('c4', 'Really_Bad_Chess+_(v1.7.2_FW_64bit_os150)-user_hidden.bfi.ipa', { size: '42.7 MB', days: 10, downloads: 5 }),
      makeFile('c5', '=SUM(A1:A2)_Things_3_3.25_[TNT].dmg', { size: '25.0 MB', days: 2, downloads: 30 }),
    ];
    db.saveSyncResult('user_hidden', sample, { mode: 'full', totalReported: sample.length });
    db.addWatch({ watch_type: 'keyword', keyword: 'Things', display_name: 'Things' });

    // Simulate c1 seen 4 days ago so effective uploaded_days_ago becomes 4
    const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString();
    db.db.prepare("UPDATE files SET last_seen_at = ? WHERE file_code = 'c1'").run(fourDaysAgo);

    const exported = db.exportCloudState();
    const engine = new CloudRadarEngine();
    engine.loadStateObject(exported);

    assert.equal(
      detectGithubRepoFromLocation({ hostname: 'alfarizigan.github.io', pathname: '/dailyuploads-radar/' }),
      'alfarizigan/dailyuploads-radar'
    );

    // Grouped vs Flat parity
    assert.equal(engine.searchFiles({ grouped: false }).total, 5);
    const grouped = engine.searchFiles({ grouped: true });
    assert.equal(grouped.total, 4);
    const aio = grouped.items.find((i) => i.app_slug === 'aiostreams');
    assert.equal(aio.version, '0.8.1');
    assert.equal(aio.version_count, 2);
    assert.equal(aio.total_downloads, 28);

    // Special char search & malformed query resilience
    assert.equal(engine.searchFiles({ q: 'Chess+' }).total, 1);
    assert.equal(engine.searchFiles({ q: '""" () -OR* :' }).total, 0);

    // Effective stale age adjustment (c1 was 0d + 4d stale = 4d -> excluded from maxDays=0)
    assert.equal(engine.searchFiles({ maxDays: '0', grouped: false }).total, 0);

    // CSV export formula injection protection
    const csvOut = engine.exportCatalog({ format: 'csv', grouped: false });
    assert.ok(csvOut.content.includes("'=SUM(A1:A2)"));

    // Local browser watch + automatic browser update alert when newer version arrives
    const added = engine.addWatch({ watch_type: 'app', target_slug: 'aiostreams', display_name: 'AIOStreams' });
    assert.equal(added.created, true);
    assert.equal(added.item.last_known_version, '0.8.1');

    db.saveSyncResult(
      'user_hidden',
      [makeFile('c_new', 'AIOStreams_0.9.0.ipa', { size: '19.0 MB', days: 0, downloads: 1 }), ...sample],
      { mode: 'quick', totalReported: 6 }
    );
    engine.loadStateObject(db.exportCloudState());

    const alerts = engine.listAlerts();
    assert.equal(alerts.unread_count, 1);
    assert.equal(alerts.items[0].old_version, '0.8.1');
    assert.equal(alerts.items[0].new_version, '0.9.0');

    // Removing cloud watch mutes it cleanly
    const wlBefore = engine.listWatchlist();
    assert.equal(wlBefore.length, 2);
    const cloudItem = wlBefore.find((w) => w.scope === 'cloud');
    assert.ok(cloudItem);
    engine.removeWatch(cloudItem.id);
    assert.equal(engine.listWatchlist().length, 1);
  } finally {
    db.close();
  }
});
