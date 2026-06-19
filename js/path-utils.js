/*
 * AppPath keeps internal links working whether the app is served from a domain
 * root, a nested folder, or opened directly from the file system.
 */
(function () {
  function getPrefix() {
    const path = window.location.pathname || '';
    const file = path.split('/').pop() || '';
    const inPagesFolder = /\/pages\//.test(path) || (
      path.includes('/pages/') ||
      ['about.html', 'admin.html', 'browse.html', 'chapter.html', 'history.html', 'library.html', 'login.html', 'notifications.html', 'profile.html', 'register.html', 'series.html', 'settings.html'].includes(file)
    );
    return inPagesFolder ? '../' : './';
  }

  function normalize(path) {
    if (!path || path === '#') return path;
    if (/^(https?:|mailto:|tel:|data:|blob:|javascript:)/i.test(path)) return path;

    let clean = String(path).trim();
    if (clean === '/') return getPrefix() + 'index.html';
    clean = clean.replace(/^\/+/, '');
    if (clean === '') return getPrefix() + 'index.html';

    return getPrefix() + clean;
  }

  function page(path) {
    const clean = String(path || '').replace(/^\/+/, '').replace(/^pages\//, '');
    return normalize('pages/' + clean);
  }

  window.AppPath = {
    prefix: getPrefix,
    to: normalize,
    page,
    home: function () { return normalize('/'); },
    asset: normalize
  };
})();
