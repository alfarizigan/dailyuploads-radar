'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const { config } = require('./config');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function readJsonBody(req, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function csvCell(val) {
  let str = String(val ?? '');
  // Mitigate spreadsheet formula injection
  if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function extractUsernameFromInput(input) {
  const raw = String(input || '').trim();
  const urlMatch = raw.match(/dailyuploads\.net\/users\/([a-zA-Z0-9._-]+)/i);
  if (urlMatch) return urlMatch[1];
  return raw.replace(/^@/, '').replace(/\/+$/, '');
}

function createAppServer({ db, syncManager, notifier, telegramBot, publicDir = config.publicDir }) {
  const server = http.createServer(async (req, res) => {
    try {
      const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let pathname;
      try {
        pathname = decodeURIComponent(urlObj.pathname);
      } catch {
        sendJson(res, 400, { error: 'Invalid URL encoding' });
        return;
      }
      const method = req.method.toUpperCase();

      // SSE Stream
      if (method === 'GET' && pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        res.write(`event: connected\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`);
        notifier.addSseClient(res);
        const hb = setInterval(() => {
          try {
            res.write(': heartbeat\n\n');
          } catch {
            clearInterval(hb);
          }
        }, 25000);
        if (hb.unref) hb.unref();
        req.on('close', () => {
          clearInterval(hb);
          notifier.removeSseClient(res);
        });
        return;
      }

      // API Routes
      if (pathname.startsWith('/api/')) {
        await handleApi(req, res, method, pathname, urlObj.searchParams, {
          db,
          syncManager,
          notifier,
          telegramBot,
        });
        return;
      }

      // Static files
      if (method === 'GET' || method === 'HEAD') {
        serveStatic(res, pathname, publicDir, method === 'HEAD');
        return;
      }

      sendJson(res, 405, { error: 'Method Not Allowed' });
    } catch (err) {
      const status = err.statusCode || 500;
      sendJson(res, status, { error: err.message || 'Internal Server Error' });
    }
  });

  return server;
}

async function handleApi(req, res, method, pathname, qs, { db, syncManager, notifier, telegramBot }) {
  if (method === 'GET' && pathname === '/api/health') {
    return sendJson(res, 200, { ok: true, name: 'dailyuploads-radar', version: '1.0.0' });
  }

  if (method === 'GET' && pathname === '/api/stats') {
    return sendJson(res, 200, {
      ...db.getStats(),
      sync: syncManager.getStatus(),
      telegram: telegramBot ? telegramBot.getStatus() : { running: false },
    });
  }

  if (method === 'GET' && pathname === '/api/facets') {
    const source = qs.get('source') || 'all';
    return sendJson(res, 200, db.getFacets(source));
  }

  if (method === 'GET' && pathname === '/api/files') {
    const result = db.searchFiles({
      q: qs.get('q') || '',
      source: qs.get('source') || 'all',
      platform: qs.get('platform') || 'all',
      extension: qs.get('extension') || 'all',
      tag: qs.get('tag') || 'all',
      releaseGroup: qs.get('releaseGroup') || 'all',
      maxIos: qs.get('maxIos') ?? '',
      maxDays: qs.get('maxDays') ?? '',
      minSizeMb: qs.get('minSizeMb') ?? '',
      maxSizeMb: qs.get('maxSizeMb') ?? '',
      watchedOnly: qs.get('watchedOnly') || '',
      grouped: qs.get('grouped') || '',
      sort: qs.get('sort') || 'newest',
      page: qs.get('page') || 1,
      limit: qs.get('limit') || 40,
    });
    return sendJson(res, 200, result);
  }

  if (method === 'GET' && pathname === '/api/export') {
    const format = (qs.get('format') || 'csv').toLowerCase();
    const result = db.searchFiles({
      q: qs.get('q') || '',
      source: qs.get('source') || 'all',
      platform: qs.get('platform') || 'all',
      extension: qs.get('extension') || 'all',
      tag: qs.get('tag') || 'all',
      releaseGroup: qs.get('releaseGroup') || 'all',
      maxIos: qs.get('maxIos') ?? '',
      maxDays: qs.get('maxDays') ?? '',
      minSizeMb: qs.get('minSizeMb') ?? '',
      maxSizeMb: qs.get('maxSizeMb') ?? '',
      watchedOnly: qs.get('watchedOnly') || '',
      grouped: qs.get('grouped') || '',
      sort: qs.get('sort') || 'newest',
      page: 1,
      limit: 5000,
      maxLimit: 10000,
    });

    if (format === 'json') {
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="dailyuploads-export.json"',
      });
      res.end(JSON.stringify(result.items, null, 2));
      return;
    }

    const headers = [
      'App Name',
      'Version',
      'Platform',
      'Extension',
      'Size',
      'Min iOS',
      'Days Ago',
      'Downloads',
      'Tags',
      'Filename',
      'Download URL',
    ];
    const lines = [headers.join(',')];
    for (const it of result.items) {
      lines.push(
        [
          csvCell(it.app_name),
          csvCell(it.version),
          csvCell(it.platform),
          csvCell(it.extension),
          csvCell(it.size_text),
          csvCell(it.min_ios_label || ''),
          csvCell(it.uploaded_days_ago ?? ''),
          csvCell(it.downloads),
          csvCell((it.tags || []).join('; ')),
          csvCell(it.raw_filename),
          csvCell(it.download_url),
        ].join(',')
      );
    }
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="dailyuploads-export.csv"',
    });
    res.end(lines.join('\r\n'));
    return;
  }

  const appVersionsMatch = pathname.match(/^\/api\/apps\/([^/]+)\/versions$/);
  if (method === 'GET' && appVersionsMatch) {
    const slug = appVersionsMatch[1];
    const source = qs.get('source') || '';
    const versions = db.getAppVersions(slug, source);
    return sendJson(res, 200, { slug, versions });
  }

  /* ── Watchlist ────────────────────────────────────────── */

  if (method === 'GET' && pathname === '/api/watchlist') {
    return sendJson(res, 200, { items: db.listWatchlist() });
  }

  if (method === 'GET' && pathname === '/api/watchlist/export') {
    const list = db.listWatchlist().map((w) => ({
      watch_type: w.watch_type,
      target_slug: w.target_slug,
      keyword: w.keyword,
      display_name: w.display_name,
      platform_filter: w.platform_filter,
      source_user: w.source_user,
      notes: w.notes,
    }));
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="dailyuploads-watchlist.json"',
    });
    res.end(JSON.stringify(list, null, 2));
    return;
  }

  if (method === 'POST' && pathname === '/api/watchlist/import') {
    const body = await readJsonBody(req);
    const items = Array.isArray(body) ? body : body.items;
    try {
      const summary = db.importWatchlist(items);
      return sendJson(res, 200, { ok: true, ...summary });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (method === 'POST' && pathname === '/api/watchlist') {
    const body = await readJsonBody(req);
    try {
      const resAdd = db.addWatch(body);
      return sendJson(res, resAdd.created ? 201 : 200, resAdd);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  const watchBySlugMatch = pathname.match(/^\/api\/watchlist\/by-slug\/([^/]+)$/);
  if (method === 'DELETE' && watchBySlugMatch) {
    const removed = db.removeWatchBySlug(watchBySlugMatch[1]);
    return sendJson(res, 200, { ok: true, removed });
  }

  const watchIdMatch = pathname.match(/^\/api\/watchlist\/(\d+)$/);
  if (watchIdMatch) {
    const id = Number.parseInt(watchIdMatch[1], 10);
    if (method === 'PATCH') {
      const body = await readJsonBody(req);
      const updated = db.updateWatch(id, body);
      if (!updated) return sendJson(res, 404, { error: 'Watch item not found' });
      return sendJson(res, 200, { item: updated });
    }
    if (method === 'DELETE') {
      const removed = db.removeWatch(id);
      if (!removed) return sendJson(res, 404, { error: 'Watch item not found' });
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ── Alerts ───────────────────────────────────────────── */

  if (method === 'GET' && pathname === '/api/alerts') {
    const unreadOnly = qs.get('unreadOnly') === 'true' || qs.get('unreadOnly') === '1';
    const limit = qs.get('limit') || 50;
    return sendJson(res, 200, db.listAlerts({ unreadOnly, limit }));
  }

  if (method === 'POST' && pathname === '/api/alerts/read-all') {
    const count = db.markAllAlertsRead();
    return sendJson(res, 200, { ok: true, marked: count });
  }

  const alertReadMatch = pathname.match(/^\/api\/alerts\/(\d+)\/read$/);
  if (method === 'POST' && alertReadMatch) {
    const id = Number.parseInt(alertReadMatch[1], 10);
    const ok = db.markAlertRead(id);
    return sendJson(res, ok ? 200 : 404, { ok });
  }

  if (method === 'DELETE' && pathname === '/api/alerts') {
    db.clearAlerts();
    return sendJson(res, 200, { ok: true });
  }

  /* ── Sync ─────────────────────────────────────────────── */

  if (method === 'GET' && pathname === '/api/sync/status') {
    return sendJson(res, 200, syncManager.getStatus());
  }

  if (method === 'POST' && pathname === '/api/sync') {
    const body = await readJsonBody(req);
    const mode = ['full', 'quick', 'auto'].includes(body.mode) ? body.mode : 'auto';
    const asyncMode = body.async === true;
    const source = body.source ? extractUsernameFromInput(body.source) : '';

    if (asyncMode) {
      const promise = source
        ? syncManager.syncSource(source, { mode })
        : syncManager.syncAllSources({ mode });
      promise.catch((err) => console.error('[Sync] Background error:', err.message));
      return sendJson(res, 202, { accepted: true, mode, source: source || 'all' });
    }

    try {
      const result = source
        ? await syncManager.syncSource(source, { mode })
        : await syncManager.syncAllSources({ mode });
      return sendJson(res, 200, { ok: true, result });
    } catch (err) {
      return sendJson(res, 502, { ok: false, error: err.message });
    }
  }

  /* ── Sources ──────────────────────────────────────────── */

  if (method === 'GET' && pathname === '/api/sources') {
    return sendJson(res, 200, { sources: db.listSources() });
  }

  if (method === 'POST' && pathname === '/api/sources') {
    const body = await readJsonBody(req);
    const username = extractUsernameFromInput(body.username || body.url);
    try {
      const source = db.addSource(username, body.label || '');
      return sendJson(res, 201, { source });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  const sourceDelMatch = pathname.match(/^\/api\/sources\/([^/]+)$/);
  if (method === 'DELETE' && sourceDelMatch) {
    try {
      db.removeSource(sourceDelMatch[1]);
      return sendJson(res, 200, { ok: true });
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  /* ── Settings & Notification Test ─────────────────────── */

  if (method === 'GET' && pathname === '/api/settings') {
    return sendJson(res, 200, {
      settings: db.getSettings(),
      telegram: telegramBot ? telegramBot.getStatus() : { running: false },
    });
  }

  if (method === 'PUT' && pathname === '/api/settings') {
    const body = await readJsonBody(req);
    const updated = db.updateSettings(body);
    syncManager.startScheduler();
    if (telegramBot) {
      await telegramBot.reconfigure().catch(() => {});
    }
    return sendJson(res, 200, {
      settings: updated,
      telegram: telegramBot ? telegramBot.getStatus() : { running: false },
    });
  }

  if (method === 'POST' && pathname === '/api/notifications/test') {
    const body = await readJsonBody(req);
    try {
      const resTest = await notifier.sendTest(body.channel, {
        telegram_bot_token: body.telegram_bot_token,
        telegram_chat_id: body.telegram_chat_id,
        webhook_url: body.webhook_url,
      });
      return sendJson(res, 200, resTest);
    } catch (err) {
      return sendJson(res, 400, { ok: false, error: err.message });
    }
  }

  return sendJson(res, 404, { error: 'Not Found' });
}

function serveStatic(res, pathname, publicDir, headOnly = false) {
  let relPath = pathname === '/' ? '/index.html' : pathname;
  const resolvedBase = path.resolve(publicDir);
  const fullPath = path.resolve(resolvedBase, '.' + relPath);

  // Prevent path traversal (including sibling directories sharing the same prefix)
  if (fullPath !== resolvedBase && !fullPath.startsWith(resolvedBase + path.sep)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let target = fullPath;
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    target = path.join(resolvedBase, 'index.html');
  }

  if (!fs.existsSync(target)) {
    res.writeHead(404);
    res.end('Not Found');
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const buf = fs.readFileSync(target);
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': buf.length,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(headOnly ? undefined : buf);
}

module.exports = { createAppServer, extractUsernameFromInput, csvCell };
