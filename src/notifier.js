'use strict';

const { execFile } = require('node:child_process');

function escapeTelegramHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatAlertSummary(alert) {
  const verDiff =
    alert.old_version && alert.new_version && alert.old_version !== alert.new_version
      ? `v${alert.old_version} → v${alert.new_version}`
      : alert.new_version
        ? `v${alert.new_version}`
        : 'New Upload';
  return {
    title: `Update: ${alert.app_name}`,
    versionDiff: verDiff,
    body: `${verDiff} • ${alert.size_text || 'Unknown size'} (${alert.platform || 'App'})`,
  };
}

class Notifier {
  constructor(db, options = {}) {
    this.db = db;
    this.sseClients = new Set();
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.enableOsToast = options.enableOsToast !== undefined ? options.enableOsToast : true;
  }

  addSseClient(res) {
    this.sseClients.add(res);
  }

  removeSseClient(res) {
    this.sseClients.delete(res);
  }

  broadcastSse(eventName, payload) {
    const data = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const res of this.sseClients) {
      try {
        res.write(data);
      } catch {
        this.sseClients.delete(res);
      }
    }
  }

  async notifyAlerts(alerts) {
    if (!Array.isArray(alerts) || alerts.length === 0) return { sent: 0, errors: [] };

    const settings = this.db.getSettings();
    const errors = [];

    // 1. Always broadcast SSE to connected web clients
    this.broadcastSse('alerts', {
      count: alerts.length,
      alerts,
    });

    // 2. Windows Native Toast (summarize if >3 alerts at once)
    if (this.enableOsToast && settings.windows_toast_enabled && process.platform === 'win32') {
      try {
        if (alerts.length === 1) {
          const info = formatAlertSummary(alerts[0]);
          await this.sendWindowsToast(info.title, info.body);
        } else {
          const names = alerts
            .slice(0, 3)
            .map((a) => a.app_name)
            .join(', ');
          const extra = alerts.length > 3 ? ` +${alerts.length - 3} more` : '';
          await this.sendWindowsToast(
            `${alerts.length} New Updates on DailyUploads!`,
            `${names}${extra}`
          );
        }
      } catch (err) {
        errors.push({ channel: 'windows_toast', message: err.message });
      }
    }

    // 3. Telegram Notification
    if (settings.telegram_bot_token && settings.telegram_chat_id) {
      try {
        await this.sendTelegramAlerts(settings.telegram_bot_token, settings.telegram_chat_id, alerts);
      } catch (err) {
        errors.push({ channel: 'telegram', message: err.message });
      }
    }

    // 4. Discord / Generic Webhook
    if (settings.webhook_url) {
      try {
        await this.sendWebhookAlerts(settings.webhook_url, alerts);
      } catch (err) {
        errors.push({ channel: 'webhook', message: err.message });
      }
    }

    return { sent: alerts.length, errors };
  }

  sendWindowsToast(title, body) {
    return new Promise((resolve, reject) => {
      if (process.platform !== 'win32') {
        resolve(false);
        return;
      }
      // Strictly pass strings via env vars to prevent any shell injection.
      // Use PowerShell's registered AppUserModelID so Windows 10/11 displays the toast instead of silently dropping it.
      const psScript = `
        $ErrorActionPreference = 'Stop'
        [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
        [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
        $t = [System.Security.SecurityElement]::Escape($env:DU_TOAST_TITLE)
        $b = [System.Security.SecurityElement]::Escape($env:DU_TOAST_BODY)
        $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
        $xml.LoadXml("<toast><visual><binding template='ToastText02'><text id='1'>$t</text><text id='2'>$b</text></binding></visual></toast>")
        $toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
        $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
        $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId)
        $notifier.Show($toast)
      `;
      execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', psScript],
        {
          timeout: 8000,
          env: {
            ...process.env,
            DU_TOAST_TITLE: String(title || 'DailyUploads Radar').slice(0, 120),
            DU_TOAST_BODY: String(body || '').slice(0, 240),
          },
        },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error((stderr || err.message || 'Failed to display Windows Toast').trim().slice(0, 200)));
            return;
          }
          resolve(true);
        }
      );
    });
  }

  async sendTelegramMessage(token, chatId, htmlText, extra = {}) {
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: htmlText,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...extra,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      throw new Error(data.description || `Telegram API error (${res.status})`);
    }
    return data;
  }

  async sendTelegramAlerts(token, chatIdConfig, alerts) {
    const chatIds = String(chatIdConfig || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (chatIds.length === 0) {
      throw new Error('Telegram Chat ID is empty.');
    }

    const errors = [];
    for (const chatId of chatIds) {
      try {
        // Batch up to 5 alerts per message to respect Telegram 4096 char limit
        for (let i = 0; i < alerts.length; i += 5) {
          const batch = alerts.slice(i, i + 5);
          const lines = ['🔔 <b>DailyUploads Radar — New Update Detected!</b>\n'];
          for (const a of batch) {
            const info = formatAlertSummary(a);
            lines.push(
              `📦 <b>${escapeTelegramHtml(a.app_name)}</b>`,
              `• Version: <code>${escapeTelegramHtml(info.versionDiff)}</code>`,
              `• Platform: ${escapeTelegramHtml(a.platform)} | Size: ${escapeTelegramHtml(a.size_text || '-')}`,
              `• Watch rule: <i>${escapeTelegramHtml(a.watch_name)}</i>`,
              `• <a href="${escapeTelegramHtml(a.download_url)}">Open Download Link</a>\n`
            );
          }
          await this.sendTelegramMessage(token, chatId, lines.join('\n'));
        }
      } catch (err) {
        errors.push(`chat ${chatId}: ${err.message}`);
      }
    }

    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
  }

  async sendWebhookAlerts(webhookUrl, alerts) {
    const isDiscord = /discord(?:app)?\.com\/api\/webhooks\//i.test(webhookUrl);
    let payload;
    if (isDiscord) {
      payload = {
        username: 'DailyUploads Radar',
        content: `🔔 **${alerts.length} new update${alerts.length === 1 ? '' : 's'} detected on DailyUploads!**`,
        embeds: alerts.slice(0, 10).map((a) => {
          const info = formatAlertSummary(a);
          return {
            title: `${a.app_name} (${info.versionDiff})`,
            url: a.download_url,
            color: 0x3b82f6,
            fields: [
              { name: 'Platform', value: a.platform || '-', inline: true },
              { name: 'Size', value: a.size_text || '-', inline: true },
              { name: 'Watch Rule', value: a.watch_name || '-', inline: true },
              { name: 'Filename', value: `\`${a.raw_filename.slice(0, 200)}\``, inline: false },
            ],
            timestamp: a.created_at || new Date().toISOString(),
          };
        }),
      };
    } else {
      payload = {
        event: 'dailyuploads.update',
        timestamp: new Date().toISOString(),
        count: alerts.length,
        alerts,
      };
    }

    const res = await this.fetchFn(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Webhook HTTP ${res.status}: ${txt.slice(0, 160)}`);
    }
    return true;
  }

  async sendTest(channel, overrides = {}) {
    const saved = this.db.getSettings();
    const settings = {
      ...saved,
      ...(overrides.telegram_bot_token !== undefined ? { telegram_bot_token: String(overrides.telegram_bot_token).trim() } : {}),
      ...(overrides.telegram_chat_id !== undefined ? { telegram_chat_id: String(overrides.telegram_chat_id).trim() } : {}),
      ...(overrides.webhook_url !== undefined ? { webhook_url: String(overrides.webhook_url).trim() } : {}),
    };
    const sampleAlert = {
      app_name: 'Spotify-Shrubify (Test Alert)',
      old_version: '9.2.1',
      new_version: '9.2.2',
      platform: 'iOS',
      size_text: '173.9 MB',
      watch_name: 'Test Notification',
      raw_filename: 'Spotify-Shrubify_(v9.2.2_Univ_64bit_os161)-user_hidden.bfi2.ipa',
      download_url: 'https://dailyuploads.net/users/user_hidden',
      created_at: new Date().toISOString(),
    };

    if (channel === 'telegram') {
      if (!settings.telegram_bot_token || !settings.telegram_chat_id) {
        throw new Error('Enter both Telegram Bot Token and Chat ID first.');
      }
      await this.sendTelegramAlerts(settings.telegram_bot_token, settings.telegram_chat_id, [sampleAlert]);
      return { ok: true, channel: 'telegram' };
    }

    if (channel === 'webhook') {
      if (!settings.webhook_url) {
        throw new Error('Enter a Webhook URL first.');
      }
      await this.sendWebhookAlerts(settings.webhook_url, [sampleAlert]);
      return { ok: true, channel: 'webhook' };
    }

    if (channel === 'windows_toast') {
      if (process.platform !== 'win32') {
        throw new Error('Windows Toast is only available on Windows.');
      }
      await this.sendWindowsToast('DailyUploads Radar — Test', 'Windows desktop notifications are active and working!');
      return { ok: true, channel: 'windows_toast' };
    }

    throw new Error(`Unknown notification channel: ${channel}`);
  }
}

module.exports = { Notifier, formatAlertSummary, escapeTelegramHtml };
