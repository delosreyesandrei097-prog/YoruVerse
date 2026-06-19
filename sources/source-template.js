/**
 * ============================================================
 * MANHWA PLATFORM - ASURA SCANS SOURCE PLUGIN
 * ============================================================
 * Supports URLs like:
 * https://asurascans.com/comics/sword-gods-livestream-46f09241/chapter/1
 *
 * Important: Asura blocks normal browser fetches with CORS, so this plugin
 * tries direct fetch first, then public CORS proxy fallbacks.
 *
 * V12 FIXES (Asura plugin):
 *   - Stricter chapter-page validator that REQUIRES real chapter image URLs
 *     or the Astro `chapterNumber` payload. This prevents the chain from
 *     accepting Jina-markdown responses (which only carry comment/profile
 *     images for chapter pages) and silently producing 0-image imports.
 *   - Categorized error messages (network / parsing / validation) so
 *     Auto-Sync logs the real cause instead of a generic
 *     "Failed during import".
 *   - Looser CDN host match for chapter images: optional `www.` and
 *     accept additional asset paths (chapter/, chapters/).
 * ============================================================
 */

const SourceTemplate = {
  name: 'Asura Scans',
  domain: 'asurascans.com',

  patterns: [
    /^https?:\/\/(www\.)?asurascans\.com\/comics\/[^/]+\/chapter\/\d+(?:\.\d+)?\/?(?:[?#].*)?$/i,
    /^https?:\/\/(www\.)?asurascans\.com\/manga\/[^/]+\/chapter-\d+(?:\.\d+)?\/?(?:[?#].*)?$/i,
    /^https?:\/\/(www\.)?asurascans\.com\/series\/[^/]+\/chapter[\/-]\d+(?:\.\d+)?\/?(?:[?#].*)?$/i
  ],

  detect(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace(/^www\./, '') === this.domain &&
        this.patterns.some(pattern => pattern.test(url));
    } catch (error) {
      console.error(`[${this.name}] Error detecting URL:`, error);
      return false;
    }
  },

  /**
   * Stricter validator: only accept payloads that actually contain
   * recognizable Asura chapter content. Rejecting markdown / error
   * pages here is what allows SourceConfig to move to the next proxy
   * instead of returning a body the parser can't use.
   */
  _chapterValidator(html) {
    if (typeof html !== 'string' || html.length < 200) return false;
    if (/cdn\.asurascans\.com\/asura-images\/chapters?\//i.test(html)) return true;
    if (/&quot;chapterNumber&quot;:\[0,\d/i.test(html)) return true;
    if (/"chapterNumber"\s*:\s*\[0,\d/i.test(html)) return true;
    if (/&quot;pages&quot;:\[1,\[/i.test(html)) return true;
    return false;
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (html) => this._chapterValidator(html)
    });
  },

  async extract(url) {
    let html;
    try {
      html = await this.fetchPage(url);
    } catch (err) {
      const msg = (err && err.message) || String(err);
      // SourceConfig.fetchPage exhausts all proxies before throwing — treat
      // as a NETWORK / SOURCE error so Auto-Sync can categorize it.
      const e = new Error(`[${this.name}] Network/source error for ${url}: ${msg}`);
      e.category = 'network';
      throw e;
    }

    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const chapterNumber = this.extractChapterNumber(html, url);
    const imageUrls = this.extractImageUrls(doc, html);
    const seriesTitle = this.extractSeriesTitle(doc, html);
    const chapterData = {
      chapterTitle: this.extractTitle(doc, html, url),
      chapterNumber,
      imageUrls,
      seriesTitle,
      source: this.name,
      sourceUrl: url
    };

    if (!imageUrls || imageUrls.length === 0) {
      const e = new Error(`[${this.name}] Parsing error: no chapter images detected on page (${url}). The proxy may have returned a stripped/markdown payload.`);
      e.category = 'parsing';
      throw e;
    }
    if (chapterNumber == null) {
      const e = new Error(`[${this.name}] Parsing error: chapter number could not be determined for ${url}`);
      e.category = 'parsing';
      throw e;
    }
    if (!this.validate(chapterData)) {
      const e = new Error(`[${this.name}] Validation error: extracted chapter data is incomplete (${url})`);
      e.category = 'validation';
      throw e;
    }

    return chapterData;
  },

  extractTitle(doc, html, url) {
    const seriesTitle = this.extractSeriesTitle(doc, html);
    const chapterNumber = this.extractChapterNumber(html, url);
    const chapterTitle = this.findAstroString(html, 'chapterTitle');

    if (seriesTitle && chapterNumber && chapterTitle) {
      return `${seriesTitle} - Chapter ${chapterNumber} - ${chapterTitle}`;
    }

    if (seriesTitle && chapterNumber) {
      return `${seriesTitle} - Chapter ${chapterNumber}`;
    }

    const h1 = doc.querySelector('h1')?.textContent?.trim();
    return h1 || `Chapter ${chapterNumber || ''}`.trim();
  },

  extractChapterNumber(html, url) {
    const fromAstro = html.match(/&quot;chapterNumber&quot;:\[0,(\d+(?:\.\d+)?)\]/i)
      || html.match(/"chapterNumber"\s*:\s*\[0,(\d+(?:\.\d+)?)\]/i);
    if (fromAstro) return parseFloat(fromAstro[1]);

    const fromUrl = url.match(/\/chapter\/(\d+(?:\.\d+)?)/i) || url.match(/\/chapter-(\d+(?:\.\d+)?)/i);
    if (fromUrl) return parseFloat(fromUrl[1]);

    return null;
  },

  extractImageUrls(doc, html) {
    const urls = [];
    const add = (src) => {
      if (!src) return;

      const clean = src
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .trim();

      // Accept the canonical chapter image host (with optional www.)
      if (!/^https?:\/\/(?:www\.)?cdn\.asurascans\.com\/asura-images\/chapters?\//i.test(clean)) return;
      if (!/\.(webp|jpg|jpeg|png|avif)(?:\?.*)?$/i.test(clean)) return;
      if (!urls.includes(clean)) urls.push(clean);
    };

    doc.querySelectorAll('img').forEach(img => {
      add(img.dataset.src || img.dataset.lazySrc || img.dataset.original || img.getAttribute('src'));
    });

    const imageMatches = html.match(/https?:\/\/(?:www\.)?cdn\.asurascans\.com\/asura-images\/chapters?\/[^"'<>\\\s]+?\.(?:webp|jpg|jpeg|png|avif)/gi) || [];
    imageMatches.forEach(add);

    return urls;
  },

  extractSeriesTitle(doc, html) {
    const fromAstro = this.findAstroString(html, 'seriesName');
    if (fromAstro) return fromAstro;

    const coverAlt = doc.querySelector('img[alt]')?.getAttribute('alt')?.trim();
    if (coverAlt && !/^Page\s+\d+/i.test(coverAlt)) return coverAlt;

    const title = doc.querySelector('title')?.textContent?.trim();
    return title ? this.decodeHtml(title) : null;
  },

  findAstroString(html, key) {
    const escapedPattern = new RegExp(`&quot;${key}&quot;:\\[0,&quot;([\\s\\S]*?)&quot;\\]`, 'i');
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
      console.error(`[${this.name}] Validation failed: no chapter images found`);
      return false;
    }

    if (!data.chapterNumber && data.chapterNumber !== 0) {
      console.error(`[${this.name}] Validation failed: no chapter number found`);
      return false;
    }

    return true;
  }
};

window.SourceTemplate = SourceTemplate;
