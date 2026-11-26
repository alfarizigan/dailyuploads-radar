# 🛰️ DailyUploads Radar (Cloud + Local)

**Smart Searcher, Filter, Sort, Version Tracker, Update Notifier + Interactive Telegram Bot** untuk katalog DailyUploads (pre-configured untuk [`https://dailyuploads.net/users/user_hidden`](https://dailyuploads.net/users/user_hidden)).

🌐 **Live Cloud Web App (24/7 Instan Tanpa PC):**  
👉 **[https://alfarizigan.github.io/dailyuploads-radar/](https://alfarizigan.github.io/dailyuploads-radar/)**

⚡ **Cloud Auto-Sync Engine:**  
Berjalan otomatis di **GitHub Actions** setiap ~15 menit (Quick Sync ~2 detik + Full Sync otomatis tiap 24 jam) — **100% gratis di cloud tanpa perlu menyalakan PC/server sendiri!**

---

## ✨ Fitur Utama

1. **Instant Search, Filter & Sort (Cloud Web UI & Local SQLite FTS5)**
   - Cari ribuan file dalam hitungan milidetik (`/` untuk langsung fokus ke kolom pencarian).
   - Otomatis mengekstrak nama aplikasi, versi (`v9.2.2`, `0.8.1`, `3.25`, `Build 11`), platform (`iOS`, `macOS`, `Windows`, `Archive`), format (`.ipa`, `.dmg`, `.pkg`, `.tipa`, `.zip`, `.deb`, `.exe`), Minimum iOS (`os150` → `iOS 15.0+`), ukuran, jumlah download, usia upload, dan tag (`VIP`, `Pro`, `Subscribed`, `Unsigned`, `Universal`, `iPad`, `TNT`, `MacKed`, `Incl. DLC`, `TrollStore`).
   - **Group by App**: Menggabungkan beberapa versi/build dari aplikasi yang sama menjadi 1 kartu rapi + modal **Detail & Riwayat Versi** (`N builds`).
   - Tampilan **Card Grid** maupun **Compact Table**, plus **Export CSV / JSON**.

2. **Cloud Auto-Sync & Notifikasi Update 24/7 (GitHub Actions)**
   - **Zero Git Bloat**: State katalog disimpan dalam format tuple ringkas di orphan branch `radar-state` & `gh-pages` (hanya ~138 KB terkompresi untuk 2.170+ file, tidak menumpuk riwayat commit di `main`).
   - **Watchlist Fleksibel**:
     - Pantau aplikasi spesifik atau keyword bebas (`Spotify`, `YouTube`, `Procreate`, dll.).
     - Bisa ditambahkan lewat **Bot Telegram** (`/watch NamaApp` atau tombol inline `🔔 Watch`), lewat file [`watchlist.json`](./watchlist.json), maupun langsung dari **Cloud Web UI**.
   - **Multi-Channel Push Alert**:
     - **Telegram Bot** (Push notifikasi otomatis lengkap dengan perbandingan versi `v9.2.1 → v9.2.2` + link download, sekaligus menerima perintah `/search`, `/latest`, `/watch`, `/watchlist`, `/updates`, `/sync`, `/stats`).
     - **Discord / Generic Webhook** (otomatis format Discord Embed).

---

## ☁️ Cara Mengaktifkan Notifikasi Telegram / Discord di Cloud (GitHub Actions)

Katalog Web di **[alfarizigan.github.io/dailyuploads-radar](https://alfarizigan.github.io/dailyuploads-radar/)** sudah langsung aktif dan ter-update otomatis tanpa konfigurasi tambahan!

Jika ingin menerima **notifikasi otomatis di HP (Telegram / Discord)** saat aplikasi yang ditandai ada update baru:

1. Buat bot di Telegram lewat **[@BotFather](https://t.me/BotFather)** (`/newbot`) → salin **Bot Token**.
2. Ambil **Chat ID** Telegram kamu (bisa chat ke `@userinfobot`, atau uji langsung lewat tab **Pengaturan → 🧪 Test Kirim Telegram** di Web UI).
3. Buka repo ini di GitHub → **Settings** → **Secrets and variables** → **Actions** → klik **New repository secret**:
   - `TELEGRAM_BOT_TOKEN` = Token dari BotFather
   - `TELEGRAM_CHAT_ID` = Chat ID Telegram kamu (bisa lebih dari satu, pisahkan dengan koma)
   - *(Opsional)* `WEBHOOK_URL` = URL Webhook Discord / custom
4. Selesai! Sekarang kamu bisa:
   - Mengirim `/watch Spotify` (atau klik tombol `🔔 Watch` pada hasil `/search`) ke Bot Telegram kamu — saat jadwal GitHub Actions berjalan (atau saat kamu klik **Run workflow** di tab **Actions**), bot akan membalas & memantau aplikasi tersebut 24/7!
   - Atau menambahkan daftar pantauan langsung di file [`watchlist.json`](./watchlist.json), contoh:
     ```json
     [
       { "watch_type": "keyword", "keyword": "Spotify", "platform_filter": "iOS" },
       { "watch_type": "app", "target_slug": "lumafusion", "display_name": "LumaFusion" }
     ]
     ```

---

## 💻 Menjalankan Secara Lokal di PC (Opsional)

Jika sewaktu-waktu ingin dijalankan sebagai server lokal dengan *long-polling* instan & Windows Native Toast:

```powershell
npm start
# Buka http://localhost:3456
```

## 🧪 Menjalankan Automated Tests

```powershell
npm test
```
