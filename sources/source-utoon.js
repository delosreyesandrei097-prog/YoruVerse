/**
 * ============================================================
 * MANHWA PLATFORM - UTOON SOURCE PLUGIN
 * ============================================================
 * Site: https://utoon.net   (WordPress + Madara theme)
 *
 * Chapter URL: https://utoon.net/manga/<slug>/chapter-<num>(-<sub>)?/
 *   - Numeric chapters can also use zero-padded slugs:
 *       chapter-01  -> 1
 *       chapter-12  -> 12
 *       chapter-12-5 -> 12.5
 *   - Image markup (Madara):
 *       <img id="image-N" class="wp-manga-chapter-img"
 *            src="https://utoon.net/wp-content/uploads/WP-manga/data/.../NN.jpg">
 *
 * Series URL: https://utoon.net/manga/<slug>/
 * ============================================================
 */

const SourceUtoon = {
  name: 'Utoon',
  domain: 'utoon.net',

  patterns: [
    /^https?:\/\/(www\.)?utoon\.net\/manga\/[^/]+\/chapter-[\w.-]+\/?(?:[?#].*)?$/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      return u.hostname.replace(/^www\./, '') === 'utoon.net' &&
             this.patterns.some(p => p.test(url));
    } catch { return false; }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (html) => /wp-manga-chapter-img|reading-content|wp-theme-madara|wp-content\/uploads\/WP-manga|chapter-heading/i.test(html)
    });
  },

  async extract(url) {
    const html = await this.fetchPage(url);
    const doc = new DOMParser().parseFromString(html, 'text/html');

    // Premium chapter detection — Madara wraps locked content in
    // .premium-block / sends user to /# placeholder.
    if (/class="[^"]*premium-block[^"]*"|premium-content|please log in to read/i.test(html) &&
        !/wp-manga-chapter-img/i.test(html)) {
      throw new Error('Utoon: this chapter is locked (premium / login required).');
    }

    const data = {
      chapterTitle: this.extractTitle(doc, url),
      chapterNumber: this.extractChapterNumber(url, html),
      imageUrls: this.extractImageUrls(doc, html),
      seriesTitle: this.extractSeriesTitle(doc, url),
      source: this.name,
      sourceUrl: url
    };

    if (!this.validate(data)) {
      throw new Error('Could not extract valid chapter data. Site structure may have changed.');
    }
    return data;
  },

  extractChapterNumber(url, html) {
    // Heading like: "Series - Chapter 12.5"
    const heading = (html.match(/<h1[^>]*id=["']chapter-heading["'][^>]*>([^<]+)<\/h1>/i) || [])[1] || '';
    const m1 = heading.match(/chapter\s+(\d+(?:\.\d+)?)/i);
    if (m1) return parseFloat(m1[1]);

    // URL: chapter-12 / chapter-01 / chapter-12-5
    const m = url.match(/\/chapter-(\d+)(?:-(\d+))?\/?(?:[?#]|$)/i);
    if (!m) return null;
    return m[2] ? parseFloat(`${parseInt(m[1], 10)}.${m[2]}`) : parseInt(m[1], 10);
  },

  extractTitle(doc, url) {
    const h = doc.querySelector('#chapter-heading')?.textContent?.trim();
    if (h) {
      const m = h.match(/Chapter\s+\d+(?:\.\d+)?[^|]*$/i);
      return (m ? m[0] : h).trim();
    }
    const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (og) return og.split('|')[0].trim();
    const num = this.extractChapterNumber(url, '');
    return num != null ? `Chapter ${num}` : null;
  },

  extractSeriesTitle(doc, url) {
    const h = doc.querySelector('#chapter-heading')?.textContent?.trim() || '';
    const m = h.match(/^(.*?)\s+-\s+Chapter\s+\d/i);
    if (m) return m[1].trim();
    const slug = (url.match(/\/manga\/([^/]+)/i) || [])[1] || '';
    return slug ? prettifySlug(slug) : null;
  },

  extractImageUrls(doc, html) {
    const seen = new Set();
    const out = [];

    const imgs = [...doc.querySelectorAll(
      '.reading-content img.wp-manga-chapter-img, .reading-content .page-break img, ' +
      'img.wp-manga-chapter-img'
    )];
    // Prefer DOM order; Madara renders pages sequentially.
    for (const img of imgs) {
      const src = (img.getAttribute('src') ||
                   img.getAttribute('data-src') ||
                   img.getAttribute('data-lazy-src') || '').trim();
      if (src && !seen.has(src)) { seen.add(src); out.push(src); }
    }
    if (out.length > 0) return out;

    // Fallback: scan HTML for Madara's WP-manga/data path.
    const re = /https?:\/\/(?:www\.)?utoon\.net\/wp-content\/uploads\/WP-manga\/data\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png)/gi;
    const matches = html.match(re) || [];
    for (const u of matches) {
      if (/-150x150|-\d+x\d+\./i.test(u)) continue;
      if (!seen.has(u)) { seen.add(u); out.push(u); }
    }
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

function prettifySlug(slug) {
  return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Untitled';
}

window.SourceUtoon = SourceUtoon;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceUtoon);
}
