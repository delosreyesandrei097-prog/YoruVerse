/**
 * ============================================================
 * MANHWA PLATFORM - QIMANGA SOURCE PLUGIN
 * ============================================================
 * Site: https://qimanga.com   (SPA, server-rendered JSON payload)
 *
 * Series  URL: https://qimanga.com/series/<idprefix>-<slug>
 *              (the numeric prefix is REQUIRED; "/series/<slug>" 404s)
 * Chapter URL: https://qimanga.com/series/<idprefix>-<slug>/chapter-<N>
 *
 * The HTML is a Tailwind/Beasties SPA shell but the SSR payload contains
 * everything we need as inline JSON:
 *   - chapter list:     "slug":"chapter-N"  paired with  "number":N
 *   - chapter images:   "images":[{"url":"https://media.qimanhwa.com/.../X.webp","order":N}]
 *   - cover:            <meta property="og:image" content="...">
 *   - genres:           "genres":[{"id":..,"name":"...","slug":"..."}]
 *   - status:           "status":"ONGOING"|"COMPLETED"|"HIATUS"
 *   - description:      "description":"..."     (full)
 *                       or  <meta property="og:description"> (truncated)
 *   - alternativeTitles:"alternativeTitles":"일렉시드"
 *
 * Image CDN host: media.qimanhwa.com   (covers also live on
 * media.qiscans.org / media.ezmanga.org — accept all of them).
 * ============================================================
 */

const SourceQiManga = {
  name: 'QiManga',
  domain: 'qimanga.com',

  patterns: [
    /^https?:\/\/(www\.)?qimanga\.com\/series\/[^/?#]+\/chapter-[\d.]+\/?(?:[?#].*)?$/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./, '') !== 'qimanga.com') return false;
      // Series pages must NOT be detected as chapters.
      if (/^\/series\/[^/]+\/?$/i.test(u.pathname)) return false;
      return this.patterns.some(p => p.test(url));
    } catch { return false; }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (h) =>
        /qimanga|qiscans|qimanhwa|ezmanga|chapter-\d|"images"\s*:\s*\[|og:title/i.test(String(h || ''))
    });
  },

  // ---- URL helpers ----
  extractSeriesSlug(url) {
    const m = String(url).match(/\/series\/([^/?#]+)/i);
    return m ? m[1] : '';
  },
  extractChapterSlug(url) {
    const m = String(url).match(/\/(chapter-[\d.]+)\/?(?:[?#]|$)/i);
    return m ? m[1].toLowerCase() : '';
  },
  extractChapterNumber(url) {
    const m = String(url).match(/\/chapter-(\d+(?:\.\d+)?)\/?(?:[?#]|$)/i);
    return m ? parseFloat(m[1]) : null;
  },

  async extract(url) {
    const html = await this.fetchPage(url);
    const decoded = String(html || '')
      .replace(/\\\//g, '/')
      .replace(/\\u002F/gi, '/')
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
    if (!this.validate(data)) throw new Error('Could not extract valid QiManga chapter data.');
    return data;
  },

  extractTitle(decoded, url, chapterNumber) {
    const og = (decoded.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i) || [])[1];
    if (og) return og.trim();
    return chapterNumber != null ? `Chapter ${chapterNumber}` : `Chapter ${this.extractChapterSlug(url).replace('chapter-','')}`;
  },

  extractSeriesTitle(decoded) {
    const og = (decoded.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i) || [])[1];
    if (og) {
      // "Eleceed – Ch. 1" → "Eleceed"
      return og.replace(/\s*[–—-]\s*Ch\.?\s*\d.*$/i, '').replace(/\s*\|.*$/, '').trim();
    }
    const t = (decoded.match(/<title>([^<]+)<\/title>/i) || [])[1];
    if (t) return t.split('|')[0].split(/[–—-]\s*Ch/i)[0].trim();
    return null;
  },

  // Image hosts QiManga uses for chapter pages.
  _imageHostRe: /^https?:\/\/(?:media\.qimanhwa\.com|media\.qiscans\.org|media\.ezmanga\.org|cdn\.qimanga\.com)\//i,

  extractImageUrls(decoded, url) {
    const seen = new Set();
    const out = [];

    const isPage = (u) => {
      if (!u || typeof u !== 'string') return false;
      if (!this._imageHostRe.test(u)) return false;
      if (!/\.(?:webp|jpe?g|png|avif)(?:\?|$)/i.test(u)) return false;
      if (/\/logo|\/favicon|\/placeholder|LOGO-\d/i.test(u)) return false;
      return true;
    };
    const push = (u) => {
      if (!isPage(u)) return;
      if (seen.has(u)) return;
      seen.add(u);
      out.push(u);
    };

    // STRATEGY 1: Object form  "images":[{"url":"...","order":N}, ...]
    // Pick the array whose URLs match the current chapter URL pattern
    // (ch-<number>/<page>.<ext>) or the longest matching array.
    const slug = this.extractSeriesSlug(url);
    const cnum = this.extractChapterNumber(url);
    const objBlocks = decoded.match(/"images"\s*:\s*\[\s*\{[\s\S]{0,500000}?\}\s*\]/gi) || [];
    const objCandidates = [];
    for (const block of objBlocks) {
      const urlRe = /"url"\s*:\s*"([^"\\]+?\.(?:webp|jpe?g|png|avif))"/gi;
      const orderRe = /"order"\s*:\s*(\d+)/gi;
      const items = [];
      let mm, om;
      const urls = [];
      while ((mm = urlRe.exec(block)) !== null) urls.push(mm[1]);
      // Pair with order when possible by sequential index
      const orders = [];
      while ((om = orderRe.exec(block)) !== null) orders.push(parseInt(om[1], 10));
      for (let i = 0; i < urls.length; i++) items.push({ url: urls[i], order: orders[i] ?? i });
      if (!items.length) continue;
      objCandidates.push(items);
    }
    if (objCandidates.length) {
      const scope = slug && cnum != null
        ? new RegExp(`/${slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/ch-${cnum}/`, 'i')
        : null;
      let pick = null;
      if (scope) {
        pick = objCandidates
          .filter(arr => arr.some(it => scope.test(it.url)))
          .sort((a, b) => b.length - a.length)[0] || null;
      }
      if (!pick) pick = objCandidates.sort((a, b) => b.length - a.length)[0];
      if (pick) {
        pick.sort((a, b) => (a.order ?? 0) - (b.order ?? 0)).forEach(it => push(it.url));
        if (out.length) return out;
      }
    }

    // STRATEGY 2: String form  "images":["...","..."]
    const strBlocks = decoded.match(/"images"\s*:\s*\[\s*"[^"]+"(?:\s*,\s*"[^"]+")*\s*\]/gi) || [];
    const strCandidates = [];
    for (const block of strBlocks) {
      const urlRe = /"([^"]+?\.(?:webp|jpe?g|png|avif))"/gi;
      const urls = [];
      let mm;
      while ((mm = urlRe.exec(block)) !== null) urls.push(mm[1]);
      if (urls.length) strCandidates.push(urls);
    }
    if (strCandidates.length) {
      const pick = strCandidates.sort((a, b) => b.length - a.length)[0];
      pick.forEach(push);
      if (out.length) return out;
    }

    // STRATEGY 3: DOM scan (lazy attributes)
    try {
      const doc = new DOMParser().parseFromString(decoded, 'text/html');
      const imgs = [...doc.querySelectorAll('img')];
      const attrs = ['src', 'data-src', 'data-lazy-src', 'data-original'];
      for (const img of imgs) {
        for (const a of attrs) push(img.getAttribute(a));
        const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset') || '';
        ss.split(',').forEach(p => push(p.trim().split(/\s+/)[0]));
      }
      if (out.length) return out;
    } catch { /* DOMParser missing — ignore */ }

    // STRATEGY 4: Raw URL sweep restricted to scoped folder.
    if (slug && cnum != null) {
      const re = new RegExp(
        `https?:\\/\\/(?:media\\.qimanhwa\\.com|media\\.qiscans\\.org|media\\.ezmanga\\.org|cdn\\.qimanga\\.com)\\/[^"'\\s<>\\\\]*?\\/${slug.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\/ch-${cnum}\\/[^"'\\s<>\\\\]+?\\.(?:webp|jpe?g|png|avif)`,
        'gi'
      );
      let m;
      while ((m = re.exec(decoded)) !== null) push(m[0]);
      if (out.length) {
        // Sort by trailing page index when present (0.webp, 1.webp, ...)
        out.sort((a, b) => {
          const ai = parseInt((a.match(/\/(\d+)\.[a-z]+$/i) || [])[1] || '0', 10);
          const bi = parseInt((b.match(/\/(\d+)\.[a-z]+$/i) || [])[1] || '0', 10);
          return ai - bi;
        });
        return out;
      }
    }

    // STRATEGY 5: Final sweep — any qimanhwa media URL ending in an image.
    const allRe = /https?:\/\/(?:media\.qimanhwa\.com|media\.qiscans\.org|media\.ezmanga\.org|cdn\.qimanga\.com)\/[^"'\s<>\\]+?\.(?:webp|jpe?g|png|avif)/gi;
    let m5;
    while ((m5 = allRe.exec(decoded)) !== null) push(m5[0]);
    if (!out.length) {
      console.warn('[QiManga] No images extracted for chapter', { url, htmlLength: (decoded || '').length });
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

  const SERIES_PATTERN = /^https?:\/\/(www\.)?qimanga\.com\/series\/[^/?#]+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;

  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') === 'qimanga.com' && SERIES_PATTERN.test(url);
    } catch { return false; }
  };

  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/series\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  async function fetchSeriesPage(url) {
    return window.SourceConfig.fetchPage(url, {
      validator: (h) =>
        /qimanga|qiscans|qimanhwa|"slug"\s*:\s*"chapter-|chapter-\d|og:title/i.test(String(h || ''))
    });
  }

  function pluckStr(decoded, key) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'i');
    const m = decoded.match(re);
    if (!m) return '';
    try { return JSON.parse('"' + m[1] + '"').trim(); }
    catch { return m[1].trim(); }
  }

  function pluckGenres(decoded) {
    // "genres":[{"id":2,"name":"Action","slug":"action"}, ...]
    const block = decoded.match(/"genres"\s*:\s*\[([^\]]{2,4000})\]/i);
    const out = [];
    if (block) {
      const re = /"name"\s*:\s*"([^"\\]+)"/gi;
      let m;
      while ((m = re.exec(block[1])) !== null) {
        const v = m[1].trim();
        if (v && !out.includes(v)) out.push(v);
      }
    }
    if (!out.length) {
      // Fallback: simple "genre":["..."] array
      const b2 = decoded.match(/"genre"\s*:\s*\[([^\]]{2,2000})\]/i);
      if (b2) {
        const re = /"([^"\\]{2,40})"/g;
        let m;
        while ((m = re.exec(b2[1])) !== null) {
          const v = m[1].trim();
          if (v && !out.includes(v)) out.push(v);
        }
      }
    }
    return out;
  }

  function pluckStatus(decoded) {
    // Prefer "status":"ONGOING" over "APPROVED" (which is moderation status)
    const re = /"status"\s*:\s*"(ONGOING|COMPLETED|HIATUS|DROPPED|CANCELLED)"/i;
    const m = decoded.match(re);
    if (!m) return undefined;
    const v = m[1].toLowerCase();
    return v === 'cancelled' ? 'dropped' : v;
  }

  base.getSeriesInfo = async function (url) {
    const html = await fetchSeriesPage(url);
    const decoded = String(html || '')
      .replace(/\\\//g, '/')
      .replace(/\\u002F/gi, '/')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&');

    const slug = base.getSeriesSlug(url);

    const ogTitle = (decoded.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)/i) || [])[1] || '';
    const ogImage = (decoded.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)/i) || [])[1] || '';
    const ogDesc  = (decoded.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)/i) || [])[1] || '';

    const title = (ogTitle || pluckStr(decoded, 'title') || slug.replace(/^\d+-/, '').replace(/-/g, ' ')).trim();

    let description = pluckStr(decoded, 'description');
    if (!description || description.length < ogDesc.length) {
      description = description || ogDesc.trim();
    }
    // Drop the truncated og:description if we have a fuller one
    if (ogDesc && description && description.length < 80 && ogDesc.length > description.length) {
      description = ogDesc.trim();
    }

    const author = pluckStr(decoded, 'author') || undefined;
    const artist = pluckStr(decoded, 'artist') || undefined;
    const status = pluckStatus(decoded);
    const genres = pluckGenres(decoded);

    const altRaw = pluckStr(decoded, 'alternativeTitles') || pluckStr(decoded, 'alternative_titles') || '';
    const alternativeTitles = altRaw
      ? altRaw.split(/[,;|\/]/).map(s => s.trim()).filter(Boolean)
      : [];

    const cover = ogImage
      || (decoded.match(/https?:\/\/media\.(?:qimanhwa\.com|qiscans\.org|ezmanga\.org)\/[^"'\s<>\\]+?\.(?:webp|jpe?g|png|avif)/i) || [])[0]
      || undefined;

    return {
      title,
      cover: cover && !/LOGO-\d/i.test(cover) ? cover : undefined,
      description: description || undefined,
      author,
      artist,
      status,
      genres: genres.length ? genres : undefined,
      alternativeTitles,
      slug,
      sourceUrl: url
    };
  };

  // Scan a single HTML payload for chapter URLs (PRIMARY / SECONDARY /
  // TERTIARY strategies). Mutates `map`.
  function scanChaptersInto(decoded, slug, origin, map) {
    // PRIMARY: pull "slug":"chapter-N" paired with the adjacent "number":N.
    const pairRe = /"slug"\s*:\s*"(chapter-(\d+(?:\.\d+)?))"\s*,\s*"number"\s*:\s*(\d+(?:\.\d+)?)/gi;
    let m;
    while ((m = pairRe.exec(decoded)) !== null) {
      const number = parseFloat(m[3]);
      if (!Number.isFinite(number) || map.has(number)) continue;
      map.set(number, {
        number,
        title: `Chapter ${number}`,
        url: `${origin}/series/${slug}/chapter-${m[2]}`
      });
    }

    // SECONDARY: anchor scrape — direct hrefs in the SSR shell.
    const escSlug = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hrefRe = new RegExp(`\\/series\\/${escSlug}\\/chapter-(\\d+(?:\\.\\d+)?)`, 'gi');
    let hm;
    while ((hm = hrefRe.exec(decoded)) !== null) {
      const number = parseFloat(hm[1]);
      if (!Number.isFinite(number) || map.has(number)) continue;
      map.set(number, {
        number,
        title: `Chapter ${number}`,
        url: `${origin}/series/${slug}/chapter-${hm[1]}`
      });
    }

    // TERTIARY: any plain slug occurrence (covers slug-only JSON entries).
    const slugRe = /"slug"\s*:\s*"chapter-(\d+(?:\.\d+)?)"/gi;
    let sm;
    while ((sm = slugRe.exec(decoded)) !== null) {
      const number = parseFloat(sm[1]);
      if (!Number.isFinite(number) || map.has(number)) continue;
      map.set(number, {
        number,
        title: `Chapter ${number}`,
        url: `${origin}/series/${slug}/chapter-${sm[1]}`
      });
    }
  }

  base.getChapterList = async function (url) {
    const slug = base.getSeriesSlug(url);
    const origin = 'https://qimanga.com';
    const map = new Map();

    // The QiManga series page is an Angular SPA. The SSR shell only
    // embeds a SHORT slice of chapters (first chapter + last ~10), even
    // though hundreds may exist. The remainder is loaded client-side via
    // a virtual-scroll list, so anything past the visible slice was being
    // silently skipped on import (gap between chapter 1 and the latest
    // ~10 chapters).
    //
    // Strategy:
    //   1. Scrape every chapter we can see in the default payload.
    //   2. Try `?page=N` variants — the server expands the SSR slice when
    //      a query string is present, surfacing a wider window of chapters.
    //   3. Detect the maximum chapter number observed and synthesize any
    //      missing INTEGER chapters between 1..max. This guarantees no
    //      mid-list integer chapter is skipped during import / Auto-Sync.
    //      Decimal/special chapters discovered in step 1-2 are preserved
    //      and merged in alongside the synthesized integer chapters.

    // Step 1: default SSR payload.
    const baseHtml = await fetchSeriesPage(url);
    const decode = (h) => String(h || '')
      .replace(/\\\//g, '/')
      .replace(/\\u002F/gi, '/')
      .replace(/&quot;/g, '"');
    scanChaptersInto(decode(baseHtml), slug, origin, map);

    // Step 2: probe paginated SSR variants. Each `?page=N` returns a
    // different ~30-chapter window. We probe sequentially until a page
    // adds no new chapter numbers — capped to avoid runaway loops on
    // unbounded SPAs.
    const sep = url.includes('?') ? '&' : '?';
    const MAX_PAGES = 30;
    let sizeBefore = map.size;
    for (let page = 1; page <= MAX_PAGES; page++) {
      let pageHtml;
      try {
        pageHtml = await fetchSeriesPage(`${url}${sep}page=${page}`);
      } catch (e) {
        console.warn('[QiManga:Series] paginated fetch failed', { page, err: String(e?.message || e) });
        break;
      }
      scanChaptersInto(decode(pageHtml), slug, origin, map);
      if (map.size === sizeBefore) break; // no new chapters — stop probing
      sizeBefore = map.size;
    }

    // Step 3: synthesize missing integer chapters up to the max observed.
    // This is the actual fix for the "chapters 2..N silently skipped" bug.
    let maxNumber = 0;
    for (const n of map.keys()) {
      if (Number.isFinite(n) && n > maxNumber) maxNumber = Math.floor(n);
    }
    if (maxNumber >= 1) {
      for (let n = 1; n <= maxNumber; n++) {
        if (map.has(n)) continue;
        // Also skip if we already have a decimal variant pinned to this
        // integer (e.g. 5.1 exists — we still synthesize 5).
        map.set(n, {
          number: n,
          title: `Chapter ${n}`,
          url: `${origin}/series/${slug}/chapter-${n}`
        });
      }
    }

    const list = [...map.values()].sort((a, b) => a.number - b.number);
    if (!list.length) {
      throw new Error(
        `No chapters found on QiManga series page (slug="${slug}"). ` +
        `The proxy may have returned a stripped page — try Refetch.`
      );
    }
    console.info('[QiManga:Series] Chapter list extracted', {
      url, count: list.length, max: maxNumber
    });
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
})(SourceQiManga);

window.SourceQiManga = SourceQiManga;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceQiManga);
}
