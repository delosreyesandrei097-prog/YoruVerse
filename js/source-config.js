/**
 * ============================================================
 * MANHWA PLATFORM - SOURCE CONFIGURATION
 * ============================================================
 * Global configuration for source plugins:
 *   - CORS proxy URL configuration
 *   - Multi-proxy fallback chain with automatic retry
 *   - Rate limiting per host
 *   - Custom headers
 *
 * USAGE:
 *   // Set a custom CORS proxy
 *   SourceConfig.setProxyUrl('https://my-proxy.example.com/?url={url}');
 *
 *   // Or set before scripts load:
 *   window.SourceConfig = { proxyUrl: 'https://...' };
 *
 * PROXY URL FORMAT:
 *   Use '{url}' for an encoded URL or '{rawUrl}' for the original URL.
 *   Example: 'https://api.allorigins.win/raw?url={url}'
 * ============================================================
 */

const existingSourceConfig = window.SourceConfig || {};

window.SourceConfig = {
  proxyUrl: existingSourceConfig.proxyUrl || null,

  // Built-in fallbacks tried in order until one returns usable content.
  //
  // IMPORTANT ORDERING: proxies that return the page's REAL HTML come
  // FIRST. r.jina.ai in its default mode returns *markdown*, which breaks
  // every plugin that parses DOM selectors or embedded JSON (metadata,
  // RSC chapter lists, Astro-packed payloads). It is therefore used:
  //   1. mid-chain in HTML mode (x-respond-with: html — also executes JS,
  //      which helps with client-rendered chapter lists), and
  //   2. at the very END in markdown mode, as a last-resort text fallback
  //      (plugins have markdown-aware fallbacks for this case).
  defaultProxyUrls: existingSourceConfig.defaultProxyUrls || [
    'https://corsproxy.io/?{url}',
    'https://api.allorigins.win/raw?url={url}',
    'https://api.codetabs.com/v1/proxy/?quest={rawUrl}',
    'jina-html:https://r.jina.ai/{rawUrl}',
    'https://api.allorigins.win/get?url={url}',
    'https://thingproxy.freeboard.io/fetch/{rawUrl}',
    'https://cors.eu.org/{rawUrl}',
    'https://proxy.cors.sh/{rawUrl}',
    'https://r.jina.ai/{rawUrl}'
  ],

  useDefaultProxies: existingSourceConfig.useDefaultProxies !== false,

  // Minimum ms between requests to the same domain (per-host rate limit).
  // V10: lowered 750 -> 400ms since most upstream proxies easily handle
  // this and Auto-Sync was bottlenecked by it.
  rateLimitMs: existingSourceConfig.rateLimitMs || 400,

  // Per-attempt timeout (ms). V10: 25s -> 15s so a slow/dead proxy fails
  // fast and we move on to the next one instead of stalling the queue.
  requestTimeout: existingSourceConfig.requestTimeout || 15000,

  // How many times to retry an attempt before moving on to the next proxy
  retriesPerAttempt: existingSourceConfig.retriesPerAttempt ?? 1,

  // Backoff between retries of the same attempt (ms)
  retryBackoffMs: existingSourceConfig.retryBackoffMs || 800,

  customHeaders: existingSourceConfig.customHeaders || {
    'Accept': 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  },

  tryDirectFirst: existingSourceConfig.tryDirectFirst !== false,

  _lastRequestTimes: {},

  // V10: small in-process response cache. Multiple series on the same
  // host frequently end up requesting overlapping URLs within one sync
  // pass; dedupe those calls for a configurable TTL.
  _cache: new Map(),
  cacheTtlMs: existingSourceConfig.cacheTtlMs || 60_000,
  _cacheGet(url) {
    const e = this._cache.get(url);
    if (!e) return null;
    if (Date.now() - e.t > this.cacheTtlMs) { this._cache.delete(url); return null; }
    return e.v;
  },
  _cacheSet(url, v) {
    if (!v) return;
    if (this._cache.size > 200) {
      // Evict oldest ~50 entries to keep it bounded.
      const it = this._cache.keys();
      for (let i = 0; i < 50; i++) { const k = it.next().value; if (!k) break; this._cache.delete(k); }
    }
    this._cache.set(url, { v, t: Date.now() });
  },
  clearCache() { this._cache.clear(); },


  setProxyUrl(url) {
    this.proxyUrl = url;
    console.log(`[SourceConfig] CORS proxy set to: ${url}`);
  },

  async waitForRateLimit(domain) {
    const lastTime = this._lastRequestTimes[domain] || 0;
    const elapsed = Date.now() - lastTime;
    if (elapsed < this.rateLimitMs) {
      const waitTime = this.rateLimitMs - elapsed;
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    this._lastRequestTimes[domain] = Date.now();
  },

  buildProxyUrl(template, targetUrl) {
    if (!template) return null;
    template = template.replace(/^jina-html:/, '');
    if (template.includes('{rawUrl}')) return template.replace('{rawUrl}', targetUrl);
    if (template.includes('{url}')) return template.replace('{url}', encodeURIComponent(targetUrl));
    return template + encodeURIComponent(targetUrl);
  },

  getProxiedUrl(targetUrl) {
    return this.buildProxyUrl(this.proxyUrl, targetUrl);
  },

  normalizeProxyResponse(payload) {
    if (typeof payload !== 'string') return '';
    const trimmed = payload.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return payload;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed.contents || parsed.data || parsed.html || parsed.body || payload;
    } catch {
      return payload;
    }
  },

  async fetchWithTimeout(fetchUrl, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeout);
    try {
      const response = await fetch(fetchUrl, {
        method: options.method || 'GET',
        headers: { ...this.customHeaders, ...(options.headers || {}) },
        body: options.body,
        signal: controller.signal,
        cache: 'no-store',
        mode: 'cors',
        credentials: 'omit',
        redirect: 'follow'
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText || ''}`.trim());
      }
      const text = await response.text();
      return this.normalizeProxyResponse(text);
    } finally {
      clearTimeout(timeout);
    }
  },

  getFetchAttempts(targetUrl) {
    const attempts = [];
    if (this.tryDirectFirst) attempts.push({ name: 'direct', url: targetUrl, isProxy: false });
    if (this.proxyUrl) attempts.push({ name: 'configured proxy', url: this.getProxiedUrl(targetUrl), isProxy: true });
    if (this.useDefaultProxies) {
      this.defaultProxyUrls.forEach((template, index) => {
        const isJinaHtml = /^jina-html:/i.test(template);
        attempts.push({
          name: `fallback proxy ${index + 1} (${this._proxyLabel(template)}${isJinaHtml ? ' html' : ''})`,
          url: this.buildProxyUrl(template, targetUrl),
          isProxy: true,
          // markdown-mode jina only (last resort); html-mode jina returns real HTML
          isJina: /r\.jina\.ai/i.test(template) && !isJinaHtml,
          headers: isJinaHtml ? { 'x-respond-with': 'html' } : null
        });
      });
    }
    return attempts.filter(a => a.url);
  },

  _proxyLabel(template) {
    try { return new URL(template.replace(/^jina-html:/, '').replace(/\{rawUrl\}|\{url\}/g, 'x')).hostname; }
    catch { return 'proxy'; }
  },

  _hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  },

  async fetchPage(targetUrl, options = {}) {
    const validator = options.validator || (() => true);
    const attemptsLog = [];
    let lastError = null;
    const challengeRe = /Just a moment|cf-browser-verification|challenges\.cloudflare\.com|Performing security verification|verify you are not a bot|cf-chl|Attention Required\!.*Cloudflare/i;

    // V10: short-TTL cache for the same exact target URL.
    if (!options.noCache) {
      const hit = this._cacheGet(targetUrl);
      if (hit) return hit;
    }

    // Per-target-host rate limit (best effort)
    const targetHost = this._hostOf(targetUrl);
    if (targetHost) await this.waitForRateLimit(targetHost);

    const attempts = this.getFetchAttempts(targetUrl);



    for (const attempt of attempts) {
      const tries = Math.max(1, 1 + (this.retriesPerAttempt | 0));
      for (let t = 0; t < tries; t++) {
        const t0 = Date.now();
        try {
          const attemptOptions = attempt.headers
            ? { ...options, headers: { ...(options.headers || {}), ...attempt.headers } }
            : options;
          const html = await this.fetchWithTimeout(attempt.url, attemptOptions);
          if (!html) throw new Error('Empty response body');
          if (challengeRe.test(html)) throw new Error('Cloudflare challenge page returned');

          // Markdown-mode Jina returns plain text/markdown — strict HTML
          // validators may fail on it. We accept those responses whenever
          // they're non-trivial (plugins have markdown-aware fallbacks),
          // but only as the last-resort attempt in the chain.
          if (attempt.isJina && html.length > 200) {
            console.log(`[SourceConfig] ✓ ${attempt.name} [jina markdown] (${Date.now() - t0}ms) — ${targetUrl}`);
            if (!options.noCache) this._cacheSet(targetUrl, html);
            return html;
          }

          if (!validator(html)) {
            throw new Error('Response did not pass content validator (page may have changed or proxy returned an error page)');
          }
          console.log(`[SourceConfig] ✓ ${attempt.name} (${Date.now() - t0}ms) — ${targetUrl}`);
          if (!options.noCache) this._cacheSet(targetUrl, html);
          return html;

        } catch (error) {
          const reason = (error && error.name === 'AbortError')
            ? `timeout after ${this.requestTimeout}ms`
            : (error && error.message) || String(error);
          lastError = error;
          const retryNote = t + 1 < tries ? ` (retry ${t + 1}/${tries - 1})` : '';
          attemptsLog.push(`${attempt.name}${retryNote}: ${reason}`);
          console.warn(`[SourceConfig] ✗ ${attempt.name}${retryNote} for ${targetUrl} — ${reason}`);
          if (t + 1 < tries) {
            await new Promise(r => setTimeout(r, this.retryBackoffMs));
          }
        }
      }
    }

    const detail = attemptsLog.length
      ? '\n  • ' + attemptsLog.join('\n  • ')
      : ' (no fetch attempts were possible — check proxy configuration)';
    const err = new Error(
      `Unable to fetch source page after direct and proxy attempts.\nURL: ${targetUrl}\nTried:${detail}\nLast error: ${(lastError && lastError.message) || 'unknown'}`
    );
    err.targetUrl = targetUrl;
    err.attempts = attemptsLog;
    throw err;
  },

  getConfig() {
    return {
      proxyUrl: this.proxyUrl || '(not set)',
      useDefaultProxies: this.useDefaultProxies,
      defaultProxyUrls: [...this.defaultProxyUrls],
      rateLimitMs: this.rateLimitMs,
      requestTimeout: this.requestTimeout,
      retriesPerAttempt: this.retriesPerAttempt,
      retryBackoffMs: this.retryBackoffMs,
      tryDirectFirst: this.tryDirectFirst,
      customHeaders: { ...this.customHeaders }
    };
  },

  /**
   * True when a fetched payload looks like r.jina.ai markdown / plain text
   * rather than real HTML. Plugins use this to switch to markdown-aware
   * fallback extraction.
   */
  isMarkdownPayload(text) {
    if (typeof text !== 'string') return false;
    if (/^Title:\s*\S/m.test(text) && /^(URL Source|Markdown Content):/m.test(text)) return true;
    // No html/body/div tags in the first chunk => almost certainly not HTML
    return !/<(?:!doctype|html|head|body|div|span|script|meta)\b/i.test(text.slice(0, 4000));
  },

  /**
   * Best-effort metadata extraction from r.jina.ai markdown output.
   * Returns { title, cover, description, genres, author, artist, status }
   * with empty values for anything it can't find. Used by series plugins
   * as a LAST-RESORT fallback so imports still carry metadata even when
   * only a markdown proxy succeeded.
   */
  parseMarkdownMeta(text) {
    const out = { title: '', cover: '', description: '', genres: [], author: '', artist: '', status: '' };
    if (typeof text !== 'string' || !text.trim()) return out;

    // Title: header line emitted by jina
    const titleLine = text.match(/^Title:\s*(.+)$/m);
    if (titleLine) {
      out.title = titleLine[1]
        .replace(/\s*\|[^|]*$/, '')                                  // "| SiteName" suffix
        .replace(/^Read\s+/i, '')                                    // "Read X" prefix
        .replace(/\s*\[[^\]]*\]\s*$/i, '')                           // "[Latest Chapters]" suffix
        .replace(/\s*(?:Manga|Manhwa|Webtoon|Comic)\s*$/i, '')       // trailing media word
        .replace(/\s*[–-]\s*(?:[A-Za-z0-9 .']{0,40}(?:Scans?|Toons?|Comics?))\s*$/i, '')
        .trim();
    }


    // Cover: prefer image URLs that look like covers/posters, else the
    // first large-looking content image.
    const imgRe = /!\[[^\]]*\]\((https?:\/\/[^)\s]+?\.(?:webp|jpe?g|png|avif)(?:\?[^)\s]*)?)\)/gi;
    let im, firstImg = '';
    while ((im = imgRe.exec(text)) !== null) {
      const u = im[1];
      if (!firstImg && !/logo|icon|avatar|banner|wewtwt|favicon/i.test(u)) firstImg = u;
      if (/cover|poster|thumb|og-image|\/series\/|\/covers\//i.test(u)) { out.cover = u; break; }
    }
    if (!out.cover) out.cover = firstImg;

    // Description / Synopsis section
    const desc = text.match(/^(?:#{0,4}\s*)?(?:Description|Synopsis|Summary)\s*:?\s*$\n+([\s\S]{20,2000}?)(?:\n\s*\n(?:#{1,4}\s|\*\*|Chapter\b|\[)|$)/im) ||
                 text.match(/(?:Description|Synopsis)\s*:\s*\n+([\s\S]{20,2000}?)(?:\n\s*\n|$)/i);
    if (desc) {
      out.description = desc[1]
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/[*_`>#]+/g, '')
        .replace(/\n{2,}/g, '\n')
        .trim();
    }

    // Inline "Key: Value" rows (jina keeps simple text rows)
    const row = (label) => {
      const m = text.match(new RegExp(`^\\**\\s*${label}\\s*\\**\\s*[:：]\\s*\\**\\s*([^\\n*]+)`, 'im'));
      return m ? m[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim() : '';
    };
    out.author = row('Author(?:\\(s\\))?');
    out.artist = row('Artist(?:\\(s\\))?');
    const st = row('Status').toLowerCase();
    if (st) {
      const mm = st.match(/ongoing|completed|complete|hiatus|dropped|cancelled|axed|season end/);
      if (mm) out.status = mm[0] === 'complete' ? 'completed' : (mm[0] === 'axed' ? 'dropped' : mm[0]);
    }

    // Genres: a "Genres" row or genre-ish links
    const gRow = row('Genres?');
    if (gRow) {
      out.genres = gRow.split(/[,;|•·]/).map(s => s.trim()).filter(s => s && s.length < 40);
    }
    if (!out.genres.length) {
      const g = new Set();
      const linkRe = /\[([^\]\n]{2,30})\]\((https?:\/\/[^)\s]*(?:genre|genres)[=\/][^)\s]*)\)/gi;
      let gm;
      while ((gm = linkRe.exec(text)) !== null) g.add(gm[1].trim());
      out.genres = [...g];
    }

    return out;
  }
};
