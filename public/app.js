(() => {
  'use strict';

  const HIGHLIGHT_TAGS = new Set(['VIP', 'Pro', 'Premium', 'Subscribed', 'Unlocked', 'Incl. DLC']);
  const MOD_TAGS = new Set(['Unsigned', 'TNT', 'MacKed', 'U2B', 'TrollStore', 'Creator Ed', 'Modded']);
  const VALID_TABS = new Set(['catalog', 'watchlist', 'alerts', 'insights', 'settings']);
  const VALID_SORTS = new Set([
    'newest',
    'oldest',
    'downloads',
    'name_asc',
    'name_desc',
    'size_desc',
    'size_asc',
  ]);

  function safeStorageGet(key, fallback) {
    try {
      return localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function safeStorageSet(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch {
      // Ignore private-mode storage restrictions
    }
  }

  function safeStorageRemove(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore
    }
  }

  // Clean up legacy language preference key so UI is uniformly English
  safeStorageRemove('du_lang');

  const state = {
    tab: 'catalog',
    viewMode: safeStorageGet('du_view_mode', 'grid'),
    theme: safeStorageGet('du_theme', 'dark'),
    q: '',
    source: 'all',
    platform: 'all',
    extension: 'all',
    tag: 'all',
    maxIos: 'all',
    maxDays: 'all',
    sizeRange: 'all',
    watchedOnly: false,
    grouped: true,
    sort: 'newest',
    page: 1,
    limit: 36,
    facets: null,
    stats: null,
    lastSearch: null,
    modalSlug: null,
    modalAppName: '',
    modalIsWatched: false,
    isCloudMode: false,
  };

  let cloudEngine = null;

  const $ = (id) => document.getElementById(id);

  function downloadBlobFile(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      a.remove();
      URL.revokeObjectURL(url);
    }, 100);
  }

  function esc(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatBytesHuman(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let idx = 0;
    let val = bytes;
    while (val >= 1024 && idx < units.length - 1) {
      val /= 1024;
      idx += 1;
    }
    return `${idx === 0 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`;
  }

  function formatRelativeTime(iso) {
    if (!iso) return 'Never';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return `${sec}s ago`;
    const min = Math.floor(sec / 60);
    if (min < 60) return `${min}m ago`;
    const hr = Math.floor(min / 60);
    if (hr < 24) {
      const remMin = min % 60;
      return hr < 6 && remMin > 0 ? `${hr}h ${remMin}m ago` : `${hr}h ago`;
    }
    const d = Math.floor(hr / 24);
    return `${d}d ago`;
  }

  function formatClockTime(iso) {
    if (!iso) return '';
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function formatAge(days) {
    if (days === null || days === undefined) return '—';
    if (days === 0) return 'Today';
    if (days === 1) return '1d ago';
    return `${days}d ago`;
  }

  /* ── URL State Deep-Linking & Clipboard Helper ────────── */

  async function copyTextToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to execCommand fallback (e.g. non-HTTPS LAN / WebKit restrictions)
      }
    }
    const ta = document.createElement('textarea');
    ta.value = String(text ?? '');
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    } finally {
      ta.remove();
    }
    if (!copied) throw new Error('Clipboard access denied');
    return true;
  }

  function setSelectValueSafe(selectEl, desiredVal, fallbackVal = 'all') {
    if (!selectEl) return fallbackVal;
    const hasMatch = Array.from(selectEl.options).some((o) => o.value === desiredVal);
    const finalVal = hasMatch ? desiredVal : fallbackVal;
    selectEl.value = finalVal;
    return finalVal;
  }

  function hydrateStateFromUrl() {
    try {
      const qs = new URLSearchParams(window.location.search);
      const tab = qs.get('tab');
      state.tab = tab && VALID_TABS.has(tab) ? tab : 'catalog';
      state.q = qs.has('q') ? qs.get('q').trim() : '';
      state.source = qs.get('source') || 'all';
      state.platform = qs.get('platform') || 'all';
      state.extension = qs.get('ext') || 'all';
      state.tag = qs.get('tag') || 'all';
      state.maxIos = qs.get('ios') || 'all';
      state.maxDays = qs.get('days') || 'all';
      state.sizeRange = qs.get('size') || 'all';
      state.watchedOnly = qs.get('watched') === '1' || qs.get('watched') === 'true';
      state.grouped = !(qs.get('grouped') === '0' || qs.get('grouped') === 'false');
      const sort = qs.get('sort');
      state.sort = sort && VALID_SORTS.has(sort) ? sort : 'newest';
      const p = Number.parseInt(qs.get('page'), 10);
      state.page = Number.isFinite(p) && p > 1 ? p : 1;
    } catch {
      // Ignore malformed URL params
    }
  }

  function syncDomControlsFromState() {
    if ($('searchInput')) $('searchInput').value = state.q;
    if ($('btnClearSearch')) $('btnClearSearch').classList.toggle('hidden', !state.q);
    if ($('btnWatchQuery')) $('btnWatchQuery').classList.toggle('hidden', !state.q);
    if ($('searchKbdHint')) $('searchKbdHint').classList.toggle('hidden', Boolean(state.q));
    state.sort = setSelectValueSafe($('filterSort'), state.sort, 'newest');
    state.maxIos = setSelectValueSafe($('filterMaxIos'), state.maxIos, 'all');
    state.maxDays = setSelectValueSafe($('filterMaxDays'), state.maxDays, 'all');
    state.sizeRange = setSelectValueSafe($('filterSize'), state.sizeRange, 'all');
    if ($('toggleGrouped')) $('toggleGrouped').checked = state.grouped;
    if ($('toggleWatchedOnly')) $('toggleWatchedOnly').checked = state.watchedOnly;

    document.querySelectorAll('.nav-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === state.tab);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${state.tab}`);
    });
  }

  function buildShareableUrlParams() {
    const qs = new URLSearchParams();
    if (state.tab !== 'catalog') qs.set('tab', state.tab);
    if (state.q) qs.set('q', state.q);
    if (state.source !== 'all') qs.set('source', state.source);
    if (state.platform !== 'all') qs.set('platform', state.platform);
    if (state.extension !== 'all') qs.set('ext', state.extension);
    if (state.tag !== 'all') qs.set('tag', state.tag);
    if (state.maxIos !== 'all') qs.set('ios', state.maxIos);
    if (state.maxDays !== 'all') qs.set('days', state.maxDays);
    if (state.sizeRange !== 'all') qs.set('size', state.sizeRange);
    if (state.watchedOnly) qs.set('watched', '1');
    if (!state.grouped) qs.set('grouped', '0');
    if (state.sort !== 'newest') qs.set('sort', state.sort);
    if (state.page > 1) qs.set('page', String(state.page));
    return qs;
  }

  function syncUrlFromState() {
    try {
      if (window.location.protocol === 'file:') return;
      const qs = buildShareableUrlParams().toString();
      const nextUrl = `${window.location.pathname}${qs ? `?${qs}` : ''}${window.location.hash || ''}`;
      const curUrl = `${window.location.pathname}${window.location.search}${window.location.hash || ''}`;
      if (nextUrl !== curUrl) {
        window.history.replaceState(null, '', nextUrl);
      }
    } catch {
      // Ignore history API errors in restricted contexts
    }
  }

  /* ── Cloud / Local API Adapter ────────────────────────── */

  async function cloudApi(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const urlObj = new URL(path, 'http://localhost');
    const pathname = decodeURIComponent(urlObj.pathname);
    const qs = urlObj.searchParams;
    const body = options.body ? JSON.parse(options.body) : {};

    if (method === 'GET' && pathname === '/api/stats') {
      return cloudEngine.getStats();
    }
    if (method === 'GET' && pathname === '/api/facets') {
      return cloudEngine.getFacets(qs.get('source') || 'all');
    }
    if (method === 'GET' && pathname === '/api/files') {
      return cloudEngine.searchFiles({
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
    }
    const appVerMatch = pathname.match(/^\/api\/apps\/([^/]+)\/versions$/);
    if (method === 'GET' && appVerMatch) {
      return {
        slug: appVerMatch[1],
        versions: cloudEngine.getAppVersions(appVerMatch[1], qs.get('source') || ''),
      };
    }
    if (method === 'GET' && pathname === '/api/watchlist') {
      return { items: cloudEngine.listWatchlist() };
    }
    if (method === 'POST' && pathname === '/api/watchlist') {
      const res = cloudEngine.addWatch(body);
      if (cloudEngine.getCloudSettings().github_pat) {
        try {
          await cloudEngine.syncWatchlistToGithub();
          res.syncedToCloud = true;
        } catch (err) {
          toast(`GitHub sync failed: ${err.message}`, 'warn');
        }
      }
      return res;
    }
    if (method === 'POST' && pathname === '/api/watchlist/import') {
      const items = Array.isArray(body) ? body : body.items;
      const res = cloudEngine.importWatchlist(items);
      if (cloudEngine.getCloudSettings().github_pat) {
        await cloudEngine
          .syncWatchlistToGithub()
          .catch((err) => toast(`GitHub sync failed: ${err.message}`, 'warn'));
      }
      return { ok: true, ...res };
    }
    const wlSlugMatch = pathname.match(/^\/api\/watchlist\/by-slug\/([^/]+)$/);
    if (method === 'DELETE' && wlSlugMatch) {
      const removed = cloudEngine.removeWatchBySlug(wlSlugMatch[1]);
      if (cloudEngine.getCloudSettings().github_pat) {
        await cloudEngine
          .syncWatchlistToGithub()
          .catch((err) => toast(`GitHub sync failed: ${err.message}`, 'warn'));
      }
      return { ok: true, removed };
    }
    const wlIdMatch = pathname.match(/^\/api\/watchlist\/([^/]+)$/);
    if (wlIdMatch) {
      if (method === 'PATCH') {
        const updated = cloudEngine.updateWatch(wlIdMatch[1], body);
        if (cloudEngine.getCloudSettings().github_pat) {
          await cloudEngine
            .syncWatchlistToGithub()
            .catch((err) => toast(`GitHub sync failed: ${err.message}`, 'warn'));
        }
        return { item: updated };
      }
      if (method === 'DELETE') {
        cloudEngine.removeWatch(wlIdMatch[1]);
        if (cloudEngine.getCloudSettings().github_pat) {
          await cloudEngine
            .syncWatchlistToGithub()
            .catch((err) => toast(`GitHub sync failed: ${err.message}`, 'warn'));
        }
        return { ok: true };
      }
    }
    if (method === 'GET' && pathname === '/api/alerts') {
      return cloudEngine.listAlerts({
        unreadOnly: qs.get('unreadOnly') === 'true' || qs.get('unreadOnly') === '1',
        limit: qs.get('limit') || 50,
      });
    }
    if (method === 'POST' && pathname === '/api/alerts/read-all') {
      return { ok: true, marked: cloudEngine.markAllAlertsRead() };
    }
    const alertReadMatch = pathname.match(/^\/api\/alerts\/([^/]+)\/read$/);
    if (method === 'POST' && alertReadMatch) {
      return { ok: cloudEngine.markAlertRead(alertReadMatch[1]) };
    }
    if (method === 'DELETE' && pathname === '/api/alerts') {
      cloudEngine.clearAlerts();
      return { ok: true };
    }
    if (method === 'GET' && pathname === '/api/settings') {
      const cfg = cloudEngine.getCloudSettings();
      return {
        settings: {
          sync_interval_minutes: 15,
          windows_toast_enabled: false,
          telegram_bot_token: cfg.telegram_bot_token,
          telegram_chat_id: cfg.telegram_chat_id,
          telegram_bot_enabled: true,
          webhook_url: cfg.webhook_url,
        },
        telegram: { running: false, cloudMode: true },
        cloud: cfg,
      };
    }
    if (method === 'PUT' && pathname === '/api/settings') {
      const next = cloudEngine.updateCloudSettings({
        telegram_bot_token: body.telegram_bot_token,
        telegram_chat_id: body.telegram_chat_id,
        webhook_url: body.webhook_url,
      });
      return { settings: next, telegram: { running: false, cloudMode: true } };
    }
    if (method === 'POST' && pathname === '/api/notifications/test') {
      if (body.channel === 'telegram') {
        return cloudEngine.sendTelegramBrowserTest(body.telegram_bot_token, body.telegram_chat_id);
      }
      if (body.channel === 'webhook') {
        return cloudEngine.sendWebhookBrowserTest(body.webhook_url);
      }
      throw new Error('Windows Toast is only available when running the local Windows server.');
    }
    if (method === 'POST' && pathname === '/api/sources') {
      throw new Error('In Cloud Mode, configure additional sources via GitHub Repository Variables → EXTRA_SOURCES.');
    }
    throw new Error(`Endpoint ${pathname} is only available on the local server.`);
  }

  async function api(path, options = {}) {
    if (state.isCloudMode && cloudEngine) {
      return cloudApi(path, options);
    }
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options,
    });
    const text = await res.text();
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return data;
  }

  function toast(message, type = 'info') {
    const stack = $('toastStack');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.25s';
      setTimeout(() => el.remove(), 260);
    }, 3800);
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    $('btnTheme').textContent = state.theme === 'dark' ? '☀️' : '🌙';
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', state.theme === 'dark' ? '#0b0f19' : '#f1f5f9');
    }
  }

  function updateSyncButtonsUI() {
    const qLabel = $('btnQuickSyncLabel');
    const fLabel = $('btnFullSyncLabel');
    const qBtn = $('btnQuickSync');
    const fBtn = $('btnFullSync');
    if (!qLabel || !fLabel || !qBtn || !fBtn) return;

    if (!state.isCloudMode || !cloudEngine) {
      qLabel.textContent = 'Quick Sync';
      qBtn.title = 'Check DailyUploads page 1 for new uploads (~1–2s)';
      fLabel.textContent = 'Full';
      fBtn.title = 'Re-scrape entire DailyUploads catalog (~7s)';
      return;
    }

    const cfg = cloudEngine.getCloudSettings();
    const hasPat = Boolean(cfg.github_pat && cfg.github_repo);
    if (hasPat) {
      qLabel.textContent = 'Cloud Sync';
      qBtn.title = 'Dispatch GitHub Actions quick sync & load fresh catalog';
      fLabel.textContent = 'Full';
      fBtn.title = 'Dispatch GitHub Actions full catalog resync';
    } else {
      qLabel.textContent = 'Refresh';
      qBtn.title = 'Reload latest cloud catalog snapshot (bypasses CDN cache)';
      fLabel.textContent = '⚡ Actions';
      fBtn.title = 'Open GitHub Actions to trigger a manual cloud scrape (or add a GitHub Token in Settings)';
    }
  }

  function buildFilterQueryParams(extra = {}) {
    const params = new URLSearchParams();
    if (state.q) params.set('q', state.q);
    if (state.source !== 'all') params.set('source', state.source);
    if (state.platform !== 'all') params.set('platform', state.platform);
    if (state.extension !== 'all') params.set('extension', state.extension);
    if (state.tag !== 'all') params.set('tag', state.tag);
    if (state.maxIos !== 'all') params.set('maxIos', state.maxIos);
    if (state.maxDays !== 'all') params.set('maxDays', state.maxDays);
    if (state.sizeRange !== 'all') {
      const [minMb, maxMb] = state.sizeRange.split('-');
      if (minMb) params.set('minSizeMb', minMb);
      if (maxMb) params.set('maxSizeMb', maxMb);
    }
    if (state.watchedOnly) params.set('watchedOnly', 'true');
    params.set('grouped', state.grouped ? 'true' : 'false');
    params.set('sort', state.sort);
    params.set('page', String(extra.page ?? state.page));
    params.set('limit', String(extra.limit ?? state.limit));
    for (const [k, v] of Object.entries(extra)) {
      if (k !== 'page' && k !== 'limit' && v !== undefined) params.set(k, String(v));
    }
    return params;
  }

  /* ── Data Loaders ─────────────────────────────────────── */

  function refreshLastSyncDisplay() {
    const st = state.stats;
    if (!st) return;
    const firstSource = st.sources?.[0];
    const lastIso = firstSource?.last_sync_at || st.exported_at || '';
    $('kpiLastSync').textContent = lastIso ? formatRelativeTime(lastIso) : 'Syncing...';
    $('kpiLastSync').title = lastIso ? new Date(lastIso).toLocaleString() : '';

    const subEl = $('kpiLastSyncSub');
    if (subEl) {
      const clock = formatClockTime(lastIso);
      if (state.isCloudMode) {
        subEl.textContent = clock ? `Auto ~15m • ${clock}` : 'Auto ~15m (Cloud)';
      } else {
        subEl.textContent = clock ? `Synced at ${clock}` : '';
      }
    }
  }

  async function loadStats() {
    const st = await api('/api/stats');
    state.stats = st;
    $('kpiTotalFiles').textContent = (st.total_files || 0).toLocaleString();
    $('kpiTotalApps').textContent = (st.total_apps || 0).toLocaleString();
    $('kpiToday').textContent = (st.uploaded_today || 0).toLocaleString();
    $('kpiWatched').textContent = (st.watchlist_count || 0).toLocaleString();
    refreshLastSyncDisplay();

    const firstSource = st.sources?.[0];
    if (firstSource) {
      $('sourceHeaderLink').href = `https://dailyuploads.net/users/${encodeURIComponent(firstSource.username)}`;
      $('sourceHeaderLink').textContent = `${firstSource.username} ↗`;
    }

    $('navWatchCount').textContent = String(st.watchlist_count || 0);
    const unreadEl = $('navUnreadCount');
    if (st.unread_alerts > 0) {
      unreadEl.textContent = String(st.unread_alerts);
      unreadEl.classList.remove('hidden');
    } else {
      unreadEl.classList.add('hidden');
    }

    // Source dropdown visibility if > 1 source
    const srcWrap = $('sourceFilterWrap');
    const srcSel = $('filterSource');
    if (st.sources && st.sources.length > 1) {
      srcWrap.classList.remove('hidden');
      srcSel.innerHTML =
        `<option value="all">All Sources</option>` +
        st.sources
          .map((s) => `<option value="${esc(s.username)}">${esc(s.username)} (${s.active_files})</option>`)
          .join('');
      state.source = setSelectValueSafe(srcSel, state.source, 'all');
    } else {
      srcWrap.classList.add('hidden');
      if (state.source !== 'all' && st.sources?.[0]?.username !== state.source) {
        state.source = 'all';
      }
    }

    if (st.sync?.isSyncing && st.sync.running?.length > 0) {
      showSyncBanner(st.sync.running[0]);
    }
  }

  async function loadFacets() {
    const f = await api(`/api/facets?source=${encodeURIComponent(state.source)}`);
    state.facets = f;

    // Platform pills
    const totalPlat = (f.platforms || []).reduce((acc, p) => acc + p.count, 0);
    const pillsHtml = [
      `<button class="pill ${state.platform === 'all' ? 'active' : ''}" data-platform="all">All <span class="pill-cnt">${totalPlat}</span></button>`,
      ...(f.platforms || []).map(
        (p) =>
          `<button class="pill ${state.platform === p.name ? 'active' : ''}" data-platform="${esc(p.name)}">${esc(p.name)} <span class="pill-cnt">${p.count}</span></button>`
      ),
    ].join('');
    $('platformPills').innerHTML = pillsHtml;

    // Extension select
    const extSel = $('filterExt');
    extSel.innerHTML =
      `<option value="all">All Formats</option>` +
      (f.extensions || [])
        .map((e) => `<option value="${esc(e.name)}">.${esc(e.name)} (${e.count})</option>`)
        .join('');
    if (state.extension !== 'all' && !Array.from(extSel.options).some((o) => o.value === state.extension)) {
      const opt = document.createElement('option');
      opt.value = state.extension;
      opt.textContent = `.${state.extension}`;
      extSel.appendChild(opt);
    }
    extSel.value = state.extension;

    // Tag select
    const tagSel = $('filterTag');
    tagSel.innerHTML =
      `<option value="all">All Tags</option>` +
      (f.tags || [])
        .map((t) => `<option value="${esc(t.name)}">${esc(t.name)} (${t.count})</option>`)
        .join('');
    syncTagSelectUI();
  }

  function syncTagSelectUI() {
    const tagSel = $('filterTag');
    if (state.tag && state.tag !== 'all') {
      const hasOpt = Array.from(tagSel.options).some((o) => o.value === state.tag);
      if (!hasOpt) {
        const opt = document.createElement('option');
        opt.value = state.tag;
        opt.textContent = state.tag;
        tagSel.appendChild(opt);
      }
    }
    tagSel.value = state.tag;
    syncQuickChipUI();
  }

  let searchSeq = 0;
  async function loadFiles() {
    syncUrlFromState();
    const seq = ++searchSeq;
    const params = buildFilterQueryParams();
    const res = await api(`/api/files?${params.toString()}`);
    if (seq !== searchSeq) return;
    state.lastSearch = res;
    renderCatalog(res);
  }

  function renderCatalog(res) {
    const container = $('catalogContainer');
    const summary = $('resultsSummary');

    const start = res.total === 0 ? 0 : (res.page - 1) * res.limit + 1;
    const end = Math.min(res.total, res.page * res.limit);
    const unit = res.grouped ? 'apps' : 'files';
    summary.textContent =
      res.total === 0
        ? `0 ${unit}`
        : `Showing ${start}–${end} of ${res.total.toLocaleString()} ${unit}`;

    if (!res.items || res.items.length === 0) {
      container.className = '';
      const hasQuery = Boolean(state.q);
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${state.stats?.total_files === 0 ? '🛰️' : '🔍'}</div>
          <h3>${state.stats?.total_files === 0 ? 'Syncing initial catalog...' : 'No matching apps found'}</h3>
          <p>${
            state.stats?.total_files === 0
              ? 'Please wait a few seconds while DailyUploads catalog finishes syncing, or trigger a Full Sync.'
              : hasQuery
                ? `No uploads match "${esc(state.q)}" yet. Click "Watch Keyword" above to get notified automatically as soon as it gets uploaded!`
                : 'Try adjusting or resetting your search filters.'
          }</p>
        </div>
      `;
      $('paginationBar').innerHTML = '';
      return;
    }

    if (state.viewMode === 'table') {
      container.className = 'table-wrap';
      container.innerHTML = `
        <table class="data-table">
          <thead>
            <tr>
              <th>App</th>
              <th>Version</th>
              <th>Platform</th>
              <th>Size</th>
              <th>Min iOS</th>
              <th>Uploaded</th>
              <th>DL</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${res.items.map(renderTableRow).join('')}
          </tbody>
        </table>
      `;
    } else {
      container.className = 'cards-grid';
      container.innerHTML = res.items.map(renderAppCard).join('');
    }

    renderPagination(res);
  }

  function tagBadgeClass(tag) {
    if (HIGHLIGHT_TAGS.has(tag)) return 'tag-pill tag-highlight';
    if (MOD_TAGS.has(tag)) return 'tag-pill tag-mod';
    return 'tag-pill';
  }

  function renderAppCard(item) {
    const ver = item.version ? `v${item.version}` : `.${item.extension || 'file'}`;
    const vCount = item.version_count || 1;
    const dlCount = item.total_downloads ?? item.downloads ?? 0;
    const isToday = item.uploaded_days_ago === 0;
    const tags = (item.tags || []).slice(0, 7);

    return `
      <article class="app-card ${item.is_watched ? 'is-watched' : ''}">
        <div class="card-top">
          <div class="app-title-wrap">
            <h3 class="app-title" data-open-versions="${esc(item.app_slug)}" data-app-name="${esc(item.app_name)}">${esc(item.app_name)}</h3>
            <div class="app-subrow">
              ${isToday ? '<span class="new-badge">NEW</span>' : ''}
              <span class="ver-badge">${esc(ver)}</span>
              <span class="plat-badge plat-${esc(item.platform)}">${esc(item.platform)}</span>
              ${
                vCount > 1
                  ? `<button class="builds-btn" data-open-versions="${esc(item.app_slug)}" data-app-name="${esc(item.app_name)}">${vCount} builds</button>`
                  : `<span class="muted-text">.${esc(item.extension)}</span>`
              }
            </div>
          </div>
          <button
            class="btn btn-amber btn-xs ${item.is_watched ? 'watched' : ''}"
            data-toggle-watch="${esc(item.app_slug)}"
            data-app-name="${esc(item.app_name)}"
            data-watched="${item.is_watched ? '1' : '0'}"
            title="${item.is_watched ? 'Remove from Watchlist' : 'Watch this app for new versions'}"
          >
            ${item.is_watched ? '⭐ Watched' : '🔔 Watch'}
          </button>
        </div>

        <div class="meta-row">
          <span class="meta-item">📦 ${esc(item.size_text || '—')}</span>
          <span class="meta-item ${isToday ? 'meta-today' : ''}">🕒 ${esc(formatAge(item.uploaded_days_ago))}</span>
          <span class="meta-item">⬇️ ${dlCount}</span>
          ${item.min_ios_label ? `<span class="meta-item">📱 ${esc(item.min_ios_label)}+</span>` : ''}
        </div>

        ${
          tags.length > 0
            ? `<div class="tags-row">
                ${tags.map((t) => `<span class="${tagBadgeClass(t)}" data-filter-tag="${esc(t)}">${esc(t)}</span>`).join('')}
              </div>`
            : ''
        }

        <div class="raw-filename" title="${esc(item.raw_filename)}">${esc(item.raw_filename)}</div>

        <div class="card-actions">
          <button class="btn btn-ghost btn-xs" data-open-versions="${esc(item.app_slug)}" data-app-name="${esc(item.app_name)}">
            📋 Details${vCount > 1 ? ` (${vCount})` : ''}
          </button>
          <button class="btn btn-ghost btn-xs" data-copy-url="${esc(item.download_url)}">🔗 Copy</button>
          <span class="spacer"></span>
          <a class="btn btn-primary btn-xs" href="${esc(item.download_url)}" target="_blank" rel="noopener noreferrer">Download ↗</a>
        </div>
      </article>
    `;
  }

  function renderTableRow(item) {
    const ver = item.version ? `v${item.version}` : '—';
    const vCount = item.version_count || 1;
    const dlCount = item.total_downloads ?? item.downloads ?? 0;
    const isToday = item.uploaded_days_ago === 0;
    return `
      <tr>
        <td>
          <div class="app-title" style="font-size:13.5px" data-open-versions="${esc(item.app_slug)}" data-app-name="${esc(item.app_name)}">
            ${isToday ? '<span class="new-badge" style="margin-right:4px">NEW</span>' : ''}${esc(item.app_name)} ${vCount > 1 ? `<span class="builds-btn">${vCount} builds</span>` : ''}
          </div>
          <div class="raw-filename" style="max-width:340px" title="${esc(item.raw_filename)}">${esc(item.raw_filename)}</div>
        </td>
        <td><span class="ver-badge">${esc(ver)}</span></td>
        <td><span class="plat-badge plat-${esc(item.platform)}">${esc(item.platform)}</span></td>
        <td>${esc(item.size_text || '—')}</td>
        <td>${item.min_ios_label ? `${esc(item.min_ios_label)}+` : '—'}</td>
        <td class="${isToday ? 'meta-today' : ''}">${esc(formatAge(item.uploaded_days_ago))}</td>
        <td>${dlCount}</td>
        <td>
          <div style="display:flex;gap:5px;flex-wrap:nowrap">
            <button class="btn btn-amber btn-xs ${item.is_watched ? 'watched' : ''}" data-toggle-watch="${esc(item.app_slug)}" data-app-name="${esc(item.app_name)}" data-watched="${item.is_watched ? '1' : '0'}" title="${item.is_watched ? 'Unwatch' : 'Watch'}">${item.is_watched ? '⭐' : '🔔'}</button>
            <button class="btn btn-ghost btn-xs" data-copy-url="${esc(item.download_url)}" title="Copy Download Link">🔗</button>
            <a class="btn btn-primary btn-xs" href="${esc(item.download_url)}" target="_blank" rel="noopener noreferrer" title="Download">↗</a>
          </div>
        </td>
      </tr>
    `;
  }

  function renderPagination(res) {
    const bar = $('paginationBar');
    if (res.totalPages <= 1) {
      bar.innerHTML = '';
      return;
    }
    const p = res.page;
    const max = res.totalPages;
    const pages = new Set([1, max, p, p - 1, p + 1, p - 2, p + 2].filter((n) => n >= 1 && n <= max));
    const sorted = [...pages].sort((a, b) => a - b);

    const btns = [`<button class="page-btn" data-page="${p - 1}" ${p <= 1 ? 'disabled' : ''}>‹ Prev</button>`];
    let prev = 0;
    for (const num of sorted) {
      if (prev && num - prev > 1) btns.push(`<span class="muted-text">…</span>`);
      btns.push(`<button class="page-btn ${num === p ? 'active' : ''}" data-page="${num}">${num}</button>`);
      prev = num;
    }
    btns.push(`<button class="page-btn" data-page="${p + 1}" ${p >= max ? 'disabled' : ''}>Next ›</button>`);
    bar.innerHTML = btns.join('');
  }

  /* ── Watchlist Tab ────────────────────────────────────── */

  async function loadWatchlist() {
    const { items } = await api('/api/watchlist');
    const box = $('watchlistContainer');
    if (!items || items.length === 0) {
      box.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">⭐</div>
          <h3>Your watchlist is empty</h3>
          <p>Click <b>🔔 Watch</b> on any app card in the Catalog tab, or add a keyword rule above to start tracking new releases automatically!</p>
        </div>
      `;
      return;
    }

    box.innerHTML = items
      .map((w) => {
        const lf = w.latest_file;
        const latestVer = lf?.version
          ? `v${lf.version}`
          : w.last_known_version
            ? `v${w.last_known_version}`
            : 'No matching upload yet';
        const scopeBadge = state.isCloudMode
          ? w.scope === 'cloud'
            ? '<span class="tag-pill tag-highlight" title="Saved in GitHub Cloud — 24/7 push alerts active">☁️ Cloud 24/7</span>'
            : '<span class="tag-pill" title="Saved in this browser. Send /watch to your Telegram Bot or Push to GitHub in Settings for 24/7 mobile alerts">🌐 Browser</span>'
          : '';
        const tgCmd = `/watch ${w.watch_type === 'keyword' ? w.keyword : w.display_name}`;
        return `
          <div class="list-card">
            <div class="list-card-main">
              <div class="list-card-title">
                <span>${w.watch_type === 'keyword' ? '🔎' : '📦'} ${esc(w.display_name)}</span>
                <span class="ver-badge">${esc(w.watch_type === 'keyword' ? `Keyword: ${w.keyword}` : 'App')}</span>
                ${scopeBadge}
                ${w.platform_filter ? `<span class="plat-badge plat-${esc(w.platform_filter)}">${esc(w.platform_filter)}</span>` : ''}
                ${w.alert_count > 0 ? `<span class="tag-pill tag-highlight">${w.alert_count} alert${w.alert_count === 1 ? '' : 's'}</span>` : ''}
              </div>
              <div class="meta-row mt-12" style="margin-top:6px">
                <span>Latest version: <b>${esc(latestVer)}</b></span>
                ${lf ? `<span>• ${esc(lf.size_text)} • ${esc(formatAge(lf.uploaded_days_ago))}</span>` : ''}
                ${w.notes ? `<span>• 📝 ${esc(w.notes)}</span>` : ''}
              </div>
            </div>
            <div class="list-card-actions">
              ${
                lf
                  ? `<a class="btn btn-primary btn-xs" href="${esc(lf.download_url)}" target="_blank" rel="noopener noreferrer">Download Latest ↗</a>`
                  : ''
              }
              <button class="btn btn-ghost btn-xs" data-search-watch="${esc(w.watch_type === 'keyword' ? w.keyword : w.display_name)}">🔍 View in Catalog</button>
              ${
                state.isCloudMode && w.scope !== 'cloud'
                  ? `<button class="btn btn-ghost btn-xs" data-copy-url="${esc(tgCmd)}" title="Copy /watch command to send to your Telegram Bot">📲 Copy /watch</button>`
                  : ''
              }
              <button class="btn btn-ghost btn-xs" data-toggle-notify="${esc(w.id)}" data-enabled="${w.notify_enabled}">
                ${w.notify_enabled ? '🔔 Alerts ON' : '🔕 Alerts OFF'}
              </button>
              <button class="btn btn-danger-ghost btn-xs" data-del-watch="${esc(w.id)}">🗑 Remove</button>
            </div>
          </div>
        `;
      })
      .join('');
  }

  /* ── Alerts Tab ───────────────────────────────────────── */

  async function loadAlerts() {
    const { items, unread_count } = await api('/api/alerts?limit=100');
    const unreadEl = $('navUnreadCount');
    if (unread_count > 0) {
      unreadEl.textContent = String(unread_count);
      unreadEl.classList.remove('hidden');
    } else {
      unreadEl.classList.add('hidden');
    }

    const box = $('alertsContainer');
    if (!items || items.length === 0) {
      box.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔔</div>
          <h3>No update notifications yet</h3>
          <p>Whenever an app or keyword on your Watchlist receives a new upload on DailyUploads, version comparisons and download links will appear here!</p>
        </div>
      `;
      return;
    }

    box.innerHTML = items
      .map((a) => {
        const diff =
          a.old_version && a.new_version && a.old_version !== a.new_version
            ? `v${a.old_version} → v${a.new_version}`
            : a.new_version
              ? `v${a.new_version}`
              : 'New Upload';
        return `
          <div class="list-card ${a.is_read ? '' : 'unread'}">
            <div class="list-card-main">
              <div class="list-card-title">
                <span>${a.is_read ? '📦' : '🆕'} ${esc(a.app_name)}</span>
                <span class="ver-badge">${esc(diff)}</span>
                <span class="plat-badge plat-${esc(a.platform)}">${esc(a.platform)}</span>
              </div>
              <div class="meta-row" style="margin-top:6px">
                <span>Rule: <b>${esc(a.watch_name)}</b></span>
                <span>• ${esc(a.size_text || '—')}</span>
                <span>• ${esc(formatRelativeTime(a.created_at))}</span>
              </div>
              <div class="raw-filename" style="margin-top:4px">${esc(a.raw_filename)}</div>
            </div>
            <div class="list-card-actions">
              <a class="btn btn-primary btn-xs" href="${esc(a.download_url)}" target="_blank" rel="noopener noreferrer">Download ↗</a>
              ${!a.is_read ? `<button class="btn btn-ghost btn-xs" data-read-alert="${esc(a.id)}">✓ Mark Read</button>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }

  /* ── Insights & Sources Tab ───────────────────────────── */

  async function loadInsights() {
    const st = await api('/api/stats');
    state.stats = st;

    if ($('insCatalogSize')) $('insCatalogSize').textContent = formatBytesHuman(st.total_size_bytes || 0);
    if ($('insTotalDownloads')) $('insTotalDownloads').textContent = (st.total_downloads || 0).toLocaleString();
    if ($('insUploadedWeek')) $('insUploadedWeek').textContent = `${(st.uploaded_week || 0).toLocaleString()} files`;
    if ($('insSourcesCount')) $('insSourcesCount').textContent = String((st.sources || []).length);

    $('topDownloadedList').innerHTML =
      (st.top_downloaded || [])
        .map(
          (f, idx) => `
        <div class="mini-row">
          <div style="min-width:0">
            <div class="app-title" style="font-size:13.5px" data-open-versions="${esc(f.app_slug)}" data-app-name="${esc(f.app_name)}">
              <b>#${idx + 1} ${esc(f.app_name)}</b> ${f.version ? `<span class="ver-badge">v${esc(f.version)}</span>` : ''}
            </div>
            <div class="muted-text">${esc(f.platform)} • ${esc(f.size_text)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="tag-pill tag-highlight">⬇️ ${f.downloads}</span>
            <a class="btn btn-ghost btn-xs" href="${esc(f.download_url)}" target="_blank" rel="noopener noreferrer" title="Download">↗</a>
          </div>
        </div>
      `
        )
        .join('') || '<div class="muted-text">No data yet.</div>';

    $('multiVersionList').innerHTML =
      (st.multi_version_apps || [])
        .map(
          (a) => `
        <div class="mini-row">
          <div><b>${esc(a.app_name)}</b></div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="ver-badge">${a.versions} builds</span>
            <button class="btn btn-ghost btn-xs" data-open-versions="${esc(a.app_slug)}" data-app-name="${esc(a.app_name)}">View</button>
          </div>
        </div>
      `
        )
        .join('') || '<div class="muted-text">No data yet.</div>';

    $('sourcesList').innerHTML = (st.sources || [])
      .map(
        (s) => `
      <div class="list-card">
        <div class="list-card-main">
          <div class="list-card-title">
            <span>👤 ${esc(s.username)}</span>
            <a href="https://dailyuploads.net/users/${encodeURIComponent(s.username)}" target="_blank" rel="noopener noreferrer" class="source-pill">dailyuploads.net/users/${esc(s.username)} ↗</a>
          </div>
          <div class="meta-row" style="margin-top:5px">
            <span>${(s.active_files || 0).toLocaleString()} files • ${(s.active_apps || 0).toLocaleString()} apps</span>
            <span>• Last sync: ${esc(formatRelativeTime(s.last_sync_at))}</span>
          </div>
        </div>
        <div class="list-card-actions">
          <button class="btn btn-ghost btn-xs" data-sync-source="${esc(s.username)}">🔄 ${state.isCloudMode ? 'Refresh / Sync' : 'Full Sync'}</button>
          ${
            !state.isCloudMode && st.sources.length > 1
              ? `<button class="btn btn-danger-ghost btn-xs" data-del-source="${esc(s.username)}">🗑 Remove</button>`
              : ''
          }
        </div>
      </div>
    `
      )
      .join('');

    const logs = st.sync?.recentLogs || [];
    $('syncLogsContainer').innerHTML =
      logs.length === 0
        ? '<div class="muted-text" style="padding:12px">No sync history recorded yet.</div>'
        : `
      <table class="data-table">
        <thead>
          <tr><th>Time</th><th>Source</th><th>Mode</th><th>Status</th><th>Checked</th><th>New</th><th>Alerts</th><th>Duration</th></tr>
        </thead>
        <tbody>
          ${logs
            .map(
              (l) => `
            <tr>
              <td title="${esc(l.created_at)}">${esc(formatRelativeTime(l.created_at))}</td>
              <td>${esc(l.source_user)}</td>
              <td><code>${esc(l.mode)}</code></td>
              <td>${l.status === 'ok' ? '<span class="tag-pill tag-highlight">OK</span>' : `<span class="tag-pill" style="color:var(--danger)" title="${esc(l.error_message)}">ERROR</span>`}</td>
              <td>${l.total_fetched}</td>
              <td>${l.new_files > 0 ? `<b>+${l.new_files}</b>` : '0'}</td>
              <td>${l.alerts_triggered}</td>
              <td>${(l.duration_ms / 1000).toFixed(1)}s</td>
            </tr>
          `
            )
            .join('')}
        </tbody>
      </table>
    `;
  }

  /* ── Settings Tab ─────────────────────────────────────── */

  function updateCloudRepoLinksUI(repoStr) {
    const clean = (repoStr || 'alfarizigan/dailyuploads-radar').trim();
    const base = `https://github.com/${clean}`;
    if ($('linkGhActions')) $('linkGhActions').href = `${base}/actions/workflows/radar-sync.yml`;
    if ($('linkGhSecrets')) $('linkGhSecrets').href = `${base}/settings/secrets/actions`;
    if ($('linkGhWatchlist')) $('linkGhWatchlist').href = `${base}/edit/main/watchlist.json`;
  }

  async function loadSettings() {
    const { settings, telegram, cloud } = await api('/api/settings');
    $('setSyncInterval').value = settings.sync_interval_minutes ?? 20;
    $('setWindowsToast').checked = Boolean(settings.windows_toast_enabled);
    $('setTgToken').value = settings.telegram_bot_token || '';
    $('setTgChatId').value = settings.telegram_chat_id || '';
    $('setTgEnabled').checked = Boolean(settings.telegram_bot_enabled);
    $('setWebhookUrl').value = settings.webhook_url || '';

    const box = $('telegramStatusBox');
    if (state.isCloudMode) {
      const repoVal = cloud?.github_repo || 'alfarizigan/dailyuploads-radar';
      if ($('setCloudGhRepo')) $('setCloudGhRepo').value = repoVal;
      if ($('setCloudGhPat')) $('setCloudGhPat').value = cloud?.github_pat || '';
      if ($('tgSettingsTitle')) {
        $('tgSettingsTitle').textContent = '✈️ Telegram Bot Quick Test & Chat ID Detector';
      }
      if ($('tgSettingsDesc')) {
        $('tgSettingsDesc').innerHTML =
          '1. Paste your <b>Bot Token</b> from <b>@BotFather</b> below (ephemeral — never saved to server or localStorage).<br />' +
          '2. Send <code>/start</code> to your bot in Telegram, then click <b>🔍 Auto-Detect Chat ID</b>.<br />' +
          '3. Click <b>🧪 Test Telegram</b>, then copy both Token &amp; Chat ID into <b>🔐 GitHub Repository Secrets</b> above for 24/7 cloud alerts!';
      }
      if ($('webhookSettingsDesc')) {
        $('webhookSettingsDesc').innerHTML =
          'Test your Discord / JSON Webhook directly from the browser, then save the URL as <code>WEBHOOK_URL</code> in <b>GitHub Repository Secrets</b> for automated 24/7 notifications.';
      }
      updateCloudRepoLinksUI(repoVal);
      box.className = 'status-box ok mt-12';
      box.innerHTML =
        '☁️ <b>Cloud 24/7 Mode:</b> Telegram Bot &amp; Push Alerts run automatically via <b>GitHub Actions</b> on a ~15-minute schedule using <code>TELEGRAM_BOT_TOKEN</code> &amp; <code>TELEGRAM_CHAT_ID</code> from GitHub Secrets.';
    } else if (telegram?.running) {
      box.className = 'status-box ok mt-12';
      box.textContent = `✅ Bot active & listening as @${telegram.botUsername}`;
    } else if (telegram?.lastError) {
      box.className = 'status-box err mt-12';
      box.textContent = `❌ Bot error: ${telegram.lastError}`;
    } else {
      box.className = 'status-box mt-12';
      box.textContent = '⏸️ Interactive Telegram Bot is currently disabled (optional).';
    }
  }

  /* ── Versions Modal ───────────────────────────────────── */

  async function openVersionsModal(slug, appName) {
    state.modalSlug = slug;
    state.modalAppName = appName || slug;
    $('modalAppTitle').textContent = state.modalAppName;
    $('modalAppSubtitle').textContent = 'Loading versions...';
    $('modalBody').innerHTML = '<div class="muted-text">Loading...</div>';
    $('versionsModal').classList.remove('hidden');

    try {
      const srcQs = state.source !== 'all' ? `?source=${encodeURIComponent(state.source)}` : '';
      const { versions } = await api(`/api/apps/${encodeURIComponent(slug)}/versions${srcQs}`);
      const first = versions[0];
      state.modalIsWatched = Boolean(first?.is_watched);
      updateModalWatchButton();
      $('modalAppTitle').textContent = first?.app_name || state.modalAppName;
      $('modalAppSubtitle').textContent = `${versions.length} build${versions.length === 1 ? '' : 's'} found in catalog`;

      $('modalBody').innerHTML = versions
        .map(
          (v, idx) => `
        <div class="list-card">
          <div class="list-card-main">
            <div class="list-card-title">
              <span class="ver-badge">${esc(v.version ? 'v' + v.version : '.' + v.extension)}</span>
              ${idx === 0 ? '<span class="tag-pill tag-highlight">Latest</span>' : ''}
              <span class="plat-badge plat-${esc(v.platform)}">${esc(v.platform)}</span>
              ${v.min_ios_label ? `<span class="tag-pill">${esc(v.min_ios_label)}+</span>` : ''}
            </div>
            <div class="meta-row" style="margin-top:6px">
              <span>📦 ${esc(v.size_text)}</span>
              <span>🕒 ${esc(formatAge(v.uploaded_days_ago))}</span>
              <span>⬇️ ${v.downloads}</span>
              <span>👤 ${esc(v.source_user)}</span>
            </div>
            ${
              v.tags?.length
                ? `<div class="tags-row" style="margin-top:6px">${v.tags.map((t) => `<span class="${tagBadgeClass(t)}">${esc(t)}</span>`).join('')}</div>`
                : ''
            }
            <div class="raw-filename" style="margin-top:6px;white-space:normal;word-break:break-all">${esc(v.raw_filename)}</div>
          </div>
          <div class="list-card-actions">
            <button class="btn btn-ghost btn-xs" data-copy-url="${esc(v.download_url)}">🔗 Copy</button>
            <a class="btn btn-primary btn-xs" href="${esc(v.download_url)}" target="_blank" rel="noopener noreferrer">Download ↗</a>
          </div>
        </div>
      `
        )
        .join('');
    } catch (err) {
      $('modalBody').innerHTML = `<div class="muted-text">Failed to load versions: ${esc(err.message)}</div>`;
    }
  }

  function updateModalWatchButton() {
    const btn = $('modalWatchBtn');
    btn.className = `btn btn-amber btn-sm ${state.modalIsWatched ? 'watched' : ''}`;
    btn.textContent = state.modalIsWatched ? '⭐ Watched' : '🔔 Watch App';
  }

  function closeVersionsModal() {
    $('versionsModal').classList.add('hidden');
  }

  /* ── Actions ──────────────────────────────────────────── */

  function formatWatchAddedToast(label, res) {
    if (!res?.created) return `"${label}" is already on your Watchlist.`;
    if (!state.isCloudMode) return `⭐ Now watching updates for ${label}!`;
    if (res.syncedToCloud) return `☁️ Watching 24/7 on GitHub Cloud: ${label}!`;
    return `⭐ Saved in this browser! For 24/7 mobile push alerts, send "/watch ${label}" to your Telegram Bot or connect a GitHub Token in Settings.`;
  }

  async function toggleAppWatch(slug, appName, currentlyWatched) {
    try {
      if (currentlyWatched) {
        await api(`/api/watchlist/by-slug/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        toast(`Stopped watching ${appName}`, 'info');
      } else {
        const res = await api('/api/watchlist', {
          method: 'POST',
          body: JSON.stringify({ watch_type: 'app', target_slug: slug, display_name: appName }),
        });
        toast(formatWatchAddedToast(appName, res), 'success');
      }
      await Promise.all([loadStats(), loadFiles()]);
      if (state.tab === 'watchlist') await loadWatchlist();
      if (!$('versionsModal').classList.contains('hidden') && state.modalSlug === slug) {
        state.modalIsWatched = !currentlyWatched;
        updateModalWatchButton();
      }
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  function showSyncBanner(info) {
    const banner = $('syncBanner');
    banner.classList.remove('hidden');
    const page = info.page || 0;
    const totalPages = info.totalPages || 1;
    const pct = info.percent ?? Math.min(95, Math.max(12, Math.round((page / totalPages) * 100)));
    $('syncProgressBar').style.width = `${pct}%`;
    if (info.customText) {
      $('syncBannerText').textContent = info.customText;
      return;
    }
    const detail =
      info.fetchedSoFar > 0
        ? `page ${page}/${totalPages} (${info.fetchedSoFar} files)`
        : `connecting to DailyUploads (${info.mode || 'sync'})...`;
    $('syncBannerText').textContent = `Syncing ${info.sourceUser || info.source || ''} — ${detail}`;
  }

  function hideSyncBanner() {
    $('syncBanner').classList.add('hidden');
  }

  async function triggerSync(mode, source = '') {
    if (state.isCloudMode && cloudEngine) {
      const cfg = cloudEngine.getCloudSettings();
      const hasPat = Boolean(cfg.github_pat && cfg.github_repo);

      // Without PAT, clicking the secondary Actions button opens GitHub Actions workflow page directly
      if (mode === 'full' && !hasPat && !source) {
        const repoClean = (cfg.github_repo || 'alfarizigan/dailyuploads-radar').trim();
        window.open(`https://github.com/${repoClean}/actions/workflows/radar-sync.yml`, '_blank', 'noopener,noreferrer');
        toast(
          '⚡ Opened GitHub Actions — click "Run workflow" there, or add a GitHub Token in Settings for 1-click Web sync.',
          'info'
        );
        return;
      }

      try {
        if (hasPat) {
          const prevExportedAt = cloudEngine.state.exported_at;
          showSyncBanner({
            percent: 20,
            customText: `⚡ Dispatching GitHub Actions (${mode} sync)...`,
          });
          await cloudEngine.triggerGithubWorkflow(mode);
          const waitRes = await cloudEngine.waitForCloudSync(prevExportedAt, {
            timeoutMs: mode === 'full' ? 60000 : 45000,
            intervalMs: 3500,
            onPoll: ({ elapsedMs, timeoutMs }) => {
              const pct = Math.min(92, 25 + Math.round((elapsedMs / timeoutMs) * 67));
              showSyncBanner({
                percent: pct,
                customText: `⚡ GitHub Actions scraping DailyUploads (${Math.round(elapsedMs / 1000)}s)...`,
              });
            },
          });
          hideSyncBanner();
          await refreshActiveTab();
          toast(
            waitRes.completed
              ? `✅ Cloud sync (${mode}) finished in ${(waitRes.elapsedMs / 1000).toFixed(0)}s — catalog updated!`
              : `⚡ GitHub Actions (${mode}) is still running in the background; refresh in a few seconds.`,
            'success'
          );
          return;
        }

        // No PAT: fetch fresh commit SHA from radar-state branch (zero CDN cache)
        showSyncBanner({
          percent: 55,
          customText: '☁️ Checking latest snapshot on GitHub Cloud...',
        });
        const res = await cloudEngine.fetchRemoteState({ forceFresh: true });
        hideSyncBanner();
        await refreshActiveTab();
        const lastSyncStr = formatRelativeTime(cloudEngine.state.sources?.[0]?.last_sync_at || res.exportedAt);
        toast(
          `☁️ Loaded latest cloud catalog (${res.totalFiles.toLocaleString()} files • last cloud scrape: ${lastSyncStr})`,
          'success'
        );
      } catch (err) {
        hideSyncBanner();
        toast(`Cloud refresh failed: ${err.message}`, 'error');
      }
      return;
    }

    try {
      showSyncBanner({ source, mode, page: 0, totalPages: 1 });
      await api('/api/sync', {
        method: 'POST',
        body: JSON.stringify({ mode, source, async: true }),
      });
    } catch (err) {
      hideSyncBanner();
      toast(`Sync failed: ${err.message}`, 'error');
    }
  }

  /* ── SSE Live Stream (Local Server Mode) ──────────────── */

  function connectSse() {
    const es = new EventSource('/api/events');
    es.addEventListener('sync_progress', (e) => {
      try {
        showSyncBanner(JSON.parse(e.data));
      } catch {
        // ignore
      }
    });
    es.addEventListener('sync_complete', async (e) => {
      hideSyncBanner();
      try {
        const info = JSON.parse(e.data);
        const msg = `Sync complete (${info.sourceUser}): ${info.totalFetched} files, +${info.newFilesCount} new${
          info.alertsTriggered > 0 ? `, 🔔 ${info.alertsTriggered} alert${info.alertsTriggered === 1 ? '' : 's'}!` : ''
        }`;
        toast(msg, info.alertsTriggered > 0 ? 'warn' : 'success');
      } catch {
        toast('Sync complete', 'success');
      }
      await refreshActiveTab();
    });
    es.addEventListener('sync_error', (e) => {
      hideSyncBanner();
      try {
        const info = JSON.parse(e.data);
        toast(`Sync failed: ${info.error}`, 'error');
      } catch {
        toast('Sync failed', 'error');
      }
    });
    es.addEventListener('alerts', (e) => {
      try {
        const data = JSON.parse(e.data);
        const first = data.alerts?.[0];
        if (first) {
          toast(`🔔 New update: ${first.app_name} ${first.new_version ? 'v' + first.new_version : ''}`, 'warn');
          if ('Notification' in window && Notification.permission === 'granted') {
            new Notification(`Update: ${first.app_name}`, {
              body: `${first.new_version ? 'v' + first.new_version : 'New upload'} • ${first.size_text}`,
            });
          }
        }
      } catch {
        // ignore
      }
      loadStats();
      if (state.tab === 'alerts') loadAlerts();
    });
  }

  /* ── Tab Switching & Event Bindings ───────────────────── */

  async function switchTab(tabName) {
    state.tab = tabName;
    document.querySelectorAll('.nav-tab').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tabName);
    });
    document.querySelectorAll('.tab-panel').forEach((p) => {
      p.classList.toggle('active', p.id === `tab-${tabName}`);
    });
    syncUrlFromState();
    await refreshActiveTab();
  }

  async function refreshActiveTab() {
    await loadStats();
    if (state.tab === 'catalog') {
      await loadFacets();
      await loadFiles();
    } else if (state.tab === 'watchlist') {
      await loadWatchlist();
    } else if (state.tab === 'alerts') {
      await loadAlerts();
    } else if (state.tab === 'insights') {
      await loadInsights();
    } else if (state.tab === 'settings') {
      await loadSettings();
    }
  }

  let searchTimer = null;
  function scheduleSearch() {
    state.page = 1;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      loadFiles().catch((err) => toast(err.message, 'error'));
    }, 140);
  }

  function syncQuickChipUI() {
    document.querySelectorAll('.quick-chips .chip').forEach((c) => {
      c.classList.toggle('active', c.dataset.tag === state.tag);
    });
  }

  function bindEvents() {
    // Tabs
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });

    // Sync buttons
    $('btnQuickSync').addEventListener('click', () => triggerSync('quick'));
    $('btnFullSync').addEventListener('click', () => triggerSync('full'));

    // Theme
    $('btnTheme').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      safeStorageSet('du_theme', state.theme);
      applyTheme();
    });

    // Search input
    const searchInput = $('searchInput');
    searchInput.addEventListener('input', () => {
      state.q = searchInput.value.trim();
      $('btnClearSearch').classList.toggle('hidden', !state.q);
      $('btnWatchQuery').classList.toggle('hidden', !state.q);
      if ($('searchKbdHint')) $('searchKbdHint').classList.toggle('hidden', Boolean(state.q));
      scheduleSearch();
    });

    $('btnClearSearch').addEventListener('click', () => {
      searchInput.value = '';
      state.q = '';
      $('btnClearSearch').classList.add('hidden');
      $('btnWatchQuery').classList.add('hidden');
      if ($('searchKbdHint')) $('searchKbdHint').classList.remove('hidden');
      scheduleSearch();
      searchInput.focus();
    });

    $('btnWatchQuery').addEventListener('click', async () => {
      if (!state.q) return;
      try {
        const res = await api('/api/watchlist', {
          method: 'POST',
          body: JSON.stringify({
            watch_type: 'keyword',
            keyword: state.q,
            display_name: state.q,
            platform_filter: state.platform !== 'all' ? state.platform : '',
          }),
        });
        toast(formatWatchAddedToast(state.q, res), 'success');
        await loadStats();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    // Quick chips
    document.querySelectorAll('.quick-chips .chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        const tag = chip.dataset.tag;
        state.tag = state.tag === tag ? 'all' : tag;
        syncTagSelectUI();
        state.page = 1;
        loadFiles();
      });
    });

    // Platform pills (delegated)
    $('platformPills').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-platform]');
      if (!btn) return;
      state.platform = btn.dataset.platform;
      document.querySelectorAll('#platformPills .pill').forEach((p) => {
        p.classList.toggle('active', p.dataset.platform === state.platform);
      });
      state.page = 1;
      loadFiles();
    });

    // Dropdown filters
    $('filterSort').addEventListener('change', (e) => {
      state.sort = e.target.value;
      state.page = 1;
      loadFiles();
    });
    $('filterExt').addEventListener('change', (e) => {
      state.extension = e.target.value;
      state.page = 1;
      loadFiles();
    });
    $('filterMaxIos').addEventListener('change', (e) => {
      state.maxIos = e.target.value;
      state.page = 1;
      loadFiles();
    });
    $('filterMaxDays').addEventListener('change', (e) => {
      state.maxDays = e.target.value;
      state.page = 1;
      loadFiles();
    });
    $('filterSize').addEventListener('change', (e) => {
      state.sizeRange = e.target.value;
      state.page = 1;
      loadFiles();
    });
    $('filterTag').addEventListener('change', (e) => {
      state.tag = e.target.value;
      syncQuickChipUI();
      state.page = 1;
      loadFiles();
    });
    $('filterSource').addEventListener('change', async (e) => {
      state.source = e.target.value;
      state.page = 1;
      await loadFacets();
      await loadFiles();
    });

    $('toggleGrouped').addEventListener('change', (e) => {
      state.grouped = e.target.checked;
      state.page = 1;
      loadFiles();
    });
    $('toggleWatchedOnly').addEventListener('change', (e) => {
      state.watchedOnly = e.target.checked;
      state.page = 1;
      loadFiles();
    });

    $('btnResetFilters').addEventListener('click', async () => {
      state.q = '';
      state.source = 'all';
      state.platform = 'all';
      state.extension = 'all';
      state.tag = 'all';
      state.maxIos = 'all';
      state.maxDays = 'all';
      state.sizeRange = 'all';
      state.watchedOnly = false;
      state.grouped = true;
      state.sort = 'newest';
      state.page = 1;

      searchInput.value = '';
      $('btnClearSearch').classList.add('hidden');
      $('btnWatchQuery').classList.add('hidden');
      if ($('searchKbdHint')) $('searchKbdHint').classList.remove('hidden');
      $('filterSource').value = 'all';
      $('filterSort').value = 'newest';
      $('filterExt').value = 'all';
      $('filterMaxIos').value = 'all';
      $('filterMaxDays').value = 'all';
      $('filterSize').value = 'all';
      $('filterTag').value = 'all';
      $('toggleGrouped').checked = true;
      $('toggleWatchedOnly').checked = false;
      syncQuickChipUI();
      await loadFacets();
      await loadFiles();
    });

    // View mode
    const applyViewMode = (mode) => {
      state.viewMode = mode;
      safeStorageSet('du_view_mode', mode);
      $('viewGrid').classList.toggle('active', mode === 'grid');
      $('viewTable').classList.toggle('active', mode === 'table');
      if (state.lastSearch) renderCatalog(state.lastSearch);
    };
    $('viewGrid').addEventListener('click', () => applyViewMode('grid'));
    $('viewTable').addEventListener('click', () => applyViewMode('table'));
    applyViewMode(state.viewMode);

    // Shareable filtered URL
    if ($('btnShareSearch')) {
      $('btnShareSearch').addEventListener('click', async () => {
        syncUrlFromState();
        try {
          await copyTextToClipboard(window.location.href);
          toast('🔗 Shareable search link copied to clipboard!', 'success');
        } catch {
          toast('Failed to copy link to clipboard', 'error');
        }
      });
    }

    // Export CSV / JSON
    $('btnExportCsv').addEventListener('click', () => {
      if (state.isCloudMode && cloudEngine) {
        const params = Object.fromEntries(buildFilterQueryParams({ format: 'csv' }).entries());
        const out = cloudEngine.exportCatalog(params);
        downloadBlobFile(out.filename, out.mime, out.content);
        return;
      }
      const qs = buildFilterQueryParams({ format: 'csv' });
      window.location.href = `/api/export?${qs.toString()}`;
    });
    $('btnExportJson').addEventListener('click', () => {
      if (state.isCloudMode && cloudEngine) {
        const params = Object.fromEntries(buildFilterQueryParams({ format: 'json' }).entries());
        const out = cloudEngine.exportCatalog(params);
        downloadBlobFile(out.filename, out.mime, out.content);
        return;
      }
      const qs = buildFilterQueryParams({ format: 'json' });
      window.location.href = `/api/export?${qs.toString()}`;
    });

    // Delegated clicks inside main content (cards, table, watchlist, alerts, insights, modal)
    document.body.addEventListener('click', async (e) => {
      const copyBtn = e.target.closest('[data-copy-url]');
      if (copyBtn) {
        const url = copyBtn.dataset.copyUrl;
        try {
          await copyTextToClipboard(url);
          toast(
            url.startsWith('/watch')
              ? `📲 Copied "${url}"! Paste and send it to your Telegram Bot.`
              : '🔗 Download link copied!',
            'success'
          );
        } catch {
          toast('Failed to copy to clipboard', 'error');
        }
        return;
      }

      const watchBtn = e.target.closest('[data-toggle-watch]');
      if (watchBtn) {
        await toggleAppWatch(
          watchBtn.dataset.toggleWatch,
          watchBtn.dataset.appName,
          watchBtn.dataset.watched === '1'
        );
        return;
      }

      const verTrigger = e.target.closest('[data-open-versions]');
      if (verTrigger) {
        await openVersionsModal(verTrigger.dataset.openVersions, verTrigger.dataset.appName);
        return;
      }

      const tagBtn = e.target.closest('[data-filter-tag]');
      if (tagBtn) {
        state.tag = tagBtn.dataset.filterTag;
        syncTagSelectUI();
        state.page = 1;
        if (state.tab !== 'catalog') await switchTab('catalog');
        else await loadFiles();
        return;
      }

      const pageBtn = e.target.closest('[data-page]');
      if (pageBtn && !pageBtn.disabled) {
        state.page = Number.parseInt(pageBtn.dataset.page, 10) || 1;
        await loadFiles();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
      }

      const delWatch = e.target.closest('[data-del-watch]');
      if (delWatch) {
        await api(`/api/watchlist/${delWatch.dataset.delWatch}`, { method: 'DELETE' });
        toast('Removed from Watchlist', 'info');
        await Promise.all([loadStats(), loadWatchlist()]);
        return;
      }

      const toggleNotif = e.target.closest('[data-toggle-notify]');
      if (toggleNotif) {
        const next = toggleNotif.dataset.enabled !== '1';
        await api(`/api/watchlist/${toggleNotif.dataset.toggleNotify}`, {
          method: 'PATCH',
          body: JSON.stringify({ notify_enabled: next }),
        });
        toast(next ? 'Notifications enabled' : 'Notifications muted', 'info');
        await loadWatchlist();
        return;
      }

      const searchWatch = e.target.closest('[data-search-watch]');
      if (searchWatch) {
        state.q = searchWatch.dataset.searchWatch;
        state.platform = 'all';
        state.extension = 'all';
        state.tag = 'all';
        state.maxIos = 'all';
        state.maxDays = 'all';
        state.sizeRange = 'all';
        state.watchedOnly = false;
        state.page = 1;

        $('searchInput').value = state.q;
        $('btnClearSearch').classList.remove('hidden');
        $('btnWatchQuery').classList.remove('hidden');
        if ($('searchKbdHint')) $('searchKbdHint').classList.add('hidden');
        $('filterExt').value = 'all';
        $('filterMaxIos').value = 'all';
        $('filterMaxDays').value = 'all';
        $('filterSize').value = 'all';
        $('filterTag').value = 'all';
        $('toggleWatchedOnly').checked = false;
        syncQuickChipUI();
        await switchTab('catalog');
        return;
      }

      const readAlert = e.target.closest('[data-read-alert]');
      if (readAlert) {
        await api(`/api/alerts/${readAlert.dataset.readAlert}/read`, { method: 'POST' });
        await Promise.all([loadAlerts(), loadStats()]);
        return;
      }

      const syncSrc = e.target.closest('[data-sync-source]');
      if (syncSrc) {
        await triggerSync(state.isCloudMode ? 'quick' : 'full', syncSrc.dataset.syncSource);
        return;
      }

      const delSrc = e.target.closest('[data-del-source]');
      if (delSrc) {
        if (!confirm(`Remove source "${delSrc.dataset.delSource}" and all its indexed files?`)) return;
        await api(`/api/sources/${encodeURIComponent(delSrc.dataset.delSource)}`, { method: 'DELETE' });
        toast('Source removed', 'info');
        await loadInsights();
        return;
      }

      const testBtn = e.target.closest('[data-test-channel]');
      if (testBtn) {
        const channel = testBtn.dataset.testChannel;
        try {
          testBtn.disabled = true;
          const payload = { channel };
          if (channel === 'telegram') {
            payload.telegram_bot_token = $('setTgToken').value.trim();
            payload.telegram_chat_id = $('setTgChatId').value.trim();
          } else if (channel === 'webhook') {
            payload.webhook_url = $('setWebhookUrl').value.trim();
          }
          await api('/api/notifications/test', {
            method: 'POST',
            body: JSON.stringify(payload),
          });
          toast(`✅ Test notification (${channel}) sent!`, 'success');
        } catch (err) {
          toast(`❌ Test failed: ${err.message}`, 'error');
        } finally {
          testBtn.disabled = false;
        }
      }
    });

    // Modal controls
    $('modalBackdrop').addEventListener('click', closeVersionsModal);
    $('modalCloseBtn').addEventListener('click', closeVersionsModal);
    $('modalWatchBtn').addEventListener('click', async () => {
      if (!state.modalSlug) return;
      await toggleAppWatch(state.modalSlug, state.modalAppName, state.modalIsWatched);
    });

    // Watchlist add keyword form
    $('addKeywordForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const keyword = $('kwInput').value.trim();
      if (!keyword) return;
      try {
        const res = await api('/api/watchlist', {
          method: 'POST',
          body: JSON.stringify({
            watch_type: 'keyword',
            keyword,
            display_name: keyword,
            platform_filter: $('kwPlatform').value,
            notes: $('kwNotes').value.trim(),
          }),
        });
        $('kwInput').value = '';
        $('kwNotes').value = '';
        toast(formatWatchAddedToast(keyword, res), 'success');
        await Promise.all([loadWatchlist(), loadStats()]);
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    // Export / Import Watchlist
    $('btnExportWatchlist').addEventListener('click', () => {
      if (state.isCloudMode && cloudEngine) {
        const out = cloudEngine.exportWatchlistJson();
        downloadBlobFile(out.filename, out.mime, out.content);
        return;
      }
      window.location.href = '/api/watchlist/export';
    });
    $('importWatchlistInput').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const items = JSON.parse(text);
        const res = await api('/api/watchlist/import', {
          method: 'POST',
          body: JSON.stringify({ items }),
        });
        toast(`Import complete: +${res.added} added (${res.skipped} skipped)`, 'success');
        await Promise.all([loadWatchlist(), loadStats()]);
      } catch (err) {
        toast(`Import failed: ${err.message}`, 'error');
      } finally {
        e.target.value = '';
      }
    });

    // Alerts actions
    $('btnEnableBrowserNotif').addEventListener('click', async () => {
      if (!('Notification' in window)) {
        toast('This browser does not support Web Notifications.', 'error');
        return;
      }
      const perm = await Notification.requestPermission();
      toast(
        perm === 'granted' ? '🔔 Browser notifications enabled!' : 'Browser notification permission denied.',
        perm === 'granted' ? 'success' : 'warn'
      );
    });
    $('btnMarkAllRead').addEventListener('click', async () => {
      await api('/api/alerts/read-all', { method: 'POST' });
      toast('All notifications marked as read', 'info');
      await Promise.all([loadAlerts(), loadStats()]);
    });
    $('btnClearAlerts').addEventListener('click', async () => {
      if (!confirm('Clear entire notification history?')) return;
      await api('/api/alerts', { method: 'DELETE' });
      toast('Notification history cleared', 'info');
      await Promise.all([loadAlerts(), loadStats()]);
    });

    // Add source form
    $('addSourceForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = $('newSourceInput').value.trim();
      if (!val) return;
      try {
        const { source } = await api('/api/sources', {
          method: 'POST',
          body: JSON.stringify({ url: val }),
        });
        $('newSourceInput').value = '';
        toast(`Added source "${source.username}"! Starting Full Sync...`, 'success');
        await loadInsights();
        await triggerSync('full', source.username);
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    // Settings form
    $('settingsForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        await api('/api/settings', {
          method: 'PUT',
          body: JSON.stringify({
            sync_interval_minutes: Number.parseInt($('setSyncInterval').value, 10) || 0,
            windows_toast_enabled: $('setWindowsToast').checked,
            telegram_bot_token: $('setTgToken').value.trim(),
            telegram_chat_id: $('setTgChatId').value.trim(),
            telegram_bot_enabled: $('setTgEnabled').checked,
            webhook_url: $('setWebhookUrl').value.trim(),
          }),
        });
        toast('💾 Settings saved!', 'success');
        await loadSettings();
      } catch (err) {
        toast(`Failed to save settings: ${err.message}`, 'error');
      }
    });

    if ($('btnDetectTgChatId')) {
      $('btnDetectTgChatId').addEventListener('click', async () => {
        if (!cloudEngine) return;
        const token = $('setTgToken').value.trim();
        try {
          $('btnDetectTgChatId').disabled = true;
          const info = await cloudEngine.detectTelegramChatId(token);
          if (info.chatIds.length > 0) {
            $('setTgChatId').value = info.chatIds.join(', ');
            toast(
              `✅ Connected to @${info.botUsername}! Detected Chat ID: ${info.chatIds.join(', ')}`,
              'success'
            );
          } else {
            toast(
              `✅ Valid token (@${info.botUsername})! Send /start to @${info.botUsername} in Telegram, then click this button again.`,
              'warn'
            );
          }
        } catch (err) {
          toast(`Chat ID detection failed: ${err.message}`, 'error');
        } finally {
          $('btnDetectTgChatId').disabled = false;
        }
      });
    }

    if ($('btnSaveCloudBridge')) {
      $('btnSaveCloudBridge').addEventListener('click', () => {
        if (!cloudEngine) return;
        const repo = $('setCloudGhRepo').value.trim() || 'alfarizigan/dailyuploads-radar';
        const pat = $('setCloudGhPat').value.trim();
        cloudEngine.updateCloudSettings({ github_repo: repo, github_pat: pat });
        updateCloudRepoLinksUI(repo);
        updateSyncButtonsUI();
        toast('☁️ GitHub Cloud connection settings saved in this browser!', 'success');
      });
    }

    if ($('btnPushWatchlistCloud')) {
      $('btnPushWatchlistCloud').addEventListener('click', async () => {
        if (!cloudEngine) return;
        const repo = $('setCloudGhRepo').value.trim() || 'alfarizigan/dailyuploads-radar';
        const pat = $('setCloudGhPat').value.trim();
        cloudEngine.updateCloudSettings({ github_repo: repo, github_pat: pat });
        updateSyncButtonsUI();
        if (!pat) {
          toast('Enter a GitHub Personal Access Token first, or use the "Edit watchlist.json" link above.', 'warn');
          return;
        }
        try {
          $('btnPushWatchlistCloud').disabled = true;
          await cloudEngine.syncWatchlistToGithub();
          toast('✅ Watchlist pushed to GitHub Cloud (watchlist.json)!', 'success');
          if (state.tab === 'watchlist') await loadWatchlist();
        } catch (err) {
          toast(`Failed to push to GitHub: ${err.message}`, 'error');
        } finally {
          $('btnPushWatchlistCloud').disabled = false;
        }
      });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (!$('versionsModal').classList.contains('hidden')) {
          closeVersionsModal();
        }
        return;
      }
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === '/') {
        e.preventDefault();
        if (state.tab !== 'catalog') switchTab('catalog');
        $('searchInput').focus();
      } else if (e.key === 'r' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
        triggerSync('quick');
      }
    });

    // Browser Back/Forward URL state sync
    window.addEventListener('popstate', () => {
      hydrateStateFromUrl();
      syncDomControlsFromState();
      syncQuickChipUI();
      refreshActiveTab().catch(() => {});
    });
  }

  async function maybeBackgroundVerifyCloudFreshness() {
    if (!state.isCloudMode || !cloudEngine) return;
    const prevExported = cloudEngine.state.exported_at || '';
    const exportedMs = prevExported ? Date.parse(prevExported) : 0;

    // If initial branch snapshot is >3m old, verify head commit SHA in background so Fastly's 5m cache never hides a fresh run
    if (!exportedMs || Date.now() - exportedMs > 3 * 60 * 1000) {
      try {
        const res = await cloudEngine.fetchRemoteState({ forceFresh: true });
        if (res.exportedAt && res.exportedAt !== prevExported) {
          await refreshActiveTab();
        }
      } catch {
        // Non-fatal background check
      }
    }

    // If user configured a GitHub PAT and cloud scrape is >25m stale (e.g. GitHub cron queue lag), auto-dispatch silently
    const cfg = cloudEngine.getCloudSettings();
    const lastSyncIso = cloudEngine.state.sources?.[0]?.last_sync_at || cloudEngine.state.exported_at || '';
    const lastSyncMs = lastSyncIso ? Date.parse(lastSyncIso) : 0;
    const lastAutoDispatch = Number.parseInt(safeStorageGet('du_last_auto_dispatch_ms', '0'), 10) || 0;
    if (
      cfg.github_pat &&
      cfg.github_repo &&
      lastSyncMs > 0 &&
      Date.now() - lastSyncMs > 25 * 60 * 1000 &&
      Date.now() - lastAutoDispatch > 15 * 60 * 1000
    ) {
      safeStorageSet('du_last_auto_dispatch_ms', String(Date.now()));
      const baseExported = cloudEngine.state.exported_at;
      cloudEngine
        .triggerGithubWorkflow('quick')
        .then(() => cloudEngine.waitForCloudSync(baseExported, { timeoutMs: 45000, intervalMs: 4000 }))
        .then((w) => {
          if (w.completed) return refreshActiveTab();
          return undefined;
        })
        .catch(() => {});
    }
  }

  async function detectAndInitRuntime() {
    const isStaticHost =
      location.protocol === 'file:' || location.hostname.endsWith('.github.io');

    if (!isStaticHost) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 1500);
        const r = await fetch('./api/health', { signal: ctrl.signal });
        clearTimeout(t);
        if (r.ok) {
          const j = await r.json().catch(() => ({}));
          if (j && j.ok) {
            state.isCloudMode = false;
            updateSyncButtonsUI();
            connectSse();
            return;
          }
        }
      } catch {
        // Fallback to Cloud Static Mode
      }
    }

    if (!window.CloudRadarEngine) {
      throw new Error('CloudRadarEngine not found.');
    }

    state.isCloudMode = true;
    cloudEngine = new window.CloudRadarEngine.CloudRadarEngine();
    if ($('runtimeModeBadge')) $('runtimeModeBadge').classList.remove('hidden');
    if ($('cloudSettingsCard')) $('cloudSettingsCard').classList.remove('hidden');
    if ($('localAutoSyncCard')) $('localAutoSyncCard').classList.add('hidden');
    if ($('tgLongPollingRow')) $('tgLongPollingRow').classList.add('hidden');
    if ($('localSettingsFooter')) $('localSettingsFooter').classList.add('hidden');
    if ($('btnDetectTgChatId')) $('btnDetectTgChatId').classList.remove('hidden');
    if ($('addSourceForm')) $('addSourceForm').classList.add('hidden');
    if ($('cloudSourcesHint')) $('cloudSourcesHint').classList.remove('hidden');
    updateCloudRepoLinksUI(cloudEngine.getCloudSettings().github_repo);
    updateSyncButtonsUI();

    await cloudEngine.fetchRemoteState();

    // Auto-refresh cloud catalog silently every 5 minutes while visible
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        cloudEngine
          .fetchRemoteState({ forceFresh: true })
          .then(() => refreshActiveTab())
          .catch(() => {});
      }
    }, 5 * 60 * 1000);

    // Refresh immediately when user switches back to tab (e.g. mobile Safari resume) after >60s
    document.addEventListener('visibilitychange', () => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - (cloudEngine.lastFetchedAt || 0) > 60 * 1000
      ) {
        cloudEngine
          .fetchRemoteState({ forceFresh: true })
          .then(() => refreshActiveTab())
          .catch(() => {});
      }
    });
  }

  async function init() {
    hydrateStateFromUrl();
    applyTheme();
    syncDomControlsFromState();
    bindEvents();
    await detectAndInitRuntime();
    await refreshActiveTab();
    maybeBackgroundVerifyCloudFreshness();

    // Keep relative "Last Sync" indicator ticking smoothly every 30s
    setInterval(() => {
      refreshLastSyncDisplay();
    }, 30 * 1000);
  }

  init().catch((err) => {
    console.error(err);
    toast(`Initialization error: ${err.message}`, 'error');
  });
})();
