'use strict';

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

function decodeHtmlEntities(str) {
  if (!str) return '';
  return String(str).replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (match, code) => {
    if (code.startsWith('#x') || code.startsWith('#X')) {
      const n = Number.parseInt(code.slice(2), 16);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    if (code.startsWith('#')) {
      const n = Number.parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return NAMED_ENTITIES[code.toLowerCase()] ?? match;
  });
}

function parseSizeToBytes(sizeText) {
  if (!sizeText) return 0;
  const m = String(sizeText).trim().match(/^([\d.,]+)\s*(B|KB|MB|GB|TB)$/i);
  if (!m) return 0;
  const num = Number.parseFloat(m[1].replace(',', '.'));
  if (!Number.isFinite(num)) return 0;
  const unit = m[2].toUpperCase();
  const mult = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] || 1;
  return Math.round(num * mult);
}

function formatBytes(bytes) {
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

function decodePercentEncoded(str) {
  let out = String(str || '');
  // DailyUploads XFileSharing sometimes double-encodes special chars in hrefs (e.g. %2526 -> %26 -> &)
  for (let pass = 0; pass < 2; pass += 1) {
    if (!/%[0-9a-fA-F]{2}/.test(out)) break;
    try {
      const decoded = decodeURIComponent(out);
      if (decoded === out) break;
      out = decoded;
    } catch {
      const replaced = out
        .replace(/%25([0-9a-fA-F]{2})/gi, '%$1')
        .replace(/%([0-9a-fA-F]{2})/g, (m, hex) => {
          const code = Number.parseInt(hex, 16);
          return code >= 32 && code <= 126 ? String.fromCharCode(code) : m;
        });
      if (replaced === out) break;
      out = replaced;
    }
  }
  return out;
}

function parseOsToken(token) {
  // e.g. os15 -> 15.0, os90 -> 9.0, os150 -> 15.0, os161 -> 16.1, os144 -> 14.4, os270 -> 27.0, os1510 -> 15.1, os1500 -> 15.0
  const m1 = String(token).match(/^os(\d{2,4})$/i);
  if (m1) {
    const digits = m1[1];
    if (digits.length === 2) {
      const num = Number.parseInt(digits, 10);
      // os60..os99 denote iOS 6.0..9.9 (e.g. os80 -> 8.0, os90 -> 9.0); os10..os59 denote major iOS 10..59 (e.g. os15 -> 15.0, os18 -> 18.0)
      if (num >= 60) {
        const major = Number.parseInt(digits[0], 10);
        const minor = Number.parseInt(digits[1], 10);
        return Number(`${major}.${minor}`);
      }
      return num;
    }
    if (digits.length === 3 || digits.length === 4) {
      const major = Number.parseInt(digits.slice(0, 2), 10);
      const minor = Number.parseInt(digits[2], 10);
      return Number(`${major}.${minor}`);
    }
  }
  // e.g. ios17+, ios26+, ios15.2+
  const m2 = String(token).match(/^ios(\d+(?:\.\d+)?)\+?$/i);
  if (m2) {
    const n = Number.parseFloat(m2[1]);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function normalizeTagLabel(raw) {
  const cleaned = String(raw).replace(/[_]+/g, ' ').trim();
  const lower = cleaned.toLowerCase();
  const map = {
    vip: 'VIP',
    pro: 'Pro',
    premium: 'Premium',
    subscribed: 'Subscribed',
    unlocked: 'Unlocked',
    full: 'Full',
    plus: 'Plus',
    unsigned: 'Unsigned',
    univ: 'Universal',
    universal: 'Universal',
    ipad: 'iPad',
    iphone: 'iPhone',
    '64bit': '64bit',
    pi: 'PI',
    fw: 'FW',
    lp: 'LP',
    tnt: 'TNT',
    macked: 'MacKed',
    u2b: 'U2B',
    'incl. dlc': 'Incl. DLC',
    'incl dlc': 'Incl. DLC',
    dlc: 'DLC',
    modded: 'Modded',
    trollstore: 'TrollStore',
  };
  return map[lower] || cleaned;
}

function inferPlatform(ext, rawFilename) {
  const e = (ext || '').toLowerCase();
  if (['ipa', 'tipa', 'deb'].includes(e)) return 'iOS';
  if (['dmg', 'pkg'].includes(e)) return 'macOS';
  if (['exe', 'msi'].includes(e)) return 'Windows';
  if (['apk', 'apks', 'xapk'].includes(e)) return 'Android';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(e)) {
    if (/macos|osx|\bmac\b/i.test(rawFilename)) return 'macOS';
    if (/\bios\b|iphone|ipad|trollstore/i.test(rawFilename)) return 'iOS';
    if (/win64|win32|windows/i.test(rawFilename)) return 'Windows';
    return 'Archive';
  }
  if (e === 'iso') return 'Windows';
  return 'Other';
}

function slugifyAppName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/\+/g, ' plus ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || 'unknown-app';
}

function cleanDisplayName(str) {
  return String(str || '')
    .replace(/[_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._-]+|[\s._-]+$/g, '')
    .trim();
}

function parseFilename(rawFilename) {
  const filename = String(rawFilename || '').trim();
  const tags = new Set();
  let version = '';
  let minIos = null;
  let releaseGroup = '';

  // 1. Split extension (including multi-part split archives like .zip.001, .rar.002, .7z.004)
  let extension = '';
  let base = filename;
  const splitArchiveMatch = filename.match(/^(.+)\.(zip|rar|7z|tar|gz|iso|dmg|pkg)\.(\d{3})$/i);
  if (splitArchiveMatch) {
    base = splitArchiveMatch[1];
    extension = splitArchiveMatch[2].toLowerCase();
    tags.add(`Part ${splitArchiveMatch[3]}`);
  } else {
    const lastDot = filename.lastIndexOf('.');
    extension = lastDot > 0 ? filename.slice(lastDot + 1).toLowerCase() : '';
    base = lastDot > 0 ? filename.slice(0, lastDot) : filename;
  }

  // Handle accidental duplicate extension suffix like Husk_3.2.1ipa.ipa
  if (extension && new RegExp(`(\\d)${extension}$`, 'i').test(base)) {
    base = base.slice(0, -extension.length);
  }

  const platform = inferPlatform(extension, filename);

  // 2. Strip trailing release-group / bfi suffix e.g. -user_hidden.bfi2, -iOSGods.bfi3, -user_hidden
  const bfiMatch = base.match(/-([a-zA-Z0-9_]+)\.(bfi\d*)$/i);
  if (bfiMatch) {
    releaseGroup = bfiMatch[1];
    tags.add(bfiMatch[2].toLowerCase());
    base = base.slice(0, bfiMatch.index);
  } else {
    const uhMatch = base.match(/-user_hidden$/i);
    if (uhMatch) {
      releaseGroup = 'user_hidden';
      base = base.slice(0, uhMatch.index);
    }
  }

  // 3. Extract bracketed release groups e.g. [TNT], [MacKed], [HCiSO]
  base = base.replace(/\[([^\]]+)\]/g, (_, content) => {
    const label = normalizeTagLabel(content);
    if (label) {
      tags.add(label);
      if (!releaseGroup) releaseGroup = label;
    }
    return '';
  });
  base = base.replace(/[\s._-]+$/, '');

  // 4. Pattern A: Standard user_hidden parenthesized metadata block: _(v9.2.2_Univ_PI_FW_LP_64bit_os161_ok27)
  const uhParenRegex = /[_\s]*\((v\d[^)]*)\)\s*$/i;
  const uhParenMatch = base.match(uhParenRegex);
  if (uhParenMatch) {
    const inside = uhParenMatch[1];
    base = base.slice(0, uhParenMatch.index);
    const tokens = inside.split(/[_\s]+/).filter(Boolean);
    if (tokens.length > 0) {
      version = tokens[0].replace(/^v/i, '');
      for (const tok of tokens.slice(1)) {
        const iosVal = parseOsToken(tok);
        if (iosVal !== null) {
          minIos = iosVal;
        } else if (/^ok\d+$/i.test(tok)) {
          tags.add(tok.toLowerCase());
        } else if (/^(unk|unknown)$/i.test(tok)) {
          // skip noise
        } else {
          tags.add(normalizeTagLabel(tok));
        }
      }
    }

    // Check for preceding edition parens e.g. (vip), (pro), (subscribed), (Creator_Ed)
    while (true) {
      const edMatch = base.match(/[_\s]*\(([^()]{1,40})\)\s*$/);
      if (!edMatch) break;
      const edText = edMatch[1].trim();
      // Keep year or genuine disambiguator if purely 4 digits? Usually edition tags are words.
      if (/^\d{4}$/.test(edText)) break;
      tags.add(normalizeTagLabel(edText));
      base = base.slice(0, edMatch.index);
    }
  } else {
    // 5. Pattern B & C: General IPA / DMG / PKG / EXE naming
    // Strip trailing known flags like -unsigned, -ios-unsigned, -ios17+, -MacOS-U2B, .MacOS, -2026-11-22
    let changed = true;
    while (changed) {
      changed = false;

      // Trailing date like -2026-11-22
      const dateM = base.match(/[-_.](20\d{2}-\d{2}-\d{2})$/);
      if (dateM) {
        base = base.slice(0, dateM.index);
        changed = true;
        continue;
      }

      // Trailing -unsigned / _unsigned
      const unsM = base.match(/[-_. ]unsigned$/i);
      if (unsM) {
        tags.add('Unsigned');
        base = base.slice(0, unsM.index);
        changed = true;
        continue;
      }

      // Trailing -ios17+ / -ios26+
      const iosPlusM = base.match(/[-_. ](ios\d+(?:\.\d+)?\+?)$/i);
      if (iosPlusM) {
        const v = parseOsToken(iosPlusM[1]);
        if (v !== null) minIos = v;
        base = base.slice(0, iosPlusM.index);
        changed = true;
        continue;
      }

      // Trailing -ios / .ios
      const iosM = base.match(/[-_. ]ios$/i);
      if (iosM) {
        base = base.slice(0, iosM.index);
        changed = true;
        continue;
      }

      // Trailing MacOS-U2B / MacOS
      const macGroupM = base.match(/[._ -]MacOS[-_. ]([A-Za-z0-9]+)$/i);
      if (macGroupM) {
        const grp = normalizeTagLabel(macGroupM[1]);
        tags.add(grp);
        if (!releaseGroup) releaseGroup = grp;
        base = base.slice(0, macGroupM.index);
        changed = true;
        continue;
      }

      const macOnlyM = base.match(/[._ -]MacOS$/i);
      if (macOnlyM) {
        base = base.slice(0, macOnlyM.index);
        changed = true;
        continue;
      }

      // Trailing Incl.DLC / Incl_DLC
      const dlcM = base.match(/[._ -]Incl[._ -]DLC$/i);
      if (dlcM) {
        tags.add('Incl. DLC');
        base = base.slice(0, dlcM.index);
        changed = true;
        continue;
      }

      // Trailing TrollStore marker
      const tsM = base.match(/[._ -]TrollStore$/i);
      if (tsM) {
        tags.add('TrollStore');
        base = base.slice(0, tsM.index);
        changed = true;
        continue;
      }

      // Clean leftover trailing separators e.g. Peggle_Enhanced_HD_1.1.1_-unsigned -> Peggle_Enhanced_HD_1.1.1_
      const trailSep = base.match(/[-_. ]+$/);
      if (trailSep) {
        base = base.slice(0, trailSep.index);
        changed = true;
        continue;
      }
    }

    // Extract version from the end of `base`
    // Case 1: explicit v-prefixed version e.g. .v2.16, -v5.4.5, -v1.0.0-beta.2, _v2026.11.21, -v2, .v1097911
    const vPrefixed = base.match(
      /[-_. ]v(\d+(?:\.\d+)*(?:[ab]\d*|[-.](?:alpha|beta|rc|pre|dev|build)[.-]?\d*|-\d{1,8})*)$/i
    );
    // Case 2: numeric dotted version at end e.g. _0.8.1, -0.2.27, _3.25, _0.20.1a, _0.1.3-20261031
    const numDotted = !vPrefixed
      ? base.match(/[-_. ](\d+(?:\.\d+)+(?:[a-z]\d*|[-.](?:beta|alpha|rc|b|a|pre)\d*|-\d{1,8})?)$/i)
      : null;
    // Case 3: underscore-separated semantic version e.g. Cubase_Pro_16_0_5
    const numUnderscore = !vPrefixed && !numDotted ? base.match(/_(\d{1,3})_(\d{1,3})_(\d{1,3})$/) : null;
    // Case 4: Build number e.g. -Build11, _build2
    const buildM = !vPrefixed && !numDotted && !numUnderscore ? base.match(/[-_. ]build[-_. ]?(\d+)$/i) : null;
    // Case 5: enUS_<number> e.g. 868_Back_enUS_263
    const enUsNum = !vPrefixed && !numDotted && !numUnderscore && !buildM ? base.match(/_enUS_(\d+)$/i) : null;
    // Case 6: short build tag _b1 / -b2 or 7-8 char git commit hash e.g. TermX-e543723
    const shortBuildM =
      !vPrefixed && !numDotted && !numUnderscore && !buildM && !enUsNum
        ? base.match(/[-_]b(\d{1,4})$/i)
        : null;
    const gitHashM =
      !vPrefixed && !numDotted && !numUnderscore && !buildM && !enUsNum && !shortBuildM
        ? base.match(/[-_]((?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,8})$/i)
        : null;

    if (vPrefixed) {
      version = vPrefixed[1];
      base = base.slice(0, vPrefixed.index);
    } else if (numDotted) {
      version = numDotted[1];
      base = base.slice(0, numDotted.index);
    } else if (numUnderscore) {
      version = `${numUnderscore[1]}.${numUnderscore[2]}.${numUnderscore[3]}`;
      base = base.slice(0, numUnderscore.index);
    } else if (buildM) {
      version = `Build ${buildM[1]}`;
      base = base.slice(0, buildM.index);
    } else if (enUsNum) {
      version = enUsNum[1];
      base = base.slice(0, enUsNum.index);
    } else if (shortBuildM) {
      version = `Build ${shortBuildM[1]}`;
      base = base.slice(0, shortBuildM.index);
    } else if (gitHashM) {
      version = gitHashM[1].toLowerCase();
      base = base.slice(0, gitHashM.index);
    } else {
      // Fallback: inline version followed by suffix tags e.g. Stremio_2.1.2-27_tvOS, Tetherless-1.2.5-Modern, Logos.Bible.Software.v7.4.0.51.Incl.Libros
      const inlineVer = base.match(
        /[-_. ]v?(\d+\.\d+(?:\.\d+)*(?:[ab]\d+|[-.](?:beta|alpha|rc|pre)[.-]?\d*|-\d{1,5})?)(?=[-_. ][a-zA-Z])/i
      );
      if (inlineVer && inlineVer.index > 0) {
        version = inlineVer[1];
        let suffix = base.slice(inlineVer.index + inlineVer[0].length).replace(/^[-_. ]+/, '');
        base = base.slice(0, inlineVer.index);
        if (/\bIncl[._ -]DLC\b/i.test(suffix)) {
          tags.add('Incl. DLC');
          suffix = suffix.replace(/\bIncl[._ -]DLC\b/gi, '');
        }
        for (const tok of suffix.split(/[-_. ]+/).filter(Boolean)) {
          if (/^(release|ios|full|incl)$/i.test(tok)) {
            if (/^full$/i.test(tok)) tags.add('Full');
          } else if (tok.length <= 24 && !/^\d{4}\.\d{2}\.\d{2}$/.test(tok)) {
            tags.add(normalizeTagLabel(tok));
          }
        }
      }
    }

    // Strip trailing language / platform markers left after version extraction e.g. _enUS, -ios
    base = base.replace(/[-_. ](?:enUS|ios)$/i, '');

    // If dots were used as word separators (e.g. "The.Battle.of.Polytopia"), convert dots to spaces
    if (!base.includes('_') && !base.includes(' ') && (base.match(/\./g) || []).length >= 2) {
      base = base.replace(/\./g, ' ');
    }
  }

  // Also detect inline mod/edition keywords in app name for filter badges (without mutating app_name)
  const appName = cleanDisplayName(base) || filename;
  if (/\bpro\b/i.test(appName)) tags.add('Pro');
  if (/\bpremium\b/i.test(appName)) tags.add('Premium');
  if (/\bvip\b/i.test(appName)) tags.add('VIP');
  if (/\bipad\b/i.test(appName)) tags.add('iPad');

  // If extension is tipa, add TrollStore tag
  if (extension === 'tipa') tags.add('TrollStore');

  const appSlug = slugifyAppName(appName);
  const tagList = Array.from(tags);

  return {
    raw_filename: filename,
    app_name: appName,
    app_slug: appSlug,
    version: version || '',
    platform,
    extension,
    tags: tagList,
    min_ios: minIos,
    min_ios_label: minIos !== null ? `iOS ${minIos.toFixed(1)}` : null,
    release_group: releaseGroup,
  };
}

function tokenizeVersion(v) {
  if (!v) return [];
  const cleaned = String(v).trim().replace(/^v/i, '');
  // Split primary version before pre-release/tweak hyphen if numeric
  return cleaned
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? { num: Number.parseInt(part, 10), isNum: true } : { str: part.toLowerCase(), isNum: false }));
}

const PRERELEASE_RE = /^(?:alpha|beta|rc|pre|dev|a|b)$/i;

function compareVersions(a, b) {
  const ta = tokenizeVersion(a);
  const tb = tokenizeVersion(b);
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i += 1) {
    const pa = ta[i];
    const pb = tb[i];
    if (!pa && pb) {
      if (!pb.isNum && PRERELEASE_RE.test(pb.str)) return 1; // 1.0.0 > 1.0.0-beta
      if (pb.isNum && pb.num === 0) continue; // 1.0 == 1.0.0
      return -1;
    }
    if (pa && !pb) {
      if (!pa.isNum && PRERELEASE_RE.test(pa.str)) return -1; // 1.0.0-beta < 1.0.0
      if (pa.isNum && pa.num === 0) continue;
      return 1;
    }
    if (pa.isNum && pb.isNum) {
      if (pa.num !== pb.num) return pa.num > pb.num ? 1 : -1;
    } else if (pa.isNum !== pb.isNum) {
      // Numeric segment ranks higher than pre-release suffix
      return pa.isNum ? 1 : -1;
    } else if (pa.str !== pb.str) {
      return pa.str > pb.str ? 1 : -1;
    }
  }
  return 0;
}

function parsePageMeta(html) {
  const str = String(html || '');
  const filesPagingBlock = str.match(/setPagination\s*\(\s*['"]\.files_paging['"]\s*,\s*\{([\s\S]*?)\}\s*\)/);
  const foldersPagingBlock = str.match(/setPagination\s*\(\s*['"]\.folders_paging['"]\s*,\s*\{([\s\S]*?)\}\s*\)/);

  const extractField = (block, field) => {
    if (!block) return '';
    const m = block.match(new RegExp(`${field}\\s*:\\s*['"]([^'"]*)['"]`));
    return m ? m[1] : '';
  };

  const token =
    extractField(filesPagingBlock?.[1], 'token') ||
    str.match(/token:\s*'([a-f0-9]+)'/i)?.[1] ||
    '';

  const totalFiles = Number.parseInt(extractField(filesPagingBlock?.[1], 'total'), 10) || 0;
  const totalFolders = Number.parseInt(extractField(foldersPagingBlock?.[1], 'total'), 10) || 0;
  const perPage = Number.parseInt(extractField(filesPagingBlock?.[1], 'perpage'), 10) || 20;
  const usrLogin = extractField(filesPagingBlock?.[1], 'usr_login') || '';

  return { token, totalFiles, totalFolders, perPage, usrLogin };
}

function buildDownloadUrl(fileCode, rawFilename) {
  // Encode characters that break URLs while keeping readable punctuation
  const safeName = encodeURIComponent(rawFilename)
    .replace(/%28/g, '(')
    .replace(/%29/g, ')')
    .replace(/%2B/g, '+')
    .replace(/%2C/g, ',')
    .replace(/%5B/g, '[')
    .replace(/%5D/g, ']');
  return `https://dailyuploads.net/${fileCode}/${safeName}`;
}

function parseFileCards(html, sourceUser = 'user_hidden') {
  const str = String(html || '');
  const parts = str.split('<div class="col border border-1 p-2 py-4 bg-light rounded">');
  if (parts.length <= 1) return [];

  const items = [];
  for (let i = 1; i < parts.length; i += 1) {
    const chunk = parts[i];
    const hrefMatch = chunk.match(/href="(https?:\/\/dailyuploads\.net\/([a-zA-Z0-9]+)\/([^"]+))"/i);
    if (!hrefMatch) continue;

    const fileCode = hrefMatch[2];
    const rawFilename = decodePercentEncoded(decodeHtmlEntities(hrefMatch[3]));
    const downloadUrl = buildDownloadUrl(fileCode, rawFilename);

    const spanMatches = [...chunk.matchAll(/<span>([\s\S]*?)<\/span>/gi)];
    const spans = spanMatches.map((m) => m[1].replace(/<svg[\s\S]*?<\/svg>/gi, '').trim());

    const sizeText = spans[0] || '';
    const sizeBytes = parseSizeToBytes(sizeText);

    const ageSpan = spans[1] || '';
    const ageMatch =
      ageSpan.match(/<!--\s*Uploaded\s+(\d+)\s*-->/i) || ageSpan.match(/(\d+)\s*days?\s*ago/i);
    const uploadedDaysAgo = ageMatch ? Number.parseInt(ageMatch[1], 10) : null;

    const dlSpan = spans[2] || '';
    const dlMatch = dlSpan.match(/<!--\s*(\d+)\s*-->/) || dlSpan.match(/(\d+)\s*Downloads?/i);
    const downloads = dlMatch ? Number.parseInt(dlMatch[1], 10) : 0;

    const meta = parseFilename(rawFilename);

    items.push({
      file_code: fileCode,
      source_user: sourceUser,
      download_url: downloadUrl,
      size_text: sizeText,
      size_bytes: sizeBytes,
      uploaded_days_ago: uploadedDaysAgo,
      downloads,
      ...meta,
    });
  }

  return items;
}

module.exports = {
  decodeHtmlEntities,
  decodePercentEncoded,
  parseSizeToBytes,
  formatBytes,
  parseOsToken,
  parseFilename,
  compareVersions,
  slugifyAppName,
  parsePageMeta,
  parseFileCards,
  buildDownloadUrl,
};
