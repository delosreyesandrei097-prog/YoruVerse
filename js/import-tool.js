/**
 * ============================================================
 * MANHWA PLATFORM - CHAPTER IMPORT TOOL
 * ============================================================
 * Admin tool for importing chapters by pasting URLs.
 * Uses source plugins to extract chapter data.
 * 
 * FEATURES:
 * - Single chapter URL import with auto-extraction
 * - Bulk import: paste multiple URLs at once
 * - Manual import: add chapter data without extraction
 * - Import progress tracking and error reporting
 * ============================================================
 */

const ImportTool = {
  currentExtractedData: null,
  currentSeriesId: null,
  
  // Bulk import state
  bulkImportQueue: [],
  bulkImportProgress: { total: 0, completed: 0, failed: 0, current: 0 },
  bulkImportRunning: false,

  /**
   * Initialize import tool
   */
  init(seriesId = null) {
    this.currentSeriesId = seriesId;
    this.bindEvents();
  },

  /**
   * Bind DOM events
   */
  bindEvents() {
    // Import button
    const importBtn = document.getElementById('importBtn');
    const urlInput = document.getElementById('importUrl');
    const confirmBtn = document.getElementById('confirmImportBtn');
    const cancelBtn = document.getElementById('cancelImportBtn');
    const bulkImportBtn = document.getElementById('bulkImportBtn');
    const bulkUrlsInput = document.getElementById('bulkUrls');

    if (importBtn) {
      importBtn.addEventListener('click', () => this.handleImport());
    }

    if (urlInput) {
      urlInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
          this.handleImport();
        }
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener('click', () => this.confirmImport());
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => this.resetImport());
    }

    if (bulkImportBtn) {
      bulkImportBtn.addEventListener('click', () => this.handleBulkImport());
    }

    // Series selector for import
    const seriesSelect = document.getElementById('importSeriesSelect');
    if (seriesSelect && !this.currentSeriesId) {
      this.loadSeriesOptions(seriesSelect);
    }
  },

  /**
   * Load series into select dropdown
   */
  async loadSeriesOptions(select) {
    try {
      select.innerHTML = '<option value="">Loading series...</option>';
      select.disabled = true;

      const result = await DB.getSeries({ limit: 100, sortBy: 'title', sortOrder: 'asc' });
      
      select.innerHTML = '<option value="">Select a series...</option>' +
        result.series.map(s => `<option value="${s.id}">${s.title}</option>`).join('');
      
      select.disabled = false;
    } catch (error) {
      console.error('Error loading series:', error);
      select.innerHTML = '<option value="">Error loading series</option>';
    }
  },

  /**
   * Handle single import button click
   */
  async handleImport() {
    const urlInput = document.getElementById('importUrl');
    const seriesSelect = document.getElementById('importSeriesSelect');
    const loadingEl = document.getElementById('importLoading');
    const previewEl = document.getElementById('importPreview');
    
    const url = urlInput?.value?.trim();
    const seriesId = this.currentSeriesId || seriesSelect?.value;

    if (!url) {
      showToast('Please enter a chapter URL', 'warning');
      return;
    }

    if (!seriesId) {
      showToast('Please select a series', 'warning');
      return;
    }

    // Show loading
    if (loadingEl) loadingEl.classList.remove('hidden');
    if (previewEl) previewEl.classList.add('hidden');

    try {
      // Check if URL is supported
      if (!SourceRegistry.canHandle(url)) {
        showToast('No specific plugin found. Attempting generic extraction...', 'info');
      }

      // Extract chapter data
      const extractedData = await SourceRegistry.extract(url);
      
      // Store extracted data
      this.currentExtractedData = {
        ...extractedData,
        seriesId: seriesId
      };

      // Show preview
      this.showPreview(this.currentExtractedData);

    } catch (error) {
      console.error('Import error:', error);
      showToast(error.message || 'Failed to extract chapter data', 'error');
      
      if (loadingEl) loadingEl.classList.add('hidden');
    }
  },

  /**
   * Show extraction preview
   */
  showPreview(data) {
    const loadingEl = document.getElementById('importLoading');
    const previewEl = document.getElementById('importPreview');
    const previewTitle = document.getElementById('previewTitle');
    const previewChapter = document.getElementById('previewChapter');
    const previewImageCount = document.getElementById('previewImageCount');
    const previewImages = document.getElementById('previewImages');

    if (loadingEl) loadingEl.classList.add('hidden');
    if (previewEl) previewEl.classList.remove('hidden');

    // Update preview info
    if (previewTitle) previewTitle.textContent = data.seriesTitle || 'Unknown Series';
    if (previewChapter) previewChapter.textContent = `Chapter ${data.chapterNumber}${data.chapterTitle && data.chapterTitle !== `Chapter ${data.chapterNumber}` ? ': ' + data.chapterTitle : ''}`;
    if (previewImageCount) previewImageCount.textContent = `${data.imageUrls.length} pages found`;

    // Show image thumbnails
    if (previewImages) {
      previewImages.innerHTML = data.imageUrls.slice(0, 12).map((imgUrl, index) => `
        <div class="import-preview-image">
          <img src="${imgUrl}" 
               alt="Page ${index + 1}" 
               loading="lazy"
               onerror="this.parentElement.style.display='none'">
        </div>
      `).join('');

      if (data.imageUrls.length > 12) {
        previewImages.innerHTML += `
          <div class="import-preview-image" style="display:flex;align-items:center;justify-content:center;background:var(--bg-hover);">
            <span style="color:var(--text-muted);font-size:0.875rem;">+${data.imageUrls.length - 12} more</span>
          </div>
        `;
      }
    }
  },

  /**
   * Confirm and save import
   */
  async confirmImport() {
    if (!this.currentExtractedData) {
      showToast('No data to import', 'warning');
      return;
    }

    const confirmBtn = document.getElementById('confirmImportBtn');
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.innerHTML = '<div class="spinner spinner-sm" style="border-color:white;"></div> Saving...';
    }

    try {
      // Check if chapter already exists
      const existingChapter = await DB.getChapterByNumber(
        this.currentExtractedData.seriesId,
        this.currentExtractedData.chapterNumber
      );

      if (existingChapter) {
        // Update existing chapter
        await DB.updateChapter(existingChapter.id, {
          chapterTitle: this.currentExtractedData.chapterTitle,
          imageUrls: this.currentExtractedData.imageUrls,
          thumbnail: this.currentExtractedData.thumbnail || this.currentExtractedData.imageUrls[0] || null,
          sourceUrl: this.currentExtractedData.sourceUrl,
          source: this.currentExtractedData.source
        });
        showToast('Chapter updated successfully!', 'success');
      } else {
        // Add new chapter
        await DB.addChapter({
          seriesId: this.currentExtractedData.seriesId,
          chapterNumber: this.currentExtractedData.chapterNumber,
          chapterTitle: this.currentExtractedData.chapterTitle,
          chapterUrl: this.currentExtractedData.sourceUrl,
          imageUrls: this.currentExtractedData.imageUrls,
          thumbnail: this.currentExtractedData.thumbnail || this.currentExtractedData.imageUrls[0] || null,
          source: this.currentExtractedData.source,
          releaseDate: new Date().toISOString()
        });
        showToast('Chapter imported successfully!', 'success');
      }

      this.resetImport();
      
      // Refresh chapter list if on series page
      if (window.loadChapters) {
        window.loadChapters();
      }

    } catch (error) {
      console.error('Error saving chapter:', error);
      showToast('Failed to save chapter: ' + error.message, 'error');
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.innerHTML = '<i class="fas fa-check"></i> Confirm Import';
      }
    }
  },

  /**
   * Reset import form
   */
  resetImport() {
    this.currentExtractedData = null;
    
    const urlInput = document.getElementById('importUrl');
    const previewEl = document.getElementById('importPreview');
    const loadingEl = document.getElementById('importLoading');
    
    if (urlInput) urlInput.value = '';
    if (previewEl) previewEl.classList.add('hidden');
    if (loadingEl) loadingEl.classList.add('hidden');
  },

  /**
   * Manual import (bypass source plugin)
   */
  async manualImport(seriesId, chapterNumber, chapterTitle, imageUrls) {
    try {
      const existingChapter = await DB.getChapterByNumber(seriesId, chapterNumber);

      if (existingChapter) {
        await DB.updateChapter(existingChapter.id, {
          chapterTitle,
          imageUrls,
          thumbnail: imageUrls[0] || null
        });
        showToast('Chapter updated!', 'success');
      } else {
        await DB.addChapter({
          seriesId,
          chapterNumber,
          chapterTitle,
          imageUrls,
          thumbnail: imageUrls[0] || null,
          releaseDate: new Date().toISOString()
        });
        showToast('Chapter imported!', 'success');
      }

      return true;
    } catch (error) {
      console.error('Manual import error:', error);
      showToast('Import failed: ' + error.message, 'error');
      return false;
    }
  },

  // ==================== BULK IMPORT ====================

  /**
   * Handle bulk import from multiple URLs
   * Reads URLs from the bulk URL textarea, validates them,
   * and processes them sequentially with progress tracking.
   */
  async handleBulkImport() {
    const bulkUrlsInput = document.getElementById('bulkUrls');
    const seriesSelect = document.getElementById('importSeriesSelect');
    const bulkProgressEl = document.getElementById('bulkImportProgress');
    const bulkResultsEl = document.getElementById('bulkImportResults');

    if (!bulkUrlsInput) {
      showToast('Bulk import UI not available on this page', 'warning');
      return;
    }

    const urlsText = bulkUrlsInput.value.trim();
    if (!urlsText) {
      showToast('Please enter at least one chapter URL', 'warning');
      return;
    }

    const seriesId = this.currentSeriesId || seriesSelect?.value;
    if (!seriesId) {
      showToast('Please select a series for bulk import', 'warning');
      return;
    }

    // Parse URLs (one per line, support comma-separated too)
    const urls = urlsText
      .split(/[\n,]+/)
      .map(u => u.trim())
      .filter(u => {
        try {
          new URL(u);
          return true;
        } catch {
          return false;
        }
      });

    if (urls.length === 0) {
      showToast('No valid URLs found. Enter one URL per line.', 'warning');
      return;
    }

    // Initialize bulk import state
    this.bulkImportQueue = urls;
    this.bulkImportProgress = { total: urls.length, completed: 0, failed: 0, current: 0 };
    this.bulkImportRunning = true;

    // Show progress UI
    if (bulkProgressEl) bulkProgressEl.classList.remove('hidden');
    if (bulkResultsEl) {
      bulkResultsEl.classList.remove('hidden');
      bulkResultsEl.innerHTML = '';
    }

    // Disable bulk import button during processing, show cancel button
    const bulkBtn = document.getElementById('bulkImportBtn');
    const bulkCancelBtn = document.getElementById('bulkCancelBtn');
    if (bulkBtn) {
      bulkBtn.disabled = true;
      bulkBtn.innerHTML = '<div class="spinner spinner-sm" style="border-color:white;display:inline-block;"></div> Importing...';
    }
    if (bulkCancelBtn) {
      bulkCancelBtn.style.display = '';
    }

    showToast(`Starting bulk import of ${urls.length} chapters...`, 'info');

    // Process URLs sequentially to avoid overwhelming the server
    for (let i = 0; i < urls.length; i++) {
      if (!this.bulkImportRunning) break;

      this.bulkImportProgress.current = i + 1;
      this.updateBulkProgress();

      try {
        // Extract chapter data
        const extractedData = await SourceRegistry.extract(urls[i]);
        
        // Save to database
        const existingChapter = await DB.getChapterByNumber(seriesId, extractedData.chapterNumber);
        
        if (existingChapter) {
          await DB.updateChapter(existingChapter.id, {
            chapterTitle: extractedData.chapterTitle,
            imageUrls: extractedData.imageUrls,
            thumbnail: extractedData.thumbnail || extractedData.imageUrls[0] || null,
            sourceUrl: extractedData.sourceUrl,
            source: extractedData.source
          });
        } else {
          await DB.addChapter({
            seriesId,
            chapterNumber: extractedData.chapterNumber,
            chapterTitle: extractedData.chapterTitle,
            chapterUrl: extractedData.sourceUrl,
            imageUrls: extractedData.imageUrls,
            thumbnail: extractedData.thumbnail || extractedData.imageUrls[0] || null,
            source: extractedData.source,
            releaseDate: new Date().toISOString()
          });
        }

        this.bulkImportProgress.completed++;
        this.addBulkResult(urls[i], 'success', `Chapter ${extractedData.chapterNumber} imported`);

      } catch (error) {
        this.bulkImportProgress.failed++;
        this.addBulkResult(urls[i], 'error', error.message);
        console.error(`[BulkImport] Failed for ${urls[i]}:`, error);
      }

      // Small delay between requests to avoid rate limiting
      if (i < urls.length - 1 && window.SourceConfig?.rateLimitMs) {
        await new Promise(resolve => setTimeout(resolve, window.SourceConfig.rateLimitMs));
      }
    }

    this.bulkImportRunning = false;

    // Final status
    const { total, completed, failed } = this.bulkImportProgress;
    if (failed === 0) {
      showToast(`Bulk import complete! ${completed}/${total} chapters imported.`, 'success');
    } else if (completed === 0) {
      showToast(`Bulk import failed. 0/${total} chapters imported.`, 'error');
    } else {
      showToast(`Bulk import partially complete. ${completed}/${total} imported, ${failed} failed.`, 'warning');
    }

    // Re-enable bulk import button, hide cancel button
    if (bulkBtn) {
      bulkBtn.disabled = false;
      bulkBtn.innerHTML = '<i class="fas fa-file-import"></i> Bulk Import';
    }
    if (bulkCancelBtn) {
      bulkCancelBtn.style.display = 'none';
    }

    // Refresh chapter list if on series page
    if (window.loadChapters) {
      window.loadChapters();
    }
  },

  /**
   * Update bulk import progress bar
   */
  updateBulkProgress() {
    const progressFill = document.getElementById('bulkProgressFill');
    const progressText = document.getElementById('bulkProgressText');
    
    const { total, completed, failed, current } = this.bulkImportProgress;
    const percent = Math.round((current / total) * 100);

    if (progressFill) {
      progressFill.style.width = `${percent}%`;
    }

    if (progressText) {
      progressText.textContent = `Processing ${current}/${total} (${completed} imported, ${failed} failed)`;
    }
  },

  /**
   * Add a result entry to the bulk import results list
   * @param {string} url - The URL that was processed
   * @param {string} status - 'success' or 'error'
   * @param {string} message - Result message
   */
  addBulkResult(url, status, message) {
    const resultsEl = document.getElementById('bulkImportResults');
    if (!resultsEl) return;

    const resultItem = document.createElement('div');
    resultItem.style.cssText = `
      display: flex; align-items: center; gap: var(--space-sm);
      padding: var(--space-xs) var(--space-sm);
      border-bottom: 1px solid var(--bg-tertiary);
      font-size: 0.8125rem;
    `;

    const icon = status === 'success' ? 'fa-check-circle' : 'fa-exclamation-circle';
    const color = status === 'success' ? 'var(--success)' : 'var(--error)';

    resultItem.innerHTML = `
      <i class="fas ${icon}" style="color:${color};flex-shrink:0;"></i>
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${url}">${url}</span>
      <span style="color:var(--text-muted);flex-shrink:0;">${message}</span>
    `;

    resultsEl.appendChild(resultItem);
    resultsEl.scrollTop = resultsEl.scrollHeight;
  },

  /**
   * Cancel a running bulk import
   */
  cancelBulkImport() {
    this.bulkImportRunning = false;
    
    // Restore UI state
    const bulkBtn = document.getElementById('bulkImportBtn');
    const bulkCancelBtn = document.getElementById('bulkCancelBtn');
    if (bulkBtn) {
      bulkBtn.disabled = false;
      bulkBtn.innerHTML = '<i class="fas fa-file-import"></i> Bulk Import';
    }
    if (bulkCancelBtn) {
      bulkCancelBtn.style.display = 'none';
    }
    
    showToast('Bulk import cancelled', 'warning');
  }
};

// Expose globally
window.ImportTool = ImportTool;
