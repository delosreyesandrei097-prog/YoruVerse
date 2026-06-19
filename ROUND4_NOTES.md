# Round 4 — Auto-Sync reliability & log accuracy

Only the sync subsystem was touched. No changes to the store, the
importer, source plugins, Firestore rules, or unrelated UI.

## Files changed
- `js/series-sync.js`
- `js/import-series-page.js`
- `sw.js`

## What was wrong
1. **Auto-sync stopped while the tab was closed.** The watchdog only runs
   inside an open page. After a reload it was re-armed but never fired a
   *catch-up* run if the next sync was already overdue, so the UI showed a
   stale "last run" (your screenshot: last run 6:05 PM, current time 9:48 PM).
2. **Cross-tab lock could get stuck for 15 minutes.** If a tab was killed
   mid-run, the old lock silently turned every "Sync All Series Now" click
   into `Sync skipped — another tab/run is already in progress`.
3. **"0 series / 0 chapters" log was misleading.** The summary was logged
   at SUCCESS level even when imports failed (your screenshot actually
   had `imported 0, failed 14` for that run). Per-series failures didn't
   include the source plugin or a usable error reason.

## What changed
### `js/series-sync.js`
- `initFromStorage()` now runs an immediate catch-up `syncAll()` if the
  next run was already overdue when the page loaded.
- Cross-tab lock uses a heartbeat (`mp_series_sync_lock` JSON with a
  `heartbeat` timestamp refreshed every 5 s). A lock with no heartbeat
  in the last 12 s is considered abandoned and reclaimed — and the
  takeover is logged.
- Final summary log level reflects reality: `success` when nothing failed,
  `warn` when some imports succeeded, `error` when everything failed.
- Per-series failure logs now include `[<source>]` and a truncated
  reason, e.g. `Sync failed: My Series [asurascans.com] — HTTP 503`.
- Stats now expose `lastErrors: [{ seriesId, title, source, error, at }]`
  (last 20) so the UI can show failures without console access.
- Opportunistic upgrade: when a Service Worker controls the page, the
  page asks it to register Periodic Background Sync. The SW posts
  `mp-run-sync-all` back to clients, which trigger `syncAll()`. Browsers
  without periodicSync support are unaffected.

### `js/import-series-page.js`
- Renders the new `lastErrors` list right under the Sync stats card,
  styled with the existing `.log-error` class.
- Auto-opens the "Sync Logs" disclosure when the latest run produced any
  error/warn entries — until the user manually toggles it.

### `sw.js`
- Appended a `message` listener for `mp-register-periodic-sync`.
- Added a `periodicsync` handler that pings every open client with
  `{ type: 'mp-run-sync-all' }` so `SeriesSync.syncAll()` runs.

## Known limitation
No in-browser sync can run while **every** tab is fully closed unless
Periodic Background Sync is available (Chrome/Edge on Android, app
installed as a PWA, site engagement score met). On other browsers the
catch-up run on load is the strongest available guarantee. For truly
unattended sync on a schedule, run `SeriesSync.syncAll()` from a server
cron / Cloud Function instead — out of scope for this round.
