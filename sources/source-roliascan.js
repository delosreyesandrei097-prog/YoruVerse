/**
 * ============================================================
 * MANHWA PLATFORM - ROLIASCAN SOURCE PLUGIN
 * ============================================================
 * Site: https://roliascan.com   (WordPress + MangaPeak theme)
 *
 * Chapter URL: https://roliascan.com/read/<series-slug>/ch<num>-<chapter_id>
 *   - The trailing numeric segment IS the WP chapter post id.
 *
 * Image source: the site exposes a public-ish JSON endpoint that
 * returns the ordered image list for a chapter:
 *     GET https://roliascan.com/auth/chapter-content?chapter_id=<id>
 *   -> { success, chapter_type, images: [...], total }
 *
 * Images themselves are hosted on a sister storage domain:
 *     https://roliascan.org/storage/chapters/manhwa_<mangaId>_<chapNum>/NNN.png
 * ============================================================
 */

const SourceRoliaScan = {
  name: 'RoliaScan',
  domain: 'roliascan.com',

  patterns: [
    // Accept numeric, dash-decimal, and special slugs (prologue/extra/etc.)
    /roliascan\.com\/read\/[^/]+\/ch[\w.\-]+-\d+/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('roliascan.com') &&
             this.patterns.some(p => p.test(url));
    } catch {
      return false;
    }
  },

  // ---------- url parsing ----------
  parseChapterUrl(url) {
    // The chapter id is ALWAYS the final `-<digits>` segment of the path.
    // Whatever sits between `ch` and that final id is the chapter "number"
    // (which can be 152, 152.5, 152-5, prologue, extra-1, side-story-2, ...).
    const m = String(url).match(/\/read\/([^/]+)\/ch(.+?)-(\d+)(?:\/|$|[?#])/i);
    if (!m) return null;
    const rawNum = m[2];
    // Treat dash as decimal separator when it sits between two digit groups
    // (e.g. "152-5" -> 152.5) so the API receives the correct chapter id.
    const normalized = rawNum.replace(/^(\d+)-(\d+)$/, '$1.$2');
    const parsed = parseFloat(normalized);
    return {
      seriesSlug: m[1],
      chapterNumber: Number.isFinite(parsed) ? parsed : null,
      chapterLabel: rawNum,
      chapterId: parseInt(m[3], 10)
    };
  },

  // ---------- fetching ----------
  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (html) => /roliascan|mangapeak|chapter|manga/i.test(html)
    });
  },

  async fetchJson(url) {
    // Use SourceConfig.fetchPage if it can return JSON-as-text, then parse.
    const text = await window.SourceConfig.fetchPage(url, {
      validator: (t) => /"images"|"success"|"chapter_id"/i.test(t)
    });
    const normalized = this.extractJsonText(text);
    try {
      return JSON.parse(normalized);
    } catch {
      // Some proxies wrap in JSON envelopes (e.g. allorigins /get)
      try {
        const wrapped = JSON.parse(normalized);
        if (wrapped && typeof wrapped.contents === 'string') {
          return JSON.parse(wrapped.contents);
        }
      } catch {}
      throw new Error('RoliaScan API returned non-JSON response');
    }
  },

  // ---------- main extraction ----------
  async extract(url) {
    const parsed = this.parseChapterUrl(url);
    if (!parsed) throw new Error('Unrecognized RoliaScan chapter URL');

    // 1) Always fetch the canonical image list from the JSON endpoint.
    const apiUrl = `https://roliascan.com/auth/chapter-content?chapter_id=${parsed.chapterId}`;
    let imageUrls = [];
    try {
      const json = await this.fetchJson(apiUrl);
      if (json && Array.isArray(json.images)) {
        imageUrls = json.images.filter(u => typeof u === 'string' && /^https?:\/\//i.test(u));
      }
    } catch (e) {
      console.warn(`[${this.name}] chapter-content API failed, falling back to HTML scrape`, e);
    }

    // 2) Fetch the HTML for titles + as a fallback image source.
    let chapterTitle = `Chapter ${parsed.chapterNumber}`;
    let seriesTitle = prettifySlug(parsed.seriesSlug);
    try {
      const html = await this.fetchPage(url);
      const doc = new DOMParser().parseFromString(html, 'text/html');

      const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
      const t  = doc.querySelector('title')?.textContent;
      const raw = (og || t || '').trim();
      // Pattern: "Chapter N - Series Name | Read Manga ..."
      const titled = raw.match(/^(Chapter\s+[\d.]+)\s*[-–]\s*([^|]+)/i);
      if (titled) {
        chapterTitle = `${titled[1].trim()}`;
        seriesTitle  = titled[2].trim();
      } else if (raw) {
        chapterTitle = raw.split('|')[0].trim();
      }

      if (imageUrls.length === 0) {
        imageUrls = this.extractImageUrlsFromHtml(html);
      }
    } catch (e) {
      console.warn(`[${this.name}] HTML fetch failed, using API data only`, e);
    }

    const data = {
      chapterTitle,
      chapterNumber: parsed.chapterNumber,
      chapterLabel: parsed.chapterLabel,
      imageUrls,
      seriesTitle,
      source: this.name,
      sourceUrl: url
    };

    if (!this.validate(data)) {
      throw new Error('Could not extract valid chapter data. Site structure may have changed.');
    }
    return data;
  },

  // Fallback: scan HTML for storage URLs if the API failed.
  extractImageUrlsFromHtml(html) {
    const decoded = decodeHtml(html);
    const fixed = decoded.replace(/https:\/\/roliascan\.com\/%22https:\/\/roliascan\.org/g, 'https://roliascan.org')
                         .replace(/\/\/%22/g, '')
                         .replace(/\\\//g, '/')
                         .replace('/storage//chapters/', '/storage/chapters/');
    const regex = /https?:\/\/roliascan\.org\/storage\/chapters\/[^"'<>\s)]+?\.(?:webp|jpg|jpeg|png)/gi;
    const matches = fixed.match(regex) || [];
    const seen = new Set();
    const urls = [];
    for (const u of matches) if (!seen.has(u)) { seen.add(u); urls.push(u); }
    urls.sort((a, b) => {
      const pa = parseInt((a.match(/\/(\d+)\.(?:webp|jpg|jpeg|png)$/i) || [])[1] || '0', 10);
      const pb = parseInt((b.match(/\/(\d+)\.(?:webp|jpg|jpeg|png)$/i) || [])[1] || '0', 10);
      return pa - pb;
    });
    return urls;
  },

  extractJsonText(text) {
    let t = String(text || '').trim();
    const marker = 'Markdown Content:';
    const markerIndex = t.indexOf(marker);
    if (markerIndex !== -1) t = t.slice(markerIndex + marker.length).trim();
    const firstObject = t.indexOf('{');
    const firstArray = t.indexOf('[');
    const starts = [firstObject, firstArray].filter(i => i >= 0);
    if (starts.length) t = t.slice(Math.min(...starts)).trim();
    return t;
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

function decodeHtml(value) {
  const textarea = document.createElement('textarea');
  textarea.innerHTML = value;
  return textarea.value;
}
function prettifySlug(slug) {
  return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
}

window.SourceRoliaScan = SourceRoliaScan;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceRoliaScan);
}
