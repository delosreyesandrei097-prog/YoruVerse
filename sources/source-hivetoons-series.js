/**
 * ============================================================
 * HIVETOONS - SERIES EXTENSION
 * ============================================================
 * Adds series-level capabilities to the SourceHiveToons chapter
 * plugin. Load AFTER source-hivetoons.js.
 *
 * Series URL: https://hivetoons.org/series/<slug>
 * HiveToons runs the same engine as Vortex Scans: series data is
 * embedded as Astro-packed keys —
 *   postTitle, postContent (HTML synopsis), featuredImage (cover),
 *   banner / bannerHero, seriesStatus, author, artist,
 *   alternativeTitles (comma-separated), genres (nested name objects).
 * ============================================================
 */
(function (global) {
  'use strict';
  if (!global.SourceHiveToons) {
    console.error('[HiveToons:Series] base plugin not found — load source-hivetoons.js first');
    return;
  }
  const base = global.SourceHiveToons;

  const SERIES_PATTERN = /^https?:\/\/(www\.)?hivetoons\.org\/series\/[^/]+\/?(?:[?#].*)?$/i;

  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('hivetoons.org') && SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/series\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  base.getSeriesInfo = async function (url) {
    const html = await global.SourceConfig.fetchPage(url, {
      validator: (h) => /hivetoons|postTitle|seriesTitle|seriesSlug|og:title/i.test(h)
    });
    const decoded = base.decodeHtml(html);

    const pick = (key) => base.findPackedString(html, key) || extractJsonString(decoded, key);

    const title = pick('postTitle') || pick('seriesTitle') || pick('title') ||
                  ogContent(decoded, 'og:title') ||
                  prettifySlug(base.getSeriesSlug(url));
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
      const coverMatch = decoded.match(
        /https:\/\/storage\.hivetoon\.com\/public\/+upload\/[^"'\s]+?\.(?:webp|jpg|jpeg|png)/i
      );
      if (coverMatch) cover = coverMatch[0].replace('public//upload', 'public/upload');
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
      slug: base.getSeriesSlug(url),
      sourceUrl: url
    };

    // LAST RESORT: markdown payload (text proxy) — fill remaining gaps.
    if (global.SourceConfig?.isMarkdownPayload?.(html)) {
      const md = global.SourceConfig.parseMarkdownMeta(html);
      if (!info.title || info.title === prettifySlug(base.getSeriesSlug(url))) info.title = md.title || info.title;
      if (!info.cover)        info.cover = md.cover;
      if (!info.description)  info.description = md.description;
      if (!info.author)       info.author = md.author;
      if (!info.artist)       info.artist = md.artist;
      if (!info.genres.length) info.genres = md.genres;
      if (md.status)          info.status = md.status;
      console.info('[HiveToons:Series] markdown fallback metadata applied');
    }

    return info;
  };

  base.getChapterList = async function (url) {
    const html = await global.SourceConfig.fetchPage(url, {
      validator: (h) => /chapter-\d|chapterNumber|hivetoons/i.test(h)
    });
    const decoded = base.decodeHtml(html);
    const slug = base.getSeriesSlug(url);
    const origin = 'https://hivetoons.org';

    // Accept "." or "-" as decimal separator (chapter-2.5 or chapter-2-5)
    // so decimal / special chapters aren't collapsed into the integer chapter.
    const re = new RegExp(`/series/${escapeRe(slug)}/chapter-(\\d+(?:[.-]\\d+)?)`, 'gi');
    const seen = new Map();
    let m;
    while ((m = re.exec(decoded)) !== null) {
      const num = parseFloat(String(m[1]).replace('-', '.'));
      if (!Number.isFinite(num)) continue;
      if (!seen.has(num)) {
        seen.set(num, { number: num, title: `Chapter ${num}`, url: origin + m[0] });
      }
    }

    const list = [...seen.values()].sort((a, b) => a.number - b.number);
    if (list.length === 0) {
      const sample = decoded.slice(0, 300).replace(/\s+/g, ' ');
      console.warn('[HiveToons:Series] empty chapter list — payload head:', sample);
      throw new Error('No chapters found on HiveToons series page');
    }
    console.info('[HiveToons:Series] Chapter list extracted', { url, count: list.length });
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
  // Collect "name":[0,"..."] values inside a packed nested block like
  //   "genres":[1,[[0,{"id":[0,1],"name":[0,"Action"],...}],...]]
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
