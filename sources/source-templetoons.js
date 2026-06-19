/**
 * ============================================================
 * MANHWA PLATFORM - TEMPLE TOONS SOURCE PLUGIN  (FIXED)
 * ============================================================
 * Site: https://templetoons.com   (Next.js / RSC)
 *
 * Series  URL: https://templetoons.com/comic/<slug>
 * Chapter URL: https://templetoons.com/comic/<slug>/<chapter_slug>
 *
 * TempleToons embeds the chapter list inside the streamed RSC payload as
 * escaped JSON like:
 *     \"index\":\"19\",\"chapter_name\":\"Chapter 19\",
 *     \"chapter_title\":null,\"chapter_data\":{...},
 *     \"chapter_thumbnail\":\"...\",\"chapter_slug\":\"chapter-19\"
 *
 * Decimal / named chapters use slugs like:
 *     chapter-1, chapter-01, chapter-1-5, prologue, side-story-2,
 *     extra-1, epilogue, special-1
 *
 * V11 FIXES (2026-06):
 *   - Chapter image extraction was returning 0 images on real chapter
 *     pages. The RSC payload arrives as backslash-escaped JSON
 *     ( \"images\":[\"https://media...\"] ) and the previous `decoded`
 *     step normalized `\/`, `\u002F`, `&quot;` and `&amp;` but NOT the
 *     `\"` quote escape. As a result Strategies 1 + 2 (which match the
 *     literal `"images":[ ... ]` array) never fired and only the
 *     fallback raw-URL sweep ran — which the older filters also broke
 *     on some payloads. The fix: add `\\"` → `"` to the decoder so the
 *     RSC payload looks like normal JSON to the rest of the pipeline.
 *   - Strategy 3 (series-slug-scoped sweep) now also accepts the
 *     decoded payload and is unconditional (not gated by escSlug being
 *     present) so it works even when extractSeriesSlug() can't read the
 *     URL.
 *   - Added a folder-dominance check so prefetched neighbour chapters
 *     embedded in the same payload don't leak into the result.
 *   - Clearer logging when no images extract: include payload size,
 *     proxy hint, and a head snippet.
 * ============================================================
 */

const SourceTempleToons = {
  name: 'TempleToons',
  domain: 'templetoons.com',

  patterns: [
    /^https?:\/\/(www\.)?templetoons\.com\/comic\/[^/]+\/(?:\d+-)?(?:chapter-[\w.-]+|prologue|epilogue|side-story(?:-\d+(?:-\d+)?)?|extra(?:-\d+(?:-\d+)?)?|special(?:-\d+(?:-\d+)?)?)\/?(?:[?#].*)?$/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./, '') !== 'templetoons.com') return false;
      if (/^\/comic\/[^/]+\/?$/i.test(u.pathname)) return false;
      return this.patterns.some(p => p.test(url));
    } catch { return false; }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (h) => /media\.templetoons\.com|chapter_slug|chapter_name|slug_chapter|templetoons/i.test(h)
    });
  },

  async extract(url) {
    const html = await this.fetchPage(url);
    const slug = this.extractSeriesSlug(url);
    const chapterNum = this.extractChapterNumber(url, html);
    const chapterTitle = this.extractTitle(html, url, chapterNum);
    const seriesTitle = this.extractSeriesTitle(html, slug);
    const imageUrls = this.extractImageUrls(html, url);

    const data = {
      chapterTitle,
      chapterNumber: chapterNum,
      imageUrls,
      seriesTitle,
      source: this.name,
      sourceUrl: url
    };
    if (!this.validate(data)) throw new Error('Could not extract valid TempleToons chapter data.');
    return data;
  },

  extractSeriesSlug(url) {
    const m = String(url).match(/\/comic\/([^/]+)/i);
    return m ? m[1] : '';
  },

  extractChapterSlug(url) {
    const m = String(url).match(/\/comic\/[^/]+\/(?:\d+-)?([\w.-]+?)\/?(?:[?#]|$)/i);
    return m ? m[1].toLowerCase() : '';
  },

  extractChapterNumber(url, html = '') {
    // Numeric: /chapter-12 or /chapter-12-5 or /chapter-01
    const m = url.match(/\/(?:\d+-)?chapter-(\d+)(?:-(\d+))?\/?(?:[?#]|$)/i);
    if (m) return m[2] ? parseFloat(`${parseInt(m[1], 10)}.${m[2]}`) : parseInt(m[1], 10);
    if (/\/prologue\/?(?:[?#]|$)/i.test(url)) return 0;
    if (/\/epilogue\/?(?:[?#]|$)/i.test(url)) return 9999;
    const named = url.match(/\/(side-story|extra|special)(?:-(\d+)(?:-(\d+))?)?\/?(?:[?#]|$)/i);
    if (named) {
      const n = named[2] ? (named[3] ? parseFloat(`${named[2]}.${named[3]}`) : parseFloat(named[2])) : 0;
      return 0.001 + n / 1000;
    }
    const j = html.match(/\\?"index\\?"\s*:\s*\\?"?(\d+(?:\.\d+)?)\\?"?/i);
    return j ? parseFloat(j[1]) : null;
  },

  extractTitle(html, url, chapterNum) {
    const slugFromUrl = this.extractChapterSlug(url);
    if (slugFromUrl) {
      // Accept zero or one backslash before each quote (RSC escapes once)
      const re = new RegExp(
        `\\\\?"chapter_slug\\\\?"\\s*:\\s*\\\\?"${slugFromUrl}\\\\?"[\\s\\S]{0,400}?\\\\?"chapter_title\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`,
        'i'
      );
      const m = html.match(re);
      if (m && m[1] && m[1].trim() && m[1].trim() !== 'null') {
        return `Chapter ${chapterNum ?? ''} - ${m[1].trim()}`.replace(/^Chapter\s+-\s+/, '');
      }
    }
    const ogTitle = (html.match(/<meta property=["']og:title["']\s*content=["']([^"']+)/i) || [])[1];
    if (ogTitle) return ogTitle.trim();
    return chapterNum != null ? `Chapter ${chapterNum}` : null;
  },

  extractSeriesTitle(html, slug) {
    const og = (html.match(/<meta property=["']og:title["']\s*content=["']([^"']+)/i) || [])[1];
    if (og) return og.split(/[-–—|]/)[0].trim();
    const t = (html.match(/<title>([^<]+)<\/title>/i) || [])[1];
    if (t) return t.split(/[-–—|]/)[0].trim();
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;
  },

  extractImageUrls(html, url) {
    const slug = this.extractSeriesSlug(url);
    const chapterSlug = this.extractChapterSlug(url);
    const seen = new Set();
    const out = [];
    const escSlug = slug ? slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';

    // Normalize escaped JSON (RSC payloads use \/ for slashes, \u002F,
    // &quot;, and — critically — \" around every embedded quote). Without
    // the \" → " step, Strategies 1 & 2 below never matched the
    // "images":[...] array and chapters silently returned 0 images.
    const decoded = String(html || '')
      .replace(/\\\//g, '/')
      .replace(/\\u002F/gi, '/')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&')
      .replace(/\\"/g, '"');

    const isPage = (u) => {
      if (!u || typeof u !== 'string') return false;
      if (!/^https?:\/\/media\.templetoons\.com\/file\//i.test(u)) return false;
      if (!/\.(?:webp|jpg|jpeg|png|avif)(?:\?|$)/i.test(u)) return false;
      if (/\/covers\//i.test(u)) return false;
      if (/\/thumbnails\//i.test(u)) return false;
      // Avoid avatars/icons/logos that occasionally leak in.
      if (/\/(?:avatars?|icons?|logos?|favicon|placeholder)\//i.test(u)) return false;
      return true;
    };

    const push = (u) => {
      if (!isPage(u)) return;
      if (seen.has(u)) return;
      seen.add(u);
      out.push(u);
    };

    // When several chapters are embedded in the same payload, keep only
    // the dominant chapter folder. Each page URL contains a UUID-shaped
    // chapter folder segment right after the series slug:
    //   /uploads/series/<slug>/<chapter-folder>/01.jpg
    const restrictToDominantFolder = (list) => {
      if (!list || list.length < 2) return list;
      const counts = new Map();
      for (const u of list) {
        const m = u.match(/\/uploads\/series\/[^/]+\/([^/]+)\//i);
        if (!m) continue;
        counts.set(m[1], (counts.get(m[1]) || 0) + 1);
      }
      let dom = null, n = 0;
      for (const [k, v] of counts) { if (v > n) { dom = k; n = v; } }
      if (!dom || n < 2) return list;
      const filtered = list.filter(u =>
        new RegExp(`/uploads/series/[^/]+/${dom.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}/`, 'i').test(u)
      );
      return filtered.length ? filtered : list;
    };

    // ----------------------------------------------------------------
    // STRATEGY 1: Parse "images":[...] arrays directly from the payload.
    // TempleToons RSC emits the active chapter as:
    //     "chapter_data":{...,"images":["https://media.../...01.jpg","..."]}
    // The chapter list also contains chapter_data blocks for other chapters,
    // so we pick the array whose URLs are scoped to the current series
    // (and prefer the longest one — that is the active chapter's pages).
    // ----------------------------------------------------------------
    const arrayRe = /"images"\s*:\s*\[([^\]]{20,200000})\]/gi;
    let arr;
    const candidates = [];
    while ((arr = arrayRe.exec(decoded)) !== null) {
      const body = arr[1];
      const urlRe = /"(https?:\/\/media\.templetoons\.com\/file\/[^"\\]+?\.(?:webp|jpg|jpeg|png|avif))"/gi;
      const urls = [];
      let mm;
      while ((mm = urlRe.exec(body)) !== null) {
        if (isPage(mm[1])) urls.push(mm[1]);
      }
      if (!urls.length) continue;
      // Object form: "images":[{"url":"..."}] — pull "url":"..."
      // The above already covers raw "...jpg" strings; objects are handled by
      // the same scan because the URLs appear within the bracketed body.
      candidates.push(urls);
    }

    if (candidates.length) {
      // Prefer arrays scoped to this series slug.
      let pick = null;
      if (escSlug) {
        const slugRe = new RegExp(`/uploads/series/${escSlug}/`, 'i');
        pick = candidates
          .filter(a => a.some(u => slugRe.test(u)))
          .sort((a, b) => b.length - a.length)[0] || null;
      }
      if (!pick) pick = candidates.sort((a, b) => b.length - a.length)[0];
      if (pick) {
        pick.forEach(push);
        if (out.length) {
          console.info('[TempleToons] images extracted (strategy 1)', { url, count: out.length });
          return restrictToDominantFolder(out);
        }
      }
    }

    // ----------------------------------------------------------------
    // STRATEGY 2: Object-form image lists — "images":[{"url":"..."}]
    // (Catches variants where order/width metadata is included.)
    // ----------------------------------------------------------------
    const objRe = /"images"\s*:\s*\[\s*\{[\s\S]{0,200000}?\}\s*\]/gi;
    let om;
    while ((om = objRe.exec(decoded)) !== null) {
      const urlRe = /"url"\s*:\s*"(https?:\/\/media\.templetoons\.com\/file\/[^"\\]+?\.(?:webp|jpg|jpeg|png|avif))"/gi;
      let mm;
      while ((mm = urlRe.exec(om[0])) !== null) push(mm[1]);
    }
    if (out.length) {
      console.info('[TempleToons] images extracted (strategy 2)', { url, count: out.length });
      return restrictToDominantFolder(out);
    }

    // ----------------------------------------------------------------
    // STRATEGY 3: Series-slug-scoped regex over the decoded payload, plus
    // an unconditional generic /uploads/series/.../ sweep. The decoded
    // payload now has \" → " unescaping applied, so URLs that used to be
    // wrapped in \" pairs are now plain JSON strings.
    // ----------------------------------------------------------------
    if (escSlug) {
      const seriesRe = new RegExp(
        `https?:\\/\\/media\\.templetoons\\.com\\/file\\/[^"'\\s<>\\\\]+?\\/uploads\\/series\\/${escSlug}\\/[^"'\\s<>\\\\]+?\\.(?:webp|jpg|jpeg|png|avif)`,
        'gi'
      );
      let m;
      while ((m = seriesRe.exec(decoded)) !== null) push(m[0]);
      if (out.length) return restrictToDominantFolder(out);
    }
    // Generic series-uploads sweep (slug-agnostic) — catches series whose
    // CDN folder name differs from the URL slug.
    const genericRe = /https?:\/\/media\.templetoons\.com\/file\/[^"'\s<>\\]+?\/uploads\/series\/[^"'\s<>\\]+?\.(?:webp|jpg|jpeg|png|avif)/gi;
    let gm;
    while ((gm = genericRe.exec(decoded)) !== null) push(gm[0]);
    if (out.length) return restrictToDominantFolder(out);

    // ----------------------------------------------------------------
    // STRATEGY 4: DOM scan for <img> tags inside the reader area.
    // (Lazy-loaded variants: src / data-src / data-lazy-src / data-original.)
    // ----------------------------------------------------------------
    try {
      const doc = new DOMParser().parseFromString(decoded, 'text/html');
      const imgs = [...doc.querySelectorAll('img')];
      const attrs = ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-srcset', 'srcset'];
      for (const img of imgs) {
        for (const a of attrs) {
          const v = img.getAttribute(a);
          if (!v) continue;
          if (/srcset/i.test(a)) {
            v.split(',').forEach(part => push(part.trim().split(/\s+/)[0]));
          } else {
            push(v);
          }
        }
      }
      if (out.length) return out;
    } catch { /* DOMParser unavailable — ignore */ }

    // ----------------------------------------------------------------
    // STRATEGY 5: Tail-after-last-chapter_thumbnail sweep (legacy fallback).
    // ----------------------------------------------------------------
    const lastThumb = decoded.lastIndexOf('chapter_thumbnail');
    if (lastThumb > -1) {
      const tail = decoded.slice(lastThumb);
      const tailRe = /https?:\/\/media\.templetoons\.com\/file\/[^"'\\\s<>]+?\.(?:webp|jpg|jpeg|png|avif)/gi;
      let tm;
      while ((tm = tailRe.exec(tail)) !== null) push(tm[0]);
      if (out.length) return out;
    }

    // ----------------------------------------------------------------
    // STRATEGY 6: Final sweep — every media URL that is not a cover/thumb.
    // ----------------------------------------------------------------
    const allRe = /https?:\/\/media\.templetoons\.com\/file\/[^"'\\\s<>]+?\.(?:webp|jpg|jpeg|png|avif)/gi;
    let m6;
    while ((m6 = allRe.exec(decoded)) !== null) push(m6[0]);

    if (!out.length) {
      console.warn('[TempleToons] No images extracted for chapter', {
        url, slug, chapterSlug,
        htmlLength: (html || '').length,
        decodedLength: decoded.length,
        hasMediaHost: /media\.templetoons\.com/.test(decoded),
        hasUploadsSeries: /\/uploads\/series\//.test(decoded),
        hint: 'Try refetching — the proxy may have returned a stripped page.',
        head: decoded.slice(0, 200).replace(/\s+/g, ' ')
      });
    } else {
      console.info('[TempleToons] images extracted (fallback)', { url, count: out.length });
    }
    return restrictToDominantFolder(out);
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
  const SERIES_PATTERN = /^https?:\/\/(www\.)?templetoons\.com\/comic\/[^/?#]+\/?(?:[?#].*)?$/i;
  base.seriesUrlPattern = SERIES_PATTERN;
  base.detectSeries = function (url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') === 'templetoons.com' && SERIES_PATTERN.test(url);
    } catch { return false; }
  };
  base.getSeriesSlug = function (url) {
    const m = String(url).match(/\/comic\/([^/?#]+)/i);
    return m ? m[1] : '';
  };

  async function fetchSeriesPage(url) {
    return window.SourceConfig.fetchPage(url, {
      validator: (h) => /chapter_slug|chapter_name|media\.templetoons\.com|templetoons|comic\//i.test(h)
    });
  }

  function decodeJsonString(s) { try { return JSON.parse('"' + s + '"'); } catch { return s; } }
  function unescapeUrl(u) { return String(u || '').replace(/\\\//g, '/').replace(/\\u002F/gi, '/'); }

  // Convert chapter slug to a numeric ordering value.
  // Supports: chapter-1, chapter-01, chapter-1-5, chapter-1.5, prologue,
  // epilogue, side-story, side-story-2, extra-1-5, special-3, etc.
  function slugToNumber(slug) {
    if (!slug) return null;
    const s = String(slug).toLowerCase();
    let m = s.match(/^chapter-(\d+)(?:[-.](\d+))?$/);
    if (m) return m[2] ? parseFloat(`${parseInt(m[1], 10)}.${m[2]}`) : parseInt(m[1], 10);
    if (s === 'prologue') return 0;
    if (s === 'epilogue') return 9999;
    m = s.match(/^(side-story|extra|special)(?:-(\d+)(?:[-.](\d+))?)?$/);
    if (m) {
      const n = m[2] ? (m[3] ? parseFloat(`${m[2]}.${m[3]}`) : parseFloat(m[2])) : 0;
      return 0.001 + n / 1000;
    }
    const g = s.match(/(\d+(?:\.\d+)?)/);
    return g ? parseFloat(g[1]) : null;
  }

  base.getSeriesInfo = async function (url) {
    const html = await fetchSeriesPage(url);
    const slug = base.getSeriesSlug(url);

    const ogTitle = (html.match(/<meta property=["']og:title["']\s*content=["']([^"']+)/i) || [])[1] || '';
    const ogImage = (html.match(/<meta property=["']og:image["']\s*content=["']([^"']+)/i) || [])[1] || '';
    const ogDesc  = (html.match(/<meta name=["']description["']\s*content=["']([^"']+)/i) || [])[1] || '';

    const title = (ogTitle.split(/[-–—|]/)[0] || slug.replace(/-/g, ' ')).trim();

    // Accept 0 or 1 backslash around RSC-escaped JSON keys
    const pluck = (key) => {
      const m = html.match(new RegExp(`\\\\?"${key}\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)`, 'i'));
      return m ? decodeJsonString(m[1]).trim() : '';
    };
    const author = pluck('author') || pluck('writer') || undefined;
    const artist = pluck('artist') || pluck('illustrator') || undefined;
    const statusRaw = (pluck('status') || pluck('serialization_status') || '').toLowerCase();
    let status;
    if (statusRaw) {
      const mm = statusRaw.match(/ongoing|completed|complete|hiatus|dropped|cancelled/);
      status = mm ? (mm[0] === 'complete' ? 'completed' : mm[0]) : 'ongoing';
    }

    const genres = [];
    const gre = /\\?"(?:genres?|categories|tags)\\?"\s*:\s*\[([^\]]+)\]/gi;
    let gm;
    while ((gm = gre.exec(html)) !== null) {
      const items = gm[1].match(/\\?"([^"\\]+)\\?"/g) || [];
      items.forEach(s => {
        const v = decodeJsonString(s.replace(/^\\?"/, '').replace(/\\?"$/, '')).trim();
        if (v && v.length < 40 && !genres.includes(v)) genres.push(v);
      });
    }

    // Alternative titles: \"alternative_names\":\"...\" (comma/slash separated)
    const altRaw = pluck('alternative_names') || pluck('alternative_titles') || '';
    const alternativeTitles = altRaw
      ? altRaw.split(/[,;|\/]/).map(s => s.trim()).filter(Boolean)
      : [];

    // Synopsis from the RSC payload when meta description is missing/short
    let description = ogDesc ? ogDesc.trim() : '';
    if (!description || description.length < 40) {
      const d = pluck('description') || pluck('synopsis') || pluck('summary');
      if (d && d.length > description.length) description = d;
    }

    let cover = ogImage ? unescapeUrl(ogImage) : '';
    if (!cover) {
      const cm = html.match(/https?:\/\/media\.templetoons\.com\/file\/[^"'\\\s<>]*\/covers\/[^"'\\\s<>]+?\.(?:webp|jpg|jpeg|png)/i);
      if (cm) cover = unescapeUrl(cm[0]);
    }

    const info = {
      title,
      cover: cover || undefined,
      description: description || undefined,
      author,
      artist,
      status,
      genres: genres.length ? genres : undefined,
      alternativeTitles,
      slug,
      sourceUrl: url
    };

    // LAST RESORT: markdown payload (text proxy) — fill the gaps from it.
    if (window.SourceConfig?.isMarkdownPayload?.(html)) {
      const md = window.SourceConfig.parseMarkdownMeta(html);
      if (!info.title || info.title === slug.replace(/-/g, ' ').trim()) info.title = md.title || info.title;
      if (!info.cover)       info.cover = md.cover || undefined;
      if (!info.description) info.description = md.description || undefined;
      if (!info.author)      info.author = md.author || undefined;
      if (!info.artist)      info.artist = md.artist || undefined;
      if (!info.genres || !info.genres.length) info.genres = md.genres.length ? md.genres : undefined;
      if (md.status)         info.status = md.status;
      console.info('[TempleToons:Series] markdown fallback metadata applied');
    }

    return info;
  };

  base.getChapterList = async function (url) {
    const html = await fetchSeriesPage(url);
    const slug = base.getSeriesSlug(url);
    const origin = 'https://templetoons.com';
    const map = new Map();

    // PRIMARY: extract chapter_slug values from the escaped RSC JSON.
    // Bytes look like:  \"chapter_slug\":\"chapter-19\"
    // (i.e. one backslash + double-quote around the key and the value).
    // The regex accepts 0 or 1 backslash for robustness.
    const slugRe = /\\?"chapter_slug\\?"\s*:\s*\\?"([a-z0-9._-]+?)\\?"/gi;
    let sm;
    const slugs = new Set();
    while ((sm = slugRe.exec(html)) !== null) {
      slugs.add(sm[1].toLowerCase());
    }

    // Optional: chapter_name / chapter_title → friendlier label, indexed by
    // slug. In the live RSC payload each entry is laid out as:
    //   "index","chapter_name","chapter_title","chapter_data"{...images...},
    //   "chapter_thumbnail","chapter_slug"
    // i.e. the name comes BEFORE the slug with a large gap (the image list).
    // The gap guard (?!chapter_slug|chapter_name) prevents pairing across
    // adjacent entries no matter how large the budget is.
    const gap = '(?:(?!chapter_slug|chapter_name)[\\s\\S]){0,6000}?';
    const labelBySlug = new Map();
    const pairRe = new RegExp(
      `\\\\?"chapter_name\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)\\\\?"${gap}\\\\?"chapter_slug\\\\?"\\s*:\\s*\\\\?"([a-z0-9._-]+?)\\\\?"`,
      'gi'
    );
    let sm2;
    while ((sm2 = pairRe.exec(html)) !== null) {
      labelBySlug.set(sm2[2].toLowerCase(), decodeJsonString(sm2[1]).trim());
    }
    const titleBySlug = new Map();
    const titlePair = new RegExp(
      `\\\\?"chapter_title\\\\?"\\s*:\\s*\\\\?"([^"\\\\]+)\\\\?"${gap}\\\\?"chapter_slug\\\\?"\\s*:\\s*\\\\?"([a-z0-9._-]+?)\\\\?"`,
      'gi'
    );
    while ((sm2 = titlePair.exec(html)) !== null) {
      const t = decodeJsonString(sm2[1]).trim();
      if (t && t !== 'null') titleBySlug.set(sm2[2].toLowerCase(), t);
    }

    for (const cslug of slugs) {
      const number = slugToNumber(cslug);
      if (!Number.isFinite(number) || map.has(number)) continue;
      const baseLabel = labelBySlug.get(cslug) || cslug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
      const titleExtra = titleBySlug.get(cslug);
      map.set(number, {
        number,
        title: titleExtra ? `${baseLabel} - ${titleExtra}` : baseLabel,
        url: `${origin}/comic/${slug}/${cslug}`
      });
    }

    // SECONDARY: anchor scrape (in case the layout ever emits direct hrefs).
    const hrefRe = new RegExp(
      `href=["'](?:\\.?\\/|https?:\\/\\/(?:www\\.)?templetoons\\.com\\/)?comic\\/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/([a-z0-9._-]+?)["']`,
      'gi'
    );
    let hm;
    while ((hm = hrefRe.exec(html)) !== null) {
      const cslug = hm[1].toLowerCase().replace(/^\d+-/, '');
      const number = slugToNumber(cslug);
      if (!Number.isFinite(number) || map.has(number)) continue;
      map.set(number, {
        number,
        title: cslug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        url: `${origin}/comic/${slug}/${cslug}`
      });
    }

    // TERTIARY: raw URL sweep — catches markdown payloads and any chapter
    // URLs embedded in scripts/JSON that the patterns above missed.
    const rawRe = new RegExp(
      `https?:\\/\\/(?:www\\.)?templetoons\\.com\\/comic\\/${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/([a-z0-9._-]+)`,
      'gi'
    );
    let rm;
    while ((rm = rawRe.exec(html)) !== null) {
      const cslug = rm[1].toLowerCase().replace(/^\d+-/, '').replace(/[.,;:!?]+$/, '');
      const number = slugToNumber(cslug);
      if (!Number.isFinite(number) || map.has(number)) continue;
      map.set(number, {
        number,
        title: cslug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        url: `${origin}/comic/${slug}/${cslug}`
      });
    }

    const list = [...map.values()].sort((a, b) => a.number - b.number);
    if (list.length === 0) {
      const sample = html.slice(0, 400).replace(/\s+/g, ' ');
      console.warn('[TempleToons:Series] empty chapter list — payload head:', sample);
      throw new Error(
        `No chapters found on TempleToons series page (slug="${slug}", payload ${html.length} chars). ` +
        `The proxy may have returned a stripped page — try Refetch.`
      );
    }
    console.info('[TempleToons:Series] Chapter list extracted', { url, count: list.length });
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
})(SourceTempleToons);

window.SourceTempleToons = SourceTempleToons;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceTempleToons);
}
