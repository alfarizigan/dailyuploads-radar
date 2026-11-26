'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startServer } = require('../src/server');
const { parseFilename, parseSizeToBytes, buildDownloadUrl } = require('../src/parser');

function makeFile(code, rawFilename, days = 0) {
  const meta = parseFilename(rawFilename);
  return {
    file_code: code,
    source_user: 'user_hidden',
    download_url: buildDownloadUrl(code, rawFilename),
    size_text: '64.0 MB',
    size_bytes: parseSizeToBytes('64.0 MB'),
    uploaded_days_ago: days,
    downloads: 9,
    ...meta,
  };
}

test('HTTP API end-to-end integration test', async () => {
  const mockScraper = {
    fetchAllFiles: async () => ({
      items: [
        makeFile('k1', 'Shadowrocket_(v2.2.92_Univ_PI_64bit_os130)-user_hidden.bfi2.ipa', 0),
        makeFile('k2', '=SUM(A1:A2)_formula_test_1.0.zip', 1),
      ],
      totalReported: 2,
      pagesFetched: 1,
    }),
    fetchRecentFiles: async () => ({ items: [], totalReported: 2, pagesFetched: 1 }),
  };

  const app = await startServer({
    dbPath: ':memory:',
    host: '127.0.0.1',
    port: 0,
    autoSyncOnStart: false,
    enableOsToast: false,
    scraper: mockScraper,
  });

  try {
    // 1. Health
    const health = await fetch(`${app.url}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    // 2. Trigger synchronous full sync via API
    const syncRes = await fetch(`${app.url}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'full', source: 'user_hidden' }),
    }).then((r) => r.json());
    assert.equal(syncRes.ok, true);
    assert.equal(syncRes.result.totalFetched, 2);

    // 3. Search files
    const filesRes = await fetch(`${app.url}/api/files?q=shadow`).then((r) => r.json());
    assert.equal(filesRes.total, 1);
    assert.equal(filesRes.items[0].app_name, 'Shadowrocket');

    // 4. Watchlist POST, GET, PATCH, DELETE
    const addW = await fetch(`${app.url}/api/watchlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watch_type: 'app', target_slug: 'shadowrocket' }),
    });
    assert.equal(addW.status, 201);
    const added = await addW.json();
    assert.equal(added.item.target_slug, 'shadowrocket');

    const patchW = await fetch(`${app.url}/api/watchlist/${added.item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notify_enabled: false, notes: 'wait for 2.3' }),
    }).then((r) => r.json());
    assert.equal(patchW.item.notify_enabled, 0);
    assert.equal(patchW.item.notes, 'wait for 2.3');

    const exportedWl = await fetch(`${app.url}/api/watchlist/export`).then((r) => r.json());
    assert.equal(exportedWl[0].notify_enabled, 0);

    // 5. CSV export escapes formula-leading cells
    const csvText = await fetch(`${app.url}/api/export?format=csv`).then((r) => r.text());
    assert.ok(csvText.includes("'=SUM(A1:A2)"));

    // 6. Add source via full DailyUploads URL
    const srcAdd = await fetch(`${app.url}/api/sources`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://dailyuploads.net/users/another_user' }),
    });
    assert.equal(srcAdd.status, 201);
    const srcData = await srcAdd.json();
    assert.equal(srcData.source.username, 'another_user');

    // 7. Static HTML, SVG icon & PWA manifest served properly, and all app.js DOM IDs exist in index.html
    const htmlRes = await fetch(`${app.url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes('DailyUploads Radar'));
    assert.ok(html.includes('<html lang="en"'));

    const iconRes = await fetch(`${app.url}/icon.svg`);
    assert.equal(iconRes.status, 200);
    assert.ok((iconRes.headers.get('content-type') || '').includes('image/svg+xml'));

    const manifestRes = await fetch(`${app.url}/manifest.webmanifest`);
    assert.equal(manifestRes.status, 200);
    assert.ok((manifestRes.headers.get('content-type') || '').includes('application/manifest+json'));

    const appJsRes = await fetch(`${app.url}/app.js`);
    const appJs = await appJsRes.text();
    const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
    const jsIds = new Set([...appJs.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
    const missingIds = [...jsIds].filter((id) => !htmlIds.has(id));
    assert.deepEqual(missingIds, [], 'Every DOM ID referenced in public/app.js must exist in public/index.html');

    // 8. Path traversal check (cannot read package.json outside public/)
    const travRes = await fetch(`${app.url}/..%2Fpackage.json`);
    const travText = await travRes.text();
    assert.ok(!travText.includes('"dailyuploads-radar"'), 'Should not leak files outside public/');

    // 9. Malformed URL encoding returns 400 (not 500)
    const badUri = await fetch(`${app.url}/%E0%A4%A`);
    assert.equal(badUri.status, 400);

    // 10. Export CSV returns >200 rows (does not silently truncate at 200)
    const bulkFiles = [];
    for (let i = 1; i <= 250; i += 1) {
      bulkFiles.push(makeFile(`bulk${i}`, `TestApp_${i}_(v1.0.${i}_Univ_64bit_os150)-user_hidden.bfi2.ipa`, 0));
    }
    app.db.saveSyncResult('user_hidden', bulkFiles, { mode: 'full', totalReported: bulkFiles.length });
    const bulkCsv = await fetch(`${app.url}/api/export?format=csv&grouped=false`).then((r) => r.text());
    const dataRows = bulkCsv.trim().split('\r\n').length - 1;
    assert.equal(dataRows, 250);
  } finally {
    await app.shutdown();
  }
});
