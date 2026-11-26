(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CloudRadarEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function buildDownloadUrl(fileCode, rawFilename) {
    const safeName = encodeURIComponent(String(rawFilename || ''))
      .replace(/%28/g, '(')
      .replace(/%29/g, ')')
      .replace(/%2B/g, '+')
      .replace(/%2C/g, ',')
      .replace(/%5B/g, '[')
      .replace(/%5D/g, ']');
    return `https://dailyuploads.net/${fileCode}/${safeName}`;
  }

  function slugifyAppName(name) {
    return (
      String(name || '')
        .toLowerCase()
        .replace(/['’`]/g, '')
        .replace(/\+/g, ' plus ')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 120) || 'unknown-app'
    );
  }

  const PRERELEASE_RE = /^(?:alpha|beta|rc|pre|dev|a|b)$/i;

  function tokenizeVersion(v) {
    if (!v) return [];
    return String(v)
      .trim()
      .replace(/^v/i, '')
      .split(/[^a-zA-Z0-9]+/)
      .filter(Boolean)
      .map((part) =>
        /^\d+$/.test(part)
          ? { num: Number.parseInt(part, 10), isNum: true }
          : { str: part.toLowerCase(), isNum: false }
      );
  }

  function compareVersions(a, b) {
    const ta = tokenizeVersion(a);
    const tb = tokenizeVersion(b);
    const len = Math.max(ta.length, tb.length);
    for (let i = 0; i < len; i += 1) {
      const pa = ta[i];
      const pb = tb[i];
      if (!pa && pb) {
        if (!pb.isNum && PRERELEASE_RE.test(pb.str)) return 1;
        if (pb.isNum && pb.num === 0) continue;
        return -1;
      }
      if (pa && !pb) {
        if (!pa.isNum && PRERELEASE_RE.test(pa.str)) return -1;
        if (pa.isNum && pa.num === 0) continue;
        return 1;
      }
      if (pa.isNum && pb.isNum) {
        if (pa.num !== pb.num) return pa.num > pb.num ? 1 : -1;
      } else if (pa.isNum !== pb.isNum) {
        return pa.isNum ? 1 : -1;
      } else if (pa.str !== pb.str) {
        return pa.str > pb.str ? 1 : -1;
      }
    }
    return 0;
  }

  function csvCell(val) {
    let str = String(val ?? '');
    if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  }

  function computeEffectiveAge(uploadedDaysAgo, lastSeenAt, nowMs = Date.now()) {
    if (uploadedDaysAgo === null || uploadedDaysAgo === undefined) return null;
    const seenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
    if (!Number.isFinite(seenMs)) return uploadedDaysAgo;
    const extraDays = Math.max(0, Math.floor((nowMs - seenMs) / 86400000));
    return uploadedDaysAgo + extraDays;
  }

  function foldSearchText(str) {
    return String(str || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase();
  }

  function extractWordTokens(str) {
    return foldSearchText(str).match(/[\p{L}\p{N}]+/gu) || [];
  }

  function createMemoryStorage() {
    const map = new Map();
    return {
      getItem: (k) => (map.has(k) ? map.get(k) : null),
      setItem: (k, v) => map.set(k, String(v)),
      removeItem: (k) => map.delete(k),
    };
  }

  function detectGithubRepoFromLocation(loc) {
    if (!loc || !loc.hostname) return '';
    if (loc.hostname.endsWith('.github.io')) {
      const owner = loc.hostname.replace(/\.github\.io$/i, '');
      const parts = String(loc.pathname || '')
        .split('/')
        .filter(Boolean);
      if (owner && parts[0]) {
        return `${owner}/${parts[0]}`;
      }
    }
    return '';
  }

  function getBrowserStorageSafe() {
    try {
      if (typeof window !== 'undefined' && window.localStorage && typeof window.localStorage.getItem === 'function') {
        return window.localStorage;
      }
    } catch {
      // Blocked third-party storage or private mode restriction
    }
    return createMemoryStorage();
  }

  class CloudRadarEngine {
    constructor(options = {}) {
      this.storage = options.storage || getBrowserStorageSafe();
      this.fetchFn =
        options.fetchFn ||
        (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
      this.githubRepo =
        options.githubRepo ||
        this.storage.getItem('du_cloud_github_repo') ||
        detectGithubRepoFromLocation(typeof location !== 'undefined' ? location : null) ||
        '';

      this.state = {
        exported_at: null,
        sources: [],
        files: [],
        cloudWatchlist: [],
        cloudAlerts: [],
        sync_logs: [],
      };
      this.versionCountBySourceSlug = new Map();
      this._ephemeralSecrets = {
        telegram_bot_token: '',
        telegram_chat_id: '',
        webhook_url: '',
      };
      this._ghSyncChain = null;
      this._ghSyncDirty = false;
      this.lastFetchedAt = 0;
      this.lastSourceUrl = '';
    }

    /* ── Storage Helpers ──────────────────────────────────── */

    _readJson(key, fallback) {
      try {
        const raw = this.storage.getItem(key);
        return raw ? JSON.parse(raw) : fallback;
      } catch {
        return fallback;
      }
    }

    _writeJson(key, val) {
      this.storage.setItem(key, JSON.stringify(val));
    }

    getLocalWatchlist() {
      const arr = this._readJson('du_cloud_watchlist_v1', []);
      return Array.isArray(arr) ? arr : [];
    }

    saveLocalWatchlist(list) {
      this._writeJson('du_cloud_watchlist_v1', list);
    }

    getMutedCloudKeys() {
      const arr = this._readJson('du_cloud_muted_watches_v1', []);
      return new Set(Array.isArray(arr) ? arr : []);
    }

    saveMutedCloudKeys(set) {
      this._writeJson('du_cloud_muted_watches_v1', [...set]);
    }

    getReadAlertIds() {
      const arr = this._readJson('du_cloud_read_alerts_v1', []);
      return new Set(Array.isArray(arr) ? arr : []);
    }

    saveReadAlertIds(set) {
      this._writeJson('du_cloud_read_alerts_v1', [...set]);
    }

    getClearedAlertsBefore() {
      return this.storage.getItem('du_cloud_alerts_cleared_at') || '';
    }

    getBrowserAlerts() {
      const arr = this._readJson('du_cloud_browser_alerts_v1', []);
      return Array.isArray(arr) ? arr : [];
    }

    saveBrowserAlerts(list) {
      this._writeJson('du_cloud_browser_alerts_v1', list.slice(-200));
    }

    getCloudSettings() {
      const saved = this._readJson('du_cloud_settings_v1', {});
      // Scrub any legacy persisted notification secrets from localStorage
      if (saved.telegram_bot_token || saved.webhook_url) {
        delete saved.telegram_bot_token;
        delete saved.webhook_url;
        this._writeJson('du_cloud_settings_v1', saved);
      }
      return {
        github_repo: saved.github_repo || this.githubRepo || '',
        github_pat: saved.github_pat || '',
        sync_watchlist_to_github: Boolean(saved.sync_watchlist_to_github),
        telegram_bot_token: this._ephemeralSecrets.telegram_bot_token || '',
        telegram_chat_id: this._ephemeralSecrets.telegram_chat_id || saved.telegram_chat_id || '',
        webhook_url: this._ephemeralSecrets.webhook_url || '',
      };
    }

    updateCloudSettings(patch = {}) {
      const saved = this._readJson('du_cloud_settings_v1', {});
      if (patch.telegram_bot_token !== undefined) {
        this._ephemeralSecrets.telegram_bot_token = String(patch.telegram_bot_token).trim();
      }
      if (patch.telegram_chat_id !== undefined) {
        this._ephemeralSecrets.telegram_chat_id = String(patch.telegram_chat_id).trim();
      }
      if (patch.webhook_url !== undefined) {
        this._ephemeralSecrets.webhook_url = String(patch.webhook_url).trim();
      }

      const persisted = {
        github_repo:
          patch.github_repo !== undefined
            ? String(patch.github_repo).trim()
            : saved.github_repo || this.githubRepo || '',
        github_pat:
          patch.github_pat !== undefined ? String(patch.github_pat).trim() : saved.github_pat || '',
        sync_watchlist_to_github:
          patch.sync_watchlist_to_github !== undefined
            ? Boolean(patch.sync_watchlist_to_github)
            : Boolean(saved.sync_watchlist_to_github),
        telegram_chat_id:
          patch.telegram_chat_id !== undefined
            ? String(patch.telegram_chat_id).trim()
            : saved.telegram_chat_id || '',
      };
      if (persisted.github_repo) {
        this.githubRepo = persisted.github_repo;
        this.storage.setItem('du_cloud_github_repo', persisted.github_repo);
      }
      this._writeJson('du_cloud_settings_v1', persisted);
      return this.getCloudSettings();
    }

    /* ── State Hydration & Remote Loading ─────────────────── */

    loadStateObject(stateObj, nowMs = Date.now()) {
      if (!stateObj || typeof stateObj !== 'object') {
        throw new Error('Invalid cloud state payload');
      }

      const rawFiles = Array.isArray(stateObj.files) ? stateObj.files : [];
      const hydratedFiles = [];
      const vCounts = new Map();

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
            raw_days_ago,
            downloads,
            list_order,
            first_seen_at,
            last_seen_at,
            custom_url,
          ] = entry;
          f = {
            file_code,
            source_user: source_user || 'user_hidden',
            raw_filename,
            app_name,
            app_slug,
            version: version || '',
            platform: platform || 'Other',
            extension: extension || '',
            tags: Array.isArray(tags) ? tags : [],
            min_ios: min_ios ?? null,
            min_ios_label: min_ios_label ?? null,
            release_group: release_group || '',
            size_text: size_text || '',
            size_bytes: size_bytes || 0,
            raw_uploaded_days_ago: raw_days_ago ?? null,
            uploaded_days_ago: computeEffectiveAge(raw_days_ago ?? null, last_seen_at, nowMs),
            downloads: downloads || 0,
            list_order: list_order ?? i,
            first_seen_at: first_seen_at || '',
            last_seen_at: last_seen_at || '',
            download_url: custom_url || buildDownloadUrl(file_code, raw_filename),
          };
        } else if (entry && typeof entry === 'object') {
          f = {
            ...entry,
            source_user: entry.source_user || 'user_hidden',
            tags: Array.isArray(entry.tags) ? entry.tags : [],
            raw_uploaded_days_ago: entry.uploaded_days_ago ?? null,
            uploaded_days_ago: computeEffectiveAge(
              entry.uploaded_days_ago ?? null,
              entry.last_seen_at,
              nowMs
            ),
            download_url: entry.download_url || buildDownloadUrl(entry.file_code, entry.raw_filename),
            list_order: entry.list_order ?? i,
          };
        } else {
          continue;
        }

        const tagsLower = f.tags.map((t) => String(t).toLowerCase());
        const wordTokens = extractWordTokens(
          `${f.app_name} ${f.raw_filename} ${f.version} ${tagsLower.join(' ')} ${f.release_group}`
        );
        f._tagsLower = new Set(tagsLower);
        f._wordTokens = wordTokens;
        f._appLower = String(f.app_name || '').toLowerCase();
        f._rawLower = String(f.raw_filename || '').toLowerCase();
        f._appFolded = foldSearchText(f.app_name);
        f._rawFolded = foldSearchText(f.raw_filename);
        f._haystack = `${f._appLower} ${f._rawLower} ${tagsLower.join(' ')}`;
        f._foldedHaystack = `${f._appFolded} ${f._rawFolded} ${foldSearchText(tagsLower.join(' '))}`;

        const key = `${f.source_user}::${f.app_slug}`;
        vCounts.set(key, (vCounts.get(key) || 0) + 1);
        hydratedFiles.push(f);
      }

      // Compute active_files & active_apps per source
      const rawSources = Array.isArray(stateObj.sources) ? stateObj.sources : [];
      const sources = (rawSources.length > 0
        ? rawSources
        : [{ username: 'user_hidden', label: 'user_hidden', enabled: 1 }]
      ).map((s) => {
        const srcFiles = hydratedFiles.filter((f) => f.source_user === s.username);
        const uniqueApps = new Set(srcFiles.map((f) => f.app_slug));
        return {
          ...s,
          active_files: srcFiles.length,
          active_apps: uniqueApps.size,
        };
      });

      const incomingCloudWl = Array.isArray(stateObj.watchlist) ? stateObj.watchlist : [];
      this.versionCountBySourceSlug = vCounts;
      this.state = {
        exported_at: stateObj.exported_at || null,
        sources,
        files: hydratedFiles,
        cloudWatchlist: incomingCloudWl,
        cloudAlerts: Array.isArray(stateObj.alerts) ? stateObj.alerts : [],
        sync_logs: Array.isArray(stateObj.sync_logs) ? [...stateObj.sync_logs].reverse() : [],
      };

      // Reconcile muted cloud keys, overrides, & local rules that already landed in (or were deleted from) cloudWatchlist
      const cloudByKey = new Map(incomingCloudWl.map((w) => [this._watchDedupKey(w), w]));
      const cloudKeySet = new Set(cloudByKey.keys());
      const muted = this.getMutedCloudKeys();
      if (muted.size > 0) {
        let changedMuted = false;
        for (const k of [...muted]) {
          if (!cloudKeySet.has(k)) {
            muted.delete(k);
            changedMuted = true;
          }
        }
        if (changedMuted) this.saveMutedCloudKeys(muted);
      }

      const overrides = this.getCloudWatchOverrides();
      const ovKeys = Object.keys(overrides);
      if (ovKeys.length > 0) {
        let changedOv = false;
        for (const k of ovKeys) {
          const cw = cloudByKey.get(k);
          if (!cw) {
            delete overrides[k];
            changedOv = true;
          } else {
            const ov = overrides[k];
            const sameNotify =
              ov.notify_enabled === undefined || (cw.notify_enabled ? 1 : 0) === (ov.notify_enabled ? 1 : 0);
            const sameNotes = ov.notes === undefined || String(cw.notes || '') === String(ov.notes);
            if (sameNotify && sameNotes && !ov.display_name) {
              delete overrides[k];
              changedOv = true;
            }
          }
        }
        if (changedOv) this.saveCloudWatchOverrides(overrides);
      }

      const exportedMs = stateObj.exported_at ? Date.parse(stateObj.exported_at) : NaN;
      const localList = this.getLocalWatchlist();
      if (localList.length > 0) {
        const prunedLocal = localList.filter((lw) => {
          const k = this._watchDedupKey(lw);
          if (cloudKeySet.has(k) && !muted.has(k)) {
            return false; // Cloud state now owns this rule
          }
          if (
            lw.scope === 'cloud' &&
            lw.synced_at &&
            Number.isFinite(exportedMs) &&
            exportedMs > Date.parse(lw.synced_at) + 15000
          ) {
            return false; // Previously synced rule was deleted in Cloud (e.g. via Telegram /unwatch)
          }
          return true;
        });
        if (prunedLocal.length !== localList.length) {
          this.saveLocalWatchlist(prunedLocal);
        }
      }

      this._evaluateBrowserWatchUpdates();
      return this.state;
    }

    async _fetchWithTimeout(url, options = undefined, timeoutMs = 8000) {
      if (typeof AbortController !== 'function' || !timeoutMs || timeoutMs <= 0) {
        return options ? this.fetchFn(url, options) : this.fetchFn(url);
      }
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const mergedOpts = options ? { ...options, signal: ctrl.signal } : { signal: ctrl.signal };
        return await this.fetchFn(url, mergedOpts);
      } finally {
        clearTimeout(timer);
      }
    }

    async _resolveRadarStateCommitSha(repo, pat = '', timeoutMs = 5000) {
      if (!this.fetchFn || !repo) return '';
      try {
        // Append _=<ts> and cache: 'no-store' so api.github.com's default max-age=60 / s-maxage=60
        // never serves a cached pre-sync SHA during waitForCloudSync polling or manual refresh
        const apiUrl = `https://api.github.com/repos/${repo}/commits?sha=radar-state&per_page=1&_=${Date.now()}`;
        const opts = pat
          ? {
              cache: 'no-store',
              headers: {
                Authorization: `Bearer ${pat}`,
                Accept: 'application/vnd.github+json',
              },
            }
          : { cache: 'no-store' };
        const res = await this._fetchWithTimeout(apiUrl, opts, timeoutMs);
        if (!res.ok) return '';
        const data = await res.json();
        const sha = Array.isArray(data) ? data[0]?.sha : data?.sha;
        return typeof sha === 'string' && /^[0-9a-f]{40}$/i.test(sha) ? sha : '';
      } catch {
        return '';
      }
    }

    async _tryFetchStateFromUrl(url, timeoutMs) {
      // Intentionally send a simple CORS GET with no custom headers to avoid OPTIONS preflight on raw.githubusercontent.com / jsDelivr
      const res = await this._fetchWithTimeout(url, undefined, timeoutMs);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const json = await res.json();
      this.loadStateObject(json);
      this.lastFetchedAt = Date.now();
      this.lastSourceUrl = url;
      return {
        ok: true,
        sourceUrl: url,
        totalFiles: this.state.files.length,
        exportedAt: this.state.exported_at,
      };
    }

    async fetchRemoteState({ forceFresh = false, timeoutMs = 8000 } = {}) {
      if (!this.fetchFn) throw new Error('fetch is not available');
      const cfg = this.getCloudSettings();
      const repo = cfg.github_repo || this.githubRepo;
      const cacheKey = forceFresh ? Date.now() : Math.floor(Date.now() / 120000);
      const validRepo = Boolean(repo && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo));
      let lastErr = null;
      let attemptedSha = false;

      if (validRepo) {
        if (forceFresh) {
          // Resolve exact commit SHA on radar-state to bypass 5-minute Fastly / 7-day jsDelivr branch caches completely
          attemptedSha = true;
          const sha = await this._resolveRadarStateCommitSha(repo, cfg.github_pat, Math.min(5000, timeoutMs));
          if (sha) {
            for (const shaUrl of [
              `https://raw.githubusercontent.com/${repo}/${sha}/cloud-state.json`,
              `https://cdn.jsdelivr.net/gh/${repo}@${sha}/cloud-state.json`,
            ]) {
              try {
                return await this._tryFetchStateFromUrl(shaUrl, timeoutMs);
              } catch (err) {
                lastErr = err;
              }
            }
          }
        }

        // Primary branch raw URL (0 GitHub API quota on normal page loads when raw.githubusercontent.com is reachable)
        try {
          return await this._tryFetchStateFromUrl(
            `https://raw.githubusercontent.com/${repo}/radar-state/cloud-state.json?v=${cacheKey}`,
            timeoutMs
          );
        } catch (err) {
          lastErr = err;
        }

        // If raw.githubusercontent.com failed/timed out (e.g. ISP block) on initial load, resolve exact commit SHA
        // BEFORE falling back to jsDelivr so we never hit jsDelivr's 7-day @branch cache when SHA is available!
        if (!attemptedSha) {
          const sha = await this._resolveRadarStateCommitSha(repo, cfg.github_pat, Math.min(5000, timeoutMs));
          if (sha) {
            try {
              return await this._tryFetchStateFromUrl(
                `https://cdn.jsdelivr.net/gh/${repo}@${sha}/cloud-state.json`,
                timeoutMs
              );
            } catch (err) {
              lastErr = err;
            }
          }
        }

        try {
          return await this._tryFetchStateFromUrl(
            `https://cdn.jsdelivr.net/gh/${repo}@radar-state/cloud-state.json`,
            timeoutMs
          );
        } catch (err) {
          lastErr = err;
        }
      }

      for (const localUrl of [
        `./data/cloud-state.json?v=${cacheKey}`,
        `../data/cloud-state.json?v=${cacheKey}`,
      ]) {
        try {
          return await this._tryFetchStateFromUrl(localUrl, timeoutMs);
        } catch (err) {
          lastErr = err;
        }
      }
      throw lastErr || new Error('Failed to load cloud catalog data.');
    }

    async waitForCloudSync(previousExportedAt, { timeoutMs = 45000, intervalMs = 3500, onPoll } = {}) {
      const start = Date.now();
      let attempt = 0;
      while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, intervalMs));
        attempt += 1;
        if (onPoll) {
          onPoll({ attempt, elapsedMs: Date.now() - start, timeoutMs });
        }
        try {
          await this.fetchRemoteState({ forceFresh: true });
          if (this.state.exported_at && this.state.exported_at !== previousExportedAt) {
            return { completed: true, elapsedMs: Date.now() - start, exportedAt: this.state.exported_at };
          }
        } catch {
          // Continue polling until timeout
        }
      }
      return { completed: false, elapsedMs: Date.now() - start, exportedAt: this.state.exported_at };
    }

    /* ── Watchlist Merging & Browser Alert Detection ──────── */

    _watchDedupKey(w) {
      const type = w.watch_type === 'keyword' ? 'keyword' : 'app';
      const target =
        type === 'keyword' ? String(w.keyword || '').toLowerCase() : String(w.target_slug || '');
      return `${type}::${target}::${w.platform_filter || ''}`;
    }

    getCloudWatchOverrides() {
      const obj = this._readJson('du_cloud_watch_overrides_v1', {});
      return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
    }

    saveCloudWatchOverrides(obj) {
      this._writeJson('du_cloud_watch_overrides_v1', obj);
    }

    getCombinedWatchRules() {
      const muted = this.getMutedCloudKeys();
      const overrides = this.getCloudWatchOverrides();
      const map = new Map();

      for (const cw of this.state.cloudWatchlist) {
        const key = this._watchDedupKey(cw);
        if (muted.has(key)) continue;
        const ov = overrides[key] || {};
        map.set(key, {
          ...cw,
          ...(ov.notify_enabled !== undefined ? { notify_enabled: ov.notify_enabled ? 1 : 0 } : {}),
          ...(ov.notes !== undefined ? { notes: String(ov.notes) } : {}),
          ...(ov.display_name ? { display_name: String(ov.display_name) } : {}),
          id: `cloud_${cw.id}`,
          scope: 'cloud',
        });
      }

      for (const lw of this.getLocalWatchlist()) {
        const key = this._watchDedupKey(lw);
        if (!map.has(key)) {
          map.set(key, { ...lw, scope: lw.scope || 'browser' });
        }
      }

      return [...map.values()].sort((a, b) =>
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      );
    }

    getAppWatchRules() {
      return this.getCombinedWatchRules().filter((w) => w.watch_type === 'app' && w.target_slug);
    }

    isFileWatched(f, appWatches = null) {
      const rules = appWatches || this.getAppWatchRules();
      return rules.some(
        (w) =>
          w.target_slug === f.app_slug &&
          (!w.platform_filter || w.platform_filter === f.platform) &&
          (!w.source_user || w.source_user === f.source_user)
      );
    }

    getWatchedSlugSet() {
      const set = new Set();
      for (const w of this.getAppWatchRules()) {
        set.add(w.target_slug);
      }
      return set;
    }

    _evaluateBrowserWatchUpdates() {
      const localList = this.getLocalWatchlist();
      if (localList.length === 0 || this.state.files.length === 0) return;

      const browserAlerts = this.getBrowserAlerts();
      const existingKeys = new Set(browserAlerts.map((a) => `${a.watch_id}::${a.file_code}`));
      let mutatedWatch = false;
      let addedAlert = false;

      for (const w of localList) {
        if (!w.notify_enabled) continue;
        const latest = this._findLatestForWatch(w);
        if (!latest) continue;

        if (!w.last_known_file_code) {
          w.last_known_file_code = latest.file_code;
          w.last_known_version = latest.version || '';
          mutatedWatch = true;
          continue;
        }

        if (latest.file_code !== w.last_known_file_code) {
          const isNewer =
            !w.last_known_version ||
            !latest.version ||
            compareVersions(latest.version, w.last_known_version) > 0 ||
            latest.first_seen_at > (w.created_at || '');
          if (isNewer) {
            const alertKey = `${w.id}::${latest.file_code}`;
            if (!existingKeys.has(alertKey)) {
              browserAlerts.push({
                id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                watch_id: w.id,
                watch_name: w.display_name,
                file_code: latest.file_code,
                source_user: latest.source_user,
                app_name: latest.app_name,
                app_slug: latest.app_slug,
                old_version: w.last_known_version || '',
                new_version: latest.version || '',
                raw_filename: latest.raw_filename,
                download_url: latest.download_url,
                size_text: latest.size_text || '',
                platform: latest.platform || '',
                is_read: 0,
                created_at: latest.first_seen_at || new Date().toISOString(),
              });
              existingKeys.add(alertKey);
              addedAlert = true;
            }
            w.last_known_version = latest.version || w.last_known_version;
            w.last_known_file_code = latest.file_code;
            mutatedWatch = true;
          }
        }
      }

      if (mutatedWatch) this.saveLocalWatchlist(localList);
      if (addedAlert) this.saveBrowserAlerts(browserAlerts);
    }

    _findLatestForWatch(w) {
      if (w.watch_type === 'app' && w.target_slug) {
        const candidates = this.state.files
          .filter(
            (f) =>
              f.app_slug === w.target_slug &&
              (!w.platform_filter || f.platform === w.platform_filter) &&
              (!w.source_user || f.source_user === w.source_user)
          )
          .sort((a, b) => a.list_order - b.list_order);
        return candidates[0] || null;
      }
      if (w.watch_type === 'keyword' && w.keyword) {
        const res = this.searchFiles({
          q: w.keyword,
          platform: w.platform_filter || 'all',
          source: w.source_user || 'all',
          limit: 1,
          sort: 'newest',
        });
        return res.items[0] || null;
      }
      return null;
    }

    /* ── Filtering, Search, Grouping & Sorting ────────────── */

    _matchesWatchRule(f, w) {
      if (w.source_user && w.source_user !== f.source_user) return false;
      if (w.platform_filter && w.platform_filter !== f.platform) return false;
      if (w.watch_type === 'app') {
        return Boolean(w.target_slug) && f.app_slug === w.target_slug;
      }
      const terms = foldSearchText(w.keyword || '')
        .split(/\s+/)
        .filter(Boolean);
      if (terms.length === 0) return false;
      const hay = f._foldedHaystack || foldSearchText(f._haystack || '');
      return terms.every((t) => hay.includes(t));
    }

    _filterFiles(params = {}) {
      const source = params.source && params.source !== 'all' ? params.source : '';
      const platform = params.platform && params.platform !== 'all' ? params.platform : '';
      const ext =
        params.extension && params.extension !== 'all'
          ? String(params.extension).toLowerCase()
          : '';
      const tag = params.tag && params.tag !== 'all' ? String(params.tag).toLowerCase() : '';
      const relGroup =
        params.releaseGroup && params.releaseGroup !== 'all'
          ? String(params.releaseGroup).toLowerCase()
          : '';
      const maxIos =
        params.maxIos !== undefined && params.maxIos !== '' && params.maxIos !== 'all'
          ? Number.parseFloat(params.maxIos)
          : NaN;
      const maxDays =
        params.maxDays !== undefined && params.maxDays !== '' && params.maxDays !== 'all'
          ? Number.parseInt(params.maxDays, 10)
          : NaN;
      const minBytes =
        params.minSizeMb !== undefined && params.minSizeMb !== ''
          ? Math.round(Number.parseFloat(params.minSizeMb) * 1024 * 1024)
          : NaN;
      const maxBytes =
        params.maxSizeMb !== undefined && params.maxSizeMb !== ''
          ? Math.round(Number.parseFloat(params.maxSizeMb) * 1024 * 1024)
          : NaN;
      const watchedOnly =
        params.watchedOnly === true || params.watchedOnly === 'true' || params.watchedOnly === '1';
      const watchRules = watchedOnly ? this.getCombinedWatchRules() : null;

      const q = String(params.q || '').trim();
      const qLower = q.toLowerCase();
      const qFolded = foldSearchText(q);
      const qTokens = q ? extractWordTokens(q) : [];
      const requireSubstring = Boolean(q) && (qTokens.length === 0 || /[+#@]/.test(q));

      return this.state.files.filter((f) => {
        if (source && f.source_user !== source) return false;
        if (platform && f.platform !== platform) return false;
        if (ext && f.extension.toLowerCase() !== ext) return false;
        if (tag && !f._tagsLower.has(tag)) return false;
        if (relGroup && f.release_group.toLowerCase() !== relGroup) return false;
        if (Number.isFinite(maxIos) && (f.min_ios === null || f.min_ios > maxIos)) return false;
        if (
          Number.isFinite(maxDays) &&
          (f.uploaded_days_ago === null || f.uploaded_days_ago > maxDays)
        ) {
          return false;
        }
        if (Number.isFinite(minBytes) && minBytes >= 0 && f.size_bytes < minBytes) return false;
        if (Number.isFinite(maxBytes) && maxBytes >= 0 && f.size_bytes > maxBytes) return false;
        if (
          watchedOnly &&
          (watchRules.length === 0 || !watchRules.some((w) => this._matchesWatchRule(f, w)))
        ) {
          return false;
        }

        if (qTokens.length > 0) {
          const allMatch = qTokens.every((qt) =>
            f._wordTokens.some((wt) => wt.startsWith(qt))
          );
          if (!allMatch) return false;
        }
        if (requireSubstring) {
          const matchesRaw = f._appLower.includes(qLower) || f._rawLower.includes(qLower);
          const matchesFolded = f._appFolded.includes(qFolded) || f._rawFolded.includes(qFolded);
          if (!matchesRaw && !matchesFolded) return false;
        }
        return true;
      });
    }

    _toPublicItem(f, appWatches, extra = {}) {
      const key = `${f.source_user}::${f.app_slug}`;
      return {
        file_code: f.file_code,
        source_user: f.source_user,
        raw_filename: f.raw_filename,
        app_name: f.app_name,
        app_slug: f.app_slug,
        version: f.version,
        platform: f.platform,
        extension: f.extension,
        tags: f.tags,
        min_ios: f.min_ios,
        min_ios_label: f.min_ios_label,
        release_group: f.release_group,
        size_text: f.size_text,
        size_bytes: f.size_bytes,
        uploaded_days_ago: f.uploaded_days_ago,
        downloads: f.downloads,
        download_url: f.download_url,
        list_order: f.list_order,
        first_seen_at: f.first_seen_at,
        last_seen_at: f.last_seen_at,
        is_active: 1,
        is_watched: this.isFileWatched(f, appWatches),
        version_count: this.versionCountBySourceSlug.get(key) || 1,
        ...extra,
      };
    }

    searchFiles(params = {}) {
      const page = Math.max(1, Number.parseInt(params.page, 10) || 1);
      const maxLimit = Math.min(10000, Math.max(1, Number.parseInt(params.maxLimit, 10) || 200));
      const limit = Math.min(maxLimit, Math.max(1, Number.parseInt(params.limit, 10) || 40));
      const offset = (page - 1) * limit;
      const grouped =
        params.grouped === true || params.grouped === 'true' || params.grouped === '1';
      const sort = String(params.sort || 'newest');
      const appWatches = this.getAppWatchRules();

      const filtered = this._filterFiles(params);

      const compareItems = (a, b, isGrouped) => {
        if (sort === 'oldest') {
          const da = a.uploaded_days_ago ?? -1;
          const db = b.uploaded_days_ago ?? -1;
          if (da !== db) return db - da;
          return b.list_order - a.list_order;
        }
        if (sort === 'downloads') {
          const dla = isGrouped ? a.total_downloads : a.downloads;
          const dlb = isGrouped ? b.total_downloads : b.downloads;
          if (dla !== dlb) return dlb - dla;
          return a.list_order - b.list_order;
        }
        if (sort === 'name_asc') {
          const cmp = a.app_name.toLowerCase().localeCompare(b.app_name.toLowerCase());
          return cmp !== 0 ? cmp : a.list_order - b.list_order;
        }
        if (sort === 'name_desc') {
          const cmp = b.app_name.toLowerCase().localeCompare(a.app_name.toLowerCase());
          return cmp !== 0 ? cmp : a.list_order - b.list_order;
        }
        if (sort === 'size_desc') {
          if (a.size_bytes !== b.size_bytes) return b.size_bytes - a.size_bytes;
          return a.list_order - b.list_order;
        }
        if (sort === 'size_asc') {
          if (a.size_bytes !== b.size_bytes) return a.size_bytes - b.size_bytes;
          return a.list_order - b.list_order;
        }
        // Default: newest
        const da = a.uploaded_days_ago ?? 99999;
        const db = b.uploaded_days_ago ?? 99999;
        if (da !== db) return da - db;
        return a.list_order - b.list_order;
      };

      if (!grouped) {
        const items = filtered
          .map((f) => this._toPublicItem(f, appWatches))
          .sort((a, b) => compareItems(a, b, false));
        const total = items.length;
        return {
          items: items.slice(offset, offset + limit),
          total,
          page,
          limit,
          totalPages: Math.max(1, Math.ceil(total / limit)),
          grouped: false,
        };
      }

      const groupMap = new Map();
      for (const f of filtered) {
        const gKey = `${f.source_user}::${f.app_slug}`;
        const cur = groupMap.get(gKey);
        if (!cur) {
          groupMap.set(gKey, {
            rep: f,
            total_downloads: f.downloads || 0,
            max_downloads: f.downloads || 0,
          });
        } else {
          cur.total_downloads += f.downloads || 0;
          if ((f.downloads || 0) > cur.max_downloads) cur.max_downloads = f.downloads || 0;
          if (
            f.list_order < cur.rep.list_order ||
            (f.list_order === cur.rep.list_order && f.file_code < cur.rep.file_code)
          ) {
            cur.rep = f;
          }
        }
      }

      const groupedItems = [...groupMap.values()]
        .map((g) =>
          this._toPublicItem(g.rep, appWatches, {
            total_downloads: g.total_downloads,
            max_downloads: g.max_downloads,
          })
        )
        .sort((a, b) => compareItems(a, b, true));

      const total = groupedItems.length;
      return {
        items: groupedItems.slice(offset, offset + limit),
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
        grouped: true,
      };
    }

    getAppVersions(appSlug, sourceUser = '') {
      const appWatches = this.getAppWatchRules();
      return this.state.files
        .filter((f) => f.app_slug === appSlug && (!sourceUser || f.source_user === sourceUser))
        .sort((a, b) => a.list_order - b.list_order)
        .map((f) => this._toPublicItem(f, appWatches));
    }

    getFacets(sourceUser = 'all') {
      const files =
        sourceUser && sourceUser !== 'all'
          ? this.state.files.filter((f) => f.source_user === sourceUser)
          : this.state.files;

      const platMap = new Map();
      const extMap = new Map();
      const relMap = new Map();
      const tagMap = new Map();

      for (const f of files) {
        platMap.set(f.platform, (platMap.get(f.platform) || 0) + 1);
        if (f.extension) extMap.set(f.extension, (extMap.get(f.extension) || 0) + 1);
        if (f.release_group) relMap.set(f.release_group, (relMap.get(f.release_group) || 0) + 1);
        for (const t of f.tags) {
          tagMap.set(t, (tagMap.get(t) || 0) + 1);
        }
      }

      const toSorted = (m, lim = 100) =>
        [...m.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, lim)
          .map(([name, count]) => ({ name, count }));

      return {
        platforms: toSorted(platMap),
        extensions: toSorted(extMap),
        releaseGroups: toSorted(relMap, 20),
        tags: toSorted(tagMap, 30),
      };
    }

    getStats() {
      const files = this.state.files;
      const appSlugs = new Set();
      let totalSizeBytes = 0;
      let totalDownloads = 0;
      let uploadedToday = 0;
      let uploadedWeek = 0;

      for (const f of files) {
        appSlugs.add(f.app_slug);
        totalSizeBytes += f.size_bytes || 0;
        totalDownloads += f.downloads || 0;
        if (f.uploaded_days_ago === 0) uploadedToday += 1;
        if (f.uploaded_days_ago !== null && f.uploaded_days_ago <= 7) uploadedWeek += 1;
      }

      const topDownloaded = [...files]
        .sort((a, b) => b.downloads - a.downloads || a.list_order - b.list_order)
        .slice(0, 10)
        .map((f) => ({
          file_code: f.file_code,
          app_name: f.app_name,
          app_slug: f.app_slug,
          version: f.version,
          platform: f.platform,
          downloads: f.downloads,
          size_text: f.size_text,
          download_url: f.download_url,
        }));

      const bySlug = new Map();
      for (const f of files) {
        const cur = bySlug.get(f.app_slug);
        if (!cur) {
          bySlug.set(f.app_slug, {
            app_slug: f.app_slug,
            app_name: f.app_name,
            versions: 1,
            max_downloads: f.downloads || 0,
          });
        } else {
          cur.versions += 1;
          if (f.app_name < cur.app_name) cur.app_name = f.app_name;
          if ((f.downloads || 0) > cur.max_downloads) cur.max_downloads = f.downloads || 0;
        }
      }
      const multiVersionApps = [...bySlug.values()]
        .filter((x) => x.versions > 1)
        .sort((a, b) => b.versions - a.versions || b.max_downloads - a.max_downloads)
        .slice(0, 10);

      const alertsInfo = this.listAlerts({ limit: 200 });
      return {
        total_files: files.length,
        total_apps: appSlugs.size,
        total_size_bytes: totalSizeBytes,
        total_downloads: totalDownloads,
        uploaded_today: uploadedToday,
        uploaded_week: uploadedWeek,
        watchlist_count: this.getCombinedWatchRules().length,
        unread_alerts: alertsInfo.unread_count,
        sources: this.state.sources,
        top_downloaded: topDownloaded,
        multi_version_apps: multiVersionApps,
        sync: {
          isSyncing: false,
          running: [],
          sources: this.state.sources,
          recentLogs: this.state.sync_logs.slice(0, 10),
        },
        cloud_mode: true,
        exported_at: this.state.exported_at,
      };
    }

    exportCatalog(params = {}) {
      const format = String(params.format || 'csv').toLowerCase();
      const res = this.searchFiles({ ...params, page: 1, limit: 5000, maxLimit: 10000 });
      if (format === 'json') {
        return {
          filename: 'dailyuploads-export.json',
          mime: 'application/json; charset=utf-8',
          content: JSON.stringify(res.items, null, 2),
        };
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
      for (const it of res.items) {
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
      return {
        filename: 'dailyuploads-export.csv',
        mime: 'text/csv; charset=utf-8',
        content: lines.join('\r\n'),
      };
    }

    /* ── Watchlist & Alerts CRUD (Cloud + Browser) ────────── */

    listWatchlist() {
      const allAlerts = this.listAlerts({ limit: 200 }).items;
      return this.getCombinedWatchRules().map((w) => {
        const latest = this._findLatestForWatch(w);
        const alertCount = allAlerts.filter(
          (a) =>
            String(a.watch_id) === String(w.id) ||
            (w.target_slug && a.app_slug === w.target_slug)
        ).length;
        return {
          ...w,
          latest_file: latest
            ? {
                file_code: latest.file_code,
                app_name: latest.app_name,
                version: latest.version,
                size_text: latest.size_text,
                uploaded_days_ago: latest.uploaded_days_ago,
                downloads: latest.downloads,
                download_url: latest.download_url,
                platform: latest.platform,
              }
            : null,
          alert_count: alertCount,
        };
      });
    }

    addWatch(body = {}) {
      const type = body.watch_type === 'keyword' ? 'keyword' : 'app';
      let slug = String(body.target_slug || '').trim();
      const kw = String(body.keyword || '').trim();
      let name = String(body.display_name || '').trim();
      const platformFilter = String(body.platform_filter || '').trim();
      const sourceUser = String(body.source_user || '').trim();
      const notes = String(body.notes || '').trim();

      if (type === 'app') {
        if (!slug && name) slug = slugifyAppName(name);
        if (!slug) throw new Error('target_slug or display_name is required.');
      } else if (!kw) {
        throw new Error('Keyword is required.');
      }

      const candidate = {
        watch_type: type,
        target_slug: type === 'app' ? slug : '',
        keyword: type === 'keyword' ? kw : '',
        platform_filter: platformFilter,
        source_user: sourceUser,
      };
      const key = this._watchDedupKey(candidate);

      // Unmute if it was previously muted from cloud
      const muted = this.getMutedCloudKeys();
      if (muted.has(key)) {
        muted.delete(key);
        this.saveMutedCloudKeys(muted);
      }

      const existing = this.getCombinedWatchRules().find((w) => this._watchDedupKey(w) === key);
      if (existing) {
        return { item: existing, created: false };
      }

      const latest = this._findLatestForWatch(candidate);
      if (!name) name = latest?.app_name || (type === 'keyword' ? kw : slug);

      const newRule = {
        id: `local_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        watch_type: type,
        target_slug: type === 'app' ? slug : '',
        keyword: type === 'keyword' ? kw : '',
        display_name: name,
        platform_filter: platformFilter,
        source_user: sourceUser,
        last_known_version: latest?.version || '',
        last_known_file_code: latest?.file_code || '',
        notes,
        notify_enabled: body.notify_enabled !== undefined ? (body.notify_enabled ? 1 : 0) : 1,
        created_at: new Date().toISOString(),
        scope: 'browser',
      };

      const local = this.getLocalWatchlist();
      local.push(newRule);
      this.saveLocalWatchlist(local);
      return { item: newRule, created: true };
    }

    updateWatch(id, patch = {}) {
      const strId = String(id);
      if (strId.startsWith('cloud_')) {
        const rawCloudId = strId.slice('cloud_'.length);
        const cw = this.state.cloudWatchlist.find((w) => String(w.id) === rawCloudId);
        if (cw) {
          const key = this._watchDedupKey(cw);
          const overrides = this.getCloudWatchOverrides();
          const curOv = overrides[key] || {};
          overrides[key] = {
            ...curOv,
            ...(patch.notify_enabled !== undefined ? { notify_enabled: patch.notify_enabled ? 1 : 0 } : {}),
            ...(patch.notes !== undefined ? { notes: String(patch.notes) } : {}),
            ...(patch.display_name !== undefined && String(patch.display_name).trim()
              ? { display_name: String(patch.display_name).trim() }
              : {}),
          };
          this.saveCloudWatchOverrides(overrides);
          return this.getCombinedWatchRules().find((w) => String(w.id) === strId) || null;
        }
      }

      const local = this.getLocalWatchlist();
      const idx = local.findIndex((w) => String(w.id) === strId);
      if (idx !== -1) {
        const cur = local[idx];
        local[idx] = {
          ...cur,
          notify_enabled:
            patch.notify_enabled !== undefined ? (patch.notify_enabled ? 1 : 0) : cur.notify_enabled,
          notes: patch.notes !== undefined ? String(patch.notes) : cur.notes,
          platform_filter:
            patch.platform_filter !== undefined ? String(patch.platform_filter) : cur.platform_filter,
          display_name:
            patch.display_name !== undefined && String(patch.display_name).trim()
              ? String(patch.display_name).trim()
              : cur.display_name,
        };
        this.saveLocalWatchlist(local);
        return local[idx];
      }
      return null;
    }

    removeWatch(id) {
      const strId = String(id);
      if (strId.startsWith('cloud_')) {
        const rawCloudId = strId.slice('cloud_'.length);
        const cw = this.state.cloudWatchlist.find((w) => String(w.id) === rawCloudId);
        if (cw) {
          const key = this._watchDedupKey(cw);
          const muted = this.getMutedCloudKeys();
          muted.add(key);
          this.saveMutedCloudKeys(muted);
          const overrides = this.getCloudWatchOverrides();
          if (overrides[key]) {
            delete overrides[key];
            this.saveCloudWatchOverrides(overrides);
          }
          return true;
        }
      }
      const local = this.getLocalWatchlist();
      const next = local.filter((w) => String(w.id) !== strId);
      if (next.length !== local.length) {
        this.saveLocalWatchlist(next);
        return true;
      }
      return false;
    }

    removeWatchBySlug(slug) {
      let removed = false;
      for (const cw of this.state.cloudWatchlist) {
        if (cw.watch_type === 'app' && cw.target_slug === slug) {
          const muted = this.getMutedCloudKeys();
          muted.add(this._watchDedupKey(cw));
          this.saveMutedCloudKeys(muted);
          removed = true;
        }
      }
      const local = this.getLocalWatchlist();
      const next = local.filter((w) => !(w.watch_type === 'app' && w.target_slug === slug));
      if (next.length !== local.length) {
        this.saveLocalWatchlist(next);
        removed = true;
      }
      return removed;
    }

    importWatchlist(items = []) {
      if (!Array.isArray(items)) throw new Error('Import payload must be a JSON array.');
      let added = 0;
      let skipped = 0;
      for (const raw of items) {
        if (!raw || typeof raw !== 'object') continue;
        try {
          const res = this.addWatch(raw);
          if (res.created) added += 1;
          else skipped += 1;
        } catch {
          skipped += 1;
        }
      }
      return { added, skipped };
    }

    exportWatchlistJson() {
      const list = this.getCombinedWatchRules().map((w) => ({
        watch_type: w.watch_type,
        target_slug: w.target_slug || '',
        keyword: w.keyword || '',
        display_name: w.display_name,
        platform_filter: w.platform_filter || '',
        source_user: w.source_user || '',
        notes: w.notes || '',
        notify_enabled: w.notify_enabled ? 1 : 0,
      }));
      return {
        filename: 'dailyuploads-watchlist.json',
        mime: 'application/json; charset=utf-8',
        content: JSON.stringify(list, null, 2),
      };
    }

    listAlerts({ unreadOnly = false, limit = 50 } = {}) {
      const clearedBefore = this.getClearedAlertsBefore();
      const readIds = this.getReadAlertIds();

      const merged = [
        ...this.state.cloudAlerts.map((a) => ({ ...a, id: `cloud_${a.id}` })),
        ...this.getBrowserAlerts(),
      ]
        .filter((a) => !clearedBefore || String(a.created_at || '') > clearedBefore)
        .map((a) => ({
          ...a,
          is_read: a.is_read || readIds.has(String(a.id)) ? 1 : 0,
        }))
        .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));

      const unreadCount = merged.filter((a) => !a.is_read).length;
      const filtered = unreadOnly ? merged.filter((a) => !a.is_read) : merged;
      const lim = Math.min(200, Math.max(1, Number.parseInt(limit, 10) || 50));
      return { items: filtered.slice(0, lim), unread_count: unreadCount };
    }

    markAlertRead(id) {
      const readIds = this.getReadAlertIds();
      readIds.add(String(id));
      this.saveReadAlertIds(readIds);
      return true;
    }

    markAllAlertsRead() {
      const readIds = this.getReadAlertIds();
      const all = this.listAlerts({ limit: 200 }).items;
      let count = 0;
      for (const a of all) {
        if (!readIds.has(String(a.id))) {
          readIds.add(String(a.id));
          count += 1;
        }
      }
      this.saveReadAlertIds(readIds);
      return count;
    }

    clearAlerts() {
      this.storage.setItem('du_cloud_alerts_cleared_at', new Date().toISOString());
      this.saveBrowserAlerts([]);
    }

    /* ── Optional GitHub Cloud Sync & Telegram Test ───────── */

    async syncWatchlistToGithub() {
      // Serialize & coalesce rapid watch/unwatch clicks so concurrent PUTs never hit GitHub HTTP 409 Conflict
      this._ghSyncDirty = true;
      if (this._ghSyncChain) {
        return this._ghSyncChain;
      }

      this._ghSyncChain = (async () => {
        let lastResult = { synced: false };
        while (this._ghSyncDirty) {
          this._ghSyncDirty = false;
          lastResult = await this._pushWatchlistToGithubOnce();
        }
        return lastResult;
      })().finally(() => {
        this._ghSyncChain = null;
      });

      return this._ghSyncChain;
    }

    async _pushWatchlistToGithubOnce() {
      const cfg = this.getCloudSettings();
      if (!cfg.github_pat || !cfg.github_repo) return { synced: false };

      const apiUrl = `https://api.github.com/repos/${cfg.github_repo}/contents/watchlist.json`;
      const headers = {
        Authorization: `Bearer ${cfg.github_pat}`,
        Accept: 'application/vnd.github+json',
      };

      let sha = undefined;
      const getRes = await this.fetchFn(apiUrl, { headers });
      if (getRes.ok) {
        const existing = await getRes.json();
        sha = existing.sha;
      }

      const syncedAt = new Date().toISOString();
      const items = JSON.parse(this.exportWatchlistJson().content);
      const payloadJson = JSON.stringify(
        {
          authoritative: true,
          updated_at: syncedAt,
          items,
        },
        null,
        2
      );
      const b64 =
        typeof btoa === 'function'
          ? btoa(unescape(encodeURIComponent(payloadJson)))
          : Buffer.from(payloadJson, 'utf8').toString('base64');

      const putRes = await this.fetchFn(apiUrl, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'chore(watchlist): update watchlist rules from Cloud Web UI',
          content: b64,
          ...(sha ? { sha } : {}),
        }),
      });

      if (!putRes.ok) {
        const errData = await putRes.json().catch(() => ({}));
        throw new Error(errData.message || `GitHub API HTTP ${putRes.status}`);
      }

      // Mark local rules as synced to cloud with timestamp for later reconciliation
      const local = this.getLocalWatchlist().map((w) => ({
        ...w,
        scope: 'cloud',
        synced_at: syncedAt,
      }));
      this.saveLocalWatchlist(local);
      return { synced: true };
    }

    async triggerGithubWorkflow(mode = 'quick') {
      const cfg = this.getCloudSettings();
      if (!cfg.github_pat || !cfg.github_repo) return { dispatched: false };

      const url = `https://api.github.com/repos/${cfg.github_repo}/actions/workflows/radar-sync.yml/dispatches`;
      const res = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.github_pat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { mode: ['auto', 'quick', 'full'].includes(mode) ? mode : 'quick' },
        }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.message || `GitHub Actions HTTP ${res.status}`);
      }
      return { dispatched: true };
    }

    async detectTelegramChatId(token) {
      const cleanToken = String(token || '').trim();
      if (!cleanToken) {
        throw new Error('Paste your Telegram Bot Token from @BotFather first.');
      }

      const meRes = await this.fetchFn(
        `https://api.telegram.org/bot${encodeURIComponent(cleanToken)}/getMe`
      );
      const meData = await meRes.json().catch(() => ({}));
      if (!meRes.ok || meData.ok === false) {
        throw new Error(meData.description || `Invalid Bot Token (HTTP ${meRes.status})`);
      }
      const botUsername = meData.result?.username || 'bot';

      // Call getUpdates WITHOUT offset so pending commands on Telegram's queue are NOT consumed
      const updRes = await this.fetchFn(
        `https://api.telegram.org/bot${encodeURIComponent(cleanToken)}/getUpdates?limit=20&timeout=0`
      );
      const updData = await updRes.json().catch(() => ({}));
      if (!updRes.ok || updData.ok === false) {
        throw new Error(updData.description || `Failed to read getUpdates (HTTP ${updRes.status})`);
      }

      const seenChats = new Map();
      const updates = Array.isArray(updData.result) ? updData.result : [];
      for (const u of updates) {
        const chat = u.message?.chat || u.callback_query?.message?.chat;
        if (chat?.id !== undefined) {
          seenChats.set(String(chat.id), chat.title || chat.first_name || chat.username || String(chat.id));
        }
      }

      const chatIds = [...seenChats.keys()];
      if (chatIds.length > 0) {
        this.updateCloudSettings({ telegram_chat_id: chatIds.join(', ') });
      }

      return {
        ok: true,
        botUsername,
        chatIds,
        chats: [...seenChats.entries()].map(([id, label]) => ({ id, label })),
      };
    }

    async sendTelegramBrowserTest(token, chatId) {
      const cleanToken = String(token || '').trim();
      const cleanChats = String(chatId || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!cleanToken || cleanChats.length === 0) {
        throw new Error('Enter both Telegram Bot Token and Chat ID first.');
      }

      for (const cid of cleanChats) {
        const body = new URLSearchParams({
          chat_id: cid,
          parse_mode: 'HTML',
          disable_web_page_preview: 'true',
          text: [
            '🔔 <b>DailyUploads Radar Cloud — Test Successful!</b>',
            '',
            'Your Bot Token &amp; Chat ID connection is valid.',
            'Save both values to <b>GitHub Repository Secrets</b> (<code>TELEGRAM_BOT_TOKEN</code> &amp; <code>TELEGRAM_CHAT_ID</code>) so GitHub Actions sends 24/7 update notifications automatically!',
          ].join('\n'),
        });
        const res = await this.fetchFn(
          `https://api.telegram.org/bot${encodeURIComponent(cleanToken)}/sendMessage`,
          { method: 'POST', body }
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          throw new Error(data.description || `Telegram HTTP ${res.status}`);
        }
      }
      return { ok: true, channel: 'telegram' };
    }

    async sendWebhookBrowserTest(webhookUrl) {
      const cleanUrl = String(webhookUrl || '').trim();
      if (!cleanUrl) {
        throw new Error('Enter a Webhook URL first.');
      }
      const isDiscord = /discord(?:app)?\.com\/api\/webhooks\//i.test(cleanUrl);
      const payload = isDiscord
        ? {
            username: 'DailyUploads Radar',
            content: '🔔 **DailyUploads Radar Cloud — Webhook Test Successful!**',
            embeds: [
              {
                title: 'Spotify-Shrubify (v9.2.1 → v9.2.2)',
                url: 'https://dailyuploads.net/users/user_hidden',
                color: 0x3b82f6,
                description:
                  'Save this Webhook URL as `WEBHOOK_URL` in **GitHub Repository Secrets** for automated 24/7 update alerts!',
              },
            ],
          }
        : {
            event: 'dailyuploads.test',
            timestamp: new Date().toISOString(),
            message: 'DailyUploads Radar Cloud Webhook Test OK',
          };

      const res = await this.fetchFn(cleanUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`Webhook HTTP ${res.status}: ${txt.slice(0, 140)}`);
      }
      return { ok: true, channel: 'webhook' };
    }
  }

  return {
    CloudRadarEngine,
    buildDownloadUrl,
    compareVersions,
    computeEffectiveAge,
    csvCell,
    detectGithubRepoFromLocation,
    slugifyAppName,
  };
});
