'use strict';

const { config } = require('./config');
const { parsePageMeta, parseFileCards } = require('./parser');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url, options = {}, retries = 3) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs || config.requestTimeoutMs);
      try {
        const res = await fetch(url, {
          ...options,
          signal: controller.signal,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        const text = await res.text();
        if (options.returnMeta) {
          const setCookies =
            typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
          const cookieHeader = setCookies
            .map((c) => String(c).split(';')[0].trim())
            .filter(Boolean)
            .join('; ');
          return { text, cookieHeader };
        }
        return text;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(500 * attempt);
      }
    }
  }
  throw lastError;
}

class DailyUploadsScraper {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://dailyuploads.net';
    this.userAgent = options.userAgent || config.userAgent;
    this.timeoutMs = options.timeoutMs || config.requestTimeoutMs;
    this.cookieByUser = new Map();
  }

  async fetchLandingMeta(sourceUser) {
    const cleanUser = String(sourceUser || '').trim();
    if (!cleanUser || !/^[a-zA-Z0-9._-]+$/.test(cleanUser)) {
      throw new Error(`Invalid DailyUploads username: "${sourceUser}"`);
    }
    const url = `${this.baseUrl}/users/${encodeURIComponent(cleanUser)}`;
    const { text: html, cookieHeader } = await fetchWithRetry(url, {
      method: 'GET',
      headers: {
        'User-Agent': this.userAgent,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      timeoutMs: this.timeoutMs,
      returnMeta: true,
    });

    if (cookieHeader) {
      this.cookieByUser.set(cleanUser, cookieHeader);
    }

    const meta = parsePageMeta(html);
    const initialItems = parseFileCards(html, cleanUser);
    if (!meta.token && initialItems.length === 0) {
      throw new Error(`Failed to parse DailyUploads page for user "${cleanUser}" (no token or files found)`);
    }
    return { ...meta, initialItems, landingUrl: url };
  }

  async fetchFilesPage(sourceUser, token, page = 1, perPage = 500) {
    const cleanUser = String(sourceUser || '').trim();
    const body = new URLSearchParams({
      op: 'user_public',
      load_files_list: '1',
      page: String(page),
      fld_id: '',
      usr_login: cleanUser,
      token: String(token),
      per_page: String(perPage),
    });

    const headers = {
      'User-Agent': this.userAgent,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: this.baseUrl,
      Referer: `${this.baseUrl}/users/${encodeURIComponent(cleanUser)}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    };
    const savedCookie = this.cookieByUser.get(cleanUser);
    if (savedCookie) {
      headers.Cookie = savedCookie;
    }

    const html = await fetchWithRetry(this.baseUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
      timeoutMs: this.timeoutMs,
    });

    return parseFileCards(html, cleanUser);
  }

  async fetchAllFiles(sourceUser, { perPage = config.perPageFull, onProgress } = {}) {
    const meta = await this.fetchLandingMeta(sourceUser);
    const total = meta.totalFiles || meta.initialItems.length;

    if (total === 0) {
      return { items: [], totalReported: 0, pagesFetched: 1 };
    }

    if (!meta.token) {
      return { items: meta.initialItems, totalReported: total, pagesFetched: 1 };
    }

    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const seen = new Set();
    const allItems = [];

    for (let page = 1; page <= totalPages; page += 1) {
      if (onProgress) {
        onProgress({
          stage: 'fetching',
          page,
          totalPages,
          fetchedSoFar: allItems.length,
          totalReported: total,
        });
      }

      const pageItems = await this.fetchFilesPage(sourceUser, meta.token, page, perPage);
      if (pageItems.length === 0 && total > 0) {
        if (page === 1 || allItems.length < total * 0.8) {
          throw new Error(
            `DailyUploads returned empty file list on page ${page}/${totalPages} (fetched ${allItems.length}/${total})`
          );
        }
        break;
      }
      for (const item of pageItems) {
        if (!seen.has(item.file_code)) {
          seen.add(item.file_code);
          allItems.push(item);
        }
      }

      if (pageItems.length < perPage) {
        break;
      }
      if (page < totalPages) {
        await sleep(150);
      }
    }

    return {
      items: allItems,
      totalReported: total,
      pagesFetched: totalPages,
    };
  }

  async fetchRecentFiles(
    sourceUser,
    { knownFileCodes = new Set(), perPage = config.perPageQuick, maxPages = 5, onProgress } = {}
  ) {
    const meta = await this.fetchLandingMeta(sourceUser);
    const total = meta.totalFiles || meta.initialItems.length;

    if (total === 0) {
      return { items: [], totalReported: 0, pagesFetched: 1, hitKnownBoundary: true };
    }

    if (!meta.token) {
      return {
        items: meta.initialItems,
        totalReported: total,
        pagesFetched: 1,
        hitKnownBoundary: true,
      };
    }

    const totalPages = Math.min(maxPages, Math.max(1, Math.ceil(total / perPage)));
    const seen = new Set();
    const collected = [];
    let hitKnownBoundary = false;

    for (let page = 1; page <= totalPages; page += 1) {
      if (onProgress) {
        onProgress({
          stage: 'quick-sync',
          page,
          totalPages,
          fetchedSoFar: collected.length,
          totalReported: total,
        });
      }

      const pageItems = await this.fetchFilesPage(sourceUser, meta.token, page, perPage);
      if (page === 1 && pageItems.length === 0 && total > 0) {
        throw new Error(`DailyUploads returned empty file list on quick sync page 1 (expected ${total} total files)`);
      }
      let foundKnownOnPage = 0;

      for (const item of pageItems) {
        if (!seen.has(item.file_code)) {
          seen.add(item.file_code);
          collected.push(item);
          if (knownFileCodes.has(item.file_code)) {
            foundKnownOnPage += 1;
          }
        }
      }

      if (foundKnownOnPage > 0 || pageItems.length < perPage) {
        hitKnownBoundary = true;
        break;
      }
      if (page < totalPages) {
        await sleep(150);
      }
    }

    return {
      items: collected,
      totalReported: total,
      pagesFetched: totalPages,
      hitKnownBoundary,
    };
  }
}

module.exports = { DailyUploadsScraper };
