/**
 * ============================================================
 * MANHWA PLATFORM - SERIES IMPORTER
 * ============================================================
 * Orchestrates full-series imports:
 *
 *   Series URL
 *     -> detect plugin (findSeriesSource)
 *     -> fetch series metadata
 *     -> fetch full chapter list
 *     -> bulk import every chapter (dedupe, retry, log)
 *     -> save/update Firestore series doc with sync metadata
 *
 * Requires (loaded before this file):
 *   - firebase compat (firestore.FieldValue)
 *   - SourceRegistry
 *   - SourceConfig
 *   - DB
 *
 * Plugins gain four optional series-level methods:
 *   detectSeries(url)        -> boolean
 *   getSeriesInfo(url)       -> { title, cover, description, genres, ... }
 *   getChapterList(url)      -> [{ number, title, url, releasedAt }]
 *   getChapter(chapterUrl)   -> same shape as the legacy extract(url)
 *                               (defaults to plugin.extract if omitted)
 *
 * Plugins that only implement the legacy detect()/extract() pair will
 * keep working for single-chapter imports; they just won't show up when
 * a *series* URL is pasted.
 * ============================================================
 */
(function (global) {
  'use strict';

  const STATES = Object.freeze({
    IDLE: 'idle',
    RUNNING: 'running',
    PAUSED: 'paused',
    CANCELLED: 'cancelled',
    DONE: 'done',
    ERROR: 'error'
  });

  function nowISO() { return new Date().toISOString(); }
  function slugify(text) {
    return String(text || '')
      .toLowerCase()
      .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'series-' + Date.now();
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ------------------------------------------------------------
  // Series-aware view over SourceRegistry
  // ------------------------------------------------------------
  const SeriesSourceRegistry = {
    findSeriesSource(url) {
      if (!url || !global.SourceRegistry) return null;
      for (const src of global.SourceRegistry.getSources()) {
        try {
          if (typeof src.detectSeries === 'function' && src.detectSeries(url)) return src;
        } catch (e) {
          console.error(`[SeriesSourceRegistry] detectSeries error in ${src.name}:`, e);
        }
      }
      // Fallback: domain match on a /series/ path
      try {
        const host = new URL(url).hostname.replace(/^www\./, '');
        for (const src of global.SourceRegistry.getSources()) {
          if (src.domain && host.endsWith(src.domain) &&
              typeof src.getSeriesInfo === 'function' &&
              typeof src.getChapterList === 'function') {
            return src;
          }
        }
      } catch (_) {}
      return null;
    },

    canHandleSeries(url) { return !!this.findSeriesSource(url); },

    listSeriesSources() {
      if (!global.SourceRegistry) return [];
      return global.SourceRegistry.getSources()
        .filter(s => typeof s.getSeriesInfo === 'function' && typeof s.getChapterList === 'function')
        .map(s => ({ name: s.name, domain: s.domain }));
    }
  };

  // ------------------------------------------------------------
  // Main importer (single global instance; only one import at a time)
  // ------------------------------------------------------------
  const SeriesImporter = {
    STATES,
    state: STATES.IDLE,
    logs: [],
    progress: null,
    _listeners: {},
    _abort: false,
    _pauseGate: null,

    // ---------- Events ----------
    on(event, cb) {
      if (typeof cb !== 'function') return;
      (this._listeners[event] = this._listeners[event] || []).push(cb);
    },
    off(event, cb) {
      if (!this._listeners[event]) return;
      this._listeners[event] = this._listeners[event].filter(f => f !== cb);
    },
    _emit(event, payload) {
      (this._listeners[event] || []).forEach(cb => {
        try { cb(payload); } catch (e) { console.error('[SeriesImporter] listener error', e); }
      });
    },

    // ---------- Logs ----------
    _log(level, message, meta) {
      const entry = { ts: nowISO(), level, message, ...(meta || {}) };
      this.logs.push(entry);
      if (this.logs.length > 5000) this.logs.splice(0, this.logs.length - 5000);
      this._emit('log', entry);
      const tag = `[SeriesImporter:${level}]`;
      if (level === 'error') console.error(tag, message, meta || '');
      else if (level === 'warn') console.warn(tag, message, meta || '');
      else console.log(tag, message, meta || '');
      return entry;
    },
    clearLogs() { this.logs = []; this._emit('log', null); },
    getLogs() { return [...this.logs]; },

    // ---------- Control ----------
    pause() {
      if (this.state !== STATES.RUNNING) return;
      this.state = STATES.PAUSED;
      this._pauseGate = new Promise(resolve => { this._resumeFn = resolve; });
      this._log('info', 'Import paused');
      this._emit('state', this.state);
    },
    resume() {
      if (this.state !== STATES.PAUSED) return;
      this.state = STATES.RUNNING;
      this._log('info', 'Import resumed');
      this._emit('state', this.state);
      if (this._resumeFn) { this._resumeFn(); this._resumeFn = null; this._pauseGate = null; }
    },
    cancel() {
      if (this.state !== STATES.RUNNING && this.state !== STATES.PAUSED) return;
      this._abort = true;
      this._log('warn', 'Import cancellation requested');
      if (this._resumeFn) { this._resumeFn(); this._resumeFn = null; this._pauseGate = null; }
    },
    async _checkpoint() {
      if (this._abort) throw new Error('__CANCELLED__');
      if (this._pauseGate) await this._pauseGate;
      if (this._abort) throw new Error('__CANCELLED__');
    },

    // ---------- Preview (no writes) ----------
    async preview(seriesUrl) {
      const source = SeriesSourceRegistry.findSeriesSource(seriesUrl);
      if (!source) throw new Error('No source plugin supports this series URL.');
      const info = await source.getSeriesInfo(seriesUrl);
      const chapters = await source.getChapterList(seriesUrl);
      return {
        source: source.name,
        info: this._normalizeSeriesInfo(info, source, seriesUrl),
        chapterCount: chapters.length,
        firstChapter: chapters[0] || null,
        lastChapter: chapters[chapters.length - 1] || null
      };
    },

    // ---------- Main entry ----------
    /**
     * @param {string} seriesUrl
     * @param {object} options
     *   - seriesId?: string      reuse an existing series doc
     *   - concurrency?: number   parallel chapter fetches (default 2)
     *   - maxRetries?: number    per chapter (default 3)
     *   - overwrite?: boolean    re-import existing chapters (default false)
     *   - rangeStart?: number    only chapters with number >= rangeStart
     *   - rangeEnd?:   number    only chapters with number <= rangeEnd
     *   - onlyNew?: boolean      skip everything <= series.lastImportedChapter
     */
    async importSeries(seriesUrl, options = {}) {
      if (this.state === STATES.RUNNING || this.state === STATES.PAUSED) {
        throw new Error('Another import is already running. Cancel it first.');
      }
      const opts = Object.assign({
        concurrency: 5,  // increased from 2 → 4 → 5 for faster parallel imports
        maxRetries: 3,
        overwrite: false,
        rangeStart: null,
        rangeEnd: null,
        onlyNew: false,
        seriesId: null,
        // When true, an existing series document is NEVER overwritten with
        // freshly-scraped metadata (cover, title, description, genres, …).
        // Only chapters are added. This is used by Sync / Auto-Sync so that
        // admin-edited series details and locally chosen covers don't get
        // clobbered every time the source HTML changes.
        preserveMetadata: false
      }, options);

      this._abort = false;
      this._pauseGate = null;
      this._resumeFn = null;
      this.logs = [];
      this.state = STATES.RUNNING;
      this._emit('state', this.state);

      const result = {
        seriesId: null,
        seriesTitle: null,
        imported: 0,
        skipped: 0,
        failed: 0,
        total: 0,
        failedChapters: [],
        cancelled: false,
        startedAt: nowISO(),
        finishedAt: null
      };

      try {
        // 1. Detect plugin
        const source = SeriesSourceRegistry.findSeriesSource(seriesUrl);
        if (!source) throw new Error('No source plugin supports this URL.');
        this._log('info', `Detected source: ${source.name}`);

        // 2. Fetch metadata (or use admin-supplied override)
        let rawInfo;
        if (opts.overrideInfo) {
          this._log('info', 'Using admin-edited metadata (skipping refetch)');
          rawInfo = opts.overrideInfo;
        } else {
          this._setProgress({ phase: 'metadata', message: 'Fetching series metadata...' });
          rawInfo = await source.getSeriesInfo(seriesUrl);
        }
        const seriesInfo = this._normalizeSeriesInfo(rawInfo, source, seriesUrl);
        // Preserve fields that aren't normalized but the admin may have set
        if (rawInfo && rawInfo.banner)        seriesInfo.banner = rawInfo.banner;
        if (rawInfo && rawInfo.releaseYear)   seriesInfo.releaseYear = rawInfo.releaseYear;
        if (rawInfo && rawInfo.synopsis)      seriesInfo.description = rawInfo.synopsis;
        result.seriesTitle = seriesInfo.title;
        this._log('success', `Series metadata loaded: ${seriesInfo.title}`);

        // 3. Resolve / create series doc
        const seriesId = await this._upsertSeries(
          seriesInfo,
          opts.seriesId,
          { preserveMetadata: !!opts.preserveMetadata }
        );
        result.seriesId = seriesId;
        this._log('success', `Series saved (id=${seriesId})`);

        // 4. Fetch chapter list
        await this._checkpoint();
        this._setProgress({ phase: 'list', message: 'Fetching chapter list...' });
        let chapters = await source.getChapterList(seriesUrl);
        if (!Array.isArray(chapters)) throw new Error('getChapterList did not return an array');
        chapters = this._normalizeChapterList(chapters);

        // Range / onlyNew filtering
        if (opts.rangeStart != null) chapters = chapters.filter(c => c.number >= Number(opts.rangeStart));
        if (opts.rangeEnd != null)   chapters = chapters.filter(c => c.number <= Number(opts.rangeEnd));
        if (opts.onlyNew) {
          const existingSeries = await DB.getSeriesById(seriesId);
          const last = Number(existingSeries?.lastImportedChapter || 0);
          chapters = chapters.filter(c => c.number > last);
        }

        result.total = chapters.length;
        this._log('info', `Chapter list ready: ${chapters.length} chapters queued`);
        if (chapters.length === 0) {
          await this._finalizeSeries(seriesId, source.name);
          this.state = STATES.DONE;
          result.finishedAt = nowISO();
          this._emit('complete', result);
          return result;
        }

        // 5. Bulk import with concurrency + dedupe + retry
        await this._runBulk(source, seriesId, chapters, opts, result);

        // 6. Finalize series metadata
        await this._finalizeSeries(seriesId, source.name);

        result.finishedAt = nowISO();
        this.state = STATES.DONE;
        this._setProgress({
          phase: 'done',
          message: `Done. Imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed}.`,
          current: result.imported + result.skipped + result.failed,
          total: result.total
        });
        this._emit('complete', result);
        return result;

      } catch (err) {
        result.finishedAt = nowISO();
        if (err && err.message === '__CANCELLED__') {
          result.cancelled = true;
          this.state = STATES.CANCELLED;
          this._log('warn', 'Import cancelled by user');
          this._emit('cancelled', result);
        } else {
          this.state = STATES.ERROR;
          const url = (err && err.targetUrl) ? `\n  ↳ Failed URL: ${err.targetUrl}` : '';
          const attempts = (err && err.attempts && err.attempts.length)
            ? `\n  ↳ Attempts:\n    - ${err.attempts.join('\n    - ')}`
            : '';
          this._log('error', `Import failed: ${err?.message || err}${url}${attempts}`);
          this._emit('error', { error: err, result });
        }
        return result;
      } finally {
        this._emit('state', this.state);
      }
    },

    // ---------- Internals ----------
    /**
     * Normalize a raw chapter list so that:
     *   - decimal chapters (0.5, 1.5, 2.5, 100.5) are preserved as floats
     *   - Prologue / Epilogue / Side Story / Extra / Special chapters
     *     get synthetic sortable numbers but keep their original label
     *   - nothing valid is silently dropped (only entries with no URL go)
     *   - the list is sorted into proper reading order
     */
    _normalizeChapterList(raw) {
      const list = (raw || [])
        .filter(c => c && c.url)
        .map((c) => {
          const labelSource =
            (c.chapterLabel != null ? String(c.chapterLabel) : '') ||
            (c.number != null ? String(c.number) : '') ||
            (c.title || '');
          let num = Number(c.number);
          if (!Number.isFinite(num)) {
            // Try parsing the raw label (handles "152-5" -> 152.5)
            const norm = String(labelSource).trim().replace(/^(\d+)-(\d+)$/, '$1.$2');
            const fromLabel = parseFloat(norm);
            if (Number.isFinite(fromLabel)) {
              num = fromLabel;
            } else {
              // Last resort: pull the first number out of the title/url
              const fromTitle = String(c.title || '').match(/(\d+(?:\.\d+)?)/);
              const fromUrl = String(c.url || '').match(/chapter[\/-](\d+(?:[.-]\d+)?)/i);
              const candidate = (fromTitle && fromTitle[1]) ||
                (fromUrl && fromUrl[1] && fromUrl[1].replace(/^(\d+)-(\d+)$/, '$1.$2'));
              const n = parseFloat(candidate || '');
              num = Number.isFinite(n) ? n : null;
            }
          }
          return { ...c, number: num, _label: labelSource };
        });

      // Assign synthetic sort numbers for true non-numeric specials
      // (Prologue / Epilogue / Side Story / Extra / Special) so they
      // import successfully and land in a sensible reading order.
      let extraCounter = 0.0001;
      const numeric = list.filter(c => Number.isFinite(c.number));
      const minNum = numeric.length ? Math.min(...numeric.map(c => c.number)) : 1;
      const maxNum = numeric.length ? Math.max(...numeric.map(c => c.number)) : 1;
      for (const c of list) {
        if (Number.isFinite(c.number)) continue;
        const lbl = String(c._label || c.title || '').toLowerCase();
        if (lbl.includes('prologue')) c.number = minNum - 1;
        else if (lbl.includes('epilogue')) c.number = maxNum + 1 + extraCounter++;
        else c.number = maxNum + 0.5 + extraCounter++;
        if (!c.title) c.title = c._label || `Chapter ${c.number}`;
      }
      // Drop anything that STILL has no number (shouldn't happen, but safety)
      return list
        .filter(c => Number.isFinite(c.number))
        .sort((a, b) => a.number - b.number);
    },

    _normalizeSeriesInfo(info, source, seriesUrl) {
      info = info || {};
      const title = info.title || 'Untitled Series';
      return {
        title,
        slug: info.slug || slugify(title),
        cover: info.cover || '',
        coverImage: info.cover || '',          // app uses both names
        description: info.description || '',
        genres: Array.isArray(info.genres) ? info.genres : [],
        author: info.author || '',
        artist: info.artist || '',
        status: info.status || 'ongoing',
        alternativeTitles: Array.isArray(info.alternativeTitles) ? info.alternativeTitles : [],
        source: source.name,
        sourceUrl: info.sourceUrl || seriesUrl
      };
    },

    async _upsertSeries(info, existingId, upsertOpts = {}) {
      const { preserveMetadata = false } = upsertOpts;
      const rawFields = {
        cover: info.cover, coverImage: info.cover,
        banner: info.banner || null,
        bannerImage: info.banner || null,
        releaseYear: info.releaseYear || null,
        description: info.description,
        synopsis: info.description,
        genres: info.genres,
        author: info.author, artist: info.artist,
        status: info.status,
        alternativeTitles: info.alternativeTitles,
        source: info.source, sourceUrl: info.sourceUrl
      };
      // Strip empty/falsy values so a partial / failed scrape can never
      // wipe out fields that the admin (or a previous successful import)
      // already populated. Empty string, null, undefined, and [] all skip.
      const baseFields = {};
      for (const [k, v] of Object.entries(rawFields)) {
        if (v === undefined || v === null) continue;
        if (typeof v === 'string' && v.trim() === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        baseFields[k] = v;
      }
      // 1. Explicit id wins
      if (existingId) {
        const found = await DB.getSeriesById(existingId);
        if (found) {
          // Sync / Auto-Sync: keep the admin's metadata + cover untouched.
          // Only ensure sourceUrl is recorded so future syncs can find it.
          if (preserveMetadata) {
            const minimal = {};
            if (!found.sourceUrl && info.sourceUrl) minimal.sourceUrl = info.sourceUrl;
            if (!found.source && info.source)       minimal.source    = info.source;
            if (Object.keys(minimal).length) {
              await DB.updateSeries(existingId, minimal, { silent: true });
            }
            return existingId;
          }
          // Manual re-import: refresh metadata but keep existing values
          // for any field the source no longer provides (empty/missing).
          // Must NOT push the series to the top of "Recently Updated".
          const updates = { ...baseFields };
          if (info.title && info.title !== 'Untitled Series') updates.title = info.title;
          await DB.updateSeries(existingId, updates, { silent: true });
          return existingId;
        }
      }
      // 2. Match by sourceUrl
      try {
        const snap = await firebase.firestore()
          .collection('series')
          .where('sourceUrl', '==', info.sourceUrl)
          .limit(1).get();
        if (!snap.empty) {
          const id = snap.docs[0].id;
          if (preserveMetadata) {
            return id;
          }
          const updates = { ...baseFields };
          if (info.title && info.title !== 'Untitled Series') updates.title = info.title;
          await DB.updateSeries(id, updates, { silent: true });
          return id;
        }
      } catch (e) {
        this._log('warn', `Series lookup by sourceUrl failed: ${e.message}`);
      }
      // 3. Create new
      const created = await DB.addSeries({
        title: info.title,
        slug: info.slug,
        ...baseFields,
        totalChapters: 0,
        lastImportedChapter: 0,
        lastSyncTime: null
      });
      return created.id;
    },

    async _runBulk(source, seriesId, chapters, opts, result) {
      // Higher default concurrency (was 2). Most sources tolerate 4–6
      // parallel page requests cleanly; capped at 8 to stay polite.
      const concurrency = Math.max(1, Math.min(8, Number(opts.concurrency) || 5));
      let nextIndex = 0;

      // V10: when the caller (Auto-Sync) already loaded the existing
      // chapter numbers, reuse the same Set instead of re-querying.
      const existingNumbers = (opts.existingNumbers instanceof Set)
        ? opts.existingNumbers
        : await this._loadExistingChapterNumbers(seriesId);


      const total = chapters.length;
      const startedAtMs = Date.now();
      const updateProgress = () => {
        const done = result.imported + result.skipped + result.failed;
        const elapsedSec = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));
        const rate = done / elapsedSec; // chapters/sec
        const remaining = Math.max(0, total - done);
        const etaSec = rate > 0 ? Math.round(remaining / rate) : null;
        const etaStr = etaSec != null
          ? (etaSec > 60 ? `~${Math.round(etaSec / 60)}m left` : `~${etaSec}s left`)
          : '';
        this._setProgress({
          phase: 'import',
          current: done,
          total,
          message: `Imported ${result.imported} / ${total} (skipped ${result.skipped}, failed ${result.failed})${etaStr ? ' · ' + etaStr : ''}`
        });
      };
      updateProgress();

      const worker = async () => {
        while (true) {
          await this._checkpoint();
          const i = nextIndex++;
          if (i >= chapters.length) return;
          const chap = chapters[i];
          const chapLabel = chap.title || chap._label || `Chapter ${chap.number}`;

          // Dedupe
          if (!opts.overwrite && existingNumbers.has(chap.number)) {
            result.skipped++;
            this._log('skip', `${chapLabel} (#${chap.number}) already exists — skipped`,
              { number: chap.number, title: chapLabel, url: chap.url });
            updateProgress();
            continue;
          }

          let ok = false;
          let lastErr = null;
          for (let attempt = 1; attempt <= opts.maxRetries; attempt++) {
            try {
              await this._checkpoint();
              await this._importOneChapter(source, seriesId, chap, existingNumbers, opts);
              ok = true;
              break;
            } catch (err) {
              if (err && err.message === '__CANCELLED__') throw err;
              // Already-exists thrown after a successful fetch isn't a failure.
              if (err && err.message === '__ALREADY_EXISTS__') {
                ok = true; // treat as skip
                result.skipped++;
                this._log('skip', `${chapLabel} (#${chap.number}) already exists — skipped`,
                  { number: chap.number, title: chapLabel, url: chap.url });
                updateProgress();
                break;
              }
              lastErr = err;
              this._log('warn',
                `${chapLabel} (#${chap.number}) attempt ${attempt}/${opts.maxRetries} failed: ${err?.message || err}`,
                { number: chap.number, title: chapLabel, url: chap.url, attempt });
              if (attempt < opts.maxRetries) {
                // Faster exponential backoff with jitter (was 1s × 2^n,
                // capped at 15s; now 300ms × 2^n capped at 6s + 0–250ms jitter).
                const base = Math.min(6000, 300 * Math.pow(2, attempt));
                await sleep(base + Math.floor(Math.random() * 250));
              }
            }
          }

          if (ok && !lastErr) {
            result.imported++;
            this._log('success', `${chapLabel} (#${chap.number}) imported`,
              { number: chap.number, title: chapLabel });
          } else if (!ok) {
            result.failed++;
            result.failedChapters.push({
              number: chap.number,
              title: chapLabel,
              url: chap.url,
              error: lastErr?.message || String(lastErr)
            });
            this._log('error',
              `${chapLabel} (#${chap.number}) FAILED after ${opts.maxRetries} attempts — ${lastErr?.message || lastErr} [url: ${chap.url}]`,
              { number: chap.number, title: chapLabel, url: chap.url });
          }
          updateProgress();
        }
      };

      const pool = Array.from({ length: concurrency }, () => worker());
      await Promise.all(pool);
    },

    async _loadExistingChapterNumbers(seriesId) {
      const set = new Set();
      try {
        const snap = await firebase.firestore()
          .collection('chapters')
          .where('seriesId', '==', seriesId)
          .get();
        snap.forEach(d => {
          const n = d.data().chapterNumber;
          if (n != null) set.add(Number(n));
        });
      } catch (e) {
        this._log('warn', `Could not preload existing chapter numbers: ${e.message}`);
      }
      return set;
    },

    async _importOneChapter(source, seriesId, chap, existingNumbers, opts) {
      // Fetch chapter (pages)
      const getChapter = (typeof source.getChapter === 'function')
        ? source.getChapter.bind(source)
        : source.extract.bind(source);

      const raw = await getChapter(chap.url);
      if (!raw || !Array.isArray(raw.imageUrls) || raw.imageUrls.length === 0) {
        throw new Error('Chapter returned no images');
      }

      const chapterNumber = (raw.chapterNumber != null) ? Number(raw.chapterNumber) : Number(chap.number);
      const chapterTitle = chap.title || raw.chapterTitle || `Chapter ${chapterNumber}`;

      // Re-check dedupe in case another worker just wrote it
      if (!opts.overwrite) {
        const existing = await DB.getChapterByNumber(seriesId, chapterNumber);
        if (existing) {
          existingNumbers.add(chapterNumber);
          throw new Error('__ALREADY_EXISTS__');
        }
      }

      const payload = {
        seriesId,
        chapterNumber,
        chapterTitle,
        imageUrls: raw.imageUrls,
        // Pick a representative page (skip the first 1-2 pages which are
        // usually scanlator credits/cover, and the last page which is often
        // a credits/outro). Falls back gracefully for short chapters.
        thumbnail: pickRepresentativePage(raw.imageUrls, chapterNumber),
        source: source.name,
        sourceUrl: chap.url,
        importedAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      if (opts.overwrite) {
        const existing = await DB.getChapterByNumber(seriesId, chapterNumber);
        if (existing) {
          await DB.updateChapter(existing.id, payload);
        } else {
          await DB.addChapter(payload);
        }
      } else {
        await DB.addChapter(payload);
      }

      existingNumbers.add(chapterNumber);
    },

    async _finalizeSeries(seriesId, sourceName) {
      try {
        const snap = await firebase.firestore()
          .collection('chapters')
          .where('seriesId', '==', seriesId)
          .get();

        let total = 0;
        let lastNum = 0;
        let lastTitle = '';
        let lastId = '';
        snap.forEach(d => {
          total++;
          const data = d.data();
          const n = Number(data.chapterNumber || 0);
          if (n > lastNum) {
            lastNum = n;
            lastTitle = data.chapterTitle || '';
            lastId = d.id;
          }
        });

        // Bookkeeping only. `DB.addChapter` already bumps `updatedAt` on
        // each newly-inserted chapter, so we MUST stay silent here —
        // otherwise rescans with zero new chapters would still reorder
        // the "Recently Updated" feed.
        await DB.updateSeries(seriesId, {
          totalChapters: total,
          lastImportedChapter: lastNum,
          latestChapter: lastNum,
          latestChapterTitle: lastTitle,
          latestChapterId: lastId,
          source: sourceName,
          lastSyncTime: firebase.firestore.FieldValue.serverTimestamp()
        }, { silent: true });
      } catch (e) {
        this._log('warn', `Series finalization failed: ${e.message}`);
      }
    },

    _setProgress(p) {
      const now = Date.now();

      // Start tracking time when bulk chapter import begins
      if (p.phase === 'importing' && p.current === 0 && p.total > 0) {
        this._importStartTime = now;
        this._importStartCount = 0;
      }

      const merged = Object.assign({ phase: 'idle', current: 0, total: 0, message: '' }, p);

      // Calculate speed (chapters/sec) and ETA during active importing
      if (merged.phase === 'importing' && merged.total > 0 && this._importStartTime) {
        const elapsedSec = (now - this._importStartTime) / 1000;
        const done = merged.current - (this._importStartCount || 0);
        if (elapsedSec > 0.5 && done > 0) {
          const chapPerSec = done / elapsedSec;
          const remaining = merged.total - merged.current;
          const etaSec = remaining / chapPerSec;
          const etaStr = etaSec < 60
            ? `${Math.ceil(etaSec)}s`
            : `${Math.floor(etaSec / 60)}m ${Math.ceil(etaSec % 60)}s`;
          merged.speed = `${chapPerSec.toFixed(1)} ch/s`;
          merged.eta = etaStr;
          merged.message = `${merged.message} — ${chapPerSec.toFixed(1)} ch/s, ETA: ${etaStr}`.replace(/^ — /, '');
        }
      }

      if (merged.phase !== 'importing') {
        this._importStartTime = null;
      }

      this.progress = merged;
      this._emit('progress', this.progress);
    }
  };

  /**
   * Choose a representative page from a chapter for use as its thumbnail.
   * Skips the cover/credits pages that scanlation groups put at the start
   * and the credits/preview pages they put at the end. The choice is
   * deterministic per chapter number so the same chapter always gets the
   * same thumbnail across renders.
   */
  function pickRepresentativePage(imgs, chapterNumber) {
    if (!Array.isArray(imgs) || imgs.length === 0) return null;
    if (imgs.length === 1) return imgs[0];
    if (imgs.length === 2) return imgs[1];
    if (imgs.length === 3) return imgs[1];

    // Skip first 2 pages (cover + scanlator credits) and last 1 page
    // (often a "next chapter" / credits page). For very long chapters
    // skip a slightly bigger tail too.
    const skipStart = imgs.length >= 6 ? 2 : 1;
    const skipEnd   = imgs.length >= 10 ? 2 : 1;
    const lo = skipStart;
    const hi = Math.max(lo, imgs.length - 1 - skipEnd);

    // Deterministic pick within the safe range.
    const key = String(chapterNumber || imgs.length);
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    const idx = lo + (Math.abs(h) % Math.max(1, hi - lo + 1));
    return imgs[Math.min(idx, imgs.length - 1)];
  }

  global.SeriesSourceRegistry = SeriesSourceRegistry;
  global.SeriesImporter = SeriesImporter;
})(window);
