/**
 * ============================================================
 * MANHWA PLATFORM - SERIES SYNC (auto + manual)
 * ============================================================
 * Detects newly released chapters on the source and imports only
 * the missing ones. Never re-downloads chapters that already exist.
 *
 * Public API (unchanged):
 *   SeriesSync.syncSeries(seriesId)
 *   SeriesSync.syncAll(opts)
 *   SeriesSync.startAutoSync(intervalMinutes)
 *   SeriesSync.stopAutoSync()
 *   SeriesSync.getAutoSyncInfo()
 *   SeriesSync.getStats()
 *   SeriesSync.getSyncLogs()
 *   SeriesSync.clearSyncLogs()
 *   SeriesSync.on(event, cb) / off(event, cb)
 *   SeriesSync.getProgress()
 *   SeriesSync.isRunning()
 *   SeriesSync.isAutoSyncOn()
 *
 * V10 IMPROVEMENTS:
 *   - Web-Locks-based leader election so only ONE tab runs the sync at
 *     a time, but if that tab is closed mid-run another tab automatically
 *     picks up where it left off (no more "restart from Series 1/20").
 *   - Resumable run state: currentIndex + per-series checked set persisted
 *     to localStorage every step. Page navigations / refreshes / hard
 *     closes resume the same run instead of restarting.
 *   - Smarter source detection: never relies on `lastImportedChapter`
 *     alone (which can be corrupted by synthetic side-story numbers).
 *     Always cross-checks the source's full chapter list against the
 *     actual set of existing chapter numbers in Firestore.
 *   - Per-series quick-throttle: skips re-checking a series that was
 *     checked successfully within the last `MIN_RECHECK_MS` window
 *     during the same run, cutting redundant network + DB reads.
 *   - Higher default parallelism (3 -> 6) for syncAll.
 *   - Single chapter-collection read per series, shared with the importer
 *     so a sync of a series with N existing chapters costs 1 read instead
 *     of 2.
 *   - Background service worker hand-off (periodicSync + visibility +
 *     focus + storage) so sync keeps running across the whole site.
 * ============================================================
 */
(function (global) {
  'use strict';

  const STORAGE_KEY      = 'mp_series_sync_config';
  const STATS_KEY        = 'mp_series_sync_stats';
  const LOGS_KEY         = 'mp_series_sync_logs';
  const PROGRESS_KEY     = 'mp_series_sync_progress';      // live progress shared across pages/tabs
  const RESUME_KEY       = 'mp_series_sync_resume';        // persisted resumable run state
  const LOCK_KEY         = 'mp_series_sync_lock';          // legacy cross-tab mutex (kept for back-compat)
  const LOCK_TTL_MS      = 15 * 60 * 1000;
  const MAX_LOGS         = 300;
  const WATCHDOG_MS      = 30 * 1000;
  const MIN_RECHECK_MS   = 10 * 60 * 1000;                 // don't re-check a series checked < 10min ago
  const LEADER_LOCK_NAME = 'mp_series_sync_leader_v1';     // Web Locks lock name

  const SyncListeners = {};
  function emit(event, payload) {
    (SyncListeners[event] || []).forEach(cb => {
      try { cb(payload); } catch (e) { console.error('[SeriesSync] listener error', e); }
    });
    try {
      if (bcastChannel && (event === 'status' || event === 'syncStart' ||
          event === 'syncDone'   || event === 'syncError' ||
          event === 'syncAllStart' || event === 'syncAllDone' ||
          event === 'log')) {
        bcastChannel.postMessage({ type: 'mp-sync-event', event, payload });
      }
    } catch (_) {}
  }

  // ---------- live progress (shared across tabs + persisted) ----------
  function getProgress() {
    try { return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || null; }
    catch { return null; }
  }
  function setProgress(p) {
    try {
      if (p == null) localStorage.removeItem(PROGRESS_KEY);
      else localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
    } catch (_) {}
  }
  function patchProgress(patch) {
    const cur = getProgress() || {
      active: false, total: 0, done: 0, imported: 0, failed: 0,
      currentTitle: '', startedAt: 0, finishedAt: 0
    };
    Object.assign(cur, patch);
    setProgress(cur);
  }

  // ---------- resumable run state ----------
  // Saved every step so any tab can pick up where the previous leader
  // left off. Cleared explicitly when a run finishes successfully.
  function getResume() {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY)) || null; }
    catch { return null; }
  }
  function setResume(s) {
    try {
      if (s == null) localStorage.removeItem(RESUME_KEY);
      else localStorage.setItem(RESUME_KEY, JSON.stringify(s));
    } catch (_) {}
  }

  // Status filter: skip series whose status is not actively updating.
  const SYNC_SKIP_STATUSES = new Set(['completed','complete','hiatus','dropped','cancelled','canceled']);
  function isSyncableStatus(status) {
    if (status == null || status === '') return true;
    return !SYNC_SKIP_STATUSES.has(String(status).trim().toLowerCase());
  }

  // ---------- persisted config / stats / logs ----------
  function getConfig() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const cfg = raw ? JSON.parse(raw) : null;
      return Object.assign(
        { enabled: false, intervalMinutes: 60, lastRun: null, lastSuccess: null, lastFailure: null },
        cfg || {}
      );
    } catch {
      return { enabled: false, intervalMinutes: 60, lastRun: null, lastSuccess: null, lastFailure: null };
    }
  }
  function setConfig(cfg) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg)); } catch (_) {}
  }
  function getStats() {
    try { return JSON.parse(localStorage.getItem(STATS_KEY)) || emptyStats(); }
    catch { return emptyStats(); }
  }
  function setStats(s) {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(s)); } catch (_) {}
  }
  function emptyStats() {
    return {
      seriesChecked: 0, newChaptersFound: 0, imported: 0, failed: 0,
      lastSuccess: null, lastFailure: null, lastRunAt: null,
      lastRunDurationMs: 0, lastErrors: []
    };
  }
  function getLogs() {
    try { return JSON.parse(localStorage.getItem(LOGS_KEY)) || []; }
    catch { return []; }
  }
  function pushLog(level, message) {
    const entry = { ts: Date.now(), level, message: String(message) };
    const logs = getLogs();
    logs.unshift(entry);
    if (logs.length > MAX_LOGS) logs.length = MAX_LOGS;
    try { localStorage.setItem(LOGS_KEY, JSON.stringify(logs)); } catch (_) {}
    emit('log', entry);
    return entry;
  }

  // ---------- helpers ----------
  function truncate(s, max) {
    s = String(s == null ? '' : s);
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }
  function safeHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch { return 'unknown'; }
  }
  function recordError(stats, seriesId, title, source, error) {
    stats.lastErrors = stats.lastErrors || [];
    stats.lastErrors.unshift({
      seriesId, title: String(title || '(untitled)'),
      source: String(source || 'unknown'),
      error: truncate(error, 240),
      at: new Date().toISOString()
    });
    if (stats.lastErrors.length > 20) stats.lastErrors.length = 20;
  }

  // ---------- BroadcastChannel ----------
  let bcastChannel = null;
  try { bcastChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mp_series_sync') : null; } catch (_) { bcastChannel = null; }
  if (bcastChannel) {
    bcastChannel.addEventListener('message', (ev) => {
      const d = ev.data || {};
      if (d.type !== 'mp-sync-event') return;
      (SyncListeners[d.event] || []).forEach(cb => {
        try { cb(d.payload); } catch (e) { console.error('[SeriesSync] remote listener error', e); }
      });
    });
  }
  try {
    window.addEventListener('storage', (e) => {
      if (!e || !e.key) return;
      if (e.key === STORAGE_KEY || e.key === STATS_KEY || e.key === PROGRESS_KEY) {
        (SyncListeners['configChanged'] || []).forEach(cb => { try { cb({ key: e.key }); } catch (_) {} });
      }
    });
  } catch (_) {}

  // ---------- legacy localStorage lock (back-compat — webLocks supersede it) ----------
  const HEARTBEAT_MS       = 5000;
  const HEARTBEAT_STALE_MS = 12000;
  let heartbeatTimer = null;
  function acquireLegacyLock() {
    const now = Date.now();
    try {
      const raw = localStorage.getItem(LOCK_KEY);
      if (raw) {
        let held = 0;
        try { held = JSON.parse(raw).heartbeat || 0; }
        catch { held = Number(raw) || 0; }
        if (now - held < HEARTBEAT_STALE_MS) return false;
        if (held && now - held < LOCK_TTL_MS) {
          try { pushLog('warn', 'Stuck sync lock detected (no heartbeat) — reclaiming.'); } catch (_) {}
        }
      }
      localStorage.setItem(LOCK_KEY, JSON.stringify({ heartbeat: now, acquiredAt: now }));
      startHeartbeat();
      return true;
    } catch { return true; }
  }
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      try {
        const raw = localStorage.getItem(LOCK_KEY);
        if (!raw) return;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = { acquiredAt: Date.now() }; }
        parsed.heartbeat = Date.now();
        localStorage.setItem(LOCK_KEY, JSON.stringify(parsed));
      } catch (_) {}
    }, HEARTBEAT_MS);
  }
  function stopHeartbeat() {
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }
  function releaseLegacyLock() {
    stopHeartbeat();
    try { localStorage.removeItem(LOCK_KEY); } catch (_) {}
  }

  // ---------- Web Locks leader election ----------
  // The leader is the single tab actively running syncAll right now.
  // If the leader tab closes, the browser releases the lock automatically
  // and another open tab picks it up — without losing progress (which is
  // persisted in localStorage RESUME_KEY).
  const hasWebLocks = !!(navigator && navigator.locks && typeof navigator.locks.request === 'function');
  let leaderReleaseFn = null;
  let leaderPromise = null;

  function acquireLeader() {
    if (!hasWebLocks) return Promise.resolve(true); // fall back to legacy lock
    if (leaderReleaseFn) return Promise.resolve(true);
    return new Promise((resolve) => {
      const acquired = new Promise((releaseResolve) => {
        leaderPromise = navigator.locks.request(
          LEADER_LOCK_NAME,
          { mode: 'exclusive', ifAvailable: true },
          (lock) => {
            if (!lock) { resolve(false); return; }   // someone else holds it
            leaderReleaseFn = releaseResolve;
            resolve(true);
            return acquired;                           // hold until released
          }
        ).catch(() => { resolve(false); });
      });
    });
  }
  function releaseLeader() {
    if (leaderReleaseFn) { try { leaderReleaseFn(); } catch (_) {} leaderReleaseFn = null; }
    leaderPromise = null;
  }

  function mirrorConfigToCloud(patch) {
    try {
      if (!window.firebase || !firebase.firestore) return;
      const data = Object.assign({}, patch || {}, {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      firebase.firestore().collection('config').doc('autoSync')
        .set(data, { merge: true }).catch(() => {});
    } catch (_) {}
  }

  let watchdogId = null;
  let runningPromise = null;

  // ---------- public API ----------
  const SeriesSync = {
    on(event, cb) { (SyncListeners[event] = SyncListeners[event] || []).push(cb); },
    off(event, cb) {
      if (!SyncListeners[event]) return;
      SyncListeners[event] = SyncListeners[event].filter(f => f !== cb);
    },

    /**
     * Sync one series. Returns the SeriesImporter result.
     * Accepts an optional pre-loaded `existingNumbers` Set so callers
     * (notably syncAll) can avoid a redundant Firestore round-trip.
     */
    async syncSeries(seriesId, ctx = {}) {
      const series = await DB.getSeriesById(seriesId);
      if (!series) throw new Error('Series not found: ' + seriesId);

      const urls = (Array.isArray(series.sourceUrls) && series.sourceUrls.length
        ? series.sourceUrls
        : (series.sourceUrl ? [series.sourceUrl] : []))
        .map(u => String(u || '').trim()).filter(Boolean);

      if (urls.length === 0) {
        throw new Error(`Series "${series.title}" has no sourceUrl — cannot sync`);
      }

      emit('syncStart', { seriesId, title: series.title });
      emit('status', { state: 'running', message: `Syncing ${series.title}…`, seriesId, title: series.title });
      pushLog('info', `Sync started: ${series.title} (${urls.length} source${urls.length > 1 ? 's' : ''})`);

      // Existing chapter set — one Firestore read per series. Reused
      // by the importer below so we don't pay for it twice.
      let existing = ctx.existingNumbers instanceof Set ? ctx.existingNumbers : null;
      if (!existing) {
        existing = new Set();
        const snap = await firebase.firestore()
          .collection('chapters').where('seriesId', '==', seriesId).get();
        snap.forEach(d => existing.add(Number(d.data().chapterNumber)));
      }

      const newByNumber = new Map(); // chapterNumber -> { url, chapter }
      const aggregated = { imported: 0, skipped: 0, failed: 0, total: 0 };
      let anyUrlSucceeded = false;
      const errors = [];

      const callWithRetry = async (fn, label) => {
        let lastErr;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try { return await fn(); }
          catch (e) {
            lastErr = e;
            if (attempt < 3) await new Promise(r => setTimeout(r, 600 * attempt));
          }
        }
        throw new Error(`${label} failed after 3 attempts: ${lastErr?.message || lastErr}`);
      };

      for (const url of urls) {
        const source = global.SeriesSourceRegistry.findSeriesSource(url);
        if (!source) {
          errors.push(`No plugin supports ${url}`);
          pushLog('warn', `Sync: skipping unsupported URL for ${series.title}: ${url}`);
          continue;
        }
        try {
          // V10 fix: ALWAYS fetch the full chapter list and dedupe against
          // the real existing-chapters set. Relying on `plugin.checkUpdates`
          // alone (which compares against series.lastImportedChapter) misses
          // new chapters whenever lastImportedChapter has been corrupted by
          // a synthetic side-story number (a real bug we kept hitting on
          // /comics/the-demon-king-overrun-by-heroes-89829cb7).
          const fullList = await callWithRetry(
            () => source.getChapterList(url),
            'getChapterList'
          );
          anyUrlSucceeded = true;
          const candidate = fullList.filter(c => {
            const n = Number(c.number);
            return Number.isFinite(n) && !existing.has(n);
          });
          for (const c of candidate) {
            const n = Number(c.number);
            if (!newByNumber.has(n)) newByNumber.set(n, { url, chapter: c });
          }
        } catch (e) {
          errors.push(`${url}: ${e.message || e}`);
          pushLog('warn', `Sync: source failed for ${series.title} — ${url} — ${e.message || e}`);
        }
      }

      if (!anyUrlSucceeded) {
        throw new Error('All source URLs failed: ' + errors.join(' | '));
      }

      const newChapters = Array.from(newByNumber.values());

      if (newChapters.length === 0) {
        await DB.updateSeries(seriesId, {
          lastSyncTime: firebase.firestore.FieldValue.serverTimestamp()
        }, { silent: true });
        const result = { seriesId, title: series.title, imported: 0, skipped: 0, failed: 0, total: 0, newFound: 0 };
        emit('syncDone', result);
        emit('status', { state: 'noNew', message: `No new chapters for ${series.title}`, seriesId, title: series.title });
        pushLog('info', `No new chapters: ${series.title}`);
        return result;
      }

      // Group new chapters by source URL and import each batch from the
      // URL that originally provided them.
      const byUrl = new Map();
      for (const { url, chapter } of newChapters) {
        if (!byUrl.has(url)) byUrl.set(url, []);
        byUrl.get(url).push(chapter);
      }

      for (const [url, chapters] of byUrl) {
        const nums = chapters.map(c => Number(c.number)).filter(Number.isFinite);
        if (nums.length === 0) continue;
        const rangeStart = Math.min(...nums);
        const rangeEnd   = Math.max(...nums);
        try {
          const r = await global.SeriesImporter.importSeries(url, {
            seriesId, rangeStart, rangeEnd,
            onlyNew: true, overwrite: false,
            concurrency: 5,
            preserveMetadata: true,
            // V10: pass the already-loaded set so the importer doesn't
            // re-query the chapters collection a second time.
            existingNumbers: existing
          });
          aggregated.imported += r.imported || 0;
          aggregated.skipped  += r.skipped  || 0;
          aggregated.failed   += r.failed   || 0;
          aggregated.total    += r.total    || nums.length;
        } catch (e) {
          aggregated.failed += nums.length;
          pushLog('warn', `Sync: import failed for ${series.title} from ${url} — ${e.message || e}`);
        }
      }

      const result = {
        seriesId, title: series.title,
        imported: aggregated.imported, skipped: aggregated.skipped,
        failed: aggregated.failed, total: aggregated.total,
        newFound: newChapters.length
      };

      // Defensive Recently-Updated bump.
      //
      // DB.addChapter already bumps `updatedAt` on every new chapter, but
      // historically a regular-user Auto-Sync could leave a series stuck
      // at its old timestamp (e.g. if the full series-doc update was
      // partially rejected and the minimal fallback was skipped). To
      // guarantee identical behaviour for Admin / Moderator / User /
      // Guest-triggered runs, we *explicitly* bump `updatedAt` here
      // whenever at least one new chapter was imported. This also
      // ensures the latestChapter* fields reflect the most-recent
      // import even when `_finalizeSeries` ran silently.
      if ((aggregated.imported || 0) > 0) {
        try {
          // Re-read so we can write the true latest chapter number/title.
          const latest = await DB.getSeriesById(seriesId);
          const patch = {};
          if (latest && latest.latestChapter != null) {
            patch.latestChapter = latest.latestChapter;
          }
          if (latest && latest.latestChapterId) {
            patch.latestChapterId = latest.latestChapterId;
          }
          if (latest && latest.latestChapterTitle) {
            patch.latestChapterTitle = latest.latestChapterTitle;
          }
          // Non-silent update → DB.updateSeries adds serverTimestamp
          // `updatedAt`, which is the field "Recently Updated" sorts by.
          await DB.updateSeries(seriesId, patch);
        } catch (e) {
          // Fall back to the absolute minimum that the public-user
          // whitelist in firestore.rules permits.
          try {
            await firebase.firestore().collection('series').doc(seriesId).update({
              updatedAt: firebase.firestore.FieldValue.serverTimestamp()
            });
          } catch (e2) {
            pushLog('warn', `Recently-Updated bump failed for ${series.title}: ${e2?.message || e2}`);
          }
        }
      }

      emit('syncDone', { ...result, title: series.title });
      emit('status', {
        state: 'completed',
        message: `Imported ${result.imported || 0} new chapter(s) for ${series.title}` +
                 (urls.length > 1 ? ` (across ${urls.length} sources)` : ''),
        seriesId, title: series.title
      });
      pushLog(
        (result.failed || 0) > 0 ? 'warn' : 'success',
        `Sync done: ${series.title} — imported ${result.imported || 0}, failed ${result.failed || 0}`
      );
      return result;
    },

    /**
     * Sync every series that has a sourceUrl. Deduped across tabs by
     * Web Locks (with legacy localStorage lock fallback). Resumable
     * across navigations: progress is persisted on every step, and if
     * the leader tab dies another open tab picks up automatically.
     */
    async syncAll(opts = {}) {
      if (runningPromise) return runningPromise;

      // 1) Try to become the leader via Web Locks (preferred). On older
      //    browsers, fall back to the legacy localStorage heartbeat lock.
      const gotLeader = await acquireLeader();
      if (!gotLeader) {
        pushLog('warn', 'Sync skipped — leader running in another tab.');
        emit('status', { state: 'running', message: 'Sync already running in another tab' });
        return [];
      }
      if (!hasWebLocks && !acquireLegacyLock()) {
        pushLog('warn', 'Sync skipped — another tab/run is already in progress.');
        emit('status', { state: 'running', message: 'Sync already running in another tab' });
        return [];
      }

      runningPromise = (async () => {
        const { maxParallel = 6, force = false } = opts;
        const stats = emptyStats();
        const results = [];

        emit('status', { state: 'running', message: 'Sync running…' });
        pushLog('info', 'Sync All started');

        try {
          // 2) Load (or resume) the series list. If a previous run was
          //    interrupted (leader closed mid-run), we keep its order and
          //    skip the series already marked processed.
          let resume = getResume();
          let all;
          const checkedAt = (resume && resume.checkedAt) || {};
          const processed = new Set(resume && Array.isArray(resume.processed) ? resume.processed : []);

          if (resume && Array.isArray(resume.queue) && resume.queue.length) {
            all = resume.queue;
            pushLog('info', `Resuming previous run — ${processed.size}/${all.length} already done`);
          } else {
            const snap = await firebase.firestore().collection('series').get();
            const list = [];
            let skippedInactive = 0;
            snap.forEach(d => {
              const data = d.data();
              const hasUrl = data.sourceUrl || (Array.isArray(data.sourceUrls) && data.sourceUrls.length);
              if (!hasUrl) return;
              if (!isSyncableStatus(data.status)) { skippedInactive++; return; }
              // Keep payload tiny — only what worker needs.
              list.push({
                id: d.id,
                title: data.title || '(untitled)',
                source: data.source || (data.sourceUrl ? safeHost(data.sourceUrl) : 'unknown')
              });
            });
            if (skippedInactive > 0) pushLog('info', `Auto-Sync filter: skipped ${skippedInactive} inactive (completed/hiatus/dropped) series`);
            all = list;
          }

          const startedAt = (resume && resume.startedAt) || Date.now();
          stats.seriesChecked = all.length;

          setResume({
            queue: all, processed: [...processed], checkedAt,
            startedAt, total: all.length
          });
          patchProgress({
            active: true, total: all.length,
            done: processed.size, imported: 0, failed: 0,
            currentTitle: '', startedAt
          });
          emit('syncAllStart', { total: all.length, resumed: !!(resume && resume.queue) });

          // 3) Atomic next-item dispenser (shared across workers).
          let nextIdx = 0;
          const claimNext = () => {
            while (nextIdx < all.length) {
              const i = nextIdx++;
              const s = all[i];
              if (processed.has(s.id)) continue;
              // Quick throttle: skip if checked successfully in last MIN_RECHECK_MS
              if (!force && checkedAt[s.id] && (Date.now() - checkedAt[s.id]) < MIN_RECHECK_MS) {
                processed.add(s.id);
                continue;
              }
              return s;
            }
            return null;
          };

          const persistResume = () => {
            try {
              setResume({
                queue: all, processed: [...processed], checkedAt,
                startedAt, total: all.length
              });
            } catch (_) {}
          };

          const worker = async () => {
            while (true) {
              const s = claimNext();
              if (!s) return;
              patchProgress({ currentTitle: s.title || '' });
              try {
                const r = await this.syncSeries(s.id);
                checkedAt[s.id] = Date.now();
                stats.newChaptersFound += r.newFound || 0;
                stats.imported         += r.imported || 0;
                stats.failed           += r.failed   || 0;
                results.push({ ok: true, series: s.title, ...r });
                patchProgress({
                  done: (getProgress()?.done || 0) + 1,
                  imported: (getProgress()?.imported || 0) + (r.imported || 0),
                  failed: (getProgress()?.failed || 0) + (r.failed || 0)
                });
                if ((r.failed || 0) > 0) {
                  recordError(stats, s.id, s.title, s.source,
                    `${r.failed} chapter(s) failed during import`);
                }
              } catch (e) {
                stats.failed += 1;
                const errMsg = truncate(e && (e.message || String(e)), 240);
                results.push({ ok: false, series: s.title, error: errMsg });
                emit('syncError', { seriesId: s.id, title: s.title, error: errMsg });
                pushLog('error', `Sync failed: ${s.title} [${s.source}] — ${errMsg}`);
                recordError(stats, s.id, s.title, s.source, errMsg);
                patchProgress({
                  done: (getProgress()?.done || 0) + 1,
                  failed: (getProgress()?.failed || 0) + 1
                });
              } finally {
                processed.add(s.id);
                // Persist after every step so any interruption is recoverable.
                persistResume();
              }
            }
          };

          const poolSize = Math.max(1, Math.min(8, Number(maxParallel) || 6));
          await Promise.all(Array.from({ length: poolSize }, () => worker()));

          const cfg = getConfig();
          const nowIso = new Date().toISOString();
          cfg.lastRun = nowIso;
          cfg.lastSuccess = nowIso;
          setConfig(cfg);
          mirrorConfigToCloud({ lastRun: nowIso, lastSuccess: nowIso });

          stats.lastRunAt = nowIso;
          stats.lastSuccess = nowIso;
          stats.lastRunDurationMs = Date.now() - startedAt;
          setStats(stats);

          // Run completed successfully — clear resume state.
          setResume(null);
          patchProgress({ active: false, finishedAt: Date.now(), currentTitle: '' });
          emit('syncAllDone', { results, stats });
          const durSec = Math.round(stats.lastRunDurationMs / 100) / 10;
          emit('status', {
            state: stats.imported > 0 ? 'completed' : (stats.failed > 0 ? 'failed' : 'noNew'),
            message: stats.imported > 0
              ? `Sync complete — ${stats.imported} new chapter(s) across ${stats.seriesChecked} series` +
                (stats.failed > 0 ? ` (${stats.failed} failed)` : '')
              : (stats.failed > 0
                  ? `Sync finished with ${stats.failed} failure(s) across ${stats.seriesChecked} series`
                  : `Sync complete — no new chapters across ${stats.seriesChecked} series`)
          });
          const summaryLevel =
            stats.failed === 0 ? 'success'
            : (stats.imported === 0 ? 'error' : 'warn');
          pushLog(summaryLevel,
            `Sync All complete — checked ${stats.seriesChecked}, new ${stats.newChaptersFound}, ` +
            `imported ${stats.imported}, failed ${stats.failed} (${durSec}s)`);
          return results;
        } catch (e) {
          const cfg = getConfig();
          cfg.lastRun = new Date().toISOString();
          cfg.lastFailure = cfg.lastRun;
          setConfig(cfg);
          stats.lastRunAt = cfg.lastRun;
          stats.lastFailure = cfg.lastRun;
          setStats(stats);
          // Keep RESUME_KEY so the next leader (this tab on retry, or
          // another tab) picks up where we left off.
          patchProgress({ active: false, finishedAt: Date.now(), currentTitle: '' });
          emit('status', { state: 'failed', message: 'Sync failed: ' + (e.message || e) });
          pushLog('error', 'Sync All failed: ' + (e.message || e));
          throw e;
        } finally {
          releaseLegacyLock();
          releaseLeader();
          runningPromise = null;
        }
      })();

      return runningPromise;
    },

    // ---------- Auto sync scheduler ----------
    startAutoSync(intervalMinutes) {
      const minutes = Math.max(5, Number(intervalMinutes) || 60);

      if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }

      const cfg = getConfig();
      cfg.enabled = true;
      cfg.intervalMinutes = minutes;
      setConfig(cfg);

      const tickIfDue = async () => {
        const c = getConfig();
        if (!c.enabled) return;
        // If a previous run was interrupted, always pick it back up
        // regardless of the scheduled interval.
        const hasResume = !!getResume();
        const lastRunMs = c.lastRun ? Date.parse(c.lastRun) : 0;
        const dueAt = lastRunMs + (c.intervalMinutes * 60 * 1000);
        if (!hasResume && Date.now() < dueAt) return;
        if (runningPromise) return;
        try {
          console.log('[SeriesSync] Auto-sync tick' + (hasResume ? ' (resume)' : ''));
          pushLog('info', 'Auto-sync tick' + (hasResume ? ' — resuming previous run' : ''));
          await this.syncAll();
        } catch (e) {
          console.error('[SeriesSync] Auto-sync error', e);
        }
      };

      watchdogId = setInterval(() => tickIfDue(), WATCHDOG_MS);

      if (!this._visibilityHooked) {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') tickIfDue();
        });
        window.addEventListener('focus', () => tickIfDue());
        // Also try to grab leadership whenever the user comes back —
        // covers the case where the previous leader was just closed.
        this._visibilityHooked = true;
      }

      emit('autoSyncStarted', { intervalMinutes: minutes });
      pushLog('info', `Auto-sync enabled — every ${minutes} min`);
      mirrorConfigToCloud({ enabled: true, intervalMinutes: minutes });

      // Kick once shortly after enabling so admins see immediate effect.
      setTimeout(() => tickIfDue(), 1500);
      return { enabled: true, intervalMinutes: minutes };
    },

    stopAutoSync() {
      if (watchdogId) { clearInterval(watchdogId); watchdogId = null; }
      const cfg = getConfig(); cfg.enabled = false; setConfig(cfg);
      emit('autoSyncStopped', {});
      pushLog('info', 'Auto-sync disabled');
      mirrorConfigToCloud({ enabled: false });
      return { enabled: false };
    },

    getAutoSyncInfo() { return { ...getConfig(), running: !!runningPromise, watchdog: !!watchdogId }; },
    isAutoSyncOn()    { return !!getConfig().enabled; },
    getProgress()     { return getProgress(); },
    isRunning()       { return !!runningPromise; },
    getStats()        { return getStats(); },
    getSyncLogs()     { return getLogs(); },
    clearSyncLogs()   { try { localStorage.removeItem(LOGS_KEY); } catch (_) {} },

    /**
     * Re-arm auto-sync after a page reload / navigation. Crucially this
     * is what makes V10 survive page changes: every page that loads
     * series-sync.js calls initFromStorage on DOMContentLoaded, which
     *   (a) re-attaches the watchdog,
     *   (b) tries to become the leader, and
     *   (c) resumes any in-progress run from the persisted RESUME_KEY.
     */
    initFromStorage() {
      const self = this;
      const hydrateFromCloud = () => {
        try {
          if (!window.firebase || !firebase.firestore) return;
          const ref = firebase.firestore().collection('config').doc('autoSync');
          ref.get().then((snap) => {
            if (!snap.exists) return;
            const remote = snap.data() || {};
            const cur = getConfig();
            const merged = Object.assign({}, cur, {
              enabled: typeof remote.enabled === 'boolean' ? remote.enabled : cur.enabled,
              intervalMinutes: Number(remote.intervalMinutes) || cur.intervalMinutes,
              lastRun: remote.lastRun || cur.lastRun
            });
            setConfig(merged);
            if (merged.enabled && !watchdogId) self.startAutoSync(merged.intervalMinutes);
            if (!merged.enabled && watchdogId) { clearInterval(watchdogId); watchdogId = null; }
          }).catch(() => {});
          if (!self._cloudCfgHooked) {
            ref.onSnapshot((snap) => {
              if (!snap.exists) return;
              const remote = snap.data() || {};
              const cur = getConfig();
              cur.enabled = typeof remote.enabled === 'boolean' ? remote.enabled : cur.enabled;
              cur.intervalMinutes = Number(remote.intervalMinutes) || cur.intervalMinutes;
              if (remote.lastRun) cur.lastRun = remote.lastRun;
              setConfig(cur);
              if (cur.enabled && !watchdogId) self.startAutoSync(cur.intervalMinutes);
              if (!cur.enabled && watchdogId) { clearInterval(watchdogId); watchdogId = null; }
            }, () => {});
            self._cloudCfgHooked = true;
          }
        } catch (_) {}
      };
      hydrateFromCloud();

      const cfg = getConfig();
      if (!cfg.enabled) return;
      this.startAutoSync(cfg.intervalMinutes);

      // V10: if a previous run was interrupted (resume state present),
      // pick it back up RIGHT NOW — don't wait for the next scheduled tick.
      const resume = getResume();
      if (resume && Array.isArray(resume.queue) && resume.queue.length) {
        setTimeout(() => {
          pushLog('info', `Resuming auto-sync from previous run (${(resume.processed || []).length}/${resume.queue.length} done)`);
          this.syncAll().catch(e => console.error('[SeriesSync] resume failed', e));
        }, 1200);
      } else {
        const lastRunMs = cfg.lastRun ? Date.parse(cfg.lastRun) : 0;
        const overdueBy = Date.now() - (lastRunMs + cfg.intervalMinutes * 60 * 1000);
        if (overdueBy >= 0) {
          setTimeout(() => {
            pushLog('info', `Catch-up auto-sync on load (overdue by ${Math.round(overdueBy / 60000)} min)`);
            this.syncAll().catch(e => console.error('[SeriesSync] catch-up failed', e));
          }, 1500);
        }
      }

      // Service worker hand-off for background ticks.
      try {
        if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({
            type: 'mp-register-periodic-sync',
            intervalMinutes: cfg.intervalMinutes
          });
        }
        if ('serviceWorker' in navigator && !this._swHooked) {
          navigator.serviceWorker.addEventListener('message', (ev) => {
            if (ev.data && ev.data.type === 'mp-run-sync-all') {
              pushLog('info', 'Auto-sync triggered by service worker');
              this.syncAll().catch(e => console.error('[SeriesSync] sw-triggered sync failed', e));
            }
          });
          this._swHooked = true;
        }
        if (bcastChannel && !this._bcHooked) {
          bcastChannel.addEventListener('message', (ev) => {
            if (ev.data && ev.data.type === 'mp-run-sync-all') {
              this.syncAll().catch(() => {});
            }
          });
          this._bcHooked = true;
        }
      } catch (_) {}
    }
  };

  global.SeriesSync = SeriesSync;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SeriesSync.initFromStorage());
  } else {
    SeriesSync.initFromStorage();
  }
})(window);
