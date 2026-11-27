'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { config } = require('./config');

const DEFAULT_REPO = 'alfarizigan/dailyuploads-radar';
const DEFAULT_WORKFLOW = 'radar-sync.yml';
const DEFAULT_MAX_AGE_MINUTES = 13.5;
const FAILURE_BACKOFF_MINUTES = 10;
const MAX_LOG_LINES = 200;

function isValidRepoSlug(repo) {
  return Boolean(repo && /^[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/.test(repo));
}

function readGitCredentialToken(repo = DEFAULT_REPO) {
  const credQuery = `protocol=https\nhost=github.com\npath=${repo}.git\n\n`;
  const env = {
    ...process.env,
    GCM_INTERACTIVE: 'never',
    GIT_TERMINAL_PROMPT: '0',
  };

  const gitCandidates = ['git', 'C:\\Program Files\\Git\\cmd\\git.exe'];
  for (const gitBin of gitCandidates) {
    try {
      const res = spawnSync(gitBin, ['credential', 'fill'], {
        input: credQuery,
        encoding: 'utf8',
        env,
        timeout: 5000,
        windowsHide: true,
      });
      if (res.error) {
        if (res.error.code === 'ENOENT') continue;
        return '';
      }
      if (res.status !== 0 || !res.stdout) return '';
      const passLine = res.stdout
        .split(/\r?\n/)
        .find((line) => line.startsWith('password='));
      return passLine ? passLine.slice('password='.length).trim() : '';
    } catch {
      // Try next candidate or return empty
    }
  }
  return '';
}

function appendBoundedLog(logPath, line) {
  if (!logPath) return;
  try {
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    let existing = [];
    if (fs.existsSync(logPath)) {
      existing = fs
        .readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean);
    }
    existing.push(`[${new Date().toISOString()}] ${line}`);
    if (existing.length > MAX_LOG_LINES) {
      existing = existing.slice(-MAX_LOG_LINES);
    }
    fs.writeFileSync(logPath, `${existing.join('\n')}\n`, 'utf8');
  } catch {
    // Non-fatal logging error
  }
}

async function fetchWithTimeout(fetchFn, url, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function pingCloudSync(options = {}) {
  const repo = String(options.repo || process.env.GITHUB_REPO || DEFAULT_REPO).trim();
  const workflowFile = options.workflowFile || DEFAULT_WORKFLOW;
  const force = Boolean(options.force);
  const maxAgeMinutes =
    options.maxAgeMinutes !== undefined
      ? Number(options.maxAgeMinutes)
      : DEFAULT_MAX_AGE_MINUTES;
  const nowMs = options.nowMs !== undefined ? Number(options.nowMs) : Date.now();
  const fetchFn = options.fetchFn || globalThis.fetch;
  const logPath =
    options.logPath !== undefined
      ? options.logPath
      : path.join(config.dataDir, 'cloud-pinger.log');

  if (!isValidRepoSlug(repo)) {
    const err = new Error(`Invalid GitHub repository slug: "${repo}"`);
    appendBoundedLog(logPath, `ERROR ${err.message}`);
    throw err;
  }

  const token =
    options.token !== undefined
      ? String(options.token).trim()
      : String(
          process.env.GITHUB_PAT ||
            process.env.GITHUB_TOKEN ||
            readGitCredentialToken(repo) ||
            ''
        ).trim();

  if (!token) {
    const res = {
      ok: false,
      dispatched: false,
      skipped: true,
      reason: 'missing_token',
      repo,
    };
    appendBoundedLog(logPath, `SKIP missing_token (${repo})`);
    return res;
  }

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'DailyUploads-Radar-CloudPinger/1.0',
  };

  let loggedError = false;
  const logAndThrow = (logLine, errorMsg) => {
    appendBoundedLog(logPath, logLine);
    loggedError = true;
    throw new Error(errorMsg);
  };

  try {
    if (!force) {
      const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/runs?per_page=5`;
      const runsRes = await fetchWithTimeout(fetchFn, runsUrl, { headers }, 10000);
      if (runsRes.status === 401) {
        const errBody = await runsRes.json().catch(() => ({}));
        const errMsg = errBody.message || 'HTTP 401 Unauthorized';
        logAndThrow(`ERROR auth failed: ${errMsg}`, `GitHub authentication failed: ${errMsg}`);
      }
      if (runsRes.ok) {
        const data = await runsRes.json().catch(() => ({}));
        const runs = Array.isArray(data.workflow_runs) ? data.workflow_runs : [];

        const activeRun = runs.find((r) =>
          ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(
            String(r.status || '').toLowerCase()
          )
        );
        if (activeRun) {
          const out = {
            ok: true,
            dispatched: false,
            skipped: true,
            reason: 'already_running',
            runId: activeRun.id,
            repo,
          };
          appendBoundedLog(logPath, `SKIP already_running (run=${activeRun.id})`);
          return out;
        }

        const latestSuccess = runs.find((r) => r.conclusion === 'success');
        if (latestSuccess) {
          const ts = Date.parse(
            latestSuccess.updated_at || latestSuccess.run_started_at || latestSuccess.created_at || ''
          );
          if (Number.isFinite(ts)) {
            const ageMin = (nowMs - ts) / 60000;
            if (ageMin >= 0 && ageMin < maxAgeMinutes) {
              const out = {
                ok: true,
                dispatched: false,
                skipped: true,
                reason: 'recent_success',
                ageMinutes: Number(ageMin.toFixed(2)),
                runId: latestSuccess.id,
                repo,
              };
              appendBoundedLog(
                logPath,
                `SKIP recent_success (${out.ageMinutes}m ago < ${maxAgeMinutes}m, run=${latestSuccess.id})`
              );
              return out;
            }
          }
        }

        const latestRun = runs[0];
        if (
          latestRun &&
          latestRun.conclusion &&
          !['success', 'cancelled', 'skipped', 'neutral'].includes(
            String(latestRun.conclusion).toLowerCase()
          )
        ) {
          const failTs = Date.parse(latestRun.updated_at || latestRun.created_at || '');
          if (Number.isFinite(failTs)) {
            const failAgeMin = (nowMs - failTs) / 60000;
            if (failAgeMin >= 0 && failAgeMin < FAILURE_BACKOFF_MINUTES) {
              const out = {
                ok: true,
                dispatched: false,
                skipped: true,
                reason: 'recent_failure_backoff',
                ageMinutes: Number(failAgeMin.toFixed(2)),
                runId: latestRun.id,
                repo,
              };
              appendBoundedLog(
                logPath,
                `SKIP recent_failure_backoff (${out.ageMinutes}m ago, run=${latestRun.id})`
              );
              return out;
            }
          }
        }
      }
    }

    // 1. Primary: repository_dispatch ("radar-sync")
    const repoDispatchUrl = `https://api.github.com/repos/${repo}/dispatches`;
    const dispRes = await fetchWithTimeout(
      fetchFn,
      repoDispatchUrl,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ event_type: 'radar-sync' }),
      },
      10000
    );

    if (dispRes.ok) {
      const out = {
        ok: true,
        dispatched: true,
        method: 'repository_dispatch',
        repo,
      };
      appendBoundedLog(logPath, `DISPATCHED repository_dispatch (${repo})`);
      return out;
    }

    // 2. Fallback: workflow_dispatch (works for fine-grained PATs with Actions:write only, without Contents:write)
    if (dispRes.status === 403 || dispRes.status === 404 || dispRes.status === 422) {
      const wfDispatchUrl = `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`;
      const wfRes = await fetchWithTimeout(
        fetchFn,
        wfDispatchUrl,
        {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: 'main', inputs: { mode: 'auto' } }),
        },
        10000
      );
      if (wfRes.ok) {
        const out = {
          ok: true,
          dispatched: true,
          method: 'workflow_dispatch',
          repo,
        };
        appendBoundedLog(logPath, `DISPATCHED workflow_dispatch (${repo})`);
        return out;
      }
      const wfErr = await wfRes.json().catch(() => ({}));
      const msg = wfErr.message || `HTTP ${wfRes.status}`;
      logAndThrow(`ERROR dispatch failed: ${msg}`, `GitHub dispatch failed: ${msg}`);
    }

    const errBody = await dispRes.json().catch(() => ({}));
    const errMsg = errBody.message || `HTTP ${dispRes.status}`;
    logAndThrow(
      `ERROR repository_dispatch failed: ${errMsg}`,
      `GitHub repository_dispatch failed: ${errMsg}`
    );
  } catch (err) {
    if (!loggedError) {
      const safeMsg = String(err?.message || err || 'Unknown network error').replace(
        token,
        '[REDACTED]'
      );
      appendBoundedLog(logPath, `ERROR network: ${safeMsg}`);
    }
    throw err;
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const repoIdx = args.indexOf('--repo');
  const repo = repoIdx !== -1 && args[repoIdx + 1] ? args[repoIdx + 1] : undefined;

  pingCloudSync({ force, repo })
    .then((res) => {
      if (res.dispatched) {
        console.log(`[CloudPinger] Triggered cloud sync via ${res.method} on ${res.repo}`);
      } else {
        console.log(
          `[CloudPinger] Skipped (${res.reason}${res.ageMinutes !== undefined ? `, ${res.ageMinutes}m ago` : ''})`
        );
      }
      process.exit(res.ok ? 0 : 1);
    })
    .catch((err) => {
      console.error(`[CloudPinger] Error: ${err.message || err}`);
      process.exit(1);
    });
}

module.exports = {
  pingCloudSync,
  readGitCredentialToken,
  appendBoundedLog,
};
