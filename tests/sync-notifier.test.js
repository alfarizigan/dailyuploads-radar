'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RadarDB } = require('../src/db');
const { Notifier } = require('../src/notifier');
const { SyncManager } = require('../src/sync-manager');
const { TelegramBotRunner } = require('../src/telegram');
const { parseFilename, parseSizeToBytes, buildDownloadUrl } = require('../src/parser');

function makeFile(code, rawFilename, days = 0) {
  const meta = parseFilename(rawFilename);
  return {
    file_code: code,
    source_user: 'user_hidden',
    download_url: buildDownloadUrl(code, rawFilename),
    size_text: '100.0 MB',
    size_bytes: parseSizeToBytes('100.0 MB'),
    uploaded_days_ago: days,
    downloads: 1,
    ...meta,
  };
}

test('SyncManager baseline sync does not alert, subsequent quick sync alerts via SSE, Telegram & Discord webhook', async () => {
  const db = new RadarDB(':memory:');
  try {
    const httpCalls = [];
    const mockFetch = async (url, opts) => {
      httpCalls.push({ url, body: JSON.parse(opts.body) });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, result: {} }),
        text: async () => 'ok',
      };
    };

    const sseEvents = [];
    const notifier = new Notifier(db, { fetchFn: mockFetch, enableOsToast: false });
    notifier.addSseClient({ write: (chunk) => sseEvents.push(chunk) });

    db.updateSettings({
      telegram_bot_token: '123:TESTTOKEN',
      telegram_chat_id: '99999, 88888',
      webhook_url: 'https://discord.com/api/webhooks/12345/abcdef',
      windows_toast_enabled: false,
    });

    const initialBatch = [
      makeFile('f1', 'Spotify-Shrubify_(v9.2.1_Univ_64bit_os161)-user_hidden.bfi2.ipa', 1),
      makeFile('f2', 'AIOStreams_0.8.0.ipa', 2),
    ];

    let nextQuickBatch = [];
    const mockScraper = {
      fetchAllFiles: async () => ({ items: initialBatch, totalReported: initialBatch.length, pagesFetched: 1 }),
      fetchRecentFiles: async () => ({ items: nextQuickBatch, totalReported: 3, pagesFetched: 1 }),
    };

    const syncManager = new SyncManager({ db, scraper: mockScraper, notifier });

    // Pre-add watch BEFORE baseline sync: baseline must NOT spam alert
    db.addWatch({ watch_type: 'app', target_slug: 'spotify-shrubify', display_name: 'Spotify-Shrubify' });

    const r1 = await syncManager.syncSource('user_hidden', { mode: 'auto' });
    assert.equal(r1.mode, 'full');
    assert.equal(r1.isBaseline, true);
    assert.equal(r1.alertsTriggered, 0);
    assert.equal(httpCalls.length, 0);

    // Update watch's known version as if watched after baseline
    db.removeWatchBySlug('spotify-shrubify');
    db.addWatch({ watch_type: 'app', target_slug: 'spotify-shrubify' });

    // Now simulate a new version appearing at top of DailyUploads!
    nextQuickBatch = [
      makeFile('f3', 'Spotify-Shrubify_(v9.2.2_Univ_64bit_os161)-user_hidden.bfi2.ipa', 0),
      ...initialBatch,
    ];

    const r2 = await syncManager.syncSource('user_hidden', { mode: 'quick' });
    assert.equal(r2.isBaseline, false);
    assert.equal(r2.newFilesCount, 1);
    assert.equal(r2.alertsTriggered, 1);

    // Verify newest item is ranked first (list_order 0)
    const search = db.searchFiles({ sort: 'newest', grouped: false });
    assert.equal(search.items[0].file_code, 'f3');

    // Verify SSE emitted alerts + sync_complete
    assert.ok(sseEvents.some((e) => e.includes('event: alerts')));
    assert.ok(sseEvents.some((e) => e.includes('event: sync_complete')));

    // Verify Telegram (multi-chat-ID) & Discord webhook calls
    const tgCalls = httpCalls.filter((c) => c.url.includes('api.telegram.org'));
    const discordCall = httpCalls.find((c) => c.url.includes('discord.com'));
    assert.equal(tgCalls.length, 2, 'Expected Telegram notification sent to both comma-separated chat IDs');
    assert.deepEqual(
      tgCalls.map((c) => c.body.chat_id),
      ['99999', '88888']
    );
    assert.ok(tgCalls[0].body.text.includes('v9.2.1 → v9.2.2'));

    // Verify sendTest supports unsaved credential overrides
    await notifier.sendTest('telegram', { telegram_bot_token: 'OVR:TOK', telegram_chat_id: '77777' });
    const overrideCall = httpCalls[httpCalls.length - 1];
    assert.ok(overrideCall.url.includes('OVR%3ATOK'));
    assert.equal(overrideCall.body.chat_id, '77777');

    assert.ok(discordCall, 'Expected Discord webhook call');
    assert.equal(discordCall.body.embeds.length, 1);
    assert.ok(discordCall.body.embeds[0].title.includes('v9.2.1 → v9.2.2'));

    // Re-running quick sync with same data triggers 0 new files and 0 alerts
    const r3 = await syncManager.syncSource('user_hidden', { mode: 'quick' });
    assert.equal(r3.newFilesCount, 0);
    assert.equal(r3.alertsTriggered, 0);
  } finally {
    db.close();
  }
});

test('TelegramBotRunner handles /search, /watch, /watchlist, and inline watch callback (including long slugs)', async () => {
  const db = new RadarDB(':memory:');
  try {
    db.saveSyncResult(
      'user_hidden',
      [
        makeFile('f1', 'LumaFusion_(v5.6.2_PI_FW_64bit_os270)-user_hidden.bfi3.ipa', 0),
        makeFile(
          'f2long',
          'NightShot_Pro_Night_Shoot_Artifact_with_Video_Noise_Reduction_(v3.1_Univ_64bit_os160)-user_hidden.bfi2.ipa',
          0
        ),
      ],
      { mode: 'full', totalReported: 2 }
    );

    const sent = [];
    const mockFetch = async (url, opts) => {
      sent.push({ method: url.split('/').pop(), body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ ok: true, result: {} }) };
    };

    const bot = new TelegramBotRunner({ db, syncManager: null, fetchFn: mockFetch });

    // Search and watch app with long slug (>48 chars) via compact watch_fc callback
    await bot.handleUpdate('TOK', { message: { chat: { id: 42 }, text: 'NightShot' } });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].method, 'sendMessage');
    const cbData = sent[0].body.reply_markup.inline_keyboard[0][0].callback_data;
    assert.equal(cbData, 'watch_fc:f2long');
    assert.ok(Buffer.byteLength(cbData) <= 64);

    await bot.handleUpdate('TOK', {
      callback_query: { id: 'cb1', message: { chat: { id: 42 } }, data: cbData },
    });
    assert.equal(db.listWatchlist().length, 1);
    assert.equal(
      db.listWatchlist()[0].target_slug,
      'nightshot-pro-night-shoot-artifact-with-video-noise-reduction'
    );

    // /watch without args returns usage hint instead of silently doing nothing
    await bot.handleUpdate('TOK', { message: { chat: { id: 42 }, text: '/watch' } });
    assert.ok(sent[sent.length - 1].body.text.includes('/watch Spotify'));

    // /watch@MyBotName Spotify adds keyword watch
    await bot.handleUpdate('TOK', { message: { chat: { id: 42 }, text: '/watch@RadarBot Spotify' } });
    assert.ok(db.listWatchlist().some((w) => w.watch_type === 'keyword' && w.keyword === 'Spotify'));
  } finally {
    db.close();
  }
});
