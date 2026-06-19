/**
 * ============================================================
 * MANHWA PLATFORM - EXP / LEVEL / TITLES / FOLLOW SYSTEM
 * ============================================================
 * Pure additive module. Does NOT modify existing data shapes; it only
 * adds new fields to the user document:
 *
 *   exp                : number   - total accumulated experience points
 *   level              : number   - derived level (cached for sorting)
 *   selectedTitleId    : string   - id of the title displayed next to name
 *   unlockedTitleIds   : string[] - titles the user has unlocked
 *   followingUsers     : string[] - uids this user follows
 *   dailyStreak        : number   - consecutive days with reading activity
 *   lastReadDate       : string   - YYYY-MM-DD of last reading activity
 *   chaptersReadCount  : number   - total chapters finished (lifetime)
 *
 * Existing data (favorites, history, comments, etc.) is untouched.
 * ============================================================
 */

const EXPSystem = {
  // ---------- Configuration ----------

  // Base XP awarded for finishing a chapter.
  BASE_CHAPTER_XP: 10,
  // Bonus for the first chapter read on a given day.
  DAILY_FIRST_XP: 20,
  // Bonus per consecutive day in a streak (capped).
  STREAK_BONUS_PER_DAY: 5,
  STREAK_BONUS_CAP: 50,

  // Cumulative XP required to REACH each level.
  // level 1 = 0xp, level 2 = 100xp, level 3 = 250xp, ...
  // formula: cum(n) = 50 * (n-1) * n  -> 0, 100, 300, 600, 1000, ...
  xpForLevel(n) { return 50 * (n - 1) * n; },

  levelFromExp(exp) {
    let lv = 1;
    while (this.xpForLevel(lv + 1) <= exp) lv++;
    return lv;
  },

  progressForExp(exp) {
    const lv = this.levelFromExp(exp);
    const curr = this.xpForLevel(lv);
    const next = this.xpForLevel(lv + 1);
    return {
      level: lv,
      currentExp: exp,
      levelStart: curr,
      levelEnd: next,
      intoLevel: exp - curr,
      neededForNext: next - curr,
      percent: Math.min(100, ((exp - curr) / (next - curr)) * 100)
    };
  },

  /**
   * Title catalog. `effect` controls the visual badge style:
   *   plain | shine | glow | rainbow | legend
   * `unlock` is either {level: N} or {chapters: N} or {streak: N}.
   */
  TITLES: [
    { id: 'new_reader',     label: 'New Reader',        unlock: { level: 1 },     effect: 'plain' },
    { id: 'casual_reader',  label: 'Casual Reader',     unlock: { level: 5 },     effect: 'plain' },
    { id: 'avid_reader',    label: 'Avid Reader',       unlock: { level: 10 },    effect: 'shine' },
    { id: 'enthusiast',     label: 'Manhwa Enthusiast', unlock: { level: 20 },    effect: 'shine' },
    { id: 'scholar',        label: 'Manhwa Scholar',    unlock: { level: 30 },    effect: 'glow' },
    { id: 'expert',         label: 'Manhwa Expert',     unlock: { level: 50 },    effect: 'glow' },
    { id: 'sage',           label: 'Manhwa Sage',       unlock: { level: 75 },    effect: 'rainbow' },
    { id: 'legend',         label: 'Manhwa Legend',     unlock: { level: 100 },   effect: 'legend' },
    // Milestone titles
    { id: 'page_turner',    label: 'Page Turner',       unlock: { chapters: 50 },  effect: 'shine' },
    { id: 'century',        label: 'Century Reader',    unlock: { chapters: 100 }, effect: 'glow' },
    { id: 'marathon',       label: 'Marathon Reader',   unlock: { chapters: 500 }, effect: 'rainbow' },
    { id: 'insatiable',     label: 'Insatiable',        unlock: { chapters: 1000 },effect: 'legend' },
    // Streak titles
    { id: 'dedicated',      label: 'Dedicated',         unlock: { streak: 7 },     effect: 'shine' },
    { id: 'unwavering',     label: 'Unwavering',        unlock: { streak: 30 },    effect: 'rainbow' },
    // Admin-granted titles. These cannot be unlocked through levels,
    // achievements, or reading progress. Only an admin can grant them
    // through the Admin Dashboard (see Donation.grantTitle).
    { id: 'donator',        label: 'DONATOR',           unlock: { adminGranted: true }, effect: 'donator' }
  ],

  getTitle(id) {
    return this.TITLES.find(t => t.id === id) || null;
  },

  // ---------- Public API ----------

  /**
   * Called when a user finishes a chapter. Awards XP, updates streak,
   * unlocks any newly available titles, and emits a toast/level-up modal.
   */
  async onChapterRead(seriesId, chapterId) {
    const user = (typeof auth !== 'undefined') ? auth.currentUser : null;
    if (!user) return;

    try {
      const userRef = db.collection('users').doc(user.uid);
      const today = this._today();

      // Read once so we can compute streak + dedupe per chapter.
      const snap = await userRef.get();
      const data = snap.data() || {};

      // Dedupe: EXP is awarded at most once per chapter, tracked via a
      // dedicated `expAwardedChapters` map. We deliberately do NOT reuse
      // `readChapters` here because that flag is set the moment a chapter
      // page opens (for the "Read" badge), which would block XP from ever
      // being awarded after the 1-minute dwell timer fires.
      const awardedMap = data.expAwardedChapters || {};
      const awardedList = Array.isArray(awardedMap[seriesId]) ? awardedMap[seriesId] : [];
      if (awardedList.includes(chapterId)) {
        return;
      }

      // Streak handling.
      const lastDate = data.lastReadDate || null;
      let streak = data.dailyStreak || 0;
      let dailyBonus = 0;
      if (lastDate !== today) {
        if (lastDate && this._isYesterday(lastDate, today)) {
          streak += 1;
        } else {
          streak = 1;
        }
        dailyBonus = this.DAILY_FIRST_XP + Math.min(this.STREAK_BONUS_CAP, streak * this.STREAK_BONUS_PER_DAY);
      }

      const xpGained = this.BASE_CHAPTER_XP + dailyBonus;
      const prevExp = data.exp || 0;
      const prevLevel = this.levelFromExp(prevExp);
      const newExp = prevExp + xpGained;
      const newLevel = this.levelFromExp(newExp);
      const newCount = (data.chaptersReadCount || 0) + 1;

      // Title unlocks
      const previouslyUnlocked = new Set(data.unlockedTitleIds || []);
      const newlyUnlocked = [];
      for (const t of this.TITLES) {
        if (previouslyUnlocked.has(t.id)) continue;
        const u = t.unlock || {};
        if ((u.level && newLevel >= u.level) ||
            (u.chapters && newCount >= u.chapters) ||
            (u.streak && streak >= u.streak)) {
          previouslyUnlocked.add(t.id);
          newlyUnlocked.push(t);
        }
      }

      const updates = {
        exp: newExp,
        level: newLevel,
        chaptersReadCount: newCount,
        dailyStreak: streak,
        lastReadDate: today,
        unlockedTitleIds: Array.from(previouslyUnlocked),
        // Mark this chapter as having paid out EXP so future loads of the
        // same chapter don't double-award.
        expAwardedChapters: {
          [seriesId]: firebase.firestore.FieldValue.arrayUnion(chapterId)
        }
      };
      if (!data.selectedTitleId && previouslyUnlocked.size > 0) {
        updates.selectedTitleId = Array.from(previouslyUnlocked)[0];
      }

      await userRef.set(updates, { merge: true });

      // Notifications (toast)
      if (typeof showToast === 'function') {
        showToast(`+${xpGained} EXP${dailyBonus ? ' (daily bonus!)' : ''}`, 'success');
        if (newLevel > prevLevel) {
          showToast(`Level up! You are now Level ${newLevel}`, 'success');
        }
        for (const t of newlyUnlocked) {
          showToast(`Title unlocked: ${t.label}`, 'success');
        }
      }
    } catch (err) {
      console.error('[EXPSystem] onChapterRead failed:', err);
    }
  },

  /**
   * Set the title the user displays on comments.
   */
  async setSelectedTitle(titleId) {
    const user = auth.currentUser;
    if (!user) throw new Error('Not logged in');
    const snap = await db.collection('users').doc(user.uid).get();
    const unlocked = snap.data()?.unlockedTitleIds || [];
    if (titleId && !unlocked.includes(titleId)) throw new Error('Title not unlocked');
    await db.collection('users').doc(user.uid).set(
      { selectedTitleId: titleId || null }, { merge: true }
    );
  },

  /**
   * Follow another user (by uid).
   */
  async followUser(targetUid) {
    const user = auth.currentUser;
    if (!user) throw new Error('Not logged in');
    if (user.uid === targetUid) throw new Error("You can't follow yourself");
    await db.collection('users').doc(user.uid).set({
      followingUsers: firebase.firestore.FieldValue.arrayUnion(targetUid)
    }, { merge: true });
  },

  async unfollowUser(targetUid) {
    const user = auth.currentUser;
    if (!user) return;
    await db.collection('users').doc(user.uid).set({
      followingUsers: firebase.firestore.FieldValue.arrayRemove(targetUid)
    }, { merge: true });
  },

  async isFollowing(targetUid) {
    const user = auth.currentUser;
    if (!user) return false;
    const snap = await db.collection('users').doc(user.uid).get();
    return (snap.data()?.followingUsers || []).includes(targetUid);
  },

  async getFollowerCount(uid) {
    try {
      const snap = await db.collection('users')
        .where('followingUsers', 'array-contains', uid).get();
      return snap.size;
    } catch { return 0; }
  },

  async getFollowing(uid) {
    const snap = await db.collection('users').doc(uid).get();
    return snap.data()?.followingUsers || [];
  },

  /**
   * Fetch public profile for any user.
   */
  async getPublicProfile(uid) {
    const snap = await db.collection('users').doc(uid).get();
    if (!snap.exists) return null;
    const d = snap.data();
    return {
      uid,
      username: d.username || 'User',
      avatar: d.avatar || '/images/default-avatar.png',
      coverImage: d.coverImage || '',
      bio: d.bio || '',
      role: d.role || 'user',
      exp: d.exp || 0,
      level: d.level || this.levelFromExp(d.exp || 0),
      selectedTitleId: d.selectedTitleId || null,
      unlockedTitleIds: d.unlockedTitleIds || [],
      chaptersReadCount: d.chaptersReadCount || (d.readingHistory?.length || 0),
      dailyStreak: d.dailyStreak || 0,
      favoritesCount: d.favorites?.length || 0,
      followingCount: d.followingUsers?.length || 0,
      favorites: d.favorites || [],
      followingUsers: d.followingUsers || [],
      readingHistory: d.readingHistory || []
    };
  },

  /**
   * Top users by EXP.
   */
  async getLeaderboard(limit = 50) {
    try {
      const snap = await db.collection('users')
        .orderBy('exp', 'desc').limit(limit).get();
      return snap.docs.map(d => {
        const x = d.data();
        return {
          uid: d.id,
          username: x.username || 'User',
          avatar: x.avatar || '/images/default-avatar.png',
          exp: x.exp || 0,
          level: x.level || this.levelFromExp(x.exp || 0),
          selectedTitleId: x.selectedTitleId || null,
          chaptersReadCount: x.chaptersReadCount || 0
        };
      });
    } catch (err) {
      console.error('[EXPSystem] leaderboard failed:', err);
      return [];
    }
  },

  // ---------- Rendering helpers ----------

  /**
   * HTML for a title badge. Safe to inject as innerHTML.
   */
  renderTitleBadge(titleId) {
    const t = this.getTitle(titleId);
    if (!t) return '';
    return `<span class="exp-title exp-title--${t.effect}" title="${t.label}">${t.label}</span>`;
  },

  renderLevelBadge(level) {
    if (!level) return '';
    return `<span class="exp-level-badge">Lv ${level}</span>`;
  },

  /**
   * HTML for an ADMIN / MODERATOR role badge. Matches the styling used in
   * comments.js / reviews.js (role-badge-admin / role-badge-moderator).
   */
  renderRoleBadge(role) {
    if (role === 'admin') {
      return `<span class="role-badge role-badge-admin" title="Administrator"><i class="fas fa-crown"></i> ADMIN</span>`;
    }
    if (role === 'moderator') {
      return `<span class="role-badge role-badge-moderator" title="Moderator"><i class="fas fa-shield-alt"></i> MOD</span>`;
    }
    return '';
  },

  // ---------- Internal ----------

  _today() {
    const d = new Date();
    return d.toISOString().slice(0, 10);
  },

  _isYesterday(prevYmd, todayYmd) {
    const t = new Date(todayYmd + 'T00:00:00Z');
    const y = new Date(t.getTime() - 86400000);
    return y.toISOString().slice(0, 10) === prevYmd;
  }
};

// Expose globally
if (typeof window !== 'undefined') window.EXPSystem = EXPSystem;
