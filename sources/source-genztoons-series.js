/**
 * ============================================================
 * GENZ TOONS - SERIES EXTENSION
 * ============================================================
 * Adds series-level capabilities to SourceGenZToons.
 * Load AFTER source-genztoons.js.
 *
 * Series URL pattern: https://genztoons.org/series/<slug>
 *                     https://genztoons.org/manga/<slug>
 * ============================================================
 */
(function (global) {
  'use strict';
  if (!global.SourceGenZToons) {
    console.error('[GenZToons:Series] base plugin not found — load source-genztoons.js first');
    return;
  }
  const base = global.SourceGenZToons;

  const SERIES_PATTERN = /^https?:\/\/(?:www\.)?genztoons\.org\/(?:series|manga|read)\/[^/]+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('genztoons.org') && SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/(?:series|manga|read)\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  base.getSeriesInfo = async function (url) {
    const html = await global.SourceConfig.fetchPage(url, {
      validator: (h) => /genztoons|post-title|summary_image|wp-manga|og:title/i.test(h)
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const title = textOf(doc, '.post-title h1, .post-title h3, h1.entry-title') ||
                  ogContent(doc, 'og:title') ||
                  prettifySlug(base.getSeriesSlug(url));

    let cover = attrOf(doc, '.summary_image img, .tab-summary img, .series-cover img', 'src') ||
                attrOf(doc, '.summary_image img', 'data-src') ||
                ogContent(doc, 'og:image') || '';
    if (cover && cover.startsWith('//')) cover = 'https:' + cover;

    const description = textOf(doc, '.summary__content, .description-summary .summary__content, .manga-summary, .entry-content') ||
                        metaContent(doc, 'description') || '';

    const author = collectText(doc, '.author-content a, .manga-authors a') ||
                   collectText(doc, '.post-content_item:has(.summary-heading:contains("Author")) .summary-content') || '';
    const artist = collectText(doc, '.artist-content a, .manga-artists a') || author;

    const statusRaw = textOf(doc, '.post-status .summary-content, .post-content_item .summary-content') || '';
    const status = normalizeStatus(statusRaw);

    const genres = Array.from(doc.querySelectorAll('.genres-content a, .wp-manga-genre a, .genre a'))
      .map(a => a.textContent.trim()).filter(Boolean);

    const altRaw = textOf(doc, '.summary-content:has(+ .summary-heading), .post-content_item:nth-child(2) .summary-content') || '';
    const alt = altRaw ? altRaw.split(/[,;|]/).map(s => s.trim()).filter(Boolean) : [];

    return {
      title, cover, banner: '',
      description: stripHtml(description),
      author, artist, status,
      genres, alternativeTitles: alt,
      slug: base.getSeriesSlug(url),
      sourceUrl: url
    };
  };

  base.getChapterList = async function (url) {
    const html = await global.SourceConfig.fetchPage(url, {
      validator: (h) => /chapter|\/chapter\/|cdn\.meowing\.org|id="chapters"|wp-manga-chapter|listing-chapters/i.test(h)
    });
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const slug = base.getSeriesSlug(url);
    const origin = 'https://genztoons.org';
    const seen = new Map();

    const addChapter = (href, num, title) => {
      if (!href || !Number.isFinite(num) || seen.has(num)) return;
      const abs = href.startsWith('http') ? href : (origin + (href.startsWith('/') ? href : '/' + href));
      seen.set(num, { number: num, title: (title || `Chapter ${num}`).trim(), url: abs });
    };

    // Current GenZ Toons layout (Alpine.js): chapters live inside
    // <div id="chapters"> as <a href="https://genztoons.org/chapter/<id>/"
    // alt="Chapter N" title="Chapter N">. The URL no longer contains the
    // chapter number, so derive the number from alt/title/text instead.
    doc.querySelectorAll('#chapters a[href*="/chapter/"], a[href*="/chapter/"][title*="Chapter"], a[href*="/chapter/"][alt*="Chapter"]').forEach(a => {
      const href = a.getAttribute('href') || '';
      if (!href || !/\/chapter\//i.test(href)) return;
      const label = a.getAttribute('alt') || a.getAttribute('title') || a.textContent || '';
      const m = label.match(/chapter\s+(\d+(?:\.\d+)?)/i) ||
                href.match(/chapter[-_/](\d+(?:[.-]\d+)?)/i);
      if (!m) return;
      const num = parseFloat(String(m[1]).replace('-', '.'));
      addChapter(href, num, `Chapter ${num}`);
    });

    // Legacy Madara/WP layout fallback.
    if (seen.size === 0) {
      doc.querySelectorAll('.wp-manga-chapter a, .listing-chapters_wrap a, .chapter-link a, a.chapter-item').forEach(a => {
        const href = a.getAttribute('href') || '';
        const m = href.match(/chapter[-_/](\d+(?:[.-]\d+)?)/i);
        if (!m) return;
        const num = parseFloat(String(m[1]).replace('-', '.'));
        addChapter(href, num, (a.textContent || '').trim());
      });
    }

    // Raw HTML fallback for the new layout — scan every chapter href +
    // its surrounding `alt="Chapter N"` / `title="Chapter N"`.
    if (seen.size === 0) {
      const re = /<a[^>]+href="(https?:\/\/(?:www\.)?genztoons\.org\/chapter\/[^"]+)"[^>]*?(?:alt|title)="\s*Chapter\s+(\d+(?:\.\d+)?)/gi;
      let m;
      while ((m = re.exec(html)) !== null) {
        const num = parseFloat(m[2]);
        addChapter(m[1], num, `Chapter ${num}`);
      }
    }

    // Final fallback: legacy /series/<slug>/chapter-N style URLs.
    if (seen.size === 0 && slug) {
      const re = new RegExp(`https?://[^"'<>\\s]*genztoons\\.org/[^"'<>\\s]*${escapeRe(slug)}[^"'<>\\s]*chapter[-_/](\\d+(?:[.-]\\d+)?)`, 'gi');
      let m;
      while ((m = re.exec(html)) !== null) {
        const num = parseFloat(String(m[1]).replace('-', '.'));
        addChapter(m[0], num, `Chapter ${num}`);
      }
    }

    const list = [...seen.values()].sort((a, b) => a.number - b.number);
    if (list.length === 0) throw new Error('No chapters found on GenZ Toons series page');
    return list;
  };

  base.checkUpdates = async function (seriesDoc) {
    const list = await base.getChapterList(seriesDoc.sourceUrl);
    const last = Number(seriesDoc.lastImportedChapter || 0);
    return list.filter(c => c.number > last);
  };

  // ---- helpers ----
  function textOf(doc, sel) { try { const el = doc.querySelector(sel); return el ? el.textContent.trim() : ''; } catch { return ''; } }
  function attrOf(doc, sel, attr) { try { const el = doc.querySelector(sel); return el ? (el.getAttribute(attr) || '').trim() : ''; } catch { return ''; } }
  function ogContent(doc, prop) { const m = doc.querySelector(`meta[property="${prop}"]`); return m?.content || ''; }
  function metaContent(doc, name) { const m = doc.querySelector(`meta[name="${name}"]`); return m?.content || ''; }
  function collectText(doc, sel) {
    try { return Array.from(doc.querySelectorAll(sel)).map(n => n.textContent.trim()).filter(Boolean).join(', '); }
    catch { return ''; }
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
