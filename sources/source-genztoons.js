/**
 * ============================================================
 * MANHWA PLATFORM - GENZ TOONS SOURCE PLUGIN
 * ============================================================
 * Site: https://genztoons.org
 * URL pattern: https://genztoons.org/series/<series-slug>/chapter-<num>
 *              https://genztoons.org/<series-slug>/chapter-<num>
 *              https://genztoons.org/read/<series-slug>/chapter-<num>
 *
 * Chapter-level extractor. Mirrors the structure used by the
 * other Madara/Next.js style sources we already support so the
 * plugin remains stable across small site re-skins.
 * ============================================================
 */

const SourceGenZToons = {
  name: 'GenZ Toons',
  domain: 'genztoons.org',

  // GenZ Toons is now a custom Alpine.js site (no longer Madara/WP).
  // Chapter URL pattern: https://genztoons.org/chapter/<id1>-<id2>/
  // Legacy/alt patterns retained for forward-compat.
  patterns: [
    /genztoons\.org\/chapter\/[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\/?/i,
    /genztoons\.org\/(?:series|read)?\/?[^/]+\/chapter[-_/][\d.]+/i,
    /genztoons\.org\/[^/]+-chapter-[\d.]+/i
  ],

  // CDN hosts used by genztoons for chapter pages.
  cdnHosts: ['cdn.meowing.org', 'i0.wp.com', 'wsrv.nl'],

  detect(url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('genztoons.org') &&
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
      validator: (html) => /genztoons|cdn\.meowing\.org|id="pages"|myImage|reading-content|wp-manga/i.test(html)
    });
  },

  async extract(url) {
    const html = await this.fetchPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    const data = {
      chapterTitle: this.extractTitle(doc, html, url),
      chapterNumber: this.extractChapterNumber(url, html, doc),
      imageUrls: this.extractImageUrls(doc, html),
      seriesTitle: this.extractSeriesTitle(doc, html, url),
      source: this.name,
      sourceUrl: url
    };

    if (!this.validate(data)) {
      throw new Error('Could not extract valid chapter data from GenZ Toons. Site structure may have changed.');
    }
    return data;
  },

  extractChapterNumber(url, html = '', doc = null) {
    // Legacy URL form: /chapter-N
    const m = url.match(/chapter[-_/](\d+(?:[.-]\d+)?)/i);
    if (m) return parseFloat(String(m[1]).replace('-', '.'));
    // New site uses opaque hash URLs — derive number from the page chrome.
    if (doc) {
      const og = doc.querySelector('meta[property="og:title"]')?.content || '';
      const t = (og || doc.querySelector('title')?.textContent || '').match(/Chapter\s+(\d+(?:\.\d+)?)/i);
      if (t) return parseFloat(t[1]);
    }
    const t = html.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
    return t ? parseFloat(t[1]) : null;
  },

  extractTitle(doc, html, url) {
    const og = doc.querySelector('meta[property="og:title"]');
    if (og?.content) return og.content.trim();
    const h1 = doc.querySelector('#chapter-heading, h1.entry-title, .reading-content h1, .chapter-title');
    if (h1?.textContent?.trim()) return h1.textContent.trim();
    const t = doc.querySelector('title');
    if (t?.textContent) return t.textContent.trim();
    const num = this.extractChapterNumber(url, html, doc);
    return num != null ? `Chapter ${num}` : null;
  },

  extractSeriesTitle(doc, html, url) {
    const link = doc.querySelector('.breadcrumb a[href*="/series/"], .breadcrumb a[href*="/manga/"], a[rel="up"], a[href*="/series/"]');
    if (link?.textContent?.trim()) {
      const t = link.textContent.trim();
      if (t && t.length < 200 && !/^chapter/i.test(t)) return t;
    }
    const og = doc.querySelector('meta[property="og:novel:novel_name"], meta[property="og:series"]');
    if (og?.content) return og.content.trim();
    const full = this.extractTitle(doc, html, url) || '';
    const cleaned = full.replace(/\s*[-–|]?\s*Chapter\s*\d+(\.\d+)?.*$/i, '').trim();
    if (cleaned && cleaned.length < 200) return cleaned;
    const slug = (url.match(/\/(?:series|read|manga)\/([^/]+)/i) || [])[1] || '';
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : null;
  },

  extractImageUrls(doc, html) {
    const out = [];
    const seen = new Set();
    const push = (src) => {
      if (!src) return;
      let s = String(src).trim();
      if (s.startsWith('//')) s = 'https:' + s;
      if (this.isValidImageUrl(s) && !seen.has(s)) { seen.add(s); out.push(s); }
    };

    // STRATEGY 1 (current site): #pages img — lazy-loaded reader. Real
    // page URL is reconstructed from the `uid` attribute since `src`
    // usually points at a placeholder until the lazy-loader fires.
    const pageImgs = doc.querySelectorAll('#pages img, [id^="pages"] img.myImage, img.myImage');
    pageImgs.forEach(img => {
      const uid = (img.getAttribute('uid') || '').trim();
      if (uid) {
        push(`https://cdn.meowing.org/uploads/${uid}`);
        return;
      }
      const src = (img.getAttribute('data-src') ||
                   img.getAttribute('data-lazy-src') ||
                   img.getAttribute('data-original') ||
                   img.getAttribute('src') || '').trim();
      // Skip placeholder.svg etc.
      if (src && !/placeholder|assets\/images\//i.test(src)) push(src);
    });

    // STRATEGY 2 (legacy Madara/WP layout): reading-content/page-break.
    if (out.length === 0) {
      const containers = doc.querySelectorAll(
        '.reading-content img, .page-break img, .wp-manga-chapter-img, #chapter-content img, .entry-content img'
      );
      containers.forEach(img => {
        const src = (img.getAttribute('data-src') ||
                     img.getAttribute('data-lazy-src') ||
                     img.getAttribute('data-original') ||
                     img.getAttribute('src') || '').trim();
        push(src);
      });
    }

    // STRATEGY 3 (raw HTML sweep): catch uid="..." attributes that the
    // DOM parser may have stripped, and direct CDN URLs.
    if (out.length === 0) {
      const uidRe = /\buid\s*=\s*"([A-Za-z0-9._-]+\.(?:avif|webp|jpe?g|png))"/gi;
      let m;
      while ((m = uidRe.exec(html)) !== null) push(`https://cdn.meowing.org/uploads/${m[1]}`);
    }
    if (out.length === 0) {
      const re = /https?:\/\/(?:cdn\.meowing\.org|i0\.wp\.com\/cdn\.meowing\.org|[a-z0-9-]+\.genztoons\.org|genztoons\.org)\/[^"'<>\s]+?\.(?:avif|webp|jpe?g|png)(?:\?[^"'<>\s]*)?/gi;
      (html.match(re) || []).forEach(push);
    }

    return out;
  },

  isValidImageUrl(url) {
    if (!url || url.startsWith('data:')) return false;
    if (/logo|favicon|avatar|placeholder|spacer|icon-|sprite|iconify|Coin\.svg|hcaptcha|sharethis|ZMIO-logo/i.test(url)) return false;
    // Genz pages use .avif as well as the usual image extensions.
    return /\.(jpg|jpeg|png|webp|gif|avif)(\?.*)?$/i.test(url) ||
           /\/uploads?\//i.test(url);
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

window.SourceGenZToons = SourceGenZToons;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceGenZToons);
}
