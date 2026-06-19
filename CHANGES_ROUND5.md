# Round 5 — Browse, Library, Search, Hero Slider, Favorites

## Browse page (pages/browse.html)
- New sticky, glass-blur filter toolbar (`.browse-toolbar`) — cleaner
  alignment, equal-width selects, and a 2-col mobile / 4-col desktop grid.
- Reduced search debounce from 400ms → 80ms (now hits the in-memory cache,
  so keystrokes feel instant and don't hammer Firestore).

## Library page (pages/library.html)
- Tabs now support deep linking: `library.html#favorites`,
  `library.html#following`, `library.html#continue`. The URL updates as you
  switch tabs and is honored on reload.
- Tabs scroll horizontally on small screens with pill styling; chapter rows
  and grids tightened on phones (less empty space, smoother scroll).

## Favorites page removed (pages/favorites.html)
- `favorites.html` is now a `<meta refresh>` + JS redirect to
  `library.html#favorites`. Any old bookmark still works.
- Every link / mobile-menu entry across the site (about, history, library,
  notifications, profile, series, settings, index, shared-header) now points
  at `library.html#favorites`.
- All favorite functionality continues to live inside the Library page's
  "Favorites" tab — no behavior change for users.

## Search optimisation (js/db.js + js/ui.js)
- New `DB.searchSeries(query, limit)`:
  - Builds a single in-memory index of up to 500 recently-updated series
    cached for 5 minutes.
  - Every keystroke is a synchronous, tokenised substring match against
    the index — **zero Firestore reads per keystroke** after the first
    cache fill.
- Global search bar (`js/ui.js`) debounce dropped from 120ms → 60ms and
  now calls `DB.searchSeries` for instant results.
- Browse page also benefits via the same cache (debounce 80ms).

## Hero slider (js/db.js getTrendingSeries + index.html)
- The hero slider now showcases real trending series:
  - Pulls a 60-item pool, scored by views, follows, favorites, reads,
    rating count, average rating, and recency.
  - The top slice is shuffled with a 10-minute time bucket so featured
    series rotate automatically without anyone touching the database.
  - Pool cached in memory for 5 minutes to cut Firestore reads.
- `index.html` consumes the same `DB.getTrendingSeries(7)` call, so no
  template changes were needed there.

## CSS additions (css/main.css)
- `.browse-toolbar`, mobile-tuned `.series-grid`, scrollable pill `.tabs`,
  tighter `.chapter-row` paddings on phones.
- `content-visibility: auto` on `.series-grid` for smoother long-grid
  scrolling.

No other files were modified.
