/**
 * ============================================================
 * MADARASCANS - SERIES EXTENSION
 * ============================================================
 * Adds series-level capabilities to the SourceMadaraScans chapter
 * plugin. Load AFTER source-madarascans.js.
 *
 * Series URL: https://madarascans.com/series/<slug>/
 *
 * MadaraScans uses a custom WordPress "mangareader" theme, but the
 * underlying markup occasionally shifts between two layouts (the
 * "legendary hero" layout and the more generic Madara theme layout).
 * We try BOTH families of selectors and keep the first non-empty hit
 * for every field, so a layout change on their side no longer wipes
 * out covers, descriptions, genres, author/artist or status.
 *
 * IMPORTANT: All extractors return either a non-empty value or `null`
 * (never `''` / `[]`). The importer's `_upsertSeries` strips empty
 * values, so returning null guarantees a transient site hiccup can
 * never overwrite admin-edited metadata with blanks.
 * ============================================================
 */
(function (global) {
  'use strict';
  if (!global.SourceMadaraScans) {
    console.error('[MadaraScans:Series] base plugin not found — load source-madarascans.js first');
    return;
  }
  const base = global.SourceMadaraScans;

  const SERIES_PATTERN = /^https?:\/\/(www\.)?madarascans\.com\/series\/[^/?#]+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') === 'madarascans.com' &&
             SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/series\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  async function fetchSeriesPage(url) {
    console.info('[MadaraScans:Series] Fetching series page', { url });
    return global.SourceConfig.fetchPage(url, {
      validator: (h) => {
        if (base.isCloudflareChallenge && base.isCloudflareChallenge(h)) {
          console.error('[MadaraScans:Series] Cloudflare verification page returned', { url });
          return false;
        }
        const ok = /lh-title|legendary-hero|ch-item|chapters-list-container|wp-theme-mangareader|class="post-title"|summary_image|entry-title|manga-title-badges/i.test(h);
        if (!ok) console.warn('[MadaraScans:Series] Series HTML missing known metadata/chapter markers', { url, length: String(h || '').length });
        return ok;
      }
    });
  }

  // ---------- field extractors (each returns string|null) ----------
  function firstText(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const t = el?.textContent?.replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    return null;
  }
  function firstAttr(doc, selectors, attr) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const v = el?.getAttribute(attr);
      if (v && v.trim()) return v.trim();
    }
    return null;
  }
  function allText(doc, selectors) {
    for (const sel of selectors) {
      const els = [...doc.querySelectorAll(sel)];
      const arr = els.map(e => (e.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (arr.length) return arr;
    }
    return [];
  }
  // Madara theme exposes labelled rows like:
  //   <div class="post-content_item"><h5>Author(s)</h5><div class="summary-content"><a>...</a></div></div>
  // Pull the value cell by matching the label text.
  function labelledValue(doc, labels) {
    const rows = [...doc.querySelectorAll('.post-content_item, .imptdt, .fmed, .tsinfo .imptdt, .post-content .summary-heading')];
    const wantedRe = new RegExp('\\b(' + labels.join('|') + ')\\b', 'i');
    for (const row of rows) {
      const label = (row.querySelector('h5, .summary-heading h5, i')?.textContent || row.textContent || '').trim();
      if (!wantedRe.test(label)) continue;
      const val = row.querySelector('.summary-content, .summary_content, a, i + *');
      const t = (val?.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t;
    }
    // Fallback: scan any element whose text starts with the label.
    const all = [...doc.querySelectorAll('div, span, li, td')];
    for (const el of all) {
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt) continue;
      const m = txt.match(new RegExp('^(?:' + labels.join('|') + ')\\s*[:\\-]\\s*(.+)$', 'i'));
      if (m && m[1] && m[1].length < 80) return m[1].trim();
    }
    return null;
  }
  function htmlToText(el) {
    if (!el) return null;
    // Drop scripts/styles/ads
    el.querySelectorAll('script, style, .ads, .adsbygoogle').forEach(n => n.remove());
    const t = (el.textContent || '').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
    return t || null;
  }
  function stripWpSize(u) {
    return (u || '').replace(/-\d+x\d+(\.(?:webp|jpg|jpeg|png|avif))(\?.*)?$/i, '$1$2');
  }
  function firstImageFrom(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      if (!el) continue;
      const direct = el.getAttribute('data-src') || el.getAttribute('data-lazy-src') || el.getAttribute('data-original') || el.getAttribute('src') || el.getAttribute('content');
      if (direct && direct.trim()) return direct.trim();
      const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset') || '';
      const first = srcset.split(',')[0]?.trim().split(/\s+/)[0];
      if (first) return first;
    }
    return null;
  }
  function absolutize(href) {
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/'))  return 'https://madarascans.com' + href;
    return 'https://madarascans.com/' + href;
  }
  function prettifySlug(slug) {
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
  }

  base.getSeriesInfo = async function (url) {
    const html = await fetchSeriesPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // ----- Title -----
    const title =
      firstText(doc, [
        'h1.lh-title',
        '.post-title h1',
        '.post-title h3',
        'h1.entry-title',
        '.summary_content h1',
        '.summary_content .post-title',
        'h1'
      ]) ||
      (doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.split('|')[0].trim()) ||
      prettifySlug(base.getSeriesSlug(url));

    // ----- Cover -----
    let cover =
      firstImageFrom(doc, [
        '.lh-poster img',
        '.summary_image img',
        '.thumb img',
        'img.wp-post-image',
        '.tab-summary img',
        'meta[property="og:image"]',
        'meta[name="twitter:image"]'
      ]) || '';
    cover = stripWpSize(absolutize(cover));
    if (cover) {
      // MadaraScans serves images behind Cloudflare with referrer/hotlink
      // protection — direct <img src="https://madarascans.com/...">
      // returns 403/blank in other origins. Wrap through the same wsrv.nl
      // image proxy the chapter pages use so the cover actually renders
      // during Preview, in Manage Series, and on the public series page.
      cover = base.toProxiedImageUrl ? base.toProxiedImageUrl(cover) : cover;
    } else {
      cover = null;
      console.warn('[MadaraScans:Series] Cover image not found', { url });
    }

    let banner = firstImageFrom(doc, [
      '.lh-backdrop-img',
      '.hero-bg img',
      '.manga-banner img',
      '.series-banner img',
      'meta[property="og:image"]'
    ]);
    banner = stripWpSize(absolutize(banner));
    if (banner && banner !== cover && base.toProxiedImageUrl) banner = base.toProxiedImageUrl(banner);
    if (!banner || banner === cover) banner = null;

    // ----- Description / synopsis -----
    let description = null;
    const descCandidates = [
      '#manga-story',
      '.description-summary .summary__content',
      '.summary__content',
      '.summary_content .post-content_item .summary-content',
      '.manga-excerpt',
      '.entry-content',
      'div[itemprop="description"]'
    ];
    for (const sel of descCandidates) {
      const el = doc.querySelector(sel);
      const t = htmlToText(el);
      if (t && t.length > 20) { description = t; break; }
    }
    if (!description) {
      const meta = doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
                   doc.querySelector('meta[property="og:description"]')?.getAttribute('content');
      if (meta && meta.trim().length > 20) description = meta.trim();
    }

    // ----- Status -----
    let statusRaw =
      firstText(doc, [
        '.status-badge-lux',
        '.lh-meta-item.status-badge-lux',
        '.post-status .summary-content',
        '.tsinfo .imptdt i'
      ]) ||
      labelledValue(doc, ['Status']);
    let status = null;
    if (statusRaw) {
      const m = statusRaw.toLowerCase().match(/ongoing|completed|complete|hiatus|dropped|on\s*hold|cancelled/);
      if (m) {
        status = m[0].replace(/\s+/g, '');
        if (status === 'complete') status = 'completed';
        if (status === 'onhold') status = 'hiatus';
      } else if (/mass\s*released|released|publishing|active/i.test(statusRaw)) {
        status = 'ongoing';
      } else {
        status = statusRaw.toLowerCase();
      }
    }

    // ----- Genres -----
    let genres = allText(doc, [
      '.lh-genres a.lh-genre-tag',
      '.genres-content a',
      '.mgen a',
      '.wd-full .genres-content a',
      '.gnr a',
      'a[rel="tag"]'
    ]);
    // Dedupe and normalise capitalisation
    if (genres.length) {
      const seen = new Set();
      genres = genres.filter(g => {
        const k = g.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k); return true;
      });
    }
    if (!genres.length) genres = null;

    // ----- Author / Artist -----
    let author =
      firstText(doc, ['.author-content a', '.author-content']) ||
      labelledValue(doc, ['Author', 'Author\\(s\\)']) ||
      doc.querySelector('meta[name="author"]')?.getAttribute('content') ||
      null;
    let artist =
      firstText(doc, ['.artist-content a', '.artist-content']) ||
      labelledValue(doc, ['Artist', 'Artist\\(s\\)']) ||
      null;

    // ----- Release year -----
    let releaseYear = null;
    const yearRaw =
      labelledValue(doc, ['Released', 'Release', 'Year']) ||
      firstText(doc, ['.imptdt-year', '.post-content_item .summary-content[itemprop="datePublished"]']);
    if (yearRaw) {
      const ym = String(yearRaw).match(/(19|20)\d{2}/);
      if (ym) releaseYear = parseInt(ym[0], 10);
    }

    // ----- Alternative titles -----
    let altRaw =
      firstText(doc, ['.lh-alt-title']) ||
      (function () {
        // Madara theme: <div class="post-content_item"><h5>Alternative</h5><div class="summary-content">...</div></div>
        // :contains() / :has(:contains()) are jQuery extensions, not valid CSS — walk the rows manually.
        const rows = doc.querySelectorAll('.post-content_item');
        for (const row of rows) {
          const label = (row.querySelector('h5')?.textContent || '').trim();
          if (/^(Alternative|Alt(ernative)? Names?|Other Names?)\b/i.test(label)) {
            const val = row.querySelector('.summary-content, .summary_content');
            const t = (val?.textContent || '').replace(/\s+/g, ' ').trim();
            if (t) return t;
          }
        }
        return null;
      })() ||
      labelledValue(doc, ['Alternative', 'Alt Name', 'Alternative Names', 'Other Names']);
    const alternativeTitles = altRaw
      ? altRaw.split(/[;,/|]/).map(s => s.trim()).filter(Boolean)
      : [];

    return {
      title,
      cover: cover || undefined,
      banner: banner || undefined,
      description: description || undefined,
      author: author || undefined,
      artist: artist || undefined,
      status: status || undefined,
      genres: genres || undefined,
      releaseYear: releaseYear || undefined,
      alternativeTitles,
      slug: base.getSeriesSlug(url),
      sourceUrl: url
    };
  };

  base.getChapterList = async function (url) {
    const html = await fetchSeriesPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const map = new Map(); // number -> { number, title, url }

    // Layout A: structured items on the series page (legendary-hero theme).
    doc.querySelectorAll('.ch-item[data-ch]').forEach(item => {
      const raw = (item.getAttribute('data-ch') || '').trim();
      const numMatch = raw.match(/(\d+(?:\.\d+)?)/);
      if (!numMatch) return;
      const number = parseFloat(numMatch[1]);
      const link = item.querySelector('a.ch-main-anchor[href], a[href*="-chapter-"]');
      const href = link?.getAttribute('href');
      if (!href || !Number.isFinite(number)) return;
      if (!map.has(number)) {
        map.set(number, {
          number,
          title: `Chapter ${raw || number}`,
          url: absolutize(href)
        });
      }
    });

    // Layout B: generic Madara chapter list (li.wp-manga-chapter > a)
    if (map.size === 0) {
      doc.querySelectorAll('li.wp-manga-chapter a[href*="-chapter-"], .listing-chapters_wrap a[href*="-chapter-"]').forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/-chapter-(\d+)(?:-(\d+))?(?:-\d+)?\/?$/i);
        if (!m) return;
        const number = m[2] ? parseFloat(`${m[1]}.${m[2]}`) : parseFloat(m[1]);
        if (!Number.isFinite(number) || map.has(number)) return;
        map.set(number, { number, title: `Chapter ${number}`, url: absolutize(href) });
      });
    }

    // Layout C: regex sweep over the raw HTML (handles client-rendered lists).
    if (map.size === 0) {
      const slug = base.getSeriesSlug(url);
      const re = new RegExp(
        `https?:\\/\\/(?:www\\.)?madarascans\\.com\\/${escapeRe(slug)}[a-z0-9-]*-chapter-(\\d+)(?:-(\\d+))?(?:-\\d+)?\\/`,
        'gi'
      );
      let m;
      while ((m = re.exec(html)) !== null) {
        const number = m[2] ? parseFloat(`${m[1]}.${m[2]}`) : parseFloat(m[1]);
        if (!Number.isFinite(number)) continue;
        if (!map.has(number)) {
          map.set(number, { number, title: `Chapter ${number}`, url: m[0] });
        }
      }
    }

    const list = [...map.values()].sort((a, b) => a.number - b.number);
    if (list.length === 0) {
      console.error('[MadaraScans:Series] No chapters found', { url });
      throw new Error('No chapters found on MadaraScans series page');
    }
    console.info('[MadaraScans:Series] Chapter list extracted', { url, count: list.length });
    return list;
  };

  base.checkUpdates = async function (seriesDoc) {
    const list = await base.getChapterList(seriesDoc.sourceUrl);
    const last = Number(seriesDoc.lastImportedChapter || 0);
    return list.filter(c => c.number > last);
  };

  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
})(window);
