/**
 * ============================================================
 * MANHWA PLATFORM - KING OF SHOJO SOURCE PLUGIN  (FIXED)
 * ============================================================
 * Site: https://kingofshojo.com   (custom WordPress theme)
 *
 * Series  URL: https://kingofshojo.com/manga/<slug>/
 * Chapter URL: https://kingofshojo.com/<slug>-chapter-<num>(-<sub>)?/
 *              e.g.  /predatory-marriage-chapter-80/
 *                    /predatory-marriage-chapter-0-5/  (= 0.5)
 *                    /predatory-marriage-chapter-prologue/
 *
 * Chapter images: served from cdn.kingofshojo.com/king-bucket/<id>/<n>/<i>.jpg
 * (also some series use /wp-content/uploads/... or i.ibb.co fallbacks).
 * ============================================================
 */

const SourceKingOfShojo = {
  name: 'KingOfShojo',
  domain: 'kingofshojo.com',

  patterns: [
    // The flat /<slug>-chapter-<...>/ form used by the live site.
    /^https?:\/\/(www\.)?kingofshojo\.com\/[a-z0-9-]+-chapter-[\w.-]+\/?(?:[?#].*)?$/i,
    // Legacy /manga/<slug>/chapter-<num>/ form (still detected for completeness)
    /^https?:\/\/(www\.)?kingofshojo\.com\/manga\/[^/]+\/(?:chapter-[\w.-]+|prologue|epilogue|side-story(?:-\d+(?:-\d+)?)?|extra(?:-\d+(?:-\d+)?)?|special(?:-\d+(?:-\d+)?)?)\/?(?:[?#].*)?$/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./, '') !== 'kingofshojo.com') return false;
      if (/^\/manga\/[^/]+\/?$/i.test(u.pathname)) return false; // series page
      return this.patterns.some(p => p.test(url));
    } catch { return false; }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (h) => /cdn\.kingofshojo\.com|chapterbody|entry-content|wp-content\/uploads|chapter-heading|kingofshojo/i.test(h)
    });
  },

  async extract(url) {
    const html = await this.fetchPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    if (/class="[^"]*premium-block[^"]*"|premium-content|please log in to read/i.test(html) &&
        !/cdn\.kingofshojo\.com\/king-bucket/i.test(html)) {
      throw new Error('KingOfShojo: this chapter is locked (premium / login required).');
    }

    const data = {
      chapterTitle: this.extractTitle(doc, url),
      chapterNumber: this.extractChapterNumber(url, html),
      imageUrls: this.extractImageUrls(doc, html),
      seriesTitle: this.extractSeriesTitle(doc, url),
      source: this.name,
      sourceUrl: url
    };
    if (!this.validate(data)) throw new Error('Could not extract valid KingOfShojo chapter data.');
    return data;
  },

  // Parse the trailing -chapter-N(-M)? token from either URL shape.
  extractChapterNumber(url, html = '') {
    // Flat: /<slug>-chapter-<n>(-<m>)/
    const flat = url.match(/-chapter-(\d+)(?:-(\d+))?\/?(?:[?#]|$)/i);
    if (flat) return flat[2] ? parseFloat(`${parseInt(flat[1], 10)}.${flat[2]}`) : parseInt(flat[1], 10);
    // Legacy: /manga/<slug>/chapter-<n>(-<m>)/
    const legacy = url.match(/\/chapter-(\d+)(?:-(\d+))?\/?(?:[?#]|$)/i);
    if (legacy) return legacy[2] ? parseFloat(`${parseInt(legacy[1], 10)}.${legacy[2]}`) : parseInt(legacy[1], 10);
    if (/-chapter-prologue|\/prologue\/?(?:[?#]|$)/i.test(url)) return 0;
    if (/-chapter-epilogue|\/epilogue\/?(?:[?#]|$)/i.test(url)) return 9999;
    const named = url.match(/-chapter-(side-story|extra|special)(?:-(\d+)(?:-(\d+))?)?|\/(side-story|extra|special)(?:-(\d+)(?:-(\d+))?)?\/?(?:[?#]|$)/i);
    if (named) {
      const kind = named[1] || named[4];
      const a = named[2] || named[5];
      const b = named[3] || named[6];
      const n = a ? (b ? parseFloat(`${a}.${b}`) : parseFloat(a)) : 0;
      return 0.001 + n / 1000;
    }
    const fromHeading = html.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
    return fromHeading ? parseFloat(fromHeading[1]) : null;
  },

  extractTitle(doc, url) {
    const h = doc.querySelector('#chapter-heading, .entry-title, h1.entry-title')?.textContent?.trim();
    if (h) return h.replace(/\s+/g, ' ');
    const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (og) return og.split('|')[0].trim();
    const num = this.extractChapterNumber(url);
    return num != null ? `Chapter ${num}` : null;
  },

  extractSeriesTitle(doc, url) {
    const h = doc.querySelector('#chapter-heading, .entry-title')?.textContent || '';
    const m = h.match(/^(.*?)\s*[-–—]\s*Chapter/i);
    if (m) return m[1].trim();
    // From flat URL: /<series-slug>-chapter-<n>/
    const flat = url.match(/kingofshojo\.com\/([a-z0-9-]+?)-chapter-/i);
    if (flat) return flat[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const legacy = (url.match(/\/manga\/([^/]+)/i) || [])[1] || '';
    return legacy ? legacy.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;
  },

  extractImageUrls(doc, html) {
    const seen = new Set();
    const out = [];
    const add = (raw) => {
      if (!raw) return;
      const clean = String(raw).trim()
        .replace(/&amp;/g, '&').replace(/\\\//g, '/').replace(/&quot;/g, '"');
      if (!/\.(?:webp|jpg|jpeg|png|avif)(?:\?[^"'<>\s]*)?$/i.test(clean)) return;
      if (/-\d+x\d+\.(?:webp|jpg|jpeg|png|avif)/i.test(clean)) return; // thumbnails
      if (seen.has(clean)) return;
      seen.add(clean); out.push(clean);
    };

    // 1) Primary: CDN bucket images (sequential pages).
    const cdnRe = /https?:\/\/cdn\.kingofshojo\.com\/king-bucket\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png|avif)(?:\?[^"'<>\s]*)?/gi;
    const cdnMatches = html.match(cdnRe) || [];
    cdnMatches.forEach(add);

    if (out.length) {
      // Sort by trailing /<index>.ext within /king-bucket/<id>/<chap>/
      out.sort((a, b) => {
        const na = parseInt((a.match(/\/(\d+)\.(?:webp|jpg|jpeg|png|avif)(?:\?|$)/i) || [])[1] || '0', 10);
        const nb = parseInt((b.match(/\/(\d+)\.(?:webp|jpg|jpeg|png|avif)(?:\?|$)/i) || [])[1] || '0', 10);
        return na - nb;
      });
      return out;
    }

    // 2) Fallback: <img> tags inside the reading area, DOM order.
    const imgs = [...doc.querySelectorAll(
      '.chapterbody img, .reading-content img, .entry-content img, img.wp-manga-chapter-img'
    )];
    for (const img of imgs) {
      add(img.getAttribute('src') || img.getAttribute('data-src') ||
          img.getAttribute('data-lazy-src') || img.getAttribute('data-original'));
    }
    if (out.length) return out;

    // 3) Last resort: any kingofshojo.com /wp-content/uploads/ image.
    const re = /https?:\/\/(?:www\.|cdn\.)?kingofshojo\.com\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png|avif)/gi;
    (html.match(re) || []).forEach(add);
    return out;
  },

  validate(data) {
    if (!data.imageUrls || !data.imageUrls.length) return false;
    if (data.chapterNumber == null) data.chapterNumber = 1;
    if (!data.chapterTitle) data.chapterTitle = `Chapter ${data.chapterNumber}`;
    return true;
  }
};

// ============= Series capabilities =============
(function (base) {
  const SERIES_PATTERN = /^https?:\/\/(www\.)?kingofshojo\.com\/manga\/[^/?#]+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;
  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') === 'kingofshojo.com' && SERIES_PATTERN.test(url);
    } catch { return false; }
  };
  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/manga\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  async function fetchSeriesPage(url) {
    return window.SourceConfig.fetchPage(url, {
      validator: (h) => /summary_image|listing-chapters|post-title|wp-theme|kingofshojo|chapter-\d/i.test(h)
    });
  }
  function absolutize(href) {
    if (!href) return '';
    if (/^https?:\/\//i.test(href)) return href;
    if (href.startsWith('//')) return 'https:' + href;
    if (href.startsWith('/')) return 'https://kingofshojo.com' + href;
    return 'https://kingofshojo.com/' + href;
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function stripWpSize(u) {
    return (u || '').replace(/-\d+x\d+(\.(?:webp|jpg|jpeg|png|avif))(\?.*)?$/i, '$1$2');
  }
  function prettifySlug(s) { return s ? s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled'; }

  base.getSeriesInfo = async function (url) {
    const html = await fetchSeriesPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // KingOfShojo runs a Themesia/MangaStream-style theme:
    //   <h1 class="entry-title">, .thumb img (cover), .bigbanner (banner),
    //   .entry-content[itemprop=description], and an info <table> with
    //   <td>Label</td><td>Value</td> rows (Alternative / Status / Author /
    //   Artist / Released / Type). Genre links point to /genres/<g>.
    const title =
      doc.querySelector('h1.entry-title, .seriestuhead h1, .post-title h1')?.textContent?.trim() ||
      cleanOgTitle(doc.querySelector('meta[property="og:title"]')?.getAttribute('content')) ||
      prettifySlug(base.getSeriesSlug(url));

    let cover =
      doc.querySelector('.thumb img, .seriestucon img, .summary_image img')?.getAttribute('data-src') ||
      doc.querySelector('.thumb img, .seriestucon img, .summary_image img')?.getAttribute('src') ||
      doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
      '';
    cover = stripWpSize(absolutize(cover)) || null;

    // Banner: .bigbanner background-image url('...')
    let banner = '';
    const bannerEl = doc.querySelector('.bigbanner, .bigcover [style*="background-image"]');
    if (bannerEl) {
      const m = (bannerEl.getAttribute('style') || '').match(/url\(['"]?([^'")]+)['"]?\)/i);
      if (m) banner = absolutize(m[1]);
    }

    const description =
      doc.querySelector('.entry-content[itemprop="description"], .entry-content-single, .summary__content, div[itemprop="description"]')
        ?.textContent?.trim() ||
      doc.querySelector('meta[name="description"]')?.getAttribute('content') || '';

    // Info table rows: <td>Label</td><td>Value</td>
    const meta = {};
    doc.querySelectorAll('table tr, .infotable tr').forEach(tr => {
      const tds = tr.querySelectorAll('td');
      if (tds.length < 2) return;
      const key = (tds[0].textContent || '').toLowerCase().replace(/[():]/g, '').trim();
      const val = (tds[1].textContent || '').replace(/\s+/g, ' ').trim();
      if (key && val) meta[key] = val;
    });
    // Madara-style rows as a secondary source (older layouts)
    doc.querySelectorAll('.post-content_item').forEach(row => {
      const head = (row.querySelector('.summary-heading')?.textContent || '').toLowerCase()
        .replace(/[():]/g, '').replace(/\(s\)/g, '').trim();
      const body = row.querySelector('.summary-content');
      if (!head || !body || meta[head]) return;
      const links = [...body.querySelectorAll('a')].map(a => a.textContent.trim()).filter(Boolean);
      meta[head] = links.length ? links.join(', ') : body.textContent.replace(/\s+/g, ' ').trim();
    });

    const cleanNA = (v) => (v && !/^n\/?a$/i.test(v.trim()) ? v.trim() : '');

    const statusRaw = (meta.status || '').toLowerCase();
    let status = null;
    if (statusRaw) {
      const m = statusRaw.match(/ongoing|completed|complete|hiatus|dropped|cancelled/);
      status = m ? (m[0] === 'complete' ? 'completed' : m[0]) : 'ongoing';
    }

    // Genres: /genres/<g> links anywhere in the series info area
    const genreSet = new Set();
    doc.querySelectorAll('a[href*="/genres/"], a[href*="/genre/"], .mgen a, .seriestugenre a').forEach(a => {
      const t = (a.textContent || '').trim();
      if (t && t.length < 40) genreSet.add(t);
    });
    (meta.genres || meta.genre || '').split(/[,;|]/).forEach(s => { const t = s.trim(); if (t) genreSet.add(t); });
    const genres = [...genreSet];

    const alt = (meta.alternative || meta['alt names'] || meta['alternative names'] || '')
                .split(/[,;|\/]/).map(s => s.trim()).filter(Boolean);

    const releaseYear = (meta.released || '').match(/\d{4}/)?.[0] || null;

    const info = {
      title,
      cover: cover || undefined,
      banner: banner || undefined,
      description: description || undefined,
      author: cleanNA(meta.author || meta.authors || '') || undefined,
      artist: cleanNA(meta.artist || meta.artists || '') || undefined,
      status: status || undefined,
      genres: genres.length ? genres : undefined,
      alternativeTitles: alt,
      releaseYear: releaseYear || undefined,
      slug: base.getSeriesSlug(url),
      sourceUrl: url
    };

    // LAST RESORT: markdown payload (text proxy) — fill the gaps from it.
    if (window.SourceConfig?.isMarkdownPayload?.(html)) {
      const md = window.SourceConfig.parseMarkdownMeta(html);
      if (!info.title || info.title === prettifySlug(base.getSeriesSlug(url))) info.title = md.title || info.title;
      if (!info.cover)       info.cover = md.cover || undefined;
      if (!info.description) info.description = md.description || undefined;
      if (!info.author)      info.author = md.author || undefined;
      if (!info.artist)      info.artist = md.artist || undefined;
      if (!info.genres || !info.genres.length) info.genres = md.genres.length ? md.genres : undefined;
      if (md.status)         info.status = md.status;
      console.info('[KingOfShojo:Series] markdown fallback metadata applied');
    }

    return info;
  };

  function cleanOgTitle(og) {
    if (!og) return '';
    return og
      .split('|')[0]
      .replace(/^Read\s+/i, '')
      .replace(/\s*(?:Manga|Manhwa|Webtoon)?\s*\[[^\]]*\]\s*$/i, '')
      .trim();
  }

  base.getChapterList = async function (url) {
    let html = await fetchSeriesPage(url);

    const slug = base.getSeriesSlug(url);
    const slugRe = escapeRe(slug);

    const parse = (payload) => {
      const map = new Map();

      // PRIMARY pattern observed on the live site (absolute or relative):
      //   https://kingofshojo.com/<series-slug>-chapter-<num>(-<sub>)?/
      const flatRe = new RegExp(
        `(?:https?:\\/\\/(?:www\\.)?kingofshojo\\.com)?\\/${slugRe}-chapter-(\\d+)(?:-(\\d+))?\\/?(?=["'\\s<>)\\]#?]|$)`,
        'gi'
      );
      let m;
      while ((m = flatRe.exec(payload)) !== null) {
        const number = m[2] ? parseFloat(`${parseInt(m[1], 10)}.${m[2]}`) : parseInt(m[1], 10);
        if (!Number.isFinite(number) || map.has(number)) continue;
        const abs = m[0].startsWith('http') ? m[0] : `https://kingofshojo.com${m[0]}`;
        map.set(number, { number, title: `Chapter ${number}`, url: abs.replace(/\/?$/, '/') });
      }

      // Named flat URLs: prologue, epilogue, side-story-N, extra-N, special-N.
      const namedFlatRe = new RegExp(
        `(?:https?:\\/\\/(?:www\\.)?kingofshojo\\.com)?\\/${slugRe}-chapter-(prologue|epilogue|side-story|extra|special)(?:-(\\d+)(?:-(\\d+))?)?\\/?(?=["'\\s<>)\\]#?]|$)`,
        'gi'
      );
      while ((m = namedFlatRe.exec(payload)) !== null) {
        const kind = m[1].toLowerCase();
        const a = m[2]; const b = m[3];
        const n = a ? (b ? parseFloat(`${a}.${b}`) : parseFloat(a)) : 0;
        let number;
        if (kind === 'prologue') number = 0;
        else if (kind === 'epilogue') number = 9999 + n / 1000;
        else number = 0.001 + n / 1000;
        if (map.has(number)) continue;
        const label = `${kind.replace(/-/g, ' ')}${a ? ' ' + a : ''}`.replace(/\b\w/g, c => c.toUpperCase());
        const abs = m[0].startsWith('http') ? m[0] : `https://kingofshojo.com${m[0]}`;
        map.set(number, { number, title: label, url: abs.replace(/\/?$/, '/') });
      }

      // LEGACY pattern (kept for safety): /manga/<slug>/chapter-<num>/
      const legacyRe = new RegExp(
        `https?:\\/\\/(?:www\\.)?kingofshojo\\.com\\/manga\\/${slugRe}\\/chapter-(\\d+)(?:[-.](\\d+))?\\/?`,
        'gi'
      );
      while ((m = legacyRe.exec(payload)) !== null) {
        const number = m[2] ? parseFloat(`${parseInt(m[1], 10)}.${m[2]}`) : parseInt(m[1], 10);
        if (!Number.isFinite(number) || map.has(number)) continue;
        map.set(number, { number, title: `Chapter ${number}`, url: m[0] });
      }

      return map;
    };

    let map = parse(html);

    // Only when the series page itself produced NOTHING do we try the
    // (slow, best-effort) Madara-style AJAX endpoints. Each of these walks
    // the full proxy chain, so they must never run on the happy path.
    if (map.size === 0) {
      console.warn('[KingOfShojo:Series] no chapters in main page payload — trying AJAX fallbacks');
      try {
        const ajax = await window.SourceConfig.fetchPage(url.replace(/\/?$/, '/') + 'ajax/chapters/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          validator: (h) => /chapter-\d|chapter-prologue|kingofshojo/i.test(h)
        });
        if (ajax) html += '\n' + ajax;
      } catch {}

      const idMatch = html.match(/data-id=["'](\d{2,})["']/i) ||
                      html.match(/"manga[_-]?id"\s*:\s*"?(\d{2,})"?/i);
      if (idMatch) {
        try {
          const adminAjax = await window.SourceConfig.fetchPage('https://kingofshojo.com/wp-admin/admin-ajax.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `action=manga_get_chapters&manga=${encodeURIComponent(idMatch[1])}`,
            validator: (h) => /chapter-\d|kingofshojo/i.test(h)
          });
          if (adminAjax) html += '\n' + adminAjax;
        } catch {}
      }
      map = parse(html);
    }

    const list = [...map.values()].sort((a, b) => a.number - b.number);
    if (list.length === 0) {
      const sample = html.slice(0, 400).replace(/\s+/g, ' ');
      console.warn('[KingOfShojo:Series] empty chapter list — payload head:', sample);
      throw new Error(
        `No chapters found on KingOfShojo series page (slug="${slug}", payload ${html.length} chars). ` +
        `The page may be behind Cloudflare for the proxy that responded — try Refetch.`
      );
    }
    console.info('[KingOfShojo:Series] Chapter list extracted', { url, count: list.length });
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
})(SourceKingOfShojo);

window.SourceKingOfShojo = SourceKingOfShojo;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceKingOfShojo);
}
