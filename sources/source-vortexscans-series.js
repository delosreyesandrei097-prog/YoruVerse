/**
 * ============================================================
 * VORTEX SCANS - SERIES EXTENSION
 * ============================================================
 * Adds series-level capabilities to the existing SourceVortexScans
 * chapter plugin. Load this file AFTER source-vortexscans.js.
 *
 * Series URL pattern: https://vortexscans.org/series/<slug>
 *
 * V13 (2026-06): series fetcher now uses the Vortex-tuned fetchPage()
 * defined in source-vortexscans.js (Googlebot UA, extra proxies,
 * Wayback Machine fallback, stale-HTML cache). On a fully successful
 * extraction we also cache the *parsed* series info + chapter list in
 * localStorage so Auto-Sync can still report a "no new chapters" result
 * during transient provider outages instead of erroring the whole job.
 * ============================================================
 */
(function (global) {
  'use strict';
  if (!global.SourceVortexScans) {
    console.error('[VortexScans:Series] base plugin not found — load source-vortexscans.js first');
    return;
  }
  const base = global.SourceVortexScans;

  const SERIES_PATTERN = /^https?:\/\/(www\.)?vortexscans\.org\/series\/[^/]+\/?(?:[?#].*)?$/i;

  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('vortexscans.org') && SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/series\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  // ---- V13 result cache (parsed info + chapter list) ---------------
  const INFO_KEY  = (slug) => `vortex:series:info:${slug}`;
  const LIST_KEY  = (slug) => `vortex:series:chapters:${slug}`;
  const CACHE_TTL = 14 * 24 * 60 * 60 * 1000; // 14 days
  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || Date.now() - (obj.t || 0) > CACHE_TTL) return null;
      return obj.v;
    } catch { return null; }
  }
  function writeCache(key, v) {
    try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v })); } catch {}
  }

  base.getSeriesInfo = async function (url) {
    const slug = base.getSeriesSlug(url);
    let html;
    try {
      // Use the Vortex-specific fetcher (defined on `base`). It already
      // includes shared-config proxies + Vortex extras + stale cache.
      html = await base.fetchPage(url, {
        validator: (h) => /vortexscans|postTitle|seriesTitle|storage\.vortexscans|og:title/i.test(h)
      });
    } catch (e) {
      // Replay last good parsed metadata, if we have any. This is the
      // "import never dies because the proxies are flapping" path.
      const cached = readCache(INFO_KEY(slug));
      if (cached) {
        console.warn('[VortexScans:Series] live fetch failed — returning cached series info', { url, error: e.message });
        return cached;
      }
      throw e;
    }

    const decoded = base.decodeHtml(html);
    const pick = (key) => base.findPackedString(html, key) || extractJsonString(decoded, key);

    const title = pick('postTitle') || pick('seriesTitle') || pick('title') ||
                  ogContent(decoded, 'og:title') ||
                  prettifySlug(slug);
    const description = stripHtml(
      pick('postContent') || pick('description') || pick('synopsis') ||
      metaContent(decoded, 'description') || ''
    );
    const author = pick('author') || '';
    const artist = pick('artist') || '';
    const status = normalizeStatus(pick('seriesStatus') || pick('status') || '');

    // Cover image: featuredImage key first, then storage URLs, then og:image.
    let cover = pick('featuredImage') || '';
    if (!cover) {
      const coverMatch = decoded.match(/https:\/\/storage\.vortexscans\.org\/upload\/[^"'\s]+?\.(?:webp|jpg|jpeg|png)/i);
      if (coverMatch) cover = coverMatch[0];
    }
    if (!cover) cover = ogContent(decoded, 'og:image');

    const banner = pick('banner') || pick('bannerHero') || '';

    let genres = extractPackedNames(decoded, 'genres');
    if (!genres.length) genres = extractStringArray(decoded, 'genres');

    let alt = [];
    const altPacked = pick('alternativeTitles') || pick('altTitles');
    if (altPacked) alt = altPacked.split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    if (!alt.length) alt = extractStringArray(decoded, 'alternativeTitles');

    const info = {
      title, cover, banner, description, author, artist, status,
      genres, alternativeTitles: alt,
      slug,
      sourceUrl: url
    };

    // Markdown payload (Jina / text proxy) — fill remaining gaps.
    if (global.SourceConfig?.isMarkdownPayload?.(html)) {
      const md = global.SourceConfig.parseMarkdownMeta(html);
      if (!info.title || info.title === prettifySlug(slug)) info.title = md.title || info.title;
      if (!info.cover)        info.cover = md.cover;
      if (!info.description)  info.description = md.description;
      if (!info.author)       info.author = md.author;
      if (!info.artist)       info.artist = md.artist;
      if (!info.genres.length) info.genres = md.genres;
      if (md.status)          info.status = md.status;
      console.info('[VortexScans:Series] markdown fallback metadata applied');
    }

    // Persist parsed info for the cached-fallback path on next outage.
    if (info.title && info.title !== prettifySlug(slug)) {
      writeCache(INFO_KEY(slug), info);
    }

    return info;
  };

  base.getChapterList = async function (url) {
    const slug = base.getSeriesSlug(url);
    let html;
    try {
      html = await base.fetchPage(url, {
        validator: (h) => /chapter-\d|chapterNumber|vortexscans/i.test(h)
      });
    } catch (e) {
      const cached = readCache(LIST_KEY(slug));
      if (cached && cached.length) {
        console.warn('[VortexScans:Series] live fetch failed — returning cached chapter list', { url, count: cached.length, error: e.message });
        return cached;
      }
      throw e;
    }

    const decoded = base.decodeHtml(html)
      .replace(/\\\//g, '/').replace(/\\u002F/gi, '/').replace(/\\"/g, '"');
    const origin = 'https://vortexscans.org';

    // Accept decimals with either "." or "-" (chapter-2.5 / chapter-2-5).
    const re = new RegExp(`/series/${escapeRe(slug)}/chapter-(\\d+(?:[.-]\\d+)?)`, 'gi');
    const seen = new Map();
    const addChapter = (rawNum, hrefPath) => {
      const num = parseFloat(String(rawNum).replace('-', '.'));
      if (!Number.isFinite(num)) return;
      if (seen.has(num)) return;
      const path = hrefPath || `/series/${slug}/chapter-${String(rawNum).replace('.', '-')}`;
      seen.set(num, {
        number: num,
        title: `Chapter ${num}`,
        url: origin + path
      });
    };

    let m;
    while ((m = re.exec(decoded)) !== null) addChapter(m[1], m[0]);

    // V14: ALSO pull chapter numbers out of the packed Next.js / RSC
    // payload. Vortex lazy-renders most chapter links inside the
    // virtualised list, so the link sweep above only finds the visible
    // ones (typically the latest few + the currently-selected one) and
    // chapters 2..N-3 used to be skipped from imports / Auto-Sync.
    const packedNumRe = /"chapterNumber"\s*:\s*\[0,\s*"?(\d+(?:\.\d+)?)"?\]/gi;
    while ((m = packedNumRe.exec(decoded)) !== null) addChapter(m[1], null);

    // Markdown-mode (Jina) listings: "Chapter 12" headings.
    if (seen.size < 3) {
      const mdRe = /(?:^|\n|\s)Chapter\s+(\d+(?:\.\d+)?)\b/gi;
      while ((m = mdRe.exec(decoded)) !== null) addChapter(m[1], null);
    }


    const list = [...seen.values()].sort((a, b) => a.number - b.number);
    if (list.length === 0) {
      // No chapters in this payload. Don't crash an Auto-Sync run for a
      // transient empty response — if we have a cached list, replay it.
      const cached = readCache(LIST_KEY(slug));
      if (cached && cached.length) {
        console.warn('[VortexScans:Series] empty chapter list in payload — returning cached list', { url, count: cached.length });
        return cached;
      }
      const sample = decoded.slice(0, 300).replace(/\s+/g, ' ');
      console.warn('[VortexScans:Series] empty chapter list — payload head:', sample);
      throw new Error('No chapters found on Vortex Scans series page');
    }

    writeCache(LIST_KEY(slug), list);
    console.info('[VortexScans:Series] Chapter list extracted', { url, count: list.length });
    return list;
  };

  base.checkUpdates = async function (seriesDoc) {
    const list = await base.getChapterList(seriesDoc.sourceUrl);
    const last = Number(seriesDoc.lastImportedChapter || 0);
    return list.filter(c => c.number > last);
  };

  // ----- helpers -----
  function extractJsonString(text, key) {
    const re = new RegExp(`"${escapeRe(key)}"\\s*:\\s*"([^"]+)"`, 'i');
    const m = text.match(re);
    return m ? m[1] : null;
  }
  function extractStringArray(text, key) {
    const re = new RegExp(`"${escapeRe(key)}"\\s*:\\s*\\[([^\\]]*)\\]`, 'i');
    const m = text.match(re);
    if (!m) return [];
    return (m[1].match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1));
  }
  function extractPackedNames(text, key) {
    const block = text.match(new RegExp(`"${escapeRe(key)}"\\s*:\\s*\\[1,\\[(.{0,3000}?)\\]\\]`, 'i'));
    if (!block) return [];
    const out = [];
    const nameRe = /"name"\s*:\s*\[0,"([^"]+)"\]/gi;
    let m;
    while ((m = nameRe.exec(block[1])) !== null) {
      const t = m[1].trim();
      if (t && t.length < 40 && !out.includes(t)) out.push(t);
    }
    return out;
  }
  function ogContent(text, prop) {
    const m = text.match(new RegExp(`<meta[^>]+property=["']${escapeRe(prop)}["'][^>]+content=["']([^"']+)["']`, 'i')) ||
              text.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${escapeRe(prop)}["']`, 'i'));
    return m ? m[1] : '';
  }
  function metaContent(text, name) {
    const m = text.match(new RegExp(`<meta[^>]+name=["']${escapeRe(name)}["'][^>]+content=["']([^"']+)["']`, 'i'));
    return m ? m[1] : '';
  }
  function stripHtml(s) {
    if (!s) return '';
    return String(s)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }
  function normalizeStatus(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return 'ongoing';
    if (/dropped|cancell?ed|axed/.test(s)) return 'dropped';
    if (/completed|complete|finished/.test(s)) return 'completed';
    if (/hiatus|paused|season\s*end/.test(s)) return 'hiatus';
    if (/coming\s*soon|upcoming/.test(s)) return 'upcoming';
    return 'ongoing';
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function prettifySlug(slug) {
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
  }
})(window);
