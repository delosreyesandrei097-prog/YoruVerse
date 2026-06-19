/**
 * ============================================================
 * MANHWA PLATFORM - MADARASCANS SOURCE PLUGIN
 * ============================================================
 * Site: https://madarascans.com   (custom WP "mangareader" theme)
 *
 * Chapter URL: https://madarascans.com/<series-slug>-chapter-<num>(-N)*(/?)
 *   - Chapter number can contain decimals using dashes:
 *       chapter-49-2     -> 49.2
 *       chapter-49-1-2   -> 49.1 (the trailing -2 is a "fix" / re-upload)
 *       chapter-35-5     -> 35.5
 *   - Image markup:
 *       <img class="ts-main-image" data-index="0" src="..."/>
 *
 * Series URL: https://madarascans.com/series/<slug>/
 *   - Title:       h1.lh-title
 *   - Cover:       .lh-poster img[src]
 *   - Synopsis:    #manga-story
 *   - Status:      .status-badge-lux text
 *   - Genres:      .lh-genres a.lh-genre-tag
 *   - Chapters:    .ch-item[data-ch]  -> a.ch-main-anchor[href]
 *
 * The series page exposes the canonical chapter number via
 * `data-ch="51.2"`, so we trust it over URL parsing whenever
 * possible.
 * ============================================================
 */

const SourceMadaraScans = {
  name: 'MadaraScans',
  domain: 'madarascans.com',

  patterns: [
    // Chapter URLs sit at the site root and end with `-chapter-<num>(-N)*`.
    /^https?:\/\/(www\.)?madarascans\.com\/[a-z0-9][a-z0-9-]*-chapter-\d+(?:-\d+)*\/?(?:[?#].*)?$/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      if (u.hostname.replace(/^www\./, '') !== 'madarascans.com') return false;
      // Series pages also live under /series/<slug>/ — exclude them from the
      // chapter detector so the series detector wins.
      if (/\/series\/[^/]+\/?$/i.test(u.pathname)) return false;
      return this.patterns.some(p => p.test(url));
    } catch { return false; }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    console.info(`[${this.name}] Fetching chapter page`, { url });
    return window.SourceConfig.fetchPage(url, {
      validator: (html) => {
        const isChallenge = this.isCloudflareChallenge(html);
        if (isChallenge) {
          console.error(`[${this.name}] Cloudflare verification page returned for chapter`, { url });
          return false;
        }
        const hasReaderData = /ts-main-image|wp-manga-chapter-img|chapter-preloaded-images|chapter_preloaded_images|reader-area|readerarea|reading-content|legendary-reader-wrap|wp-theme-mangareader|wp-content\/uploads\//i.test(html);
        if (!hasReaderData) {
          console.warn(`[${this.name}] Chapter HTML did not contain known reader markers`, {
            url,
            length: String(html || '').length,
            sample: String(html || '').slice(0, 240)
          });
        }
        return hasReaderData;
      }
    });
  },

  async extract(url) {
    const html = await this.fetchPage(url);

    if (this.isCloudflareChallenge(html)) {
      throw new Error('MadaraScans Cloudflare verification page was returned instead of chapter HTML. Open MadaraScans in the same browser, finish verification, then retry, or configure a Cloudflare-capable SourceConfig.proxyUrl.');
    }

    // Premium / login-walled chapters render a "lock-container" instead of
    // the reader. Surface a clear error so the UI tells the user why.
    if (/class="lock-container"|class="lock-status"|This chapter is locked/i.test(html)) {
      throw new Error('MadaraScans: this chapter is locked (premium / login required).');
    }

    const doc = new DOMParser().parseFromString(html, 'text/html');

    const data = {
      chapterTitle: this.extractTitle(doc, url),
      chapterNumber: this.extractChapterNumber(doc, url),
      imageUrls: this.extractImageUrls(doc, html, url),
      seriesTitle: this.extractSeriesTitle(doc, url),
      source: this.name,
      sourceUrl: url
    };

    if (!this.validate(data)) {
      throw new Error('Could not extract valid chapter data. Site structure may have changed.');
    }
    return data;
  },

  // ---------- helpers ----------
  extractChapterNumber(doc, url) {
    const badge = doc.querySelector('.reader-chapter-badge, .ch-num')?.textContent || '';
    const m1 = badge.match(/(\d+(?:\.\d+)?)/);
    if (m1) return parseFloat(m1[1]);

    // URL fallback: last "-chapter-XX(-Y)?" group.
    const m = url.match(/-chapter-(\d+)(?:-(\d+))?(?:-\d+)?\/?$/i);
    if (!m) return null;
    return m[2] ? parseFloat(`${m[1]}.${m[2]}`) : parseFloat(m[1]);
  },

  extractTitle(doc, url) {
    const t = doc.querySelector('.reader-chapter-badge')?.textContent?.trim();
    if (t) return t;
    const og = doc.querySelector('meta[property="og:title"]')?.getAttribute('content');
    if (og) return og.split('|')[0].trim();
    const num = this.extractChapterNumber(doc, url);
    return num != null ? `Chapter ${num}` : null;
  },

  extractSeriesTitle(doc, url) {
    const series = doc.querySelector('.reader-manga-title')?.textContent?.trim();
    if (series) return series;
    const back = doc.querySelector('.reader-back-btn[href*="/series/"]')?.getAttribute('href') || '';
    const m = back.match(/\/series\/([^/?#]+)/i);
    if (m) return prettifySlug(m[1]);
    return null;
  },

  isCloudflareChallenge(html) {
    return /Just a moment|cf-browser-verification|challenges\.cloudflare\.com|Performing security verification|verify you are not a bot|cf-chl/i.test(String(html || ''));
  },

  extractImageUrls(doc, html, pageUrl) {
    const seen = new Set();
    const out = [];
    const rawHtml = String(html || '');
    const htmlVariants = [
      rawHtml,
      rawHtml.replace(/\\\//g, '/').replace(/\\u002F/gi, '/'),
      rawHtml.replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&')
    ];

    const add = (raw, source = 'unknown') => {
      const src = this.normalizeImageUrl(raw, pageUrl);
      if (!src) return;
      if (!/\.(?:webp|jpg|jpeg|png|avif)(?:[?#].*)?$/i.test(src)) return;
      if (/placeholder|default-avatar|\/themes\/mangareader\/assets\/images\/logo|favicon|\/uploads\/.*-150x150\./i.test(src)) return;
      if (seen.has(src)) return;
      seen.add(src);
      out.push(SourceMadaraScans.toProxiedImageUrl(src));
      console.debug?.(`[${this.name}] image ${out.length} from ${source}:`, src);
    };

    // Primary: DOM order from all known Madara / WP Manga reader image nodes.
    const imgs = [...doc.querySelectorAll([
      'img.ts-main-image',
      'img.wp-manga-chapter-img',
      '#readerarea img',
      '.reader-area img',
      '.reading-content img',
      '.entry-content img',
      '.chapter-content img',
      'picture source[srcset]',
      'img[src*="/wp-content/uploads/"]',
      'img[data-src*="/wp-content/uploads/"]',
      'img[data-lazy-src*="/wp-content/uploads/"]'
    ].join(','))];
    imgs.sort((a, b) => {
      const ia = parseInt(a.getAttribute('data-index') || a.getAttribute('data-page') || '0', 10);
      const ib = parseInt(b.getAttribute('data-index') || b.getAttribute('data-page') || '0', 10);
      return ia - ib;
    });
    const attrs = ['src', 'data-src', 'data-lazy-src', 'data-original', 'data-cfsrc', 'data-full', 'content'];
    for (const img of imgs) {
      attrs.forEach(attr => add(img.getAttribute(attr), `img[${attr}]`));
      const srcset = img.getAttribute('srcset') || img.getAttribute('data-srcset') || img.getAttribute('data-lazy-srcset') || '';
      srcset.split(',').forEach(part => add(part.trim().split(/\s+/)[0], 'srcset'));
    }
    if (out.length > 0) return out;

    // Fallbacks: sweep raw, escaped, and entity-decoded HTML/JS for reader image URLs.
    const patterns = [
      /https?:\/\/(?:www\.)?madarascans\.com\/wp-content\/uploads\/[^"'<>\s)\\]+?\.(?:webp|jpg|jpeg|png|avif)(?:\?[^"'<>\s)]*)?/gi,
      /https?:\\\/\\\/(?:www\\\.)?madarascans\\\.com\\\/wp-content\\\/uploads\\\/[^"'<>\s)]+?\.(?:webp|jpg|jpeg|png|avif)(?:\\?[^"'<>\s)]*)?/gi,
      /\/wp-content\/uploads\/[^"'<>\s)\\]+?\.(?:webp|jpg|jpeg|png|avif)(?:\?[^"'<>\s)]*)?/gi,
      /(?:src|data-src|data-lazy-src|data-original|data-cfsrc|content)["'\s:=]+([^"'<>\s]+\.(?:webp|jpg|jpeg|png|avif)(?:\?[^"'<>\s]*)?)/gi
    ];
    for (const variant of htmlVariants) {
      for (const re of patterns) {
        let m;
        while ((m = re.exec(variant)) !== null) add(m[1] || m[0], 'regex/html-js');
      }
    }

    if (out.length === 0) {
      console.error(`[${this.name}] No chapter images extracted`, {
        pageUrl,
        cloudflare: this.isCloudflareChallenge(rawHtml),
        htmlLength: rawHtml.length,
        hint: 'If Cloudflare is active, complete MadaraScans verification in the same browser/WebView or configure SourceConfig.proxyUrl with a Cloudflare-capable browser proxy.'
      });
    }
    return out;
  },

  normalizeImageUrl(raw, pageUrl) {
    let src = String(raw || '')
      .trim()
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#34;/g, '"')
      .replace(/\\u002F/gi, '/')
      .replace(/\\\//g, '/');
    if (!src || /^data:/i.test(src)) return '';
    src = src.replace(/^url\((['"]?)(.*?)\1\)$/i, '$2').trim();
    src = src.replace(/^['"]|['"]$/g, '');
    try {
      return new URL(src, pageUrl || 'https://madarascans.com/').href;
    } catch {
      return '';
    }
  },

  /**
   * Return direct MadaraScans image URLs by default.
   *
   * The previous version forced every image through wsrv.nl. That proxy does
   * not carry the browser's Cloudflare clearance cookie, so MadaraScans still
   * returned 403 and the app saved broken thumbnails/pages. Direct URLs let
   * images load with the same browser session after the user has completed
   * MadaraScans verification. If you run your own Cloudflare-capable image
   * proxy, set SourceConfig.madaraImageProxyUrl or SourceConfig.imageProxyUrl
   * with {url}/{rawUrl}; otherwise no proxy is used.
   */
  toProxiedImageUrl(rawUrl) {
    const url = String(rawUrl || '').trim();
    if (!url) return url;
    if (/^https?:\/\/(?:images\.)?wsrv\.nl\//i.test(url)) {
      try {
        const nested = new URL(url).searchParams.get('url') || '';
        return nested ? this.normalizeImageUrl(/^https?:\/\//i.test(nested) ? nested : `https://${nested}`) : url;
      } catch {
        return url;
      }
    }
    if (!/^https?:\/\/(?:[a-z0-9-]+\.)?madarascans\.com\//i.test(url)) return url;
    const template = window.SourceConfig?.madaraImageProxyUrl || window.SourceConfig?.imageProxyUrl || '';
    if (!template) return url;
    if (template.includes('{rawUrl}')) return template.replace('{rawUrl}', url);
    if (template.includes('{url}')) return template.replace('{url}', encodeURIComponent(url));
    return template + encodeURIComponent(url);
  },

  validate(data) {
    if (!data.imageUrls || data.imageUrls.length === 0) {
      console.error(`[${this.name}] No images extracted`, {
        sourceUrl: data.sourceUrl,
        chapterNumber: data.chapterNumber,
        hint: 'MadaraScans may have returned a Cloudflare verification page or changed reader markup.'
      });
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

window.SourceMadaraScans = SourceMadaraScans;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceMadaraScans);
}
