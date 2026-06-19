/**
 * ============================================================
 * BULK IMPORT - Multiple Series at Once
 * ============================================================
 * Lets admins paste many series URLs, preview them in parallel,
 * edit metadata per series, choose which to publish, and run the
 * imports sequentially with per-series progress + error reporting.
 *
 * Depends on: SeriesSourceRegistry, SeriesImporter, DB.
 * ============================================================
 */
(function (global) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const items = []; // { id, url, source, info, chapterCount, status, error, include, importResult }
  let uid = 0;
  const newId = () => 'bi_' + (++uid);

  const STATUS = {
    PENDING:    'pending',
    PREVIEWING: 'previewing',
    READY:      'ready',
    ERROR:      'error',
    IMPORTING:  'importing',
    DONE:       'done',
    SKIPPED:    'skipped',
    FAILED:     'failed'
  };

  // ---- Persistence (Issues #2 & #3 partial) ----
  // Saves the queue (URLs, preview metadata, statuses) so that leaving the
  // page, refreshing, or closing the browser does not lose pending imports.
  const STORAGE_KEY = 'bulkImportQueue.v1';
  let saveTimer = null;
  function persist() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        // Strip transient flags; keep enough state to restore the UI.
        const serialised = items.map(it => ({
          id: it.id, url: it.url, source: it.source, info: it.info,
          chapterCount: it.chapterCount, status: it.status, error: it.error,
          include: it.include, importResult: it.importResult,
          failedChapters: it.failedChapters || null,
          _progressPct: it._progressPct || 0,
          savedAt: Date.now()
        }));
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: serialised, uid }));
      } catch (e) { /* quota / private mode — ignore */ }
    }, 150);
  }
  function restore() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      if (!data || !Array.isArray(data.items) || data.items.length === 0) return false;
      // Any item that was mid-import when the page closed is rolled back to
      // READY so it can be resumed by the user (or auto-resumed below).
      data.items.forEach(it => {
        if (it.status === STATUS.IMPORTING || it.status === STATUS.PREVIEWING) {
          it.status = it.info ? STATUS.READY : STATUS.PENDING;
          it._progressPct = 0;
          it.importResult = (it.importResult || '') + (it.importResult ? '\n' : '') +
            '[Resumed after interruption]';
        }
        items.push(it);
      });
      uid = Math.max(uid, Number(data.uid) || 0);
      return true;
    } catch (_) { return false; }
  }

  const BulkImport = {
    init() {
      if (!$('bulkUrlList')) return;
      const restored = restore();
      if (!restored) {
        // Start with 5 rows per spec ("at least 5 series simultaneously").
        for (let i = 0; i < 5; i++) this.addRow('', false);
      }
      this._renderRows();
      if (restored) {
        // Show preview cards for any items that have info loaded
        const hasPreviews = items.some(it => it.info || it.status === STATUS.ERROR);
        if (hasPreviews) {
          $('bulkPreviewWrap').style.display = '';
          this._renderPreviews();
          this._updateSummary('Restored ' + items.filter(i => (i.url||'').trim()).length + ' queued series from previous session.');
        }
        // Auto-resume any imports that were interrupted (still selected & ready).
        const resumable = items.filter(it => it.status === STATUS.READY && it.include && it.info);
        if (resumable.length > 0) {
          // Defer slightly so the UI can paint first.
          setTimeout(() => {
            try { this.publishSelected(true /* skipConfirm */); } catch (_) {}
          }, 600);
        }
      }
    },

    toggleHelp() {
      const h = $('bulkHelp');
      h.style.display = h.style.display === 'none' ? '' : 'none';
    },

    addRow(value = '', render = true) {
      items.push({
        id: newId(), url: value || '', source: null, info: null,
        chapterCount: 0, status: STATUS.PENDING, error: null,
        include: true, importResult: null
      });
      if (render) this._renderRows();
      persist();
    },

    removeRow(id) {
      const idx = items.findIndex(i => i.id === id);
      if (idx >= 0) items.splice(idx, 1);
      this._renderRows();
      this._renderPreviews();
      this._updateSummary();
      persist();
    },

    clearRows() {
      if (!confirm('Clear all URLs and previews? This also clears the saved queue.')) return;
      items.length = 0;
      for (let i = 0; i < 5; i++) this.addRow('', false);
      this._renderRows();
      $('bulkPreviewWrap').style.display = 'none';
      $('bulkPreviewList').innerHTML = '';
      try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
      persist();
    },


    _renderRows() {
      const wrap = $('bulkUrlList');
      wrap.innerHTML = items.map((it, i) => `
        <div class="bulk-url-row" data-id="${it.id}"
             style="display:flex;gap:0.5rem;align-items:center;">
          <span style="min-width:1.75rem;color:var(--text-muted);font-variant-numeric:tabular-nums;">${i + 1}.</span>
          <input type="url" class="form-input bulk-url-input"
                 data-id="${it.id}"
                 value="${escapeAttr(it.url)}"
                 placeholder="https://asurascans.com/series/...  or  https://vortexscans.org/series/..."
                 style="flex:1;">
          <button class="btn btn-ghost btn-sm" type="button"
                  onclick="BulkImport.removeRow('${it.id}')" title="Remove row">
            <i class="fas fa-times"></i>
          </button>
        </div>
      `).join('');
      // Wire input events
      wrap.querySelectorAll('.bulk-url-input').forEach(inp => {
        inp.addEventListener('input', (e) => {
          const it = items.find(x => x.id === inp.dataset.id);
          if (it) { it.url = e.target.value; persist(); }
        });
      });
    },

    selectAll(on) {
      items.forEach(it => { if (it.status === STATUS.READY) it.include = !!on; });
      this._renderPreviews();
      this._updateSummary();
      persist();
    },

    async previewAll() {
      // Collect non-empty URLs
      const urlItems = items.filter(it => (it.url || '').trim());
      if (urlItems.length === 0) { alert('Add at least one URL first.'); return; }

      $('bulkPreviewWrap').style.display = '';
      $('bulkPreviewList').innerHTML = '';

      // Mark all as previewing
      urlItems.forEach(it => {
        it.status = STATUS.PREVIEWING; it.error = null;
        const src = SeriesSourceRegistry.findSeriesSource(it.url.trim());
        it.source = src ? src.name : null;
      });
      this._renderPreviews();
      this._updateSummary('Previewing ' + urlItems.length + ' series...');

      // Bounded parallelism so we don't hammer source sites.
      const CONCURRENCY = 3;
      let cursor = 0;
      const worker = async () => {
        while (cursor < urlItems.length) {
          const it = urlItems[cursor++];
          await this._previewOne(it);
          this._renderPreviews();
          this._updateSummary();
        }
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urlItems.length) }, worker));
      this._updateSummary();
    },

    async _previewOne(it) {
      try {
        const url = it.url.trim();
        const src = SeriesSourceRegistry.findSeriesSource(url);
        if (!src) {
          it.status = STATUS.ERROR;
          it.error = 'No source plugin supports this URL.';
          return;
        }
        it.source = src.name;
        const data = await SeriesImporter.preview(url);
        const info = data.info || {};
        it.info = {
          cover:        info.cover || info.coverImage || '',
          banner:       info.banner || info.bannerImage || '',
          title:        info.title || '',
          alternativeTitles: info.alternativeTitles || [],
          author:       info.author || '',
          artist:       info.artist || '',
          status:       (info.status || 'ongoing').toLowerCase(),
          releaseYear:  info.releaseYear || info.year || null,
          genres:       info.genres || [],
          description:  stripHtml(info.description || info.synopsis || ''),
          synopsis:     stripHtml(info.description || info.synopsis || '')
        };
        it.chapterCount = data.chapterCount || 0;
        it.status = STATUS.READY;
      } catch (e) {
        console.error('Preview failed:', it.url, e);
        it.status = STATUS.ERROR;
        it.error = e.message || String(e);
      }
      persist();
    },

    _renderPreviews() {
      const wrap = $('bulkPreviewList');
      const urlItems = items.filter(it => (it.url || '').trim());
      wrap.innerHTML = urlItems.map(it => this._renderCard(it)).join('');
      // Wire input syncing per card
      wrap.querySelectorAll('[data-bi-field]').forEach(el => {
        el.addEventListener('input', () => {
          const it = items.find(x => x.id === el.dataset.biId);
          if (!it || !it.info) return;
          const f = el.dataset.biField;
          if (f === 'genres') {
            it.info.genres = el.value.split(',').map(s => s.trim()).filter(Boolean);
          } else if (f === 'alternativeTitles') {
            it.info.alternativeTitles = el.value.split(',').map(s => s.trim()).filter(Boolean);
          } else if (f === 'releaseYear') {
            it.info.releaseYear = el.value ? Number(el.value) : null;
          } else {
            it.info[f] = el.value;
          }
          if (f === 'description') it.info.synopsis = el.value;
          if (f === 'cover' || f === 'banner') {
            const img = document.querySelector(`img[data-bi-img="${it.id}-${f}"]`);
            if (img) img.src = el.value || '';
          }
          persist();
        });
      });
      wrap.querySelectorAll('input[type="checkbox"][data-bi-include]').forEach(cb => {
        cb.addEventListener('change', () => {
          const it = items.find(x => x.id === cb.dataset.biInclude);
          if (it) it.include = cb.checked;
          this._updateSummary();
          persist();
        });
      });
    },

    _renderCard(it) {
      const statusBadge = ({
        [STATUS.PREVIEWING]: '<span style="color:var(--accent-primary);">Previewing...</span>',
        [STATUS.READY]:      '<span style="color:#10b981;">Ready</span>',
        [STATUS.ERROR]:      `<span style="color:#ef4444;">Error</span>`,
        [STATUS.IMPORTING]:  '<span style="color:var(--accent-primary);">Importing...</span>',
        [STATUS.DONE]:       '<span style="color:#10b981;">Imported ✓</span>',
        [STATUS.SKIPPED]:    '<span style="color:var(--text-muted);">Skipped</span>',
        [STATUS.FAILED]:     '<span style="color:#ef4444;">Failed</span>'
      })[it.status] || '<span class="muted">Pending</span>';

      if (it.status === STATUS.ERROR || !it.info) {
        return `
          <div class="bulk-card" data-id="${it.id}"
               style="border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:1rem;background:var(--bg-card,#111);">
            <div style="display:flex;justify-content:space-between;gap:1rem;flex-wrap:wrap;">
              <div style="min-width:0;">
                <div class="muted" style="font-size:0.8rem;word-break:break-all;">${escapeHtml(it.url)}</div>
                <div style="margin-top:0.25rem;">${statusBadge}</div>
                ${it.error ? `<div style="color:#ef4444;font-size:0.85rem;margin-top:0.25rem;">${escapeHtml(it.error)}</div>` : ''}
                ${it.importResult ? `<div class="muted" style="font-size:0.85rem;margin-top:0.25rem;white-space:pre-wrap;">${escapeHtml(it.importResult)}</div>` : ''}
              </div>
              <button class="btn btn-ghost btn-sm" type="button" onclick="BulkImport.removeRow('${it.id}')">
                <i class="fas fa-times"></i> Remove
              </button>
            </div>
            ${it.status === STATUS.PREVIEWING ? '<div class="spinner spinner-sm" style="margin-top:0.5rem;"></div>' : ''}
          </div>`;
      }

      const info = it.info;
      const pct = it._progressPct || 0;
      // Shared style strings so every field is full-width, legible in both
      // light and dark mode, and never overflows its container on mobile.
      const inputStyle = 'width:100%;max-width:100%;box-sizing:border-box;background:var(--bg-tertiary,#0d0d0d);color:var(--text-primary,#fff);border:1px solid var(--border-color,#2a2a2a);padding:0.5rem 0.65rem;border-radius:6px;font-size:0.9rem;';
      const textareaStyle = inputStyle + 'min-height:90px;resize:vertical;line-height:1.4;';
      return `
        <div class="bulk-card" data-id="${it.id}"
             style="border:1px solid var(--border-color,#2a2a2a);border-radius:8px;padding:1rem;background:var(--bg-card,#111);color:var(--text-primary,#fff);">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.75rem;">
            <label style="display:flex;align-items:center;gap:0.5rem;font-weight:600;">
              <input type="checkbox" data-bi-include="${it.id}" ${it.include ? 'checked' : ''}
                ${it.status === STATUS.DONE || it.status === STATUS.IMPORTING ? 'disabled' : ''}>
              Include in batch
            </label>
            <div style="display:flex;align-items:center;gap:0.5rem;">
              ${statusBadge}
              <button class="btn btn-ghost btn-sm" type="button" onclick="BulkImport.removeRow('${it.id}')" title="Remove">
                <i class="fas fa-times"></i>
              </button>
            </div>
          </div>

          <div class="bulk-card-grid" style="display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-start;">
            <div style="flex:0 0 110px;display:flex;justify-content:center;width:100%;max-width:110px;">
              <img data-bi-img="${it.id}-cover" src="${escapeAttr(info.cover)}" alt=""
                   style="width:110px;height:150px;object-fit:cover;border-radius:6px;background:#0a0a0a;display:block;">
            </div>
            <div style="flex:1 1 240px;min-width:0;display:flex;flex-direction:column;gap:0.5rem;">
              <input class="form-input" data-bi-id="${it.id}" data-bi-field="title"
                     value="${escapeAttr(info.title)}" placeholder="Title *"
                     style="${inputStyle}font-weight:600;">
              <input class="form-input" data-bi-id="${it.id}" data-bi-field="alternativeTitles"
                     value="${escapeAttr((info.alternativeTitles || []).join(', '))}"
                     placeholder="Alternative titles (comma-separated)"
                     style="${inputStyle}">
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.5rem;">
                <input class="form-input" data-bi-id="${it.id}" data-bi-field="author"
                       value="${escapeAttr(info.author)}" placeholder="Author"
                       style="${inputStyle}">
                <input class="form-input" data-bi-id="${it.id}" data-bi-field="artist"
                       value="${escapeAttr(info.artist)}" placeholder="Artist"
                       style="${inputStyle}">
              </div>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0.5rem;">
                <select class="form-input" data-bi-id="${it.id}" data-bi-field="status"
                        style="${inputStyle}">
                  ${['ongoing','completed','hiatus','dropped'].map(s =>
                    `<option value="${s}" ${info.status===s?'selected':''}>${s[0].toUpperCase()+s.slice(1)}</option>`).join('')}
                </select>
                <input type="number" class="form-input" data-bi-id="${it.id}" data-bi-field="releaseYear"
                       value="${info.releaseYear || ''}" placeholder="Year" min="1900" max="2100"
                       style="${inputStyle}">
              </div>
              <input class="form-input" data-bi-id="${it.id}" data-bi-field="genres"
                     value="${escapeAttr((info.genres || []).join(', '))}"
                     placeholder="Genres (comma-separated)"
                     style="${inputStyle}">
              <input class="form-input" data-bi-id="${it.id}" data-bi-field="cover"
                     value="${escapeAttr(info.cover)}" placeholder="Cover URL *"
                     style="${inputStyle}">
              <input class="form-input" data-bi-id="${it.id}" data-bi-field="banner"
                     value="${escapeAttr(info.banner || '')}" placeholder="Banner URL (optional)"
                     style="${inputStyle}">
              <textarea class="form-input" data-bi-id="${it.id}" data-bi-field="description"
                        rows="4" placeholder="Synopsis *"
                        style="${textareaStyle}">${escapeHtml(info.description)}</textarea>
              <div style="font-size:0.8rem;color:var(--text-secondary,#cfcfcf);">
                Source: <strong style="color:var(--text-primary,#fff);">${escapeHtml(it.source || '—')}</strong>
                &middot; <span style="color:var(--text-primary,#fff);">${it.chapterCount}</span> chapters
              </div>
            </div>
          </div>

          ${it.status === STATUS.IMPORTING || it.status === STATUS.DONE || it.status === STATUS.FAILED ? `
            <div class="progress-bar" style="margin-top:0.75rem;height:6px;background:var(--bg-tertiary,#0d0d0d);border-radius:3px;overflow:hidden;">
              <div style="height:100%;width:${pct}%;background:var(--accent-primary,#6366f1);transition:width 0.2s;"></div>
            </div>
            <div class="muted" style="font-size:0.8rem;margin-top:0.25rem;white-space:pre-wrap;">${escapeHtml(it.importResult || '')}</div>
          ` : ''}
        </div>`;
    },

    _updateSummary(override) {
      const total = items.filter(it => (it.url||'').trim()).length;
      const ready = items.filter(it => it.status === STATUS.READY).length;
      const errs  = items.filter(it => it.status === STATUS.ERROR).length;
      const selected = items.filter(it => it.status === STATUS.READY && it.include).length;
      $('bulkPreviewSummary').textContent = override ||
        `${total} URL(s) · ${ready} ready · ${errs} error(s) · ${selected} selected for publishing`;
    },

    _validate(info) {
      if (!info.title)       return 'Title is required';
      if (!info.cover)       return 'Cover image URL is required';
      if (!info.description) return 'Synopsis is required';
      if (!info.status)      return 'Status is required';
      return null;
    },

    async publishSelected(skipConfirm) {
      const queue = items.filter(it => it.status === STATUS.READY && it.include && it.info);
      if (queue.length === 0) {
        if (!skipConfirm) alert('No series selected for publishing.');
        return;
      }
      // Validate everything up front
      for (const it of queue) {
        const err = this._validate(it.info);
        if (err) {
          if (skipConfirm) {
            it.status = STATUS.FAILED;
            it.importResult = 'Validation failed: ' + err;
            continue;
          }
          alert(`"${it.info.title || it.url}": ${err}`); return;
        }
      }
      if (!skipConfirm && !confirm(`Publish & import ${queue.length} series? They will be processed one at a time.`)) return;

      // Persist whole-batch start
      persist();

      // Process sequentially so SeriesImporter (singleton) stays consistent.
      for (const it of queue) {
        if (it.status !== STATUS.READY) continue;
        it.status = STATUS.IMPORTING;
        it._progressPct = 0;
        it.importResult = 'Starting...';
        this._renderPreviews();
        this._updateSummary();
        persist();

        // Hook progress for THIS series — also persist throttled
        const onProgress = (p) => {
          if (!p || !p.total) return;
          it._progressPct = Math.round((p.current / p.total) * 100);
          it.importResult = `${p.current}/${p.total} — ${p.message || ''}`;
          // Light DOM update — only progress text/bar
          const card = document.querySelector(`.bulk-card[data-id="${it.id}"]`);
          if (card) {
            const bar = card.querySelector('.progress-bar > div');
            if (bar) bar.style.width = it._progressPct + '%';
            const lbl = card.querySelector('.progress-bar + .muted');
            if (lbl) lbl.textContent = it.importResult;
          }
          persist();
        };
        SeriesImporter.on('progress', onProgress);

        try {
          const res = await SeriesImporter.importSeries(it.url, {
            concurrency: 2,
            maxRetries:  3,
            overwrite:   false,
            overrideInfo: it.info
          });
          it.status = STATUS.DONE;
          it._progressPct = 100;
          const failedList = Array.isArray(res.failedChapters) ? res.failedChapters : [];
          let summary = `Imported ${res.imported || 0}, skipped ${res.skipped || 0}, failed ${res.failed || 0}.`;
          if (failedList.length) {
            const preview = failedList.slice(0, 8).map(f =>
              `• ${f.title || ('Chapter ' + f.number)} — ${f.error || 'unknown error'}`
            ).join('\n');
            const more = failedList.length > 8 ? `\n…and ${failedList.length - 8} more` : '';
            summary += `\nFailed chapters:\n${preview}${more}`;
            it.status = STATUS.FAILED; // mark visibly so user notices
          }
          it.importResult = summary;
          it.failedChapters = failedList;
        } catch (e) {
          it.status = STATUS.FAILED;
          it.importResult = 'Failed: ' + (e.message || String(e));
        } finally {
          try { SeriesImporter.off && SeriesImporter.off('progress', onProgress); } catch (_) {}
        }
        this._renderPreviews();
        this._updateSummary();
        persist();
      }

      const done   = items.filter(it => it.status === STATUS.DONE).length;
      const failed = items.filter(it => it.status === STATUS.FAILED).length;
      if (!skipConfirm) alert(`Batch finished: ${done} imported, ${failed} failed.`);
      if (typeof ImportSeriesPage?._renderImportedList === 'function') {
        try { await ImportSeriesPage._renderImportedList(); } catch (_) {}
      }
    }
  };


  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g,
      m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
  }
  function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
  function stripHtml(s) {
    if (!s) return '';
    const tmp = document.createElement('div');
    tmp.innerHTML = String(s);
    return (tmp.textContent || tmp.innerText || '').replace(/\s+\n/g, '\n').trim();
  }

  global.BulkImport = BulkImport;
  document.addEventListener('DOMContentLoaded', () => BulkImport.init());

  // Warn if user tries to navigate away while a series is mid-import — the
  // queue itself is persisted (and will resume on return), but in-flight
  // chapter requests cannot continue without a live page.
  window.addEventListener('beforeunload', (e) => {
    const importing = items.some(it => it.status === STATUS.IMPORTING);
    if (importing) {
      e.preventDefault();
      e.returnValue = 'An import is in progress. Pending items are saved and will resume when you return, but the active import will be interrupted.';
      return e.returnValue;
    }
  });
})(window);
