/**
 * ============================================================
 * ASURA SCANS - SERIES EXTENSION
 * ============================================================
 * Adds series-level methods to the existing SourceTemplate (Asura Scans)
 * chapter plugin. Load AFTER source-template.js.
 *
 * Supports series URLs of the form:
 *   https://asurascans.com/series/<slug>
 *   https://asurascans.com/series/<slug-hash>
 *   https://asurascans.com/comics/<slug-hash>
 *   https://asurascans.com/manga/<slug>
 *
 * Chapter URL shapes vary; we collect every link on the series page
 * that matches a `/chapter/<num>` or `/chapter-<num>` suffix.
 * ============================================================
 */
(function (global) {
  'use strict';
  if (!global.SourceTemplate) {
    console.error('[AsuraScans:Series] base plugin not found — load source-template.js first');
    return;
  }
  const base = global.SourceTemplate;

  const SERIES_PATTERNS = [
    /^https?:\/\/(www\.)?asurascans\.com\/series\/[^/?#]+\/?(?:[?#].*)?$/i,
    /^https?:\/\/(www\.)?asurascans\.com\/comics\/[^/?#]+\/?(?:[?#].*)?$/i,
    /^https?:\/\/(www\.)?asurascans\.com\/manga\/[^/?#]+\/?(?:[?#].*)?$/i
  ];

  base.seriesUrlPatterns = SERIES_PATTERNS;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./, '') !== 'asurascans.com') return false;
      return SERIES_PATTERNS.some(p => p.test(url));
    } catch { return false; }
  };

  // Series pages don't contain the chapter-image markers the base validator
  // checks for. V12: require chapter-link evidence so we don't accept
  // Cloudflare interstitials, blank Astro shells, or unrelated landing pages.
  const seriesValidator = (html) => {
    if (typeof html !== 'string' || html.length < 200) return false;
    // Direct evidence of a chapter list (HTML anchors, RSC payload, or
    // jina-markdown links). Any one is sufficient.
    if (/\/chapter[\/-]\d/i.test(html)) return true;
    if (/&quot;chapters&quot;:\[1,\[/i.test(html)) return true;
    if (/"chapters"\s*:\s*\[1,\[/i.test(html)) return true;
    // Markdown-style chapter links from text proxies.
    if (/\[\s*Chapter\s+\d/i.test(html)) return true;
    return false;
  };

  async function fetchSeriesPage(url) {
    return window.SourceConfig.fetchPage(url, { validator: seriesValidator });
  }

  base.getSeriesInfo = async function (url) {
    const html = await fetchSeriesPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const og = (prop) => doc.querySelector(`meta[property="${prop}"]`)?.getAttribute('content');
    const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content');

    // JSON-LD if present (best source for structured fields)
    const ld = parseJsonLd(doc);

    const title =
      base.findAstroString(html, 'seriesName') ||
      base.findAstroString(html, 'title') ||
      ld.name ||
      (og('og:title') || '').replace(/\s*\|\s*Asura Scans\s*$/i, '').trim() ||
      doc.querySelector('h1')?.textContent?.trim() ||
      prettifySlug(slugFromUrl(url));

    const cover =
      base.findAstroString(html, 'cover') ||
      ld.image ||
      og('og:image') ||
      firstMatch(html, /https?:\/\/cdn\.asurascans\.com\/asura-images\/covers\/[^"'<>\\\s]+?\.(?:webp|jpg|jpeg|png)/i) ||
      '';

    // Banner image (series hero) when the page ships one.
    const banner =
      firstMatch(html, /https?:\/\/(?:cdn\.)?asurascans\.com\/asura-images\/banners\/[^"'<>\\\s]+?\.(?:webp|jpg|jpeg|png)/i) || '';

    const description = stripHtml(
      base.findAstroString(html, 'synopsis') ||
      base.findAstroString(html, 'description') ||
      ld.description ||
      meta('description') ||
      og('og:description') ||
      ''
    );

    const author = base.findAstroString(html, 'author')   || ld.author   || '';
    const artist = base.findAstroString(html, 'artist')   || ld.artist   || '';
    const status = normalizeStatus(base.findAstroString(html, 'status') || ld.status || '');

    let genres = extractGenres(doc, html);
    if (!genres.length && Array.isArray(ld.genres)) genres = ld.genres;

    let alternativeTitles = extractAltTitles(doc, html);
    if (!alternativeTitles.length && ld.alternateName) {
      alternativeTitles = String(ld.alternateName).split(/\s*[•|]\s*/).map(s => s.trim()).filter(Boolean);
    }

    const info = {
      title, cover, banner, description, author, artist, status,
      genres, alternativeTitles,
      slug: slugFromUrl(url),
      sourceUrl: url
    };

    // LAST RESORT: payload was markdown (text proxy) — fill the gaps from it.
    if (global.SourceConfig?.isMarkdownPayload?.(html)) {
      const md = global.SourceConfig.parseMarkdownMeta(html);
      if (!info.title || info.title === prettifySlug(slugFromUrl(url))) info.title = md.title || info.title;
      if (!info.cover)        info.cover = md.cover;
      if (!info.description)  info.description = md.description;
      if (!info.author)       info.author = md.author;
      if (!info.artist)       info.artist = md.artist;
      if (!info.genres.length) info.genres = md.genres;
      if (md.status)          info.status = md.status;
      console.info('[AsuraScans:Series] markdown fallback metadata applied', {
        cover: !!info.cover, description: !!info.description, genres: info.genres.length
      });
    }

    return info;
  };

  base.getChapterList = async function (url) {
    let html;
    try {
      html = await fetchSeriesPage(url);
    } catch (e) {
      const err = new Error(`[AsuraScans:Series] Network/source error fetching series page ${url}: ${(e && e.message) || e}`);
      err.category = 'network';
      throw err;
    }
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const seriesSlug = slugFromUrl(url);
    const origin = 'https://asurascans.com';

    const map = new Map(); // number -> { number, title, url }
    let anchorCount = 0;
    let sweepCount = 0;
    let mdCount = 0;

    const addEntry = (num, rawTitle, abs) => {
      if (!Number.isFinite(num) || !abs) return;
      const cleaned = cleanChapterTitle(rawTitle, num);
      if (!map.has(num)) {
        map.set(num, { number: num, title: cleaned, url: abs });
      } else if (cleaned && !/^Chapter\s+\d+(?:\.\d+)?$/i.test(cleaned)) {
        // Upgrade to a more descriptive title if we found one later.
        const existing = map.get(num);
        if (/^Chapter\s+\d+(?:\.\d+)?$/i.test(existing.title)) {
          existing.title = cleaned;
        }
      }
    };

    // 1) Walk anchors on the rendered page
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href') || '';
      const num = chapterNumberFromHref(href);
      if (num == null) return;
      const abs = absolutize(href, origin);
      if (!abs) return;
      const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
      addEntry(num, text || `Chapter ${num}`, abs);
      anchorCount++;
    });

    // 2) Regex sweep for chapter URLs missed by anchors (rendered client-side
    //    or returned by markdown-style proxies like r.jina.ai). Slug-agnostic
    //    so we still match when the proxy rewrites/strips the series slug.
    const decoded = base.decodeHtml(html);
    const sweepRe =
      /https?:\/\/(?:www\.)?asurascans\.com\/(?:series|comics|manga)\/[^"'<>\s)\]]+?\/chapter[\/-](\d+(?:[.-]\d+)?)/gi;
    let m;
    while ((m = sweepRe.exec(decoded)) !== null) {
      const num = parseChapterToken(m[1]);
      addEntry(num, `Chapter ${num}`, m[0]);
      sweepCount++;
    }

    // 2b) Relative-path sweep (proxies that strip the host but keep paths).
    if (seriesSlug) {
      const relRe = new RegExp(
        `["'(\\s](\\/(?:series|comics|manga)\\/${escapeRe(seriesSlug)}\\/chapter[\\/-](\\d+(?:[.-]\\d+)?))`,
        'gi'
      );
      let rm;
      while ((rm = relRe.exec(decoded)) !== null) {
        const num = parseChapterToken(rm[2]);
        addEntry(num, `Chapter ${num}`, origin + rm[1]);
        sweepCount++;
      }
    }

    // 3) Markdown link sweep: [Chapter 38 - title  1 day ago](https://.../chapter/38)
    //    Many proxies (r.jina.ai, etc.) return markdown instead of HTML.
    const mdRe =
      /\[([^\]\n]{1,200})\]\((https?:\/\/(?:www\.)?asurascans\.com\/(?:series|comics|manga)\/[^)\s]+?\/chapter[\/-](\d+(?:[.-]\d+)?))\)/gi;
    let mm;
    while ((mm = mdRe.exec(decoded)) !== null) {
      const text = mm[1].trim().replace(/\s+/g, ' ');
      const abs  = mm[2];
      const num  = parseChapterToken(mm[3]);
      addEntry(num, text || `Chapter ${num}`, abs);
      mdCount++;
    }

    const list = [...map.values()].sort((a, b) => a.number - b.number);
    console.log(
      `[AsuraScans:Series] chapters detected: ${list.length} ` +
      `(anchors=${anchorCount}, sweep=${sweepCount}, markdown=${mdCount}, slug="${seriesSlug}")`
    );
    if (list.length === 0) {
      const sample = decoded.slice(0, 400).replace(/\s+/g, ' ');
      console.warn('[AsuraScans:Series] empty chapter list — first 400 chars of payload:', sample);
      const err = new Error(`[AsuraScans:Series] Parsing error: no chapters found on series page ${url} (payload may be a Cloudflare challenge or stripped proxy response)`);
      err.category = 'parsing';
      throw err;
    }
    return list;
  };

  base.checkUpdates = async function (seriesDoc) {
    const list = await base.getChapterList(seriesDoc.sourceUrl);
    const last = Number(seriesDoc.lastImportedChapter || 0);
    const latest = list.reduce((mx, c) => (Number(c.number) > mx ? Number(c.number) : mx), 0);
    const newer = list.filter(c => Number(c.number) > last);
    console.log(`[AsuraScans:Series] checkUpdates: latest=${latest} lastImported=${last} newCount=${newer.length}`);
    return newer;
  };

  // ---------- helpers ----------
  function slugFromUrl(url) {
    const m = String(url).match(/\/(?:series|comics|manga)\/([^/?#]+)/i);
    return m ? m[1] : '';
  }
  function chapterNumberFromHref(href) {
    // Match decimals written with either "." (chapter/2.5) or "-" (chapter-2-5).
    const m = href.match(/\/chapter[\/-](\d+(?:[.-]\d+)?)/i);
    return m ? parseChapterToken(m[1]) : null;
  }
  function parseChapterToken(tok) {
    if (tok == null) return null;
    const s = String(tok).replace('-', '.');
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  function absolutize(href, origin) {
    if (!href) return null;
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/'))  return origin + href;
    return origin + '/' + href;
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /**
   * Strip release-timer / date suffixes from chapter anchor text and
   * normalize the result. Examples handled:
   *   "Chapter 38 1 day ago"           -> "Chapter 38"
   *   "Chapter 37last week"            -> "Chapter 37"
   *   "Chapter 33May 1, 2026"          -> "Chapter 33"
   *   "Chapter 75: End of the First Year 3 hours ago" -> custom title preserved
   * If only "Chapter N" remains (no custom title), returns "Chapter N".
   */
  function cleanChapterTitle(raw, num) {
    if (!raw) return `Chapter ${num}`;
    let t = String(raw).replace(/\s+/g, ' ').trim();

    // Strip trailing relative-time phrases (with or without leading space)
    const relRe = /\s*(?:[•·\-–|,]\s*)?(?:just\s+now|yesterday|last\s+(?:week|month|year|hour|minute|second)|a\s+(?:few\s+)?(?:second|minute|hour|day|week|month|year)s?\s+ago|\d+\s*(?:s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|wks|week|weeks|mo|month|months|y|yr|yrs|year|years)\s*ago)\s*$/i;
    for (let i = 0; i < 3 && relRe.test(t); i++) t = t.replace(relRe, '').trim();

    // Strip trailing absolute dates like "May 1, 2026" / "Apr 24, 20..." / "2026-05-01"
    const dateRe = /\s*(?:[•·\-–|,]\s*)?(?:(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z.]*\s+\d{1,2}(?:,\s*\d{2,4})?(?:\s*\.{2,3})?|\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}|\d{4}-\d{2}-\d{2})\s*$/i;
    for (let i = 0; i < 3 && dateRe.test(t); i++) t = t.replace(dateRe, '').trim();

    // Drop trailing punctuation left behind
    t = t.replace(/[\s,;:•·\-–|]+$/g, '').trim();

    // If the cleaned text reduces to just "Chapter <num>" (with optional separator),
    // normalize to the canonical "Chapter N" form.
    const onlyChapter = new RegExp(`^chapter\\s*0*${num.toString().replace('.', '\\.')}\\b[\\s:.\\-–]*$`, 'i');
    if (onlyChapter.test(t)) return `Chapter ${num}`;

    // If it's empty after cleaning, fall back.
    if (!t) return `Chapter ${num}`;

    // If text starts with "Chapter N <separator> Title", return just the
    // subtitle so the UI renders "Chapter N: Title" (it auto-prefixes).
    const withCustom = t.match(new RegExp(`^chapter\\s*0*${num.toString().replace('.', '\\.')}\\s*[:.\\-–]\\s*(.+)$`, 'i'));
    if (withCustom) return withCustom[1].trim();

    // If it still starts with "Chapter N " followed by extra words, treat
    // the remainder as the custom subtitle.
    const trailing = t.match(new RegExp(`^chapter\\s*0*${num.toString().replace('.', '\\.')}\\s+(.+)$`, 'i'));
    if (trailing) {
      const rest = trailing[1].trim();
      return rest || `Chapter ${num}`;
    }

    return t;
  }
  function prettifySlug(slug) {
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
  }
  function parseJsonLd(doc) {
    const out = {};
    doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
      try {
        const obj = JSON.parse(s.textContent || '{}');
        const items = Array.isArray(obj) ? obj : [obj];
        items.forEach(it => {
          if (!it || typeof it !== 'object') return;
          // Skip the site-wide Organization block (its "name" is "Asura Scans")
          if (it['@type'] === 'Organization' || it['@type'] === 'BreadcrumbList') return;
          if (it.name && !out.name) out.name = String(it.name);
          if (it.headline && !out.name) out.name = String(it.headline);
          if (it.description && !out.description) out.description = String(it.description);
          if (it.image && !out.image) out.image = typeof it.image === 'string' ? it.image : (it.image.url || '');
          if (it.author && !out.author) out.author = nameOf(it.author);
          if (it.illustrator && !out.artist) out.artist = nameOf(it.illustrator);
          if (it.genre && !out.genres) {
            out.genres = (Array.isArray(it.genre) ? it.genre : [it.genre]).map(String).filter(Boolean);
          }
          const alt = it.alternateName || it.alternativeHeadline;
          if (alt && !out.alternateName) out.alternateName = String(alt);
          if (it.creativeWorkStatus && !out.status) out.status = String(it.creativeWorkStatus);
        });
      } catch {}
    });
    return out;
  }
  function nameOf(v) {
    if (!v) return '';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join(', ');
    if (typeof v === 'object') return v.name || '';
    return String(v);
  }
  function firstMatch(html, re) {
    const m = String(html || '').match(re);
    return m ? m[0] : '';
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
  // Map source statuses to the platform's vocabulary. Asura uses values
  // like "ongoing", "completed", "hiatus", "dropped", "axed", "season end".
  function normalizeStatus(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return 'ongoing';
    if (/axed|dropped|cancell?ed/.test(s)) return 'dropped';
    if (/completed|complete|finished|end(?:ed)?$/.test(s)) return 'completed';
    if (/hiatus|season\s*end|paused/.test(s)) return 'hiatus';
    if (/coming\s*soon|upcoming/.test(s)) return 'upcoming';
    return 'ongoing';
  }
  function extractGenres(doc, html) {
    const set = new Set();
    // Current Asura layout links genres to /browse?genres=<g>; older layouts
    // used /genres/<g>. Accept both.
    doc.querySelectorAll('a[href*="/genres/"], a[href*="/genre/"], a[href*="genres="], a[href*="genre="]').forEach(a => {
      const t = (a.textContent || '').trim();
      if (t && t.length < 40 && !/^(all|browse)$/i.test(t)) set.add(t);
    });
    const packed = base.findAstroString(html, 'genres');
    if (packed) packed.split(/[,\|]/).forEach(g => { const t = g.trim(); if (t) set.add(t); });
    // Astro-packed nested genre objects: &quot;genres&quot;:[1,[[0,{...&quot;name&quot;:[0,&quot;Action&quot;]...
    const decoded = base.decodeHtml(html);
    const block = decoded.match(/"genres"\s*:\s*\[1,\[(.{0,2000}?)\]\]/i);
    if (block) {
      let nm;
      const nameRe = /"name"\s*:\s*\[0,"([^"]+)"\]/gi;
      while ((nm = nameRe.exec(block[1])) !== null) {
        const t = nm[1].trim();
        if (t && t.length < 40) set.add(t);
      }
    }
    return [...set];
  }
  function extractAltTitles(doc, html) {
    const packed =
      base.findAstroString(html, 'alternativeTitles') ||
      base.findAstroString(html, 'altTitle') ||
      base.findAstroString(html, 'alternativeName');
    if (!packed) return [];
    return packed.split(/[,;•]| - /).map(s => s.trim()).filter(Boolean);
  }
})(window);
