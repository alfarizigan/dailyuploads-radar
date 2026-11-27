'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { RadarDB } = require('../src/db');
const { TelegramBotRunner } = require('../src/telegram');
const { runCloudSync } = require('../src/cloud-sync');
const { pingCloudSync, appendBoundedLog } = require('../src/cloud-pinger');
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

    // /start reply includes Cloud Web App link in English
    const startMsg = apiCalls.find(
      (c) =>
        c.method === 'sendMessage' &&
        c.body.text.includes('Instant Web Searcher') &&
        c.body.text.includes('https://alfarizigan.github.io/dailyuploads-radar/')
    );
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

test('Unicode diacritics, watchedOnly keyword filter, and slugifyAppName parity across RadarDB & CloudRadarEngine', () => {
  const { slugifyAppName: cloudSlugify } = require('../public/cloud-engine');
  const { slugifyAppName: serverSlugify } = require('../src/parser');

  assert.equal(
    cloudSlugify('Weather & Radar Premium'),
    serverSlugify('Weather & Radar Premium')
  );
  assert.equal(cloudSlugify("Assassin's Creed"), serverSlugify("Assassin's Creed"));

  const db = new RadarDB(':memory:');
  try {
    const sample = [
      makeFile('u1', 'Désiré_(v1.0.42_Univ_FW_os140_ok27)-user_hidden.bfi2.ipa', { days: 0 }),
      makeFile('u2', 'Spotify-Shrubify_(v9.2.2_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 1 }),
      makeFile('u3', 'Spotify_1.2.0_[TNT].dmg', { days: 2 }),
    ];
    db.saveSyncResult('user_hidden', sample, { mode: 'full', totalReported: 3 });
    db.addWatch({ watch_type: 'keyword', keyword: 'Spotify', platform_filter: 'iOS' });

    const engine = new CloudRadarEngine();
    engine.loadStateObject(db.exportCloudState());

    // Both accented "Désiré" and unaccented "Desire" must find the app in both engines
    assert.equal(db.searchFiles({ q: 'Désiré' }).total, 1);
    assert.equal(db.searchFiles({ q: 'Desire' }).total, 1);
    assert.equal(engine.searchFiles({ q: 'Désiré' }).total, 1);
    assert.equal(engine.searchFiles({ q: 'Desire' }).total, 1);

    // watchedOnly must match keyword watches AND respect platform_filter ('iOS' -> excludes macOS dmg)
    const dbWatched = db.searchFiles({ watchedOnly: true, grouped: false });
    const cloudWatched = engine.searchFiles({ watchedOnly: true, grouped: false });
    assert.equal(dbWatched.total, 1);
    assert.equal(dbWatched.items[0].file_code, 'u2');
    assert.equal(cloudWatched.total, 1);
    assert.equal(cloudWatched.items[0].file_code, 'u2');

    // Unaccented keyword watch ("Desire") must match accented uploads ("Désiré") in BOTH watchedOnly and matchWatchlistForNewFiles!
    db.addWatch({ watch_type: 'keyword', keyword: 'Desire', platform_filter: 'iOS' });
    const diacriticAlerts = db.matchWatchlistForNewFiles([
      makeFile('u1_new', 'Désiré_(v1.0.43_Univ_FW_os140_ok27)-user_hidden.bfi2.ipa', { days: 0 }),
    ]);
    assert.equal(diacriticAlerts.length, 1);
    assert.equal(diacriticAlerts[0].old_version, '1.0.42');
    assert.equal(diacriticAlerts[0].new_version, '1.0.43');
    assert.equal(db.searchFiles({ watchedOnly: true, q: 'Desire', grouped: false }).total, 1);

    engine.loadStateObject(db.exportCloudState());
    assert.equal(engine.searchFiles({ watchedOnly: true, q: 'Desire', grouped: false }).total, 1);

    // Platform-scoped app watch marks only matching platform as is_watched in CloudRadarEngine too
    engine.addWatch({ watch_type: 'app', target_slug: 'spotify-shrubify', platform_filter: 'iOS' });
    db.saveSyncResult(
      'user_hidden',
      [...sample, makeFile('u4', 'Spotify-Shrubify_9.1.0_[TNT].dmg', { days: 1 })],
      { mode: 'full', totalReported: 4 }
    );
    engine.loadStateObject(db.exportCloudState());
    const flatSpot = engine.searchFiles({ q: 'Spotify-Shrubify', grouped: false }).items;
    assert.equal(flatSpot.find((i) => i.file_code === 'u2').is_watched, true);
    assert.equal(flatSpot.find((i) => i.file_code === 'u4').is_watched, false);
  } finally {
    db.close();
  }
});

test('Bidirectional watchlist.json reconciliation avoids zombie resurrection, honors removals, and preserves pre-sync Telegram watches on scrape failure', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-reconcile-'));
  const statePath = path.join(tmpDir, 'cloud-state.json');
  const watchlistPath = path.join(tmpDir, 'watchlist.json');

  const prevEnv = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    CLOUD_MODE: process.env.CLOUD_MODE,
  };
  process.env.TELEGRAM_BOT_TOKEN = '888:RECONTOK';
  process.env.TELEGRAM_CHAT_ID = '555';
  process.env.CLOUD_MODE = '1';

  try {
    const items = [makeFile('r1', 'Spotify-Shrubify_(v9.2.1_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 1 })];
    const okScraper = {
      fetchAllFiles: async () => ({ items, totalReported: 1, pagesFetched: 1 }),
      fetchRecentFiles: async () => ({ items, totalReported: 1, pagesFetched: 1 }),
    };

    let tgQueue = [];
    const sentMessages = [];
    const editedMarkups = [];
    const mockFetch = async (url, opts) => {
      const method = url.split('/').pop();
      const body = JSON.parse(opts.body);
      if (method === 'getUpdates') {
        const batch = tgQueue.filter((u) => u.update_id >= (body.offset || 0));
        tgQueue = [];
        return { ok: true, status: 200, json: async () => ({ ok: true, result: batch }) };
      }
      if (method === 'answerCallbackQuery') {
        // Simulate expired callback_query (>30s delay in GitHub Actions cron)
        return {
          ok: false,
          status: 400,
          json: async () => ({ ok: false, description: 'Bad Request: query is too old and response timeout expired' }),
        };
      }
      if (method === 'editMessageReplyMarkup') {
        editedMarkups.push(body);
      }
      if (method === 'sendMessage') {
        sentMessages.push(body);
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, result: true }) };
    };

    // 1. Seed two rules via watchlist.json
    fs.writeFileSync(
      watchlistPath,
      JSON.stringify([
        { watch_type: 'keyword', keyword: 'Procreate', platform_filter: 'iOS' },
        { watch_type: 'keyword', keyword: 'LumaFusion', platform_filter: 'iOS' },
      ]),
      'utf8'
    );
    const r1 = await runCloudSync({
      statePath,
      watchlistFile: watchlistPath,
      scraper: okScraper,
      fetchFn: mockFetch,
      skipPostDelay: true,
    });
    assert.equal(r1.watchlistCount, 2);

    // 2. Delete Procreate via delayed Telegram inline callback (unwatch_id:1) while watchlist.json still lists Procreate
    tgQueue = [
      {
        update_id: 200,
        callback_query: {
          id: 'expired_cb',
          data: 'unwatch_id:1',
          message: {
            message_id: 77,
            chat: { id: 555 },
            reply_markup: {
              inline_keyboard: [[{ text: '🗑 Remove: Procreate', callback_data: 'unwatch_id:1' }]],
            },
          },
        },
      },
    ];
    const r2 = await runCloudSync({
      statePath,
      watchlistFile: watchlistPath,
      mode: 'quick',
      scraper: okScraper,
      fetchFn: mockFetch,
      skipPostDelay: true,
    });
    assert.equal(r2.watchlistCount, 1, 'Procreate must be deleted via Telegram');
    assert.equal(editedMarkups.length, 1, 'Inline keyboard row should be updated');
    assert.ok(
      sentMessages.some((m) => m.text.includes('Procreate') && m.text.includes('Removed')),
      'Expired callback_query in cron mode must send chat confirmation message'
    );

    // 3. Next cron run with unchanged watchlist.json MUST NOT resurrect Procreate!
    const r3 = await runCloudSync({
      statePath,
      watchlistFile: watchlistPath,
      mode: 'quick',
      scraper: okScraper,
      fetchFn: mockFetch,
      skipPostDelay: true,
    });
    assert.equal(r3.watchlistCount, 1, 'Deleted rule must NOT resurrect on subsequent cron runs');

    // 4. Editing watchlist.json to remove LumaFusion removes it from cloud state
    fs.writeFileSync(watchlistPath, JSON.stringify([]), 'utf8');
    const r4 = await runCloudSync({
      statePath,
      watchlistFile: watchlistPath,
      mode: 'quick',
      scraper: okScraper,
      fetchFn: mockFetch,
      skipPostDelay: true,
    });
    assert.equal(r4.watchlistCount, 0, 'Removing rule from watchlist.json must remove it from cloud state');

    // 5. User queues /watch Shadowrocket on Telegram, then DailyUploads fails with HTTP 503:
    //    catalog stays intact AND Shadowrocket + bot_offset are preserved!
    tgQueue = [{ update_id: 201, message: { chat: { id: 555 }, text: '/watch Shadowrocket' } }];
    const failingScraper = {
      fetchAllFiles: async () => {
        throw new Error('HTTP 503');
      },
      fetchRecentFiles: async () => {
        throw new Error('HTTP 503');
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
    const savedOnFail = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(savedOnFail.files.length, 1, 'Catalog files must stay intact on scrape error');
    assert.equal(savedOnFail.bot_offset, 202, 'Bot offset must be preserved so user is not re-spammed');
    assert.equal(savedOnFail.watchlist.length, 1, 'Pre-sync /watch must not be lost when scrape fails');
    assert.equal(savedOnFail.watchlist[0].keyword, 'Shadowrocket');
  } finally {
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CloudRadarEngine never persists secrets to storage, coalesces concurrent GitHub pushes, and detects Telegram Chat ID', async () => {
  const storageMap = new Map();
  const storage = {
    getItem: (k) => (storageMap.has(k) ? storageMap.get(k) : null),
    setItem: (k, v) => storageMap.set(k, String(v)),
    removeItem: (k) => storageMap.delete(k),
  };

  let putCalls = 0;
  let currentSha = 'sha_v1';
  let lastPutContent = null;

  const mockFetch = async (url, opts = {}) => {
    if (url.includes('/contents/watchlist.json')) {
      if (!opts.method || opts.method === 'GET') {
        await new Promise((r) => setTimeout(r, 15));
        return { ok: true, status: 200, json: async () => ({ sha: currentSha }) };
      }
      if (opts.method === 'PUT') {
        const body = JSON.parse(opts.body);
        if (body.sha !== currentSha) {
          return { ok: false, status: 409, json: async () => ({ message: '409 SHA conflict' }) };
        }
        putCalls += 1;
        currentSha = `sha_v${putCalls + 1}`;
        lastPutContent = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      }
    }
    if (url.endsWith('/getMe')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, result: { username: 'MyRadarBot' } }) };
    }
    if (url.includes('/getUpdates?')) {
      assert.ok(!url.includes('offset='), 'Chat ID detector must not consume Telegram queue offset');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          result: [{ update_id: 1, message: { chat: { id: 987654321, first_name: 'Alfa' }, text: '/start' } }],
        }),
      };
    }
    if (url.includes('discord.com/api/webhooks/')) {
      const body = JSON.parse(opts.body);
      assert.ok(Array.isArray(body.embeds));
      return { ok: true, status: 204, text: async () => '' };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const engine = new CloudRadarEngine({ storage, fetchFn: mockFetch, githubRepo: 'alfarizigan/dailyuploads-radar' });

  // 1. Secret non-persistence in localStorage
  engine.updateCloudSettings({
    github_pat: 'ghp_testpat',
    telegram_bot_token: '111:SECRET_BOT_TOK',
    webhook_url: 'https://discord.com/api/webhooks/1/secret',
  });
  const rawStored = storageMap.get('du_cloud_settings_v1');
  assert.ok(!rawStored.includes('SECRET_BOT_TOK'), 'Telegram bot token must never be persisted to localStorage');
  assert.ok(!rawStored.includes('webhooks/1/secret'), 'Webhook URL must never be persisted to localStorage');

  // 2. Concurrent rapid syncWatchlistToGithub calls coalesce cleanly without 409 conflict
  engine.addWatch({ watch_type: 'keyword', keyword: 'AppOne' });
  const p1 = engine.syncWatchlistToGithub();
  engine.addWatch({ watch_type: 'keyword', keyword: 'AppTwo' });
  const p2 = engine.syncWatchlistToGithub();
  await Promise.all([p1, p2]);
  assert.equal(lastPutContent.authoritative, true);
  assert.equal(lastPutContent.items.length, 2);

  // 3. Auto-detect Telegram Chat ID + Discord Webhook test
  const detected = await engine.detectTelegramChatId('111:SECRET_BOT_TOK');
  assert.equal(detected.botUsername, 'MyRadarBot');
  assert.deepEqual(detected.chatIds, ['987654321']);
  const whRes = await engine.sendWebhookBrowserTest('https://discord.com/api/webhooks/1/secret');
  assert.equal(whRes.ok, true);
});

test('CloudRadarEngine.fetchRemoteState bypasses CDN cache via commit SHA on forceFresh, falls back across CDNs, and waitForCloudSync polls until exported_at updates', async () => {
  const sha1 = 'a'.repeat(40);
  const sha2 = 'b'.repeat(40);
  let activeSha = sha1;
  let blockRawGithub = false;
  const requestedUrls = [];

  const stateV1 = {
    schema_version: 1,
    exported_at: '2026-11-26T20:00:00.000Z',
    sources: [{ username: 'user_hidden', last_sync_at: '2026-11-26T20:00:00.000Z' }],
    files: [[
      'f1', 'user_hidden', 'App_1.0.ipa', 'App', 'app', '1.0', 'iOS', 'ipa', [],
      null, null, '', '10 MB', 10485760, 0, 1, 0, '2026-11-26T20:00:00.000Z', '2026-11-26T20:00:00.000Z',
    ]],
    watchlist: [],
    alerts: [],
    sync_logs: [],
  };

  const stateV2 = {
    ...stateV1,
    exported_at: '2026-11-26T21:30:00.000Z',
    sources: [{ username: 'user_hidden', last_sync_at: '2026-11-26T21:30:00.000Z' }],
    files: [
      [
        'f2', 'user_hidden', 'App_2.0.ipa', 'App', 'app', '2.0', 'iOS', 'ipa', [],
        null, null, '', '12 MB', 12582912, 0, 0, 0, '2026-11-26T21:30:00.000Z', '2026-11-26T21:30:00.000Z',
      ],
      ...stateV1.files,
    ],
  };

  const mockFetch = async (url) => {
    requestedUrls.push(url);
    if (url.includes('api.github.com/repos/alfarizigan/dailyuploads-radar/commits')) {
      return { ok: true, status: 200, json: async () => [{ sha: activeSha }] };
    }
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      if (blockRawGithub) {
        return { ok: false, status: 503 };
      }
      const payload = url.includes(sha2) ? stateV2 : stateV1;
      return { ok: true, status: 200, json: async () => payload };
    }
    if (url.startsWith('https://cdn.jsdelivr.net/')) {
      const payload = url.includes(sha2) ? stateV2 : stateV1;
      return { ok: true, status: 200, json: async () => payload };
    }
    return { ok: false, status: 404 };
  };

  const engine = new CloudRadarEngine({
    fetchFn: mockFetch,
    githubRepo: 'alfarizigan/dailyuploads-radar',
  });

  // Initial load (forceFresh=false) avoids api.github.com quota and uses branch raw URL when reachable
  const r1 = await engine.fetchRemoteState({ forceFresh: false });
  assert.equal(r1.totalFiles, 1);
  assert.ok(!requestedUrls.some((u) => u.includes('api.github.com')));

  // When raw.githubusercontent.com is blocked on initial load (forceFresh=false), dynamically resolves commit SHA
  // BEFORE hitting jsDelivr so it never falls into jsDelivr's 7-day @radar-state branch cache!
  requestedUrls.length = 0;
  blockRawGithub = true;
  const rIspBlocked = await engine.fetchRemoteState({ forceFresh: false });
  assert.ok(rIspBlocked.sourceUrl.includes(`cdn.jsdelivr.net/gh/alfarizigan/dailyuploads-radar@${sha1}`));
  assert.ok(!requestedUrls.some((u) => u.includes('@radar-state/')));
  assert.ok(requestedUrls.some((u) => u.includes('api.github.com') && u.includes('_=')));

  // forceFresh=true short-circuits (unchanged=true) without re-downloading payload when SHA matches lastCommitSha
  requestedUrls.length = 0;
  const r2CachedSha = await engine.fetchRemoteState({ forceFresh: true });
  assert.equal(r2CachedSha.unchanged, true);
  assert.ok(r2CachedSha.sourceUrl.includes(`cdn.jsdelivr.net/gh/alfarizigan/dailyuploads-radar@${sha1}`));
  assert.equal(
    requestedUrls.filter((u) => u.includes('cloud-state.json')).length,
    0,
    'Must not re-download cloud-state.json when head commit SHA has not changed'
  );

  // When state was loaded without a commit SHA (e.g. loadStateObject), forceFresh=true fetches via SHA and falls back to jsDelivr
  engine.loadStateObject(stateV1);
  const r2 = await engine.fetchRemoteState({ forceFresh: true });
  assert.equal(r2.unchanged, false);
  assert.ok(r2.sourceUrl.includes(`cdn.jsdelivr.net/gh/alfarizigan/dailyuploads-radar@${sha1}`));

  // Cloud watchlist item notify_enabled update & lossless export
  const seededWithCloudWatch = {
    ...stateV1,
    watchlist: [
      {
        id: 7,
        watch_type: 'keyword',
        keyword: 'Spotify',
        display_name: 'Spotify',
        platform_filter: 'iOS',
        source_user: '',
        notes: '',
        notify_enabled: 1,
        created_at: '2026-11-26T20:00:00.000Z',
      },
    ],
  };
  engine.loadStateObject(seededWithCloudWatch);
  const updatedCloudWl = engine.updateWatch('cloud_7', { notify_enabled: false, notes: 'hold' });
  assert.equal(updatedCloudWl.notify_enabled, 0);
  assert.equal(updatedCloudWl.notes, 'hold');
  const exportedJson = JSON.parse(engine.exportWatchlistJson().content);
  assert.equal(exportedJson[0].notify_enabled, 0);
  assert.equal(exportedJson[0].notes, 'hold');

  // waitForCloudSync polls until exported_at advances to stateV2
  blockRawGithub = false;
  setTimeout(() => {
    activeSha = sha2;
  }, 40);

  let pollTicks = 0;
  const waitRes = await engine.waitForCloudSync(stateV1.exported_at, {
    timeoutMs: 1000,
    intervalMs: 25,
    onPoll: () => {
      pollTicks += 1;
    },
  });
  assert.equal(waitRes.completed, true);
  assert.ok(pollTicks >= 1);
  assert.equal(engine.state.files.length, 2);
  assert.equal(engine.state.exported_at, '2026-11-26T21:30:00.000Z');
});

test('pingCloudSync deduplicates active/recent runs, backs off on failures, falls back to workflow_dispatch, and bounds logs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-pinger-'));
  const logPath = path.join(tmpDir, 'cloud-pinger.log');
  const nowMs = Date.parse('2026-11-26T23:30:00.000Z');

  try {
    // 1. Rejects malformed repo slug
    await assert.rejects(
      () => pingCloudSync({ repo: 'bad slug/../x', token: 'tok', logPath }),
      /Invalid GitHub repository slug/
    );

    // 2. Gracefully skips when token is empty
    const noTok = await pingCloudSync({
      repo: 'alfarizigan/dailyuploads-radar',
      token: '',
      logPath,
    });
    assert.equal(noTok.ok, false);
    assert.equal(noTok.dispatched, false);
    assert.equal(noTok.reason, 'missing_token');

    // 3. Skips when a run is already queued / in_progress
    let runsPayload = [
      { id: 10, status: 'in_progress', conclusion: null, created_at: '2026-11-26T23:29:00.000Z' },
    ];
    let repoDispatchStatus = 204;
    let wfDispatchStatus = 204;
    const calls = [];

    const mockFetch = async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', body: opts.body });
      if (url.includes('/actions/workflows/radar-sync.yml/runs')) {
        return { ok: true, status: 200, json: async () => ({ workflow_runs: runsPayload }) };
      }
      if (url.endsWith('/dispatches') && !url.includes('/actions/workflows/')) {
        return {
          ok: repoDispatchStatus >= 200 && repoDispatchStatus < 300,
          status: repoDispatchStatus,
          json: async () => ({ message: `HTTP ${repoDispatchStatus}` }),
        };
      }
      if (url.includes('/actions/workflows/radar-sync.yml/dispatches')) {
        return {
          ok: wfDispatchStatus >= 200 && wfDispatchStatus < 300,
          status: wfDispatchStatus,
          json: async () => ({ message: `HTTP ${wfDispatchStatus}` }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const rActive = await pingCloudSync({
      repo: 'alfarizigan/dailyuploads-radar',
      token: 'ghp_secret_never_logged',
      nowMs,
      fetchFn: mockFetch,
      logPath,
    });
    assert.equal(rActive.dispatched, false);
    assert.equal(rActive.reason, 'already_running');

    // 4. Skips when latest successful run finished 4 minutes ago (< 13.5m threshold)
    runsPayload = [
      {
        id: 11,
        status: 'completed',
        conclusion: 'success',
        updated_at: '2026-11-26T23:26:00.000Z',
      },
    ];
    const rRecent = await pingCloudSync({
      repo: 'alfarizigan/dailyuploads-radar',
      token: 'ghp_secret_never_logged',
      nowMs,
      fetchFn: mockFetch,
      logPath,
    });
    assert.equal(rRecent.dispatched, false);
    assert.equal(rRecent.reason, 'recent_success');
    assert.equal(rRecent.ageMinutes, 4);

    // 5. Backs off when latest run failed 3 minutes ago (< 10m backoff) while previous success was 20m ago
    runsPayload = [
      {
        id: 12,
        status: 'completed',
        conclusion: 'failure',
        updated_at: '2026-11-26T23:27:00.000Z',
      },
      {
        id: 11,
        status: 'completed',
        conclusion: 'success',
        updated_at: '2026-11-26T23:10:00.000Z',
      },
    ];
    const rBackoff = await pingCloudSync({
      repo: 'alfarizigan/dailyuploads-radar',
      token: 'ghp_secret_never_logged',
      nowMs,
      fetchFn: mockFetch,
      logPath,
    });
    assert.equal(rBackoff.dispatched, false);
    assert.equal(rBackoff.reason, 'recent_failure_backoff');

    // 5b. Does NOT back off when latest run was 'skipped' or 'neutral' (not an actual failure)
    runsPayload = [
      {
        id: 13,
        status: 'completed',
        conclusion: 'skipped',
        updated_at: '2026-11-26T23:28:00.000Z',
      },
      {
        id: 11,
        status: 'completed',
        conclusion: 'success',
        updated_at: '2026-11-26T23:10:00.000Z',
      },
    ];
    const rSkipped = await pingCloudSync({
      repo: 'alfarizigan/dailyuploads-radar',
      token: 'ghp_secret_never_logged',
      nowMs,
      fetchFn: mockFetch,
      logPath,
    });
    assert.equal(rSkipped.dispatched, true);

    // 6. Dispatches repository_dispatch when last success was 16m ago (>= 13.5m)
    runsPayload = [
      {
        id: 11,
        status: 'completed',
        conclusion: 'success',
        updated_at: '2026-11-26T23:14:00.000Z',
      },
    ];
    const rDisp = await pingCloudSync({
      repo: 'alfarizigan/dailyuploads-radar',
      token: 'ghp_secret_never_logged',
      nowMs,
      fetchFn: mockFetch,
      logPath,
    });
    assert.equal(rDisp.ok, true);
    assert.equal(rDisp.dispatched, true);
    assert.equal(rDisp.method, 'repository_dispatch');

    // 7. Automatically falls back to workflow_dispatch if repository_dispatch returns 403 (e.g. Actions-only fine-grained PAT)
    repoDispatchStatus = 403;
    wfDispatchStatus = 204;
    const rFallback = await pingCloudSync({
      repo: 'alfarizigan/dailyuploads-radar',
      token: 'ghp_secret_never_logged',
      force: true,
      nowMs,
      fetchFn: mockFetch,
      logPath,
    });
    assert.equal(rFallback.ok, true);
    assert.equal(rFallback.dispatched, true);
    assert.equal(rFallback.method, 'workflow_dispatch');

    // 8. Throws on 401 Bad credentials
    repoDispatchStatus = 401;
    await assert.rejects(
      () =>
        pingCloudSync({
          repo: 'alfarizigan/dailyuploads-radar',
          token: 'ghp_secret_never_logged',
          force: true,
          nowMs,
          fetchFn: mockFetch,
          logPath,
        }),
      /GitHub repository_dispatch failed/
    );

    // 8b. Fails fast on 401 during preflight workflow runs check and logs network errors with token redaction
    let preflightCalls = 0;
    await assert.rejects(
      () =>
        pingCloudSync({
          repo: 'alfarizigan/dailyuploads-radar',
          token: 'ghp_secret_never_logged',
          force: false,
          nowMs,
          fetchFn: async () => {
            preflightCalls += 1;
            return { ok: false, status: 401, json: async () => ({ message: 'Bad credentials' }) };
          },
          logPath,
        }),
      /GitHub authentication failed: Bad credentials/
    );
    assert.equal(preflightCalls, 1, 'Should fail fast on 401 without attempting POST /dispatches');

    await assert.rejects(
      () =>
        pingCloudSync({
          repo: 'alfarizigan/dailyuploads-radar',
          token: 'ghp_secret_never_logged',
          force: true,
          nowMs,
          fetchFn: async () => {
            throw new Error('DNS timeout with header ghp_secret_never_logged');
          },
          logPath,
        }),
      /DNS timeout/
    );
    const netErrLog = fs.readFileSync(logPath, 'utf8');
    assert.ok(netErrLog.includes('ERROR network: DNS timeout with header [REDACTED]'));
    assert.ok(!netErrLog.includes('ghp_secret_never_logged'));

    // 9. Bounded log rotation <= 200 lines & zero token leakage
    for (let i = 0; i < 250; i += 1) {
      appendBoundedLog(logPath, `entry ${i}`);
    }
    const rawLog = fs.readFileSync(logPath, 'utf8');
    const lines = rawLog.trim().split(/\r?\n/);
    assert.equal(lines.length, 200);
    assert.ok(!rawLog.includes('ghp_secret_never_logged'), 'Log must never contain auth token');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
