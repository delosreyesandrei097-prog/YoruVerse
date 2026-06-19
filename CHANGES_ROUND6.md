# Round 6 — Genre auto-discovery, view-count dedup, menu cleanup

Only the three requested issues were touched. No other behavior changed.

## 1. Browse genre filter updates automatically

`js/db.js`
- New helper `DB._ensureGenresExist(names)` slugifies each genre name and
  creates a doc in the `genres` collection if one is missing. Safe to call
  with empty / null input.
- `DB.addSeries()` and `DB.updateSeries()` now call `_ensureGenresExist`
  with the series' `genres` array so any new tag (e.g. "Shounen") shows up
  in the Browse filter immediately, without manual seeding.
- `DB.getGenres()` now also scans existing series (uses the warm
  search-index cache when available, otherwise reads up to 500 series once)
  and merges any unique genre names with the curated defaults and the
  Firestore collection. Newly discovered names are persisted back to the
  `genres` collection in the background so subsequent loads are free.

`firestore.rules`
- `/genres/{genreId}` now permits `create` for any authenticated user (so
  the auto-registration above works from Admin/Moderator/User tabs).
  Updates and deletes remain admin-only to protect the taxonomy.

Result: any genre typed onto a Manhwa instantly becomes a Browse filter
option — no admin action required.

## 2. View counter — one view per user per series

`js/db.js` — `DB.incrementViewCount(seriesId)`
- Authenticated users: writes a marker document at
  `seriesViews/{uid}_{seriesId}`. If the marker already exists the
  function returns without touching the counter, so revisits never
  re-increment.
- Unauthenticated visitors: a `localStorage` guard
  (`seriesViewed:<seriesId>`) prevents the counter from inflating on
  refresh.
- If recording the marker fails (rules / network), the counter is **not**
  incremented — preventing silent over-counting.

`firestore.rules`
- New `/seriesViews/{viewId}` collection: each user may create exactly one
  doc per series (id format enforced as `${uid}_${seriesId}`) and may read
  only their own markers. Updates and deletes are forbidden so the record
  is permanent.

## 3. Removed "Favorites" from the mobile/toggle menu

Favorites already live inside the Library page (`library.html#favorites`),
so the duplicate link in the slide-out mobile menu was redundant.

Removed the `library.html#favorites` mobile-menu-link entry from:

- `js/shared-header.js`
- `index.html`
- `pages/about.html`
- `pages/history.html`
- `pages/library.html`
- `pages/notifications.html`
- `pages/profile.html`
- `pages/series.html`
- `pages/settings.html`

The `pages/favorites.html` redirect stub is intentionally left in place so
any old bookmarks/links still resolve to `library.html#favorites`.
