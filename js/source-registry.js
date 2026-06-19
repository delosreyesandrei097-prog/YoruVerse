/**
 * ============================================================
 * MANHWA PLATFORM - SOURCE REGISTRY
 * ============================================================
 * Manages all source plugins for chapter extraction.
 * New sources can be registered here.
 * 
 * ARCHITECTURE:
 * 1. Registration: Source plugins register themselves via register()
 * 2. Detection: Given a URL, findSource() iterates through registered
 *    sources calling each source's detect(url) method
 * 3. Extraction: extract() delegates to the matched source's extract(url)
 * 4. Validation: Each source validates its own extracted data
 * 5. Storage: ImportTool.confirmImport() saves the data to Firestore
 *    via DB.addChapter() or DB.updateChapter()
 * 
 * FLOW:
 *   URL → findSource(url) → source.detect(url) → source.extract(url)
 *       → source.validate(data) → ImportTool.showPreview(data)
 *       → ImportTool.confirmImport() → DB.addChapter(data)
 * ============================================================
 */

const SourceRegistry = {
  // Registered sources
  sources: [],

  // Event listeners for source registration/extraction events
  _listeners: [],

  /**
   * Initialize and register all available sources
   */
  init() {
    this.sources = [];

    // Register built-in sources (order matters: more specific first)
    if (window.SourceVortexScans) {
      this.register(window.SourceVortexScans);
    }

    if (window.SourceHiveToons) {
      this.register(window.SourceHiveToons);
    }

    if (window.SourceRoliaScan) {
      this.register(window.SourceRoliaScan);
    }

    if (window.SourceMadaraScans) {
      this.register(window.SourceMadaraScans);
    }

    if (window.SourceUtoon) {
      this.register(window.SourceUtoon);
    }

    if (window.SourceVioletScans) {
      this.register(window.SourceVioletScans);
    }

    if (window.SourceKingOfShojo) {
      this.register(window.SourceKingOfShojo);
    }

    if (window.SourceTempleToons) {
      this.register(window.SourceTempleToons);
    }

    if (window.SourceQiManga) {
      this.register(window.SourceQiManga);
    }

    if (window.SourceMangaKatana) {
      this.register(window.SourceMangaKatana);
    }

    if (window.SourceGenZToons) {
      this.register(window.SourceGenZToons);
    }

    if (window.SourceFlameComics) {
      this.register(window.SourceFlameComics);
    }

    if (window.SourceAsuraScans) {
      this.register(window.SourceAsuraScans);
    }

    if (window.SourceTemplate) {
      this.register(window.SourceTemplate);
    }
    
    
    if (window.SourceExample) {
      this.register(window.SourceExample);
    }
    
    // Additional sources can register themselves by calling SourceRegistry.register()
    // after they are loaded
    
    console.log(`[SourceRegistry] Registered ${this.sources.length} sources: ${this.sources.map(s => s.name).join(', ')}`);
    
    // Dispatch init event
    this._dispatchEvent('registryReady', { sourceCount: this.sources.length });
  },

  /**
   * Register a new source
   * @param {Object} source - Source plugin object
   * @returns {boolean} Whether registration succeeded
   */
  register(source) {
    // Validate required interface methods
    if (!source || typeof source !== 'object') {
      console.error('[SourceRegistry] Invalid source: not an object');
      return false;
    }

    if (typeof source.detect !== 'function') {
      console.error(`[SourceRegistry] Source "${source.name || 'unknown'}" missing detect() method`);
      return false;
    }

    if (typeof source.extract !== 'function') {
      console.error(`[SourceRegistry] Source "${source.name || 'unknown'}" missing extract() method`);
      return false;
    }

    // Validate metadata
    if (!source.name) {
      console.error('[SourceRegistry] Source missing required "name" property');
      return false;
    }

    if (!source.domain) {
      console.warn(`[SourceRegistry] Source "${source.name}" missing "domain" property - URL detection may fail`);
    }

    // Check if already registered
    const exists = this.sources.some(s => s.name === source.name);
    if (exists) {
      console.warn(`[SourceRegistry] Source "${source.name}" already registered, skipping`);
      return false;
    }

    this.sources.push(source);
    console.log(`[SourceRegistry] Registered source: ${source.name} (${source.domain || 'no domain'})`);
    
    // Dispatch registration event
    this._dispatchEvent('sourceRegistered', { source });
    
    return true;
  },

  /**
   * Unregister a source by name
   * @param {string} name - Source name to remove
   * @returns {boolean}
   */
  unregister(name) {
    const index = this.sources.findIndex(s => s.name === name);
    if (index === -1) {
      console.warn(`[SourceRegistry] Source "${name}" not found`);
      return false;
    }
    
    const removed = this.sources.splice(index, 1)[0];
    console.log(`[SourceRegistry] Unregistered source: ${removed.name}`);
    this._dispatchEvent('sourceUnregistered', { source: removed });
    return true;
  },

  /**
   * Find a source that can handle the given URL
   * @param {string} url - The chapter URL
   * @returns {Object|null} Matching source or null
   */
  findSource(url) {
    if (!url || typeof url !== 'string') {
      return null;
    }

    // Validate URL format
    try {
      new URL(url);
    } catch (e) {
      console.error('[SourceRegistry] Invalid URL format:', url);
      return null;
    }

    for (const source of this.sources) {
      try {
        if (source.detect(url)) {
          return source;
        }
      } catch (error) {
        console.error(`[SourceRegistry] Error in detect() for "${source.name}":`, error);
      }
    }
    return null;
  },

  /**
   * Get all registered sources
   * @returns {Object[]}
   */
  getSources() {
    return [...this.sources];
  },

  /**
   * Get source by name
   * @param {string} name - Source name
   * @returns {Object|null}
   */
  getSource(name) {
    return this.sources.find(s => s.name === name) || null;
  },

  /**
   * Attempt to extract chapter data from URL
   * Returns the first successful extraction
   * @param {string} url - The chapter URL
   * @returns {Promise<Object>} Extracted chapter data
   */
  async extract(url) {
    // Validate URL
    if (!url || typeof url !== 'string') {
      throw new Error('A valid URL is required for extraction');
    }

    // Apply rate limiting if SourceConfig is available
    if (window.SourceConfig?.waitForRateLimit) {
      try {
        const urlObj = new URL(url);
        await window.SourceConfig.waitForRateLimit(urlObj.hostname);
      } catch (e) {
        // Non-critical: continue even if rate limiting fails
      }
    }

    const source = this.findSource(url);
    
    if (!source) {
      const supportedDomains = this.sources.map(s => s.domain).filter(Boolean).join(', ');
      throw new Error(
        `No source plugin found for this URL. ` +
        `Supported domains: ${supportedDomains || 'none'}. ` +
        `You can add support by creating a new source plugin.`
      );
    }

    console.log(`[SourceRegistry] Using source: ${source.name}`);
    this._dispatchEvent('extractionStarted', { source, url });

    try {
      const data = await source.extract(url);
      
      // Post-extraction validation by the registry
      if (!data || typeof data !== 'object') {
        throw new Error(`${source.name} returned invalid data (not an object)`);
      }

      // Ensure minimum required fields exist
      if (!data.imageUrls || !Array.isArray(data.imageUrls) || data.imageUrls.length === 0) {
        throw new Error(
          `Extraction succeeded but no images were found. ` +
          `The site structure may have changed or images may be loaded dynamically.`
        );
      }

      // Normalize data
      const normalizedData = {
        chapterTitle: data.chapterTitle || `Chapter ${data.chapterNumber || '?'}`,
        chapterNumber: data.chapterNumber || null,
        imageUrls: data.imageUrls,
        thumbnail: data.thumbnail || data.imageUrls[0] || null,
        seriesTitle: data.seriesTitle || null,
        source: source.name,
        sourceUrl: url,
        extractedAt: new Date().toISOString()
      };

      console.log(`[SourceRegistry] Extraction successful: ${normalizedData.imageUrls.length} images, Chapter ${normalizedData.chapterNumber}`);
      this._dispatchEvent('extractionCompleted', { source, url, data: normalizedData });
      
      return normalizedData;
    } catch (error) {
      console.error(`[SourceRegistry] Extraction failed for ${source.name}:`, error);
      this._dispatchEvent('extractionFailed', { source, url, error });
      
      // Enhance error message with helpful context
      if (error.message?.includes('CORS') || error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError')) {
        throw new Error(
          `Could not fetch from ${source.domain}. ` +
          `The built-in proxy fallbacks were also blocked or unavailable. ` +
          `Try again later or set a custom SourceConfig.proxyUrl.`
        );
      }
      
      throw error;
    }
  },

  /**
   * Check if any source can handle the URL
   * @param {string} url
   * @returns {boolean}
   */
  canHandle(url) {
    return this.findSource(url) !== null;
  },

  /**
   * Get supported domains list
   * @returns {Object[]}
   */
  getSupportedDomains() {
    return this.sources.map(s => ({
      name: s.name,
      domain: s.domain,
      patterns: s.patterns?.map(p => p.toString()) || []
    }));
  },

  /**
   * Add event listener for registry events
   * Events: registryReady, sourceRegistered, sourceUnregistered,
   *         extractionStarted, extractionCompleted, extractionFailed
   * @param {string} event - Event name
   * @param {Function} callback - Event handler
   */
  addEventListener(event, callback) {
    if (typeof callback !== 'function') return;
    this._listeners.push({ event, callback });
  },

  /**
   * Remove event listener
   * @param {string} event - Event name
   * @param {Function} callback - Event handler to remove
   */
  removeEventListener(event, callback) {
    this._listeners = this._listeners.filter(
      l => l.event !== event || l.callback !== callback
    );
  },

  /**
   * Dispatch internal event
   * @param {string} event - Event name
   * @param {Object} detail - Event data
   */
  _dispatchEvent(event, detail) {
    this._listeners
      .filter(l => l.event === event)
      .forEach(l => {
        try {
          l.callback(detail);
        } catch (e) {
          console.error(`[SourceRegistry] Event listener error for "${event}":`, e);
        }
      });
  }
};

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  SourceRegistry.init();
});

// Expose globally
window.SourceRegistry = SourceRegistry;
