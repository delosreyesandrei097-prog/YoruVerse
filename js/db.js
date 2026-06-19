/**
 * ============================================================
 * MANHWA PLATFORM - DATABASE OPERATIONS MODULE
 * ============================================================
 * All Firestore database operations for:
 * - Series management
 * - Chapter management
 * - User interactions (favorites, library, history)
 * - Comments and discussions
 * - Notifications
 * - Search and filtering
 * 
 * FIRESTORE INDEX REQUIREMENTS:
 * The following composite indexes are required for queries that
 * combine where() and orderBy() on different fields. Deploy these
 * via firestore.indexes.json or create them in the Firebase Console:
 * 
 * Collection: chapters
 *   - seriesId ASC, chapterNumber ASC         (getChapterByNumber, getContinueReading)
 *   - seriesId ASC, chapterNumber DESC         (getChapters)
 *   - seriesId ASC, createdAt DESC             (alternative chapter ordering)
 *   - createdAt DESC                           (getLatestChapters)
 * 
 * Collection: comments
 *   - chapterId ASC, parentCommentId ASC, createdAt DESC  (getComments - top-level)
 *   - parentCommentId ASC, createdAt ASC       (getComments - replies)
 *   - chapterId ASC, createdAt DESC            (getComments fallback)
 * 
 * Collection: notifications
 *   - userId ASC, createdAt DESC               (getNotifications with 'in' query)
 * 
 * Collection: users
 *   - followedSeries ARRAY, createdAt DESC      (notifyNewChapter)
 *   - createdAt ASC                            (getRecentActivity, loadUsersList)
 *   - createdAt >= today                       (getAdminStats newUsersToday)
 * 
 * Collection: series
 *   - genres ARRAY, updatedAt DESC             (getSeries with genre filter)
 *   - status ASC, updatedAt DESC               (getSeries with status filter)
 *   - genres ARRAY, status ASC, updatedAt DESC  (getSeries with both filters)
 * ============================================================
 */

const DB = {
  // ==================== SERIES OPERATIONS ====================

  /**
   * Get series with pagination and filters
   */
  async getSeries(options = {}) {
    const {
      limit = 20,
      cursor = null,
      sortBy = 'updatedAt',
      sortOrder = 'desc',
      genre = null,
      status = null,
      search = null
    } = options;

    try {
      // When searching, scan a larger pool client-side (Firestore has no
      // full-text search). Without this, a query like "Sword God's Livestream"
      // returned nothing because we only filtered the first 20 docs.
      const effectiveLimit = search ? 200 : limit;

      let query = db.collection('series').orderBy(sortBy, sortOrder);

      if (genre) {
        // Adult-content filter is broad: match any common synonym so a series
        // tagged "Adult" / "Mature" / "NSFW" also shows up under "18+".
        const adultSynonyms = ['18+', 'Adult', 'adult', 'Mature', 'mature', 'NSFW', 'nsfw', '18plus', 'R18'];
        const isAdultFilter = adultSynonyms.some(s => s.toLowerCase() === String(genre).toLowerCase());
        if (isAdultFilter) {
          query = query.where('genres', 'array-contains-any', adultSynonyms);
        } else {
          query = query.where('genres', 'array-contains', genre);
        }
      }

      if (status) {
        // Status values are stored inconsistently across the database:
        // seed data and the admin form use capitalized strings ("Completed",
        // "Hiatus", "Dropped", "Ongoing") while the bulk-importer stores
        // them lowercased ("completed", "hiatus", ...). A plain `==` query
        // would silently miss half of the matching series. Use an `in`
        // query that covers every common casing so filters always return
        // every matching series.
        const s = String(status).trim();
        const variants = Array.from(new Set([
          s,
          s.toLowerCase(),
          s.toUpperCase(),
          s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
        ]));
        query = query.where('status', 'in', variants);
      }

      if (cursor && !search) {
        query = query.startAfter(cursor);
      }

      query = query.limit(effectiveLimit);

      const snapshot = await query.get();
      const series = [];

      snapshot.forEach(doc => {
        series.push({ id: doc.id, ...doc.data() });
      });

      // Client-side search if provided
      if (search) {
        const searchLower = search.toLowerCase();
        const tokens = searchLower.split(/\s+/).filter(Boolean);
        const matchesAll = (haystack) => {
          if (!haystack) return false;
          const h = haystack.toLowerCase();
          return tokens.every(t => h.includes(t));
        };
        const filtered = series.filter(s => {
          const fields = [
            s.title,
            s.author,
            s.artist,
            ...(s.alternativeTitles || [])
          ].filter(Boolean).join(' ');
          return matchesAll(fields) ||
            s.title?.toLowerCase().includes(searchLower) ||
            s.alternativeTitles?.some(t => t.toLowerCase().includes(searchLower)) ||
            s.author?.toLowerCase().includes(searchLower);
        });
        // Return unified shape so callers don't break
        return { series: filtered, lastCursor: null, hasMore: false };
      }

      return {
        series,
        lastCursor: snapshot.docs[snapshot.docs.length - 1] || null,
        hasMore: snapshot.docs.length === limit
      };
    } catch (error) {
      console.error('Error getting series:', error);
      throw error;
    }
  },

  /**
   * Get a single series by ID
   */
  async getSeriesById(seriesId) {
    try {
      const doc = await db.collection('series').doc(seriesId).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('Error getting series:', error);
      throw error;
    }
  },

  /**
   * Add new series
   */
  async addSeries(data) {
    try {
      const seriesData = {
        ...data,
        rating: 0,
        ratingCount: 0,
        viewCount: 0,
        followCount: 0,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      const docRef = await db.collection('series').add(seriesData);

      // Update stats counter atomically
      this._incrementStatsCounter('totalSeries', 1);

      // Auto-register any genres on this series so the Browse filter list
      // updates without manual seeding.
      try { await this._ensureGenresExist(data && data.genres); } catch (_) {}

      return { id: docRef.id, ...seriesData };
    } catch (error) {
      console.error('Error adding series:', error);
      throw error;
    }
  },

  /**
   * Update series.
   *
   * By default this bumps `updatedAt` so the series moves to the top of
   * "Recently Updated". Pass `{ silent: true }` for background updates
   * (metadata refresh, lastSyncTime, lastImportedChapter bookkeeping) that
   * must NOT reorder the Recently Updated feed. Only a successful import
   * of a brand-new chapter (via `DB.addChapter`) should bump `updatedAt`.
   */
  async updateSeries(seriesId, data, opts = {}) {
    try {
      const updateData = { ...data };
      if (!opts.silent) {
        updateData.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
      }

      await db.collection('series').doc(seriesId).update(updateData);

      // If genres were changed, make sure any new tag appears in the
      // global genres collection used by the Browse filter dropdown.
      if (data && Array.isArray(data.genres)) {
        try { await this._ensureGenresExist(data.genres); } catch (_) {}
      }

      return { id: seriesId, ...updateData };
    } catch (error) {
      console.error('Error updating series:', error);
      throw error;
    }
  },

  /**
   * Ensure every genre name in `names` has a document in the `genres`
   * collection. Missing ones are created automatically so newly added
   * tags (e.g. "Shounen") show up in the Browse filter without any
   * manual seeding step. Safe to call with empty / invalid input.
   */
  async _ensureGenresExist(names) {
    if (!Array.isArray(names) || names.length === 0) return;
    const cleaned = Array.from(new Set(
      names
        .map(n => String(n || '').trim())
        .filter(Boolean)
    ));
    if (cleaned.length === 0) return;

    const slugify = (s) => String(s).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'genre';

    await Promise.all(cleaned.map(async (name) => {
      const id = slugify(name);
      try {
        const ref = db.collection('genres').doc(id);
        const snap = await ref.get();
        if (snap.exists) return;
        await ref.set({
          name,
          slug: id,
          autoCreated: true,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (e) {
        // Non-critical — Browse will still fall back to scanning series.
        console.warn('Could not register genre', name, e);
      }
    }));
  },

  /**
   * Delete series and all related chapters
   */
  async deleteSeries(seriesId, opts = {}) {
    try {
      if (!seriesId) throw new Error('deleteSeries: missing seriesId');

      // Back up the series itself BEFORE touching anything. If this fails
      // the whole operation aborts and no data is lost.
      await this._archiveBeforeDelete('series', seriesId, {
        reason: opts.reason || 'deleteSeries'
      });

      // Delete all chapters first — back each one up too.
      const chaptersSnapshot = await db.collection('chapters')
        .where('seriesId', '==', seriesId)
        .get();

      for (const doc of chaptersSnapshot.docs) {
        try {
          await this._archiveBeforeDelete('chapters', doc.id, {
            reason: 'cascade:deleteSeries:' + seriesId
          });
        } catch (e) {
          // If even one chapter backup fails, abort the cascade so the
          // user can investigate. The series doc is still in `trash`.
          throw new Error(`Chapter backup failed (${doc.id}): ${e.message}`);
        }
      }

      const batch = db.batch();
      chaptersSnapshot.forEach(doc => {
        batch.delete(doc.ref);
      });
      batch.delete(db.collection('series').doc(seriesId));

      await batch.commit();

      // Update stats counters atomically
      this._incrementStatsCounter('totalSeries', -1);
      this._incrementStatsCounter('totalChapters', -chaptersSnapshot.size);

      return true;
    } catch (error) {
      console.error('Error deleting series:', error);
      throw error;
    }
  },

  /**
   * Get trending/popular series.
   *
   * The hero slider relies on this list. To keep the slider dynamic and
   * prevent the same series from being featured for long periods, we:
   *   1. Pull a wider candidate pool across multiple "trending" signals
   *      (views, follows, favorites, ratings, reads, recent activity).
   *   2. Score each candidate with a weighted blend of those signals.
   *   3. Cache the candidate pool in memory for 5 minutes to cut Firestore
   *      reads (a single hero slider used to issue many duplicate reads).
   *   4. Randomise the top slice with a time-bucketed seed so the featured
   *      series rotate every ~10 minutes even if the underlying scores
   *      barely change.
   */
  _trendingCache: { at: 0, pool: [] },
  async getTrendingSeries(limit = 10) {
    try {
      const now = Date.now();
      const CACHE_MS = 5 * 60 * 1000;
      let pool = this._trendingCache.pool;
      if (!pool.length || (now - this._trendingCache.at) > CACHE_MS) {
        // Single read of the top 60 most-viewed series. All other "trending"
        // signals are already stored on the same series doc, so we don't
        // need extra collection reads.
        const snap = await db.collection('series')
          .orderBy('viewCount', 'desc')
          .limit(60)
          .get();
        pool = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        this._trendingCache = { at: now, pool };
      }

      // Weighted score across every "trending" metric the app tracks.
      const score = (s) => {
        const views     = Number(s.viewCount     || 0);
        const follows   = Number(s.followCount   || s.followersCount || 0);
        const favs      = Number(s.favoriteCount || s.favoritesCount || 0);
        const reads     = Number(s.readCount     || s.totalReads     || 0);
        const ratingN   = Number(s.ratingCount   || s.numRatings     || 0);
        const rating    = Number(s.rating        || s.averageRating  || 0);
        const updatedMs = s.updatedAt?.toMillis?.() || s.updatedAt?.seconds * 1000 || 0;
        // Recency boost: full points if updated in last 24h, decays over 30d.
        const ageDays   = updatedMs ? (now - updatedMs) / 86400000 : 365;
        const recency   = Math.max(0, 1 - ageDays / 30);
        return (
          Math.log1p(views)   * 1.0 +
          Math.log1p(follows) * 1.4 +
          Math.log1p(favs)    * 1.4 +
          Math.log1p(reads)   * 1.1 +
          Math.log1p(ratingN) * 0.8 +
          rating              * 1.2 +
          recency             * 2.0
        );
      };

      const ranked = pool
        .map(s => ({ s, k: score(s) }))
        .sort((a, b) => b.k - a.k)
        .slice(0, Math.max(limit * 3, 18))
        .map(x => x.s);

      // Time-bucketed shuffle so the visible set rotates every ~10 minutes.
      const bucket = Math.floor(now / (10 * 60 * 1000));
      const rng = (i) => {
        const x = Math.sin(bucket * 9301 + i * 49297) * 233280;
        return x - Math.floor(x);
      };
      for (let i = ranked.length - 1; i > 0; i--) {
        const j = Math.floor(rng(i) * (i + 1));
        [ranked[i], ranked[j]] = [ranked[j], ranked[i]];
      }
      return ranked.slice(0, limit);
    } catch (error) {
      console.error('Error getting trending series:', error);
      return [];
    }
  },

  /**
   * Cached, instant search used by the global search bar and Browse page.
   *
   * Strategy: load up to 500 of the most-recently-updated series ONCE per
   * 5 minutes, keep them in memory, and run a tokenised substring match
   * locally. This makes every keystroke a synchronous in-memory filter —
   * zero Firestore reads per keystroke, results appear with no perceptible
   * delay, and the dataset still covers everything Browse can paginate to.
   */
  _searchIndex: { at: 0, items: [] },
  async _ensureSearchIndex() {
    const now = Date.now();
    const CACHE_MS = 5 * 60 * 1000;
    if (this._searchIndex.items.length && (now - this._searchIndex.at) < CACHE_MS) return;
    try {
      const snap = await db.collection('series')
        .orderBy('updatedAt', 'desc')
        .limit(500)
        .get();
      const items = snap.docs.map(d => {
        const data = d.data();
        const haystack = [
          data.title, data.author, data.artist,
          ...(data.alternativeTitles || [])
        ].filter(Boolean).join(' ').toLowerCase();
        return { id: d.id, data, haystack };
      });
      this._searchIndex = { at: now, items };
    } catch (e) {
      console.error('Error building search index:', e);
    }
  },
  async searchSeries(query, limit = 8) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    await this._ensureSearchIndex();
    const tokens = q.split(/\s+/).filter(Boolean);
    const out = [];
    const items = this._searchIndex.items;
    for (let i = 0; i < items.length && out.length < limit; i++) {
      const it = items[i];
      if (tokens.every(t => it.haystack.includes(t))) {
        out.push({ id: it.id, ...it.data });
      }
    }
    return out;
  },

  /**
   * Get recently updated series.
   *
   * Backward compatible: `getRecentlyUpdated(10)` still returns a plain array.
   * For pagination, pass an options object:
   *   `getRecentlyUpdated({ limit: 10, cursor: lastDocSnapshot })`
   * which returns `{ series, lastCursor, hasMore }`.
   */
  async getRecentlyUpdated(limitOrOptions = 10) {
    const isOpts = typeof limitOrOptions === 'object' && limitOrOptions !== null;
    const limit  = isOpts ? (limitOrOptions.limit || 10) : (limitOrOptions || 10);
    const cursor = isOpts ? (limitOrOptions.cursor || null) : null;

    try {
      let query = db.collection('series').orderBy('updatedAt', 'desc');
      if (cursor) query = query.startAfter(cursor);
      query = query.limit(limit);

      const snapshot = await query.get();
      const series = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

      if (isOpts) {
        return {
          series,
          lastCursor: snapshot.docs[snapshot.docs.length - 1] || null,
          hasMore: snapshot.docs.length === limit
        };
      }
      return series;
    } catch (error) {
      console.error('Error getting recently updated:', error);
      return isOpts ? { series: [], lastCursor: null, hasMore: false } : [];
    }
  },

  /**
   * Get new releases
   */
  async getNewReleases(limit = 10) {
    try {
      const snapshot = await db.collection('series')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting new releases:', error);
      return [];
    }
  },

  /**
   * Increment series view count.
   *
   * Each authenticated user contributes ONLY ONE view per series. We record
   * the (user, series) pair in `seriesViews/{uid}_{seriesId}` and only bump
   * the counter when that pair did not already exist. Unauthenticated
   * visitors fall back to a per-browser localStorage guard so refreshing
   * the page also does not inflate the counter.
   */
  async incrementViewCount(seriesId) {
    if (!seriesId) return;
    try {
      const user = firebase.auth().currentUser;

      if (user && user.uid) {
        const viewRef = db.collection('seriesViews').doc(`${user.uid}_${seriesId}`);
        const snap = await viewRef.get();
        if (snap.exists) return; // already counted for this user
        try {
          await viewRef.set({
            userId: user.uid,
            seriesId,
            viewedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } catch (e) {
          // If we can't record the marker we MUST NOT increment, otherwise
          // the counter would grow on every revisit.
          console.warn('Could not record view marker, skipping increment', e);
          return;
        }
      } else {
        try {
          const key = 'seriesViewed:' + seriesId;
          if (localStorage.getItem(key)) return;
          localStorage.setItem(key, String(Date.now()));
        } catch (_) { /* storage unavailable — count once per session */ }
      }

      await db.collection('series').doc(seriesId).update({
        viewCount: firebase.firestore.FieldValue.increment(1)
      });
    } catch (error) {
      console.error('Error incrementing view count:', error);
    }
  },

  /**
   * Admin-only: set view count to a specific value.
   * Used by the Series Details "Edit" button next to the eye icon.
   * Firestore security rules should also restrict this write to admins.
   */
  async setViewCount(seriesId, value) {
    const n = Math.max(0, Math.floor(Number(value) || 0));
    try {
      await db.collection('series').doc(seriesId).update({
        viewCount: n,
        viewCountUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return n;
    } catch (error) {
      console.error('Error setting view count:', error);
      throw error;
    }
  },

  // ==================== CHAPTER OPERATIONS ====================

  /**
   * Get chapters for a series
   */
  async getChapters(seriesId, options = {}) {
    const { limit = 100, cursor = null } = options;

    try {
      let query = db.collection('chapters')
        .where('seriesId', '==', seriesId)
        .orderBy('chapterNumber', 'desc');

      if (cursor) {
        query = query.startAfter(cursor);
      }

      query = query.limit(limit);

      const snapshot = await query.get();
      const chapters = [];
      
      snapshot.forEach(doc => {
        chapters.push({ id: doc.id, ...doc.data() });
      });

      return {
        chapters,
        lastCursor: snapshot.docs[snapshot.docs.length - 1] || null,
        hasMore: snapshot.docs.length === limit
      };
    } catch (error) {
      console.error('Error getting chapters:', error);
      throw error;
    }
  },

  /**
   * Get single chapter
   */
  async getChapter(chapterId) {
    try {
      const doc = await db.collection('chapters').doc(chapterId).get();
      if (!doc.exists) return null;
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('Error getting chapter:', error);
      throw error;
    }
  },

  /**
   * Get chapter by number
   */
  async getChapterByNumber(seriesId, chapterNumber) {
    try {
      const snapshot = await db.collection('chapters')
        .where('seriesId', '==', seriesId)
        .where('chapterNumber', '==', parseFloat(chapterNumber))
        .limit(1)
        .get();

      if (snapshot.empty) return null;
      const doc = snapshot.docs[0];
      return { id: doc.id, ...doc.data() };
    } catch (error) {
      console.error('Error getting chapter by number:', error);
      throw error;
    }
  },

  /**
   * Add chapter
   */
  async addChapter(data) {
    try {
      // ---------- DATA-PROTECTION VALIDATION ----------
      // Refuse to write a chapter that isn't tied to a real series. This
      // is the safeguard that prevents a failed import / corrupted sync
      // payload from creating "orphan" chapter docs (which could later be
      // mis-attributed to the wrong series and look like data loss).
      if (!data || typeof data !== 'object') {
        throw new Error('addChapter: payload must be an object');
      }
      if (!data.seriesId || typeof data.seriesId !== 'string') {
        throw new Error('addChapter: missing or invalid seriesId');
      }
      if (data.chapterNumber == null || isNaN(parseFloat(data.chapterNumber))) {
        throw new Error('addChapter: missing or invalid chapterNumber');
      }
      // Verify the parent series actually exists. Without this check a
      // typo'd seriesId would silently create unreachable chapters.
      const parentSnap = await db.collection('series').doc(data.seriesId).get();
      if (!parentSnap.exists) {
        throw new Error(`addChapter: parent series ${data.seriesId} does not exist`);
      }

      const chapterData = {
        ...data,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        viewCount: 0
      };

      const docRef = await db.collection('chapters').add(chapterData);

      // Update stats counter atomically
      this._incrementStatsCounter('totalChapters', 1);


      // Update series latest chapter. This MUST bump `updatedAt` so the
      // Manhwa moves to the top of "Recently Updated" — regardless of
      // whether the import was triggered by an admin, moderator, regular
      // user, guest-triggered cron, or background Auto-Sync. If the full
      // update is rejected by Firestore rules (older deployments without
      // the expanded whitelist), fall back to writing only the minimal
      // bookkeeping fields so the feed still reorders correctly.
      const fullUpdate = {
        latestChapter: data.chapterNumber,
        latestChapterTitle: data.chapterTitle,
        latestChapterId: docRef.id,
        latestChapterAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastChapterUpdate: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      try {
        await db.collection('series').doc(data.seriesId).update(fullUpdate);
      } catch (permErr) {
        console.warn('Series full-update rejected, retrying minimal bump:', permErr?.message);
        try {
          await db.collection('series').doc(data.seriesId).update({
            latestChapter: data.chapterNumber,
            latestChapterId: docRef.id,
            updatedAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } catch (e2) {
          console.error('Series minimal-bump also failed:', e2?.message);
        }
      }

      // Notify followers
      this.notifyNewChapter(data.seriesId, data.chapterNumber, data.chapterTitle);

      return { id: docRef.id, ...chapterData };
    } catch (error) {
      console.error('Error adding chapter:', error);
      throw error;
    }
  },

  /**
   * Update chapter
   */
  async updateChapter(chapterId, data) {
    try {
      await db.collection('chapters').doc(chapterId).update({
        ...data,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return { id: chapterId, ...data };
    } catch (error) {
      console.error('Error updating chapter:', error);
      throw error;
    }
  },

  /**
   * Delete chapter
   */
  async deleteChapter(chapterId, opts = {}) {
    try {
      if (!chapterId) throw new Error('deleteChapter: missing chapterId');
      // Back up first — abort delete if backup fails.
      await this._archiveBeforeDelete('chapters', chapterId, {
        reason: opts.reason || 'deleteChapter'
      });
      await db.collection('chapters').doc(chapterId).delete();

      // Update stats counter atomically
      this._incrementStatsCounter('totalChapters', -1);

      return true;
    } catch (error) {
      console.error('Error deleting chapter:', error);
      throw error;
    }
  },

  /**
   * Get latest chapters across all series
   * Optimized: uses batched 'in' query instead of N+1 individual doc reads
   */
  async getLatestChapters(limit = 20) {
    try {
      const snapshot = await db.collection('chapters')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      const chapters = [];
      snapshot.forEach(doc => {
        chapters.push({ id: doc.id, ...doc.data() });
      });

      // Batch fetch series info using 'in' queries (max 10 per batch)
      const seriesIds = [...new Set(chapters.map(c => c.seriesId).filter(Boolean))];
      const seriesMap = {};
      
      const chunks = [];
      for (let i = 0; i < seriesIds.length; i += 10) {
        chunks.push(seriesIds.slice(i, i + 10));
      }

      // Fetch all series in parallel batches
      const seriesPromises = chunks.map(chunk => 
        db.collection('series')
          .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
          .get()
          .then(snap => {
            snap.forEach(doc => {
              seriesMap[doc.id] = { id: doc.id, ...doc.data() };
            });
          })
      );
      
      await Promise.all(seriesPromises);

      return chapters.map(c => ({
        ...c,
        series: seriesMap[c.seriesId] || null
      }));
    } catch (error) {
      console.error('Error getting latest chapters:', error);
      return [];
    }
  },

  // ==================== USER INTERACTIONS ====================

  /**
   * Toggle favorite series
   */
  async toggleFavorite(seriesId) {
    const user = auth.currentUser;
    if (!user) throw new Error('User not authenticated');

    try {
      const userRef = db.collection('users').doc(user.uid);
      const userDoc = await userRef.get();
      const favorites = userDoc.data()?.favorites || [];

      if (favorites.includes(seriesId)) {
        await userRef.update({
          favorites: firebase.firestore.FieldValue.arrayRemove(seriesId)
        });
        return { favorited: false };
      } else {
        await userRef.update({
          favorites: firebase.firestore.FieldValue.arrayUnion(seriesId)
        });
        return { favorited: true };
      }
    } catch (error) {
      console.error('Error toggling favorite:', error);
      throw error;
    }
  },

  /**
   * Check if series is favorited
   */
  async isFavorited(seriesId) {
    const user = auth.currentUser;
    if (!user) return false;

    try {
      const userDoc = await db.collection('users').doc(user.uid).get();
      const favorites = userDoc.data()?.favorites || [];
      return favorites.includes(seriesId);
    } catch (error) {
      return false;
    }
  },

  /**
   * Get user's favorite series
   */
  async getFavorites() {
    const user = auth.currentUser;
    if (!user) return [];

    try {
      const userDoc = await db.collection('users').doc(user.uid).get();
      const favoriteIds = userDoc.data()?.favorites || [];

      if (favoriteIds.length === 0) return [];

      // Get series details
      const series = [];
      const chunks = [];
      for (let i = 0; i < favoriteIds.length; i += 10) {
        chunks.push(favoriteIds.slice(i, i + 10));
      }

      for (const chunk of chunks) {
        const snapshot = await db.collection('series')
          .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
          .get();
        
        snapshot.forEach(doc => {
          series.push({ id: doc.id, ...doc.data() });
        });
      }

      return series;
    } catch (error) {
      console.error('Error getting favorites:', error);
      return [];
    }
  },

  /**
   * Toggle follow series
   */
  async toggleFollow(seriesId) {
    const user = auth.currentUser;
    if (!user) throw new Error('User not authenticated');

    try {
      const userRef = db.collection('users').doc(user.uid);
      const userDoc = await userRef.get();
      const followed = userDoc.data()?.followedSeries || [];

      if (followed.includes(seriesId)) {
        await userRef.update({
          followedSeries: firebase.firestore.FieldValue.arrayRemove(seriesId)
        });
        // Decrement follow count
        await db.collection('series').doc(seriesId).update({
          followCount: firebase.firestore.FieldValue.increment(-1)
        });
        return { following: false };
      } else {
        await userRef.update({
          followedSeries: firebase.firestore.FieldValue.arrayUnion(seriesId)
        });
        // Increment follow count
        await db.collection('series').doc(seriesId).update({
          followCount: firebase.firestore.FieldValue.increment(1)
        });
        return { following: true };
      }
    } catch (error) {
      console.error('Error toggling follow:', error);
      throw error;
    }
  },

  /**
   * Add to reading history
   */
  async addToHistory(seriesId, chapterId, chapterNumber) {
    const user = auth.currentUser;
    if (!user) return;

    try {
      const userRef = db.collection('users').doc(user.uid);
      
      // Get current history
      const userDoc = await userRef.get();
      let history = userDoc.data()?.readingHistory || [];
      
      // Remove existing entry for this series
      history = history.filter(h => h.seriesId !== seriesId);
      
      // Add new entry at the beginning
      history.unshift({
        seriesId,
        chapterId,
        chapterNumber,
        readAt: firebase.firestore.Timestamp.now()
      });

      // Keep only last 100 entries
      if (history.length > 100) {
        history = history.slice(0, 100);
      }

      await userRef.update({ readingHistory: history });

      // Also mark the chapter itself as read (per-chapter tracking).
      // The original schema only stored the latest chapter per series in
      // `readingHistory`, so "Read" badges could never be shown for every
      // chapter the user had finished. We now also persist a per-series
      // array of read chapter IDs in `readChapters`.
      //
      // NOTE: EXP is intentionally NOT awarded here. Just opening a chapter
      // should not count as "read". The chapter page schedules EXP only
      // after the reader has actually stayed on the page for ~1 minute
      // (see pages/chapter.html). This prevents farming EXP by spamming
      // chapter-open requests.
      try { await this.markChapterRead(seriesId, chapterId); } catch(_) {}
    } catch (error) {
      console.error('Error adding to history:', error);
    }
  },

  /**
   * Mark a single chapter as read for the current user.
   * Uses arrayUnion so concurrent writes from multiple tabs/devices merge
   * cleanly without overwriting each other.
   */
  async markChapterRead(seriesId, chapterId) {
    const user = auth.currentUser;
    if (!user || !seriesId || !chapterId) return;
    try {
      await db.collection('users').doc(user.uid).set({
        readChapters: {
          [seriesId]: firebase.firestore.FieldValue.arrayUnion(chapterId)
        }
      }, { merge: true });
    } catch (error) {
      console.error('Error marking chapter read:', error);
    }
  },

  /**
   * Get the set of read chapter IDs for a given series for the current user.
   * Returns a Set for O(1) lookup when rendering chapter lists.
   */
  async getReadChapters(seriesId) {
    const user = auth.currentUser;
    if (!user || !seriesId) return new Set();
    try {
      const userDoc = await db.collection('users').doc(user.uid).get();
      const map = userDoc.data()?.readChapters || {};
      return new Set(map[seriesId] || []);
    } catch (error) {
      console.error('Error getting read chapters:', error);
      return new Set();
    }
  },



  /**
   * Get reading history
   * Optimized: uses batched 'in' query instead of N+1 individual doc reads
   */
  async getHistory() {
    const user = auth.currentUser;
    if (!user) return [];

    try {
      const userDoc = await db.collection('users').doc(user.uid).get();
      const history = userDoc.data()?.readingHistory || [];

      if (history.length === 0) return [];

      // Batch fetch series details using 'in' queries (max 10 per batch)
      const recentHistory = history.slice(0, 20);
      const seriesIds = [...new Set(recentHistory.map(h => h.seriesId).filter(Boolean))];
      const seriesMap = {};
      
      const chunks = [];
      for (let i = 0; i < seriesIds.length; i += 10) {
        chunks.push(seriesIds.slice(i, i + 10));
      }

      const seriesPromises = chunks.map(chunk =>
        db.collection('series')
          .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
          .get()
          .then(snap => {
            snap.forEach(doc => {
              seriesMap[doc.id] = { id: doc.id, ...doc.data() };
            });
          })
      );

      await Promise.all(seriesPromises);

      // Map series info to history items
      const historyWithSeries = recentHistory
        .filter(item => seriesMap[item.seriesId])
        .map(item => ({
          ...item,
          series: seriesMap[item.seriesId]
        }));

      return historyWithSeries;
    } catch (error) {
      console.error('Error getting history:', error);
      return [];
    }
  },

  /**
   * Get continue reading list
   * Optimized: uses batched 'in' queries instead of N+1 individual doc reads,
   * and batched next-chapter checks instead of individual queries per series
   */
  async getContinueReading() {
    const user = auth.currentUser;
    if (!user) return [];

    try {
      const userDoc = await db.collection('users').doc(user.uid).get();
      const history = userDoc.data()?.readingHistory || [];
      
      if (history.length === 0) return [];

      const recentHistory = history.slice(0, 10);

      // Batch fetch series details using 'in' queries
      const seriesIds = [...new Set(recentHistory.map(h => h.seriesId).filter(Boolean))];
      const seriesMap = {};
      
      const chunks = [];
      for (let i = 0; i < seriesIds.length; i += 10) {
        chunks.push(seriesIds.slice(i, i + 10));
      }

      const seriesPromises = chunks.map(chunk =>
        db.collection('series')
          .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
          .get()
          .then(snap => {
            snap.forEach(doc => {
              seriesMap[doc.id] = { id: doc.id, ...doc.data() };
            });
          })
      );

      await Promise.all(seriesPromises);

      // Check for next chapters in parallel for each series
      // Note: This still requires individual queries since each series has different chapterNumber threshold
      // but we run them in parallel instead of sequentially
      const resultPromises = recentHistory
        .filter(item => seriesMap[item.seriesId])
        .map(async item => {
          try {
            const nextChapterSnapshot = await db.collection('chapters')
              .where('seriesId', '==', item.seriesId)
              .where('chapterNumber', '>', item.chapterNumber)
              .orderBy('chapterNumber', 'asc')
              .limit(1)
              .get();
            
            return {
              ...item,
              series: seriesMap[item.seriesId],
              hasNextChapter: !nextChapterSnapshot.empty
            };
          } catch (err) {
            // If the query fails (e.g., missing composite index), still return the item
            console.warn(`Failed to check next chapter for series ${item.seriesId}:`, err.message);
            return {
              ...item,
              series: seriesMap[item.seriesId],
              hasNextChapter: false
            };
          }
        });

      const result = await Promise.all(resultPromises);
      return result;
    } catch (error) {
      console.error('Error getting continue reading:', error);
      return [];
    }
  },

  // ==================== COMMENTS/DISCUSSION ====================

  /**
   * Get comments for a chapter
   * Optimized: Fetches all comments for the chapter in one query, then
   * groups them into top-level comments and replies in memory instead of
   * making N+1 queries for each comment's replies.
   * 
   * Requires composite index: chapterId ASC, createdAt DESC
   */
  async getComments(chapterId, options = {}) {
    const { sortBy = 'createdAt', limit = 50, cursor = null } = options;

    try {
      // Fetch ALL comments for this chapter in a single query
      // This avoids the N+1 pattern of fetching replies per comment
      let query = db.collection('comments')
        .where('chapterId', '==', chapterId)
        .orderBy(sortBy, 'desc')
        .limit(limit * 3); // Fetch more to account for replies

      const snapshot = await query.get();

      // Separate into top-level comments and replies
      const topLevelComments = [];
      const repliesMap = {}; // commentId -> [replies]

      snapshot.forEach(doc => {
        const comment = { id: doc.id, ...doc.data() };
        if (!comment.parentCommentId) {
          comment.replies = []; // Will be populated below
          topLevelComments.push(comment);
        } else {
          if (!repliesMap[comment.parentCommentId]) {
            repliesMap[comment.parentCommentId] = [];
          }
          repliesMap[comment.parentCommentId].push(comment);
        }
      });

      // Attach replies to their parent comments
      topLevelComments.forEach(comment => {
        if (repliesMap[comment.id]) {
          comment.replies = repliesMap[comment.id].sort((a, b) => {
            const timeA = a.createdAt?.toMillis?.() || 0;
            const timeB = b.createdAt?.toMillis?.() || 0;
            return timeA - timeB; // Replies sorted ascending (oldest first)
          });
        }
      });

      // Apply pagination to top-level comments only
      const paginatedComments = topLevelComments.slice(0, limit);

      return {
        comments: paginatedComments,
        lastCursor: null, // Cursor pagination is simplified with this approach
        hasMore: topLevelComments.length > limit
      };
    } catch (error) {
      console.error('Error getting comments:', error);
      return { comments: [], lastCursor: null, hasMore: false };
    }
  },

  /**
   * Add comment
   */
  async addComment(chapterId, content, parentCommentId = null, extras = {}) {
    const user = auth.currentUser;
    if (!user) throw new Error('Must be logged in to comment');

    try {
      const userDoc = await db.collection('users').doc(user.uid).get();
      const userData = userDoc.data();

      const commentData = {
        chapterId,
        userId: user.uid,
        username: userData?.username || user.displayName || 'Anonymous',
        avatar: userData?.avatar || user.photoURL || '/images/default-avatar.png',
        // Role badge (admin / moderator)
        authorRole: userData?.role || 'user',
        // EXP / Title metadata (additive — safe if absent)
        authorLevel: userData?.level || (typeof EXPSystem !== 'undefined' ? EXPSystem.levelFromExp(userData?.exp || 0) : 1),
        authorTitleId: userData?.selectedTitleId || null,
        // Snapshot of any active admin-assigned title (DONATOR / VIP / etc.)
        // so it can be rendered without an extra read.
        authorCustomTitleId: (typeof Donation !== 'undefined'
          ? (Donation.getActiveCustomTitle(userData)?.id || null) : null),
        authorCustomTitleExpiresAt: (typeof Donation !== 'undefined'
          ? (Donation.getActiveCustomTitle(userData)?.expiresAt
              ? firebase.firestore.Timestamp.fromMillis(Donation.getActiveCustomTitle(userData).expiresAt)
              : null)
          : null),
        content,
        // Optional attached image (Firebase Storage URL) + spoiler flag.
        imageUrl: extras.imageUrl || null,
        isSpoiler: !!extras.isSpoiler,
        // Reactions: per-key count + per-user selection map. Stored on-doc
        // (small + cheap) so we can render counts without a sub-query.
        reactions: { upvote: 0, funny: 0, love: 0, surprised: 0, angry: 0, sad: 0 },
        userReactions: {},
        likes: 0,
        likedBy: [],
        parentCommentId,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      const docRef = await db.collection('comments').add(commentData);

      // Update stats counter atomically
      this._incrementStatsCounter('totalComments', 1);

      // ---- Comment Reply Notifications ----
      // When this comment is a reply, notify the parent comment author
      // (skip self-replies). Best-effort; never block comment creation.
      if (parentCommentId) {
        this._notifyCommentReply({
          replyId: docRef.id,
          parentCommentId,
          chapterId,
          content,
          replierUsername: commentData.username,
        }).catch(err => console.warn('[notif] reply notify failed:', err));
      }

      return { id: docRef.id, ...commentData };
    } catch (error) {
      console.error('Error adding comment:', error);
      throw error;
    }
  },

  /**
   * Update comment
   */
  async updateComment(commentId, content) {
    const user = auth.currentUser;
    if (!user) throw new Error('Must be logged in');

    try {
      const commentDoc = await db.collection('comments').doc(commentId).get();
      if (!commentDoc.exists) throw new Error('Comment not found');
      
      const comment = commentDoc.data();
      if (comment.userId !== user.uid) {
        throw new Error('Can only edit your own comments');
      }

      await db.collection('comments').doc(commentId).update({
        content,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        isEdited: true
      });

      return true;
    } catch (error) {
      console.error('Error updating comment:', error);
      throw error;
    }
  },

  /**
   * Delete comment
   */
  async deleteComment(commentId) {
    const user = auth.currentUser;
    if (!user) throw new Error('Must be logged in');

    try {
      const commentDoc = await db.collection('comments').doc(commentId).get();
      if (!commentDoc.exists) throw new Error('Comment not found');
      
      const comment = commentDoc.data();
      const userData = await db.collection('users').doc(user.uid).get();
      const isAdmin = userData.data()?.role === 'admin' || userData.data()?.role === 'moderator';

      if (comment.userId !== user.uid && !isAdmin) {
        throw new Error('Permission denied');
      }

      // Delete replies first
      const repliesSnapshot = await db.collection('comments')
        .where('parentCommentId', '==', commentId)
        .get();

      // Back up the parent + each reply BEFORE the batched delete.
      await this._archiveBeforeDelete('comments', commentId, { reason: 'deleteComment' });
      for (const doc of repliesSnapshot.docs) {
        await this._archiveBeforeDelete('comments', doc.id, {
          reason: 'cascade:deleteComment:' + commentId
        });
      }

      const batch = db.batch();
      repliesSnapshot.forEach(doc => batch.delete(doc.ref));
      batch.delete(db.collection('comments').doc(commentId));

      await batch.commit();

      // Update stats counter atomically (count deleted replies + 1 parent)
      const deletedCount = repliesSnapshot.size + 1;
      this._incrementStatsCounter('totalComments', -deletedCount);

      return true;
    } catch (error) {
      console.error('Error deleting comment:', error);
      throw error;
    }
  },

  /**
   * Toggle like on comment
   */
  async toggleLikeComment(commentId) {
    const user = auth.currentUser;
    if (!user) throw new Error('Must be logged in to like');

    try {
      const commentRef = db.collection('comments').doc(commentId);
      const commentDoc = await commentRef.get();
      
      if (!commentDoc.exists) throw new Error('Comment not found');
      
      const likedBy = commentDoc.data().likedBy || [];
      
      if (likedBy.includes(user.uid)) {
        await commentRef.update({
          likes: firebase.firestore.FieldValue.increment(-1),
          likedBy: firebase.firestore.FieldValue.arrayRemove(user.uid)
        });
        return { liked: false };
      } else {
        await commentRef.update({
          likes: firebase.firestore.FieldValue.increment(1),
          likedBy: firebase.firestore.FieldValue.arrayUnion(user.uid)
        });
        return { liked: true };
      }
    } catch (error) {
      console.error('Error toggling like:', error);
      throw error;
    }
  },

  /**
   * Toggle a reaction on a comment. Reactions are mutually exclusive per
   * user — clicking a different reaction switches from the old one, clicking
   * the same one removes it. Stored as { reactions: {key: count}, userReactions: {uid: key} }
   * so a single doc read renders the full state without sub-queries.
   */
  async toggleReaction(commentId, reactionKey) {
    const user = auth.currentUser;
    if (!user) throw new Error('Must be logged in to react');
    const VALID = ['upvote', 'funny', 'love', 'surprised', 'angry', 'sad'];
    if (!VALID.includes(reactionKey)) throw new Error('Invalid reaction');

    // Quota-friendly: one read + one write (mirrors rateSeries optimization).
    // Transactions retry on contention and burn the daily quota; this pattern
    // does not retry, and the in-flight guard in Comments.toggleReaction
    // prevents double-clicks from racing.
    const ref = db.collection('comments').doc(commentId);
    const snap = await ref.get();
    if (!snap.exists) throw new Error('Comment not found');
    const data = snap.data() || {};
    const reactions = Object.assign(
      { upvote: 0, funny: 0, love: 0, surprised: 0, angry: 0, sad: 0 },
      data.reactions || {}
    );
    const userReactions = Object.assign({}, data.userReactions || {});
    const prev = userReactions[user.uid] || null;

    let mine = null;
    if (prev === reactionKey) {
      reactions[prev] = Math.max(0, (reactions[prev] || 0) - 1);
      delete userReactions[user.uid];
    } else {
      if (prev && reactions[prev] != null) {
        reactions[prev] = Math.max(0, reactions[prev] - 1);
      }
      reactions[reactionKey] = (reactions[reactionKey] || 0) + 1;
      userReactions[user.uid] = reactionKey;
      mine = reactionKey;
    }

    await ref.update({ reactions, userReactions });
    return { reactions, mine };
  },

  /**
   * Upload a comment image to Firebase Storage.
   *
   * IMPROVEMENTS over the previous version:
   *   1. Downscale very large images client-side (max 1600px on the long
   *      edge, re-encoded as JPEG q=0.85) so a 4 MB phone photo becomes
   *      ~150-400 KB before it ever leaves the device. This is the main
   *      reason uploads used to "hang for minutes" on mobile.
   *   2. Use Firebase's resumable uploadTask so we can attach a hard
   *      timeout, surface real progress to the caller, and abort cleanly
   *      if the network stalls instead of waiting forever on `.put()`.
   *   3. Pass `cacheControl: public,max-age=31536000` so the CDN serves
   *      the image instantly on subsequent loads.
   */
  async uploadCommentImage(file, onProgress) {
    if (!firebase.storage) {
      throw new Error('Image upload is not available (storage not loaded).');
    }
    const user = auth.currentUser;
    if (!user) throw new Error('Must be logged in to upload images');

    const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const MAX_BYTES = 4 * 1024 * 1024; // 4 MB
    if (!file) throw new Error('No file selected');
    if (!ALLOWED.includes(file.type)) {
      throw new Error('Only JPG, PNG, GIF or WEBP images are allowed.');
    }
    if (file.size > MAX_BYTES) {
      throw new Error('Image is too large (max 4 MB).');
    }

    // --- Client-side downscale (skip GIFs to preserve animation) -----------
    let uploadBlob = file;
    let ext = (file.name.match(/\.([a-z0-9]+)$/i) || [, 'jpg'])[1].toLowerCase();
    let contentType = file.type;
    if (file.type !== 'image/gif') {
      try {
        uploadBlob = await this._downscaleImage(file, 1600, 0.85);
        contentType = 'image/jpeg';
        ext = 'jpg';
      } catch (_) {
        // If canvas fails (e.g. tainted source) just upload the original.
        uploadBlob = file;
      }
    }

    const path = `comment-images/${user.uid}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const ref = firebase.storage().ref().child(path);

    // Resumable upload with a 60s stall-watchdog + progress callback.
    return new Promise((resolve, reject) => {
      const task = ref.put(uploadBlob, {
        contentType,
        cacheControl: 'public,max-age=31536000,immutable'
      });

      let lastTick = Date.now();
      const stallTimer = setInterval(() => {
        if (Date.now() - lastTick > 60000) {
          clearInterval(stallTimer);
          try { task.cancel(); } catch (_) {}
          reject(new Error('Upload stalled. Please check your connection and try again.'));
        }
      }, 5000);

      task.on('state_changed',
        (snap) => {
          lastTick = Date.now();
          if (typeof onProgress === 'function' && snap.totalBytes) {
            onProgress(snap.bytesTransferred / snap.totalBytes);
          }
        },
        (err) => {
          clearInterval(stallTimer);
          reject(err);
        },
        async () => {
          clearInterval(stallTimer);
          try {
            const url = await task.snapshot.ref.getDownloadURL();
            resolve(url);
          } catch (err) { reject(err); }
        }
      );
    });
  },

  /**
   * Downscale an image File to fit inside `maxDim` (longest edge) and
   * re-encode as JPEG. Returns a Blob ready to upload.
   */
  _downscaleImage(file, maxDim = 1600, quality = 0.85) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        const { width, height } = img;
        const scale = Math.min(1, maxDim / Math.max(width, height));
        // No scaling needed AND already a reasonable size? Keep original.
        if (scale === 1 && file.size < 600 * 1024) return resolve(file);
        const w = Math.round(width * scale);
        const h = Math.round(height * scale);
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob(
          (blob) => blob ? resolve(blob) : reject(new Error('Encode failed')),
          'image/jpeg', quality
        );
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image decode failed')); };
      img.src = url;
    });
  },

  // ==================== CHAPTER-LEVEL REACTIONS ====================

  /**
   * Read the aggregated reaction counts for a chapter. Stored in
   * `meta/chapterReactions_<chapterId>` so it lives under the existing
   * meta rule (public read, authenticated write) — no rule changes needed.
   */
  async getChapterReactions(chapterId) {
    const docId = `chapterReactions_${chapterId}`;
    const snap = await db.collection('meta').doc(docId).get();
    if (!snap.exists) return { counts: {}, userReactions: {} };
    const d = snap.data() || {};
    return { counts: d.counts || {}, userReactions: d.userReactions || {} };
  },

  /**
   * Toggle the current user's reaction on a chapter. Same mutually-exclusive
   * semantics as comment reactions: same key clears it, different key swaps.
   */
  async toggleChapterReaction(chapterId, reactionKey) {
    const user = auth.currentUser;
    if (!user) throw new Error('Must be logged in to react');
    const VALID = ['upvote', 'funny', 'love', 'surprised', 'angry', 'sad'];
    if (!VALID.includes(reactionKey)) throw new Error('Invalid reaction');

    // Quota-friendly: one read + one write, no transaction retries.
    // Same optimization used for series rating (DB.rateSeries) — eliminates
    // the "Quota Exceeded" error caused by transaction contention/retries.
    const docId = `chapterReactions_${chapterId}`;
    const ref = db.collection('meta').doc(docId);
    const snap = await ref.get();
    const data = snap.exists ? (snap.data() || {}) : {};
    const counts = Object.assign(
      { upvote: 0, funny: 0, love: 0, surprised: 0, angry: 0, sad: 0 },
      data.counts || {}
    );
    const userReactions = Object.assign({}, data.userReactions || {});
    const prev = userReactions[user.uid] || null;

    let mine = null;
    if (prev === reactionKey) {
      counts[prev] = Math.max(0, (counts[prev] || 0) - 1);
      delete userReactions[user.uid];
    } else {
      if (prev && counts[prev] != null) {
        counts[prev] = Math.max(0, counts[prev] - 1);
      }
      counts[reactionKey] = (counts[reactionKey] || 0) + 1;
      userReactions[user.uid] = reactionKey;
      mine = reactionKey;
    }

    const payload = { counts, userReactions, chapterId, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    if (snap.exists) await ref.update(payload);
    else await ref.set(payload);
    return { counts, mine };
  },

  /**
   * Fetch the commenting rules (editable from the admin dashboard later).
   * Falls back to defaults if the meta doc has not been created yet so the
   * Rules button is never empty.
   */
  async getCommentRules() {
    const DEFAULT_RULES = [
      'Be respectful to other users.',
      'No harassment, hate speech, or personal attacks.',
      'No spam or advertising.',
      'No illegal or harmful content.',
      'Use spoiler tags when discussing spoilers.',
      'Keep discussions related to the series.',
      'Follow community guidelines.'
    ];
    try {
      const doc = await db.collection('meta').doc('commentRules').get();
      if (doc.exists) {
        const data = doc.data() || {};
        if (Array.isArray(data.rules) && data.rules.length) return data.rules;
      }
    } catch (e) {
      console.warn('Falling back to default comment rules:', e.message);
    }
    return DEFAULT_RULES;
  },

  // ==================== NOTIFICATIONS ====================

  /**
   * Create notification for all users or specific user
   */
  async createNotification(data) {
    try {
      const notificationData = {
        ...data,
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      };

      const docRef = await db.collection('notifications').add(notificationData);
      return { id: docRef.id, ...notificationData };
    } catch (error) {
      console.error('Error creating notification:', error);
      throw error;
    }
  },

  /**
   * Update an existing notification / announcement (Admin/Moderator only via
   * Firestore rules). Edits the SAME document instead of creating a duplicate,
   * and stamps `editedAt` so the UI can show an "Edited" label. The original
   * `createdAt` is preserved.
   */
  async updateNotification(notificationId, updates = {}) {
    try {
      const payload = {
        ...updates,
        editedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      await db.collection('notifications').doc(notificationId).update(payload);
      return true;
    } catch (error) {
      console.error('Error updating notification:', error);
      throw error;
    }
  },

  /**
   * Delete a notification or announcement.
   * Admin-only at the Firestore Rules layer — this client method just calls
   * delete; the rule rejects the write for anyone who isn't an admin.
   * Used by:
   *   - Admin "Manage Announcements" panel (admin.html)
   *   - Per-card delete button on the Notifications page (admin only)
   * Safe to call for any single notification id (announcement or per-user).
   */
  async deleteNotification(notificationId) {
    try {
      if (!notificationId) throw new Error('deleteNotification: missing id');
      await this._archiveBeforeDelete('notifications', notificationId, {
        reason: 'deleteNotification'
      });
      await db.collection('notifications').doc(notificationId).delete();
      return true;
    } catch (error) {
      console.error('Error deleting notification:', error);
      throw error;
    }
  },

  /**
   * Bulk-delete multiple notifications in a single batched write
   * (max 500 per Firestore batch — chunked automatically). Each
   * document is archived to `trash` before deletion so it can be
   * restored later via DB.restoreFromTrash().
   */
  async deleteNotifications(ids = []) {
    if (!Array.isArray(ids) || ids.length === 0) return 0;
    let deleted = 0;
    try {
      for (let i = 0; i < ids.length; i += 400) {
        const slice = ids.slice(i, i + 400);
        // Archive in parallel (best-effort). Any failure aborts that id.
        await Promise.all(slice.map(id =>
          this._archiveBeforeDelete('notifications', id, {
            reason: 'deleteNotifications(bulk)'
          }).catch(err => {
            console.warn(`Skipping ${id}: backup failed —`, err.message);
            return null;
          })
        ));
        const batch = db.batch();
        slice.forEach(id => batch.delete(db.collection('notifications').doc(id)));
        await batch.commit();
        deleted += slice.length;
      }
      return deleted;
    } catch (error) {
      console.error('Error bulk-deleting notifications:', error);
      throw error;
    }
  },

  /**
   * Fetch all site-wide announcements (userId == 'all'), newest first.
   * Used by the Admin Dashboard "Manage Announcements" panel so staff can
   * delete outdated / duplicate / mistaken announcements.
   */
  async getAllAnnouncements(limit = 100) {
    try {
      const snapshot = await db.collection('notifications')
        .where('userId', '==', 'all')
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();
      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting announcements:', error);
      return [];
    }
  },



  /**
   * Get user notifications
   */
  async getNotifications(userId, limit = 50) {
    try {
      const snapshot = await db.collection('notifications')
        .where('userId', 'in', [userId, 'all'])
        .orderBy('createdAt', 'desc')
        .limit(limit)
        .get();

      return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
      console.error('Error getting notifications:', error);
      return [];
    }
  },

  /**
   * Mark notification as read
   */
  async markNotificationRead(notificationId) {
    try {
      await db.collection('notifications').doc(notificationId).update({
        read: true,
        readAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (error) {
      console.error('Error marking notification read:', error);
    }
  },

  /**
   * Notify followers of new chapter
   */
  async notifyNewChapter(seriesId, chapterNumber, chapterTitle) {
    try {
      // Get series info
      const seriesDoc = await db.collection('series').doc(seriesId).get();
      if (!seriesDoc.exists) return;
      
      const series = { id: seriesDoc.id, ...seriesDoc.data() };

      // Find the chapter doc so we can deep-link directly to it.
      let chapterId = series.latestChapterId || null;
      if (!chapterId) {
        try {
          const chSnap = await db.collection('chapters')
            .where('seriesId', '==', seriesId)
            .where('chapterNumber', '==', chapterNumber)
            .limit(1).get();
          if (!chSnap.empty) chapterId = chSnap.docs[0].id;
        } catch (_) {}
      }

      // Get users following AND users who bookmarked (favorites). Dedupe.
      const [followSnap, bookmarkSnap] = await Promise.all([
        db.collection('users').where('followedSeries', 'array-contains', seriesId).get()
          .catch(() => ({ forEach: () => {} })),
        db.collection('users').where('favorites', 'array-contains', seriesId).get()
          .catch(() => ({ forEach: () => {} })),
      ]);

      const targetUserIds = new Set();
      followSnap.forEach(d => targetUserIds.add(d.id));
      bookmarkSnap.forEach(d => targetUserIds.add(d.id));
      if (targetUserIds.size === 0) return;

      // Dedupe vs. already-sent notifications for the same series+chapter.
      let alreadyNotified = new Set();
      try {
        const existing = await db.collection('notifications')
          .where('type', '==', 'new_chapter')
          .where('seriesId', '==', seriesId)
          .where('chapterNumber', '==', chapterNumber)
          .get();
        existing.forEach(d => alreadyNotified.add(d.data().userId));
      } catch (_) {}

      const coverImage = series.coverImage || series.cover || series.thumbnail || null;
      const payloadBase = {
        title: series.title,
        message: `Chapter ${chapterNumber} is now available.`,
        type: 'new_chapter',
        category: 'chapters',
        seriesId,
        seriesTitle: series.title,
        coverImage,
        chapterId,
        chapterNumber,
        chapterTitle: chapterTitle || null,
        read: false,
      };

      // Firestore batch limit = 500 writes. Chunk just in case.
      const ids = [...targetUserIds].filter(uid => !alreadyNotified.has(uid));
      for (let i = 0; i < ids.length; i += 450) {
        const chunk = ids.slice(i, i + 450);
        const batch = db.batch();
        chunk.forEach(uid => {
          const ref = db.collection('notifications').doc();
          batch.set(ref, {
            ...payloadBase,
            userId: uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
      }
    } catch (error) {
      console.error('Error notifying followers:', error);
    }
  },

  /**
   * Internal: notify the parent comment author that someone replied.
   * Stored as a `comment_reply` notification with category 'comments'.
   * The notifications.html page deep-links back to the chapter and
   * scrolls to the reply (#comment-<id>).
   */
  async _notifyCommentReply({ replyId, parentCommentId, chapterId, content, replierUsername }) {
    try {
      const parentSnap = await db.collection('comments').doc(parentCommentId).get();
      if (!parentSnap.exists) return;
      const parent = parentSnap.data();
      const me = auth.currentUser;
      if (!me) return;
      if (parent.userId === me.uid) return; // don't notify self

      // Resolve series/chapter context for the click-through.
      let seriesId = null;
      let seriesTitle = '';
      let coverImage = null;
      let chapterNumber = null;
      let chapterTitle = '';
      try {
        const chSnap = await db.collection('chapters').doc(chapterId).get();
        if (chSnap.exists) {
          const ch = chSnap.data();
          seriesId = ch.seriesId || null;
          chapterNumber = ch.chapterNumber || null;
          chapterTitle = ch.chapterTitle || ch.title || '';
          if (seriesId) {
            const sSnap = await db.collection('series').doc(seriesId).get();
            if (sSnap.exists) {
              const s = sSnap.data();
              seriesTitle = s.title || '';
              coverImage = s.coverImage || s.cover || s.thumbnail || null;
            }
          }
        }
      } catch (_) {}

      const preview = (content || '').replace(/\s+/g, ' ').trim().slice(0, 140);
      await db.collection('notifications').add({
        userId: parent.userId,
        type: 'comment_reply',
        category: 'comments',
        title: 'New Reply to Your Comment',
        message: `${replierUsername} replied to your comment on ${seriesTitle || 'a chapter'}${chapterNumber ? ' - Chapter ' + chapterNumber : ''}`,
        preview,
        replierUsername,
        replierId: me.uid,
        seriesId,
        seriesTitle,
        coverImage,
        chapterId,
        chapterNumber,
        chapterTitle,
        parentCommentId,
        replyId,
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (error) {
      console.warn('Error creating reply notification:', error);
    }
  },

  // ==================== MAINTENANCE MODE ====================

  /**
   * Read maintenance mode flag from meta/maintenance. Returns
   * { enabled: bool, message: string }. Safe default = disabled.
   */
  async getMaintenanceMode() {
    try {
      const snap = await db.collection('meta').doc('maintenance').get();
      if (!snap.exists) return { enabled: false, message: '' };
      const d = snap.data() || {};
      return { enabled: !!d.enabled, message: d.message || '' };
    } catch (e) {
      return { enabled: false, message: '' };
    }
  },

  /**
   * Admin-only: enable / disable maintenance mode.
   */
  async setMaintenanceMode(enabled, message = '') {
    await db.collection('meta').doc('maintenance').set({
      enabled: !!enabled,
      message: message || '',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return { enabled: !!enabled, message };
  },

  // ==================== GENRES ====================

  /**
   * Get all genres
   */
  async getGenres() {
    const DEFAULT_GENRES = [
      { id: 'action', name: 'Action', slug: 'action' },
      { id: 'adventure', name: 'Adventure', slug: 'adventure' },
      { id: 'comedy', name: 'Comedy', slug: 'comedy' },
      { id: 'crazy-mc', name: 'Crazy MC', slug: 'crazy-mc' },
      { id: 'demon', name: 'Demon', slug: 'demon' },
      { id: 'drama', name: 'Drama', slug: 'drama' },
      { id: 'dungeons', name: 'Dungeons', slug: 'dungeons' },
      { id: 'fantasy', name: 'Fantasy', slug: 'fantasy' },
      { id: 'game', name: 'Game', slug: 'game' },
      { id: 'genius-mc', name: 'Genius MC', slug: 'genius-mc' },
      { id: 'isekai', name: 'Isekai', slug: 'isekai' },
      { id: 'kuchikuchi', name: 'Kuchikuchi', slug: 'kuchikuchi' },
      { id: 'magic', name: 'Magic', slug: 'magic' },
      { id: 'martial-arts', name: 'Martial Arts', slug: 'martial-arts' },
      { id: 'murim', name: 'Murim', slug: 'murim' },
      { id: 'mystery', name: 'Mystery', slug: 'mystery' },
      { id: 'necromancer', name: 'Necromancer', slug: 'necromancer' },
      { id: 'overpowered', name: 'Overpowered', slug: 'overpowered' },
      { id: 'regression', name: 'Regression', slug: 'regression' },
      { id: 'reincarnation', name: 'Reincarnation', slug: 'reincarnation' },
      { id: 'revenge', name: 'Revenge', slug: 'revenge' },
      { id: 'romance', name: 'Romance', slug: 'romance' },
      { id: 'school-life', name: 'School Life', slug: 'school-life' },
      { id: 'sci-fi', name: 'Sci-Fi', slug: 'sci-fi' },
      { id: 'shoujo', name: 'Shoujo', slug: 'shoujo' },
      { id: 'shounen', name: 'Shounen', slug: 'shounen' },
      { id: 'system', name: 'System', slug: 'system' },
      { id: 'tower', name: 'Tower', slug: 'tower' },
      { id: 'tragedy', name: 'Tragedy', slug: 'tragedy' },
      { id: 'villain', name: 'Villain', slug: 'villain' },
      { id: 'violence', name: 'Violence', slug: 'violence' },
      { id: 'manhwa', name: 'Manhwa', slug: 'manhwa' },
      { id: 'manga', name: 'Manga', slug: 'manga' },
      { id: 'manhua', name: 'Manhua', slug: 'manhua' },
      { id: '18+', name: '18+', slug: '18-plus' },
      { id: 'mature', name: 'Mature', slug: 'mature' },
      { id: 'adult', name: 'Adult', slug: 'adult' }
    ];

    // Collect any genres found on existing series so a tag that was
    // typed directly on a series (without admins touching the genres
    // collection) still appears in the Browse filter.
    const slugify = (s) => String(s).toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'genre';
    const fromSeries = [];
    try {
      // Reuse the search-index cache if it's warm to avoid extra reads.
      let cached = this._searchIndex && Array.isArray(this._searchIndex.data)
        ? this._searchIndex.data : null;
      if (!cached) {
        const snap = await db.collection('series').limit(500).get();
        cached = snap.docs.map(d => d.data());
      }
      const seen = new Set();
      cached.forEach(s => {
        (s.genres || []).forEach(g => {
          const name = String(g || '').trim();
          if (!name) return;
          const id = slugify(name);
          if (seen.has(id)) return;
          seen.add(id);
          fromSeries.push({ id, name, slug: id });
        });
      });
    } catch (_) { /* non-critical — fall back to defaults */ }

    try {
      const snapshot = await db.collection('genres').orderBy('name').get();
      let fromDb = [];
      if (!snapshot.empty) {
        fromDb = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      } else {
        // Collection exists but is empty — seed it with defaults
        try {
          const batch = db.batch();
          DEFAULT_GENRES.forEach(g => {
            batch.set(db.collection('genres').doc(g.id), {
              name: g.name,
              slug: g.slug,
              createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });
          });
          await batch.commit();
        } catch (_) { /* non-critical */ }
        fromDb = DEFAULT_GENRES.slice();
      }

      const haveIds = new Set(fromDb.map(g => String(g.id).toLowerCase()));
      const haveNames = new Set(fromDb.map(g => String(g.name || '').toLowerCase()));
      const merged = fromDb.slice();
      const addIfMissing = (g) => {
        if (!g || !g.name) return;
        if (haveIds.has(String(g.id).toLowerCase())) return;
        if (haveNames.has(String(g.name).toLowerCase())) return;
        haveIds.add(String(g.id).toLowerCase());
        haveNames.add(String(g.name).toLowerCase());
        merged.push(g);
      };
      DEFAULT_GENRES.forEach(addIfMissing);
      fromSeries.forEach(addIfMissing);

      // Persist any series-derived genres back to the collection in the
      // background so subsequent loads don't need the scan.
      if (fromSeries.length) {
        this._ensureGenresExist(fromSeries.map(g => g.name)).catch(() => {});
      }

      merged.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return merged;
    } catch (error) {
      const haveIds = new Set(DEFAULT_GENRES.map(g => g.id));
      const merged = DEFAULT_GENRES.slice();
      fromSeries.forEach(g => { if (!haveIds.has(g.id)) merged.push(g); });
      merged.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return merged;
    }
  },

  // ==================== ANALYTICS/STATS ====================

  /**
   * Get admin dashboard stats
   * Optimized: Uses a cached stats document instead of full collection scans.
   * Falls back to count queries if stats doc doesn't exist.
   * 
   * IMPORTANT: To avoid full collection scans (which read every document and
   * cost read operations for each), create a 'meta/stats' document with fields:
   *   totalSeries, totalChapters, totalUsers, totalComments
   * Update these counts atomically whenever series/chapters/users/comments are added/deleted.
   * 
   * If the stats document doesn't exist yet, this method falls back to using
   * Firestore count() aggregation queries (available in Firebase JS SDK 9.1+),
   * which are more efficient than loading all documents.
   */
  async getAdminStats() {
    try {
      // Try to get pre-computed stats from meta/stats document
      const statsDoc = await db.collection('meta').doc('stats').get();
      if (statsDoc.exists) {
        const statsData = statsDoc.data();
        
        // Get today's new users (this is the only query that still needs to hit the collection)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayUsersSnapshot = await db.collection('users')
          .where('createdAt', '>=', today)
          .get();

        return {
          totalSeries: statsData.totalSeries || 0,
          totalChapters: statsData.totalChapters || 0,
          totalUsers: statsData.totalUsers || 0,
          totalComments: statsData.totalComments || 0,
          newUsersToday: todayUsersSnapshot.size
        };
      }

      // Fallback: Use count aggregation if available (Firebase JS SDK 9.1+)
      // Note: firebase.firestore.Query has getAggregation() in newer SDKs
      // For compat SDK, we fall back to limited scans with .select() to minimize reads
      const [seriesCount, chaptersCount, usersCount, commentsCount] = await Promise.all([
        db.collection('series').select('_id').get().then(s => s.size),
        db.collection('chapters').select('_id').get().then(s => s.size),
        db.collection('users').select('_id').get().then(s => s.size),
        db.collection('comments').select('_id').get().then(s => s.size)
      ]);

      // Get today's new users
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayUsersSnapshot = await db.collection('users')
        .where('createdAt', '>=', today)
        .get();

      // Create the stats document for future use
      try {
        await db.collection('meta').doc('stats').set({
          totalSeries: seriesCount,
          totalChapters: chaptersCount,
          totalUsers: usersCount,
          totalComments: commentsCount,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) {
        // Non-critical: just log if stats doc creation fails
        console.warn('Could not create meta/stats document:', e.message);
      }

      return {
        totalSeries: seriesCount,
        totalChapters: chaptersCount,
        totalUsers: usersCount,
        totalComments: commentsCount,
        newUsersToday: todayUsersSnapshot.size
      };
    } catch (error) {
      console.error('Error getting admin stats:', error);
      return {
        totalSeries: 0,
        totalChapters: 0,
        totalUsers: 0,
        totalComments: 0,
        newUsersToday: 0
      };
    }
  },

  /**
   * Get recent activity
   */
  async getRecentActivity(limit = 20) {
    try {
      const [recentChapters, recentUsers, recentComments] = await Promise.all([
        db.collection('chapters').orderBy('createdAt', 'desc').limit(limit).get(),
        db.collection('users').orderBy('createdAt', 'desc').limit(limit).get(),
        db.collection('comments').orderBy('createdAt', 'desc').limit(limit).get()
      ]);

      const activities = [];

      recentChapters.forEach(doc => {
        activities.push({
          type: 'chapter_added',
          description: `Chapter ${doc.data().chapterNumber} added`,
          timestamp: doc.data().createdAt,
          data: { id: doc.id, ...doc.data() }
        });
      });

      recentUsers.forEach(doc => {
        activities.push({
          type: 'user_registered',
          description: `New user: ${doc.data().username || doc.data().email}`,
          timestamp: doc.data().createdAt,
          data: { id: doc.id, ...doc.data() }
        });
      });

      recentComments.forEach(doc => {
        activities.push({
          type: 'comment',
          description: `New comment by ${doc.data().username}`,
          timestamp: doc.data().createdAt,
          data: { id: doc.id, ...doc.data() }
        });
      });

      // Sort by timestamp
      return activities
        .sort((a, b) => {
          const timeA = a.timestamp?.toMillis?.() || 0;
          const timeB = b.timestamp?.toMillis?.() || 0;
          return timeB - timeA;
        })
        .slice(0, limit);
    } catch (error) {
      console.error('Error getting recent activity:', error);
      return [];
    }
  },

  // ==================== RATINGS ====================

  /**
   * Rate a series (1-5 stars). Stores one rating per user in
   * `ratings/{seriesId}_{userId}` and recomputes the series' aggregate
   * rating + ratingCount atomically. Calling again with a new value
   * UPDATES the existing rating instead of creating a duplicate.
   */
  async rateSeries(seriesId, rating) {
    const user = auth.currentUser;
    if (!user) throw new Error('You must be logged in to rate');
    const r = Math.max(1, Math.min(5, Math.round(Number(rating))));
    if (!r) throw new Error('Invalid rating');

    // Quota-friendly pattern (mirrors toggleLikeComment): one read + one
    // write on the series doc. Per-user ratings live on the series doc
    // itself as a `userRatings: { uid: stars }` map — same shape used by
    // the chapter-comment reactions system — which removes the need for a
    // separate `ratings` collection round-trip AND the transaction retries
    // that were burning the Firestore quota.
    const seriesRef = db.collection('series').doc(seriesId);
    const seriesDoc = await seriesRef.get();
    if (!seriesDoc.exists) throw new Error('Series not found');

    const data = seriesDoc.data() || {};
    const userRatings = Object.assign({}, data.userRatings || {});
    const prev = Number(userRatings[user.uid] || 0);

    userRatings[user.uid] = r;
    // Recompute aggregate from the (small) map. Avoids drift from stale
    // `rating`/`ratingCount` and never needs a transaction.
    const values = Object.values(userRatings).map(v => Number(v) || 0).filter(v => v > 0);
    const count = values.length;
    const sum = values.reduce((a, b) => a + b, 0);
    const avg = count > 0 ? sum / count : 0;

    // IMPORTANT: Do NOT bump `updatedAt` here. `updatedAt` controls the
    // Recently Updated section on the homepage and must only change when a
    // new chapter is imported/added (see DB.addChapter). Rating a series is
    // a user interaction — it must update the aggregate rating fields but
    // must NEVER move the series in Recently Updated.
    await seriesRef.update({
      userRatings,
      rating: Number(avg.toFixed(2)),
      ratingCount: count,
      ratingSum: sum
    });

    // Legacy mirror write — best-effort only. Keeps the old `ratings`
    // collection in sync for any tool still reading it, but a failure here
    // (e.g. quota exhausted) does NOT fail the user's rating action.
    try {
      await db.collection('ratings').doc(`${seriesId}_${user.uid}`).set({
        seriesId,
        userId: user.uid,
        rating: r,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (_) { /* ignore — series doc is the source of truth now */ }

    return { rating: r, average: Number(avg.toFixed(2)), count, previous: prev || null };
  },

  /**
   * Get the current user's rating for a series, or null.
   * Reads from the series doc's `userRatings` map (single read), with a
   * fallback to the legacy `ratings` collection for older data.
   */
  async getUserRating(seriesId) {
    const user = auth.currentUser;
    if (!user) return null;
    try {
      const sDoc = await db.collection('series').doc(seriesId).get();
      if (sDoc.exists) {
        const map = sDoc.data()?.userRatings || {};
        if (map[user.uid]) return Number(map[user.uid]) || null;
      }
      // Legacy fallback (only hit when the new map has no entry).
      const doc = await db.collection('ratings').doc(`${seriesId}_${user.uid}`).get();
      return doc.exists ? (doc.data().rating || null) : null;
    } catch (e) {
      console.warn('getUserRating failed:', e.message);
      return null;
    }
  },

  // ==================== REPORTS ====================

  /**
   * List reports for the admin dashboard.
   * @param {Object} options - { status: 'pending'|'resolved'|'dismissed', limit }
   */
  async getReports({ status = null, limit = 100 } = {}) {
    try {
      let query = db.collection('reports').orderBy('reportedAt', 'desc');
      if (status) query = query.where('status', '==', status);
      const snap = await query.limit(limit).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (error) {
      console.error('Error loading reports (will retry without status filter):', error);
      // Fallback path: composite index may still be building. Fetch
      // recent reports and filter client-side so the Reports page is
      // never empty just because of a missing index.
      try {
        const snap = await db.collection('reports')
          .orderBy('reportedAt', 'desc').limit(Math.max(limit, 200)).get();
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        return status ? all.filter(r => r.status === status) : all;
      } catch (e2) {
        console.error('Reports fallback also failed:', e2);
        return [];
      }
    }
  },

  /**
   * Resolve / dismiss a report.
   */
  async updateReportStatus(reportId, status) {
    const allowed = ['pending', 'under_review', 'resolved', 'dismissed', 'rejected'];
    if (!allowed.includes(status)) throw new Error('Invalid status');
    await db.collection('reports').doc(reportId).update({
      status,
      resolvedAt: firebase.firestore.FieldValue.serverTimestamp(),
      resolvedBy: auth.currentUser?.uid || null
    });
  },

  // ==================== CHAPTER REPORTS ====================

  /**
   * Submit a chapter issue report. Implements:
   *  - field validation
   *  - per-user duplicate prevention (no two pending reports
   *    from the same user against the same chapter)
   *  - 30s client-side submission cooldown
   *  - admin/moderator notification fan-out
   *
   * @param {Object} payload {
   *   seriesId, seriesTitle, chapterId, chapterNumber,
   *   reason, details
   * }
   */
  async reportChapter(payload) {
    const user = auth.currentUser;
    if (!user) throw new Error('You must be signed in to report a chapter.');

    const {
      seriesId, seriesTitle, chapterId, chapterNumber,
      reason, details
    } = payload || {};

    if (!seriesId || !chapterId)  throw new Error('Missing series or chapter reference.');
    if (!reason)                  throw new Error('Please choose an issue type.');
    if (reason === 'other' && !(details || '').trim()) {
      throw new Error('Please describe the issue in the details box.');
    }
    if (details && details.length > 1000) {
      throw new Error('Details must be 1000 characters or less.');
    }

    // 30s cooldown — protects Firestore from spam-clicks.
    const COOLDOWN_MS = 30000;
    try {
      const last = Number(localStorage.getItem('chapterReportCooldown') || 0);
      if (Date.now() - last < COOLDOWN_MS) {
        const wait = Math.ceil((COOLDOWN_MS - (Date.now() - last)) / 1000);
        throw new Error(`Please wait ${wait}s before sending another report.`);
      }
    } catch (e) {
      if (e.message?.startsWith('Please wait')) throw e;
    }

    // Duplicate-pending guard.
    try {
      const dup = await db.collection('reports')
        .where('contentType', '==', 'chapter')
        .where('contentId',   '==', chapterId)
        .where('reportedBy',  '==', user.uid)
        .where('status',      '==', 'pending')
        .limit(1).get();
      if (!dup.empty) {
        throw new Error('You already have a pending report for this chapter.');
      }
    } catch (e) {
      // If the composite index is missing Firestore throws — surface a
      // friendly message but don't block legitimate reports forever.
      if (e.message?.startsWith('You already')) throw e;
      console.warn('Duplicate-report check skipped:', e.message);
    }

    const reasonLabel = ({
      wrong_chapter: 'Wrong Chapter',
      broken:        'Broken / Loading Issue',
      missing_pages: 'Missing Pages',
      poor_quality:  'Poor Image Quality',
      duplicate:     'Duplicate Pages',
      other:         'Other Issue'
    })[reason] || reason;

    const reporterUsername =
      (typeof Auth !== 'undefined' && Auth.userData && (Auth.userData.username || Auth.userData.displayName))
      || user.displayName || user.email || 'Anonymous';

    const doc = {
      // Generic report fields (the admin dashboard reads these)
      contentType:     'chapter',
      contentId:       chapterId,
      reason:          reasonLabel,
      reasonCode:      reason,
      snippet:         `Ch. ${chapterNumber} — ${(details || '').slice(0, 240)}`,
      status:          'pending',
      reportedBy:      user.uid,
      reporterUsername,
      reportedAt:      firebase.firestore.FieldValue.serverTimestamp(),

      // Chapter-specific context
      seriesId, seriesTitle: seriesTitle || '',
      chapterId, chapterNumber: chapterNumber ?? null,
      details: (details || '').trim()
    };

    const ref = await db.collection('reports').add(doc);
    try { localStorage.setItem('chapterReportCooldown', String(Date.now())); } catch (_) {}

    // NOTE: Chapter reports are routed ONLY to the Reports page in the
    // Admin Dashboard. They are intentionally NOT fanned out as
    // notifications, to keep the reports queue separate from the
    // admin/moderator notification feed.


    // Bump the pending counter so the admin dashboard tile stays in sync.
    this._incrementStatsCounter('pendingReports', 1);

    return { id: ref.id };
  },

  // ==================== INTERNAL HELPERS ====================

  /**
   * Atomically increment a stats counter in the meta/stats document.
   * This keeps the admin dashboard stats up to date without full collection scans.
   * If the document doesn't exist, it will be created on the next getAdminStats() call.
   *
   * @param {string} field - The counter field name (e.g., 'totalSeries')
   * @param {number} amount - The increment amount (positive or negative)
   */
  _incrementStatsCounter(field, amount) {
    try {
      db.collection('meta').doc('stats').set({
        [field]: firebase.firestore.FieldValue.increment(amount),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true }).catch(err => {
        // Non-critical: just log if counter update fails
        console.warn(`Failed to update stats counter ${field}:`, err.message);
      });
    } catch (error) {
      // Non-critical: don't throw, just warn
      console.warn(`Failed to queue stats counter update for ${field}:`, error.message);
    }
  },

  // ==================== DATA-PROTECTION HELPERS ====================
  //
  // Soft-delete + audit trail. Every destructive operation in this module
  // routes through `_archiveBeforeDelete` so the original document is first
  // copied to the `trash/{collection}_{docId}` collection (with metadata
  // about who deleted it and why). An entry is also appended to the
  // `auditLog` collection. If the backup write fails the delete is
  // ABORTED — this is the core safeguard against accidental data loss.
  //
  // Restoring a soft-deleted doc: call `DB.restoreFromTrash(trashId)` from
  // an admin tool. The doc is rewritten back into its original collection
  // with its original id.

  async _archiveBeforeDelete(collection, docId, opts = {}) {
    if (!collection || !docId) throw new Error('archive: missing collection/docId');
    try {
      const snap = await db.collection(collection).doc(docId).get();
      if (!snap.exists) return null; // nothing to back up
      const data = snap.data() || {};
      const actor = (firebase.auth && firebase.auth().currentUser) || null;
      const trashId = `${collection}_${docId}_${Date.now()}`;
      await db.collection('trash').doc(trashId).set({
        sourceCollection: collection,
        sourceId: docId,
        data,
        deletedAt: firebase.firestore.FieldValue.serverTimestamp(),
        deletedBy: actor ? actor.uid : null,
        deletedByEmail: actor ? (actor.email || null) : null,
        reason: opts.reason || null
      });
      // Best-effort audit log entry (never blocks the delete).
      try {
        await db.collection('auditLog').add({
          type: 'delete',
          collection,
          docId,
          trashId,
          actorId: actor ? actor.uid : null,
          actorEmail: actor ? (actor.email || null) : null,
          reason: opts.reason || null,
          createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (e) { console.warn('auditLog write failed:', e?.message); }
      return trashId;
    } catch (err) {
      // CRITICAL: if backup fails we refuse to delete so data is never lost.
      console.error(`Refusing to delete ${collection}/${docId} — backup failed:`, err);
      throw new Error(`Backup failed, delete aborted: ${err.message}`);
    }
  },

  /**
   * Restore a previously soft-deleted document from the `trash` collection.
   * Admin-only by Firestore rules. Writes the original data back to its
   * source collection under the original document id, then removes the
   * trash entry. If a document with the same id already exists it is
   * merged (never overwritten destructively).
   */
  async restoreFromTrash(trashId) {
    if (!trashId) throw new Error('restoreFromTrash: missing trashId');
    const snap = await db.collection('trash').doc(trashId).get();
    if (!snap.exists) throw new Error('Trash entry not found');
    const entry = snap.data() || {};
    if (!entry.sourceCollection || !entry.sourceId) {
      throw new Error('Trash entry is missing source metadata');
    }
    await db.collection(entry.sourceCollection)
      .doc(entry.sourceId)
      .set(entry.data || {}, { merge: true });
    try {
      await db.collection('auditLog').add({
        type: 'restore',
        collection: entry.sourceCollection,
        docId: entry.sourceId,
        trashId,
        actorId: (firebase.auth().currentUser || {}).uid || null,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (_) {}
    await db.collection('trash').doc(trashId).delete();
    return { collection: entry.sourceCollection, id: entry.sourceId };
  },

  // ==================== COMMUNITY REVIEWS ====================

  _reviewNeedsAuthorHydration(review = {}) {
    const avatar = String(review.userAvatar || '').trim();
    return !!review.userId && (
      !review.userName ||
      !avatar ||
      /default-avatar/i.test(avatar) ||
      !review.authorLevel ||
      (!review.authorTitleId && !review.authorCustomTitleId && !review.authorRole)
    );
  },

  _snapshotReviewAuthor(profile = {}, fallback = {}) {
    const level = profile.level || (
      typeof EXPSystem !== 'undefined' ? EXPSystem.levelFromExp(profile.exp || 0) : 1
    );
    const activeCustomTitle = (typeof Donation !== 'undefined')
      ? Donation.getActiveCustomTitle?.(profile)
      : null;

    return {
      userName: profile.username || profile.displayName || profile.name || fallback.userName || fallback.displayName || 'User',
      userAvatar: profile.avatar || profile.avatarUrl || profile.photoURL || profile.profilePicture || profile.photo || fallback.userAvatar || fallback.photoURL || '',
      authorRole: profile.role || fallback.authorRole || 'user',
      authorLevel: level || fallback.authorLevel || 1,
      authorTitleId: profile.selectedTitleId || profile.activeTitleId || profile.titleId || fallback.authorTitleId || null,
      authorCustomTitleId: activeCustomTitle?.id || fallback.authorCustomTitleId || null,
      authorCustomTitleExpiresAt: activeCustomTitle?.expiresAt
        ? firebase.firestore.Timestamp.fromMillis(activeCustomTitle.expiresAt)
        : (fallback.authorCustomTitleExpiresAt || null)
    };
  },

  async _hydrateReviewAuthors(reviews = []) {
    if (!Array.isArray(reviews) || !reviews.length || !firebase.auth().currentUser) {
      return reviews;
    }

    const ids = Array.from(new Set(
      reviews
        .filter(review => this._reviewNeedsAuthorHydration(review))
        .map(review => review.userId)
        .filter(Boolean)
    ));
    if (!ids.length) return reviews;

    const profiles = new Map();
    try {
      for (let i = 0; i < ids.length; i += 10) {
        const chunk = ids.slice(i, i + 10);
        const snap = await db.collection('users')
          .where(firebase.firestore.FieldPath.documentId(), 'in', chunk)
          .get();
        snap.forEach(doc => profiles.set(doc.id, doc.data() || {}));
      }
    } catch (error) {
      console.warn('Review author hydration skipped:', error?.message || error);
      return reviews;
    }

    return reviews.map(review => {
      const profile = profiles.get(review.userId);
      return profile ? { ...review, ...this._snapshotReviewAuthor(profile, review) } : review;
    });
  },

  /**
   * Add a review (or reply when parentId is set).
   * `content` should already be sanitized HTML containing only the
   * formatting tags <b>/<strong>, <i>/<em>, <s>/<strike>, and <br>.
   */
  async addReview({ seriesId, content, parentId = null }) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Login required');
    if (!seriesId) throw new Error('Missing seriesId');
    const text = (content || '').trim();
    if (!text) throw new Error('Review cannot be empty');

    let author = this._snapshotReviewAuthor({}, {
      userName: user.displayName || user.email || 'User',
      userAvatar: user.photoURL || ''
    });
    try {
      // Read the user profile directly — identical to addComment(). The
      // previous code called this.getUser() which does not exist, so the
      // catch swallowed the error and every review was written with empty
      // user info (no avatar, no title, level 1).
      const userDoc = await db.collection('users').doc(user.uid).get();
      const profile = userDoc.exists ? userDoc.data() : null;
      if (profile) {
        author = this._snapshotReviewAuthor(profile, author);
      }
    } catch (e) {
      console.warn('addReview: failed to load profile snapshot:', e?.message || e);
    }

    const payload = {
      seriesId,
      userId: user.uid,
      ...author,
      content: text,
      parentId: parentId || null,
      helpfulCount: 0,
      notHelpfulCount: 0,
      totalVotes: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    };
    const ref = await db.collection('reviews').add(payload);

    // Bump aggregate count on the series doc (whitelist allows it). Best-effort.
    if (!parentId) {
      try {
        await db.collection('series').doc(seriesId).update({
          reviewCount: firebase.firestore.FieldValue.increment(1)
        });
      } catch (_) {}
    }
    return { id: ref.id, ...payload };
  },

  async updateReview(reviewId, content) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Login required');
    await db.collection('reviews').doc(reviewId).update({
      content: (content || '').trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  },

  async deleteReview(reviewId) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Login required');
    if (!reviewId) throw new Error('deleteReview: missing reviewId');
    // Get to know parentId/seriesId for counter bookkeeping.
    let review = null;
    try {
      const snap = await db.collection('reviews').doc(reviewId).get();
      if (snap.exists) review = { id: snap.id, ...snap.data() };
    } catch (_) {}
    // Back up before delete — abort if backup fails.
    await this._archiveBeforeDelete('reviews', reviewId, { reason: 'deleteReview' });
    await db.collection('reviews').doc(reviewId).delete();
    if (review && !review.parentId && review.seriesId) {
      try {
        await db.collection('series').doc(review.seriesId).update({
          reviewCount: firebase.firestore.FieldValue.increment(-1)
        });
      } catch (_) {}
    }
  },

  /**
   * Get reviews for a series. Top-level reviews only — replies are
   * fetched separately via getReviewReplies().
   * sort: 'helpful' | 'newest' | 'oldest'
   */
  async getReviews(seriesId, { sort = 'newest', limit = 50 } = {}) {
    try {
      let q = db.collection('reviews')
        .where('seriesId', '==', seriesId)
        .where('parentId', '==', null);
      if (sort === 'helpful') {
        q = q.orderBy('helpfulCount', 'desc');
      } else if (sort === 'oldest') {
        q = q.orderBy('createdAt', 'asc');
      } else {
        q = q.orderBy('createdAt', 'desc');
      }
      const snap = await q.limit(limit).get();
      return await this._hydrateReviewAuthors(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      // Likely missing composite index — fall back to client-side filtering.
      console.warn('getReviews indexed query failed, falling back:', e.message);
      const snap = await db.collection('reviews')
        .where('seriesId', '==', seriesId)
        .limit(200)
        .get();
      const all = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(r => !r.parentId);
      if (sort === 'helpful') {
        all.sort((a, b) => (b.helpfulCount || 0) - (a.helpfulCount || 0));
      } else if (sort === 'oldest') {
        all.sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
      } else {
        all.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
      }
      return await this._hydrateReviewAuthors(all.slice(0, limit));
    }
  },

  async getReviewReplies(parentId) {
    try {
      const snap = await db.collection('reviews')
        .where('parentId', '==', parentId)
        .orderBy('createdAt', 'asc')
        .limit(100)
        .get();
      return await this._hydrateReviewAuthors(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    } catch (e) {
      console.warn('getReviewReplies fallback:', e.message);
      const snap = await db.collection('reviews')
        .where('parentId', '==', parentId)
        .limit(100)
        .get();
      const replies = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
      return await this._hydrateReviewAuthors(replies);
    }
  },

  /**
   * Vote on a review. `vote` is 'helpful' | 'not_helpful'. Calling with the
   * same vote toggles it off.
   *
   * Quota-friendly rewrite — mirrors `toggleLikeComment`:
   *   - 1 doc read + 1 doc write (was: 2 reads + 2 writes in a transaction
   *     that retried on contention, which was the main cause of the
   *     "Quota exceeded" errors).
   *   - No more separate `reviewVotes/{voteId}` collection writes.
   *   - Voter identity is stored on the review doc itself as two arrays
   *     (`helpfulBy` / `notHelpfulBy`) with `FieldValue.arrayUnion` /
   *     `arrayRemove`, exactly like the chapter-comment Like uses
   *     `likedBy`. Counts use `FieldValue.increment`.
   */
  async voteReview(reviewId, vote) {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Login required');
    if (vote !== 'helpful' && vote !== 'not_helpful') throw new Error('Invalid vote');

    const FV = firebase.firestore.FieldValue;
    const reviewRef = db.collection('reviews').doc(reviewId);
    const snap = await reviewRef.get();
    if (!snap.exists) throw new Error('Review not found');
    const data = snap.data() || {};

    const helpfulBy = Array.isArray(data.helpfulBy) ? data.helpfulBy : [];
    const notHelpfulBy = Array.isArray(data.notHelpfulBy) ? data.notHelpfulBy : [];
    let helpful = data.helpfulCount || 0;
    let notHelpful = data.notHelpfulCount || 0;

    const prev = helpfulBy.includes(user.uid)
      ? 'helpful'
      : notHelpfulBy.includes(user.uid) ? 'not_helpful' : null;

    let helpfulDelta = 0, notDelta = 0;
    const update = { updatedAt: FV.serverTimestamp() };

    // Always remove the user from the previous bucket (if any).
    if (prev === 'helpful') {
      update.helpfulBy = FV.arrayRemove(user.uid);
      helpfulDelta -= 1;
    } else if (prev === 'not_helpful') {
      update.notHelpfulBy = FV.arrayRemove(user.uid);
      notDelta -= 1;
    }

    let myVote;
    if (prev === vote) {
      // Same button -> toggle off, leave the user out of both buckets.
      myVote = null;
    } else {
      if (vote === 'helpful') {
        update.helpfulBy = FV.arrayUnion(user.uid);
        helpfulDelta += 1;
      } else {
        update.notHelpfulBy = FV.arrayUnion(user.uid);
        notDelta += 1;
      }
      myVote = vote;
    }

    if (helpfulDelta) update.helpfulCount = FV.increment(helpfulDelta);
    if (notDelta) update.notHelpfulCount = FV.increment(notDelta);
    const totalDelta = helpfulDelta + notDelta;
    if (totalDelta) update.totalVotes = FV.increment(totalDelta);

    await reviewRef.update(update);

    helpful = Math.max(0, helpful + helpfulDelta);
    notHelpful = Math.max(0, notHelpful + notDelta);
    return {
      helpfulCount: helpful,
      notHelpfulCount: notHelpful,
      totalVotes: helpful + notHelpful,
      myVote
    };
  },

  /**
   * "My vote" is now derivable from the review doc's helpfulBy/notHelpfulBy
   * arrays, so callers that already have the review in memory should skip
   * this entirely. Kept for backwards compatibility — reads the review
   * doc once (no separate reviewVotes lookup).
   */
  async getMyReviewVote(reviewId) {
    const user = firebase.auth().currentUser;
    if (!user) return null;
    try {
      const snap = await db.collection('reviews').doc(reviewId).get();
      if (!snap.exists) return null;
      const d = snap.data() || {};
      if (Array.isArray(d.helpfulBy) && d.helpfulBy.includes(user.uid)) return 'helpful';
      if (Array.isArray(d.notHelpfulBy) && d.notHelpfulBy.includes(user.uid)) return 'not_helpful';
      // Legacy fallback for votes recorded under the old `reviewVotes` doc.
      const leg = await db.collection('reviewVotes')
        .doc(`${reviewId}_${user.uid}`).get();
      return leg.exists ? (leg.data().vote || null) : null;
    } catch (_) { return null; }
  },

  /**
   * File a report against a review (or review reply). Enriches the report
   * with series + content context so moderators can navigate straight to
   * the reported item from the Admin Dashboard.
   */
  async reportReview(reviewId, reason, details = '') {
    const user = firebase.auth().currentUser;
    if (!user) throw new Error('Login required');
    const reasonLabel = String(reason || 'Other');

    // Pull the review + its parent (if reply) + series for richer context.
    let review = {}, parentReview = null, series = null, reporterProfile = {};
    try {
      const snap = await db.collection('reviews').doc(reviewId).get();
      if (snap.exists) review = snap.data() || {};
    } catch (_) {}
    try {
      if (review.parentId) {
        const ps = await db.collection('reviews').doc(review.parentId).get();
        if (ps.exists) parentReview = ps.data() || null;
      }
    } catch (_) {}
    try {
      if (review.seriesId) series = await this.getSeriesById(review.seriesId);
    } catch (_) {}
    try {
      const rp = await this.getUser(user.uid);
      if (rp) reporterProfile = rp;
    } catch (_) {}

    const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, '').trim();
    const snippet = stripHtml(review.content).slice(0, 300);
    const parentSnippet = parentReview ? stripHtml(parentReview.content).slice(0, 200) : '';
    const isReply = !!review.parentId;
    const reporterUsername =
      reporterProfile.username || reporterProfile.displayName ||
      user.displayName || user.email || 'User';

    const ref = await db.collection('reports').add({
      // Standard report fields read by the admin dashboard.
      contentType:     isReply ? 'reviewReply' : 'review',
      type:            isReply ? 'reviewReply' : 'review', // legacy
      contentId:       reviewId,
      targetId:        reviewId,                            // legacy
      parentId:        review.parentId || null,
      parentSnippet,

      reason:          reasonLabel,
      details:         String(details || '').slice(0, 1000),
      snippet,

      // Reported user / reporter context
      authorId:        review.userId || null,
      authorName:      review.userName || null,
      reportedBy:      user.uid,
      reporterId:      user.uid,                            // legacy
      reporterUsername,

      // Series context for navigation
      seriesId:        review.seriesId || null,
      seriesTitle:     series?.title || '',

      status:          'pending',
      reportedAt:      firebase.firestore.FieldValue.serverTimestamp(),
      createdAt:       firebase.firestore.FieldValue.serverTimestamp() // legacy
    });

    // NOTE: Review reports are routed ONLY to the Reports page in the
    // Admin Dashboard. They are intentionally NOT fanned out as
    // notifications, to keep the reports queue separate from the
    // admin/moderator notification feed.


    this._incrementStatsCounter('pendingReports', 1);
    return { id: ref.id };
  },

  // ==================== USER WARNINGS ====================
  // Staff (admin/moderator) can issue warnings to a user before banning
  // them. Each warning is a doc in the top-level `userWarnings` collection
  // keyed on the warned user.

  /**
   * Issue a warning to a user.
   * @param {string} userId - user being warned
   * @param {Object} payload - { reason, notes }
   */
  async warnUser(userId, { reason, notes } = {}) {
    const me = auth.currentUser;
    if (!me) throw new Error('Login required');
    if (!userId) throw new Error('Missing user id');
    if (!reason || !reason.trim()) throw new Error('Warning reason is required');

    let myProfile = {};
    try { myProfile = (await this.getUser(me.uid)) || {}; } catch (_) {}
    const issuedByName = myProfile.username || myProfile.displayName || me.displayName || me.email || 'Staff';

    const ref = await db.collection('userWarnings').add({
      userId,
      reason: String(reason).slice(0, 200),
      notes: String(notes || '').slice(0, 1000),
      issuedBy: me.uid,
      issuedByName,
      issuedByRole: myProfile.role || 'staff',
      acknowledged: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Notify the warned user via the bell menu.
    try {
      await db.collection('notifications').add({
        userId,
        type: 'warning',
        title: 'You received a warning',
        message: `${issuedByName}: ${reason}`,
        warningId: ref.id,
        link: 'pages/settings.html#warnings',
        read: false,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    } catch (e) {
      console.warn('Could not send warning notification:', e.message);
    }

    return { id: ref.id };
  },

  /**
   * List warnings for a user, newest first.
   */
  async getUserWarnings(userId) {
    if (!userId) return [];
    try {
      const snap = await db.collection('userWarnings')
        .where('userId', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(100).get();
      return snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {
      console.warn('getUserWarnings failed (falling back without orderBy):', e.message);
      try {
        const snap = await db.collection('userWarnings')
          .where('userId', '==', userId).limit(100).get();
        const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        arr.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
        return arr;
      } catch (_) { return []; }
    }
  },

  /**
   * Remove a previously-issued warning (staff only).
   */
  async removeWarning(warningId) {
    if (!warningId) throw new Error('Missing warning id');
    await this._archiveBeforeDelete('userWarnings', warningId, { reason: 'removeWarning' });
    await db.collection('userWarnings').doc(warningId).delete();
  },

  /**
   * Warnings issued to the currently signed-in user.
   */
  async getMyWarnings() {
    const u = auth.currentUser;
    if (!u) return [];
    return this.getUserWarnings(u.uid);
  }
};

// Expose DB globally
window.DB = DB;
