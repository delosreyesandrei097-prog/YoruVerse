/**
 * ============================================================
 * FLAME COMICS - SERIES EXTENSION
 * ============================================================
 * Adds series-level capabilities to SourceFlameComics.
 * Load AFTER source-flamecomics.js.
 *
 * Series URL pattern: https://flamecomics.xyz/series/<slug>
 * ============================================================
 */
(function (global) {
  'use strict';
  if (!global.SourceFlameComics) {
    console.error('[FlameComics:Series] base plugin not found — load source-flamecomics.js first');
    return;
  }
  const base = global.SourceFlameComics;

  const SERIES_PATTERN = /^https?:\/\/(?:www\.)?flamecomics\.xyz\/series\/[^/]+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('flamecomics.xyz') && SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/series\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  base.getSeriesInfo = async function (url) {
    const html = await global.SourceConfig.fetchPage(url, {
      validator: (h) => /flamecomics|__NEXT_DATA__|seriesTitle|og:title/i.test(h)
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const nextData = base.parseNextData(doc);
    const props = nextData?.props?.pageProps || {};
    const series = props.series || props.seriesData || props.manga || props.comic || {};

    const title = series.title || ogContent(doc, 'og:title') || prettifySlug(base.getSeriesSlug(url));
    let cover = series.cover || series.coverImage || series.image || series.thumbnail ||
                attrOf(doc, 'meta[property="og:image"]', 'content') || '';
    if (cover && cover.startsWith('/')) cover = 'https://flamecomics.xyz' + cover;
    const banner = series.banner || series.bannerImage || '';

    const description = stripHtml(series.description || series.synopsis ||
                                  metaContent(doc, 'description') || '');
    const author = arrayJoin(series.author) || arrayJoin(series.authors) || '';
    const artist = arrayJoin(series.artist) || arrayJoin(series.artists) || author;
    const status = normalizeStatus(series.status || series.releaseStatus || '');

    let genres = [];
    const g = series.genres || series.tags;
    if (Array.isArray(g)) {
      genres = g.map(x => (typeof x === 'string' ? x : (x?.name || x?.title || ''))).filter(Boolean);
    } else {
      genres = Array.from(doc.querySelectorAll('.genre a, .genres a, [data-genre]'))
        .map(a => a.textContent.trim()).filter(Boolean);
    }

    let alt = [];
    if (series.altTitles || series.alternativeTitles) {
      const a = series.altTitles || series.alternativeTitles;
      alt = Array.isArray(a) ? a : String(a).split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    }

    return {
      title, cover, banner,
      description, author, artist, status,
      genres, alternativeTitles: alt,
      slug: base.getSeriesSlug(url),
      sourceUrl: url
    };
  };

  base.getChapterList = async function (url) {
    const html = await global.SourceConfig.fetchPage(url, {
      validator: (h) => /chapter|__NEXT_DATA__|flamecomics/i.test(h)
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const nextData = base.parseNextData(doc);
    const props = nextData?.props?.pageProps || {};
    const slug = base.getSeriesSlug(url);
    const seriesIdFromProps = props.series?.series_id != null ? String(props.series.series_id) : null;
    // The series URL is /series/<id> on flamecomics.xyz now — `slug` is
    // actually the numeric id. Keep both for legacy/slug URLs.
    const seriesId = seriesIdFromProps || slug;
    const origin = 'https://flamecomics.xyz';
    const seen = new Map();

    // 1. __NEXT_DATA__ chapter array — this is the authoritative source.
    //    Each entry has { chapter, token, title, chapter_id, series_id }.
    //    Real URL is /series/<series_id>/<token>.
    const chapterArrays = [props.chapters, props.series?.chapters, props.seriesData?.chapters,
                           props.manga?.chapters, props.allChapters];
    for (const arr of chapterArrays) {
      if (!Array.isArray(arr)) continue;
      arr.forEach(c => {
        const numRaw = c.chapter ?? c.number ?? c.chapterNumber;
        const num = parseFloat(numRaw);
        if (!Number.isFinite(num) || seen.has(num)) return;

        const sid = c.series_id != null ? String(c.series_id) : seriesId;
        let abs = null;
        if (c.token && sid) {
          abs = `${origin}/series/${sid}/${c.token}`;
        } else if (c.url) {
          abs = String(c.url).startsWith('http') ? c.url : (origin + (String(c.url).startsWith('/') ? c.url : '/' + c.url));
        } else if (c.slug && sid) {
          abs = `${origin}/series/${sid}/${c.slug}`;
        }
        // No reliable URL? skip — generating /chapter-<n> would 404.
        if (!abs) return;

        const titleSuffix = (c.title || c.chapter_title || '').toString().trim();
        seen.set(num, {
          number: num,
          title: titleSuffix ? `Chapter ${num} - ${titleSuffix}` : `Chapter ${num}`,
          url: abs
        });
      });
    }

    // 2. DOM links — match the new /series/<id>/<token> shape too.
    if (seen.size === 0) {
      const linkRe = /\/series\/(\d+)\/([A-Za-z0-9]{6,})/;
      doc.querySelectorAll('a[href*="/series/"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(linkRe);
        if (!m) return;
        const text = (a.textContent || '').trim();
        const numMatch = text.match(/(\d+(?:\.\d+)?)/);
        if (!numMatch) return;
        const num = parseFloat(numMatch[1]);
        if (!Number.isFinite(num) || seen.has(num)) return;
        const abs = href.startsWith('http') ? href : origin + (href.startsWith('/') ? href : '/' + href);
        seen.set(num, { number: num, title: text || `Chapter ${num}`, url: abs });
      });
    }

    // 3. Fallback regex over HTML for token-style chapter URLs.
    if (seen.size === 0 && seriesId) {
      const re = new RegExp(`/series/${escapeRe(seriesId)}/([A-Za-z0-9]{6,})`, 'gi');
      // Without a chapter number context this fallback can't assign
      // numbers reliably, so we only use it as a last-resort token list.
      let m, idx = 1;
      while ((m = re.exec(html)) !== null) {
        const abs = `${origin}/series/${seriesId}/${m[1]}`;
        if (![...seen.values()].some(v => v.url === abs)) {
          seen.set(`token-${idx}`, { number: idx, title: `Chapter ${idx}`, url: abs });
          idx++;
        }
      }
    }

    const list = [...seen.values()]
      .filter(c => typeof c.number === 'number' && Number.isFinite(c.number))
      .sort((a, b) => a.number - b.number);
    if (list.length === 0) throw new Error('No chapters found on Flame Comics series page');
    return list;
  };

  base.checkUpdates = async function (seriesDoc) {
    const list = await base.getChapterList(seriesDoc.sourceUrl);
    const last = Number(seriesDoc.lastImportedChapter || 0);
    return list.filter(c => c.number > last);
  };

  // ---- helpers ----
  function attrOf(doc, sel, attr) { const el = doc.querySelector(sel); return el ? (el.getAttribute(attr) || '').trim() : ''; }
  function ogContent(doc, prop) { const m = doc.querySelector(`meta[property="${prop}"]`); return m?.content || ''; }
  function metaContent(doc, name) { const m = doc.querySelector(`meta[name="${name}"]`); return m?.content || ''; }
  function arrayJoin(v) {
    if (!v) return '';
    if (Array.isArray(v)) return v.map(x => (typeof x === 'string' ? x : (x?.name || x?.title || ''))).filter(Boolean).join(', ');
    return typeof v === 'string' ? v : (v.name || v.title || '');
  }
  function stripHtml(s) {
    return String(s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
      .replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  }
  function normalizeStatus(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return 'ongoing';
    if (/drop|cancel/.test(s)) return 'dropped';
    if (/complete|finished|end/.test(s)) return 'completed';
    if (/hiatus|paused/.test(s)) return 'hiatus';
    if (/upcoming|coming/.test(s)) return 'upcoming';
    return 'ongoing';
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function prettifySlug(slug) {
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
  }
})(window);
