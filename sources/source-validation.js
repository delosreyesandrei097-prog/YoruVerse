/**
 * ============================================================
 * MANHWA PLATFORM - SHARED CHAPTER VALIDATION
 * ============================================================
 * Applied uniformly to EVERY source plugin via SourceRegistry.
 *
 * Rules:
 *   1. A chapter must contain at least 1 image whose URL is a
 *      structurally valid HTTP(S) image URL.
 *   2. A chapter with only ONE image is rejected as "likely broken"
 *      UNLESS the chapter is a recognised special / announcement
 *      release (see SPECIAL_CHAPTER_NUMBERS / SPECIAL_TITLE_RE).
 *   3. Duplicate URLs collapsed before counting.
 *   4. URLs that look like site chrome (logo / banner / placeholder /
 *      "read on X" footer art) are stripped before counting.
 *
 * Load order in index.html:
 *   source-config.js -> source-registry.js -> source-validation.js
 *   -> individual source plugins
 * ============================================================
 */
(function (global) {
  'use strict';

  /** Chapter numbers that legitimately ship as a single page. */
  const SPECIAL_CHAPTER_NUMBERS = new Set([0, 0.1, 0.5, 1.5]);

  /** Title keywords that legitimately ship as a single page. */
  const SPECIAL_TITLE_RE =
    /\b(extra|special|announcement|notice|prologue|epilogue|omake|teaser|trailer|preview|interlude|side[\s-]?story)\b/i;

  /** URL substrings that are never real chapter pages. */
  const CHROME_URL_RE =
    /\/(logo|favicon|avatar|placeholder|spacer|sprite|icon-|banner|read_on_[a-z]+|thumbnail\.[a-z]+)/i;

  const SourceValidation = {
    SPECIAL_CHAPTER_NUMBERS,
    SPECIAL_TITLE_RE,
    CHROME_URL_RE,

    /**
     * Is the URL a structurally valid image URL we'd want to save?
     * (We don't HEAD-check here — that's blocked by CORS for most CDNs
     *  and would dramatically slow down imports.)
     */
    isValidImageUrl(u) {
      if (!u || typeof u !== 'string') return false;
      const s = u.trim();
      if (!s || s.startsWith('data:') || s.startsWith('blob:')) return false;
      if (!/^https?:\/\//i.test(s)) return false;
      try { new URL(s); } catch { return false; }
      if (CHROME_URL_RE.test(s)) return false;
      // Must look like an image: explicit extension OR a known CDN path.
      if (!/\.(jpe?g|png|webp|gif|avif|bmp)(\?[^"'<>\s]*)?$/i.test(s) &&
          !/\/(uploads?|images?|cdn|storage|media|wp-content)\//i.test(s)) {
        return false;
      }
      return true;
    },

    /** Deduplicate + strip chrome URLs. Returns the cleaned array. */
    sanitizeImageUrls(arr) {
      if (!Array.isArray(arr)) return [];
      const out = [];
      const seen = new Set();
      for (const raw of arr) {
        if (!this.isValidImageUrl(raw)) continue;
        const key = String(raw).trim();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(key);
      }
      return out;
    },

    /**
     * Whether a chapter is allowed to have only 1 image.
     * Accepts numbers (0.5, 1.5, ...) and/or titles ("Extra", "Notice").
     */
    isSpecialChapter(data) {
      if (!data) return false;
      const num = parseFloat(data.chapterNumber);
      if (!Number.isNaN(num) && SPECIAL_CHAPTER_NUMBERS.has(num)) return true;
      // Any non-integer chapter number (e.g. 12.5) is treated as a side
      // release and allowed to be a single-page announcement.
      if (!Number.isNaN(num) && Math.floor(num) !== num) return true;
      const title = String(data.chapterTitle || '');
      if (SPECIAL_TITLE_RE.test(title)) return true;
      return false;
    },

    /**
     * Returns { ok: true, data } or { ok: false, reason } so callers
     * can produce a useful error message.
     */
    validate(data) {
      if (!data || typeof data !== 'object') {
        return { ok: false, reason: 'no data returned by source plugin' };
      }
      const clean = this.sanitizeImageUrls(data.imageUrls);
      if (clean.length === 0) {
        return { ok: false, reason: 'chapter contains no valid images' };
      }
      if (clean.length === 1 && !this.isSpecialChapter(data)) {
        return {
          ok: false,
          reason:
            'chapter contains only 1 image — likely a broken / incomplete extraction. ' +
            'If this is a real single-page release (announcement, prologue, 0.5, extra, ...) ' +
            'mark it with one of those keywords or use a fractional chapter number.'
        };
      }
      data.imageUrls = clean;
      return { ok: true, data };
    }
  };

  global.SourceValidation = SourceValidation;

  // ---- Wire into SourceRegistry so EVERY plugin is covered automatically ----
  function wrapRegistry(registry) {
    if (!registry || registry.__strictValidationWrapped) return;
    registry.__strictValidationWrapped = true;

    const originalExtract = registry.extract.bind(registry);
    registry.extract = async function (url) {
      const data = await originalExtract(url);
      const result = SourceValidation.validate(data);
      if (!result.ok) {
        const sourceName = data?.source || 'source plugin';
        throw new Error(
          `[${sourceName}] Rejected chapter from ${url}: ${result.reason}`
        );
      }
      return result.data;
    };
    console.log('[SourceValidation] strict chapter validation enabled for all plugins');
  }

  if (global.SourceRegistry) {
    wrapRegistry(global.SourceRegistry);
  } else {
    // Registry not loaded yet — poll briefly then attach.
    let tries = 0;
    const timer = setInterval(() => {
      if (global.SourceRegistry) {
        wrapRegistry(global.SourceRegistry);
        clearInterval(timer);
      } else if (++tries > 50) {
        clearInterval(timer);
        console.warn('[SourceValidation] SourceRegistry never appeared; validation not wired');
      }
    }, 100);
  }
})(window);
