/**
 * ============================================================
 * IMPORT SERIES PAGE - CONTROLLER
 * ============================================================
 * Glues the HTML in pages/admin-import-series.html to
 * SeriesImporter, SeriesSync, DB, Auth.
 * ============================================================
 */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const logFilters = { success: true, skip: true, warn: true, error: true, info: true };
  let currentPreview = null;

  const ImportSeriesPage = {
    async init() {
      // Require admin
      try {
        await new Promise((resolve) => {
          const stop = firebase.auth().onAuthStateChanged(async (user) => {
            stop();
            if (!user) { window.location.href = 'login.html'; return; }
            const isAdmin = (typeof Auth?.isAdmin === 'function') ? await Auth.isAdmin(user.uid) : true;
            if (!isAdmin) { alert('Admin access required'); window.location.href = '../index.html'; return; }
            resolve();
          });
        });
      } catch (e) { console.error(e); }

      // Hide loader
      const ls = $('loadingScreen'); if (ls) ls.style.display = 'none';

      // Hook importer events
      SeriesImporter.on('log',      this._renderLog.bind(this));
      SeriesImporter.on('progress', this._renderProgress.bind(this));
      SeriesImporter.on('state',    this._renderState.bind(this));
      SeriesImporter.on('complete', this._onComplete.bind(this));
      SeriesImporter.on('cancelled',this._onComplete.bind(this));
      SeriesImporter.on('error',    (e) => alert('Import error: ' + (e.error?.message || e.error)));

      // Sources list
      const supported = SeriesSourceRegistry.listSeriesSources();
      $('supportedSources').textContent = supported.length
        ? 'Supported sources for full series import: ' + supported.map(s => s.name + ' (' + s.domain + ')').join(', ')
        : 'No series-capable source plugins registered.';

      // Log filters
      document.querySelectorAll('[data-log-filter]').forEach(cb => {
        cb.addEventListener('change', () => {
          logFilters[cb.dataset.logFilter] = cb.checked;
          this._rerenderLogs();
        });
      });

      // Auto-sync state
      const info = SeriesSync.getAutoSyncInfo();
      $('autoSyncToggle').checked = !!info.enabled;
      $('autoSyncInterval').value = info.intervalMinutes || 60;
      this._renderAutoSyncStatus();
      this._renderSyncStats();
      this._renderSyncLogs();

      // Live updates
      SeriesSync.on('status', (s) => {
        const el = $('syncLiveStatus'); if (el) el.textContent = s.message || '';
      });
      SeriesSync.on('log', () => this._renderSyncLogs());
      SeriesSync.on('syncAllDone', () => { this._renderSyncStats(); this._renderAutoSyncStatus(); this._renderImportedList(); });
      // Re-render when ANY tab updates persisted sync config/stats (cross-tab Last Run sync).
      try {
        window.addEventListener('storage', (e) => {
          if (!e || !e.key) return;
          if (e.key === 'mp_series_sync_config' || e.key === 'mp_series_sync_stats' || e.key === 'mp_series_sync_progress') {
            this._renderAutoSyncStatus();
            this._renderSyncStats();
          }
        });
        SeriesSync.on('configChanged', () => { this._renderAutoSyncStatus(); this._renderSyncStats(); });
      } catch (_) {}

      await this._renderImportedList();
    },

    _renderSyncStats() {
      const s = SeriesSync.getStats();
      const set = (id, v) => { const el = $(id); if (el) el.textContent = v; };
      set('ssChecked', s.seriesChecked || 0);
      set('ssNew',     s.newChaptersFound || 0);
      set('ssImp',     s.imported || 0);
      set('ssFail',    s.failed || 0);
      set('ssLastSuccess', s.lastSuccess ? new Date(s.lastSuccess).toLocaleString() : '—');
      set('ssLastFailure', s.lastFailure ? new Date(s.lastFailure).toLocaleString() : '—');
      this._renderSyncErrors(s.lastErrors || []);
    },
    _renderSyncErrors(errors) {
      // Render under the sync stats card. We mount lazily — if there is no
      // host element we create one right after #ssFail's grid container.
      let host = $('ssLastErrors');
      if (!host) {
        const anchor = $('ssFail') || $('ssChecked');
        const card = anchor && anchor.closest('.settings-section');
        if (!card) return;
        host = document.createElement('div');
        host.id = 'ssLastErrors';
        host.style.marginTop = '0.75rem';
        card.appendChild(host);
      }
      if (!errors.length) {
        host.innerHTML = '';
        return;
      }
      host.innerHTML =
        '<div style="font-weight:600;margin-bottom:0.4rem;color:var(--error,#ef4444);">' +
          `Last failures (${errors.length})` +
        '</div>' +
        '<div style="display:flex;flex-direction:column;gap:0.25rem;max-height:240px;overflow:auto;">' +
        errors.map(e =>
          `<div class="log-entry log-error" title="${escapeAttr(e.error || '')}">` +
            `<strong>${escapeHtml(e.title)}</strong> ` +
            `<span class="muted">[${escapeHtml(e.source || 'unknown')}]</span> — ` +
            `${escapeHtml(e.error || 'Unknown error')}` +
          `</div>`
        ).join('') +
        '</div>';
    },
    _renderSyncLogs() {
      const view = $('syncLogView'); if (!view) return;
      const logs = SeriesSync.getSyncLogs();
      view.innerHTML = logs.slice(0, 100).map(l =>
        `<div class="log-entry log-${l.level}">[${new Date(l.ts).toLocaleTimeString()}] [${l.level.toUpperCase()}] ${escapeHtml(l.message)}</div>`
      ).join('') || '<p class="muted">No sync logs yet.</p>';
      // Auto-open the <details> Sync Logs disclosure if the latest run had
      // any error/warn entries, so failures aren't hidden behind a click.
      const details = view.closest('details');
      if (details && !details._userToggled) {
        const recent = logs.slice(0, 20);
        const hasIssue = recent.some(l => l.level === 'error' || l.level === 'warn');
        if (hasIssue) details.open = true;
        if (!details._wired) {
          details.addEventListener('toggle', () => { details._userToggled = true; });
          details._wired = true;
        }
      }
    },

    async preview() {
      const url = $('seriesUrl').value.trim();
      if (!url) { alert('Paste a series URL first'); return; }
      $('detectedSource').textContent = 'Detecting…';
      try {
        const source = SeriesSourceRegistry.findSeriesSource(url);
        if (!source) {
          $('detectedSource').innerHTML =
            '<span style="color:var(--error,#ef4444)">No source plugin supports this URL.</span>';
          return;
        }
        $('detectedSource').textContent = 'Source: ' + source.name;

        const data = await SeriesImporter.preview(url);
        currentPreview = { url, source: source.name, ...data };

        this._fillEditForm(data.info);

        $('previewChapters').textContent =
          `${data.chapterCount} chapters found` +
          (data.firstChapter ? ` (first: ${data.firstChapter.number}, last: ${data.lastChapter.number})` : '');
        $('previewSourceMeta').textContent = `Source: ${source.name} · ${url}`;
        $('previewCard').classList.remove('hidden');
        $('previewValidation').style.display = 'none';

        // Live-update the cover/banner thumbnails when the URL field changes
        this._wireImagePreview('editCoverUrl', 'previewCover');
        this._wireImagePreview('editBannerUrl', 'previewBanner');
      } catch (e) {
        console.error(e);
        $('detectedSource').innerHTML =
          '<span style="color:var(--error,#ef4444)">' + escapeHtml(e.message || String(e)) + '</span>';
      }
    },

    _fillEditForm(info) {
      info = info || {};
      const desc = stripHtml(info.description || info.synopsis || '');
      $('editCoverUrl').value   = info.cover || info.coverImage || '';
      $('editBannerUrl').value  = info.banner || info.bannerImage || '';
      $('previewCover').src     = info.cover || info.coverImage || '';
      $('previewBanner').src    = info.banner || info.bannerImage || '';
      $('editTitle').value      = info.title || '';
      $('editAltTitles').value  = (info.alternativeTitles || []).join('\n');
      $('editAuthor').value     = info.author || '';
      $('editArtist').value     = info.artist || '';
      $('editStatus').value     = (info.status || 'ongoing').toLowerCase();
      $('editYear').value       = info.releaseYear || info.year || '';
      $('editGenres').value     = (info.genres || []).join(', ');
      $('editSynopsis').value   = desc;
    },

    _wireImagePreview(inputId, imgId) {
      const input = $(inputId);
      const img   = $(imgId);
      if (!input || !img || input._wired) return;
      input._wired = true;
      input.addEventListener('input', () => { img.src = input.value || ''; });
    },

    _collectEdited() {
      return {
        cover:        $('editCoverUrl').value.trim(),
        banner:       $('editBannerUrl').value.trim() || null,
        title:        $('editTitle').value.trim(),
        alternativeTitles: $('editAltTitles').value.split('\n').map(s => s.trim()).filter(Boolean),
        author:       $('editAuthor').value.trim(),
        artist:       $('editArtist').value.trim(),
        status:       $('editStatus').value || 'ongoing',
        releaseYear:  $('editYear').value ? Number($('editYear').value) : null,
        genres:       $('editGenres').value.split(',').map(s => s.trim()).filter(Boolean),
        description:  $('editSynopsis').value.trim(),
        synopsis:     $('editSynopsis').value.trim()
      };
    },

    _validate(info) {
      const errors = [];
      if (!info.title)        errors.push('Title is required.');
      if (!info.cover)        errors.push('Cover image URL is required.');
      if (!info.description)  errors.push('Synopsis is required.');
      if (!info.status)       errors.push('Status is required.');
      const box = $('previewValidation');
      if (errors.length) {
        box.innerHTML = '<strong>Please fix before publishing:</strong><ul>' +
          errors.map(e => `<li>${escapeHtml(e)}</li>`).join('') + '</ul>';
        box.style.display = '';
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return false;
      }
      box.style.display = 'none';
      return true;
    },

    saveDraft() {
      if (!currentPreview) { alert('Run Preview first'); return; }
      const draft = {
        url: currentPreview.url,
        source: currentPreview.source,
        info: this._collectEdited(),
        savedAt: Date.now()
      };
      try {
        localStorage.setItem('seriesImportDraft', JSON.stringify(draft));
        alert('Draft saved locally.');
      } catch (e) { alert('Could not save draft: ' + e.message); }
    },

    loadDraft() {
      let draft;
      try { draft = JSON.parse(localStorage.getItem('seriesImportDraft') || 'null'); }
      catch (e) { draft = null; }
      if (!draft) { alert('No saved draft.'); return; }
      $('seriesUrl').value = draft.url || '';
      currentPreview = currentPreview || { url: draft.url, source: draft.source, info: draft.info, chapterCount: 0 };
      currentPreview.url = draft.url;
      this._fillEditForm(draft.info || {});
      $('previewCard').classList.remove('hidden');
      $('previewSourceMeta').textContent =
        `Draft loaded (saved ${new Date(draft.savedAt).toLocaleString()})`;
      $('previewChapters').textContent = '';
      this._wireImagePreview('editCoverUrl', 'previewCover');
      this._wireImagePreview('editBannerUrl', 'previewBanner');
    },

    async refetchMeta() {
      if (!currentPreview) { alert('Nothing to refetch.'); return; }
      await this.preview();
    },

    async start() {
      if (!currentPreview) { alert('Run Preview first'); return; }
      const edited = this._collectEdited();
      if (!this._validate(edited)) return;

      const opts = {
        concurrency: Number($('optConcurrency').value) || 2,
        maxRetries:  Number($('optRetries').value)     || 3,
        rangeStart:  $('optRangeStart').value ? Number($('optRangeStart').value) : null,
        rangeEnd:    $('optRangeEnd').value   ? Number($('optRangeEnd').value)   : null,
        overwrite:   $('optOverwrite').checked,
        overrideInfo: edited
      };
      $('progressCard').classList.remove('hidden');
      $('logsCard').classList.remove('hidden');
      $('btnStart').disabled = true;
      $('progSeriesName').textContent = edited.title;
      try {
        await SeriesImporter.importSeries(currentPreview.url, opts);
        try { localStorage.removeItem('seriesImportDraft'); } catch (_) {}
      } finally {
        $('btnStart').disabled = false;
        await this._renderImportedList();
      }
    },

    pause()  { SeriesImporter.pause();  $('btnPause').style.display='none'; $('btnResume').style.display=''; },
    resume() { SeriesImporter.resume(); $('btnPause').style.display='';     $('btnResume').style.display='none'; },
    cancel() { if (confirm('Cancel running import?')) SeriesImporter.cancel(); },

    reset() {
      currentPreview = null;
      $('previewCard').classList.add('hidden');
      $('seriesUrl').value = '';
      $('detectedSource').textContent = '';
    },

    downloadLogs() {
      const blob = new Blob([JSON.stringify(SeriesImporter.getLogs(), null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'series-import-logs-' + Date.now() + '.json';
      a.click();
    },

    // ---------- Sync ----------
    async syncAll() {
      if (!confirm('Sync all series now? This checks every series with a sourceUrl for new chapters.')) return;
      $('progressCard').classList.remove('hidden');
      $('logsCard').classList.remove('hidden');
      $('progSeriesName').textContent = 'Sync all series';
      try {
        const results = await SeriesSync.syncAll();
        const total = results.reduce((acc, r) => acc + (r.imported || 0), 0);
        SeriesImporter._log('success', `Sync all complete: ${total} new chapters across ${results.length} series`);
      } catch (e) {
        alert('Sync failed: ' + e.message);
      }
      await this._renderImportedList();
    },

    toggleAutoSync(on) {
      if (on) {
        const min = Number($('autoSyncInterval').value) || 60;
        SeriesSync.startAutoSync(min);
      } else {
        SeriesSync.stopAutoSync();
      }
      this._renderAutoSyncStatus();
    },
    updateAutoSyncInterval(v) {
      const info = SeriesSync.getAutoSyncInfo();
      if (info.enabled) SeriesSync.startAutoSync(Number(v) || 60);
      this._renderAutoSyncStatus();
    },
    _renderAutoSyncStatus() {
      const info = SeriesSync.getAutoSyncInfo();
      $('autoSyncStatus').textContent = info.enabled
        ? `Auto-sync ON — every ${info.intervalMinutes} min${info.lastRun ? ' · last run ' + new Date(info.lastRun).toLocaleString() : ''}`
        : 'Auto-sync OFF';
    },

    // ---------- Imported series management ----------
    _importedItems: [],
    _importedSearch: '',
    _importedSort: 'updated',

    async _renderImportedList() {
      const wrap = $('importedList');
      wrap.innerHTML = '<p class="imported-empty">Loading…</p>';
      try {
        // Load all imported series (no 50-item cap so search covers the whole library).
        const snap = await firebase.firestore().collection('series')
          .orderBy('updatedAt', 'desc').get();
        this._importedItems = [];
        snap.forEach(d => this._importedItems.push({ id: d.id, ...d.data() }));
        this._wireImportedControls();
        this._renderImportedFiltered();
      } catch (e) {
        wrap.innerHTML = '<p class="imported-empty">Could not load: ' + escapeHtml(e.message) + '</p>';
      }
    },

    _wireImportedControls() {
      if (this._importedControlsWired) return;
      const search = $('importedSearch');
      const sort = $('importedSort');
      if (search) {
        search.addEventListener('input', () => {
          this._importedSearch = (search.value || '').trim().toLowerCase();
          this._renderImportedFiltered();
        });
      }
      if (sort) {
        sort.addEventListener('change', () => {
          this._importedSort = sort.value || 'updated';
          this._renderImportedFiltered();
        });
      }
      this._importedControlsWired = true;
    },

    _renderImportedFiltered() {
      const wrap = $('importedList');
      const countEl = $('importedCount');
      if (!wrap) return;

      const q = this._importedSearch;
      let items = this._importedItems.slice();

      if (q) {
        items = items.filter(s => {
          const title = String(s.title || '').toLowerCase();
          const src = String(
            (Array.isArray(s.sources) && s.sources.join(' ')) || s.source || ''
          ).toLowerCase();
          return title.includes(q) || src.includes(q);
        });
      }

      const sortMode = this._importedSort;
      items.sort((a, b) => {
        switch (sortMode) {
          case 'title':      return String(a.title||'').localeCompare(String(b.title||''));
          case 'title-desc': return String(b.title||'').localeCompare(String(a.title||''));
          case 'chapters':   return (b.totalChapters||0) - (a.totalChapters||0);
          case 'source': {
            const sa = (Array.isArray(a.sources)?a.sources[0]:a.source) || '';
            const sb = (Array.isArray(b.sources)?b.sources[0]:b.source) || '';
            return String(sa).localeCompare(String(sb));
          }
          case 'updated':
          default: {
            const ta = a.updatedAt && a.updatedAt.toMillis ? a.updatedAt.toMillis() : 0;
            const tb = b.updatedAt && b.updatedAt.toMillis ? b.updatedAt.toMillis() : 0;
            return tb - ta;
          }
        }
      });

      if (countEl) {
        countEl.textContent = items.length === this._importedItems.length
          ? `${items.length} series`
          : `${items.length} of ${this._importedItems.length} series`;
      }

      if (items.length === 0) {
        wrap.innerHTML = '<p class="imported-empty">' +
          (this._importedItems.length === 0 ? 'No series yet.' : 'No series match your search.') +
          '</p>';
        return;
      }

      // Build with DocumentFragment for better perf when there are many rows.
      const frag = document.createDocumentFragment();
      const tmp = document.createElement('div');
      tmp.innerHTML = items.map(s => {
        const urls = Array.isArray(s.sourceUrls) && s.sourceUrls.length
          ? s.sourceUrls
          : (s.sourceUrl ? [s.sourceUrl] : []);
        const hasUrl = urls.length > 0;
        const urlsAttr = escapeAttr(JSON.stringify(urls));
        const sourcesLabel = Array.isArray(s.sources) && s.sources.length
          ? s.sources.join(', ')
          : (s.source || '—');
        const countBadge = urls.length > 1
          ? ` · <span title="Multiple sources" style="color:var(--accent-primary,#6366f1);font-weight:600;">${urls.length} sources</span>`
          : '';
        const cover = s.cover || s.coverImage || '../images/placeholder.png';
        return `
        <div class="imported-row" data-id="${s.id}">
          <img src="${escapeAttr(cover)}" alt="" loading="lazy" onerror="this.src='../images/placeholder.png'">
          <div class="imported-info">
            <strong title="${escapeAttr(s.title || '')}">${escapeHtml(s.title || '(untitled)')}</strong>
            <div class="muted">
              ${escapeHtml(sourcesLabel)}${countBadge} ·
              ${s.totalChapters || 0} ch ·
              last #${s.lastImportedChapter || s.latestChapter || 0}
              ${hasUrl ? '' : ' · <span style="color:var(--error,#ef4444)">no source URL</span>'}
            </div>
          </div>
          <div class="imported-actions">
            <button class="btn btn-ghost btn-sm" onclick="ImportSeriesPage.setSourceUrl('${s.id}','${escapeAttr(s.title||'')}','${urlsAttr}')"><i class="fas fa-link"></i> ${hasUrl ? 'Edit URLs' : 'Set URLs'}</button>
            <button class="btn btn-ghost btn-sm" onclick="ImportSeriesPage.syncOne('${s.id}')" ${hasUrl ? '' : 'disabled'}><i class="fas fa-sync"></i> Sync</button>
            <button class="btn btn-ghost btn-sm" onclick="ImportSeriesPage.deleteOne('${s.id}','${escapeAttr(s.title||'')}')" title="Delete"><i class="fas fa-trash"></i></button>
          </div>
        </div>`;
      }).join('');
      while (tmp.firstChild) frag.appendChild(tmp.firstChild);
      wrap.innerHTML = '';
      wrap.appendChild(frag);
    },

    async syncOne(seriesId) {
      try {
        $('progressCard').classList.remove('hidden');
        $('logsCard').classList.remove('hidden');
        const r = await SeriesSync.syncSeries(seriesId);
        alert(`Sync complete: ${r.imported || 0} new, ${r.skipped || 0} skipped, ${r.failed || 0} failed.`);
        await this._renderImportedList();
      } catch (e) { alert('Sync failed: ' + e.message); }
    },
    async setSourceUrl(seriesId, title, current) {
      // `current` is now a JSON-encoded array string (or legacy single URL).
      // We open a small modal/textarea so admins can paste multiple URLs,
      // one per line, and sync will fetch new chapters from each source.
      let initial = [];
      try {
        if (current && current.charAt(0) === '[') initial = JSON.parse(current);
        else if (current) initial = [current];
      } catch (_) { initial = current ? [current] : []; }

      const urls = await this._promptMultiUrl(title, initial);
      if (urls == null) return; // cancelled
      const cleaned = urls.map(u => String(u || '').trim()).filter(Boolean);
      if (cleaned.length === 0) { alert('No URLs entered.'); return; }

      // Validate every URL has a matching plugin
      const matched = [];
      for (const u of cleaned) {
        const src = SeriesSourceRegistry.findSeriesSource(u);
        if (!src) {
          alert('No source plugin supports:\n' + u + '\n\nSupported: ' +
            SeriesSourceRegistry.listSeriesSources().map(s => s.domain).join(', '));
          return;
        }
        matched.push({ url: u, source: src.name });
      }
      try {
        // Keep `sourceUrl` (legacy/primary) + new `sourceUrls` array.
        await DB.updateSeries(seriesId, {
          sourceUrl: matched[0].url,
          source:    matched[0].source,
          sourceUrls: matched.map(m => m.url),
          sources:    matched.map(m => m.source)
        });
        alert('Saved ' + matched.length + ' source URL(s). You can now Sync this series.');
        await this._renderImportedList();
      } catch (e) { alert('Failed to save: ' + e.message); }
    },

    /**
     * Inline multi-URL editor. Resolves to an array of URLs (one per line),
     * or null if the admin cancels. Built without a framework so it works
     * on every admin page that already loads this controller.
     */
    _promptMultiUrl(title, initial) {
      return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:1rem;';
        const initText = (initial || []).join('\n');
        overlay.innerHTML = `
          <div style="background:var(--bg-card,#141414);color:var(--text-primary,#fff);border:1px solid var(--border-color,#2a2a2a);border-radius:14px;padding:1.5rem;max-width:560px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,0.5);">
            <h3 style="margin:0 0 0.5rem;font-size:1.15rem;font-weight:700;">Source URLs for "${escapeHtml(title)}"</h3>
            <p class="muted" style="margin:0 0 0.75rem;font-size:0.85rem;">
              Paste one URL per line. Sync will check every URL and import new chapters from each.
            </p>
            <textarea id="__multiUrlInput" class="form-input" rows="6" style="width:100%;font-family:monospace;font-size:0.85rem;" placeholder="https://asurascans.com/comics/example-slug&#10;https://vortexscans.org/series/example-slug">${escapeHtml(initText)}</textarea>
            <div style="display:flex;gap:0.5rem;justify-content:flex-end;margin-top:1rem;flex-wrap:wrap;">
              <button type="button" class="btn btn-ghost" id="__multiUrlCancel">Cancel</button>
              <button type="button" class="btn btn-primary" id="__multiUrlSave"><i class="fas fa-save"></i> Save</button>
            </div>
          </div>`;
        document.body.appendChild(overlay);
        const cleanup = (val) => { document.body.removeChild(overlay); resolve(val); };
        overlay.querySelector('#__multiUrlCancel').addEventListener('click', () => cleanup(null));
        overlay.querySelector('#__multiUrlSave').addEventListener('click', () => {
          const txt = overlay.querySelector('#__multiUrlInput').value || '';
          cleanup(txt.split(/\r?\n/));
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) cleanup(null); });
        setTimeout(() => overlay.querySelector('#__multiUrlInput').focus(), 50);
      });
    },
    async deleteOne(id, title) {
      if (!confirm(`Delete series "${title}" and ALL its chapters? This cannot be undone.`)) return;
      try { await DB.deleteSeries(id); await this._renderImportedList(); }
      catch (e) { alert('Delete failed: ' + e.message); }
    },

    // ---------- Renderers ----------
    _renderProgress(p) {
      if (!p) return;
      $('progPhase').textContent = p.message || '';
      const pct = p.total ? Math.round((p.current / p.total) * 100) : 0;
      $('progFill').style.width = pct + '%';
      $('progCount').textContent = `${p.current || 0} / ${p.total || 0}`;
      // Stats come from logs counting — compute live:
      const counts = countByLevel(SeriesImporter.logs);
      $('stImported').textContent  = counts.success;
      $('stSkipped').textContent   = counts.skip;
      $('stFailed').textContent    = counts.error;
      $('stRemaining').textContent = Math.max(0, (p.total || 0) - (p.current || 0));
    },
    _renderState(state) {
      if (state === SeriesImporter.STATES.PAUSED) {
        $('btnPause').style.display='none'; $('btnResume').style.display='';
      } else if (state === SeriesImporter.STATES.RUNNING) {
        $('btnPause').style.display='';     $('btnResume').style.display='none';
      }
    },
    _renderLog(entry) {
      if (entry === null) { $('logView').innerHTML = ''; return; }
      if (!logFilters[entry.level]) return;
      const el = document.createElement('div');
      el.className = 'log-entry log-' + entry.level;
      el.textContent = `[${entry.level.toUpperCase()}] ${entry.message}`;
      $('logView').appendChild(el);
      $('logView').scrollTop = $('logView').scrollHeight;
    },
    _rerenderLogs() {
      $('logView').innerHTML = '';
      SeriesImporter.getLogs().forEach(e => this._renderLog(e));
    },
    _onComplete(result) {
      $('progPhase').textContent = result.cancelled
        ? 'Cancelled.'
        : `Done — imported ${result.imported}, skipped ${result.skipped}, failed ${result.failed}.`;
    }
  };

  function countByLevel(logs) {
    const c = { success: 0, skip: 0, warn: 0, error: 0, info: 0 };
    for (const l of logs) if (c[l.level] !== undefined) c[l.level]++;
    return c;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/`/g,'&#96;'); }
  function stripHtml(s) {
    if (!s) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = String(s);
    return (tmp.textContent || tmp.innerText || '').replace(/\s+\n/g, '\n').trim();
  }

  global.ImportSeriesPage = ImportSeriesPage;
  document.addEventListener('DOMContentLoaded', () => ImportSeriesPage.init());
})(window);
