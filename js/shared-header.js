/**
 * ============================================================
 * SHARED HEADER & MOBILE MENU
 * ============================================================
 * Renders an identical header + mobile menu on every page,
 * regardless of what HTML the page originally shipped.
 *
 *  - Always shows: Logo, Search, Nav, Notification (with badge),
 *    Profile/Login, Mobile-menu button.
 *  - Theme (light/dark) toggle is moved INTO the mobile menu.
 *  - Active nav link is detected from the current URL.
 *  - Notification badge subscribes to Firestore in real-time and
 *    shows the unread count; it clears automatically when the
 *    user opens the notifications page.
 *
 * Requires AppPath (path-utils.js). Optional: firebase, Auth.
 * ============================================================
 */
(function () {
  'use strict';

  const P = (rel) => (window.AppPath ? window.AppPath.to(rel) : rel);

  // -------- Maintenance Mode Gate --------
  // If meta/maintenance.enabled == true, redirect everyone to the
  // maintenance page EXCEPT admins/moderators. Admin dashboard and the
  // maintenance page itself are always reachable.
  (function maintenanceGate() {
    try {
      if (window.__mpMaintenanceGateRan) return;
      window.__mpMaintenanceGateRan = true;

      const path = (location.pathname || '').toLowerCase();
      const file = path.split('/').pop() || '';
      // Pages that must remain accessible regardless of maintenance state.
      const EXEMPT = ['maintenance.html', 'admin.html', 'admin-import-series.html', 'login.html', 'register.html'];
      if (EXEMPT.includes(file)) return;

      const checkAndRedirect = async () => {
        if (!window.firebase || !firebase.firestore) return;
        try {
          const snap = await firebase.firestore().collection('meta').doc('maintenance').get();
          if (!snap.exists) return;
          const data = snap.data() || {};
          if (!data.enabled) return;

          // Allow admins/moderators to keep browsing.
          const user = (firebase.auth && firebase.auth().currentUser) || null;
          if (user) {
            try {
              const uSnap = await firebase.firestore().collection('users').doc(user.uid).get();
              const role = uSnap.exists ? uSnap.data().role : null;
              if (role === 'admin' || role === 'moderator') return;
            } catch (_) {}
          }
          window.location.replace(P('pages/maintenance.html'));
        } catch (_) {}
      };

      // Run after auth has had a chance to determine state.
      const start = () => {
        try {
          if (firebase.auth) {
            const off = firebase.auth().onAuthStateChanged(() => {
              checkAndRedirect();
              try { off && off(); } catch (_) {}
            });
          } else {
            checkAndRedirect();
          }
        } catch (_) { checkAndRedirect(); }
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
      } else {
        start();
      }
    } catch (e) { /* never block page rendering */ }
  })();

  // -------- Auto-Sync bootstrap (runs on EVERY page that loads this file) --------
  // The Sync & Auto-Sync engine previously only worked while the admin
  // import page was open because that was the only page that loaded
  // series-sync.js. We now lazy-load the sync engine + its dependencies
  // on every page so Auto-Sync keeps ticking while users browse the site.
  (function bootstrapAutoSync() {
    try {
      if (window.__mpAutoSyncBootstrapped) return;
      window.__mpAutoSyncBootstrapped = true;
      if (window.SeriesSync) return; // already loaded by this page (e.g. admin)

      const loadScript = (src) => new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src; s.async = false;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Failed to load ' + src));
        document.head.appendChild(s);
      });

      const scripts = [
        'js/source-config.js',
        'js/source-registry.js',
        'sources/source-template.js',
        'sources/source-vortexscans.js',
        'sources/source-vortexscans-series.js',
        'sources/source-hivetoons.js',
        'sources/source-hivetoons-series.js',
        'sources/source-roliascan.js',
        'sources/source-roliascan-series.js',
        'sources/source-asurascans-series.js',
        'sources/source-madarascans.js',
        'sources/source-madarascans-series.js',
        'sources/source-utoon.js',
        'sources/source-utoon-series.js',
        'sources/source-violetscans.js',
        'sources/source-kingofshojo.js',
        'sources/source-templetoons.js',
        'sources/source-qimanga.js',
        'sources/source-mangakatana.js',
        'sources/source-genztoons.js',
        'sources/source-genztoons-series.js',
        'sources/source-flamecomics.js',
        'sources/source-flamecomics-series.js',
        'js/series-importer.js',
        'js/series-sync.js'
      ];

      (async () => {
        for (const rel of scripts) {
          try { await loadScript(P(rel)); }
          catch (e) { console.warn('[AutoSync bootstrap]', e.message); }
        }
        try {
          if (window.SeriesSync && typeof window.SeriesSync.initFromStorage === 'function') {
            window.SeriesSync.initFromStorage();
          }
        } catch (e) { console.warn('[AutoSync bootstrap] init failed', e); }
      })();
    } catch (e) { console.warn('[AutoSync bootstrap] disabled:', e); }
  })();

  // -------- Active-link detection --------
  function currentKey() {
    const path = (location.pathname || '').toLowerCase();
    const file = path.split('/').pop() || '';
    if (!file || file === 'index.html' || path.endsWith('/')) return 'home';
    if (file.startsWith('browse'))       return 'browse';
    if (file.startsWith('library'))      return 'library';
    if (file.startsWith('favorites'))    return 'favorites';
    if (file.startsWith('history'))      return 'history';
    if (file.startsWith('profile'))      return 'profile';
    if (file.startsWith('notifications'))return 'notifications';
    if (file.startsWith('settings'))     return 'settings';
    if (file.startsWith('admin'))        return 'admin';
    if (file.startsWith('discussion'))   return 'discussion';
    return '';
  }

  // -------- Header markup --------
  function headerHTML(active) {
    const isActive = (k) => active === k ? 'active' : '';
    return `
    <div class="header-content">
      <a href="${P('index.html')}" class="logo" aria-label="YoruVerse home">
        
        <img src="${P('images/Y.png')}" alt="YoruVerse" class="logo-text-img">
      </a>

      <div class="search-bar" id="desktopSearchBar">
        <i class="fas fa-search search-icon"></i>
        <input type="text" placeholder="Search manhwa..." data-search-input aria-label="Search">
      </div>

      <nav class="nav-links" aria-label="Primary">
        <a href="${P('index.html')}" class="nav-link ${isActive('home')}">Home</a>
        <a href="${P('pages/browse.html')}" class="nav-link ${isActive('browse')}">Browse</a>
        <a href="${P('pages/library.html')}" class="nav-link ${isActive('library')}" data-auth-required style="display:none;">Library</a>
        <a href="${P('pages/discussion.html')}" class="nav-link ${isActive('discussion')}">Discussion</a>
      </nav>

      <div class="header-actions">
        <button class="icon-btn" id="searchToggle" title="Search" aria-label="Search">
          <i class="fas fa-search"></i>
        </button>
        <a href="${P('pages/notifications.html')}" class="icon-btn"
           id="notifBtn" data-auth-required style="display:none;" title="Notifications" aria-label="Notifications">
          <i class="fas fa-bell"></i>
          <span class="notification-badge" id="notifBadge" style="display:none;"></span>
        </a>
        <a href="${P('pages/profile.html')}" class="avatar-btn"
           data-auth-required style="display:none;" title="Profile" aria-label="Profile">
          <img data-user-avatar src="${P('images/default-avatar.png')}" alt="">
        </a>
        <a href="${P('pages/login.html')}" class="btn btn-primary btn-sm" data-auth-guest>Login</a>
        <button class="icon-btn mobile-menu-btn" data-mobile-menu-btn title="Menu" aria-label="Menu">
          <i class="fas fa-bars"></i>
        </button>
      </div>
    </div>

    <div class="search-bar mobile-open" id="mobileSearchBar" style="display:none;">
      <i class="fas fa-search search-icon"></i>
      <input type="text" placeholder="Search manhwa..." data-search-input aria-label="Search">
    </div>`;
  }

  function mobileMenuHTML(active) {
    const isActive = (k) => active === k ? 'active' : '';
    const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
    const themeLabel = currentTheme === 'dark' ? 'Light Mode' : 'Dark Mode';
    const themeIcon  = currentTheme === 'dark' ? 'fa-sun'     : 'fa-moon';
    return `
    <div class="mobile-menu-panel">
      <div class="mobile-menu-header">
        <a href="${P('index.html')}" class="logo">
          

        </a>
        <button class="icon-btn" data-mobile-menu-close aria-label="Close menu">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <!-- User profile header (only shown to logged-in users) -->
      <a href="${P('pages/profile.html')}" class="mobile-menu-user" data-mobile-user data-auth-required style="display:none;text-decoration:none;color:inherit;padding:1rem 1.25rem;margin:0 0 .5rem;border-bottom:1px solid var(--border-color,#2a2a2a);display:flex;align-items:center;gap:.85rem;">
        <img data-user-avatar src="${P('images/default-avatar.png')}" alt=""
             style="width:48px;height:48px;border-radius:50%;object-fit:cover;border:2px solid var(--accent-primary,#6366f1);flex:0 0 auto;">
        <div style="min-width:0;flex:1;">
          <div data-mobile-username style="font-weight:700;font-size:1rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">User</div>
          <div style="font-size:.8rem;color:var(--accent-primary,#6366f1);font-weight:600;">View Profile <i class="fas fa-arrow-right" style="font-size:.7rem;"></i></div>
        </div>
      </a>

      <div class="mobile-menu-links">
        <a href="${P('index.html')}" class="mobile-menu-link ${isActive('home')}"><i class="fas fa-home"></i> Home</a>
        <a href="${P('pages/browse.html')}" class="mobile-menu-link ${isActive('browse')}"><i class="fas fa-search"></i> Browse</a>
        <a href="${P('pages/library.html')}" class="mobile-menu-link ${isActive('library')}" data-auth-required style="display:none;"><i class="fas fa-bookmark"></i> Library</a>
        <a href="${P('pages/history.html')}" class="mobile-menu-link ${isActive('history')}" data-auth-required style="display:none;"><i class="fas fa-history"></i> History</a>
        <a href="${P('pages/discussion.html')}" class="mobile-menu-link ${isActive('discussion')}"><i class="fas fa-users"></i> Discussion Board</a>
        <a href="${P('pages/notifications.html')}" class="mobile-menu-link ${isActive('notifications')}" data-auth-required style="display:none;">
          <i class="fas fa-bell"></i> Notifications
          <span class="mobile-notif-badge" id="mobileNotifBadge" style="display:none;"></span>
        </a>
        <a href="${P('pages/profile.html')}" class="mobile-menu-link ${isActive('profile')}" data-auth-required style="display:none;"><i class="fas fa-user"></i> Profile</a>
        <a href="${P('pages/settings.html')}" class="mobile-menu-link ${isActive('settings')}" data-auth-required style="display:none;"><i class="fas fa-cog"></i> Settings</a>
        <a href="${P('pages/admin.html')}" class="mobile-menu-link ${isActive('admin')}" data-admin-only style="display:none;"><i class="fas fa-shield-alt"></i> Admin Dashboard</a>
        <a href="${P('pages/about.html')}" class="mobile-menu-link"><i class="fas fa-info-circle"></i> About</a>

        <button type="button" class="mobile-menu-link mobile-menu-theme" id="mobileThemeToggle">
          <i class="fas ${themeIcon}"></i> <span id="mobileThemeLabel">${themeLabel}</span>
        </button>

        <a href="#" class="mobile-menu-link" data-auth-required style="display:none;"
           onclick="if(window.Auth&&Auth.logout)Auth.logout();return false;">
          <i class="fas fa-sign-out-alt"></i> Logout
        </a>
        <a href="${P('pages/login.html')}" class="mobile-menu-link" data-auth-guest>
          <i class="fas fa-sign-in-alt"></i> Login
        </a>
      </div>
    </div>`;
  }

  // -------- Wiring helpers --------
  function wireMobileSearch() {
    const btn = document.getElementById('searchToggle');
    const bar = document.getElementById('mobileSearchBar');
    if (btn && bar) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        bar.style.display = bar.style.display === 'none' ? 'block' : 'none';
        if (bar.style.display === 'block') {
          const inp = bar.querySelector('input');
          if (inp) inp.focus();
        }
      });
    }
  }

  function wireMobileMenu() {
    const menu = document.querySelector('[data-mobile-menu]');
    if (!menu) return;
    document.querySelectorAll('[data-mobile-menu-btn]').forEach(btn => {
      btn.addEventListener('click', () => menu.classList.add('active'));
    });
    menu.addEventListener('click', (e) => {
      if (e.target === menu) menu.classList.remove('active');
    });
    menu.querySelectorAll('[data-mobile-menu-close]').forEach(b =>
      b.addEventListener('click', () => menu.classList.remove('active'))
    );
    menu.querySelectorAll('a').forEach(a =>
      a.addEventListener('click', () => menu.classList.remove('active'))
    );
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
    const lbl = document.getElementById('mobileThemeLabel');
    const icon = document.querySelector('#mobileThemeToggle i');
    if (lbl)  lbl.textContent  = theme === 'dark' ? 'Light Mode' : 'Dark Mode';
    if (icon) icon.className   = 'fas ' + (theme === 'dark' ? 'fa-sun' : 'fa-moon');
  }

  function wireTheme() {
    const saved = localStorage.getItem('theme') || 'dark';
    applyTheme(saved);
    const btn = document.getElementById('mobileThemeToggle');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const cur = document.documentElement.getAttribute('data-theme') || 'dark';
        applyTheme(cur === 'dark' ? 'light' : 'dark');
      });
    }
  }

  // -------- Notification badge (real-time) --------
  let notifUnsub = null;
  function setBadge(n) {
    const badge = document.getElementById('notifBadge');
    const mBadge = document.getElementById('mobileNotifBadge');
    const txt = n > 99 ? '99+' : String(n);
    [badge, mBadge].forEach(el => {
      if (!el) return;
      if (n > 0) {
        el.textContent = txt;
        el.style.display = 'inline-flex';
        el.classList.add('has-unread');
      } else {
        el.style.display = 'none';
        el.classList.remove('has-unread');
      }
    });
  }

  function subscribeNotifications(uid) {
    if (!uid || !window.firebase || !firebase.firestore) return;
    if (notifUnsub) { try { notifUnsub(); } catch (_) {} notifUnsub = null; }
    try {
      notifUnsub = firebase.firestore()
        .collection('notifications')
        .where('userId', '==', uid)
        .where('read', '==', false)
        .onSnapshot(
          (snap) => setBadge(snap.size),
          (err) => {
            // Fallback: missing composite index or rules — fetch once.
            console.warn('[notif] live count unavailable, falling back:', err.message);
            firebase.firestore().collection('notifications')
              .where('userId', '==', uid).limit(50).get()
              .then(s => {
                let n = 0; s.forEach(d => { if (d.data().read === false) n++; });
                setBadge(n);
              }).catch(()=>{});
          }
        );
    } catch (e) {
      console.warn('[notif] subscribe failed:', e.message);
    }
  }

  function preferredDisplay(el) {
    if (!el) return '';
    if (el.classList.contains('btn')) return 'inline-flex';
    if (
      el.classList.contains('icon-btn') ||
      el.classList.contains('avatar-btn') ||
      el.classList.contains('mobile-menu-link') ||
      el.classList.contains('mobile-menu-user') ||
      el.tagName === 'BUTTON'
    ) return 'flex';
    return '';
  }

  function setElementsVisible(selector, visible) {
    document.querySelectorAll(selector).forEach(el => {
      el.style.display = visible ? preferredDisplay(el) : 'none';
    });
  }

  function resolveCurrentUser() {
    try {
      return (window.Auth && typeof Auth.getUser === 'function' && Auth.getUser())
        || (window.Auth && Auth.currentUser)
        || (window.auth && auth.currentUser)
        || (window.firebase && firebase.auth && firebase.auth().currentUser)
        || null;
    } catch (_) {
      return null;
    }
  }

  async function resolveAdminState(user) {
    if (!user) return false;

    // Fast path: Auth module already cached userData
    try {
      const cachedRole = window.Auth?.userData?.role;
      if (cachedRole === 'admin' || cachedRole === 'moderator') return true;
    } catch (_) {}

    if (!window.db || !window.firebase || !firebase.firestore) return false;

    try {
      if (window.Auth) {
        if (user.uid === Auth.currentUser?.uid && typeof Auth.hasRole === 'function' && Auth.userData) {
          return Auth.hasRole('moderator');
        }
        if (typeof Auth.isAdmin === 'function') {
          return !!(await Auth.isAdmin(user.uid));
        }
      }
      const doc = await db.collection('users').doc(user.uid).get();
      const role = doc.data()?.role;
      return role === 'admin' || role === 'moderator';
    } catch (err) {
      console.warn('[shared-header] admin visibility fallback failed:', err?.message || err);
      return false;
    }
  }

  function wireAuthVisibility() {
    if (!window.firebase || !firebase.auth) return;

    const applyState = async (user) => {
      const resolvedUser = user || resolveCurrentUser();

      if (document.body) document.body.classList.add('auth-resolved');

      setElementsVisible('[data-auth-required]', !!resolvedUser);
      setElementsVisible('[data-auth-guest]', !resolvedUser);

      if (resolvedUser) {
        const avatarSrc = (window.Auth && typeof Auth.getUserData === 'function' && Auth.getUserData()?.avatar)
          || resolvedUser.photoURL
          || P('images/default-avatar.png');

        document.querySelectorAll('[data-user-avatar]').forEach(img => {
          img.src = avatarSrc;
        });

        const userData = (window.Auth && typeof Auth.getUserData === 'function')
          ? (Auth.getUserData() || {}) : {};
        const username = userData.username
          || userData.displayName
          || resolvedUser.displayName
          || (resolvedUser.email ? resolvedUser.email.split('@')[0] : 'User');
        document.querySelectorAll('[data-mobile-username]').forEach(el => {
          el.textContent = username;
        });

        const isAdmin = await resolveAdminState(resolvedUser);
        setElementsVisible('[data-admin-only]', isAdmin);
        subscribeNotifications(resolvedUser.uid);
      } else {
        setElementsVisible('[data-admin-only]', false);
        if (notifUnsub) { try { notifUnsub(); } catch(_) {} notifUnsub = null; }
        setBadge(0);
      }
    };

    try { applyState(resolveCurrentUser()); } catch(_) {}

    window.addEventListener('authStateChanged', (event) => {
      applyState(event?.detail?.user || resolveCurrentUser());
    });

    firebase.auth().onAuthStateChanged((user) => {
      applyState(user);
    });

    let retries = 0;
    const retryTimer = setInterval(() => {
      retries += 1;
      const user = resolveCurrentUser();
      // Keep polling for a couple of seconds so that admin/moderator
      // visibility is re-applied once Auth.userData finally loads
      // (it loads asynchronously after onAuthStateChanged fires).
      applyState(user);
      if (retries >= 25) {
        clearInterval(retryTimer);
      }
    }, 200);
  }

  // -------- Mount --------
  function mount() {
    const active = currentKey();

    // Replace (or create) the header
    let header = document.querySelector('header.header');
    if (!header) {
      header = document.createElement('header');
      header.className = 'header';
      document.body.insertBefore(header, document.body.firstChild);
    }
    header.innerHTML = headerHTML(active);

    // Replace (or create) the mobile menu
    let menu = document.querySelector('[data-mobile-menu]');
    if (!menu) {
      menu = document.createElement('div');
      menu.className = 'mobile-menu';
      menu.setAttribute('data-mobile-menu', '');
      header.parentNode.insertBefore(menu, header.nextSibling);
    }
    menu.innerHTML = mobileMenuHTML(active);

    wireMobileSearch();
    wireMobileMenu();
    wireTheme();
    wireAuthVisibility();

    // Re-run UI hooks that depend on the new markup
    if (window.UI) {
      try { UI.initSearch && UI.initSearch(); } catch(_) {}
      try { UI.initHeaderScroll && UI.initHeaderScroll(); } catch(_) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  // ============================================================
  // Global Auto-Sync bootstrap
  // ------------------------------------------------------------
  // Auto-Sync previously only ran on pages that explicitly loaded
  // series-sync.js (index.html + admin-import-series.html). The moment
  // the user navigated to Browse / Library / a chapter, the scheduler
  // unloaded and Auto-Sync silently stopped.
  //
  // Because shared-header.js is loaded on EVERY page, we use it as a
  // single bootstrap point: dynamically inject the source plugins,
  // series importer and series-sync scheduler on any page where they
  // aren't already loaded. SeriesSync.initFromStorage() then re-arms
  // the watchdog from localStorage, so auto-sync survives navigation,
  // refresh, login/logout, and tab restore.
  //
  // NOTE: Browsers cannot run JS while the tab is fully closed. For
  // true 24/7 background sync you need a server-side scheduler (e.g.
  // Firebase Cloud Functions with a pub/sub schedule, or any cron
  // service hitting a webhook). This bootstrap covers everything that
  // is technically possible from a static-hosted client app: as long
  // as at least one tab of the site is open in any state (foreground,
  // background, locked screen with the tab still alive), the sync
  // scheduler keeps ticking.
  // ============================================================
  function loadScriptOnce(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[data-autosync-src="${src}"]`) ||
          [...document.scripts].some(s => s.src && s.src.endsWith(src))) {
        return resolve();
      }
      const tag = document.createElement('script');
      tag.src = P(src);
      tag.async = false;          // preserve execution order
      tag.dataset.autosyncSrc = src;
      tag.onload  = () => resolve();
      tag.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.appendChild(tag);
    });
  }

  async function loadFirebaseSdks() {
    if (typeof firebase !== 'undefined' && firebase.firestore) return;
    const base = 'https://www.gstatic.com/firebasejs/10.7.1/';
    const needed = [
      'firebase-app-compat.js',
      'firebase-auth-compat.js',
      'firebase-firestore-compat.js'
    ];
    for (const f of needed) {
      await new Promise((resolve, reject) => {
        if ([...document.scripts].some(s => s.src && s.src.indexOf(f) !== -1)) return resolve();
        const tag = document.createElement('script');
        tag.src = base + f; tag.async = false;
        tag.onload = () => resolve();
        tag.onerror = () => reject(new Error('Failed to load ' + f));
        document.head.appendChild(tag);
      });
    }
  }

  async function bootAutoSync() {
    try {
      // Don't bother on auth pages — they have no Firebase context.
      const file = (location.pathname || '').split('/').pop() || '';
      if (file === 'login.html' || file === 'register.html') return;

      await loadFirebaseSdks();

      // Chain matters — dependencies first, sync scheduler last.
      const chain = [
        'js/path-utils.js',
        'js/firebase-config.js',
        'js/db.js',
        'js/source-config.js',
        'js/source-registry.js',
        'sources/source-template.js',
        'sources/source-vortexscans.js',
        'sources/source-hivetoons.js',
        'sources/source-roliascan.js',
        'sources/source-madarascans.js',
        'sources/source-utoon.js',
        'sources/source-violetscans.js',
        'sources/source-kingofshojo.js',
        'sources/source-templetoons.js',
        'sources/source-qimanga.js',
        'sources/source-mangakatana.js',
        'sources/source-genztoons.js',
        'sources/source-flamecomics.js',
        'sources/source-asurascans-series.js',
        'sources/source-vortexscans-series.js',
        'sources/source-hivetoons-series.js',
        'sources/source-roliascan-series.js',
        'sources/source-madarascans-series.js',
        'sources/source-utoon-series.js',
        'sources/source-genztoons-series.js',
        'sources/source-flamecomics-series.js',
        'js/series-importer.js',
        'js/series-sync.js'
      ];

      const results = {};
      for (const src of chain) {
        try {
          await loadScriptOnce(src);
          results[src] = 'ok';
        } catch (e) {
          results[src] = 'fail: ' + (e?.message || e);
          console.warn('[AutoSync bootstrap]', e.message);
        }
      }

      // series-sync.js auto-arms via DOMContentLoaded, but if the script
      // was injected after DOMContentLoaded fired we have to kick it
      // ourselves.
      if (window.SeriesSync && typeof SeriesSync.initFromStorage === 'function') {
        try { SeriesSync.initFromStorage(); } catch (e) { console.warn(e); }
      }

      // ---- Diagnostics: persist last bootstrap result so the sync page
      // can show "Last bootstrap" status even after a reload. ----
      try {
        const diag = {
          at: new Date().toISOString(),
          page: location.pathname,
          results,
          sources: (window.SourceRegistry?.getSources?.() || []).map(s => s.name),
          armed: !!(window.SeriesSync && SeriesSync.isAutoSyncOn?.())
        };
        localStorage.setItem('manhwa.syncDiag', JSON.stringify(diag));
        console.log('[AutoSync bootstrap] ready', diag);
      } catch {}
    } catch (e) {
      console.warn('[AutoSync bootstrap] aborted:', e.message);
      try { localStorage.setItem('manhwa.syncDiag',
        JSON.stringify({ at: new Date().toISOString(), page: location.pathname, error: e.message })); } catch {}
    }
  }

  // Defer until the page is idle so we don't compete with first paint.
  const startBoot = () => {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(bootAutoSync, { timeout: 3000 });
    } else {
      setTimeout(bootAutoSync, 1500);
    }
  };
  if (document.readyState === 'complete') startBoot();
  else window.addEventListener('load', startBoot);

  // Expose for manual refresh / debugging
  window.SharedHeader = {
    mount, setBadge, bootAutoSync,
    getDiagnostics() {
      try { return JSON.parse(localStorage.getItem('manhwa.syncDiag') || 'null'); }
      catch { return null; }
    }
  };

  // ============================================================
  // Auto-Sync STATUS INDICATOR + GLOBAL PROGRESS MODAL
  // ------------------------------------------------------------
  // Visible only to admins/moderators on every page. The indicator
  // chip is fixed bottom-right and reflects the live state of
  // SeriesSync (idle / running / completed / failed). When sync
  // starts importing chapters, a small floating progress card opens
  // automatically and shows which series + chapter is being synced.
  // Regular users never see either element.
  // ============================================================
  (function autoSyncStatusUI() {
    if (window.__mpAutoSyncUIInstalled) return;
    window.__mpAutoSyncUIInstalled = true;

    const CSS = `
      .mp-sync-chip{position:fixed;bottom:14px;right:14px;z-index:9998;
        display:none;align-items:center;gap:.5rem;padding:.5rem .75rem;
        border-radius:999px;background:rgba(15,18,30,.92);color:#fff;
        font:600 12px/1 Inter,system-ui,sans-serif;border:1px solid rgba(255,255,255,.12);
        box-shadow:0 6px 20px rgba(0,0,0,.35);cursor:pointer;backdrop-filter:blur(6px);}
      .mp-sync-chip .dot{width:8px;height:8px;border-radius:50%;background:#22c55e;
        box-shadow:0 0 0 0 rgba(34,197,94,.6);animation:mpPulse 1.8s infinite}
      .mp-sync-chip[data-state="off"] .dot{background:#64748b;animation:none}
      .mp-sync-chip[data-state="running"] .dot{background:#6366f1}
      .mp-sync-chip[data-state="failed"] .dot{background:#ef4444;animation:none}
      .mp-sync-chip[data-state="noNew"] .dot{background:#22c55e}
      @keyframes mpPulse{0%{box-shadow:0 0 0 0 rgba(99,102,241,.55)}
        70%{box-shadow:0 0 0 10px rgba(99,102,241,0)}100%{box-shadow:0 0 0 0 rgba(99,102,241,0)}}
      .mp-sync-modal{position:fixed;bottom:64px;right:14px;z-index:9999;
        width:min(360px,calc(100vw - 28px));max-height:60vh;overflow:hidden;
        display:none;flex-direction:column;border-radius:14px;background:rgba(15,18,30,.97);
        color:#fff;border:1px solid rgba(255,255,255,.12);box-shadow:0 16px 40px rgba(0,0,0,.45);
        font:500 13px/1.4 Inter,system-ui,sans-serif;backdrop-filter:blur(8px)}
      .mp-sync-modal.show{display:flex}
      .mp-sync-modal header{display:flex;align-items:center;justify-content:space-between;
        gap:.5rem;padding:.75rem .9rem;border-bottom:1px solid rgba(255,255,255,.08);
        font-weight:700;font-size:13px}
      .mp-sync-modal header button{background:transparent;border:0;color:#cbd5e1;
        font-size:18px;cursor:pointer;padding:0 4px;line-height:1}
      .mp-sync-modal .body{padding:.75rem .9rem;overflow:auto}
      .mp-sync-modal .row{display:flex;justify-content:space-between;gap:.5rem;margin:.15rem 0;
        color:#cbd5e1;font-size:12px}
      .mp-sync-modal .current{margin:.35rem 0 .5rem;color:#e2e8f0;font-weight:600}
      .mp-sync-modal .bar{height:6px;border-radius:999px;background:rgba(255,255,255,.08);overflow:hidden;margin:.4rem 0 .6rem}
      .mp-sync-modal .bar>span{display:block;height:100%;background:linear-gradient(90deg,#6366f1,#8b5cf6);width:0%;transition:width .3s}
      .mp-sync-modal .log{margin-top:.5rem;max-height:140px;overflow:auto;border-top:1px solid rgba(255,255,255,.08);padding-top:.4rem}
      .mp-sync-modal .log .e{font-size:11px;color:#94a3b8;margin:.1rem 0;white-space:pre-wrap}
      .mp-sync-modal .log .e.err{color:#fca5a5}
      .mp-sync-modal .log .e.ok{color:#86efac}
      .mp-sync-modal .log .e.warn{color:#fcd34d}
    `;

    function inject() {
      if (document.getElementById('mp-sync-style')) return;
      const s = document.createElement('style');
      s.id = 'mp-sync-style';
      s.textContent = CSS;
      document.head.appendChild(s);

      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'mp-sync-chip';
      chip.id = 'mpSyncChip';
      chip.setAttribute('data-state', 'off');
      chip.innerHTML = '<span class="dot"></span><span class="lbl">Auto-Sync</span>';
      document.body.appendChild(chip);

      const modal = document.createElement('div');
      modal.className = 'mp-sync-modal';
      modal.id = 'mpSyncModal';
      modal.innerHTML = `
        <header>
          <span><i class="fas fa-sync"></i> Auto-Sync Progress</span>
          <button type="button" id="mpSyncClose" aria-label="Close">×</button>
        </header>
        <div class="body">
          <div class="current" id="mpSyncCurrent">Idle</div>
          <div class="bar"><span id="mpSyncBar"></span></div>
          <div class="row"><span>Series</span><span id="mpSyncSeries">0 / 0</span></div>
          <div class="row"><span>Imported</span><span id="mpSyncImp">0</span></div>
          <div class="row"><span>Failed</span><span id="mpSyncFail">0</span></div>
          <div class="log" id="mpSyncLog"></div>
        </div>`;
      document.body.appendChild(modal);

      chip.addEventListener('click', () => {
        // Manual chip click = user wants to see it; clear the dismissal flag.
        userClosed = false;
        try { localStorage.removeItem(DISMISS_KEY); } catch (_) {}
        modal.classList.toggle('show');
      });
      modal.querySelector('#mpSyncClose').addEventListener('click', () => {
        // User explicitly closed — remember it (keyed to the current run's
        // startedAt) so the modal stays closed across page navigation,
        // refresh, and rehydrate polls. It only re-opens when a brand-new
        // sync run begins (different startedAt) or the user clicks the chip.
        userClosed = true;
        try {
          const pg = window.SeriesSync?.getProgress?.();
          const startedAt = (pg && pg.startedAt) ? pg.startedAt : Date.now();
          localStorage.setItem(DISMISS_KEY, String(startedAt));
        } catch (_) {}
        modal.classList.remove('show');
      });
    }

    // Persist the user's "close" decision across page navigation so the
    // modal does NOT immediately re-open after rehydrate sees an active run.
    const DISMISS_KEY = 'mp_sync_modal_dismissed_at';
    let visible = false;
    let userClosed = false; // user dismissed the modal; suppress auto-reopen
    let totalSeries = 0, doneSeries = 0, impTotal = 0, failTotal = 0;

    // Restore dismissal state from storage relative to the current run.
    function syncDismissFlag() {
      try {
        const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
        if (!dismissedAt) { userClosed = false; return; }
        const pg = window.SeriesSync?.getProgress?.();
        const startedAt = (pg && pg.startedAt) ? pg.startedAt : 0;
        // If the dismissal is for THIS run (or there is no newer run),
        // keep the modal closed. A new run (startedAt > dismissedAt)
        // clears the dismissal automatically.
        if (startedAt && startedAt > dismissedAt) {
          userClosed = false;
          try { localStorage.removeItem(DISMISS_KEY); } catch (_) {}
        } else {
          userClosed = true;
        }
      } catch (_) {}
    }

    function setChip(state, label) {
      const chip = document.getElementById('mpSyncChip');
      if (!chip) return;
      chip.setAttribute('data-state', state);
      chip.querySelector('.lbl').textContent = label;
      chip.style.display = visible ? 'inline-flex' : 'none';
    }
    function setModalShown(show) {
      const m = document.getElementById('mpSyncModal');
      if (!m) return;
      if (show) {
        syncDismissFlag();
        if (userClosed) return; // respect user's dismissal across pages
        m.classList.add('show');
      } else {
        m.classList.remove('show');
      }
    }
    function setCurrent(text) {
      const el = document.getElementById('mpSyncCurrent'); if (el) el.textContent = text;
    }
    function updateCounters() {
      const total = totalSeries || 0;
      const pct = total ? Math.round((doneSeries / total) * 100) : 0;
      const bar = document.getElementById('mpSyncBar'); if (bar) bar.style.width = pct + '%';
      const s = document.getElementById('mpSyncSeries'); if (s) s.textContent = `${doneSeries} / ${total}`;
      const i = document.getElementById('mpSyncImp'); if (i) i.textContent = String(impTotal);
      const f = document.getElementById('mpSyncFail'); if (f) f.textContent = String(failTotal);
    }
    function logLine(text, cls) {
      const log = document.getElementById('mpSyncLog'); if (!log) return;
      const e = document.createElement('div');
      e.className = 'e' + (cls ? ' ' + cls : '');
      e.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
      log.insertBefore(e, log.firstChild);
      while (log.children.length > 60) log.removeChild(log.lastChild);
    }

    function wireEvents() {
      if (!window.SeriesSync) return false;
      if (window.__mpSyncUIWired) return true;
      window.__mpSyncUIWired = true;

      const refreshChipFromConfig = () => {
        const info = SeriesSync.getAutoSyncInfo?.() || {};
        if (info.enabled) {
          setChip(info.running ? 'running' : 'on',
            info.running ? 'Auto-Sync: Running' : 'Auto-Sync: Active');
        } else {
          setChip('off', 'Auto-Sync: Off');
        }
      };
      refreshChipFromConfig();
      setInterval(refreshChipFromConfig, 5000);

      // ---- Rehydrate live progress from persisted state ----
      // So that navigating between pages NEVER resets the visible
      // "Series 18 / 86" counter — it always reflects the global run.
      const rehydrateFromStorage = () => {
        try {
          const pg = SeriesSync.getProgress?.();
          if (!pg) return;
          totalSeries = pg.total || 0;
          doneSeries  = pg.done  || 0;
          impTotal    = pg.imported || 0;
          failTotal   = pg.failed   || 0;
          updateCounters();
          if (pg.active) {
            setCurrent(pg.currentTitle ? ('Syncing: ' + pg.currentTitle) : 'Syncing…');
            setModalShown(true);
            setChip('running', 'Auto-Sync: Running');
          } else if (pg.finishedAt) {
            setCurrent(`Sync complete — ${impTotal} new chapter(s), ${failTotal} failed`);
          }
        } catch (_) {}
      };
      rehydrateFromStorage();
      // Poll storage too — covers tabs where BroadcastChannel isn't available.
      setInterval(rehydrateFromStorage, 2000);
      window.addEventListener('storage', (e) => {
        if (e && (e.key === 'mp_series_sync_progress' ||
                  e.key === 'mp_series_sync_config')) {
          rehydrateFromStorage();
          refreshChipFromConfig();
        }
      });

      SeriesSync.on('syncAllStart', (p) => {
        totalSeries = p?.total || 0; doneSeries = 0; impTotal = 0; failTotal = 0;
        userClosed = false; // new run — allow auto-open again
        setCurrent('Starting sync…'); updateCounters();
        setModalShown(true);
        setChip('running', 'Auto-Sync: Running');
        logLine(`Sync started across ${totalSeries} series`, 'ok');
      });
      SeriesSync.on('syncStart', (p) => {
        setCurrent(`Syncing: ${p?.title || '…'}`);
      });
      SeriesSync.on('syncDone', (p) => {
        doneSeries += 1;
        impTotal += (p?.imported || 0);
        failTotal += (p?.failed || 0);
        updateCounters();
        if ((p?.imported || 0) > 0) {
          setModalShown(true);
          logLine(`${p.title}: imported ${p.imported} new chapter(s)`, 'ok');
        } else if ((p?.failed || 0) > 0) {
          logLine(`${p.title}: ${p.failed} failed`, 'warn');
        }
      });
      SeriesSync.on('syncError', (p) => {
        failTotal += 1; updateCounters();
        setModalShown(true);
        logLine(`${p?.title || 'Series'}: ${p?.error || 'error'}`, 'err');
      });
      SeriesSync.on('syncAllDone', () => {
        setCurrent(`Sync complete — ${impTotal} new chapter(s), ${failTotal} failed`);
        setChip(failTotal > 0 ? 'failed' : 'noNew',
          failTotal > 0 ? 'Auto-Sync: Issues' : 'Auto-Sync: Done');
        logLine(`Run finished: ${impTotal} imported, ${failTotal} failed`,
          failTotal > 0 ? 'warn' : 'ok');
        setTimeout(refreshChipFromConfig, 6000);
      });
      SeriesSync.on('status', (p) => {
        if (p?.state === 'failed') setChip('failed', 'Auto-Sync: Failed');
      });

      // Cross-tab — other tabs broadcasting sync events
      try {
        if ('BroadcastChannel' in window) {
          const bc = new BroadcastChannel('mp_series_sync');
          bc.addEventListener('message', (ev) => {
            const d = ev.data || {};
            if (d.type !== 'mp-sync-event') return;
            if (d.event === 'syncAllStart') {
              totalSeries = d.payload?.total || 0; doneSeries = 0; impTotal = 0; failTotal = 0;
              userClosed = false;
              setCurrent('Syncing (other tab)…'); updateCounters(); setModalShown(true);
              setChip('running', 'Auto-Sync: Running');
            } else if (d.event === 'syncDone') {
              doneSeries += 1;
              impTotal += (d.payload?.imported || 0);
              failTotal += (d.payload?.failed || 0);
              updateCounters();
            } else if (d.event === 'syncStart') {
              setCurrent(`Syncing: ${d.payload?.title || '…'}`);
            } else if (d.event === 'syncAllDone') {
              setCurrent(`Sync complete — ${impTotal} new, ${failTotal} failed`);
              setChip(failTotal > 0 ? 'failed' : 'noNew',
                failTotal > 0 ? 'Auto-Sync: Issues' : 'Auto-Sync: Done');
            }
          });
        }
      } catch (_) {}
      return true;
    }

    async function showForAdmins() {
      try {
        if (!window.firebase || !firebase.auth) return;
        const user = (firebase.auth().currentUser) || await new Promise((res) => {
          const off = firebase.auth().onAuthStateChanged((u) => { try { off(); } catch(_){} res(u); });
        });
        if (!user) { visible = false; return; }
        let role = window.Auth?.userData?.role;
        if (!role && window.firebase && firebase.firestore) {
          try {
            const snap = await firebase.firestore().collection('users').doc(user.uid).get();
            role = snap.exists ? snap.data().role : null;
          } catch (_) {}
        }
        visible = (role === 'admin' || role === 'moderator');
        if (!visible) return;
        inject();
        // Wait briefly for SeriesSync to load (shared-header bootstraps it).
        let tries = 0;
        const armWhenReady = () => {
          if (wireEvents()) return;
          if (tries++ < 60) setTimeout(armWhenReady, 500);
        };
        armWhenReady();
      } catch (e) { console.warn('[mp-sync-ui]', e); }
    }

    if (document.readyState === 'complete') setTimeout(showForAdmins, 800);
    else window.addEventListener('load', () => setTimeout(showForAdmins, 800));
    window.addEventListener('authStateChanged', () => setTimeout(showForAdmins, 300));
  })();
})();
