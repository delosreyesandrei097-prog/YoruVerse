# Firestore Security & Data-Protection Improvements

Surgical changes only. No unrelated code was touched.

## Files changed
1. `firestore.rules`
2. `js/db.js`

## 1. `firestore.rules`
- **Chapter hard-delete restricted to Admins** (was admin OR moderator).
  Moderators must now go through admin-managed delete tooling, which
  archives to `trash` first.
- **New collection `trash/{trashId}`** — soft-delete backup store.
  - `read` / `delete`: Admin only
  - `create`: any authenticated user, but must stamp
    `deletedBy == request.auth.uid`
  - `update`: forbidden (immutable snapshots)
- **New collection `auditLog/{logId}`** — append-only audit trail of
  every delete and restore.
  - `read`: moderators+
  - `create`: any authenticated user, must stamp
    `actorId == request.auth.uid`
  - `update` / `delete`: forbidden

All other existing rules (users, series, chapters, comments,
notifications, reviews, reports, ratings, genres, meta,
userWarnings, etc.) are unchanged.

## 2. `js/db.js`

### New helpers (data-protection core)
- `_archiveBeforeDelete(collection, docId, opts)` — snapshots the
  document into `trash/{collection}_{docId}_{timestamp}` and writes
  an entry to `auditLog`. **If the backup write fails, the calling
  delete operation is aborted** — this is the central safeguard
  against accidental data loss.
- `restoreFromTrash(trashId)` — admin recovery API. Rewrites the
  archived data back to its original collection / id (merged, so it
  never overwrites a newer version destructively), logs the restore
  to `auditLog`, then removes the trash entry.

### Hardened destructive operations
Every delete in this module now archives first:
- `deleteSeries` — archives the series + every cascading chapter
  before the batched delete. If even one archive fails, the entire
  cascade aborts.
- `deleteChapter`
- `deleteComment` (parent + every reply)
- `deleteNotification`
- `deleteNotifications` (bulk; per-id backup)
- `deleteReview`
- `removeWarning`

### Import-safety validation
- `addChapter` now refuses payloads that:
  - aren’t an object,
  - lack a string `seriesId`,
  - lack a valid numeric `chapterNumber`,
  - reference a `seriesId` that does **not** exist in the `series`
    collection.

  This stops failed imports / corrupted Auto-Sync payloads from
  silently creating orphan chapters (a known source of
  "disappearing" content).

## Auto-Sync safety (already in place, retained)
- Sync code uses `update()` and `add()` only — never `.set()`
  without `{ merge: true }`, so existing series/chapter docs cannot
  be overwritten or wiped by a sync run.
- Sync skips when no `sourceUrl` is present and respects the
  `isSyncableStatus` filter.
- `addChapter`’s series-bump now also benefits from the new
  parent-exists check, so a stale sync payload pointing at a
  removed series will hard-fail instead of writing junk.

## What this gives you
- **No silent data loss.** Every delete leaves a recoverable backup
  in `trash` plus an `auditLog` row identifying the actor.
- **Recovery path.** `DB.restoreFromTrash(trashId)` brings any
  archived document back to its original collection.
- **Stricter delete authority.** Chapter hard-deletes are
  admin-only at the rules layer.
- **Import integrity.** Chapter writes are validated and tied to an
  existing series before being persisted.

## Required follow-up (one-time, in Firebase Console)
Composite indexes on the new collections are not required (queries
are by-id only). Optional index for moderation tooling:
- `auditLog`: `collection ASC, createdAt DESC`
- `trash`: `sourceCollection ASC, deletedAt DESC`
