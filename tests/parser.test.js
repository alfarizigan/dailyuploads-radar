'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeHtmlEntities,
  parseSizeToBytes,
  formatBytes,
  parseOsToken,
  parseFilename,
  compareVersions,
  parsePageMeta,
  parseFileCards,
} = require('../src/parser');

test('decodeHtmlEntities decodes named, decimal, and hex entities', () => {
  assert.equal(decodeHtmlEntities('Spotify_&#40;v9.2.2&#41;&amp;test&#x2B;'), 'Spotify_(v9.2.2)&test+');
  assert.equal(decodeHtmlEntities(''), '');
  assert.equal(decodeHtmlEntities(null), '');
});

test('parseSizeToBytes and formatBytes handle B, KB, MB, GB accurately', () => {
  assert.equal(parseSizeToBytes('173.9 MB'), Math.round(173.9 * 1024 * 1024));
  assert.equal(parseSizeToBytes('1.3 GB'), Math.round(1.3 * 1024 ** 3));
  assert.equal(parseSizeToBytes('420 KB'), 420 * 1024);
  assert.equal(parseSizeToBytes('invalid'), 0);
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1024 * 1024 * 10), '10.0 MB');
});

test('parseOsToken parses osNNN, 2-digit osNN, and iosNN+ tokens', () => {
  assert.equal(parseOsToken('os150'), 15.0);
  assert.equal(parseOsToken('os161'), 16.1);
  assert.equal(parseOsToken('os144'), 14.4);
  assert.equal(parseOsToken('os90'), 9.0);
  assert.equal(parseOsToken('os80'), 8.0);
  assert.equal(parseOsToken('os13'), 13.0);
  assert.equal(parseOsToken('os15'), 15.0);
  assert.equal(parseOsToken('os17'), 17.0);
  assert.equal(parseOsToken('os18'), 18.0);
  assert.equal(parseOsToken('os1510'), 15.1);
  assert.equal(parseOsToken('os1500'), 15.0);
  assert.equal(parseOsToken('ios17+'), 17.0);
  assert.equal(parseOsToken('ios26+'), 26.0);
  assert.equal(parseOsToken('64bit'), null);
});

test('parseFilename handles user_hidden IPA naming with edition tags and iOS metadata', () => {
  const r1 = parseFilename('Spotify-Shrubify_(v9.2.2-4.2.5b6_Univ_PI_FW_LP_64bit_os161_ok27)-user_hidden.bfi2.ipa');
  assert.equal(r1.app_name, 'Spotify-Shrubify');
  assert.equal(r1.app_slug, 'spotify-shrubify');
  assert.equal(r1.version, '9.2.2-4.2.5b6');
  assert.equal(r1.platform, 'iOS');
  assert.equal(r1.extension, 'ipa');
  assert.equal(r1.min_ios, 16.1);
  assert.equal(r1.min_ios_label, 'iOS 16.1');
  assert.equal(r1.release_group, 'user_hidden');
  assert.ok(r1.tags.includes('Universal'));
  assert.ok(r1.tags.includes('64bit'));
  assert.ok(r1.tags.includes('PI'));

  const r2 = parseFilename('ProCCD_Digital_Film_Camera_(vip)_(v7.2.1_Univ_PI_FW_LP_64bit_os150_ok27)-user_hidden.bfi2.ipa');
  assert.equal(r2.app_name, 'ProCCD Digital Film Camera');
  assert.equal(r2.version, '7.2.1');
  assert.ok(r2.tags.includes('VIP'));
  assert.equal(r2.min_ios, 15.0);

  const r3 = parseFilename('LumaFusion_(Creator_Ed)_(v5.6.2_PI_FW_64bit_os270_ok27)-user_hidden.bfi3.ipa');
  const r4 = parseFilename('LumaFusion_(v5.6.2_PI_FW_64bit_os270_ok27)-user_hidden.bfi3.ipa');
  assert.equal(r3.app_slug, r4.app_slug);
  assert.ok(r3.tags.includes('Creator Ed'));
});

test('parseFilename handles macOS DMG/PKG and community unsigned IPAs', () => {
  const dmg1 = parseFilename('Things_3_3.25_[TNT].dmg');
  assert.equal(dmg1.app_name, 'Things 3');
  assert.equal(dmg1.app_slug, 'things-3');
  assert.equal(dmg1.version, '3.25');
  assert.equal(dmg1.platform, 'macOS');
  assert.ok(dmg1.tags.includes('TNT'));

  const dmg2 = parseFilename('Thronefall.v2.16.Incl.DLC.MacOS-U2B.dmg');
  assert.equal(dmg2.app_name, 'Thronefall');
  assert.equal(dmg2.version, '2.16');
  assert.equal(dmg2.platform, 'macOS');
  assert.ok(dmg2.tags.includes('Incl. DLC'));
  assert.ok(dmg2.tags.includes('U2B'));

  const ipa1 = parseFilename('AniBee-0.2.27-unsigned.ipa');
  assert.equal(ipa1.app_name, 'AniBee');
  assert.equal(ipa1.version, '0.2.27');
  assert.ok(ipa1.tags.includes('Unsigned'));

  const ipa2 = parseFilename('Wrath-0.1.3-ios17+.ipa');
  assert.equal(ipa2.app_name, 'Wrath');
  assert.equal(ipa2.version, '0.1.3');
  assert.equal(ipa2.min_ios, 17.0);

  const ipa3 = parseFilename('AIOStreams_0.8.1.ipa');
  const ipa4 = parseFilename('AIOStreams_0.7.18.ipa');
  assert.equal(ipa3.app_slug, ipa4.app_slug);
  assert.equal(ipa3.version, '0.8.1');
  assert.equal(ipa4.version, '0.7.18');

  const ipa5 = parseFilename('AudioYam-Build11.ipa');
  assert.equal(ipa5.app_name, 'AudioYam');
  assert.equal(ipa5.version, 'Build 11');

  const ipa6 = parseFilename('Stremio_2.1.2-27_tvOS.ipa');
  assert.equal(ipa6.app_name, 'Stremio');
  assert.equal(ipa6.version, '2.1.2-27');
  assert.ok(ipa6.tags.includes('tvOS'));

  const ipa7 = parseFilename('Tetherless-1.2.5-Modern.ipa');
  const ipa8 = parseFilename('Tetherless-1.2.5-Legacy.ipa');
  assert.equal(ipa7.app_slug, ipa8.app_slug);
  assert.equal(ipa7.version, '1.2.5');
  assert.ok(ipa7.tags.includes('Modern'));
  assert.ok(ipa8.tags.includes('Legacy'));

  const ipa9 = parseFilename('NuvioStreamingMobile-1.1.0-beta.3-enhanced-release.ipa');
  assert.equal(ipa9.app_name, 'NuvioStreamingMobile');
  assert.equal(ipa9.version, '1.1.0-beta.3');

  // Non-user_hidden .bfi release groups (e.g. -iOSGods.bfi3)
  const iosGods = parseFilename('Warhammer_40000_Boltgun_Boom_(modded)_(v1.4.0_FW_64bit_os160_ok27)-iOSGods.bfi3.ipa');
  assert.equal(iosGods.app_name, 'Warhammer 40000 Boltgun Boom');
  assert.equal(iosGods.version, '1.4.0');
  assert.equal(iosGods.min_ios, 16.0);
  assert.equal(iosGods.release_group, 'iOSGods');
  assert.ok(iosGods.tags.includes('Modded'));
  assert.ok(iosGods.tags.includes('bfi3'));

  // Trailing separator before -unsigned, underscore semver, single-letter pre-release, TrollStore inline
  const peggle = parseFilename('Peggle_Enhanced_HD_1.1.1_-unsigned.ipa');
  assert.equal(peggle.app_name, 'Peggle Enhanced HD');
  assert.equal(peggle.version, '1.1.1');
  assert.ok(peggle.tags.includes('Unsigned'));

  const reynard = parseFilename('Reynard-Browser_0.20.1a.ipa');
  assert.equal(reynard.app_name, 'Reynard-Browser');
  assert.equal(reynard.version, '0.20.1a');

  const cubase = parseFilename('Cubase_Pro_16_0_5_macOS.rar');
  assert.equal(cubase.app_name, 'Cubase Pro');
  assert.equal(cubase.version, '16.0.5');
  assert.equal(cubase.platform, 'macOS');

  const zgta = parseFilename('ZGTA-V-2.0.0b4-Build109-VoiceDistance-TrollStore.ipa');
  assert.equal(zgta.app_name, 'ZGTA-V');
  assert.equal(zgta.version, '2.0.0b4');
  assert.ok(zgta.tags.includes('TrollStore'));

  // Split multi-part archives, 2-digit os15, duplicate extension typos, short build & git commit hashes
  const logos = parseFilename('Logos.Bible.Software.v7.4.0.51.Incl.Libros.zip.004');
  assert.equal(logos.app_name, 'Logos Bible Software');
  assert.equal(logos.app_slug, 'logos-bible-software');
  assert.equal(logos.version, '7.4.0.51');
  assert.equal(logos.extension, 'zip');
  assert.equal(logos.platform, 'Archive');
  assert.ok(logos.tags.includes('Part 004'));

  const neko = parseFilename('Neko_Atsume_Kitty_Collector+_(v1.64.0_64bit_os15_ok27)-user_hidden.bfi3.ipa');
  assert.equal(neko.min_ios, 15.0);
  assert.equal(neko.min_ios_label, 'iOS 15.0');

  const husk = parseFilename('Husk_3.2.1ipa.ipa');
  assert.equal(husk.app_name, 'Husk');
  assert.equal(husk.version, '3.2.1');

  const termx1 = parseFilename('TermX.ipa');
  const termx2 = parseFilename('TermX-e543723.ipa');
  assert.equal(termx1.app_slug, termx2.app_slug);
  assert.equal(termx2.version, 'e543723');

  const audioB1 = parseFilename('AudioYam_b1.ipa');
  assert.equal(audioB1.app_name, 'AudioYam');
  assert.equal(audioB1.version, 'Build 1');

  // Dotted semver + underscore build suffix (_5.0.1_b4), hyphenated vPrefixed build (-v2.1.8-b118), letter patch (.v1.2.98d), glued Univ tag (v1.9.2Univ), and [MacKed] zip platform
  const filza = parseFilename('Filza_5.0.1_b4.ipa');
  assert.equal(filza.app_name, 'Filza');
  assert.equal(filza.app_slug, 'filza');
  assert.equal(filza.version, '5.0.1-b4');

  const zeus = parseFilename('Zeus-v2.1.8-b118.ipa');
  assert.equal(zeus.app_name, 'Zeus');
  assert.equal(zeus.version, '2.1.8-b118');

  const scritchy = parseFilename('Scritchy.Scratchy.v1.2.98d.MacOS-U2B.dmg');
  assert.equal(scritchy.app_name, 'Scritchy Scratchy');
  assert.equal(scritchy.version, '1.2.98d');

  const glued = parseFilename('Demong_Hunter_1_Action_RPG_(v1.9.2Univ_FW_LP_64bit_os150_ok27)-user_hidden.bfi2.ipa');
  assert.equal(glued.app_name, 'Demong Hunter 1 Action RPG');
  assert.equal(glued.version, '1.9.2');
  assert.ok(glued.tags.includes('Universal'));

  const mackedZip = parseFilename('CleanMyMac_5.7.4_[MacKed].zip');
  assert.equal(mackedZip.app_name, 'CleanMyMac');
  assert.equal(mackedZip.version, '5.7.4');
  assert.equal(mackedZip.platform, 'macOS');
});

test('compareVersions accurately orders semantic and build versions', () => {
  assert.equal(compareVersions('0.8.1', '0.7.18'), 1);
  assert.equal(compareVersions('9.10.0', '9.2.2'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('Build 11', 'Build 2'), 1);
  assert.equal(compareVersions('5.6.2', '5.6.2'), 0);
  assert.equal(compareVersions('3.2.0', '3.2.1'), -1);
});

test('parsePageMeta and parseFileCards parse real DailyUploads HTML structure', () => {
  const html = `
    <div class="grid-container gap-2 text-center">
      <div class="col border border-1 p-2 py-4 bg-light rounded">
        <a href="https://dailyuploads.net/0s659yfiu2wp/Spotify-Shrubify_&#40;v9.2.2_Univ_64bit_os161&#41;-user_hidden.bfi2.ipa"><img src="x"></a>
        <div class="d-flex">
          <span><svg></svg> 173.9 MB</span>
          <span><svg></svg><!-- Uploaded 0--> days ago</span>
          <span><svg></svg><!--12--> Downloads</span>
        </div>
      </div>
      <div class="col border border-1 p-2 py-4 bg-light rounded">
        <a href="https://dailyuploads.net/abc123def456/Things_3_3.25_[TNT].dmg"><img src="x"></a>
        <div class="d-flex">
          <span><svg></svg> 24.5 MB</span>
          <span><svg></svg><!-- Uploaded 5--> days ago</span>
          <span><svg></svg><!--7--> Downloads</span>
        </div>
      </div>
    </div>
    <script>
      setPagination('.files_paging', {
        op: 'user_public',
        usr_login: 'user_hidden',
        total: '2171',
        perpage: '20',
        token: 'abcdef1234567890'
      });
    </script>
  `;

  const meta = parsePageMeta(html);
  assert.equal(meta.token, 'abcdef1234567890');
  assert.equal(meta.totalFiles, 2171);
  assert.equal(meta.usrLogin, 'user_hidden');

  const cards = parseFileCards(html, 'user_hidden');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].file_code, '0s659yfiu2wp');
  assert.equal(cards[0].app_name, 'Spotify-Shrubify');
  assert.equal(cards[0].uploaded_days_ago, 0);
  assert.equal(cards[0].downloads, 12);
  assert.equal(cards[1].file_code, 'abc123def456');
  assert.equal(cards[1].platform, 'macOS');
  assert.equal(cards[1].downloads, 7);

  // Double percent-encoded ampersand (%2526) from DailyUploads hrefs
  const encodedHtml = `
    <div class="col border border-1 p-2 py-4 bg-light rounded">
      <a href="https://dailyuploads.net/nlvzy71bsc0x/Weather_%2526_Radar_Premium_(v2026.22.2_PI_64bit_os184_ok27)-user_hidden.bfi3.ipa"><img src="x"></a>
      <span>50.0 MB</span><span><!-- Uploaded 1--> days ago</span><span><!--4--> Downloads</span>
    </div>
  `;
  const encodedCards = parseFileCards(encodedHtml, 'user_hidden');
  assert.equal(encodedCards.length, 1);
  assert.equal(encodedCards[0].app_name, 'Weather & Radar Premium');
  assert.equal(encodedCards[0].app_slug, 'weather-and-radar-premium');
  assert.ok(!encodedCards[0].download_url.includes('%252526'));
  assert.ok(encodedCards[0].download_url.includes('Weather_%26_Radar_Premium'));
});
