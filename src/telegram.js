'use strict';

const { config } = require('./config');
const { escapeTelegramHtml } = require('./notifier');
const { formatBytes, slugifyAppName } = require('./parser');

const BOT_COMMANDS = [
  { command: 'search', description: 'Search apps (e.g. /search spotify)' },
  { command: 'latest', description: 'Show latest uploads' },
  { command: 'watch', description: 'Watch a keyword or app (e.g. /watch lumafusion)' },
  { command: 'unwatch', description: 'Remove a watch rule (e.g. /unwatch lumafusion)' },
  { command: 'watchlist', description: 'List & manage watched apps' },
  { command: 'updates', description: 'Show recent update notifications' },
  { command: 'sync', description: 'Check DailyUploads for new uploads now' },
  { command: 'stats', description: 'Show catalog statistics' },
  { command: 'help', description: 'Show bot command guide' },
];

class TelegramBotRunner {
  constructor({ db, syncManager, fetchFn = globalThis.fetch }) {
    this.db = db;
    this.syncManager = syncManager;
    this.fetchFn = fetchFn;
    this.running = false;
    this.offset = typeof db?.getBotOffset === 'function' ? db.getBotOffset() : 0;
    this.abortController = null;
    this.botInfo = null;
    this.lastError = '';
    this.manualSyncResults = null;
  }

  getStatus() {
    const settings = this.db.getSettings();
    return {
      configured: Boolean(settings.telegram_bot_token),
      enabled: Boolean(settings.telegram_bot_enabled),
      running: this.running,
      botUsername: this.botInfo?.username || '',
      lastError: this.lastError,
    };
  }

  async apiCall(token, method, payload = {}, signal = undefined) {
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/${method}`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.description || `Telegram HTTP ${res.status}`);
    }
    return data.result;
  }

  async start() {
    const settings = this.db.getSettings();
    if (!settings.telegram_bot_enabled || !settings.telegram_bot_token) {
      this.stop();
      return;
    }
    if (this.running) return;

    this.running = true;
    this.lastError = '';
    const token = settings.telegram_bot_token;

    try {
      this.botInfo = await this.apiCall(token, 'getMe');
      await this.apiCall(token, 'setMyCommands', {
        commands: BOT_COMMANDS,
      }).catch(() => {});
      console.log(`[Telegram] Bot started as @${this.botInfo.username}`);
    } catch (err) {
      this.lastError = err.message;
      this.running = false;
      console.error('[Telegram] Failed to start bot:', err.message);
      return;
    }

    this._pollLoop(token);
  }

  /**
   * One-shot batch processor for serverless / GitHub Actions cron execution.
   * Drains pending Telegram updates using persisted bot_offset without hanging.
   */
  async processPendingUpdates({ tokenOverride = '', maxBatches = 10, registerCommands = false } = {}) {
    this.manualSyncResults = null;
    const settings = this.db.getSettings();
    const token = String(tokenOverride || settings.telegram_bot_token || '').trim();
    if (!token) {
      return { enabled: false, processed: 0, offset: this.offset, manualSyncResults: null };
    }

    if (registerCommands) {
      await this.apiCall(token, 'setMyCommands', { commands: BOT_COMMANDS }).catch(() => {});
    }

    if (typeof this.db.getBotOffset === 'function') {
      this.offset = this.db.getBotOffset();
    }

    let processed = 0;
    let sawUpdates = false;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const updates = await this.apiCall(token, 'getUpdates', {
        offset: this.offset,
        limit: 100,
        timeout: 0,
        allowed_updates: ['message', 'callback_query'],
      });
      if (!Array.isArray(updates) || updates.length === 0) {
        sawUpdates = false;
        break;
      }
      sawUpdates = true;

      for (const upd of updates) {
        this.offset = upd.update_id + 1;
        if (typeof this.db.setBotOffset === 'function') {
          this.db.setBotOffset(this.offset);
        }
        try {
          await this.handleUpdate(token, upd);
          processed += 1;
        } catch (err) {
          console.error('[Telegram] Batch handler error:', err.message);
        }
      }

      if (updates.length < 100) break;
    }

    // Acknowledge the final offset on Telegram's server queue so processed updates are committed upstream
    if (sawUpdates && this.offset > 0) {
      try {
        const tail = await this.apiCall(token, 'getUpdates', {
          offset: this.offset,
          limit: 10,
          timeout: 0,
          allowed_updates: ['message', 'callback_query'],
        });
        if (Array.isArray(tail) && tail.length > 0) {
          for (const upd of tail) {
            this.offset = upd.update_id + 1;
            if (typeof this.db.setBotOffset === 'function') {
              this.db.setBotOffset(this.offset);
            }
            try {
              await this.handleUpdate(token, upd);
              processed += 1;
            } catch (err) {
              console.error('[Telegram] Tail handler error:', err.message);
            }
          }
        }
      } catch {
        // Non-fatal; persisted db offset still prevents re-processing
      }
    }

    return {
      enabled: true,
      processed,
      offset: this.offset,
      manualSyncResults: this.manualSyncResults,
    };
  }

  stop() {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
  }

  async reconfigure() {
    this.stop();
    await new Promise((r) => setTimeout(r, 150));
    await this.start();
  }

  async _pollLoop(token) {
    let backoffMs = 1500;
    while (this.running) {
      this.abortController = new AbortController();
      try {
        const updates = await this.apiCall(
          token,
          'getUpdates',
          {
            offset: this.offset,
            timeout: 25,
            allowed_updates: ['message', 'callback_query'],
          },
          this.abortController.signal
        );
        backoffMs = 1500;
        this.lastError = '';
        for (const upd of updates) {
          this.offset = upd.update_id + 1;
          if (typeof this.db.setBotOffset === 'function') {
            this.db.setBotOffset(this.offset);
          }
          await this.handleUpdate(token, upd).catch((err) => {
            console.error('[Telegram] Handler error:', err.message);
          });
        }
      } catch (err) {
        if (!this.running || err.name === 'AbortError') break;
        this.lastError = err.message;
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs = Math.min(30000, backoffMs * 2);
      }
    }
  }

  isAuthorizedChat(chatId) {
    const settings = this.db.getSettings();
    const configured = String(settings.telegram_chat_id || '').trim();
    if (!configured) return true;
    const allowed = configured
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return allowed.includes(String(chatId));
  }

  async sendReply(token, chatId, htmlText, extra = {}) {
    return this.apiCall(token, 'sendMessage', {
      chat_id: chatId,
      text: htmlText,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...extra,
    });
  }

  async handleUpdate(token, update) {
    if (update.callback_query) {
      await this.handleCallback(token, update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg || !msg.text) return;
    const chatId = msg.chat.id;
    const text = msg.text.trim();

    if (/^\/(?:start|help)(?:@\S+)?(?:\s|$)/i.test(text)) {
      const authNote = this.isAuthorizedChat(chatId)
        ? ''
        : `\n⚠️ <i>Your Chat ID is not authorized yet in Settings / GitHub Secrets. Add the Chat ID below to TELEGRAM_CHAT_ID.</i>`;
      const env = typeof config.getEnvOverrides === 'function' ? config.getEnvOverrides() : {};
      const webUrl = env.cloud_web_url || config.cloudWebUrl || '';
      const webLine = webUrl
        ? `\n🌐 <b>Instant Web Searcher (24/7):</b> <a href="${escapeTelegramHtml(webUrl)}">Open DailyUploads Radar Web</a>\n`
        : '';
      await this.sendReply(
        token,
        chatId,
        [
          `🛰️ <b>DailyUploads Radar Bot</b>`,
          `Your Chat ID: <code>${chatId}</code>${authNote}${webLine}`,
          ``,
          `<b>Available commands:</b>`,
          `• <code>/search &lt;query&gt;</code> — Search apps (or simply send any app name!)`,
          `• <code>/latest</code> — Show 8 newest uploads`,
          `• <code>/watch &lt;keyword&gt;</code> — Add an update watch rule`,
          `• <code>/unwatch &lt;name or id&gt;</code> — Remove a watch rule`,
          `• <code>/watchlist</code> — View & manage your watchlist`,
          `• <code>/updates</code> — View recent update notifications`,
          `• <code>/sync</code> — Check DailyUploads for new uploads now`,
          `• <code>/stats</code> — Catalog summary & statistics`,
        ].join('\n')
      );
      return;
    }

    if (!this.isAuthorizedChat(chatId)) {
      await this.sendReply(
        token,
        chatId,
        `🔒 Access restricted. Your Chat ID is <code>${chatId}</code>. Add it to TELEGRAM_CHAT_ID in Settings or GitHub Secrets to authorize this chat.`
      );
      return;
    }

    if (/^\/latest(?:@\S+)?(?:\s|$)/i.test(text)) {
      const res = this.db.searchFiles({ sort: 'newest', limit: 8, grouped: true });
      await this.sendSearchResults(token, chatId, '🆕 Latest Uploads', res);
      return;
    }

    if (/^\/search(?:@\S+)?(?:\s|$)/i.test(text)) {
      const query = text.replace(/^\/search(?:@\S+)?\s*/i, '').trim();
      if (!query) {
        await this.sendReply(token, chatId, 'Usage: <code>/search spotify</code> (or just type the app name directly).');
        return;
      }
      const res = this.db.searchFiles({ q: query, sort: 'newest', limit: 8, grouped: true });
      await this.sendSearchResults(token, chatId, `🔍 Results for "${escapeTelegramHtml(query)}"`, res);
      return;
    }

    if (/^\/watchlist(?:@\S+)?(?:\s|$)/i.test(text)) {
      const list = this.db.listWatchlist();
      if (list.length === 0) {
        await this.sendReply(token, chatId, '📭 Your watchlist is empty. Use <code>/watch AppName</code> or tap the Watch button on any search result.');
        return;
      }
      const lines = [`⭐ <b>Your Watchlist (${list.length})</b>\n`];
      const keyboard = [];
      for (const w of list.slice(0, 15)) {
        const ver = w.latest_file?.version ? `v${w.latest_file.version}` : w.last_known_version ? `v${w.last_known_version}` : '-';
        lines.push(`• <b>${escapeTelegramHtml(w.display_name)}</b> (${w.watch_type}) — Latest: <code>${escapeTelegramHtml(ver)}</code>`);
        keyboard.push([{ text: `🗑 Remove: ${w.display_name.slice(0, 28)}`, callback_data: `unwatch_id:${w.id}` }]);
      }
      await this.sendReply(token, chatId, lines.join('\n'), {
        reply_markup: { inline_keyboard: keyboard },
      });
      return;
    }

    if (/^\/unwatch(?:@\S+)?(?:\s|$)/i.test(text)) {
      const target = text.replace(/^\/unwatch(?:@\S+)?\s*/i, '').trim();
      if (!target) {
        await this.sendReply(token, chatId, 'Usage: <code>/unwatch Spotify</code> (or use <code>/watchlist</code> to remove with a button).');
        return;
      }
      const list = this.db.listWatchlist();
      const targetLower = target.toLowerCase();
      const targetSlug = slugifyAppName(target);
      const asId = /^\d+$/.test(target) ? Number.parseInt(target, 10) : NaN;
      const matches = list.filter(
        (w) =>
          (Number.isFinite(asId) && w.id === asId) ||
          String(w.display_name || '').toLowerCase() === targetLower ||
          String(w.keyword || '').toLowerCase() === targetLower ||
          (w.target_slug && (w.target_slug === targetLower || w.target_slug === targetSlug))
      );
      if (matches.length === 0) {
        await this.sendReply(
          token,
          chatId,
          `ℹ️ No watch rule found matching <b>${escapeTelegramHtml(target)}</b>. Send <code>/watchlist</code> to view active rules.`
        );
        return;
      }
      for (const m of matches) {
        this.db.removeWatch(m.id);
      }
      const removedNames = matches.map((m) => escapeTelegramHtml(m.display_name)).join(', ');
      await this.sendReply(token, chatId, `🔕 Removed <b>${removedNames}</b> from your watchlist.`);
      return;
    }

    if (/^\/watch(?:@\S+)?(?:\s|$)/i.test(text)) {
      const kw = text.replace(/^\/watch(?:@\S+)?\s*/i, '').trim();
      if (!kw) {
        await this.sendReply(token, chatId, 'Example: <code>/watch Spotify</code>');
        return;
      }
      const { item, created } = this.db.addWatch({
        watch_type: 'keyword',
        keyword: kw,
        display_name: kw,
      });
      await this.sendReply(
        token,
        chatId,
        created
          ? `🔔 Now watching keyword <b>${escapeTelegramHtml(item.display_name)}</b>! You will receive automatic alerts whenever a matching upload arrives.`
          : `ℹ️ Keyword <b>${escapeTelegramHtml(item.display_name)}</b> is already on your watchlist.`
      );
      return;
    }

    if (/^\/updates(?:@\S+)?(?:\s|$)/i.test(text)) {
      const { items } = this.db.listAlerts({ limit: 8 });
      if (items.length === 0) {
        await this.sendReply(token, chatId, '📭 No update notifications recorded yet.');
        return;
      }
      const lines = ['🔔 <b>Recent Detected Updates</b>\n'];
      for (const a of items) {
        const diff = a.old_version && a.new_version ? `v${a.old_version} → v${a.new_version}` : a.new_version ? `v${a.new_version}` : 'New';
        lines.push(
          `• <b>${escapeTelegramHtml(a.app_name)}</b> (<code>${escapeTelegramHtml(diff)}</code>) — <a href="${escapeTelegramHtml(a.download_url)}">Download</a>`
        );
      }
      await this.sendReply(token, chatId, lines.join('\n'));
      return;
    }

    if (/^\/sync(?:@\S+)?(?:\s|$)/i.test(text)) {
      if (!this.syncManager) {
        await this.sendReply(token, chatId, 'ℹ️ Sync engine is not available.');
        return;
      }
      await this.sendReply(token, chatId, '🔄 Starting quick sync from DailyUploads...');
      const results = await this.syncManager.syncAllSources({ mode: 'quick' });
      this.manualSyncResults = results;
      const lines = ['✅ <b>Sync Complete</b>'];
      for (const r of results) {
        if (r.ok) {
          lines.push(`• <b>${escapeTelegramHtml(r.sourceUser)}</b>: ${r.totalFetched} checked, <b>+${r.newFilesCount} new</b>, ${r.alertsTriggered} alerts (${(r.durationMs / 1000).toFixed(1)}s)`);
        } else {
          lines.push(`• <b>${escapeTelegramHtml(r.sourceUser)}</b>: ❌ ${escapeTelegramHtml(r.error)}`);
        }
      }
      await this.sendReply(token, chatId, lines.join('\n'));
      return;
    }

    if (/^\/stats(?:@\S+)?(?:\s|$)/i.test(text)) {
      const st = this.db.getStats();
      await this.sendReply(
        token,
        chatId,
        [
          `📊 <b>DailyUploads Radar Statistics</b>`,
          `• Total Files: <b>${st.total_files.toLocaleString()}</b>`,
          `• Unique Apps: <b>${st.total_apps.toLocaleString()}</b>`,
          `• Total Catalog Size: <b>${formatBytes(st.total_size_bytes)}</b>`,
          `• Uploaded Today: <b>${st.uploaded_today || 0}</b> | Last 7 Days: <b>${st.uploaded_week || 0}</b>`,
          `• Watched Rules: <b>${st.watchlist_count}</b> | Unread Alerts: <b>${st.unread_alerts}</b>`,
        ].join('\n')
      );
      return;
    }

    // Plain text = instant search; unknown slash command = helpful hint
    if (!text.startsWith('/')) {
      const res = this.db.searchFiles({ q: text, sort: 'newest', limit: 8, grouped: true });
      await this.sendSearchResults(token, chatId, `🔍 Results for "${escapeTelegramHtml(text)}"`, res);
    } else {
      await this.sendReply(
        token,
        chatId,
        '❓ Unknown command. Send <code>/help</code> to see available commands, or type any app name to search.'
      );
    }
  }

  async sendSearchResults(token, chatId, header, res) {
    if (!res.items || res.items.length === 0) {
      await this.sendReply(token, chatId, `${header}\n\n❌ No matching apps found.`);
      return;
    }
    const lines = [`${header} <i>(showing ${res.items.length} of ${res.total})</i>\n`];
    const keyboard = [];

    for (const item of res.items) {
      const ver = item.version ? `v${item.version}` : '-';
      const ios = item.min_ios_label ? ` • ${item.min_ios_label}+` : '';
      const age = item.uploaded_days_ago !== null ? `${item.uploaded_days_ago}d ago` : '';
      const vCount = item.version_count > 1 ? ` (${item.version_count} builds)` : '';
      lines.push(
        `📦 <b>${escapeTelegramHtml(item.app_name)}</b> <code>${escapeTelegramHtml(ver)}</code>${vCount}`,
        `   ${escapeTelegramHtml(item.platform)} • ${escapeTelegramHtml(item.size_text)}${escapeTelegramHtml(ios)} • ${age} • ⬇️${item.downloads}`,
        `   <a href="${escapeTelegramHtml(item.download_url)}">Download on DailyUploads</a>\n`
      );
      // Use compact file_code in callback_data to stay well within Telegram's 64-byte limit even for long app_slugs
      keyboard.push([
        {
          text: item.is_watched ? `🔕 Unwatch ${item.app_name.slice(0, 22)}` : `🔔 Watch ${item.app_name.slice(0, 22)}`,
          callback_data: item.is_watched ? `unwatch_fc:${item.file_code}` : `watch_fc:${item.file_code}`,
        },
        { text: '🔗 Download', url: item.download_url },
      ]);
    }

    await this.sendReply(token, chatId, lines.join('\n'), {
      reply_markup: { inline_keyboard: keyboard },
    });
  }

  async handleCallback(token, cb) {
    const chatId = cb.message?.chat?.id;
    if (!chatId || !this.isAuthorizedChat(chatId)) {
      await this.apiCall(token, 'answerCallbackQuery', { callback_query_id: cb.id, text: 'Unauthorized' }).catch(() => {});
      return;
    }
    const data = String(cb.data || '');
    let toast = 'OK';
    let replyHtml = '';
    let buttonReplacement = null;
    let removeRowByCallback = false;

    if (data.startsWith('watch_fc:')) {
      const code = data.slice('watch_fc:'.length);
      const file = this.db.getFileByCode(code);
      if (file) {
        const { item } = this.db.addWatch({
          watch_type: 'app',
          target_slug: file.app_slug,
          display_name: file.app_name,
        });
        toast = `🔔 Watching ${item.display_name}`;
        replyHtml = `🔔 Now watching <b>${escapeTelegramHtml(item.display_name)}</b>!`;
        buttonReplacement = {
          text: `🔕 Unwatch ${item.display_name.slice(0, 22)}`,
          callback_data: `unwatch_fc:${code}`,
        };
      } else {
        toast = '❌ File not found in catalog';
        replyHtml = '❌ File not found in catalog.';
      }
    } else if (data.startsWith('unwatch_fc:')) {
      const code = data.slice('unwatch_fc:'.length);
      const file = this.db.getFileByCode(code);
      if (file) {
        this.db.removeWatchBySlug(file.app_slug);
        replyHtml = `🔕 Stopped watching <b>${escapeTelegramHtml(file.app_name)}</b>.`;
        buttonReplacement = {
          text: `🔔 Watch ${file.app_name.slice(0, 22)}`,
          callback_data: `watch_fc:${code}`,
        };
      } else {
        replyHtml = '🔕 Stopped watching.';
      }
      toast = '🔕 Unwatched';
    } else if (data.startsWith('watch_slug:')) {
      const slug = data.slice('watch_slug:'.length);
      const { item } = this.db.addWatch({ watch_type: 'app', target_slug: slug });
      toast = `🔔 Watching ${item.display_name}`;
      replyHtml = `🔔 Now watching <b>${escapeTelegramHtml(item.display_name)}</b>!`;
    } else if (data.startsWith('unwatch_slug:')) {
      const slug = data.slice('unwatch_slug:'.length);
      this.db.removeWatchBySlug(slug);
      toast = '🔕 Unwatched';
      replyHtml = `🔕 Stopped watching <code>${escapeTelegramHtml(slug)}</code>.`;
    } else if (data.startsWith('unwatch_id:')) {
      const id = Number.parseInt(data.slice('unwatch_id:'.length), 10);
      const existing = Number.isFinite(id)
        ? this.db.listWatchlist().find((w) => w.id === id)
        : null;
      if (Number.isFinite(id)) this.db.removeWatch(id);
      toast = '🗑 Removed from watchlist';
      replyHtml = existing
        ? `🗑 Removed <b>${escapeTelegramHtml(existing.display_name)}</b> from your watchlist.`
        : '🗑 Removed from your watchlist.';
      removeRowByCallback = true;
    }

    // Update inline keyboard on the message when available (works both live & in delayed cron runs)
    const origKeyboard = cb.message?.reply_markup?.inline_keyboard;
    if (cb.message?.message_id && Array.isArray(origKeyboard) && (buttonReplacement || removeRowByCallback)) {
      const nextKeyboard = removeRowByCallback
        ? origKeyboard.filter((row) => !row.some((b) => b.callback_data === data))
        : origKeyboard.map((row) =>
            row.map((b) => (b.callback_data === data ? { ...b, ...buttonReplacement } : b))
          );
      await this.apiCall(token, 'editMessageReplyMarkup', {
        chat_id: chatId,
        message_id: cb.message.message_id,
        reply_markup: { inline_keyboard: nextKeyboard },
      }).catch(() => {});
    }

    let answeredToast = false;
    try {
      await this.apiCall(token, 'answerCallbackQuery', {
        callback_query_id: cb.id,
        text: toast,
        show_alert: false,
      });
      answeredToast = true;
    } catch {
      answeredToast = false;
    }

    // If callback_query expired before cron ran (>30s), send explicit chat confirmation so user gets feedback
    if (!answeredToast && replyHtml) {
      await this.sendReply(token, chatId, replyHtml).catch(() => {});
    }
  }
}

module.exports = { TelegramBotRunner };
