'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RadarDB } = require('../src/db');
const { parseFilename, parseSizeToBytes, buildDownloadUrl } = require('../src/parser');

function makeFile(code, rawFilename, { size = '50.0 MB', days = 1, downloads = 3, source = 'user_hidden' } = {}) {
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

test('RadarDB search, FTS5 special chars, filters, sorting, and grouping', () => {
  const db = new RadarDB(':memory:');
  try {
    const sample = [
      makeFile('c1', 'Spotify-Shrubify_(v9.2.2_Univ_64bit_os161)-user_hidden.bfi2.ipa', { size: '173.9 MB', days: 0, downloads: 15 }),
      makeFile('c2', 'AIOStreams_0.8.1.ipa', { size: '18.0 MB', days: 1, downloads: 8 }),
      makeFile('c3', 'AIOStreams_0.7.18.ipa', { size: '17.2 MB', days: 4, downloads: 20 }),
      makeFile('c4', 'Really_Bad_Chess+_(v1.7.2_FW_64bit_os150)-user_hidden.bfi.ipa', { size: '42.7 MB', days: 10, downloads: 5 }),
      makeFile('c5', 'Things_3_3.25_[TNT].dmg', { size: '25.0 MB', days: 2, downloads: 30 }),
      makeFile('c6', 'Big_Game_(v1.0_64bit_os180)-user_hidden.bfi2.ipa', { size: '1.5 GB', days: 3, downloads: 2 }),
    ];

    const res = db.saveSyncResult('user_hidden', sample, { mode: 'full', totalReported: sample.length });
    assert.equal(res.isBaseline, true);
    assert.equal(res.newFiles.length, 6);

    // Flat vs Grouped
    const flat = db.searchFiles({ grouped: false });
    assert.equal(flat.total, 6);

    const grouped = db.searchFiles({ grouped: true });
    assert.equal(grouped.total, 5); // AIOStreams collapsed from 2 -> 1
    const aio = grouped.items.find((i) => i.app_slug === 'aiostreams');
    assert.equal(aio.version, '0.8.1');
    assert.equal(aio.version_count, 2);
    assert.equal(aio.total_downloads, 28);

    // FTS prefix search
    const spot = db.searchFiles({ q: 'spot' });
    assert.equal(spot.total, 1);
    assert.equal(spot.items[0].file_code, 'c1');

    // Special punctuation safety (should never throw FTS5 syntax error!)
    const plusSearch = db.searchFiles({ q: 'Chess+' });
    assert.equal(plusSearch.total, 1);
    assert.equal(plusSearch.items[0].file_code, 'c4');

    const weirdSearch = db.searchFiles({ q: '""" () -OR* :' });
    assert.equal(weirdSearch.total, 0);

    // Platform filter
    const mac = db.searchFiles({ platform: 'macOS' });
    assert.equal(mac.total, 1);
    assert.equal(mac.items[0].file_code, 'c5');

    // Min iOS filter
    const ios16 = db.searchFiles({ maxIos: '16.5' });
    assert.equal(ios16.total, 2); // c1 (16.1) + c4 (15.0)

    // Size filter (> 100 MB)
    const big = db.searchFiles({ minSizeMb: '100', sort: 'size_desc' });
    assert.equal(big.total, 2);
    assert.equal(big.items[0].file_code, 'c6');

    // Sort by downloads
    const dlSorted = db.searchFiles({ sort: 'downloads', grouped: false });
    assert.equal(dlSorted.items[0].file_code, 'c5'); // 30 downloads

    // App versions history
    const versions = db.getAppVersions('aiostreams');
    assert.equal(versions.length, 2);
    assert.equal(versions[0].version, '0.8.1');
    assert.equal(versions[1].version, '0.7.18');
  } finally {
    db.close();
  }
});

test('RadarDB watchlist matching, alert dedup, and import/export', () => {
  const db = new RadarDB(':memory:');
  try {
    db.saveSyncResult(
      'user_hidden',
      [makeFile('old1', 'AIOStreams_0.8.1.ipa', { days: 2 })],
      { mode: 'full', totalReported: 1 }
    );

    const w1 = db.addWatch({ watch_type: 'app', target_slug: 'aiostreams' });
    assert.equal(w1.created, true);
    assert.equal(w1.item.last_known_version, '0.8.1');

    // Duplicate watch returns created: false
    const w1Dup = db.addWatch({ watch_type: 'app', target_slug: 'aiostreams' });
    assert.equal(w1Dup.created, false);

    // Keyword watch with platform filter
    const w2 = db.addWatch({
      watch_type: 'keyword',
      keyword: 'spotify',
      platform_filter: 'iOS',
    });
    assert.equal(w2.created, true);

    // Simulate newly discovered uploads
    const newFiles = [
      makeFile('new1', 'AIOStreams_0.9.0.ipa', { days: 0 }),
      makeFile('new2', 'Spotify_1.2.0_[TNT].dmg', { days: 0 }), // macOS -> should NOT match iOS filter
      makeFile('new3', 'Spotify-Shrubify_(v9.3.0_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 0 }),
    ];

    const alerts = db.matchWatchlistForNewFiles(newFiles);
    assert.equal(alerts.length, 2);
    const aioAlert = alerts.find((a) => a.app_slug === 'aiostreams');
    assert.equal(aioAlert.old_version, '0.8.1');
    assert.equal(aioAlert.new_version, '0.9.0');

    // Running match again with same files must NOT create duplicate alerts
    const dupAlerts = db.matchWatchlistForNewFiles(newFiles);
    assert.equal(dupAlerts.length, 0);

    // Read / unread tracking
    const list1 = db.listAlerts();
    assert.equal(list1.unread_count, 2);
    db.markAlertRead(aioAlert.id);
    assert.equal(db.listAlerts().unread_count, 1);
    db.markAllAlertsRead();
    assert.equal(db.listAlerts().unread_count, 0);

    // Watchlist import
    const imp = db.importWatchlist([
      { watch_type: 'keyword', keyword: 'Procreate', platform_filter: 'iOS' },
      { watch_type: 'keyword', keyword: 'spotify', platform_filter: 'iOS' }, // duplicate -> skipped
    ]);
    assert.equal(imp.added, 1);
    assert.equal(imp.skipped, 1);
  } finally {
    db.close();
  }
});

test('RadarDB multi-version chronological alerts, stale age adjustment, platform-scoped app watch, and empty full-sync guard', () => {
  const db = new RadarDB(':memory:');
  try {
    db.saveSyncResult(
      'user_hidden',
      [
        makeFile('s1', 'Spotify-Shrubify_(v9.2.1_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 0 }),
        makeFile('m1', 'Spotify-Shrubify_9.1.0_[TNT].dmg', { days: 2 }),
      ],
      { mode: 'full', totalReported: 2 }
    );

    // Platform-scoped app watch picks macOS build, not iOS build
    const macWatch = db.addWatch({
      watch_type: 'app',
      target_slug: 'spotify-shrubify',
      platform_filter: 'macOS',
    });
    assert.equal(macWatch.item.last_known_version, '9.1.0');
    const listedMac = db.listWatchlist().find((w) => w.id === macWatch.item.id);
    assert.equal(listedMac.latest_file.platform, 'macOS');
    assert.equal(listedMac.latest_file.version, '9.1.0');

    // Watch iOS build and feed TWO newer versions newest-first (as returned by DailyUploads)
    const iosWatch = db.addWatch({
      watch_type: 'app',
      target_slug: 'spotify-shrubify',
      platform_filter: 'iOS',
    });
    assert.equal(iosWatch.item.last_known_version, '9.2.1');

    const alerts = db.matchWatchlistForNewFiles([
      makeFile('s3', 'Spotify-Shrubify_(v9.2.3_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 0 }),
      makeFile('s2', 'Spotify-Shrubify_(v9.2.2_Univ_64bit_os161)-user_hidden.bfi2.ipa', { days: 0 }),
    ]);
    assert.equal(alerts.length, 2);
    assert.equal(alerts[0].old_version, '9.2.1');
    assert.equal(alerts[0].new_version, '9.2.2');
    assert.equal(alerts[1].old_version, '9.2.2');
    assert.equal(alerts[1].new_version, '9.2.3');

    // Simulate s1 last_seen_at being 5 days ago -> effective uploaded_days_ago should advance to 5
    const fiveDaysAgo = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString();
    db.db.prepare("UPDATE files SET last_seen_at = ? WHERE file_code = 's1'").run(fiveDaysAgo);
    const todayOnly = db.searchFiles({ maxDays: '0', grouped: false });
    assert.equal(todayOnly.total, 0);
    const allRes = db.searchFiles({ grouped: false, sort: 'newest' });
    const s1Row = allRes.items.find((i) => i.file_code === 's1');
    assert.ok(s1Row.uploaded_days_ago >= 5);

    // Defensive guard: empty full sync when totalReported > 0 must NOT wipe existing catalog
    const guardRes = db.saveSyncResult('user_hidden', [], { mode: 'full', totalReported: 2 });
    assert.equal(guardRes.deactivatedCount, 0);
    assert.equal(db.searchFiles({ grouped: false }).total, 2);
  } finally {
    db.close();
  }
});
