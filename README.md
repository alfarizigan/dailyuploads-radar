# 🛰️ DailyUploads Radar (Cloud + Local)

**Instant App Searcher, Filter, Version Tracker, 24/7 Update Notifier & Interactive Telegram Bot** for DailyUploads catalogs (pre-configured for [`https://dailyuploads.net/users/user_hidden`](https://dailyuploads.net/users/user_hidden)).

🌐 **Live Cloud Web App (24/7 Instant Search — Zero Local Server Required):**  
👉 **[https://alfarizigan.github.io/dailyuploads-radar/](https://alfarizigan.github.io/dailyuploads-radar/)**

⚡ **Serverless Cloud Auto-Sync Architecture:**  
Runs automatically on **GitHub Actions** (`7,22,37,52 * * * *` staggered 15-minute schedule: lightweight Quick Sync ~2s + automatic Full Sync every 24h), persisting compact state to the orphan `radar-state` branch without polluting `main` commit history.

---

## ✨ Key Features

1. **Instant Search, Multi-Facet Filter & Sort (Cloud Web UI & Local SQLite FTS5)**
   - Search thousands of files in milliseconds (`/` keyboard shortcut to focus search, URL query deep-linking & 1-click shareable filter links).
   - Smart filename parser extracts clean app names, semantic/build/commit versions (`v9.2.2`, `0.8.1`, `Build 11`, split archives `.zip.001`), platforms (`iOS`, `macOS`, `Windows`, `Archive`), formats (`.ipa`, `.dmg`, `.pkg`, `.tipa`, `.zip`, `.deb`, `.exe`), Minimum iOS (`os15` / `os161` / `os270` → `iOS 15.0+` / `iOS 16.1+` / `iOS 27.0+`), file sizes, download counts, upload age, and release tags (`VIP`, `Pro`, `Subscribed`, `Unsigned`, `Universal`, `iPad`, `TNT`, `MacKed`, `Incl. DLC`, `TrollStore`).
   - **Group by App**: Collapses multiple builds/versions of the same app into a single clean card with a **Version History & Details** modal (`N builds`).
   - **Grid & Compact Table Views**, mobile-optimized responsive layout, PWA home-screen manifest, and **CSV / JSON Export**.

2. **Zero-Cache Cloud Sync & 24/7 Update Notifications**
   - **Zero Git Bloat**: Catalog state is stored in a compact tuple format on the orphan `radar-state` branch (~138 KB compressed for 2,160+ files).
   - **Zero-Stale-Cache Refresh**: Manual refresh and tab-resume resolve the exact head commit SHA on `radar-state` (with multi-CDN fallback across GitHub Raw, jsDelivr, and GitHub Pages) so fresh syncs appear immediately without waiting for CDN branch-cache expiry.
   - **Flexible Watchlist**:
     - Watch specific apps or free-form keywords (`Spotify`, `YouTube`, `Procreate`, etc.) with optional platform filters.
     - Manage rules via **Telegram Bot** (`/watch`, `/unwatch`, `/watchlist`, or inline `🔔 Watch` buttons), declarative [`watchlist.json`](./watchlist.json), or directly from the **Cloud Web UI**.
   - **Multi-Channel Push Alerts**:
     - **Telegram Bot**: Automatic push notifications with version diffs (`v9.2.1 → v9.2.2`) + direct download links, plus interactive commands (`/search`, `/latest`, `/watch`, `/unwatch`, `/watchlist`, `/updates`, `/sync`, `/stats`).
     - **Discord / Generic Webhook**: Rich Discord Embeds or standard JSON POST payloads.

---

## ☁️ Setting Up 24/7 Telegram / Discord Push Alerts in Cloud

The Web Searcher at **[alfarizigan.github.io/dailyuploads-radar](https://alfarizigan.github.io/dailyuploads-radar/)** works out of the box with zero configuration!

To receive **automatic 24/7 mobile push alerts** when watched apps get updated:

1. Create a Telegram bot via **[@BotFather](https://t.me/BotFather)** (`/newbot`) and copy the **Bot Token**.
2. Open your bot in Telegram and send `/start`. In the Web UI **Settings** tab, paste your Bot Token → click **🔍 Auto-Detect Chat ID** → click **🧪 Test Telegram** to verify delivery.
3. In your GitHub repository, go to **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:
   - `TELEGRAM_BOT_TOKEN` = Your BotFather token
   - `TELEGRAM_CHAT_ID` = Your Telegram Chat ID (comma-separated for multiple chats)
   - *(Optional)* `WEBHOOK_URL` = Discord or custom webhook URL
4. Add watch rules anytime by:
   - Sending `/watch Spotify` (or tapping `🔔 Watch` on `/search` results) in Telegram,
   - Connecting an optional GitHub Personal Access Token in Web Settings for 1-click Web Watchlist sync & live workflow dispatch, or
   - Editing [`watchlist.json`](./watchlist.json):
     ```json
     [
       { "watch_type": "keyword", "keyword": "Spotify", "platform_filter": "iOS" },
       { "watch_type": "app", "target_slug": "lumafusion", "display_name": "LumaFusion" }
     ]
     ```

> **Note on GitHub Actions `schedule` Timing:** GitHub's free public runner scheduler executes cron jobs on a best-effort basis (typically every 15–30 minutes depending on GitHub platform load, and pauses after 60 days without repository activity). For strict down-to-the-minute 15m execution, you can optionally point a free external scheduler (such as [cron-job.org](https://cron-job.org)) at the GitHub REST API `dispatches` endpoint (`POST /repos/<owner>/<repo>/dispatches` with `{"event_type":"radar-sync"}`).

---

## 💻 Running Locally on PC (Optional)

For instant real-time Telegram long-polling, SSE live progress streaming, and native Windows Toast notifications:

```powershell
npm start
# Open http://localhost:3456
```

## 🧪 Running Automated Tests

```powershell
npm test
```
