/**
 * ============================================================
 * ROLIASCAN - SERIES EXTENSION
 * ============================================================
 * Adds series-level capabilities to SourceRoliaScan.
 * Load AFTER source-roliascan.js.
 *
 * Series URL: https://roliascan.com/manga/<slug>/
 *
 * Strategy:
 *   - Series metadata comes from WP REST:
 *       /wp-json/wp/v2/manga?slug=<slug>&_embed=1
 *   - Full chapter list is reconstructed by paginating WP chapters
 *     filtered by `search=<slug>` and keeping links that start with
 *     /read/<slug>/  (WP doesn't expose a parent filter we can use).
 * ============================================================
 */
(function (global) {
  'use strict';
  if (!global.SourceRoliaScan) {
    console.error('[RoliaScan:Series] base plugin not found — load source-roliascan.js first');
    return;
  }
  const base = global.SourceRoliaScan;
  const ORIGIN = 'https://roliascan.com';

  const SERIES_PATTERN = /^https?:\/\/(www\.)?roliascan\.com\/manga\/[^/?#]+\/?(?:[?#].*)?$/i;

  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('roliascan.com') && SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/manga\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  async function fetchJson(url) {
    const text = await global.SourceConfig.fetchPage(url, {
      validator: (t) => t && (t.trim().startsWith('[') || t.trim().startsWith('{') || /Markdown Content:|contents/.test(t))
    });
    const normalized = extractJsonText(text);
    try { return JSON.parse(normalized); } catch {}
    try { return JSON.parse(escapeJsonStringBreaks(normalized)); } catch {}
    try {
      const wrapped = JSON.parse(normalized);
      if (wrapped && typeof wrapped.contents === 'string') return JSON.parse(wrapped.contents);
    } catch {}
    throw new Error('RoliaScan WP REST returned non-JSON');
  }

  function extractJsonText(text) {
    let t = String(text || '').trim();
    const marker = 'Markdown Content:';
    const markerIndex = t.indexOf(marker);
    if (markerIndex !== -1) t = t.slice(markerIndex + marker.length).trim();
    const starts = [t.indexOf('['), t.indexOf('{')].filter(i => i >= 0);
    if (starts.length) t = t.slice(Math.min(...starts)).trim();
    return t;
  }

  function escapeJsonStringBreaks(input) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of String(input || '')) {
      if (escaped) { out += ch; escaped = false; continue; }
      if (ch === '\\') { out += ch; escaped = true; continue; }
      if (ch === '"') { inString = !inString; out += ch; continue; }
      if (inString && ch === '\n') { out += '\\n'; continue; }
      if (inString && ch === '\r') { continue; }
      out += ch;
    }
    return out;
  }

  function stripHtml(s) {
    if (!s) return '';
    const div = document.createElement('div');
    div.innerHTML = s;
    return (div.textContent || '').trim();
  }

  base.getSeriesInfo = async function (url) {
    const slug = base.getSeriesSlug(url);
    const lookup = await fetchJson(
      `${ORIGIN}/wp-json/wp/v2/manga?slug=${encodeURIComponent(slug)}&_embed=1`
    );
    const post = Array.isArray(lookup) ? lookup[0] : null;
    if (!post) throw new Error(`Series not found on RoliaScan: ${slug}`);

    const title = stripHtml(post.title?.rendered) || prettifySlug(slug);
    const description = stripHtml(post.content?.rendered) || stripHtml(post.excerpt?.rendered) || '';

    // Cover: featured media via _embedded, else fallback meta scrape from /manga/<slug>/
    let cover = '';
    const fm = post._embedded?.['wp:featuredmedia']?.[0];
    if (fm) {
      cover = fm.source_url ||
              fm.media_details?.sizes?.full?.source_url ||
              fm.media_details?.sizes?.medium_large?.source_url || '';
    }
    if (!cover) {
      try {
        const html = await global.SourceConfig.fetchPage(url, {
          validator: (h) => /og:image|manga-/i.test(h)
        });
        const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        if (og) cover = og[1];
      } catch {}
    }

    // Genres + author from _embedded terms
    const genres = [];
    const authors = [];
    const termGroups = post._embedded?.['wp:term'] || [];
    for (const group of termGroups) {
      for (const term of (group || [])) {
        if (!term?.taxonomy || !term?.name) continue;
        if (term.taxonomy === 'post_tag') genres.push(term.name);
        else if (term.taxonomy === 'manga_author') authors.push(term.name);
      }
    }

    return {
      title,
      cover,
      description,
      author: authors.join(', '),
      artist: '',
      status: 'ongoing',
      genres,
      alternativeTitles: [],
      slug,
      sourceUrl: url,
      _mangaId: post.id
    };
  };

  base.getChapterList = async function (url) {
    const slug = base.getSeriesSlug(url);
    const info = await base.getSeriesInfo(url);
    const mangaId = info?._mangaId;
    if (!mangaId) throw new Error(`Could not resolve RoliaScan manga id for: ${slug}`);

    // FIX: The RoliaScan WP REST endpoint caps each response at ~500 chapters.
    // Long-running series (One Piece, Naruto, Bleach, ...) have 1000+ chapters,
    // so we MUST paginate by `offset` until the API returns fewer than the
    // requested page size. Without this loop we silently dropped every chapter
    // outside the most-recent 500 (e.g. One Piece returned 690..1184 only).
    const PAGE_SIZE = 500;
    const MAX_PAGES = 20; // hard safety cap: 10 000 chapters
    const seen = new Map(); // dedupe by chapter number (handles any overlap)
    let offset = 0;

    for (let page = 0; page < MAX_PAGES; page++) {
      const data = await fetchJson(
        `${ORIGIN}/auth/manga-chapters?${buildChapterParams(mangaId, offset, PAGE_SIZE)}`
      );
      const batch = Array.isArray(data?.chapters) ? data.chapters : [];
      if (batch.length === 0) break;

      for (const chapter of batch) {
        const number = parseFloat(chapter.chapter);
        if (!Number.isFinite(number)) continue;
        const chapUrl = String(chapter.url || '').replace(/\\\//g, '/');
        if (!chapUrl) continue;
        if (!seen.has(number)) {
          seen.set(number, {
            number,
            title: chapter.title && chapter.title !== 'N/A' ? chapter.title : `Chapter ${number}`,
            url: chapUrl
          });
        }
      }

      // Last page reached when the API returns fewer rows than requested.
      if (batch.length < PAGE_SIZE) break;
      offset += PAGE_SIZE;
    }

    // Sort ASC so the importer always starts from Chapter 1 in reading order.
    const list = Array.from(seen.values()).sort((a, b) => a.number - b.number);
    if (list.length === 0) throw new Error('No chapters found for RoliaScan series');
    return list;
  };

  function buildChapterParams(mangaId, offset = 0, limit = 500) {
    const timestamp = Math.floor(Date.now() / 1000);
    const hour = new Date().toISOString().slice(0, 13).replace(/[-T:]/g, '');
    const token = md5(`${timestamp}mng_ch_${hour}`).substring(0, 16);
    return new URLSearchParams({
      manga_id: String(mangaId),
      offset: String(offset),
      limit: String(limit),
      // ASC keeps natural pagination order (1..500, 501..1000, ...).
      order: 'ASC',
      _t: token,
      _ts: String(timestamp)
    }).toString();
  }

  base.checkUpdates = async function (seriesDoc) {
    const list = await base.getChapterList(seriesDoc.sourceUrl);
    const last = Number(seriesDoc.lastImportedChapter || 0);
    return list.filter(c => c.number > last);
  };

  function md5(string) {
    function rotateLeft(value, shift) { return (value << shift) | (value >>> (32 - shift)); }
    function addUnsigned(x, y) {
      const lsw = (x & 0xffff) + (y & 0xffff);
      const msw = (x >> 16) + (y >> 16) + (lsw >> 16);
      return (msw << 16) | (lsw & 0xffff);
    }
    function cmn(q, a, b, x, s, t) { return addUnsigned(rotateLeft(addUnsigned(addUnsigned(a, q), addUnsigned(x, t)), s), b); }
    function ff(a, b, c, d, x, s, t) { return cmn((b & c) | ((~b) & d), a, b, x, s, t); }
    function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & (~d)), a, b, x, s, t); }
    function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
    function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | (~d)), a, b, x, s, t); }
    function toWords(str) {
      const words = [];
      for (let n = 0; n < str.length * 8; n += 8) words[n >> 5] |= (str.charCodeAt(n / 8) & 0xff) << (n % 32);
      words[str.length >> 2] |= 0x80 << ((str.length % 4) * 8);
      words[(((str.length + 8) >> 6) + 1) * 16 - 2] = str.length * 8;
      return words;
    }
    function hex(num) {
      let out = '';
      for (let j = 0; j <= 3; j++) out += (`0${((num >> (j * 8)) & 255).toString(16)}`).slice(-2);
      return out;
    }
    const x = toWords(string);
    let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
    for (let k = 0; k < x.length; k += 16) {
      const aa = a, bb = b, cc = c, dd = d;
      a = ff(a, b, c, d, x[k + 0], 7, -680876936); d = ff(d, a, b, c, x[k + 1], 12, -389564586); c = ff(c, d, a, b, x[k + 2], 17, 606105819); b = ff(b, c, d, a, x[k + 3], 22, -1044525330);
      a = ff(a, b, c, d, x[k + 4], 7, -176418897); d = ff(d, a, b, c, x[k + 5], 12, 1200080426); c = ff(c, d, a, b, x[k + 6], 17, -1473231341); b = ff(b, c, d, a, x[k + 7], 22, -45705983);
      a = ff(a, b, c, d, x[k + 8], 7, 1770035416); d = ff(d, a, b, c, x[k + 9], 12, -1958414417); c = ff(c, d, a, b, x[k + 10], 17, -42063); b = ff(b, c, d, a, x[k + 11], 22, -1990404162);
      a = ff(a, b, c, d, x[k + 12], 7, 1804603682); d = ff(d, a, b, c, x[k + 13], 12, -40341101); c = ff(c, d, a, b, x[k + 14], 17, -1502002290); b = ff(b, c, d, a, x[k + 15], 22, 1236535329);
      a = gg(a, b, c, d, x[k + 1], 5, -165796510); d = gg(d, a, b, c, x[k + 6], 9, -1069501632); c = gg(c, d, a, b, x[k + 11], 14, 643717713); b = gg(b, c, d, a, x[k + 0], 20, -373897302);
      a = gg(a, b, c, d, x[k + 5], 5, -701558691); d = gg(d, a, b, c, x[k + 10], 9, 38016083); c = gg(c, d, a, b, x[k + 15], 14, -660478335); b = gg(b, c, d, a, x[k + 4], 20, -405537848);
      a = gg(a, b, c, d, x[k + 9], 5, 568446438); d = gg(d, a, b, c, x[k + 14], 9, -1019803690); c = gg(c, d, a, b, x[k + 3], 14, -187363961); b = gg(b, c, d, a, x[k + 8], 20, 1163531501);
      a = gg(a, b, c, d, x[k + 13], 5, -1444681467); d = gg(d, a, b, c, x[k + 2], 9, -51403784); c = gg(c, d, a, b, x[k + 7], 14, 1735328473); b = gg(b, c, d, a, x[k + 12], 20, -1926607734);
      a = hh(a, b, c, d, x[k + 5], 4, -378558); d = hh(d, a, b, c, x[k + 8], 11, -2022574463); c = hh(c, d, a, b, x[k + 11], 16, 1839030562); b = hh(b, c, d, a, x[k + 14], 23, -35309556);
      a = hh(a, b, c, d, x[k + 1], 4, -1530992060); d = hh(d, a, b, c, x[k + 4], 11, 1272893353); c = hh(c, d, a, b, x[k + 7], 16, -155497632); b = hh(b, c, d, a, x[k + 10], 23, -1094730640);
      a = hh(a, b, c, d, x[k + 13], 4, 681279174); d = hh(d, a, b, c, x[k + 0], 11, -358537222); c = hh(c, d, a, b, x[k + 3], 16, -722521979); b = hh(b, c, d, a, x[k + 6], 23, 76029189);
      a = hh(a, b, c, d, x[k + 9], 4, -640364487); d = hh(d, a, b, c, x[k + 12], 11, -421815835); c = hh(c, d, a, b, x[k + 15], 16, 530742520); b = hh(b, c, d, a, x[k + 2], 23, -995338651);
      a = ii(a, b, c, d, x[k + 0], 6, -198630844); d = ii(d, a, b, c, x[k + 7], 10, 1126891415); c = ii(c, d, a, b, x[k + 14], 15, -1416354905); b = ii(b, c, d, a, x[k + 5], 21, -57434055);
      a = ii(a, b, c, d, x[k + 12], 6, 1700485571); d = ii(d, a, b, c, x[k + 3], 10, -1894986606); c = ii(c, d, a, b, x[k + 10], 15, -1051523); b = ii(b, c, d, a, x[k + 1], 21, -2054922799);
      a = ii(a, b, c, d, x[k + 8], 6, 1873313359); d = ii(d, a, b, c, x[k + 15], 10, -30611744); c = ii(c, d, a, b, x[k + 6], 15, -1560198380); b = ii(b, c, d, a, x[k + 13], 21, 1309151649);
      a = ii(a, b, c, d, x[k + 4], 6, -145523070); d = ii(d, a, b, c, x[k + 11], 10, -1120210379); c = ii(c, d, a, b, x[k + 2], 15, 718787259); b = ii(b, c, d, a, x[k + 9], 21, -343485551);
      a = addUnsigned(a, aa); b = addUnsigned(b, bb); c = addUnsigned(c, cc); d = addUnsigned(d, dd);
    }
    return (hex(a) + hex(b) + hex(c) + hex(d)).toLowerCase();
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function prettifySlug(slug) {
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
  }
})(window);
