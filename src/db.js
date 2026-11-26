'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { config } = require('./config');
const { compareVersions, slugifyAppName, buildDownloadUrl } = require('./parser');

function nowIso() {
  return new Date().toISOString();
}

const EFFECTIVE_AGE_SQL =
  "CASE WHEN f.uploaded_days_ago IS NULL THEN NULL ELSE f.uploaded_days_ago + MAX(0, CAST(julianday('now') - julianday(f.last_seen_at) AS INTEGER)) END";

function foldDiacritics(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function buildFtsMatchQuery(rawQuery) {
  const tokens = foldDiacritics(rawQuery)
    .trim()
    .match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"*`).join(' ');
}

function getWatchDedupKey(w) {
  const type = w?.watch_type === 'keyword' ? 'keyword' : 'app';
  const target =
    type === 'keyword'
      ? String(w?.keyword || '')
          .trim()
          .toLowerCase()
      : String(w?.target_slug || slugifyAppName(w?.display_name || '')).trim();
  const plat = String(w?.platform_filter || '').trim();
  return `${type}::${target}::${plat}`;
}

class RadarDB {
  constructor(dbPath = config.dbPath) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.initSchema();
    this.seedDefaults();
  }

  close() {
    this.db.close();
  }

  initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        username TEXT PRIMARY KEY,
        label TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        total_reported INTEGER NOT NULL DEFAULT 0,
        last_sync_at TEXT,
        last_full_sync_at TEXT,
        baseline_completed INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS files (
        file_code TEXT PRIMARY KEY,
        source_user TEXT NOT NULL,
        raw_filename TEXT NOT NULL,
        app_name TEXT NOT NULL,
        app_slug TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT 'Other',
        extension TEXT NOT NULL DEFAULT '',
        tags_json TEXT NOT NULL DEFAULT '[]',
        tags_text TEXT NOT NULL DEFAULT '',
        min_ios REAL,
        min_ios_label TEXT,
        release_group TEXT NOT NULL DEFAULT '',
        size_text TEXT NOT NULL DEFAULT '',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        uploaded_days_ago INTEGER,
        downloads INTEGER NOT NULL DEFAULT 0,
        download_url TEXT NOT NULL,
        list_order INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_files_source_active_order ON files(source_user, is_active, list_order);
      CREATE INDEX IF NOT EXISTS idx_files_slug ON files(app_slug, is_active);
      CREATE INDEX IF NOT EXISTS idx_files_platform ON files(platform, is_active);
      CREATE INDEX IF NOT EXISTS idx_files_ext ON files(extension, is_active);
      CREATE INDEX IF NOT EXISTS idx_files_min_ios ON files(min_ios);
      CREATE INDEX IF NOT EXISTS idx_files_downloads ON files(downloads DESC);
      CREATE INDEX IF NOT EXISTS idx_files_size ON files(size_bytes DESC);
      CREATE INDEX IF NOT EXISTS idx_files_age ON files(uploaded_days_ago ASC);

      CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
        file_code UNINDEXED,
        app_name,
        raw_filename,
        version,
        tags_text,
        release_group
      );

      CREATE TABLE IF NOT EXISTS watchlist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_type TEXT NOT NULL CHECK(watch_type IN ('app', 'keyword')),
        target_slug TEXT NOT NULL DEFAULT '',
        keyword TEXT NOT NULL DEFAULT '',
        display_name TEXT NOT NULL,
        platform_filter TEXT NOT NULL DEFAULT '',
        source_user TEXT NOT NULL DEFAULT '',
        last_known_version TEXT NOT NULL DEFAULT '',
        last_known_file_code TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        notify_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_matched_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_watchlist_slug ON watchlist(watch_type, target_slug);

      CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        watch_id INTEGER NOT NULL,
        watch_name TEXT NOT NULL,
        file_code TEXT NOT NULL,
        source_user TEXT NOT NULL,
        app_name TEXT NOT NULL,
        app_slug TEXT NOT NULL,
        old_version TEXT NOT NULL DEFAULT '',
        new_version TEXT NOT NULL DEFAULT '',
        raw_filename TEXT NOT NULL,
        download_url TEXT NOT NULL,
        size_text TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        is_read INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(watch_id, file_code)
      );

      CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_alerts_read ON alerts(is_read);

      CREATE TABLE IF NOT EXISTS sync_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_user TEXT NOT NULL,
        mode TEXT NOT NULL,
        status TEXT NOT NULL,
        total_fetched INTEGER NOT NULL DEFAULT 0,
        new_files INTEGER NOT NULL DEFAULT 0,
        alerts_triggered INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        error_message TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  seedDefaults() {
    const ts = nowIso();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sources (username, label, enabled, created_at)
         VALUES (?, ?, 1, ?)`
      )
      .run(config.defaultSourceUser, config.defaultSourceUser, ts);

    const insertSetting = this.db.prepare(
      `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`
    );
    for (const [k, v] of Object.entries(config.defaults)) {
      insertSetting.run(k, JSON.stringify(v));
    }
  }

  /* ── Settings ─────────────────────────────────────────── */

  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const out = { ...config.defaults };
    for (const row of rows) {
      try {
        out[row.key] = JSON.parse(row.value);
      } catch {
        out[row.key] = row.value;
      }
    }
    const env = typeof config.getEnvOverrides === 'function' ? config.getEnvOverrides() : {};
    if (env.telegram_bot_token && (env.cloud_mode || !out.telegram_bot_token)) {
      out.telegram_bot_token = env.telegram_bot_token;
    }
    if (env.telegram_chat_id && (env.cloud_mode || !out.telegram_chat_id)) {
      out.telegram_chat_id = env.telegram_chat_id;
    }
    if (env.webhook_url && (env.cloud_mode || !out.webhook_url)) {
      out.webhook_url = env.webhook_url;
    }
    if (env.telegram_bot_enabled !== undefined && (env.cloud_mode || !out.telegram_bot_enabled)) {
      out.telegram_bot_enabled = env.telegram_bot_enabled;
    }
    return out;
  }

  getBotOffset() {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'telegram_update_offset'")
      .get();
    if (!row) return 0;
    const parsed = Number.parseInt(String(row.value).replace(/"/g, ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  setBotOffset(offset) {
    const safe = Math.max(0, Number.parseInt(offset, 10) || 0);
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('telegram_update_offset', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(JSON.stringify(safe));
    return safe;
  }

  getWatchlistFileMeta() {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key = 'watchlist_file_meta'")
      .get();
    if (!row) return { hash: '', keys: [] };
    try {
      const parsed = JSON.parse(row.value);
      return {
        hash: typeof parsed?.hash === 'string' ? parsed.hash : '',
        keys: Array.isArray(parsed?.keys) ? parsed.keys.map(String) : [],
      };
    } catch {
      return { hash: '', keys: [] };
    }
  }

  setWatchlistFileMeta(meta = {}) {
    const safe = {
      hash: typeof meta.hash === 'string' ? meta.hash : '',
      keys: Array.isArray(meta.keys) ? meta.keys.map(String) : [],
    };
    this.db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('watchlist_file_meta', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(JSON.stringify(safe));
    return safe;
  }

  updateSettings(patch) {
    const allowedKeys = new Set([
      'telegram_bot_token',
      'telegram_chat_id',
      'telegram_bot_enabled',
      'webhook_url',
      'windows_toast_enabled',
      'sync_interval_minutes',
    ]);
    const upsert = this.db.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    );
    this.db.exec('BEGIN');
    try {
      for (const [k, v] of Object.entries(patch || {})) {
        if (!allowedKeys.has(k)) continue;
        upsert.run(k, JSON.stringify(v));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    return this.getSettings();
  }

  /* ── Sources ──────────────────────────────────────────── */

  listSources() {
    return this.db
      .prepare(
        `SELECT s.*,
          (SELECT COUNT(*) FROM files f WHERE f.source_user = s.username AND f.is_active = 1) AS active_files,
          (SELECT COUNT(DISTINCT f.app_slug) FROM files f WHERE f.source_user = s.username AND f.is_active = 1) AS active_apps
         FROM sources s
         ORDER BY s.created_at ASC`
      )
      .all();
  }

  getSource(username) {
    return this.db.prepare('SELECT * FROM sources WHERE username = ?').get(username) || null;
  }

  addSource(username, label = '') {
    const clean = String(username || '').trim();
    if (!clean || !/^[a-zA-Z0-9._-]+$/.test(clean)) {
      throw new Error('Invalid DailyUploads username (only letters, numbers, dots, hyphens, and underscores allowed).');
    }
    this.db
      .prepare(
        `INSERT OR IGNORE INTO sources (username, label, enabled, created_at)
         VALUES (?, ?, 1, ?)`
      )
      .run(clean, label.trim() || clean, nowIso());
    return this.getSource(clean);
  }

  removeSource(username) {
    const sources = this.listSources();
    if (sources.length <= 1) {
      throw new Error('At least 1 active source must remain.');
    }
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare('DELETE FROM files_fts WHERE file_code IN (SELECT file_code FROM files WHERE source_user = ?)')
        .run(username);
      this.db.prepare('DELETE FROM files WHERE source_user = ?').run(username);
      this.db.prepare('DELETE FROM sources WHERE username = ?').run(username);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  getKnownFileCodes(sourceUser) {
    const rows = this.db
      .prepare('SELECT file_code FROM files WHERE source_user = ? AND is_active = 1')
      .all(sourceUser);
    return new Set(rows.map((r) => r.file_code));
  }

  /* ── Sync Persistence ─────────────────────────────────── */

  saveSyncResult(sourceUser, items, { mode = 'full', totalReported = items.length } = {}) {
    const ts = nowIso();
    let source = this.getSource(sourceUser);
    if (!source) {
      source = this.addSource(sourceUser);
    }
    const isBaseline = source.baseline_completed === 0;

    const existingRows = this.db
      .prepare('SELECT file_code, first_seen_at FROM files WHERE source_user = ?')
      .all(sourceUser);
    const existingMap = new Map(existingRows.map((r) => [r.file_code, r.first_seen_at]));

    const newFiles = [];
    const fetchedCodes = new Set();

    for (const item of items) {
      fetchedCodes.add(item.file_code);
      if (!existingMap.has(item.file_code)) {
        newFiles.push(item);
      }
    }

    const upsertFile = this.db.prepare(`
      INSERT INTO files (
        file_code, source_user, raw_filename, app_name, app_slug, version,
        platform, extension, tags_json, tags_text, min_ios, min_ios_label,
        release_group, size_text, size_bytes, uploaded_days_ago, downloads,
        download_url, list_order, first_seen_at, last_seen_at, is_active
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, 1
      )
      ON CONFLICT(file_code) DO UPDATE SET
        raw_filename = excluded.raw_filename,
        app_name = excluded.app_name,
        app_slug = excluded.app_slug,
        version = excluded.version,
        platform = excluded.platform,
        extension = excluded.extension,
        tags_json = excluded.tags_json,
        tags_text = excluded.tags_text,
        min_ios = excluded.min_ios,
        min_ios_label = excluded.min_ios_label,
        release_group = excluded.release_group,
        size_text = excluded.size_text,
        size_bytes = excluded.size_bytes,
        uploaded_days_ago = excluded.uploaded_days_ago,
        downloads = excluded.downloads,
        download_url = excluded.download_url,
        list_order = excluded.list_order,
        last_seen_at = excluded.last_seen_at,
        is_active = 1
    `);

    const delFts = this.db.prepare('DELETE FROM files_fts WHERE file_code = ?');
    const insFts = this.db.prepare(
      `INSERT INTO files_fts (file_code, app_name, raw_filename, version, tags_text, release_group)
       VALUES (?, ?, ?, ?, ?, ?)`
    );

    let deactivatedCount = 0;

    this.db.exec('BEGIN');
    try {
      if (mode === 'quick' && newFiles.length > 0) {
        // Push existing items down so newly fetched top items stay at index 0..N-1
        this.db
          .prepare('UPDATE files SET list_order = list_order + ? WHERE source_user = ?')
          .run(newFiles.length, sourceUser);
      }

      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        const tags = Array.isArray(it.tags) ? it.tags : [];
        const tagsJson = JSON.stringify(tags);
        const tagsText = tags.map((t) => t.toLowerCase()).join(' ');
        const firstSeen = existingMap.get(it.file_code) || ts;

        upsertFile.run(
          it.file_code,
          sourceUser,
          it.raw_filename,
          it.app_name,
          it.app_slug,
          it.version || '',
          it.platform || 'Other',
          it.extension || '',
          tagsJson,
          tagsText,
          it.min_ios ?? null,
          it.min_ios_label ?? null,
          it.release_group || '',
          it.size_text || '',
          it.size_bytes || 0,
          it.uploaded_days_ago ?? null,
          it.downloads || 0,
          it.download_url,
          i,
          firstSeen,
          ts
        );

        delFts.run(it.file_code);
        insFts.run(
          it.file_code,
          it.app_name,
          it.raw_filename,
          it.version || '',
          tagsText,
          it.release_group || ''
        );
      }

      if (mode === 'full' && !(totalReported > 0 && items.length === 0)) {
        const activeRows = this.db
          .prepare('SELECT file_code FROM files WHERE source_user = ? AND is_active = 1')
          .all(sourceUser);
        const deactivateStmt = this.db.prepare('UPDATE files SET is_active = 0 WHERE file_code = ?');
        for (const r of activeRows) {
          if (!fetchedCodes.has(r.file_code)) {
            deactivateStmt.run(r.file_code);
            delFts.run(r.file_code);
            deactivatedCount += 1;
          }
        }
      }

      this.db
        .prepare(
          `UPDATE sources
           SET total_reported = ?,
               last_sync_at = ?,
               last_full_sync_at = CASE WHEN ? = 'full' THEN ? ELSE last_full_sync_at END,
               baseline_completed = 1
           WHERE username = ?`
        )
        .run(totalReported, ts, mode, ts, sourceUser);

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return {
      newFiles,
      totalFetched: items.length,
      deactivatedCount,
      isBaseline,
    };
  }

  logSync({ sourceUser, mode, status, totalFetched = 0, newFiles = 0, alertsTriggered = 0, durationMs = 0, errorMessage = '' }) {
    this.db
      .prepare(
        `INSERT INTO sync_logs (source_user, mode, status, total_fetched, new_files, alerts_triggered, duration_ms, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sourceUser, mode, status, totalFetched, newFiles, alertsTriggered, durationMs, errorMessage, nowIso());
  }

  getSyncLogs(limit = 20) {
    return this.db
      .prepare('SELECT * FROM sync_logs ORDER BY id DESC LIMIT ?')
      .all(Math.min(100, Math.max(1, limit)));
  }

  /* ── Search, Filter, Sort & Grouping ──────────────────── */

  hydrateFileRow(row, watchedSlugs = null) {
    if (!row) return null;
    let tags = [];
    try {
      tags = JSON.parse(row.tags_json || '[]');
    } catch {
      tags = [];
    }
    const result = {
      ...row,
      tags,
      is_watched: watchedSlugs ? watchedSlugs.has(row.app_slug) : Boolean(row.is_watched),
    };
    delete result.tags_json;
    delete result.rn;
    return result;
  }

  getWatchedSlugSet() {
    const rows = this.db
      .prepare("SELECT target_slug FROM watchlist WHERE watch_type = 'app'")
      .all();
    return new Set(rows.map((r) => r.target_slug));
  }

  buildFilterWhere(params = {}) {
    const where = ['f.is_active = 1'];
    const bindings = [];

    if (params.source && params.source !== 'all') {
      where.push('f.source_user = ?');
      bindings.push(params.source);
    }

    if (params.platform && params.platform !== 'all') {
      where.push('f.platform = ?');
      bindings.push(params.platform);
    }

    if (params.extension && params.extension !== 'all') {
      where.push('f.extension = ?');
      bindings.push(params.extension.toLowerCase());
    }

    if (params.tag && params.tag !== 'all') {
      where.push("LOWER(f.tags_json) LIKE ?");
      bindings.push(`%"${String(params.tag).toLowerCase()}"%`);
    }

    if (params.releaseGroup && params.releaseGroup !== 'all') {
      where.push('LOWER(f.release_group) = ?');
      bindings.push(String(params.releaseGroup).toLowerCase());
    }

    if (params.maxIos !== undefined && params.maxIos !== '' && params.maxIos !== 'all') {
      const maxIosNum = Number.parseFloat(params.maxIos);
      if (Number.isFinite(maxIosNum)) {
        where.push('(f.min_ios IS NOT NULL AND f.min_ios <= ?)');
        bindings.push(maxIosNum);
      }
    }

    if (params.maxDays !== undefined && params.maxDays !== '' && params.maxDays !== 'all') {
      const maxDaysNum = Number.parseInt(params.maxDays, 10);
      if (Number.isFinite(maxDaysNum)) {
        where.push(`(f.uploaded_days_ago IS NOT NULL AND (${EFFECTIVE_AGE_SQL}) <= ?)`);
        bindings.push(maxDaysNum);
      }
    }

    if (params.minSizeMb !== undefined && params.minSizeMb !== '') {
      const minB = Number.parseFloat(params.minSizeMb) * 1024 * 1024;
      if (Number.isFinite(minB) && minB >= 0) {
        where.push('f.size_bytes >= ?');
        bindings.push(Math.round(minB));
      }
    }

    if (params.maxSizeMb !== undefined && params.maxSizeMb !== '') {
      const maxB = Number.parseFloat(params.maxSizeMb) * 1024 * 1024;
      if (Number.isFinite(maxB) && maxB >= 0) {
        where.push('f.size_bytes <= ?');
        bindings.push(Math.round(maxB));
      }
    }

    if (params.watchedOnly === true || params.watchedOnly === 'true' || params.watchedOnly === '1') {
      const watches = this.db
        .prepare('SELECT watch_type, target_slug, keyword, platform_filter, source_user FROM watchlist')
        .all();
      const ruleClauses = [];
      for (const w of watches) {
        const conds = [];
        if (w.source_user) {
          conds.push('f.source_user = ?');
          bindings.push(w.source_user);
        }
        if (w.platform_filter) {
          conds.push('f.platform = ?');
          bindings.push(w.platform_filter);
        }
        if (w.watch_type === 'app' && w.target_slug) {
          conds.push('f.app_slug = ?');
          bindings.push(w.target_slug);
          ruleClauses.push(`(${conds.join(' AND ')})`);
        } else if (w.watch_type === 'keyword' && w.keyword) {
          const terms = String(w.keyword)
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
          if (terms.length > 0) {
            for (const t of terms) {
              conds.push("LOWER(f.app_name || ' ' || f.raw_filename || ' ' || f.tags_text) LIKE ? ESCAPE '\\'");
              bindings.push(`%${t.replace(/[\\%_]/g, '\\$&')}%`);
            }
            ruleClauses.push(`(${conds.join(' AND ')})`);
          }
        }
      }
      if (ruleClauses.length === 0) {
        where.push('0 = 1');
      } else {
        where.push(`(${ruleClauses.join(' OR ')})`);
      }
    }

    const q = String(params.q || '').trim();
    let hasFts = false;
    if (q) {
      const ftsQuery = buildFtsMatchQuery(q);
      if (ftsQuery) {
        hasFts = true;
        where.push('f.file_code IN (SELECT file_code FROM files_fts WHERE files_fts MATCH ?)');
        bindings.push(ftsQuery);
        // If user typed special symbol like +, enforce substring match too
        if (/[+#@]/.test(q)) {
          where.push('(LOWER(f.app_name) LIKE ? OR LOWER(f.raw_filename) LIKE ?)');
          const pat = `%${q.toLowerCase()}%`;
          bindings.push(pat, pat);
        }
      } else {
        where.push('(LOWER(f.app_name) LIKE ? OR LOWER(f.raw_filename) LIKE ?)');
        const pat = `%${q.toLowerCase()}%`;
        bindings.push(pat, pat);
      }
    }

    return {
      whereSql: where.join(' AND '),
      bindings,
      hasFts,
      q,
    };
  }

  searchFiles(params = {}) {
    const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
    const maxLimit = Math.min(10000, Math.max(1, Number.parseInt(params.maxLimit, 10) || 200));
    const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(params.limit, 10) || 40));
    const offset = (page - 1) * limit;
    const grouped = params.grouped === true || params.grouped === 'true' || params.grouped === '1';
    const sort = String(params.sort || 'newest');

    const { whereSql, bindings } = this.buildFilterWhere(params);
    const watchedSlugs = this.getWatchedSlugSet();

    const sortMapFlat = {
      newest: `COALESCE(${EFFECTIVE_AGE_SQL}, 99999) ASC, f.list_order ASC`,
      oldest: `COALESCE(${EFFECTIVE_AGE_SQL}, -1) DESC, f.list_order DESC`,
      downloads: 'f.downloads DESC, f.list_order ASC',
      name_asc: 'LOWER(f.app_name) ASC, f.list_order ASC',
      name_desc: 'LOWER(f.app_name) DESC, f.list_order ASC',
      size_desc: 'f.size_bytes DESC, f.list_order ASC',
      size_asc: 'f.size_bytes ASC, f.list_order ASC',
    };

    const sortMapGrouped = {
      newest: 'COALESCE(f.uploaded_days_ago, 99999) ASC, f.list_order ASC',
      oldest: 'COALESCE(f.uploaded_days_ago, -1) DESC, f.list_order DESC',
      downloads: 'f.total_downloads DESC, f.list_order ASC',
      name_asc: 'LOWER(f.app_name) ASC, f.list_order ASC',
      name_desc: 'LOWER(f.app_name) DESC, f.list_order ASC',
      size_desc: 'f.size_bytes DESC, f.list_order ASC',
      size_asc: 'f.size_bytes ASC, f.list_order ASC',
    };

    if (!grouped) {
      const orderSql = sortMapFlat[sort] || sortMapFlat.newest;
      const countRow = this.db
        .prepare(`SELECT COUNT(*) AS cnt FROM files f WHERE ${whereSql}`)
        .get(...bindings);
      const total = countRow ? countRow.cnt : 0;

      const rows = this.db
        .prepare(
          `SELECT f.*,
             ${EFFECTIVE_AGE_SQL} AS uploaded_days_ago,
             (SELECT COUNT(*) FROM files f2 WHERE f2.source_user = f.source_user AND f2.app_slug = f.app_slug AND f2.is_active = 1) AS version_count
           FROM files f
           WHERE ${whereSql}
           ORDER BY ${orderSql}
           LIMIT ? OFFSET ?`
        )
        .all(...bindings, limit, offset);

      return {
        items: rows.map((r) => this.hydrateFileRow(r, watchedSlugs)),
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        grouped: false,
      };
    }

    // Grouped by (source_user, app_slug): pick newest upload (lowest list_order) per app
    const orderSql = sortMapGrouped[sort] || sortMapGrouped.newest;
    const countRow = this.db
      .prepare(
        `SELECT COUNT(*) AS cnt FROM (
           SELECT f.source_user, f.app_slug
           FROM files f
           WHERE ${whereSql}
           GROUP BY f.source_user, f.app_slug
         )`
      )
      .get(...bindings);
    const total = countRow ? countRow.cnt : 0;

    const rows = this.db
      .prepare(
        `WITH filtered AS (
           SELECT f.*,
             ${EFFECTIVE_AGE_SQL} AS effective_days_ago,
             ROW_NUMBER() OVER (
               PARTITION BY f.source_user, f.app_slug
               ORDER BY f.list_order ASC, f.file_code ASC
             ) AS rn,
             (SELECT COUNT(*) FROM files f2 WHERE f2.source_user = f.source_user AND f2.app_slug = f.app_slug AND f2.is_active = 1) AS version_count,
             SUM(f.downloads) OVER (PARTITION BY f.source_user, f.app_slug) AS total_downloads,
             MAX(f.downloads) OVER (PARTITION BY f.source_user, f.app_slug) AS max_downloads
           FROM files f
           WHERE ${whereSql}
         ),
         ranked AS (
           SELECT
             file_code, source_user, raw_filename, app_name, app_slug, version,
             platform, extension, tags_json, tags_text, min_ios, min_ios_label,
             release_group, size_text, size_bytes,
             effective_days_ago AS uploaded_days_ago,
             downloads, download_url, list_order, first_seen_at, last_seen_at, is_active,
             version_count, total_downloads, max_downloads
           FROM filtered
           WHERE rn = 1
         )
         SELECT f.*
         FROM ranked f
         ORDER BY ${orderSql}
         LIMIT ? OFFSET ?`
      )
      .all(...bindings, limit, offset);

    return {
      items: rows.map((r) => this.hydrateFileRow(r, watchedSlugs)),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      grouped: true,
    };
  }

  getAppVersions(appSlug, sourceUser = '') {
    const watchedSlugs = this.getWatchedSlugSet();
    const sql = sourceUser
      ? `SELECT f.*, ${EFFECTIVE_AGE_SQL} AS uploaded_days_ago FROM files f WHERE f.app_slug = ? AND f.source_user = ? AND f.is_active = 1 ORDER BY f.list_order ASC`
      : `SELECT f.*, ${EFFECTIVE_AGE_SQL} AS uploaded_days_ago FROM files f WHERE f.app_slug = ? AND f.is_active = 1 ORDER BY f.list_order ASC`;
    const rows = sourceUser
      ? this.db.prepare(sql).all(appSlug, sourceUser)
      : this.db.prepare(sql).all(appSlug);
    return rows.map((r) => this.hydrateFileRow(r, watchedSlugs));
  }

  getFileByCode(fileCode) {
    const row = this.db.prepare('SELECT * FROM files WHERE file_code = ?').get(fileCode);
    if (!row) return null;
    return this.hydrateFileRow(row, this.getWatchedSlugSet());
  }

  getFacets(sourceUser = 'all') {
    const filterSql = sourceUser && sourceUser !== 'all' ? 'AND source_user = ?' : '';
    const args = sourceUser && sourceUser !== 'all' ? [sourceUser] : [];

    const platforms = this.db
      .prepare(
        `SELECT platform AS name, COUNT(*) AS count
         FROM files WHERE is_active = 1 ${filterSql}
         GROUP BY platform ORDER BY count DESC`
      )
      .all(...args);

    const extensions = this.db
      .prepare(
        `SELECT extension AS name, COUNT(*) AS count
         FROM files WHERE is_active = 1 AND extension != '' ${filterSql}
         GROUP BY extension ORDER BY count DESC`
      )
      .all(...args);

    const releaseGroups = this.db
      .prepare(
        `SELECT release_group AS name, COUNT(*) AS count
         FROM files WHERE is_active = 1 AND release_group != '' ${filterSql}
         GROUP BY release_group ORDER BY count DESC LIMIT 20`
      )
      .all(...args);

    // Aggregate top tags from JSON
    const tagRows = this.db
      .prepare(`SELECT tags_json FROM files WHERE is_active = 1 ${filterSql}`)
      .all(...args);
    const tagCounts = new Map();
    for (const r of tagRows) {
      let arr;
      try {
        arr = JSON.parse(r.tags_json || '[]');
      } catch {
        continue;
      }
      for (const t of arr) {
        tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
      }
    }
    const tags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([name, count]) => ({ name, count }));

    return { platforms, extensions, releaseGroups, tags };
  }

  getStats() {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_files,
           COUNT(DISTINCT f.app_slug) AS total_apps,
           COALESCE(SUM(f.size_bytes), 0) AS total_size_bytes,
           COALESCE(SUM(f.downloads), 0) AS total_downloads,
           SUM(CASE WHEN (${EFFECTIVE_AGE_SQL}) = 0 THEN 1 ELSE 0 END) AS uploaded_today,
           SUM(CASE WHEN (${EFFECTIVE_AGE_SQL}) <= 7 THEN 1 ELSE 0 END) AS uploaded_week
         FROM files f WHERE f.is_active = 1`
      )
      .get();

    const watchCount = this.db.prepare('SELECT COUNT(*) AS cnt FROM watchlist').get().cnt;
    const unreadAlerts = this.db.prepare('SELECT COUNT(*) AS cnt FROM alerts WHERE is_read = 0').get().cnt;
    const topDownloaded = this.db
      .prepare(
        `SELECT file_code, app_name, app_slug, version, platform, downloads, size_text, download_url
         FROM files WHERE is_active = 1
         ORDER BY downloads DESC, list_order ASC LIMIT 10`
      )
      .all();

    const multiVersionApps = this.db
      .prepare(
        `SELECT app_slug, MIN(app_name) AS app_name, COUNT(*) AS versions, MAX(downloads) AS max_downloads
         FROM files WHERE is_active = 1
         GROUP BY app_slug HAVING COUNT(*) > 1
         ORDER BY versions DESC, max_downloads DESC LIMIT 10`
      )
      .all();

    return {
      ...totals,
      watchlist_count: watchCount,
      unread_alerts: unreadAlerts,
      sources: this.listSources(),
      top_downloaded: topDownloaded,
      multi_version_apps: multiVersionApps,
    };
  }

  /* ── Watchlist ────────────────────────────────────────── */

  listWatchlist() {
    const rows = this.db.prepare('SELECT * FROM watchlist ORDER BY created_at DESC').all();
    return rows.map((w) => {
      let latestFile = null;
      if (w.watch_type === 'app' && w.target_slug) {
        const conds = ['f.app_slug = ?', 'f.is_active = 1'];
        const args = [w.target_slug];
        if (w.platform_filter) {
          conds.push('f.platform = ?');
          args.push(w.platform_filter);
        }
        if (w.source_user) {
          conds.push('f.source_user = ?');
          args.push(w.source_user);
        }
        const row = this.db
          .prepare(
            `SELECT f.file_code, f.app_name, f.version, f.size_text,
                    ${EFFECTIVE_AGE_SQL} AS uploaded_days_ago,
                    f.downloads, f.download_url, f.platform
             FROM files f
             WHERE ${conds.join(' AND ')}
             ORDER BY f.list_order ASC LIMIT 1`
          )
          .get(...args);
        if (row) latestFile = row;
      } else if (w.watch_type === 'keyword' && w.keyword) {
        const res = this.searchFiles({
          q: w.keyword,
          platform: w.platform_filter || 'all',
          source: w.source_user || 'all',
          limit: 1,
          sort: 'newest',
        });
        if (res.items.length > 0) {
          const f = res.items[0];
          latestFile = {
            file_code: f.file_code,
            app_name: f.app_name,
            version: f.version,
            size_text: f.size_text,
            uploaded_days_ago: f.uploaded_days_ago,
            downloads: f.downloads,
            download_url: f.download_url,
            platform: f.platform,
          };
        }
      }
      const alertCount = this.db
        .prepare('SELECT COUNT(*) AS cnt FROM alerts WHERE watch_id = ?')
        .get(w.id).cnt;
      return { ...w, latest_file: latestFile, alert_count: alertCount };
    });
  }

  addWatch({
    watch_type = 'app',
    target_slug = '',
    keyword = '',
    display_name = '',
    platform_filter = '',
    source_user = '',
    notes = '',
  }) {
    const type = watch_type === 'keyword' ? 'keyword' : 'app';
    let slug = String(target_slug || '').trim();
    let kw = String(keyword || '').trim();
    let name = String(display_name || '').trim();

    if (type === 'app') {
      if (!slug && name) slug = slugifyAppName(name);
      if (!slug) throw new Error('target_slug or display_name is required.');

      // Prevent duplicate app watch
      const existing = this.db
        .prepare("SELECT * FROM watchlist WHERE watch_type = 'app' AND target_slug = ? AND platform_filter = ?")
        .get(slug, platform_filter || '');
      if (existing) return { item: existing, created: false };

      const latestConds = ['app_slug = ?', 'is_active = 1'];
      const latestArgs = [slug];
      if (platform_filter) {
        latestConds.push('platform = ?');
        latestArgs.push(platform_filter);
      }
      if (source_user) {
        latestConds.push('source_user = ?');
        latestArgs.push(source_user);
      }
      const latest = this.db
        .prepare(`SELECT app_name, version, file_code FROM files WHERE ${latestConds.join(' AND ')} ORDER BY list_order ASC LIMIT 1`)
        .get(...latestArgs);

      if (!name) name = latest?.app_name || slug;
      const lastVer = latest?.version || '';
      const lastCode = latest?.file_code || '';

      const res = this.db
        .prepare(
          `INSERT INTO watchlist
           (watch_type, target_slug, keyword, display_name, platform_filter, source_user, last_known_version, last_known_file_code, notes, notify_enabled, created_at)
           VALUES ('app', ?, '', ?, ?, ?, ?, ?, ?, 1, ?)`
        )
        .run(slug, name, platform_filter || '', source_user || '', lastVer, lastCode, notes || '', nowIso());

      return {
        item: this.db.prepare('SELECT * FROM watchlist WHERE id = ?').get(res.lastInsertRowid),
        created: true,
      };
    }

    // Keyword watch
    if (!kw) throw new Error('Keyword is required.');
    if (!name) name = kw;
    const existing = this.db
      .prepare("SELECT * FROM watchlist WHERE watch_type = 'keyword' AND LOWER(keyword) = LOWER(?) AND platform_filter = ?")
      .get(kw, platform_filter || '');
    if (existing) return { item: existing, created: false };

    const latestRes = this.searchFiles({
      q: kw,
      platform: platform_filter || 'all',
      source: source_user || 'all',
      limit: 1,
      sort: 'newest',
    });
    const latest = latestRes.items[0];

    const res = this.db
      .prepare(
        `INSERT INTO watchlist
         (watch_type, target_slug, keyword, display_name, platform_filter, source_user, last_known_version, last_known_file_code, notes, notify_enabled, created_at)
         VALUES ('keyword', '', ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .run(
        kw,
        name,
        platform_filter || '',
        source_user || '',
        latest?.version || '',
        latest?.file_code || '',
        notes || '',
        nowIso()
      );

    return {
      item: this.db.prepare('SELECT * FROM watchlist WHERE id = ?').get(res.lastInsertRowid),
      created: true,
    };
  }

  updateWatch(id, patch = {}) {
    const existing = this.db.prepare('SELECT * FROM watchlist WHERE id = ?').get(id);
    if (!existing) return null;
    const notifyEnabled =
      patch.notify_enabled !== undefined ? (patch.notify_enabled ? 1 : 0) : existing.notify_enabled;
    const notes = patch.notes !== undefined ? String(patch.notes) : existing.notes;
    const platformFilter =
      patch.platform_filter !== undefined ? String(patch.platform_filter) : existing.platform_filter;
    const displayName =
      patch.display_name !== undefined && String(patch.display_name).trim()
        ? String(patch.display_name).trim()
        : existing.display_name;

    this.db
      .prepare(
        `UPDATE watchlist SET notify_enabled = ?, notes = ?, platform_filter = ?, display_name = ? WHERE id = ?`
      )
      .run(notifyEnabled, notes, platformFilter, displayName, id);
    return this.db.prepare('SELECT * FROM watchlist WHERE id = ?').get(id);
  }

  removeWatch(id) {
    const info = this.db.prepare('DELETE FROM watchlist WHERE id = ?').run(id);
    return info.changes > 0;
  }

  removeWatchBySlug(slug) {
    const info = this.db
      .prepare("DELETE FROM watchlist WHERE watch_type = 'app' AND target_slug = ?")
      .run(slug);
    return info.changes > 0;
  }

  importWatchlist(items = []) {
    if (!Array.isArray(items)) throw new Error('Import payload must be a JSON array.');
    let added = 0;
    let skipped = 0;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object') continue;
      try {
        const res = this.addWatch({
          watch_type: raw.watch_type === 'keyword' ? 'keyword' : 'app',
          target_slug: raw.target_slug || '',
          keyword: raw.keyword || '',
          display_name: raw.display_name || '',
          platform_filter: raw.platform_filter || '',
          source_user: raw.source_user || '',
          notes: raw.notes || '',
        });
        if (res.created) added += 1;
        else skipped += 1;
      } catch {
        skipped += 1;
      }
    }
    return { added, skipped };
  }

  /**
   * Reconciles declarative `watchlist.json` changes without resurrecting rules
   * that were deleted via Telegram (`/unwatch`) and while honoring deletions
   * made in `watchlist.json` or authoritative Cloud Web UI pushes.
   */
  reconcileWatchlistFile(rawContent) {
    const trimmed = String(rawContent || '').trim();
    const hash = crypto.createHash('sha256').update(trimmed).digest('hex');
    const prevMeta = this.getWatchlistFileMeta();

    if (prevMeta.hash === hash) {
      return { added: 0, removed: 0, changed: false };
    }

    let parsed = [];
    if (trimmed) {
      parsed = JSON.parse(trimmed);
    }
    const isAuthoritative = Boolean(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.authoritative === true
    );
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];

    const currMap = new Map();
    for (const raw of list) {
      if (!raw || typeof raw !== 'object') continue;
      const normalized = {
        watch_type: raw.watch_type === 'keyword' ? 'keyword' : 'app',
        target_slug: raw.target_slug || '',
        keyword: raw.keyword || '',
        display_name: raw.display_name || '',
        platform_filter: raw.platform_filter || '',
        source_user: raw.source_user || '',
        notes: raw.notes || '',
      };
      const key = getWatchDedupKey(normalized);
      if (key.endsWith('::::')) continue;
      currMap.set(key, normalized);
    }

    const prevKeys = new Set(prevMeta.keys || []);
    const dbWatches = this.db.prepare('SELECT * FROM watchlist').all();
    const dbKeySet = new Set(dbWatches.map((w) => getWatchDedupKey(w)));

    let added = 0;
    let removed = 0;

    for (const [key, item] of currMap.entries()) {
      const shouldAdd = isAuthoritative ? !dbKeySet.has(key) : !prevKeys.has(key) && !dbKeySet.has(key);
      if (shouldAdd) {
        try {
          const res = this.addWatch(item);
          if (res.created) added += 1;
        } catch {
          // skip invalid entry
        }
      }
    }

    for (const w of dbWatches) {
      const key = getWatchDedupKey(w);
      const shouldRemove = isAuthoritative ? !currMap.has(key) : prevKeys.has(key) && !currMap.has(key);
      if (shouldRemove) {
        if (this.removeWatch(w.id)) removed += 1;
      }
    }

    this.setWatchlistFileMeta({ hash, keys: [...currMap.keys()] });
    return { added, removed, changed: added > 0 || removed > 0 };
  }

  /* ── Update Matching & Alerts ─────────────────────────── */

  matchWatchlistForNewFiles(newFiles) {
    if (!Array.isArray(newFiles) || newFiles.length === 0) return [];
    const watches = this.db
      .prepare('SELECT * FROM watchlist WHERE notify_enabled = 1')
      .all();
    if (watches.length === 0) return [];

    const insertAlert = this.db.prepare(`
      INSERT OR IGNORE INTO alerts (
        watch_id, watch_name, file_code, source_user, app_name, app_slug,
        old_version, new_version, raw_filename, download_url, size_text, platform,
        is_read, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);

    const updateWatchLatest = this.db.prepare(`
      UPDATE watchlist
      SET last_known_version = ?, last_known_file_code = ?, last_matched_at = ?
      WHERE id = ?
    `);

    const createdAlerts = [];
    const ts = nowIso();
    // Process oldest-first (DailyUploads returns newest-first) so multi-version updates advance chronologically
    const orderedFiles = [...newFiles].reverse();

    this.db.exec('BEGIN');
    try {
      for (const watch of watches) {
        const terms =
          watch.watch_type === 'keyword'
            ? watch.keyword
                .toLowerCase()
                .split(/\s+/)
                .filter(Boolean)
            : [];

        for (const file of orderedFiles) {
          if (watch.source_user && watch.source_user !== file.source_user) continue;
          if (watch.platform_filter && watch.platform_filter !== file.platform) continue;

          let matched = false;
          if (watch.watch_type === 'app') {
            matched = file.app_slug === watch.target_slug;
          } else if (terms.length > 0) {
            const haystack = `${file.app_name} ${file.raw_filename} ${(file.tags || []).join(' ')}`.toLowerCase();
            matched = terms.every((t) => haystack.includes(t));
          }

          if (!matched) continue;

          const oldVersion = watch.last_known_version || '';
          const newVersion = file.version || '';

          const res = insertAlert.run(
            watch.id,
            watch.display_name,
            file.file_code,
            file.source_user,
            file.app_name,
            file.app_slug,
            oldVersion,
            newVersion,
            file.raw_filename,
            file.download_url,
            file.size_text || '',
            file.platform || '',
            ts
          );

          if (res.changes > 0) {
            const alertRow = this.db
              .prepare('SELECT * FROM alerts WHERE id = ?')
              .get(res.lastInsertRowid);
            createdAlerts.push(alertRow);

            // Update last known version if newVersion is newer or previously empty
            const shouldAdvance =
              !oldVersion ||
              (newVersion && compareVersions(newVersion, oldVersion) >= 0);
            if (shouldAdvance) {
              updateWatchLatest.run(newVersion || oldVersion, file.file_code, ts, watch.id);
              watch.last_known_version = newVersion || oldVersion;
            }
          }
        }
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }

    return createdAlerts;
  }

  listAlerts({ unreadOnly = false, limit = 50 } = {}) {
    const lim = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
    const where = unreadOnly ? 'WHERE is_read = 0' : '';
    const items = this.db
      .prepare(`SELECT * FROM alerts ${where} ORDER BY id DESC LIMIT ?`)
      .all(lim);
    const unreadCount = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM alerts WHERE is_read = 0')
      .get().cnt;
    return { items, unread_count: unreadCount };
  }

  markAlertRead(id) {
    const info = this.db.prepare('UPDATE alerts SET is_read = 1 WHERE id = ?').run(id);
    return info.changes > 0;
  }

  markAllAlertsRead() {
    const info = this.db.prepare('UPDATE alerts SET is_read = 1 WHERE is_read = 0').run();
    return info.changes;
  }

  clearAlerts() {
    this.db.prepare('DELETE FROM alerts').run();
  }

  /* ── Cloud State Export / Import (Zero Secrets) ───────── */

  exportCloudState() {
    const sources = this.db
      .prepare('SELECT * FROM sources ORDER BY created_at ASC')
      .all()
      .map((r) => ({ ...r }));

    const fileRows = this.db
      .prepare(
        `SELECT
           file_code, source_user, raw_filename, app_name, app_slug, version,
           platform, extension, tags_json, min_ios, min_ios_label, release_group,
           size_text, size_bytes, uploaded_days_ago, downloads, download_url,
           list_order, first_seen_at, last_seen_at
         FROM files
         WHERE is_active = 1
         ORDER BY source_user ASC, list_order ASC`
      )
      .all();

    const files = fileRows.map((f) => {
      let tags = [];
      try {
        tags = JSON.parse(f.tags_json || '[]');
      } catch {
        tags = [];
      }
      const expectedUrl = buildDownloadUrl(f.file_code, f.raw_filename);
      const tuple = [
        f.file_code,
        f.source_user,
        f.raw_filename,
        f.app_name,
        f.app_slug,
        f.version || '',
        f.platform || 'Other',
        f.extension || '',
        tags,
        f.min_ios ?? null,
        f.min_ios_label ?? null,
        f.release_group || '',
        f.size_text || '',
        f.size_bytes || 0,
        f.uploaded_days_ago ?? null,
        f.downloads || 0,
        f.list_order || 0,
        f.first_seen_at || '',
        f.last_seen_at || '',
      ];
      if (f.download_url && f.download_url !== expectedUrl) {
        tuple.push(f.download_url);
      }
      return tuple;
    });

    const watchlist = this.db
      .prepare('SELECT * FROM watchlist ORDER BY id ASC')
      .all()
      .map((r) => ({ ...r }));

    const alerts = this.db
      .prepare('SELECT * FROM (SELECT * FROM alerts ORDER BY id DESC LIMIT 200) ORDER BY id ASC')
      .all()
      .map((r) => ({ ...r }));

    const syncLogs = this.db
      .prepare('SELECT * FROM (SELECT * FROM sync_logs ORDER BY id DESC LIMIT 50) ORDER BY id ASC')
      .all()
      .map((r) => ({ ...r }));

    return {
      schema_version: 1,
      exported_at: nowIso(),
      bot_offset: this.getBotOffset(),
      watchlist_file_meta: this.getWatchlistFileMeta(),
      columns: [
        'file_code',
        'source_user',
        'raw_filename',
        'app_name',
        'app_slug',
        'version',
        'platform',
        'extension',
        'tags',
        'min_ios',
        'min_ios_label',
        'release_group',
        'size_text',
        'size_bytes',
        'uploaded_days_ago',
        'downloads',
        'list_order',
        'first_seen_at',
        'last_seen_at',
      ],
      sources,
      files,
      watchlist,
      alerts,
      sync_logs: syncLogs,
    };
  }

  importCloudState(stateObj) {
    if (!stateObj || typeof stateObj !== 'object') {
      throw new Error('Invalid cloud state object');
    }

    const ts = nowIso();
    const insSource = this.db.prepare(
      `INSERT INTO sources (username, label, enabled, total_reported, last_sync_at, last_full_sync_at, baseline_completed, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insFile = this.db.prepare(
      `INSERT INTO files (
         file_code, source_user, raw_filename, app_name, app_slug, version,
         platform, extension, tags_json, tags_text, min_ios, min_ios_label,
         release_group, size_text, size_bytes, uploaded_days_ago, downloads,
         download_url, list_order, first_seen_at, last_seen_at, is_active
       ) VALUES (
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?,
         ?, ?, ?, ?, 1
       )`
    );
    const insFts = this.db.prepare(
      `INSERT INTO files_fts (file_code, app_name, raw_filename, version, tags_text, release_group)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insWatch = this.db.prepare(
      `INSERT INTO watchlist (
         id, watch_type, target_slug, keyword, display_name, platform_filter,
         source_user, last_known_version, last_known_file_code, notes,
         notify_enabled, created_at, last_matched_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insAlert = this.db.prepare(
      `INSERT OR IGNORE INTO alerts (
         id, watch_id, watch_name, file_code, source_user, app_name, app_slug,
         old_version, new_version, raw_filename, download_url, size_text, platform,
         is_read, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insLog = this.db.prepare(
      `INSERT INTO sync_logs (
         source_user, mode, status, total_fetched, new_files, alerts_triggered,
         duration_ms, error_message, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    this.db.exec('BEGIN');
    try {
      this.db.exec('DELETE FROM alerts;');
      this.db.exec('DELETE FROM watchlist;');
      this.db.exec('DELETE FROM files_fts;');
      this.db.exec('DELETE FROM files;');
      this.db.exec('DELETE FROM sources;');
      this.db.exec('DELETE FROM sync_logs;');

      const sources = Array.isArray(stateObj.sources) ? stateObj.sources : [];
      if (sources.length === 0) {
        insSource.run(config.defaultSourceUser, config.defaultSourceUser, 1, 0, null, null, 0, ts);
      } else {
        for (const s of sources) {
          if (!s || !s.username) continue;
          insSource.run(
            s.username,
            s.label || s.username,
            s.enabled !== undefined ? (s.enabled ? 1 : 0) : 1,
            s.total_reported || 0,
            s.last_sync_at || null,
            s.last_full_sync_at || null,
            s.baseline_completed ? 1 : 0,
            s.created_at || ts
          );
        }
      }

      const rawFiles = Array.isArray(stateObj.files) ? stateObj.files : [];
      for (let i = 0; i < rawFiles.length; i += 1) {
        const entry = rawFiles[i];
        let f;
        if (Array.isArray(entry)) {
          const [
            file_code,
            source_user,
            raw_filename,
            app_name,
            app_slug,
            version,
            platform,
            extension,
            tags,
            min_ios,
            min_ios_label,
            release_group,
            size_text,
            size_bytes,
            uploaded_days_ago,
            downloads,
            list_order,
            first_seen_at,
            last_seen_at,
            custom_url,
          ] = entry;
          f = {
            file_code,
            source_user,
            raw_filename,
            app_name,
            app_slug,
            version,
            platform,
            extension,
            tags: Array.isArray(tags) ? tags : [],
            min_ios,
            min_ios_label,
            release_group,
            size_text,
            size_bytes,
            uploaded_days_ago,
            downloads,
            list_order: list_order ?? i,
            first_seen_at: first_seen_at || ts,
            last_seen_at: last_seen_at || ts,
            download_url: custom_url || buildDownloadUrl(file_code, raw_filename),
          };
        } else if (entry && typeof entry === 'object') {
          f = {
            ...entry,
            tags: Array.isArray(entry.tags) ? entry.tags : [],
            download_url: entry.download_url || buildDownloadUrl(entry.file_code, entry.raw_filename),
            list_order: entry.list_order ?? i,
            first_seen_at: entry.first_seen_at || ts,
            last_seen_at: entry.last_seen_at || ts,
          };
        } else {
          continue;
        }

        const tagsJson = JSON.stringify(f.tags);
        const tagsText = f.tags.map((t) => String(t).toLowerCase()).join(' ');

        insFile.run(
          f.file_code,
          f.source_user || config.defaultSourceUser,
          f.raw_filename,
          f.app_name,
          f.app_slug,
          f.version || '',
          f.platform || 'Other',
          f.extension || '',
          tagsJson,
          tagsText,
          f.min_ios ?? null,
          f.min_ios_label ?? null,
          f.release_group || '',
          f.size_text || '',
          f.size_bytes || 0,
          f.uploaded_days_ago ?? null,
          f.downloads || 0,
          f.download_url,
          f.list_order,
          f.first_seen_at,
          f.last_seen_at
        );

        insFts.run(
          f.file_code,
          f.app_name,
          f.raw_filename,
          f.version || '',
          tagsText,
          f.release_group || ''
        );
      }

      const watchlist = Array.isArray(stateObj.watchlist) ? stateObj.watchlist : [];
      for (const w of watchlist) {
        if (!w || typeof w !== 'object') continue;
        insWatch.run(
          w.id ?? null,
          w.watch_type === 'keyword' ? 'keyword' : 'app',
          w.target_slug || '',
          w.keyword || '',
          w.display_name || w.keyword || w.target_slug || 'Watch',
          w.platform_filter || '',
          w.source_user || '',
          w.last_known_version || '',
          w.last_known_file_code || '',
          w.notes || '',
          w.notify_enabled !== undefined ? (w.notify_enabled ? 1 : 0) : 1,
          w.created_at || ts,
          w.last_matched_at || null
        );
      }

      const alerts = Array.isArray(stateObj.alerts) ? stateObj.alerts : [];
      for (const a of alerts) {
        if (!a || typeof a !== 'object') continue;
        insAlert.run(
          a.id ?? null,
          a.watch_id || 0,
          a.watch_name || '',
          a.file_code,
          a.source_user || config.defaultSourceUser,
          a.app_name || '',
          a.app_slug || '',
          a.old_version || '',
          a.new_version || '',
          a.raw_filename || '',
          a.download_url || buildDownloadUrl(a.file_code, a.raw_filename || ''),
          a.size_text || '',
          a.platform || '',
          a.is_read ? 1 : 0,
          a.created_at || ts
        );
      }

      const logs = Array.isArray(stateObj.sync_logs) ? stateObj.sync_logs : [];
      for (const l of logs) {
        if (!l || typeof l !== 'object') continue;
        insLog.run(
          l.source_user || config.defaultSourceUser,
          l.mode || 'quick',
          l.status || 'ok',
          l.total_fetched || 0,
          l.new_files || 0,
          l.alerts_triggered || 0,
          l.duration_ms || 0,
          l.error_message || '',
          l.created_at || ts
        );
      }

      if (stateObj.bot_offset !== undefined) {
        this.setBotOffset(stateObj.bot_offset);
      }
      if (stateObj.watchlist_file_meta !== undefined) {
        this.setWatchlistFileMeta(stateObj.watchlist_file_meta);
      } else {
        this.setWatchlistFileMeta({ hash: '', keys: [] });
      }

      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }
}

module.exports = { RadarDB, buildFtsMatchQuery, getWatchDedupKey };
