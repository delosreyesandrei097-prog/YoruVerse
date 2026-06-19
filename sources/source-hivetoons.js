/**
 * ============================================================
 * MANHWA PLATFORM - HIVETOONS SOURCE PLUGIN
 * ============================================================
 * Site: https://hivetoons.org
 * Chapter URL: https://hivetoons.org/series/<slug>/chapter-<num>
 * Series  URL: https://hivetoons.org/series/<slug>
 *
 * Hivetoons is an Astro-rendered site, same packing convention as
 * Vortex Scans: per-key strings appear as
 *     &quot;chapterTitle&quot;:[0,&quot;...&quot;]
 * inside script payloads. Chapter images live on the storage CDN:
 *     https://storage.hivetoon.com/public/upload/series/<slug>/<uuid>/page-XXXX....(webp|jpg|jpeg|png)
 * ============================================================
 */

const SourceHiveToons = {
  name: 'HiveToons',
  domain: 'hivetoons.org',

  patterns: [
    /hivetoons\.org\/series\/[^/]+\/chapter-[\d.]+/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('hivetoons.org') &&
             this.patterns.some(p => p.test(url));
    } catch {
      return false;
    }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (html) => /storage\.hivetoon\.com|chapterNumber|chapterTitle|seriesSlug/i.test(html)
    });
  },

  async extract(url) {
    const html = await this.fetchPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const data = {
      chapterTitle: this.extractTitle(doc, html, url),
      chapterNumber: this.extractChapterNumber(url, html),
      imageUrls: this.extractImageUrls(html),
      seriesTitle: this.extractSeriesTitle(doc, html, url),
      source: this.name,
      sourceUrl: url
    };

    if (!this.validate(data)) {
      throw new Error('Could not extract valid chapter data. Site structure may have changed.');
    }
    return data;
  },

  extractChapterNumber(url, html = '') {
    const fromData = html.match(/(?:&quot;|")chapterNumber(?:&quot;|")\s*:\s*\[0,\s*(\d+(?:\.\d+)?)/i);
    if (fromData) return parseFloat(fromData[1]);

    const titleMatch = html.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
    if (titleMatch) return parseFloat(titleMatch[1]);

    // Accept dash-style decimal (chapter-2-5) as well as dot (chapter-2.5).
    const m = url.match(/chapter-(\d+(?:[.-]\d+)?)/i);
    return m ? parseFloat(String(m[1]).replace('-', '.')) : null;
  },

  extractSeriesSlug(url) {
    const m = url.match(/\/series\/([^/]+)/i);
    return m ? m[1] : '';
  },

  extractTitle(doc, html = '', url = '') {
    const chapterTitle = this.findPackedString(html, 'chapterTitle');
    const chapterNumber = this.extractChapterNumber(url, html);
    if (chapterTitle && chapterNumber != null) return `Chapter ${chapterNumber} - ${chapterTitle}`;
    if (chapterTitle) return chapterTitle;

    const og = doc.querySelector('meta[property="og:title"]');
    if (og?.content) return og.content.trim();
    const t = doc.querySelector('title');
    return t?.textContent?.trim() || null;
  },

  extractSeriesTitle(doc, html, url) {
    const packed = this.findPackedString(html, 'seriesTitle');
    if (packed) return packed;

    const full = this.extractTitle(doc, html, url) || '';
    const cleaned = full.replace(/\s*Chapter\s*\d+(\.\d+)?.*$/i, '').trim();
    if (cleaned) return cleaned;

    const slug = this.extractSeriesSlug(url);
    return slug
      ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : null;
  },

  extractImageUrls(html) {
    const decodedHtml = this.decodeHtml(html);
    const normalized = decodedHtml.replace(/\\u002F/g, '/').replace(/\\\//g, '/');
    const direct = /https:\/\/storage\.hivetoon\.com\/public\/+upload\/series\/(?!featured\/)[^"'<>\]\)\s]+?\.(?:webp|jpg|jpeg|png)(?:\?[^"'<>\]\)\s]*)?/gi;
    const matches = normalized.match(direct) || [];

    const seen = new Set();
    const urls = [];
    // Track first-seen order so we can fall back to HTML appearance order
    // when a filename doesn't carry a usable page index.
    const order = new Map();
    for (const u of matches) {
      const clean = u.replace('/public//upload/', '/public/upload/');
      if (!seen.has(clean)) { seen.add(clean); order.set(clean, urls.length); urls.push(clean); }
    }

    // HiveToons filenames take two known shapes:
    //   page-0001-<uuid>.webp           (older "page-NNNN" convention)
    //   1_1_<timestamp>.webp            (current convention — leading page #)
    // The previous sort used the LAST digit run before the extension, which
    // sorted by the trailing timestamp and shuffled pages randomly. The new
    // sort prefers an explicit `page-NNNN` token, falls back to the LEADING
    // digit run in the basename (handles `1_1_...`, `12-...`, etc.), and as
    // a last resort keeps the original HTML appearance order.
    const pageIndex = (u) => {
      const base = u.split('/').pop() || '';
      const m1 = base.match(/page[-_]?(\d+)/i);
      if (m1) return parseInt(m1[1], 10);
      const m2 = base.match(/^(\d+)(?:[_\-.])/);
      if (m2) return parseInt(m2[1], 10);
      return null;
    };

    urls.sort((a, b) => {
      const pa = pageIndex(a);
      const pb = pageIndex(b);
      if (pa != null && pb != null && pa !== pb) return pa - pb;
      if (pa != null && pb == null) return -1;
      if (pa == null && pb != null) return 1;
      return order.get(a) - order.get(b);
    });

    return urls;
  },

  findPackedString(html, key) {
    const escapedPattern = new RegExp(`&quot;${key}&quot;:\\[0,&quot;([^&]+?)&quot;\\]`, 'i');
    const escapedMatch = html.match(escapedPattern);
    if (escapedMatch) return this.decodeHtml(escapedMatch[1]).trim();

    const jsonPattern = new RegExp(`"${key}"\\s*:\\s*\\[0,"([^"]+?)"\\]`, 'i');
    const jsonMatch = html.match(jsonPattern);
    return jsonMatch ? this.decodeHtml(jsonMatch[1]).trim() : null;
  },

  decodeHtml(value) {
    const textarea = document.createElement('textarea');
    textarea.innerHTML = value;
    return textarea.value;
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

window.SourceHiveToons = SourceHiveToons;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceHiveToons);
}
