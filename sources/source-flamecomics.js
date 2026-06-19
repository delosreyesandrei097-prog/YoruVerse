/**
 * ============================================================
 * MANHWA PLATFORM - FLAME COMICS SOURCE PLUGIN
 * ============================================================
 * Site: https://flamecomics.xyz
 *
 * Chapter URL patterns (current, 2026):
 *   https://flamecomics.xyz/series/<series-id>/<chapter-token>
 *     e.g. https://flamecomics.xyz/series/104/00553c6e30f8d137
 *
 * Legacy/synthetic patterns that the importer may still produce
 * (the site redirects these to a 404 page, so we resolve them by
 * looking up the real token from the series page first):
 *   https://flamecomics.xyz/series/<id>/chapter-<num>
 *   https://flamecomics.xyz/read/<slug>/<num>
 *
 * Data source: chapter pages embed everything in <script id="__NEXT_DATA__">.
 *   props.pageProps.chapter = {
 *     series_id, chapter_id, chapter: "52.00", chapter_title,
 *     token: "<hex>",
 *     images: { "0": { name: "TOWERDEF-52-1.jpg", ... }, ... },
 *     title: "<Series Title>"
 *   }
 *   CDN URL:
 *     https://cdn.flamecomics.xyz/uploads/images/series/<series_id>/<token>/<name>
 * ============================================================
 *
 * V2 FIXES (2026-06):
 *   - Site moved to hash-token chapter URLs. The old plugin generated
 *     /chapter-<n> URLs which now return a 404 "Redirecting in 3.4s"
 *     page, so every chapter import failed with
 *     "Could not extract valid chapter data from Flame Comics".
 *   - extractImageUrls now reads the authoritative image array out of
 *     __NEXT_DATA__.pageProps.chapter.images and rebuilds canonical
 *     cdn.flamecomics.xyz URLs from {series_id, token, name}.
 *   - extract() detects a legacy /chapter-<n> URL (or any redirect/404
 *     payload) and transparently resolves the real chapter token from
 *     /series/<id> before re-fetching the real chapter page.
 *   - Multiple fallback selectors keep extraction working if any single
 *     piece of the payload changes again.
 *   - Validation honours special-chapter exceptions (announcements,
 *     0.5 / 1.5 / extra / prologue / epilogue, etc).
 * ============================================================
 */

const SourceFlameComics = {
  name: 'Flame Comics',
  domain: 'flamecomics.xyz',
  cdnBase: 'https://cdn.flamecomics.xyz/uploads/images/series',

  patterns: [
    // Canonical: /series/<series-id>/<hex-token>
    /flamecomics\.xyz\/series\/\d+\/[A-Za-z0-9]+/i,
    // Legacy synthetic shapes (auto-resolved before extraction)
    /flamecomics\.xyz\/series\/[^/]+\/chapter[-_]\d+(?:[.-]\d+)?/i,
    /flamecomics\.xyz\/read\/[^/]+\/[\d.]+/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      if (!u.hostname.endsWith('flamecomics.xyz')) return false;
      // Series root (e.g. /series/<id>) is NOT a chapter URL
      const seg = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      if (seg[0] === 'series' && seg.length < 3) return false;
      return this.patterns.some(re => re.test(url));
    } catch { return false; }
  },

  async fetchPage(url) {
    if (!window.SourceConfig?.fetchPage) {
      throw new Error('SourceConfig.fetchPage is required for CORS-safe extraction.');
    }
    return window.SourceConfig.fetchPage(url, {
      validator: (html) => /flamecomics|__NEXT_DATA__|chapter|reader|page-\d+/i.test(html)
    });
  },

  /**
   * Detect the "Redirecting in 3.4s ... 404" Flame Comics splash that
   * is served whenever a URL doesn't resolve to a real chapter.
   */
  _isRedirectPage(html, nextData) {
    if (!html) return false;
    if (/Redirecting in [\d.]+s|Flame-Chan 404 Error|404\.png/i.test(html)) return true;
    const chapter = nextData?.props?.pageProps?.chapter;
    return !!nextData && !chapter; // valid NEXT_DATA but no chapter payload
  },

  /**
   * Pull (series_id, chapter_number_or_token) out of any of the URL
   * shapes the importer may produce.
   */
  _parseUrlParts(url) {
    const out = { seriesId: null, token: null, chapterNum: null };
    try {
      const u = new URL(url);
      const seg = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      // /series/<series-id>/<token-or-chapterN>
      if (seg[0] === 'series' && seg.length >= 3) {
        out.seriesId = seg[1];
        const tail = seg[2];
        const cm = tail.match(/^chapter[-_](\d+(?:[.-]\d+)?)$/i);
        if (cm) out.chapterNum = parseFloat(cm[1].replace('-', '.'));
        else if (/^[A-Za-z0-9]{6,}$/.test(tail) && /[a-f0-9]/i.test(tail)) out.token = tail;
        else if (/^\d+(?:\.\d+)?$/.test(tail)) out.chapterNum = parseFloat(tail);
      } else if (seg[0] === 'read' && seg.length >= 3) {
        // /read/<slug>/<num>
        out.chapterNum = parseFloat(seg[2]);
      }
    } catch { /* ignore */ }
    return out;
  },

  /**
   * Resolve a synthetic /chapter-<n> URL to the real /<token> URL by
   * loading the series page and matching the chapter number against the
   * NEXT_DATA chapter list.
   */
  async _resolveCanonicalUrl(url) {
    const { seriesId, chapterNum, token } = this._parseUrlParts(url);
    if (!seriesId || token || chapterNum == null) return null;
    const seriesUrl = `https://flamecomics.xyz/series/${seriesId}`;
    try {
      const html = await window.SourceConfig.fetchPage(seriesUrl, {
        validator: (h) => /__NEXT_DATA__|chapters/i.test(h)
      });
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const nd = this.parseNextData(doc);
      const chapters = nd?.props?.pageProps?.chapters;
      if (!Array.isArray(chapters)) return null;
      const match = chapters.find(c => parseFloat(c.chapter) === chapterNum);
      if (!match?.token) return null;
      const resolved = `https://flamecomics.xyz/series/${seriesId}/${match.token}`;
      console.log(`[Flame Comics] resolved ${url} → ${resolved}`);
      return resolved;
    } catch (e) {
      console.warn('[Flame Comics] could not resolve canonical URL:', e.message);
      return null;
    }
  },

  async extract(url) {
    let html = await this.fetchPage(url);
    let doc = new DOMParser().parseFromString(html, 'text/html');
    let nextData = this.parseNextData(doc);

    // If we landed on the 404/redirect splash, look up the real token.
    if (this._isRedirectPage(html, nextData)) {
      const canonical = await this._resolveCanonicalUrl(url);
      if (canonical && canonical !== url) {
        html = await this.fetchPage(canonical);
        doc = new DOMParser().parseFromString(html, 'text/html');
        nextData = this.parseNextData(doc);
        url = canonical;
      }
    }

    const data = {
      chapterTitle: this.extractTitle(doc, html, url, nextData),
      chapterNumber: this.extractChapterNumber(url, html, nextData),
      imageUrls: this.extractImageUrls(doc, html, nextData, url),
      seriesTitle: this.extractSeriesTitle(doc, html, url, nextData),
      source: this.name,
      sourceUrl: url
    };

    if (!this.validate(data)) {
      throw new Error('Could not extract valid chapter data from Flame Comics. Site structure may have changed.');
    }
    return data;
  },

  parseNextData(doc) {
    try {
      const el = doc.querySelector('script#__NEXT_DATA__');
      if (!el) return null;
      return JSON.parse(el.textContent || 'null');
    } catch { return null; }
  },

  extractChapterNumber(url, html = '', nextData = null) {
    const ch = nextData?.props?.pageProps?.chapter;
    const cands = [
      ch?.chapter, ch?.number, ch?.chapter_number,
      nextData?.props?.pageProps?.chapterData?.chapter,
      nextData?.props?.pageProps?.currentChapter?.chapter
    ];
    for (const c of cands) {
      if (c != null && !Number.isNaN(parseFloat(c))) return parseFloat(c);
    }
    const fromUrl = this._parseUrlParts(url).chapterNum;
    if (fromUrl != null) return fromUrl;
    const t = html.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
    return t ? parseFloat(t[1]) : null;
  },

  extractTitle(doc, html, url, nextData) {
    const ch = nextData?.props?.pageProps?.chapter;
    const t = ch?.chapter_title || ch?.title;
    const num = this.extractChapterNumber(url, html, nextData);
    if (t && String(t).trim()) {
      return num != null ? `Chapter ${num} - ${String(t).trim()}` : String(t).trim();
    }
    if (num != null) return `Chapter ${num}`;
    const og = doc.querySelector('meta[property="og:title"]');
    if (og?.content) return og.content.trim();
    const tt = doc.querySelector('title');
    return tt?.textContent?.trim() || null;
  },

  extractSeriesTitle(doc, html, url, nextData) {
    const pp = nextData?.props?.pageProps;
    const t = pp?.chapter?.title ||
              pp?.series?.title ||
              pp?.seriesData?.title ||
              pp?.manga?.title || pp?.comic?.title;
    if (t) return String(t).trim();
    const og = doc.querySelector('meta[property="og:title"]');
    if (og?.content) {
      // "Series Name - Chapter X - Flame Comics"
      return og.content.replace(/\s*[-–|]\s*Chapter\s*\d+(?:\.\d+)?.*$/i, '')
        .replace(/\s*[-–|]\s*Flame Comics\s*$/i, '').trim() || og.content.trim();
    }
    const tt = doc.querySelector('title')?.textContent || '';
    const cleaned = tt.replace(/\s*[-–|]\s*Chapter\s*\d+(?:\.\d+)?.*$/i, '')
                      .replace(/\s*[-–|]\s*Flame Comics\s*$/i, '').trim();
    if (cleaned) return cleaned;
    const sid = this._parseUrlParts(url).seriesId;
    return sid ? `Series ${sid}` : null;
  },

  extractImageUrls(doc, html, nextData, url = '') {
    const out = [];
    const seen = new Set();
    const push = (u) => {
      if (!u) return;
      const v = String(u).trim();
      if (!this.isValidImageUrl(v) || seen.has(v)) return;
      seen.add(v); out.push(v);
    };

    const ch = nextData?.props?.pageProps?.chapter;
    const seriesId = ch?.series_id || this._parseUrlParts(url).seriesId;
    const token = ch?.token || this._parseUrlParts(url).token;

    // 1. __NEXT_DATA__ chapter.images (object keyed "0","1",... in order)
    if (ch?.images && typeof ch.images === 'object' && seriesId && token) {
      const keys = Object.keys(ch.images).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
      for (const k of keys) {
        const entry = ch.images[k];
        if (!entry) continue;
        const name = typeof entry === 'string' ? entry : (entry.name || entry.file || entry.filename);
        if (name && !/^https?:/i.test(name)) {
          push(`${this.cdnBase}/${seriesId}/${token}/${name}`);
        } else if (name) {
          push(name);
        }
      }
    }

    // 2. Generic NEXT_DATA arrays (older shape, just in case)
    if (out.length === 0) {
      const props = nextData?.props?.pageProps;
      const containers = [
        props?.chapter?.pages, props?.chapterData?.images,
        props?.chapterData?.pages, props?.pages, props?.images
      ];
      for (const c of containers) {
        if (Array.isArray(c)) {
          c.forEach(item => {
            if (typeof item === 'string') push(item);
            else if (item && typeof item === 'object') push(item.url || item.src || item.image || item.file);
          });
        }
      }
    }

    // 3. DOM reader
    if (out.length === 0) {
      doc.querySelectorAll('#reader img, .reader img, .chapter-content img, .page-break img, main img').forEach(img => {
        push(img.getAttribute('data-src') || img.getAttribute('data-original') || img.getAttribute('src'));
      });
    }

    // 4. Fallback: any CDN-looking image URL in the raw HTML, restricted
    //    to this chapter's series/token folder when we know it.
    if (out.length === 0) {
      const folderRe = (seriesId && token)
        ? new RegExp(`https?://cdn\\.flamecomics\\.xyz/uploads/images/series/${seriesId}/${token}/[^"'<>\\s]+?\\.(?:webp|jpg|jpeg|png)`, 'gi')
        : /https?:\/\/cdn\.flamecomics\.xyz\/uploads\/images\/series\/\d+\/[A-Za-z0-9]+\/[^"'<>\s]+?\.(?:webp|jpg|jpeg|png)/gi;
      (html.match(folderRe) || []).forEach(push);
    }

    // Remove obvious site-chrome assets that leak in via the fallback.
    return out.filter(u => !/\/assets\/read\/read_on_flame|thumbnail\.jpg|placeholder|favicon/i.test(u));
  },

  isValidImageUrl(url) {
    if (!url || typeof url !== 'string') return false;
    if (url.startsWith('data:')) return false;
    if (/logo|favicon|avatar|placeholder|spacer|icon-|sprite|read_on_flame/i.test(url)) return false;
    return /\.(jpg|jpeg|png|webp|gif)(\?.*)?$/i.test(url);
  },

  validate(data) {
    if (!data.imageUrls || data.imageUrls.length === 0) {
      console.error(`[${this.name}] No images extracted`);
      return false;
    }
    if (data.chapterNumber == null) data.chapterNumber = 1;
    if (!data.chapterTitle) data.chapterTitle = `Chapter ${data.chapterNumber}`;
    // Strict single-image rule (with special-chapter exception) is
    // enforced centrally in source-registry.js / source-validation.js.
    return true;
  }
};

window.SourceFlameComics = SourceFlameComics;
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceFlameComics);
}
