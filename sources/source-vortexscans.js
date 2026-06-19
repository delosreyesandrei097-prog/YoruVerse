/**
 * ============================================================
 * MANHWA PLATFORM - VORTEX SCANS SOURCE PLUGIN
 * ============================================================
 * Site: https://vortexscans.org
 * URL pattern: https://vortexscans.org/series/<series-slug>/chapter-<num>
 * ============================================================
 *
 * V13 FIXES (2026-06):
 *   - Vortex is now fronted by Cloudflare. Direct fetches return HTTP 503
 *     and the public proxy chain in source-config.js is being hammered
 *     (403/429/503/timeouts), which made every import fail with
 *     "Unable to fetch source page after direct and proxy attempts".
 *
 *   - Introduced a Vortex-specific fetchPage() override that:
 *       1. Sends Googlebot-style User-Agent + Referer headers (CF often
 *          serves the unprotected HTML to crawler UAs).
 *       2. Walks a *Vortex-tailored* proxy chain in addition to the
 *          shared SourceConfig defaults — including the Wayback Machine,
 *          Google web cache and Jina reader (HTML mode) — so we have a
 *          metadata source even when every live proxy is throttled.
 *       3. Caches the last successful HTML for each URL in localStorage
 *          ("stale-while-error") so transient outages no longer break
 *          imports / Auto-Sync. Stale data is returned only AFTER every
 *          live attempt fails, and is clearly logged.
 *       4. Backs off cleanly on 429/503 so we stop spamming dead proxies
 *          within a single import session.
 *
 *   - Hardened validators: chapter HTML may now arrive via Wayback (with
 *     extra wrapper chrome) or Jina markdown (no DOM). Both are accepted
 *     when they still carry the chapter image URLs / chapter metadata.
 *
 * V12 FIXES (2026-06):
 *   - Page ORDER was wrong on the modern site. Vortex now uses filenames
 *     like `image_NNNN_<hash>.webp` where NNNN is an internal sequence id
 *     (often shared between many pages of the same chapter), NOT a page
 *     index. Sorting by NNNN scrambled the pages. The reader markup is
 *     the authoritative source of order: each chapter page is an
 *     `<img data-reader-page-image data-reader-index="N">` inside
 *     `.comic-images-wrapper`, with `alt="... Page N"`.
 *   - extractImageUrls now does a DOM-first pass on those <img> tags,
 *     respecting `data-reader-index` (or document order as a stable
 *     fallback). The regex sweep is kept as a safety net for proxies
 *     that strip the DOM, and only sorts by `page-NNNN` (legacy page
 *     index). `image_NNNN_<hash>` order is left as HTML/document order.
 * V11 FIXES (2026-06):
 *   - Chapter image extraction was failing because Vortex Scans changed
 *     their CDN filenames from `page-XXXX.webp` to
 *     `image_NNNN_<hash>.webp`. The old regex required `/page-` so it
 *     returned 0 images for every recent chapter. The new regex matches
 *     ANY file under `/upload/series/<slug>/<folder>/` and excludes
 *     site-chrome assets (logos, banners under /upload/YYYY/MM/...).
 *   - We scope images to the dominant chapter folder seen in the payload
 *     so prefetched neighbour chapters can't leak into the current one.
 *   - Hardened validator + clearer logging on extraction failure.
 * ============================================================
 */

const SourceVortexScans = {
  name: 'Vortex Scans',
  domain: 'vortexscans.org',

  patterns: [
    // Accept both "." and "-" as the decimal separator in chapter slugs
    // (chapter-2.5 and chapter-2-5 both resolve to 2.5).
    /vortexscans\.org\/series\/[^/]+\/chapter-[\d]+(?:[.-]\d+)?/i
  ],

  detect(url) {
    try {
      const u = new URL(url);
      return u.hostname.endsWith('vortexscans.org') &&
             this.patterns.some(p => p.test(url));
    } catch {
      return false;
    }
  },

  // ----------------------------------------------------------------
  // V13: Vortex-tailored fetcher with stale-cache + extra fallbacks.
  // ----------------------------------------------------------------
  _STALE_PREFIX: 'vortex:stale:',
  _STALE_TTL_MS: 14 * 24 * 60 * 60 * 1000, // 14 days

  _readStale(targetUrl) {
    try {
      const raw = localStorage.getItem(this._STALE_PREFIX + targetUrl);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj || typeof obj.html !== 'string') return null;
      if (Date.now() - (obj.t || 0) > this._STALE_TTL_MS) return null;
      return obj.html;
    } catch { return null; }
  },
  _writeStale(targetUrl, html) {
    try {
      if (!html || html.length < 200) return;
      // Keep stale entries small: trim very large payloads.
      const trimmed = html.length > 600_000 ? html.slice(0, 600_000) : html;
      localStorage.setItem(
        this._STALE_PREFIX + targetUrl,
        JSON.stringify({ t: Date.now(), html: trimmed })
      );
    } catch { /* quota / private-mode — ignore */ }
  },

  // Headers that increase the odds of getting real HTML back from CF /
  // Vortex itself. Googlebot is served the unprotected page; the Referer
  // helps for proxies that forward request headers verbatim.
  _crawlerHeaders() {
    return {
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Referer': 'https://www.google.com/',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    };
  },

  // Build the full ordered list of attempts for a single Vortex URL.
  // Combines the shared SourceConfig chain with Vortex-only fallbacks.
  _buildAttempts(targetUrl) {
    const enc = encodeURIComponent(targetUrl);
    const vortexExtras = [
      // Extra public CORS proxies not in the shared list (rotated set).
      { name: 'vortex proxy (cors.lol)',      url: `https://api.cors.lol/?url=${enc}`,                  isProxy: true },
      { name: 'vortex proxy (corsproxy.org)', url: `https://corsproxy.org/?${enc}`,                     isProxy: true },
      { name: 'vortex proxy (cors-anywhere herokuapp)', url: `https://cors-anywhere.herokuapp.com/${targetUrl}`, isProxy: true },
      // Jina reader in HTML mode (executes JS, returns real HTML).
      { name: 'vortex proxy (r.jina.ai html)',
        url: `https://r.jina.ai/${targetUrl}`,
        isProxy: true,
        headers: { 'x-respond-with': 'html' } },
      // Jina reader in default markdown mode — last resort, plugins have
      // markdown-aware fallbacks.
      { name: 'vortex proxy (r.jina.ai md)',
        url: `https://r.jina.ai/${targetUrl}`,
        isProxy: true,
        isJina: true },
      // Wayback Machine — usually has a recent snapshot, CORS-friendly.
      { name: 'vortex proxy (web.archive.org latest)',
        url: `https://web.archive.org/web/2id_/${targetUrl}`,
        isProxy: true,
        isArchive: true },
      { name: 'vortex proxy (web.archive.org snapshot)',
        url: `https://web.archive.org/web/${targetUrl}`,
        isProxy: true,
        isArchive: true },
      // Google web cache (sometimes accessible through the cors proxies).
      { name: 'vortex proxy (google cache via corsproxy.io)',
        url: `https://corsproxy.io/?${encodeURIComponent('https://webcache.googleusercontent.com/search?q=cache:' + targetUrl)}`,
        isProxy: true }
    ];

    // Pull whatever the shared SourceConfig already configured (direct,
    // user-set proxy, default fallbacks). Those are still useful when
    // the cors.lol / archive route is itself flapping.
    const shared = (window.SourceConfig?.getFetchAttempts?.(targetUrl) || []);
    return [...shared, ...vortexExtras].filter(a => a && a.url);
  },

  async _fetchAttempt(attempt) {
    const cfg = window.SourceConfig || {};
    const controller = new AbortController();
    const timeoutMs = cfg.requestTimeout || 15000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = {
        ...(cfg.customHeaders || {}),
        ...this._crawlerHeaders(),
        ...(attempt.headers || {})
      };
      const res = await fetch(attempt.url, {
        method: 'GET',
        headers,
        signal: controller.signal,
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow'
      });
      if (!res.ok) {
        const e = new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());
        e.status = res.status;
        throw e;
      }
      const text = await res.text();
      return cfg.normalizeProxyResponse ? cfg.normalizeProxyResponse(text) : text;
    } finally {
      clearTimeout(timer);
    }
  },

  async fetchPage(targetUrl, options = {}) {
    if (!window.SourceConfig) {
      throw new Error('SourceConfig is required.');
    }
    const cfg = window.SourceConfig;
    const validator = options.validator || (() => true);
    const challengeRe = /Just a moment|cf-browser-verification|challenges\.cloudflare\.com|Performing security verification|verify you are not a bot|cf-chl|Attention Required.*Cloudflare/i;

    // Per-host rate-limit + short in-proc cache (reuse SourceConfig's).
    try { await cfg.waitForRateLimit?.('vortexscans.org'); } catch {}
    if (!options.noCache) {
      const hit = cfg._cacheGet?.(targetUrl);
      if (hit) return hit;
    }

    const attempts = this._buildAttempts(targetUrl);
    const log = [];
    let lastError = null;

    for (const attempt of attempts) {
      const maxTries = Math.max(1, 1 + ((cfg.retriesPerAttempt | 0) || 0));
      let backoff = cfg.retryBackoffMs || 800;
      for (let t = 0; t < maxTries; t++) {
        const t0 = Date.now();
        try {
          let html = await this._fetchAttempt(attempt);
          if (!html) throw new Error('Empty response body');

          // Wayback wraps real HTML; strip its toolbar so DOM parsing works.
          if (attempt.isArchive) {
            html = html.replace(/<!-- BEGIN WAYBACK TOOLBAR INSERT -->[\s\S]*?<!-- END WAYBACK TOOLBAR INSERT -->/gi, '')
                       .replace(/https?:\/\/web\.archive\.org\/web\/\d+(?:id_)?\//gi, '');
          }

          if (challengeRe.test(html)) throw new Error('Cloudflare challenge page returned');

          // Markdown-mode jina: accept if non-trivial; plugins parse it.
          if (attempt.isJina && html.length > 200) {
            console.log(`[VortexScans] ✓ ${attempt.name} [markdown] (${Date.now() - t0}ms)`);
            this._writeStale(targetUrl, html);
            if (!options.noCache) cfg._cacheSet?.(targetUrl, html);
            return html;
          }

          if (!validator(html)) {
            throw new Error('Response did not pass content validator');
          }

          console.log(`[VortexScans] ✓ ${attempt.name} (${Date.now() - t0}ms)`);
          this._writeStale(targetUrl, html);
          if (!options.noCache) cfg._cacheSet?.(targetUrl, html);
          return html;

        } catch (err) {
          lastError = err;
          const reason = (err && err.name === 'AbortError')
            ? `timeout after ${cfg.requestTimeout || 15000}ms`
            : (err && err.message) || String(err);
          const retryNote = t + 1 < maxTries ? ` (retry ${t + 1}/${maxTries - 1})` : '';
          log.push(`${attempt.name}${retryNote}: ${reason}`);
          console.warn(`[VortexScans] ✗ ${attempt.name}${retryNote} — ${reason}`);

          // Don't retry hard-fail status codes within this attempt.
          const status = err && err.status;
          if (status === 400 || status === 403 || status === 404) break;

          if (t + 1 < maxTries) {
            // Jittered exponential backoff; longer for 429/503.
            const factor = (status === 429 || status === 503) ? 2.5 : 1.5;
            const jitter = 0.5 + Math.random();
            await new Promise(r => setTimeout(r, Math.min(8000, backoff * jitter)));
            backoff = Math.min(8000, backoff * factor);
          }
        }
      }
    }

    // ABSOLUTE LAST RESORT — replay the previous good HTML for this URL.
    const stale = this._readStale(targetUrl);
    if (stale) {
      console.warn(`[VortexScans] ⚠ all live fetches failed for ${targetUrl} — serving stale HTML from local cache`);
      return stale;
    }

    const detail = log.length ? '\n  • ' + log.join('\n  • ') : ' (no attempts ran)';
    const err = new Error(
      `Unable to fetch source page after direct and proxy attempts.\nURL: ${targetUrl}\nTried:${detail}\nLast error: ${(lastError && lastError.message) || 'unknown'}`
    );
    err.targetUrl = targetUrl;
    err.attempts = log;
    throw err;
  },

  async extract(url) {
    // V14/V15: some proxies return an HTML payload that has the chapter
    // metadata but a stripped/lazy-loaded image array. Detect "too few
    // images" and retry with the cache bypassed AND with a more
    // permissive validator so a different proxy attempt runs. We retry
    // up to 2 times before giving up.
    let html = await this.fetchPage(url, {
      validator: (h) =>
        /storage\.vortexscans\.org|chapterNumber|chapterTitle|chapterSlug|vortexscans|\/upload\/series\//i.test(h)
    });
    let doc = new DOMParser().parseFromString(html, 'text/html');
    let imageUrls = this.extractImageUrls(html, url);

    // Anything under 2 images on Vortex is almost certainly a stripped
    // payload (announcements use a different URL pattern); retry.
    for (let attempt = 0; attempt < 2 && (!imageUrls || imageUrls.length < 2); attempt++) {
      console.warn('[VortexScans] only', imageUrls?.length || 0,
        `image(s) found — retry ${attempt + 1}/2 with cache bypass for`, url);
      try {
        html = await this.fetchPage(url, {
          noCache: true,
          validator: (h) =>
            /image_\d+_|\/upload\/series\/[^/]+\/[^/]+\/[^"'<>\s]+\.(?:webp|jpe?g|png)/i.test(h)
        });
        doc = new DOMParser().parseFromString(html, 'text/html');
        const retried = this.extractImageUrls(html, url);
        if (retried && retried.length > (imageUrls?.length || 0)) imageUrls = retried;
      } catch (e) {
        console.warn('[VortexScans] retry fetch failed:', e.message);
        break;
      }
    }

    // Drop URLs that are obviously not chapter pages (avatars, banners,
    // neighbour-chapter thumbnails leaking through Strategy 2 fallback).
    if (Array.isArray(imageUrls)) {
      imageUrls = imageUrls.filter(u =>
        /\/upload\/series\/[^/]+\/[^/]+\//i.test(u) &&
        !/\/(thumbnail|cover|banner|placeholder)\.(?:webp|jpe?g|png)/i.test(u)
      );
    }

    const data = {
      chapterTitle: this.extractTitle(doc, html, url),
      chapterNumber: this.extractChapterNumber(url, html),
      imageUrls,
      seriesTitle: this.extractSeriesTitle(doc, html, url),
      source: this.name,
      sourceUrl: url
    };

    if (!this.validate(data)) {
      console.error('[VortexScans] extract failed', {
        url,
        imageCount: data.imageUrls?.length || 0,
        htmlLength: (html || '').length,
        title: data.chapterTitle,
        seriesTitle: data.seriesTitle
      });
      throw new Error('Could not extract valid chapter data. Site structure may have changed.');
    }
    return data;
  },

  extractChapterNumber(url, html = '') {
    const fromData = html.match(/(?:&quot;|\")chapterNumber(?:&quot;|\")\s*:\s*\[0,\s*(\d+(?:\.\d+)?)/i);
    if (fromData) return parseFloat(fromData[1]);

    // URL may use either "." or "-" as the decimal separator
    // (chapter-2.5 or chapter-2-5). Both should resolve to 2.5.
    const m = url.match(/chapter-(\d+(?:[.-]\d+)?)/i);
    if (m) return parseFloat(String(m[1]).replace('-', '.'));

    const titleMatch = html.match(/Chapter\s+(\d+(?:\.\d+)?)/i);
    return titleMatch ? parseFloat(titleMatch[1]) : null;
  },

  extractSeriesSlug(url) {
    const m = url.match(/\/series\/([^/]+)\//i);
    return m ? m[1] : '';
  },

  extractTitle(doc, html = '', url = '') {
    const chapterTitle = this.findPackedString(html, 'chapterTitle');
    const chapterNumber = this.extractChapterNumber(url, html);
    if (chapterTitle && chapterNumber != null) return `Chapter ${chapterNumber} - ${chapterTitle}`;
    if (chapterTitle) return chapterTitle;

    const markdownTitle = html.match(/^Title:\s*(.+)$/im);
    if (markdownTitle) return markdownTitle[1].trim();

    const og = doc.querySelector('meta[property="og:title"]');
    if (og?.content) return og.content.trim();
    const t = doc.querySelector('title');
    return t?.textContent?.trim() || null;
  },

  extractSeriesTitle(doc, html, url) {
    const packed = this.findPackedString(html, 'seriesTitle') ||
                   this.findPackedString(html, 'postTitle');
    if (packed) return packed;

    const full = this.extractTitle(doc, html, url) || '';
    // Title looks like: "Series Name Chapter 0.5"
    const cleaned = full.replace(/\s*Chapter\s*\d+(\.\d+)?.*$/i, '').trim();
    if (cleaned) return cleaned;

    // Fallback: prettify slug
    const slug = this.extractSeriesSlug(url);
    return slug
      ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : null;
  },

  /**
   * Extract chapter page images from a Vortex chapter HTML payload.
   *
   * Vortex Scans serves chapter pages from storage.vortexscans.org.
   * Historical / current filename patterns seen in the wild:
   *   - /upload/series/<slug>/<chapter-folder>/page-0001.webp        (legacy)
   *   - /upload/series/<slug>/<chapter-folder>/image_NNNN_<hash>.webp (current)
   *   - /upload/series/<slug>/<chapter-folder>/<uuid>.webp           (some hosts)
   *
   * Site-chrome assets live under /upload/YYYY/MM/... (logo, banners) and
   * MUST NOT be returned as chapter pages.
   */
  extractImageUrls(html, url = '') {
    const seriesSlug = this.extractSeriesSlug(url);
    const isChapterImage = (u) =>
      typeof u === 'string' &&
      /^https?:\/\/storage\.vortexscans\.org\/upload\/series\/[^/]+\/[^/]+\/[^/]+\.(?:webp|jpe?g|png)(?:\?[^"'<>\s]*)?$/i.test(u);
    // V16: the CDN folder is often a numeric series ID instead of the
    // URL slug. Filtering strictly by slug previously dropped EVERY
    // page for those series, producing chapters with no images. Treat
    // the slug match as a *preference* — if at least 2 images match the
    // slug, prefer them; otherwise fall back to all chapter-shaped URLs
    // and let the dominant-folder grouping below pick the right one.
    const matchesSlug = (u) =>
      isChapterImage(u) &&
      (!seriesSlug || u.includes(`/upload/series/${seriesSlug}/`));
    const pickFolder = (urls) => {
      const slugMatched = urls.filter(matchesSlug);
      return slugMatched.length >= 2 ? slugMatched : urls.filter(isChapterImage);
    };

    // STRATEGY 0 (V14): scan the packed Next.js / RSC payload for the
    // ordered image array.
    try {
      const packed = this.decodeHtml(html)
        .replace(/\\\//g, '/').replace(/\\u002F/gi, '/').replace(/\\"/g, '"');
      const re = /https?:\/\/storage\.vortexscans\.org\/upload\/series\/[^"'<>\])\s\\]+?\.(?:webp|jpg|jpeg|png)/gi;
      const seenPacked = new Set();
      const orderedPacked = [];
      let m;
      while ((m = re.exec(packed)) !== null) {
        const u = m[0];
        if (!isChapterImage(u) || seenPacked.has(u)) continue;
        seenPacked.add(u);
        orderedPacked.push(u);
      }
      const orderedPicked = pickFolder(orderedPacked);
      if (orderedPicked.length >= 2) {
        const counts = new Map();
        for (const u of orderedPicked) {
          const mm = u.match(/\/upload\/series\/([^/]+)\/([^/]+)\//i);
          if (mm) {
            const key = `${mm[1]}/${mm[2]}`;
            counts.set(key, (counts.get(key) || 0) + 1);
          }
        }
        let dom = null, max = 0;
        for (const [k, c] of counts) if (c > max) { dom = k; max = c; }
        const filtered = dom
          ? orderedPicked.filter(u => u.includes(`/upload/series/${dom}/`))
          : orderedPicked;
        if (filtered.length >= 2) {
          console.info('[VortexScans] packed-payload extraction:', filtered.length, 'pages');
          return filtered;
        }
      }
    } catch { /* fall through */ }

    // STRATEGY 1 (preferred): DOM-based extraction.
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const candidates = [...doc.querySelectorAll(
        '.comic-images-wrapper img[data-reader-page-image], img[data-reader-page-image], .comic-images-wrapper img, .reading-content img, #readerarea img'
      )];
      const seenDom = new Set();
      const ordered = [];
      for (const img of candidates) {
        const src = img.getAttribute('src') ||
                    img.getAttribute('data-src') ||
                    img.getAttribute('data-lazy-src') ||
                    img.getAttribute('data-original') || '';
        if (!isChapterImage(src) || seenDom.has(src)) continue;
        const idxAttr = img.getAttribute('data-reader-index');
        const idx = idxAttr != null && idxAttr !== '' ? parseInt(idxAttr, 10) : NaN;
        ordered.push({ src, idx: Number.isFinite(idx) ? idx : ordered.length });
        seenDom.add(src);
      }
      const domPicked = pickFolder(ordered.map(o => o.src));
      if (domPicked.length) {
        const byUrl = new Map(ordered.map(o => [o.src, o.idx]));
        return domPicked
          .map(src => ({ src, idx: byUrl.get(src) ?? 0 }))
          .sort((a, b) => a.idx - b.idx)
          .map(o => o.src);
      }
    } catch { /* DOMParser missing or malformed HTML — fall through */ }

    // STRATEGY 2 (fallback): regex sweep for proxies that strip the DOM.
    const decoded = this.decodeHtml(html)
      .replace(/\\\//g, '/')
      .replace(/\\u002F/gi, '/')
      .replace(/\\"/g, '"');

    const regex = /https?:\/\/storage\.vortexscans\.org\/upload\/series\/[^"'<>\])\s\\]+?\.(?:webp|jpg|jpeg|png)(?:\?[^"'<>\])\s\\]*)?/gi;
    const matches = decoded.match(regex) || [];

    const seen = new Set();
    let all = [];
    for (const u of matches) {
      if (seen.has(u) || !isChapterImage(u)) continue;
      seen.add(u);
      all.push(u);
    }
    let urls = pickFolder(all);

    if (!urls.length) return urls;

    const folderCounts = new Map();
    for (const u of urls) {
      const m = u.match(/\/upload\/series\/([^/]+)\/([^/]+)\//i);
      if (!m) continue;
      const key = `${m[1]}/${m[2]}`;
      folderCounts.set(key, (folderCounts.get(key) || 0) + 1);
    }
    let dominant = null;
    let dominantCount = 0;
    for (const [k, c] of folderCounts) {
      if (c > dominantCount) { dominant = k; dominantCount = c; }
    }
    if (dominant && dominantCount >= 2) {
      const filtered = urls.filter(u => u.includes(`/upload/series/${dominant}/`));
      if (filtered.length) urls = filtered;
    }

    const pageKey = (u) => {
      const m = u.match(/\/page-(\d+)/i);
      return m ? parseInt(m[1], 10) : null;
    };
    if (urls.every(u => pageKey(u) != null)) {
      urls.sort((a, b) => pageKey(a) - pageKey(b));
    }

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

window.SourceVortexScans = SourceVortexScans;

// Auto-register if registry already loaded (when this script is added after it)
if (window.SourceRegistry?.register) {
  window.SourceRegistry.register(SourceVortexScans);
}
