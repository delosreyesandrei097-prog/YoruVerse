/**
 * ============================================================
 * MANHWA PLATFORM - MANGAKATANA SOURCE PLUGIN
 * ============================================================
 * Site: https://mangakatana.com  (server-rendered traditional manga site)
 *
 * Series  URL: https://mangakatana.com/manga/<slug>.<id>
 *              (the numeric `.<id>` suffix is REQUIRED)
 * Chapter URL: https://mangakatana.com/manga/<slug>.<id>/c<number>[/<page>]
 *              Examples:
 *                /manga/one-piece.16737/c1095
 *                /manga/some-slug.123/c12.5
 *                /manga/some-slug.123/v01/c001  (volume-prefixed)
 *
 * Chapter pages embed images two ways:
 *   1. Static HTML  : <div id="imgs"> ... <img class="wide" data-src="https://..." />
 *   2. Inline JS    : `var thzq = ['https://...jpg', 'https://...jpg', ...]` or
 *                     `var ytaw = [...]` / similar, paired with code that builds
 *                     <img> tags in #imgs. Both are parsed defensively.
 *
 * Image CDN hosts MangaKatana uses (token URLs vary):
 *   - i{N}.mangakatana.com
 *   - imgs.mkcdn.xyz / mkcdn.xyz
 *   - mangakatana.com/token/...
 * ============================================================
 */

const SourceMangaKatana = {
  name: 'MangaKatana',
  domain: 'mangakatana.com',

  patterns: [
    // /manga/<slug>.<id>/c<number>            (optional /<page>, /v<vol>/c<num>)
    /^https?:\/\/(?:www\.)?mangakatana\.com\/manga\/[^/]+\.\d+(?:\/v\d+)?\/c[\d.]+(?:\/\d+)?\/?(?:[?#].*)?$/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./, '') !== 'mangakatana.com') return false;
      // Series pages must NOT be detected as chapter pages.
      if (/^\/manga\/[^/]+\.\d+\/?$/i.test(u.pathname)) return false;
      return this.patterns.some(p => p.test(url));
    } catch { return false; }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (h) =>
        /mangakatana|id=["']imgs["']|class=["']wide["']|var\s+(?:thzq|ytaw|tkqz)|chapter/i.test(String(h || ''))
    });
  },

  // ---- URL helpers ----
  extractSeriesSlug(url) {
    const m = String(url).match(/\/manga\/([^/?#]+)/i);
    return m ? m[1] : '';
  },
  extractChapterNumber(url) {
    const m = String(url).match(/\/c(\d+(?:\.\d+)?)(?:\/|$|[?#])/i);
    return m ? parseFloat(m[1]) : null;
  },

  async extract(url) {
    const html = await this.fetchPage(url);
    const decoded = String(html || '')
      .replace(/\\\//g, '/')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');

    const chapterNumber = this.extractChapterNumber(url);
    const chapterTitle = this.extractTitle(decoded, url, chapterNumber);
    const seriesTitle = this.extractSeriesTitle(decoded);
    const imageUrls = this.extractImageUrls(decoded, url);

    const data = {
      chapterTitle,
      chapterNumber,
      imageUrls,
      seriesTitle,
      source: this.name,
      sourceUrl: url
    };
    if (!this.validate(data)) {
      throw new Error('Could not extract valid MangaKatana chapter data (no images found).');
    }
    return data;
  },

  extractTitle(decoded, url, chapterNumber) {
    // <div id="imgs" data-alt="<Series> - Chapter <N>">
    const dataAlt = (decoded.match(/<div[^>]+id=["']imgs["'][^>]*data-alt=["']([^"']+)["']/i) || [])[1];
    if (dataAlt) {
      const after = dataAlt.split(/-\s*Chapter\s*/i)[1];
      if (after) return `Chapter ${after.trim()}`;
    }
    // Breadcrumb tail: <li class="uk-active ..."><span>Chapter 1095</span></li>
    const crumb = (decoded.match(/<li[^>]*uk-active[^>]*>\s*<span>([^<]+)<\/span>/i) || [])[1];
    if (crumb && /chapter/i.test(crumb)) return crumb.trim();
    return chapterNumber != null ? `Chapter ${chapterNumber}` : 'Chapter';
  },

  extractSeriesTitle(decoded) {
    // Series page heading or chapter `data-alt`
    const dataAlt = (decoded.match(/<div[^>]+id=["']imgs["'][^>]*data-alt=["']([^"']+)["']/i) || [])[1];
    if (dataAlt) return dataAlt.split(/\s*-\s*Chapter/i)[0].trim();
    const h1 = (decoded.match(/<h1[^>]*class=["'][^"']*heading[^"']*["'][^>]*>([^<]+)<\/h1>/i) || [])[1];
    if (h1) return h1.trim();
    // Breadcrumb link title
    const crumb = (decoded.match(/<a[^>]+href=["'][^"']*\/manga\/[^"']+["'][^>]*title=["']([^"']+)["']/i) || [])[1];
    if (crumb) return crumb.trim();
    const t = (decoded.match(/<title>([^<]+)<\/title>/i) || [])[1];
    if (t) return t.replace(/\s*(?:-|–|\|).*$/, '').trim();
    return null;
  },

  // Hosts that MangaKatana serves chapter pages from.
  _imageHostRe: /^https?:\/\/(?:[a-z0-9-]+\.)?(?:mangakatana\.com|mkcdn\.xyz)\//i,

  extractImageUrls(decoded, url) {
    const seen = new Set();
    const out = [];

    const isPage = (u) => {
      if (!u || typeof u !== 'string') return false;
      // Strip surrounding whitespace and escaped slashes.
      const clean = u.trim();
      if (!this._imageHostRe.test(clean)) return false;
      if (!/\.(?:webp|jpe?g|png|gif|avif)(?:\?|$)/i.test(clean)) return false;
      // Reject placeholders / chrome.
      if (/coming_soon|\/imgs\/(?:logo|loading|placeholder)|favicon|sprite/i.test(clean)) return false;
      return true;
    };
    const push = (u) => {
      if (!isPage(u)) return;
      if (seen.has(u)) return;
      seen.add(u);
      out.push(u);
    };

    // STRATEGY 1: DOM scan of #imgs — preferred since it preserves page order.
    try {
      const doc = new DOMParser().parseFromString(decoded, 'text/html');
      const wrap = doc.querySelector('#imgs');
      if (wrap) {
        const imgs = [...wrap.querySelectorAll('img')];
        const attrs = ['data-src', 'data-original', 'data-lazy-src', 'src'];
        for (const img of imgs) {
          for (const a of attrs) {
            const v = img.getAttribute(a);
            if (v) push(v);
          }
          const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
          ss.split(',').forEach(p => push(p.trim().split(/\s+/)[0]));
        }
      }
      if (out.length) return out;
    } catch { /* DOMParser unavailable — fall through */ }

    // STRATEGY 2: Inline JS arrays — `var thzq = [...]`, `var ytaw = [...]`, etc.
    // MangaKatana ships chapter images in a JS array variable that the reader
    // then injects into #imgs. Try the well-known names first, then any
    // `var <name> = [ "http..." , ... ];` block.
    const knownVars = ['thzq', 'ytaw', 'tkqz', 'htmpr', 'imgsrcs', 'mgkimgs'];
    for (const name of knownVars) {
      const re = new RegExp(`var\\s+${name}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*;`, 'i');
      const block = (decoded.match(re) || [])[1];
      if (!block) continue;
      const urlRe = /['"]([^'"\s]+?\.(?:webp|jpe?g|png|gif|avif))['"]/gi;
      let mm;
      while ((mm = urlRe.exec(block)) !== null) push(mm[1]);
      if (out.length) return out;
    }
    // Generic var-array fallback: any `var X = ["http..."...]` containing image URLs.
    const varBlocks = decoded.match(/var\s+\w+\s*=\s*\[\s*["']https?:\/\/[^\]]{20,20000}\]\s*;/gi) || [];
    for (const block of varBlocks) {
      const urlRe = /["'](https?:\/\/[^"'\s]+?\.(?:webp|jpe?g|png|gif|avif))["']/gi;
      let mm;
      const batch = [];
      while ((mm = urlRe.exec(block)) !== null) {
        if (isPage(mm[1])) batch.push(mm[1]);
      }
      if (batch.length >= 2) {
        batch.forEach(push);
        if (out.length) return out;
      }
    }

    // STRATEGY 3: Final sweep — any MangaKatana/MKCDN image URL in the document.
    const allRe = /https?:\/\/(?:[a-z0-9-]+\.)?(?:mangakatana\.com|mkcdn\.xyz)\/[^"'\s<>\\]+?\.(?:webp|jpe?g|png|gif|avif)/gi;
    let m;
    while ((m = allRe.exec(decoded)) !== null) push(m[0]);

    if (!out.length) {
      console.warn('[MangaKatana] No images extracted for chapter', { url, htmlLength: (decoded || '').length });
    }
    return out;
  },

  validate(data) {
    if (!data.imageUrls || !data.imageUrls.length) return false;
    if (data.chapterNumber == null) data.chapterNumber = 1;
    if (!data.chapterTitle) data.chapterTitle = `Chapter ${data.chapterNumber}`;
    return true;
  }
};

// ===================== Series capabilities =====================
(function (base) {
  'use strict';

  const SERIES_PATTERN = /^https?:\/\/(?:www\.)?mangakatana\.com\/manga\/[^/?#]+\.\d+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') === 'mangakatana.com' && SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/manga\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  async function fetchSeriesPage(url) {
    return window.SourceConfig.fetchPage(url, {
      validator: (h) =>
        /mangakatana|class=["']?chapters["']?|\/manga\/[^"']+\/c\d|class=["']?heading["']?/i.test(String(h || ''))
    });
  }

  function textOf(html) {
    return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  }

  base.getSeriesInfo = async function (url) {
    const html = await fetchSeriesPage(url);
    const decoded = String(html || '').replace(/\\\//g, '/');
    const slug = base.getSeriesSlug(url);

    // Title — primary h1.heading on series page.
    const title =
      (decoded.match(/<h1[^>]*class=["'][^"']*heading[^"']*["'][^>]*>([^<]+)<\/h1>/i) || [])[1]?.trim()
      || (decoded.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i) || [])[1]?.trim()
      || slug.replace(/\.\d+$/, '').replace(/-/g, ' ');

    // Cover — inside <div class="cover"><img src="...">
    let cover =
      (decoded.match(/<div[^>]+class=["'][^"']*\bcover\b[^"']*["'][^>]*>\s*<img[^>]+src=["']([^"']+)["']/i) || [])[1]
      || (decoded.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)/i) || [])[1]
      || undefined;
    if (cover && /coming_soon|logo|placeholder/i.test(cover)) cover = undefined;

    // Description — <div class="summary"><p>...</p>
    const summaryBlock = (decoded.match(/<div[^>]+class=["'][^"']*\bsummary\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
    let description = textOf((summaryBlock.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || summaryBlock);
    if (!description) {
      description = (decoded.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)/i) || [])[1] || '';
    }

    // Genres — <div class="genres"><a>Action</a><a>...</a>
    const genres = [];
    const genresBlock = (decoded.match(/<div[^>]+class=["'][^"']*\bgenres\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
    const ge = /<a[^>]*>([^<]+)<\/a>/gi;
    let gm;
    while ((gm = ge.exec(genresBlock)) !== null) {
      const v = gm[1].trim();
      if (v && !genres.includes(v)) genres.push(v);
    }

    // Authors / Artists — <div class="... authors"><a class="author">Name</a>
    const authorsBlock = (decoded.match(/<div[^>]+class=["'][^"']*\bauthors\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
    const authors = [];
    const ae = /<a[^>]*>([^<]+)<\/a>/gi;
    let am;
    while ((am = ae.exec(authorsBlock)) !== null) {
      const v = am[1].trim();
      if (v && !authors.includes(v)) authors.push(v);
    }

    // Status — <div class="... status completed">Completed</div>
    let status;
    const sm = decoded.match(/<div[^>]+class=["'][^"']*\bstatus\s+(ongoing|completed|hiatus|dropped|cancelled)\b[^"']*["'][^>]*>([^<]*)<\/div>/i);
    if (sm) {
      const v = (sm[1] || sm[2] || '').toLowerCase().trim();
      status = v === 'cancelled' ? 'dropped' : v;
    }

    // Alt names — <div class="alt_name">a / b / c</div>
    const altRaw = textOf((decoded.match(/<div[^>]+class=["'][^"']*\balt_name\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');
    const alternativeTitles = altRaw
      ? altRaw.split(/\s*\/\s*/).map(s => s.trim()).filter(Boolean)
      : [];

    return {
      title: title.trim(),
      cover,
      description: description || undefined,
      author: authors[0],
      artist: authors[0],
      status,
      genres: genres.length ? genres : undefined,
      alternativeTitles,
      slug,
      sourceUrl: url
    };
  };

  base.getChapterList = async function (url) {
    const html = await fetchSeriesPage(url);
    const decoded = String(html || '').replace(/\\\//g, '/');
    const slug = base.getSeriesSlug(url);
    const origin = 'https://mangakatana.com';
    const map = new Map();

    // Scope to the chapter table to avoid picking up nav links elsewhere.
    let scope = (decoded.match(/<div[^>]+class=["'][^"']*\bchapters\b[^"']*["'][^>]*>([\s\S]*?)<\/div>\s*<(?:div|script|section)/i) || [])[1];
    if (!scope) scope = decoded;

    const escSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const linkRe = new RegExp(
      `<a[^>]+href=["'](https?:\\/\\/(?:www\\.)?mangakatana\\.com\\/manga\\/${escSlug}(?:\\/v\\d+)?\\/c(\\d+(?:\\.\\d+)?))["'][^>]*>([\\s\\S]*?)<\\/a>`,
      'gi'
    );
    let m;
    while ((m = linkRe.exec(scope)) !== null) {
      const number = parseFloat(m[2]);
      if (!Number.isFinite(number) || map.has(number)) continue;
      const inner = m[3].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      map.set(number, {
        number,
        title: inner || `Chapter ${number}`,
        url: m[1]
      });
    }

    // Fallback: relative hrefs.
    if (!map.size) {
      const relRe = new RegExp(
        `href=["']\\/manga\\/${escSlug}(?:\\/v\\d+)?\\/c(\\d+(?:\\.\\d+)?)["']`,
        'gi'
      );
      let rm;
      while ((rm = relRe.exec(decoded)) !== null) {
        const number = parseFloat(rm[1]);
        if (!Number.isFinite(number) || map.has(number)) continue;
        map.set(number, {
          number,
          title: `Chapter ${number}`,
          url: `${origin}/manga/${slug}/c${rm[1]}`
        });
      }
    }

    const list = [...map.values()].sort((a, b) => a.number - b.number);
    if (!list.length) {
      throw new Error(
        `No chapters found on MangaKatana series page (slug="${slug}"). ` +
        `The proxy may have returned a stripped page — try Refetch.`
      );
    }
    console.info('[MangaKatana:Series] Chapter list extracted', { url, count: list.length });
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
})(SourceMangaKatana);

window.SourceMangaKatana = SourceMangaKatana;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceMangaKatana);
}