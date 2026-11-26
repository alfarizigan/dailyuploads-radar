'use strict';

class SyncManager {
  constructor({ db, scraper, notifier }) {
    this.db = db;
    this.scraper = scraper;
    this.notifier = notifier;
    this.activeSyncs = new Map();
    this.progressBySource = new Map();
    this.schedulerTimer = null;
  }

  getStatus() {
    const running = [];
    for (const [source, info] of this.progressBySource.entries()) {
      running.push({ source, ...info });
    }
    return {
      isSyncing: this.activeSyncs.size > 0,
      running,
      sources: this.db.listSources(),
      recentLogs: this.db.getSyncLogs(10),
    };
  }

  async syncSource(sourceUser, { mode = 'auto' } = {}) {
    if (this.activeSyncs.has(sourceUser)) {
      return this.activeSyncs.get(sourceUser);
    }

    const promise = this._runSync(sourceUser, mode).finally(() => {
      this.activeSyncs.delete(sourceUser);
      this.progressBySource.delete(sourceUser);
    });
    this.activeSyncs.set(sourceUser, promise);
    return promise;
  }

  async _runSync(sourceUser, requestedMode) {
    const t0 = Date.now();
    const source = this.db.getSource(sourceUser) || this.db.addSource(sourceUser);

    let effectiveMode = requestedMode;
    if (effectiveMode === 'auto') {
      const needsFull =
        !source.baseline_completed ||
        !source.last_full_sync_at ||
        Date.now() - Date.parse(source.last_full_sync_at) > 24 * 60 * 60 * 1000;
      effectiveMode = needsFull ? 'full' : 'quick';
    }

    const updateProgress = (info) => {
      const payload = { mode: effectiveMode, startedAt: new Date(t0).toISOString(), ...info };
      this.progressBySource.set(sourceUser, payload);
      if (this.notifier) {
        this.notifier.broadcastSse('sync_progress', { sourceUser, ...payload });
      }
    };

    updateProgress({ stage: 'starting', page: 0, totalPages: 1, fetchedSoFar: 0 });

    try {
      let scrapeResult;
      if (effectiveMode === 'full') {
        scrapeResult = await this.scraper.fetchAllFiles(sourceUser, {
          onProgress: updateProgress,
        });
      } else {
        const knownCodes = this.db.getKnownFileCodes(sourceUser);
        scrapeResult = await this.scraper.fetchRecentFiles(sourceUser, {
          knownFileCodes: knownCodes,
          onProgress: updateProgress,
        });
      }

      const saveResult = this.db.saveSyncResult(sourceUser, scrapeResult.items, {
        mode: effectiveMode,
        totalReported: scrapeResult.totalReported,
      });

      let triggeredAlerts = [];
      if (!saveResult.isBaseline && saveResult.newFiles.length > 0) {
        triggeredAlerts = this.db.matchWatchlistForNewFiles(saveResult.newFiles);
        if (triggeredAlerts.length > 0 && this.notifier) {
          await this.notifier.notifyAlerts(triggeredAlerts);
        }
      }

      const durationMs = Date.now() - t0;
      this.db.logSync({
        sourceUser,
        mode: effectiveMode,
        status: 'ok',
        totalFetched: saveResult.totalFetched,
        newFiles: saveResult.newFiles.length,
        alertsTriggered: triggeredAlerts.length,
        durationMs,
      });

      const summary = {
        ok: true,
        sourceUser,
        mode: effectiveMode,
        isBaseline: saveResult.isBaseline,
        totalFetched: saveResult.totalFetched,
        totalReported: scrapeResult.totalReported,
        newFilesCount: saveResult.newFiles.length,
        deactivatedCount: saveResult.deactivatedCount,
        alertsTriggered: triggeredAlerts.length,
        durationMs,
      };

      if (this.notifier) {
        this.notifier.broadcastSse('sync_complete', summary);
      }

      return summary;
    } catch (err) {
      const durationMs = Date.now() - t0;
      this.db.logSync({
        sourceUser,
        mode: effectiveMode,
        status: 'error',
        durationMs,
        errorMessage: err.message || String(err),
      });
      if (this.notifier) {
        this.notifier.broadcastSse('sync_error', {
          sourceUser,
          mode: effectiveMode,
          error: err.message || String(err),
        });
      }
      throw err;
    }
  }

  async syncAllSources({ mode = 'auto' } = {}) {
    const sources = this.db.listSources().filter((s) => s.enabled);
    const results = [];
    for (const s of sources) {
      try {
        results.push(await this.syncSource(s.username, { mode }));
      } catch (err) {
        results.push({ ok: false, sourceUser: s.username, error: err.message });
      }
    }
    return results;
  }

  startScheduler() {
    this.stopScheduler();
    const settings = this.db.getSettings();
    const mins = Number(settings.sync_interval_minutes) || 0;
    if (mins <= 0) return;

    const intervalMs = Math.max(1, mins) * 60 * 1000;
    this.schedulerTimer = setInterval(() => {
      this.syncAllSources({ mode: 'auto' }).catch((err) => {
        console.error('[Scheduler] Sync error:', err.message);
      });
    }, intervalMs);
    if (this.schedulerTimer.unref) this.schedulerTimer.unref();
  }

  stopScheduler() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = null;
    }
  }
}

module.exports = { SyncManager };
