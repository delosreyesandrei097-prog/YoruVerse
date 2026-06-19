/**
 * ============================================================
 * UTOON - SERIES EXTENSION
 * ============================================================
 * Adds series-level capabilities to the SourceUtoon chapter
 * plugin. Load AFTER source-utoon.js.
 *
 * Series URL: https://utoon.net/manga/<slug>/
 * Madara series page layout:
 *   - Cover:   .summary_image img[src|data-src]
 *   - Meta:    .post-content_item > .summary-heading + .summary-content
 *              (Author(s) / Artist(s) / Genre(s) / Status / Type / Alt Names)
 *   - Desc:    .summary__content / .description-summary
 *   - Chapters: .listing-chapters_wrap ul li a   OR  ul.main li a
 *               (sometimes loaded async; we also regex-sweep).
 * ============================================================
 */
(function (global) {
  'use strict';
  if (!global.SourceUtoon) {
    console.error('[Utoon:Series] base plugin not found — load source-utoon.js first');
    return;
  }
  const base = global.SourceUtoon;

  const SERIES_PATTERN = /^https?:\/\/(www\.)?utoon\.net\/manga\/[^/?#]+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') === 'utoon.net' && SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/manga\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  async function fetchSeriesPage(url) {
    return global.SourceConfig.fetchPage(url, {
      validator: (h) => /wp-manga|summary_image|listing-chapters|wp-theme-madara|post-title|\/manga\//i.test(h)
    });
  }

  base.getSeriesInfo = async function (url) {
    const html = await fetchSeriesPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const title =
      doc.querySelector('.post-title h1, .post-title h3, h1.entry-title')?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.split('|')[0].trim() ||
      prettifySlug(base.getSeriesSlug(url));

    let cover =
      doc.querySelector('.summary_image img')?.getAttribute('data-src') ||
      doc.querySelector('.summary_image img')?.getAttribute('src') ||
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
    cover = absolutize(cover.trim(), 'https://utoon.net')
      .replace(/-\d+x\d+(\.(?:webp|jpg|jpeg|png))$/i, '$1');

    const description =
      doc.querySelector('.summary__content, .description-summary .summary__content, .manga-excerpt')
        ?.textContent?.trim() ||
      doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    // Walk .post-content_item rows to pluck author/artist/status/genres/alt names.
    const meta = readMetaRows(doc);

    const status = normalizeStatus(meta.status || meta.Status || '');

    const genres = (meta.genres || meta.genre || '')
      .toString().split(/[,;|]/).map(s => s.trim()).filter(Boolean);

    const alt = (meta.alternative || meta['alt names'] || meta['alternative names'] || '')
      .toString().split(/[,;|]/).map(s => s.trim()).filter(Boolean);

    const info = {
      title, cover, description,
      author: meta.author || meta.authors || '',
      artist: meta.artist || meta.artists || '',
      status,
      genres,
      alternativeTitles: alt,
      slug: base.getSeriesSlug(url),
      sourceUrl: url
    };

    // LAST RESORT: markdown payload (text proxy) — fill the gaps from it.
    if (global.SourceConfig?.isMarkdownPayload?.(html)) {
      const md = global.SourceConfig.parseMarkdownMeta(html);
      if (!info.title || info.title === prettifySlug(base.getSeriesSlug(url))) info.title = md.title || info.title;
      if (!info.cover)        info.cover = md.cover;
      if (!info.description)  info.description = md.description;
      if (!info.author)       info.author = md.author;
      if (!info.artist)       info.artist = md.artist;
      if (!info.genres.length) info.genres = md.genres;
      if (md.status)          info.status = md.status;
      console.info('[Utoon:Series] markdown fallback metadata applied', {
        cover: !!info.cover, description: !!info.description, genres: info.genres.length
      });
    }

    return info;
  };

  function normalizeStatus(raw) {
    const s = String(raw || '').toLowerCase().trim();
    if (!s) return 'ongoing';
    if (/dropped|cancell?ed|axed/.test(s)) return 'dropped';
    if (/completed|complete|finished/.test(s)) return 'completed';
    if (/hiatus|paused|season\s*end/.test(s)) return 'hiatus';
    if (/coming\s*soon|upcoming/.test(s)) return 'upcoming';
    return 'ongoing';
  }

  base.getChapterList = async function (url) {
    let html = await fetchSeriesPage(url);
    const slug = base.getSeriesSlug(url);
    const origin = 'https://utoon.net';

    const parse = (payload) => {
      const doc = new DOMParser().parseFromString(payload, 'text/html');
      const map = new Map();

      const addFromHref = (href, text) => {
        if (!href) return;
        // Accept trailing slash OR none, query string OR none.
        const m = href.match(new RegExp(
          `\\/manga\\/${escapeRe(slug)}\\/chapter-(\\d+)(?:[-.](\\d+))?\\/?(?:[?#]|$)`,
          'i'
        ));
        if (!m) return;
        const number = m[2]
          ? parseFloat(`${parseInt(m[1], 10)}.${m[2]}`)
          : parseInt(m[1], 10);
        if (!Number.isFinite(number)) return;
        const abs = absolutize(href, origin);
        if (!abs) return;
        if (!map.has(number)) {
          const label = (text || '').trim().replace(/\s+/g, ' ');
          map.set(number, { number, title: label || `Chapter ${number}`, url: abs });
        }
      };

      // 1) Walk anchors in any chapter list container.
      doc.querySelectorAll('a[href*="/manga/"][href*="chapter-"]').forEach(a => {
        addFromHref(a.getAttribute('href') || '', a.textContent || '');
      });

      // 2) Regex sweep — captures anything injected as JSON / inside scripts
      //    AND markdown payloads (full chapter URLs appear in both).
      const sweep = new RegExp(
        `https?:\\/\\/(?:www\\.)?utoon\\.net\\/manga\\/${escapeRe(slug)}\\/chapter-(\\d+)(?:[-.](\\d+))?\\/?`,
        'gi'
      );
      let m;
      while ((m = sweep.exec(payload)) !== null) {
        const number = m[2]
          ? parseFloat(`${parseInt(m[1], 10)}.${m[2]}`)
          : parseInt(m[1], 10);
        if (!Number.isFinite(number)) continue;
        if (!map.has(number)) {
          map.set(number, { number, title: `Chapter ${number}`, url: m[0] });
        }
      }
      return map;
    };

    let map = parse(html);

    // Madara renders the chapter list lazily on SOME setups. The live site
    // server-renders it, so only fall back to the slow AJAX endpoints when
    // the main payload produced nothing (each walks the full proxy chain).
    if (map.size === 0) {
      console.warn('[Utoon:Series] no chapters in main page payload — trying AJAX fallbacks');
      try {
        const ajax1 = await fetchAjaxChaptersSeries(url);
        if (ajax1) html += '\n' + ajax1;
      } catch {}
      try {
        const ajax2 = await fetchAjaxChaptersAdmin(html, url);
        if (ajax2) html += '\n' + ajax2;
      } catch {}
      map = parse(html);
    }

    const list = [...map.values()].sort((a, b) => a.number - b.number);
    if (list.length === 0) {
      const sample = html.slice(0, 400).replace(/\s+/g, ' ');
      console.warn('[Utoon:Series] empty chapter list — payload head:', sample);
      throw new Error('No chapters found on Utoon series page');
    }
    console.info('[Utoon:Series] Chapter list extracted', { url, count: list.length });
    return list;
  };

  base.checkUpdates = async function (seriesDoc) {
    const list = await base.getChapterList(seriesDoc.sourceUrl);
    const last = Number(seriesDoc.lastImportedChapter || 0);
    // Defensive: also union the chapter numbers we have in Firestore
    // (passed in via seriesDoc.existingChapterNumbers when available)
    // so we never miss a chapter that's between two existing ones.
    const have = new Set(
      Array.isArray(seriesDoc.existingChapterNumbers)
        ? seriesDoc.existingChapterNumbers.map(Number)
        : []
    );
    return list.filter(c =>
      Number.isFinite(c.number) &&
      c.number > last &&
      !have.has(Number(c.number))
    );
  };

  // ---------- helpers ----------
  function readMetaRows(doc) {
    const out = {};
    doc.querySelectorAll('.post-content_item').forEach(row => {
      const head = (row.querySelector('.summary-heading')?.textContent || '').trim().toLowerCase();
      if (!head) return;
      const body = row.querySelector('.summary-content');
      if (!body) return;
      const key = head.replace(/[():]/g, '').replace(/\(s\)/g, '').trim();
      // Collect links if present (genres, author...), else plain text.
      const links = [...body.querySelectorAll('a')].map(a => a.textContent.trim()).filter(Boolean);
      out[key] = links.length ? links.join(', ') : body.textContent.replace(/\s+/g, ' ').trim();
    });
    return out;
  }

  // Madara's per-series sub-endpoint: /manga/<slug>/ajax/chapters/  (POST)
  async function fetchAjaxChaptersSeries(seriesUrl) {
    const tryUrl = seriesUrl.replace(/\/?$/, '/') + 'ajax/chapters/';
    try {
      return await global.SourceConfig.fetchPage(tryUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validator: (h) => /chapter-\d|wp-manga-chapter/i.test(h)
      });
    } catch {
      return '';
    }
  }

  // Madara's global admin-ajax endpoint:
  //   POST /wp-admin/admin-ajax.php
  //   body: action=manga_get_chapters&manga=<post_id>
  // We pull the post_id from any `data-id="…"` / "manga_id":N pattern in
  // the cached series HTML, then POST as form data via the proxy chain.
  async function fetchAjaxChaptersAdmin(html, seriesUrl) {
    const idMatch =
      html.match(/data-id=["'](\d{2,})["']/i) ||
      html.match(/"manga[_-]?id"\s*:\s*"?(\d{2,})"?/i) ||
      html.match(/wp-manga-chapter[^"']*"[^>]*data-id=["'](\d+)["']/i);
    if (!idMatch) return '';
    const postId = idMatch[1];
    const adminUrl = 'https://utoon.net/wp-admin/admin-ajax.php';
    try {
      return await global.SourceConfig.fetchPage(adminUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `action=manga_get_chapters&manga=${encodeURIComponent(postId)}`,
        validator: (h) => /chapter-\d|wp-manga-chapter/i.test(h)
      });
    } catch {
      return '';
    }
  }

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function prettifySlug(slug) {
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
  }
  function absolutize(href, origin) {
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/'))  return origin + href;
    return origin + '/' + href;
  }
})(window);
