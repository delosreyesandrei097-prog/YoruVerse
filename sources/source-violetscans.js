/**
 * ============================================================
 * MANHWA PLATFORM - VIOLET SCANS SOURCE PLUGIN
 * ============================================================
 * Site: https://violetscans.org   (WordPress + Madara theme)
 *
 * Series  URL: https://violetscans.org/comics/<slug>/
 * Chapter URL: https://violetscans.org/<slug>-chapter-<num>(-<sub>)?/
 *
 * Images: <img class="wp-manga-chapter-img" src="...">
 *         hosted under /wp-content/uploads/.../
 *
 * Decimal chapters use a trailing -N segment (chapter-12-5 -> 12.5).
 * Prologue / Side-story / Epilogue chapters use names like
 *   "prologue", "side-story-1", "extra-1", "epilogue" — for these we
 * derive a synthetic ordering number (0 for prologue, 0.x for extras,
 * 999+ for epilogue) so they sort sensibly alongside numbered chapters.
 * ============================================================
 */

const SourceVioletScans = {
  name: 'VioletScans',
  domain: 'violetscans.org',

  patterns: [
    // chapter-N or chapter-N-M or named chapters (prologue, side-story-1, etc.)
    /^https?:\/\/(www\.)?violetscans\.org\/[^/]+-chapter-[\w.-]+\/?(?:[?#].*)?$/i,
    /^https?:\/\/(www\.)?violetscans\.org\/[^/]+-(?:prologue|epilogue|side-story|extra|special)(?:-\d+(?:-\d+)?)?\/?(?:[?#].*)?$/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./, '') !== 'violetscans.org') return false;
      // Series page at /comics/<slug>/ — exclude from chapter detector.
      if (/^\/comics\/[^/]+\/?$/i.test(u.pathname)) return false;
      return this.patterns.some(p => p.test(url));
    } catch { return false; }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (h) => /wp-manga-chapter-img|reading-content|wp-content\/uploads|chapter-heading|entry-content/i.test(h)
    });
  },

  async extract(url) {
    const html = await this.fetchPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const data = {
      chapterTitle: this.extractTitle(doc, url),
      chapterNumber: this.extractChapterNumber(url, html),
      imageUrls: this.extractImageUrls(doc, html),
      seriesTitle: this.extractSeriesTitle(doc, url),
      source: this.name,
      sourceUrl: url
    };

    if (!this.validate(data)) {
      throw new Error('Could not extract valid VioletScans chapter data.');
    }
    return data;
  },

  extractChapterNumber(url, html = '') {
    // Decimal via dash: chapter-12-5 -> 12.5
    const m1 = url.match(/-chapter-(\d+)(?:-(\d+))?\/?(?:[?#]|$)/i);
    if (m1) return m1[2] ? parseFloat(`${m1[1]}.${m1[2]}`) : parseFloat(m1[1]);

    // Named: prologue -> 0; epilogue -> 9999; extra-N / side-story-N -> 0.N
    if (/-prologue\/?(?:[?#]|$)/i.test(url)) return 0;
    if (/-epilogue\/?(?:[?#]|$)/i.test(url)) return 9999;
    const m2 = url.match(/-(side-story|extra|special)-(\d+)(?:-(\d+))?/i);
    if (m2) {
      const n = m2[3] ? parseFloat(`${m2[2]}.${m2[3]}`) : parseFloat(m2[2]);
      return 0.001 + n / 1000;
    }

    const fromHeading = html.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
    if (fromHeading) return parseFloat(fromHeading[1]);
    return null;
  },

  extractTitle(doc, url) {
    const h = doc.querySelector('#chapter-heading, .entry-title')?.textContent?.trim();
    if (h) return h.replace(/\s+/g, ' ');
    const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (og) return og.split('|')[0].trim();
    const num = this.extractChapterNumber(url);
    return num != null ? `Chapter ${num}` : null;
  },

  extractSeriesTitle(doc, url) {
    const head = doc.querySelector('#chapter-heading')?.textContent || '';
    const m = head.match(/^(.*?)\s*[-–—]\s*Chapter/i);
    if (m) return m[1].trim();
    const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (og) return og.split(/[-–—|]/)[0].trim();
    return null;
  },

  extractImageUrls(doc, html) {
    const seen = new Set();
    const out = [];
    const add = (src) => {
      if (!src) return;
      const clean = src.trim()
        .replace(/&amp;/g, '&')
        .replace(/\\\//g, '/')
        .replace(/&quot;/g, '"');
      if (!/\.(?:webp|jpg|jpeg|png|avif)(?:\?[^"'<>\s]*)?$/i.test(clean)) return;
      if (/-\d+x\d+\.(?:webp|jpg|jpeg|png|avif)/i.test(clean)) return;
      if (!/\/wp-content\/uploads\//i.test(clean)) return;
      if (seen.has(clean)) return;
      seen.add(clean);
      out.push(clean);
    };

    // DOM order is canonical reading order for Madara reader.
    const imgs = [...doc.querySelectorAll(
      '.reading-content img.wp-manga-chapter-img, ' +
      '.reading-content .page-break img, ' +
      'img.wp-manga-chapter-img, ' +
      '.entry-content img'
    )];
    imgs.sort((a, b) => {
      const ia = parseInt(a.getAttribute('id')?.replace(/\D+/g, '') || '0', 10);
      const ib = parseInt(b.getAttribute('id')?.replace(/\D+/g, '') || '0', 10);
      return ia - ib;
    });
    for (const img of imgs) {
      add(img.getAttribute('src') ||
          img.getAttribute('data-src') ||
          img.getAttribute('data-lazy-src') ||
          img.getAttribute('data-original'));
    }
    if (out.length) return out;

    const re = /https?:\/\/(?:www\.)?violetscans\.org\/wp-content\/uploads\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png|avif)/gi;
    (html.match(re) || []).forEach(add);
    return out;
  },

  validate(data) {
    if (!data.imageUrls || data.imageUrls.length === 0) {
      console.error(`[${this.name}] No images extracted`);
      return false;
    }
    if (data.chapterNumber == null) data.chapterNumber = 1;
    if (!data.chapterTitle) data.chapterTitle = `Chapter ${data.chapterNumber}`;
    return true;
  }
};

// ============= Series-level capabilities =============
(function (base) {
  const SERIES_PATTERN = /^https?:\/\/(www\.)?violetscans\.org\/comics\/[^/?#]+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;
  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') === 'violetscans.org' && SERIES_PATTERN.test(url);
    } catch { return false; }
  };
  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/comics\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  async function fetchSeriesPage(url) {
    return window.SourceConfig.fetchPage(url, {
      validator: (h) => /summary_image|listing-chapters|wp-manga-chapter|post-title|entry-title|wp-theme-madara|\/comics\//i.test(h)
    });
  }

  function absolutize(href) {
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/'))  return 'https://violetscans.org' + href;
    return 'https://violetscans.org/' + href;
  }
  function stripWpSize(u) {
    return (u || '').replace(/-\d+x\d+(\.(?:webp|jpg|jpeg|png|avif))(\?.*)?$/i, '$1$2');
  }
  function prettifySlug(s) {
    return s ? s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  base.getSeriesInfo = async function (url) {
    const html = await fetchSeriesPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const title =
      doc.querySelector('.post-title h1, .post-title h3, h1.entry-title')?.textContent?.trim() ||
      doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.split('|')[0].trim() ||
      prettifySlug(base.getSeriesSlug(url));

    let cover = doc.querySelector('.summary_image img, .tab-summary img')?.getAttribute('data-src')
             || doc.querySelector('.summary_image img, .tab-summary img')?.getAttribute('src')
             || doc.querySelector('meta[property="og:image"]')?.getAttribute('content')
             || '';
    cover = stripWpSize(absolutize(cover)) || null;

    const description =
      doc.querySelector('.summary__content, .description-summary .summary__content, .manga-excerpt, div[itemprop="description"]')
        ?.textContent?.trim() ||
      doc.querySelector('meta[name="description"]')?.getAttribute('content') ||
      '';

    const meta = {};
    doc.querySelectorAll('.post-content_item').forEach(row => {
      const head = (row.querySelector('.summary-heading')?.textContent || '').toLowerCase()
        .replace(/[():]/g, '').replace(/\(s\)/g, '').trim();
      const body = row.querySelector('.summary-content');
      if (!head || !body) return;
      const links = [...body.querySelectorAll('a')].map(a => a.textContent.trim()).filter(Boolean);
      meta[head] = links.length ? links.join(', ') : body.textContent.replace(/\s+/g, ' ').trim();
    });

    const statusRaw = (meta.status || '').toLowerCase();
    let status = null;
    if (statusRaw) {
      const m = statusRaw.match(/ongoing|completed|complete|hiatus|dropped|cancelled/);
      status = m ? (m[0] === 'complete' ? 'completed' : m[0]) : 'ongoing';
    }
    const genres = (meta.genres || meta.genre || '').split(/[,;|]/).map(s => s.trim()).filter(Boolean);
    const alt = (meta.alternative || meta['alt names'] || meta['alternative names'] || '')
                .split(/[,;|]/).map(s => s.trim()).filter(Boolean);

    return {
      title,
      cover: cover || undefined,
      description: description || undefined,
      author: meta.author || meta.authors || undefined,
      artist: meta.artist || meta.artists || undefined,
      status: status || undefined,
      genres: genres.length ? genres : undefined,
      alternativeTitles: alt,
      slug: base.getSeriesSlug(url),
      sourceUrl: url
    };
  };

  base.getChapterList = async function (url) {
    let html = await fetchSeriesPage(url);
    // Madara ajax endpoint
    try {
      const ajax = await window.SourceConfig.fetchPage(url.replace(/\/?$/, '/') + 'ajax/chapters/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        validator: (h) => /chapter-\d|wp-manga-chapter/i.test(h)
      });
      if (ajax) html += '\n' + ajax;
    } catch {}

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const slug = base.getSeriesSlug(url);
    const map = new Map();

    const addHref = (href, text) => {
      if (!href) return;
      // Numeric: <slug>-chapter-N(-M)
      const m = href.match(new RegExp(
        `\\/${escapeRe(slug)}-chapter-(\\d+)(?:-(\\d+))?\\/?(?:[?#]|$)`,
        'i'
      ));
      if (m) {
        const number = m[2] ? parseFloat(`${m[1]}.${m[2]}`) : parseFloat(m[1]);
        if (!Number.isFinite(number) || map.has(number)) return;
        map.set(number, { number, title: (text || `Chapter ${number}`).trim(), url: absolutize(href) });
        return;
      }
      // Named chapters
      const named = href.match(new RegExp(
        `\\/${escapeRe(slug)}-(prologue|epilogue|side-story|extra|special)(?:-(\\d+)(?:-(\\d+))?)?\\/?(?:[?#]|$)`,
        'i'
      ));
      if (named) {
        const kind = named[1].toLowerCase();
        const n = named[2] ? (named[3] ? parseFloat(`${named[2]}.${named[3]}`) : parseFloat(named[2])) : 0;
        let number;
        if (kind === 'prologue') number = 0;
        else if (kind === 'epilogue') number = 9999 + n / 1000;
        else number = 0.001 + n / 1000;
        if (map.has(number)) return;
        const label = (text || '').trim() || `${kind.replace(/-/g, ' ')}${named[2] ? ' ' + named[2] : ''}`;
        map.set(number, { number, title: label, url: absolutize(href) });
      }
    };

    doc.querySelectorAll('a[href*="violetscans.org"], li.wp-manga-chapter a, .listing-chapters_wrap a').forEach(a => {
      addHref(a.getAttribute('href') || '', a.textContent || '');
    });

    const sweep = new RegExp(
      `https?:\\/\\/(?:www\\.)?violetscans\\.org\\/${escapeRe(slug)}-(?:chapter-\\d+(?:-\\d+)?|prologue|epilogue|side-story-\\d+(?:-\\d+)?|extra-\\d+(?:-\\d+)?|special-\\d+(?:-\\d+)?)\\/?`,
      'gi'
    );
    let m;
    while ((m = sweep.exec(html)) !== null) addHref(m[0], '');

    const list = [...map.values()].sort((a, b) => a.number - b.number);
    if (list.length === 0) throw new Error('No chapters found on VioletScans series page');
    return list;
  };

  base.checkUpdates = async function (seriesDoc) {
    const list = await base.getChapterList(seriesDoc.sourceUrl);
    const last = Number(seriesDoc.lastImportedChapter || 0);
    const have = new Set(
      Array.isArray(seriesDoc.existingChapterNumbers)
        ? seriesDoc.existingChapterNumbers.map(Number)
        : []
    );
    return list.filter(c => Number.isFinite(c.number) && c.number > last && !have.has(Number(c.number)));
  };
})(SourceVioletScans);

window.SourceVioletScans = SourceVioletScans;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceVioletScans);
}
