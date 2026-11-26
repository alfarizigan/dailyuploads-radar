(() => {
  'use strict';

  const I18N = {
    id: {
      tab_catalog: 'Katalog',
      tab_watchlist: 'Watchlist',
      tab_alerts: 'Notifikasi',
      tab_insights: 'Insights',
      tab_settings: 'Pengaturan',
      btn_quick_sync: 'Quick Sync',
      btn_full_sync: 'Full',
      kpi_files: 'Total File',
      kpi_apps: 'Aplikasi Unik',
      kpi_today: 'Upload Hari Ini',
      kpi_watched: 'Dipantau',
      kpi_last_sync: 'Sync Terakhir',
      btn_watch_keyword: 'Pantau Keyword',
      quick_tags: 'Cepat:',
      f_sort: 'Urutkan',
      f_ext: 'Format',
      f_ios: 'Min iOS',
      f_age: 'Waktu Upload',
      f_size: 'Ukuran',
      f_tag: 'Tag',
      opt_group: 'Gabung per Aplikasi',
      opt_watched: 'Hanya Watchlist ⭐',
      btn_reset: 'Reset',
      wl_title: '⭐ Watchlist & Pantauan Update',
      wl_desc: 'Tandai aplikasi atau buat aturan keyword. Setiap ada upload baru yang cocok, Radar akan memberi notifikasi otomatis!',
      btn_add_rule: 'Tambah Pantauan',
      al_title: '🔔 Pusat Notifikasi Update',
      al_desc: 'Daftar aplikasi yang terdeteksi mendapat versi/upload terbaru sejak kamu memantaunya.',
      search_placeholder: 'Cari aplikasi, versi, tag, filename... (tekan / untuk fokus)',
      sort_newest: 'Terbaru',
      sort_oldest: 'Terlama',
      sort_downloads: 'Download Terbanyak',
      sort_name_asc: 'Nama A → Z',
      sort_name_desc: 'Nama Z → A',
      sort_size_desc: 'Ukuran Terbesar',
      sort_size_asc: 'Ukuran Terkecil',
      ios_all: 'Semua iOS',
      age_all: 'Semua waktu',
      age_0: 'Hari ini (0d)',
      age_3: '≤ 3 hari',
      age_7: '≤ 7 hari',
      age_30: '≤ 30 hari',
      size_all: 'Semua ukuran',
    },
    en: {
      tab_catalog: 'Catalog',
      tab_watchlist: 'Watchlist',
      tab_alerts: 'Alerts',
      tab_insights: 'Insights',
      tab_settings: 'Settings',
      btn_quick_sync: 'Quick Sync',
      btn_full_sync: 'Full',
      kpi_files: 'Total Files',
      kpi_apps: 'Unique Apps',
      kpi_today: 'Uploaded Today',
      kpi_watched: 'Watched',
      kpi_last_sync: 'Last Sync',
      btn_watch_keyword: 'Watch Keyword',
      quick_tags: 'Quick:',
      f_sort: 'Sort by',
      f_ext: 'Format',
      f_ios: 'Min iOS',
      f_age: 'Upload Age',
      f_size: 'Size',
      f_tag: 'Tag',
      opt_group: 'Group by App',
      opt_watched: 'Watched Only ⭐',
      btn_reset: 'Reset',
      wl_title: '⭐ Watchlist & Update Rules',
      wl_desc: 'Bookmark apps or create keyword rules. Whenever a matching upload appears, Radar alerts you automatically!',
      btn_add_rule: 'Add Watch Rule',
      al_title: '🔔 Update Notifications',
      al_desc: 'Detected new versions and uploads matching your watched apps and keywords.',
      search_placeholder: 'Search apps, versions, tags, filenames... (press / to focus)',
      sort_newest: 'Newest',
      sort_oldest: 'Oldest',
      sort_downloads: 'Most Downloaded',
      sort_name_asc: 'Name A → Z',
      sort_name_desc: 'Name Z → A',
      sort_size_desc: 'Largest Size',
      sort_size_asc: 'Smallest Size',
      ios_all: 'All iOS',
      age_all: 'Any time',
      age_0: 'Today (0d)',
      age_3: '≤ 3 days',
      age_7: '≤ 7 days',
      age_30: '≤ 30 days',
      size_all: 'Any size',
    },
  };

  const HIGHLIGHT_TAGS = new Set(['VIP', 'Pro', 'Premium', 'Subscribed', 'Unlocked', 'Incl. DLC']);
  const MOD_TAGS = new Set(['Unsigned', 'TNT', 'MacKed', 'U2B', 'TrollStore', 'Creator Ed', 'Modded']);

  const state = {
    tab: 'catalog',
    viewMode: localStorage.getItem('du_view_mode') || 'grid',
    theme: localStorage.getItem('du_theme') || 'dark',
    lang: localStorage.getItem('du_lang') || 'id',
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

  function formatRelativeTime(iso) {
    const en = state.lang === 'en';
    if (!iso) return en ? 'Never' : 'Belum pernah';
    const ms = Date.now() - Date.parse(iso);
    if (!Number.isFinite(ms)) return iso;
    const sec = Math.max(0, Math.floor(ms / 1000));
    if (sec < 60) return en ? `${sec}s ago` : `${sec}d lalu`;
    const min = Math.floor(sec / 60);
    if (min < 60) return en ? `${min}m ago` : `${min}m lalu`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return en ? `${hr}h ago` : `${hr}j lalu`;
    const d = Math.floor(hr / 24);
    return en ? `${d}d ago` : `${d}h lalu`;
  }

  function formatAge(days) {
    if (days === null || days === undefined) return '—';
    if (days === 0) return state.lang === 'en' ? 'Today' : 'Hari ini';
    if (days === 1) return state.lang === 'en' ? '1d ago' : '1 hari lalu';
    return state.lang === 'en' ? `${days}d ago` : `${days} hari lalu`;
  }

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
          toast(`GitHub sync gagal: ${err.message}`, 'warn');
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
          .catch((err) => toast(`GitHub sync gagal: ${err.message}`, 'warn'));
      }
      return { ok: true, ...res };
    }
    const wlSlugMatch = pathname.match(/^\/api\/watchlist\/by-slug\/([^/]+)$/);
    if (method === 'DELETE' && wlSlugMatch) {
      const removed = cloudEngine.removeWatchBySlug(wlSlugMatch[1]);
      if (cloudEngine.getCloudSettings().github_pat) {
        await cloudEngine
          .syncWatchlistToGithub()
          .catch((err) => toast(`GitHub sync gagal: ${err.message}`, 'warn'));
      }
      return { ok: true, removed };
    }
    const wlIdMatch = pathname.match(/^\/api\/watchlist\/([^/]+)$/);
    if (wlIdMatch) {
      if (method === 'PATCH') {
        const updated = cloudEngine.updateWatch(wlIdMatch[1], body);
        return { item: updated };
      }
      if (method === 'DELETE') {
        cloudEngine.removeWatch(wlIdMatch[1]);
        if (cloudEngine.getCloudSettings().github_pat) {
          await cloudEngine
            .syncWatchlistToGithub()
            .catch((err) => toast(`GitHub sync gagal: ${err.message}`, 'warn'));
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
      throw new Error('Windows Toast hanya tersedia pada server lokal Windows.');
    }
    if (method === 'POST' && pathname === '/api/sources') {
      throw new Error('Di Mode Cloud, tambahkan variable EXTRA_SOURCES di GitHub Actions Settings → Variables.');
    }
    throw new Error(`Endpoint ${pathname} hanya tersedia di server lokal.`);
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
    }, 3600);
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    $('btnTheme').textContent = state.theme === 'dark' ? '☀️' : '🌙';
  }

  function applyLang() {
    const dict = I18N[state.lang] || I18N.id;
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const k = el.getAttribute('data-i18n');
      if (dict[k]) el.textContent = dict[k];
    });
    const searchInput = $('searchInput');
    if (searchInput && dict.search_placeholder) searchInput.placeholder = dict.search_placeholder;

    const optMap = [
      ['#filterSort option[value="newest"]', dict.sort_newest],
      ['#filterSort option[value="oldest"]', dict.sort_oldest],
      ['#filterSort option[value="downloads"]', dict.sort_downloads],
      ['#filterSort option[value="name_asc"]', dict.sort_name_asc],
      ['#filterSort option[value="name_desc"]', dict.sort_name_desc],
      ['#filterSort option[value="size_desc"]', dict.sort_size_desc],
      ['#filterSort option[value="size_asc"]', dict.sort_size_asc],
      ['#filterMaxIos option[value="all"]', dict.ios_all],
      ['#filterMaxDays option[value="all"]', dict.age_all],
      ['#filterMaxDays option[value="0"]', dict.age_0],
      ['#filterMaxDays option[value="3"]', dict.age_3],
      ['#filterMaxDays option[value="7"]', dict.age_7],
      ['#filterMaxDays option[value="30"]', dict.age_30],
      ['#filterSize option[value="all"]', dict.size_all],
    ];
    for (const [sel, label] of optMap) {
      const el = document.querySelector(sel);
      if (el && label) el.textContent = label;
    }

    $('btnLang').textContent = state.lang.toUpperCase();
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

  async function loadStats() {
    const st = await api('/api/stats');
    state.stats = st;
    $('kpiTotalFiles').textContent = (st.total_files || 0).toLocaleString();
    $('kpiTotalApps').textContent = (st.total_apps || 0).toLocaleString();
    $('kpiToday').textContent = (st.uploaded_today || 0).toLocaleString();
    $('kpiWatched').textContent = (st.watchlist_count || 0).toLocaleString();

    const firstSource = st.sources?.[0];
    $('kpiLastSync').textContent = firstSource?.last_sync_at
      ? formatRelativeTime(firstSource.last_sync_at)
      : 'Syncing...';

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
      const cur = state.source;
      srcSel.innerHTML = `<option value="all">Semua Source</option>` +
        st.sources.map((s) => `<option value="${esc(s.username)}">${esc(s.username)} (${s.active_files})</option>`).join('');
      srcSel.value = cur;
    } else {
      srcWrap.classList.add('hidden');
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
      `<option value="all">Semua</option>` +
      (f.extensions || [])
        .map((e) => `<option value="${esc(e.name)}">.${esc(e.name)} (${e.count})</option>`)
        .join('');
    extSel.value = state.extension;

    // Tag select
    const tagSel = $('filterTag');
    tagSel.innerHTML =
      `<option value="all">${state.lang === 'en' ? 'All Tags' : 'Semua Tag'}</option>` +
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
    const en = state.lang === 'en';
    const unit = res.grouped ? (en ? 'apps' : 'aplikasi') : en ? 'files' : 'file';
    summary.textContent =
      res.total === 0
        ? `0 ${unit}`
        : en
          ? `Showing ${start}–${end} of ${res.total.toLocaleString()} ${unit}`
          : `Menampilkan ${start}–${end} dari ${res.total.toLocaleString()} ${unit}`;

    if (!res.items || res.items.length === 0) {
      container.className = '';
      const hasQuery = Boolean(state.q);
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">${state.stats?.total_files === 0 ? '🛰️' : '🔍'}</div>
          <h3>${state.stats?.total_files === 0 ? 'Katalog sedang disinkronkan...' : 'Tidak ada aplikasi yang cocok'}</h3>
          <p>${
            state.stats?.total_files === 0
              ? 'Tunggu beberapa detik hingga sinkronisasi pertama dari DailyUploads selesai, atau klik Full Sync.'
              : hasQuery
                ? `Belum ada file untuk "${esc(state.q)}". Kamu bisa klik "Pantau Keyword" di atas supaya dapat notifikasi otomatis saat nanti di-upload!`
                : 'Coba ubah atau reset filter pencarian kamu.'
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
              <th>Aplikasi</th>
              <th>Versi</th>
              <th>Platform</th>
              <th>Ukuran</th>
              <th>iOS</th>
              <th>Upload</th>
              <th>DL</th>
              <th>Aksi</th>
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
            title="${item.is_watched ? 'Hapus dari Watchlist' : 'Pantau update aplikasi ini'}"
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
            📋 Detail${vCount > 1 ? ` (${vCount})` : ''}
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
    return `
      <tr>
        <td>
          <div class="app-title" style="font-size:13.5px" data-open-versions="${esc(item.app_slug)}" data-app-name="${esc(item.app_name)}">
            ${esc(item.app_name)} ${vCount > 1 ? `<span class="builds-btn">${vCount} builds</span>` : ''}
          </div>
          <div class="raw-filename" style="max-width:340px" title="${esc(item.raw_filename)}">${esc(item.raw_filename)}</div>
        </td>
        <td><span class="ver-badge">${esc(ver)}</span></td>
        <td><span class="plat-badge plat-${esc(item.platform)}">${esc(item.platform)}</span></td>
        <td>${esc(item.size_text || '—')}</td>
        <td>${esc(item.min_ios_label || '—')}</td>
        <td class="${item.uploaded_days_ago === 0 ? 'meta-today' : ''}">${esc(formatAge(item.uploaded_days_ago))}</td>
        <td>${dlCount}</td>
        <td>
          <div style="display:flex;gap:5px;flex-wrap:nowrap">
            <button class="btn btn-amber btn-xs ${item.is_watched ? 'watched' : ''}" data-toggle-watch="${esc(item.app_slug)}" data-app-name="${esc(item.app_name)}" data-watched="${item.is_watched ? '1' : '0'}">${item.is_watched ? '⭐' : '🔔'}</button>
            <button class="btn btn-ghost btn-xs" data-copy-url="${esc(item.download_url)}" title="Copy Link">🔗</button>
            <a class="btn btn-primary btn-xs" href="${esc(item.download_url)}" target="_blank" rel="noopener noreferrer">↗</a>
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
          <h3>Watchlist masih kosong</h3>
          <p>Klik tombol <b>🔔 Watch</b> pada aplikasi di tab Katalog, atau tambahkan aturan keyword di atas untuk mulai memantau update terbaru!</p>
        </div>
      `;
      return;
    }

    box.innerHTML = items
      .map((w) => {
        const lf = w.latest_file;
        const latestVer = lf?.version ? `v${lf.version}` : w.last_known_version ? `v${w.last_known_version}` : 'Belum ada file';
        const scopeBadge =
          state.isCloudMode
            ? w.scope === 'cloud'
              ? '<span class="tag-pill tag-highlight" title="Tersimpan di Cloud GitHub — notifikasi otomatis 24/7 aktif">☁️ Cloud 24/7</span>'
              : '<span class="tag-pill" title="Tersimpan di browser ini. Ketik /watch di Bot Telegram atau Push ke GitHub agar notif HP 24/7 aktif">🌐 Browser</span>'
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
                ${w.alert_count > 0 ? `<span class="tag-pill tag-highlight">${w.alert_count} alert</span>` : ''}
              </div>
              <div class="meta-row mt-12" style="margin-top:6px">
                <span>Versi terbaru: <b>${esc(latestVer)}</b></span>
                ${lf ? `<span>• ${esc(lf.size_text)} • ${esc(formatAge(lf.uploaded_days_ago))}</span>` : ''}
                ${w.notes ? `<span>• 📝 ${esc(w.notes)}</span>` : ''}
              </div>
            </div>
            <div class="list-card-actions">
              ${
                lf
                  ? `<a class="btn btn-primary btn-xs" href="${esc(lf.download_url)}" target="_blank" rel="noopener noreferrer">Download Terbaru ↗</a>`
                  : ''
              }
              <button class="btn btn-ghost btn-xs" data-search-watch="${esc(w.watch_type === 'keyword' ? w.keyword : w.display_name)}">🔍 Lihat di Katalog</button>
              ${
                state.isCloudMode && w.scope !== 'cloud'
                  ? `<button class="btn btn-ghost btn-xs" data-copy-url="${esc(tgCmd)}" title="Salin perintah /watch untuk dikirim ke Bot Telegram">📲 Copy /watch</button>`
                  : ''
              }
              ${
                !state.isCloudMode || w.scope !== 'cloud'
                  ? `<button class="btn btn-ghost btn-xs" data-toggle-notify="${esc(w.id)}" data-enabled="${w.notify_enabled}">
                      ${w.notify_enabled ? '🔔 Notif ON' : '🔕 Notif OFF'}
                    </button>`
                  : ''
              }
              <button class="btn btn-danger-ghost btn-xs" data-del-watch="${esc(w.id)}">🗑 Hapus</button>
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
          <h3>Belum ada notifikasi update</h3>
          <p>Saat aplikasi di Watchlist kamu mendapat upload baru di DailyUploads, notifikasi lengkap dengan perbandingan versi akan muncul di sini!</p>
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
                <span>Watch: <b>${esc(a.watch_name)}</b></span>
                <span>• ${esc(a.size_text || '—')}</span>
                <span>• ${esc(formatRelativeTime(a.created_at))}</span>
              </div>
              <div class="raw-filename" style="margin-top:4px">${esc(a.raw_filename)}</div>
            </div>
            <div class="list-card-actions">
              <a class="btn btn-primary btn-xs" href="${esc(a.download_url)}" target="_blank" rel="noopener noreferrer">Download ↗</a>
              ${!a.is_read ? `<button class="btn btn-ghost btn-xs" data-read-alert="${a.id}">✓ Dibaca</button>` : ''}
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

    $('topDownloadedList').innerHTML =
      (st.top_downloaded || [])
        .map(
          (f, idx) => `
        <div class="mini-row">
          <div style="min-width:0">
            <div><b>#${idx + 1} ${esc(f.app_name)}</b> <span class="ver-badge">${esc(f.version ? 'v' + f.version : '')}</span></div>
            <div class="muted-text">${esc(f.platform)} • ${esc(f.size_text)}</div>
          </div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="tag-pill tag-highlight">⬇️ ${f.downloads}</span>
            <a class="btn btn-ghost btn-xs" href="${esc(f.download_url)}" target="_blank" rel="noopener noreferrer">↗</a>
          </div>
        </div>
      `
        )
        .join('') || '<div class="muted-text">Belum ada data.</div>';

    $('multiVersionList').innerHTML =
      (st.multi_version_apps || [])
        .map(
          (a) => `
        <div class="mini-row">
          <div><b>${esc(a.app_name)}</b></div>
          <div style="display:flex;align-items:center;gap:8px">
            <span class="ver-badge">${a.versions} builds</span>
            <button class="btn btn-ghost btn-xs" data-open-versions="${esc(a.app_slug)}" data-app-name="${esc(a.app_name)}">Lihat</button>
          </div>
        </div>
      `
        )
        .join('') || '<div class="muted-text">Belum ada data.</div>';

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
            <span>${(s.active_files || 0).toLocaleString()} file • ${(s.active_apps || 0).toLocaleString()} app</span>
            <span>• Sync terakhir: ${esc(formatRelativeTime(s.last_sync_at))}</span>
          </div>
        </div>
        <div class="list-card-actions">
          <button class="btn btn-ghost btn-xs" data-sync-source="${esc(s.username)}">🔄 Full Sync</button>
          ${
            !state.isCloudMode && st.sources.length > 1
              ? `<button class="btn btn-danger-ghost btn-xs" data-del-source="${esc(s.username)}">🗑 Hapus</button>`
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
        ? '<div class="muted-text" style="padding:12px">Belum ada riwayat sinkronisasi.</div>'
        : `
      <table class="data-table">
        <thead>
          <tr><th>Waktu</th><th>Source</th><th>Mode</th><th>Status</th><th>Diproses</th><th>Baru</th><th>Alert</th><th>Durasi</th></tr>
        </thead>
        <tbody>
          ${logs
            .map(
              (l) => `
            <tr>
              <td>${esc(formatRelativeTime(l.created_at))}</td>
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
        $('tgSettingsTitle').textContent = '✈️ Tes Cepat & Deteksi Chat ID Bot Telegram';
      }
      if ($('tgSettingsDesc')) {
        $('tgSettingsDesc').innerHTML =
          '1. Tempel <b>Bot Token</b> dari <b>@BotFather</b> di bawah (tidak disimpan ke server/localStorage).<br />' +
          '2. Kirim pesan <code>/start</code> ke bot kamu di Telegram, lalu klik <b>🔍 Deteksi Chat ID Otomatis</b>.<br />' +
          '3. Klik <b>🧪 Test Kirim Telegram</b>, lalu salin Token &amp; Chat ID ke <b>🔐 GitHub Repository Secrets</b> di atas agar aktif 24/7!';
      }
      if ($('webhookSettingsDesc')) {
        $('webhookSettingsDesc').innerHTML =
          'Uji coba Discord / JSON Webhook langsung dari browser, lalu simpan URL sebagai secret <code>WEBHOOK_URL</code> di <b>GitHub Repository Secrets</b> untuk notifikasi 24/7.';
      }
      updateCloudRepoLinksUI(repoVal);
      box.className = 'status-box ok mt-12';
      box.innerHTML =
        '☁️ <b>Mode Cloud 24/7:</b> Bot &amp; Notifikasi dijalankan otomatis oleh <b>GitHub Actions</b> setiap ~15 menit menggunakan <code>TELEGRAM_BOT_TOKEN</code> &amp; <code>TELEGRAM_CHAT_ID</code> di GitHub Secrets (bukan dari penyimpanan browser).';
    } else if (telegram?.running) {
      box.className = 'status-box ok mt-12';
      box.textContent = `✅ Bot aktif & listening sebagai @${telegram.botUsername}`;
    } else if (telegram?.lastError) {
      box.className = 'status-box err mt-12';
      box.textContent = `❌ Bot error: ${telegram.lastError}`;
    } else {
      box.className = 'status-box mt-12';
      box.textContent = '⏸️ Interactive Telegram Bot belum diaktifkan (opsional).';
    }
  }

  /* ── Versions Modal ───────────────────────────────────── */

  async function openVersionsModal(slug, appName) {
    state.modalSlug = slug;
    state.modalAppName = appName || slug;
    $('modalAppTitle').textContent = state.modalAppName;
    $('modalAppSubtitle').textContent = 'Memuat versi...';
    $('modalBody').innerHTML = '<div class="muted-text">Memuat...</div>';
    $('versionsModal').classList.remove('hidden');

    try {
      const srcQs = state.source !== 'all' ? `?source=${encodeURIComponent(state.source)}` : '';
      const { versions } = await api(`/api/apps/${encodeURIComponent(slug)}/versions${srcQs}`);
      const first = versions[0];
      state.modalIsWatched = Boolean(first?.is_watched);
      updateModalWatchButton();
      $('modalAppTitle').textContent = first?.app_name || state.modalAppName;
      $('modalAppSubtitle').textContent = `${versions.length} file/build ditemukan di katalog`;

      $('modalBody').innerHTML = versions
        .map(
          (v, idx) => `
        <div class="list-card">
          <div class="list-card-main">
            <div class="list-card-title">
              <span class="ver-badge">${esc(v.version ? 'v' + v.version : '.' + v.extension)}</span>
              ${idx === 0 ? '<span class="tag-pill tag-highlight">Terbaru</span>' : ''}
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
      $('modalBody').innerHTML = `<div class="muted-text">Gagal memuat: ${esc(err.message)}</div>`;
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
    if (!res?.created) return `"${label}" sudah ada di Watchlist.`;
    if (!state.isCloudMode) return `⭐ Memantau update untuk ${label}!`;
    if (res.syncedToCloud) return `☁️ Dipantau 24/7 di GitHub Cloud: ${label}!`;
    return `⭐ Ditandai di browser! Untuk notif HP 24/7, kirim "/watch ${label}" ke Bot Telegram atau hubungkan GitHub di Pengaturan.`;
  }

  async function toggleAppWatch(slug, appName, currentlyWatched) {
    try {
      if (currentlyWatched) {
        await api(`/api/watchlist/by-slug/${encodeURIComponent(slug)}`, { method: 'DELETE' });
        toast(`Berhenti memantau ${appName}`, 'info');
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
    const pct = Math.min(95, Math.max(12, Math.round((page / totalPages) * 100)));
    $('syncProgressBar').style.width = `${pct}%`;
    const detail =
      info.fetchedSoFar > 0
        ? `halaman ${page}/${totalPages} (${info.fetchedSoFar} file)`
        : `menghubungi DailyUploads (${info.mode || 'sync'})...`;
    $('syncBannerText').textContent = `Menyinkronkan ${info.sourceUser || info.source || ''} — ${detail}`;
  }

  function hideSyncBanner() {
    $('syncBanner').classList.add('hidden');
  }

  async function triggerSync(mode, source = '') {
    if (state.isCloudMode && cloudEngine) {
      try {
        showSyncBanner({ source: 'Cloud GitHub', mode, page: 1, totalPages: 2 });
        const cfg = cloudEngine.getCloudSettings();
        let dispatched = false;
        if (cfg.github_pat && cfg.github_repo) {
          const d = await cloudEngine.triggerGithubWorkflow(mode);
          dispatched = d.dispatched;
        }
        await cloudEngine.fetchRemoteState({ forceFresh: true });
        hideSyncBanner();
        await refreshActiveTab();
        toast(
          dispatched
            ? `⚡ GitHub Actions (${mode}) dipicu & data Cloud terbaru dimuat!`
            : `☁️ Data katalog terbaru dari Cloud GitHub berhasil dimuat!`,
          'success'
        );
      } catch (err) {
        hideSyncBanner();
        toast(`Cloud refresh gagal: ${err.message}`, 'error');
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
      toast(`Sync gagal: ${err.message}`, 'error');
    }
  }

  /* ── SSE Live Stream ──────────────────────────────────── */

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
        const msg = `Sync selesai (${info.sourceUser}): ${info.totalFetched} file, +${info.newFilesCount} baru${
          info.alertsTriggered > 0 ? `, 🔔 ${info.alertsTriggered} alert!` : ''
        }`;
        toast(msg, info.alertsTriggered > 0 ? 'warn' : 'success');
      } catch {
        toast('Sinkronisasi selesai', 'success');
      }
      await refreshActiveTab();
    });
    es.addEventListener('sync_error', (e) => {
      hideSyncBanner();
      try {
        const info = JSON.parse(e.data);
        toast(`Sync gagal: ${info.error}`, 'error');
      } catch {
        toast('Sync gagal', 'error');
      }
    });
    es.addEventListener('alerts', (e) => {
      try {
        const data = JSON.parse(e.data);
        const first = data.alerts?.[0];
        if (first) {
          toast(`🔔 Update baru: ${first.app_name} ${first.new_version ? 'v' + first.new_version : ''}`, 'warn');
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

    // Theme & Language
    $('btnTheme').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('du_theme', state.theme);
      applyTheme();
    });
    $('btnLang').addEventListener('click', () => {
      state.lang = state.lang === 'id' ? 'en' : 'id';
      localStorage.setItem('du_lang', state.lang);
      applyLang();
      refreshActiveTab().catch(() => {});
    });

    // Search input
    const searchInput = $('searchInput');
    searchInput.addEventListener('input', () => {
      state.q = searchInput.value.trim();
      $('btnClearSearch').classList.toggle('hidden', !state.q);
      $('btnWatchQuery').classList.toggle('hidden', !state.q);
      scheduleSearch();
    });

    $('btnClearSearch').addEventListener('click', () => {
      searchInput.value = '';
      state.q = '';
      $('btnClearSearch').classList.add('hidden');
      $('btnWatchQuery').classList.add('hidden');
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
      localStorage.setItem('du_view_mode', mode);
      $('viewGrid').classList.toggle('active', mode === 'grid');
      $('viewTable').classList.toggle('active', mode === 'table');
      if (state.lastSearch) renderCatalog(state.lastSearch);
    };
    $('viewGrid').addEventListener('click', () => applyViewMode('grid'));
    $('viewTable').addEventListener('click', () => applyViewMode('table'));
    applyViewMode(state.viewMode);

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
          await navigator.clipboard.writeText(url);
          toast(
            url.startsWith('/watch')
              ? `📲 "${url}" disalin! Kirim ke Bot Telegram kamu.`
              : '🔗 Link download disalin!',
            'success'
          );
        } catch {
          toast('Gagal menyalin ke clipboard', 'error');
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
        toast('Dihapus dari Watchlist', 'info');
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
        toast(next ? 'Notifikasi diaktifkan' : 'Notifikasi dimatikan', 'info');
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
        await triggerSync('full', syncSrc.dataset.syncSource);
        return;
      }

      const delSrc = e.target.closest('[data-del-source]');
      if (delSrc) {
        if (!confirm(`Hapus source ${delSrc.dataset.delSource} beserta semua data filenya?`)) return;
        await api(`/api/sources/${encodeURIComponent(delSrc.dataset.delSource)}`, { method: 'DELETE' });
        toast('Source dihapus', 'info');
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
          toast(`✅ Test notifikasi (${channel}) berhasil dikirim!`, 'success');
        } catch (err) {
          toast(`❌ Test gagal: ${err.message}`, 'error');
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
        toast(`Import selesai: +${res.added} baru (${res.skipped} dilewati)`, 'success');
        await Promise.all([loadWatchlist(), loadStats()]);
      } catch (err) {
        toast(`Gagal import: ${err.message}`, 'error');
      } finally {
        e.target.value = '';
      }
    });

    // Alerts actions
    $('btnEnableBrowserNotif').addEventListener('click', async () => {
      if (!('Notification' in window)) {
        toast('Browser ini tidak mendukung Web Notification.', 'error');
        return;
      }
      const perm = await Notification.requestPermission();
      toast(
        perm === 'granted' ? '🔔 Notifikasi browser aktif!' : 'Izin notifikasi browser ditolak.',
        perm === 'granted' ? 'success' : 'warn'
      );
    });
    $('btnMarkAllRead').addEventListener('click', async () => {
      await api('/api/alerts/read-all', { method: 'POST' });
      toast('Semua notifikasi ditandai dibaca', 'info');
      await Promise.all([loadAlerts(), loadStats()]);
    });
    $('btnClearAlerts').addEventListener('click', async () => {
      if (!confirm('Hapus seluruh riwayat notifikasi?')) return;
      await api('/api/alerts', { method: 'DELETE' });
      toast('Riwayat notifikasi dibersihkan', 'info');
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
        toast(`Source "${source.username}" ditambahkan! Memulai Full Sync...`, 'success');
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
        toast('💾 Pengaturan disimpan!', 'success');
        await loadSettings();
      } catch (err) {
        toast(`Gagal menyimpan: ${err.message}`, 'error');
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
              `✅ @${info.botUsername} terhubung! Chat ID terdeteksi: ${info.chatIds.join(', ')}`,
              'success'
            );
          } else {
            toast(
              `✅ Token valid (@${info.botUsername})! Kirim pesan /start ke @${info.botUsername} di Telegram lalu klik tombol ini lagi.`,
              'warn'
            );
          }
        } catch (err) {
          toast(`Gagal deteksi Chat ID: ${err.message}`, 'error');
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
        toast('☁️ Pengaturan koneksi GitHub Cloud disimpan di browser ini!', 'success');
      });
    }

    if ($('btnPushWatchlistCloud')) {
      $('btnPushWatchlistCloud').addEventListener('click', async () => {
        if (!cloudEngine) return;
        const repo = $('setCloudGhRepo').value.trim() || 'alfarizigan/dailyuploads-radar';
        const pat = $('setCloudGhPat').value.trim();
        cloudEngine.updateCloudSettings({ github_repo: repo, github_pat: pat });
        if (!pat) {
          toast('Isi GitHub Personal Access Token terlebih dahulu, atau gunakan tombol Edit watchlist.json di atas.', 'warn');
          return;
        }
        try {
          $('btnPushWatchlistCloud').disabled = true;
          await cloudEngine.syncWatchlistToGithub();
          toast('✅ Watchlist berhasil di-push ke GitHub Cloud (watchlist.json)!', 'success');
          if (state.tab === 'watchlist') await loadWatchlist();
        } catch (err) {
          toast(`Gagal push ke GitHub: ${err.message}`, 'error');
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
            connectSse();
            return;
          }
        }
      } catch {
        // Fallback to Cloud Static Mode
      }
    }

    if (!window.CloudRadarEngine) {
      throw new Error('CloudRadarEngine tidak ditemukan.');
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

    await cloudEngine.fetchRemoteState();
    // Auto-refresh cloud catalog silently every 5 minutes if tab stays open
    setInterval(() => {
      if (document.visibilityState === 'visible') {
        cloudEngine
          .fetchRemoteState({ forceFresh: true })
          .then(() => refreshActiveTab())
          .catch(() => {});
      }
    }, 5 * 60 * 1000);
  }

  async function init() {
    applyTheme();
    applyLang();
    bindEvents();
    await detectAndInitRuntime();
    await refreshActiveTab();
  }

  init().catch((err) => {
    console.error(err);
    toast(`Init error: ${err.message}`, 'error');
  });
})();
