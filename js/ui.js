/**
 * ============================================================
 * MANHWA PLATFORM - UI UTILITIES MODULE
 * ============================================================
 * Common UI functions for:
 * - Toast notifications
 * - Modal management
 * - Loading states
 * - Image lazy loading
 * - Infinite scroll
 * - Mobile menu
 * - Theme toggle
 * - Header scroll behavior
 * ============================================================
 */

const UI = {
  // ==================== TOAST NOTIFICATIONS ====================
  
  toastContainer: null,

  initToastContainer() {
    if (!this.toastContainer) {
      this.toastContainer = document.createElement('div');
      this.toastContainer.className = 'toast-container';
      document.body.appendChild(this.toastContainer);
    }
  },

  showToast(message, type = 'info', duration = 4000) {
    this.initToastContainer();

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    
    const icons = {
      success: 'fa-check-circle',
      error: 'fa-exclamation-circle',
      warning: 'fa-exclamation-triangle',
      info: 'fa-info-circle'
    };

    toast.innerHTML = `
      <i class="fas ${icons[type] || icons.info}"></i>
      <span>${message}</span>
    `;

    this.toastContainer.appendChild(toast);

    // Animate in
    requestAnimationFrame(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      requestAnimationFrame(() => {
        toast.style.transition = 'all 300ms ease';
        toast.style.opacity = '1';
        toast.style.transform = 'translateX(0)';
      });
    });

    // Remove after duration
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(100%)';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },

  // ==================== MODAL ====================

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.add('active');
      document.body.style.overflow = 'hidden';
    }
  },

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('active');
      document.body.style.overflow = '';
    }
  },

  // ==================== LOADING STATES ====================

  showLoading(elementId) {
    const element = document.getElementById(elementId);
    if (element) {
      element.innerHTML = '<div class="flex justify-center items-center" style="padding: 3rem;"><div class="spinner"></div></div>';
    }
  },

  hideLoading(elementId, content) {
    const element = document.getElementById(elementId);
    if (element) {
      element.innerHTML = content;
    }
  },

  // ==================== IMAGE LAZY LOADING ====================

  initLazyLoading() {
    const imageObserver = new IntersectionObserver((entries, observer) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const img = entry.target;
          const src = img.dataset.src;

          if (src) {
            // decoding=async + a real src as early as the IO fires keeps
            // the main thread free and lets the browser parallelise
            // network + decode work for the next pages while you scroll.
            if (!img.hasAttribute('decoding')) img.decoding = 'async';
            img.src = src;
            img.removeAttribute('data-src');
            img.classList.add('loaded');
          }

          observer.unobserve(img);
        }
      });
    }, {
      // Wider preload window: start fetching ~1.5 viewports before the
      // image scrolls in so chapter pages feel instant on long scrolls.
      rootMargin: '1500px 0px',
      threshold: 0.01
    });

    // Observe all lazy images
    const lazyImages = document.querySelectorAll('img[data-src]');
    lazyImages.forEach(img => imageObserver.observe(img));

    // Return observer for manual observation
    return imageObserver;
  },

  observeLazyImage(img) {
    // This will be populated by initLazyLoading
  },

  // ==================== INFINITE SCROLL ====================

  initInfiniteScroll(callback, options = {}) {
    const { threshold = 100, rootMargin = '200px' } = options;

    const trigger = document.createElement('div');
    trigger.className = 'load-more-trigger';
    trigger.innerHTML = '<div class="spinner spinner-sm"></div>';
    
    const container = options.container || document.body;
    container.appendChild(trigger);

    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          callback();
        }
      });
    }, {
      rootMargin: `${rootMargin} 0px`
    });

    observer.observe(trigger);

    return {
      trigger,
      observer,
      destroy() {
        observer.disconnect();
        trigger.remove();
      }
    };
  },

  // ==================== MOBILE MENU ====================

  initMobileMenu() {
    const menuBtn = document.querySelector('[data-mobile-menu-btn]');
    const menu = document.querySelector('[data-mobile-menu]');
    
    if (menuBtn && menu) {
      menuBtn.addEventListener('click', () => {
        menu.classList.toggle('active');
      });

      // Close on overlay click
      menu.addEventListener('click', (e) => {
        if (e.target === menu) {
          menu.classList.remove('active');
        }
      });

      // Close menu on link click
      const menuLinks = menu.querySelectorAll('a');
      menuLinks.forEach(link => {
        link.addEventListener('click', () => {
          menu.classList.remove('active');
        });
      });
    }
  },

  // ==================== THEME TOGGLE ====================

  initTheme() {
    // Check saved theme
    const savedTheme = localStorage.getItem('theme') || 'dark';
    document.documentElement.setAttribute('data-theme', savedTheme);

    const themeToggle = document.querySelector('[data-theme-toggle]');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => {
        const currentTheme = document.documentElement.getAttribute('data-theme');
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
        
        // Update icon
        const icon = themeToggle.querySelector('i');
        if (icon) {
          icon.className = newTheme === 'dark' ? 'fas fa-moon' : 'fas fa-sun';
        }
      });
    }
  },

  // ==================== HEADER SCROLL ====================

  initHeaderScroll() {
    const header = document.querySelector('.header');
    if (!header) return;

    let lastScroll = 0;
    
    window.addEventListener('scroll', () => {
      const currentScroll = window.pageYOffset;
      
      if (currentScroll > 100) {
        header.style.background = 'rgba(10, 10, 15, 0.98)';
      } else {
        header.style.background = 'rgba(10, 10, 15, 0.95)';
      }
      
      lastScroll = currentScroll;
    });
  },

  // ==================== SEARCH ====================
  // Live, instant-search dropdown for every [data-search-input] in the site.
  // FIXES:
  //   - Previous version only logged results to the console — nothing rendered.
  //   - Required typing the FULL title before navigating. Now suggestions
  //     appear after the 1st character.
  //   - Adds keyboard navigation (Up/Down/Enter/Escape) and shows cover,
  //     rating and status for each suggestion.

  _searchDropdownFor(input) {
    let dd = input._searchDropdown;
    if (dd && document.body.contains(dd)) return dd;
    dd = document.createElement('div');
    dd.className = 'search-suggestions';
    dd.setAttribute('role', 'listbox');
    // Anchor to the input's parent so positioning works inside .search-bar
    const parent = input.parentElement;
    if (parent && getComputedStyle(parent).position === 'static') {
      parent.style.position = 'relative';
    }
    (parent || document.body).appendChild(dd);
    input._searchDropdown = dd;
    return dd;
  },

  _closeAllSearchDropdowns() {
    document.querySelectorAll('.search-suggestions.open').forEach(d => d.classList.remove('open'));
  },

  initSearch() {
    const searchInputs = document.querySelectorAll('[data-search-input]');

    searchInputs.forEach(input => {
      let debounceTimer;
      let activeIndex = -1;
      let currentResults = [];

      const dropdown = this._searchDropdownFor(input);

      const close = () => {
        dropdown.classList.remove('open');
        activeIndex = -1;
      };

      const highlight = () => {
        dropdown.querySelectorAll('.search-suggestion').forEach((el, i) => {
          el.classList.toggle('active', i === activeIndex);
        });
      };

      input.addEventListener('input', (e) => {
        clearTimeout(debounceTimer);
        const query = e.target.value.trim();
        if (query.length < 1) { close(); return; }
        // 60ms debounce + in-memory cached index = instant feel, zero
        // Firestore reads per keystroke after the first.
        debounceTimer = setTimeout(async () => {
          try {
            const list = (typeof DB.searchSeries === 'function')
              ? await DB.searchSeries(query, 8)
              : ((await DB.getSeries({ search: query, limit: 8 }))?.series || []);
            currentResults = (list || []).slice(0, 8);
            this.showSearchResults(currentResults, input, query);
            activeIndex = -1;
          } catch (err) {
            console.error('Search error:', err);
          }
        }, 60);
      });

      input.addEventListener('keydown', (e) => {
        const open = dropdown.classList.contains('open');
        if (e.key === 'ArrowDown' && open) {
          e.preventDefault();
          activeIndex = Math.min(activeIndex + 1, currentResults.length - 1);
          highlight();
        } else if (e.key === 'ArrowUp' && open) {
          e.preventDefault();
          activeIndex = Math.max(activeIndex - 1, -1);
          highlight();
        } else if (e.key === 'Enter') {
          if (open && activeIndex >= 0 && currentResults[activeIndex]) {
            e.preventDefault();
            window.location.href = AppPath.to(`pages/series.html?id=${currentResults[activeIndex].id}`);
            return;
          }
          const query = input.value.trim();
          if (query) {
            window.location.href = AppPath.to(`pages/browse.html?q=${encodeURIComponent(query)}`);
          }
        } else if (e.key === 'Escape') {
          close();
        }
      });

      input.addEventListener('blur', () => setTimeout(close, 150));
      input.addEventListener('focus', () => {
        if (currentResults.length) dropdown.classList.add('open');
      });
    });

    // Close on outside click
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.search-suggestions') && !e.target.matches('[data-search-input]')) {
        this._closeAllSearchDropdowns();
      }
    });
  },

  async performSearch(query) {
    // Kept for backwards compatibility — initSearch now handles rendering.
    try {
      return await DB.getSeries({ search: query, limit: 8 });
    } catch (error) {
      console.error('Search error:', error);
      return [];
    }
  },

  showSearchResults(results, input, query) {
    const dropdown = this._searchDropdownFor(input);
    if (!results || results.length === 0) {
      dropdown.innerHTML = `
        <div class="search-suggestion-empty">
          No results for "<strong>${(query || '').replace(/</g, '&lt;')}</strong>"
        </div>`;
      dropdown.classList.add('open');
      return;
    }

    dropdown.innerHTML = results.map((s, i) => {
      const rating = (s.rating != null && !isNaN(s.rating)) ? Number(s.rating).toFixed(1) : 'N/A';
      const cover = s.coverImage || AppPath.to('images/placeholder.jpg');
      const status = s.status || 'Ongoing';
      const genres = (s.genres || []).slice(0, 2).join(' • ');
      return `
        <a class="search-suggestion" data-index="${i}"
           href="${AppPath.to(`pages/series.html?id=${s.id}`)}">
          <img class="search-suggestion-cover" src="${cover}" alt="" loading="lazy">
          <div class="search-suggestion-info">
            <div class="search-suggestion-title">${s.title || 'Untitled'}</div>
            <div class="search-suggestion-meta">
              <span><i class="fas fa-star"></i> ${rating}</span>
              <span>${status}</span>
              ${genres ? `<span>${genres}</span>` : ''}
            </div>
          </div>
        </a>`;
    }).join('');
    dropdown.classList.add('open');
  },



  // ==================== CARD RENDERING ====================

  /**
   * Format a timestamp (Date | firestore Timestamp | ms number | ISO string)
   * as a compact "time ago" string: 10s, 5m, 2h, 1d, 3d, 2w, 4mo, 1y.
   */
  timeAgo(ts) {
    if (!ts) return '';
    let date;
    if (ts && typeof ts.toDate === 'function') date = ts.toDate();
    else if (ts instanceof Date) date = ts;
    else if (typeof ts === 'number') date = new Date(ts);
    else if (typeof ts === 'string') date = new Date(ts);
    else if (ts.seconds != null)    date = new Date(ts.seconds * 1000);
    else return '';
    const diff = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (diff < 10)       return 'just now';
    if (diff < 60)       return diff + 's ago';
    if (diff < 3600)     return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400)    return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400*7)  { const d = Math.floor(diff/86400); return d + (d === 1 ? ' day ago' : ' days ago'); }
    if (diff < 86400*30) return Math.floor(diff/86400/7) + 'w ago';
    if (diff < 86400*365)return Math.floor(diff/86400/30) + 'mo ago';
    return Math.floor(diff/86400/365) + 'y ago';
  },

  renderSeriesCard(series, options = {}) {
    const { className = '' } = options;
    const placeholder = AppPath.to('images/placeholder.jpg');
    const cover = series.coverImage || series.cover || placeholder;
    const seriesHref = AppPath.to(`pages/series.html?id=${series.id}`);

    const chapterNum = series.latestChapter;
    const chapterId  = series.latestChapterId;
    const updatedAt  = series.updatedAt || series.lastSyncTime || series.lastChapterAt;
    const timeStr    = this.timeAgo(updatedAt);

    const chapterHref = chapterId
      ? AppPath.to(`pages/chapter.html?series=${series.id}&chapter=${chapterId}`)
      : seriesHref;

    const chapterPill = (chapterNum != null && chapterNum !== '')
      ? `<a href="${chapterHref}" class="series-card-chip" data-stop-prop>Ch. ${chapterNum}</a>`
      : `<span class="series-card-chip is-empty">No chapters</span>`;

    const titleSafe = String(series.title || 'Untitled').replace(/"/g, '&quot;');

    return `
      <div class="series-card ${className}" data-series-id="${series.id}">
        <a href="${seriesHref}" class="series-card-image" aria-label="${titleSafe}">
          <img data-src="${cover}" alt="${titleSafe}" loading="lazy">
        </a>
        <div class="series-card-info">
          <div class="series-card-row">
            ${chapterPill}
            ${timeStr ? `<span class="series-card-time" title="Latest update">${timeStr}</span>` : ''}
          </div>
          <a href="${seriesHref}" class="series-card-title-link">
            <h3 class="series-card-title">${titleSafe}</h3>
          </a>
        </div>
      </div>
    `;
  },

  // Deterministic per-chapter "preview" thumbnail. Skips the first page
  // (almost always the cover) and the last page (often credits) so the
  // thumbnail reflects an actual story panel. Falls back gracefully for
  // chapters with very few pages or an explicit chapter.thumbnail.
  pickChapterThumb(chapter) {
    const placeholder = AppPath.to('images/placeholder.svg');
    if (!chapter) return placeholder;
    const imgs = Array.isArray(chapter.imageUrls) ? chapter.imageUrls : [];

    // If a stored thumbnail exists AND it isn't just the cover/credits page,
    // honour it. Otherwise compute a better preview from imageUrls so older
    // chapters (imported before the cover-page fix) still look right.
    const stored = chapter.thumbnail;
    const isFirstOrLast = stored && imgs.length > 2 &&
      (stored === imgs[0] || stored === imgs[imgs.length - 1]);
    if (stored && !isFirstOrLast) return stored;

    if (imgs.length === 0) return stored || placeholder;
    if (imgs.length === 1) return imgs[0];
    if (imgs.length === 2) return imgs[1];

    const key = String(chapter.id || chapter.chapterNumber || '');
    let h = 0;
    for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
    const skipStart = imgs.length >= 6 ? 2 : 1;   // skip cover + credits page
    const skipEnd   = imgs.length >= 10 ? 2 : 1;  // skip outro / "next chapter"
    const lo = skipStart;
    const hi = Math.max(lo, imgs.length - 1 - skipEnd);
    return imgs[lo + (Math.abs(h) % Math.max(1, hi - lo + 1))];
  },

  renderChapterRow(chapter, seriesId, options = {}) {
    const { isRead = false } = options;
    const rawDate = chapter.createdAt || chapter.releasedAt || chapter.updatedAt;
    const timeStr = rawDate ? this.timeAgo(rawDate) : 'Recently';
    const placeholder = AppPath.to('images/placeholder.svg');
    const thumb = this.pickChapterThumb(chapter) || placeholder;

    const pages = chapter.imageUrls?.length || 0;
    const hasCustomTitle = chapter.chapterTitle
      && chapter.chapterTitle.trim()
      && chapter.chapterTitle.trim().toLowerCase() !== `chapter ${chapter.chapterNumber}`.toLowerCase();
    const title = hasCustomTitle
      ? `Chapter ${chapter.chapterNumber}: ${chapter.chapterTitle}`
      : `Chapter ${chapter.chapterNumber}`;

    const readBadge = isRead
      ? `<span class="chapter-read-badge" title="You've read this chapter"><i class="fas fa-check"></i> Read</span>`
      : '';

    return `
      <a href="${AppPath.to(`pages/chapter.html?series=${seriesId}&chapter=${chapter.id}`)}"
         class="chapter-row ${isRead ? 'is-read' : ''}"
         data-chapter-id="${chapter.id}">
        <div class="chapter-row-thumb">
          <img src="${thumb}" alt="" loading="lazy"
               onerror="this.onerror=null;this.src='${placeholder}';">
          <span class="chapter-row-number-pill">${chapter.chapterNumber}</span>
        </div>
        <div class="chapter-row-body">
          <h4 class="chapter-row-title">${title}</h4>
          <div class="chapter-row-meta">
            <span class="chapter-row-date">${timeStr}</span>
            ${pages ? `<span class="chapter-row-dot">·</span><span>${pages} pages</span>` : ''}
          </div>
        </div>
        <div class="chapter-row-right">
          ${readBadge}
          <i class="fas fa-chevron-right chapter-row-chevron" aria-hidden="true"></i>
        </div>
      </a>
    `;
  },


  // ==================== EMPTY STATES ====================

  renderEmptyState(title, description, icon = 'fa-book-open') {
    return `
      <div class="empty-state">
        <div class="empty-state-icon">
          <i class="fas ${icon}"></i>
        </div>
        <h3 class="empty-state-title">${title}</h3>
        <p class="empty-state-desc">${description}</p>
      </div>
    `;
  },

  // ==================== INITIALIZATION ====================

  init() {
    this.initToastContainer();
    this.initMobileMenu();
    this.initTheme();
    this.initHeaderScroll();
    this.initSearch();
    this.initLazyLoading();

    // Close modals on escape
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.active').forEach(modal => {
          modal.classList.remove('active');
        });
        document.body.style.overflow = '';
      }
    });

    // Close modals on overlay click
    document.addEventListener('click', (e) => {
      if (e.target.classList.contains('modal-overlay')) {
        e.target.classList.remove('active');
        document.body.style.overflow = '';
      }
    });
  }
};

// Toast helper function
function showToast(message, type = 'info', duration = 4000) {
  UI.showToast(message, type, duration);
}

// Expose UI globally
window.UI = UI;
