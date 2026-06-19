/**
 * ============================================================
 * COMMUNITY DISCUSSION BOARD
 * ============================================================
 * Reuses the Chapter Comment Section (Comments module) for an
 * identical UI/UX: replies, mentions, reports, blocks, three-dot
 * menus, profile display, timestamps, and mobile responsiveness
 * all come "for free" from the existing comment system.
 *
 * On top of that, this module adds:
 *   - A virtual "chapter id" for the board (BOARD_ID)
 *   - Pin / Unpin support for admins & moderators (isPinned field)
 *   - "Pinned" badge + always-on-top ordering
 *   - Sort: New / Top
 *   - Rules modal (delegates to Comments.openRules())
 *
 * Everything else is plain comment behaviour — no existing
 * functionality is removed or changed.
 *
 * ------------------------------------------------------------
 * FREEZE FIX (Round 5)
 * ------------------------------------------------------------
 * Previously decorate() called list.prepend(p) which mutates the
 * commentsList. The MutationObserver watching that list fired
 * again, called decorate() again, which mutated the list again…
 * an infinite microtask loop that froze the whole page (and
 * blocked touch events on mobile because the main thread never
 * yielded).
 *
 * The fix:
 *   1. The observer is DISCONNECTED before any DOM mutation
 *      decorate() performs, then reconnected after.
 *   2. Decoration is re-entrancy guarded (_decorating flag).
 *   3. Decoration is debounced via requestAnimationFrame so a
 *      burst of mutations only triggers one pass.
 *   4. Pinned reorder is a no-op when the cards are already in
 *      the correct order (so even if the observer ever does fire
 *      we don't trigger another mutation).
 *   5. Observer only watches direct childList changes
 *      (subtree: false) — comment internals like dropdown toggles
 *      no longer schedule decoration work.
 * ============================================================
 */
(function () {
  'use strict';

  const BOARD_ID = '__community-discussion-board__';
  const PINNED_CACHE = new Set();

  const Discussion = {
    BOARD_ID,
    _mo: null,
    _decorating: false,
    _rafScheduled: false,

    init() {
      if (!window.Comments) {
        console.warn('[Discussion] Comments module not loaded');
        return;
      }

      // Boot the standard comments UI against the virtual board id.
      Comments.init(BOARD_ID);

      // Watch the rendered comment list and decorate it with pinned
      // badges, admin pin/unpin actions, and pinned-first ordering.
      const list = document.getElementById('commentsList');
      if (list) {
        this._mo = new MutationObserver(() => this._scheduleDecorate());
        this._observe();
      }

      // Initial decorate pass (after Comments.loadComments resolves)
      this._refreshPinnedCache().then(() => this._scheduleDecorate());

      // Wire sort buttons (data-discussion-sort) so we can re-apply
      // the "pinned first" ordering after every sort change.
      document.querySelectorAll('[data-discussion-sort]').forEach(btn => {
        btn.addEventListener('click', () => {
          document.querySelectorAll('[data-discussion-sort]')
            .forEach(b => b.classList.remove('active'));
          btn.classList.add('active');
          const sort = btn.dataset.discussionSort === 'top' ? 'mostLiked' : 'newest';
          Comments.changeSort(sort);
          // Re-decorate once the new render has settled. We use a
          // double rAF to land AFTER Comments.renderComments writes
          // the new innerHTML.
          requestAnimationFrame(() =>
            requestAnimationFrame(() => this._scheduleDecorate()));
        });
      });
    },

    _observe() {
      const list = document.getElementById('commentsList');
      if (this._mo && list) {
        // childList only — we don't care about edits inside a card.
        this._mo.observe(list, { childList: true, subtree: false });
      }
    },

    _disconnect() {
      if (this._mo) this._mo.disconnect();
    },

    _scheduleDecorate() {
      if (this._rafScheduled) return;
      this._rafScheduled = true;
      requestAnimationFrame(() => {
        this._rafScheduled = false;
        this.decorate();
      });
    },

    /**
     * Pull the (small) set of currently-pinned post ids so we don't
     * need a per-card read. Pinned discussions are typically a handful.
     */
    async _refreshPinnedCache() {
      try {
        const snap = await db.collection('comments')
          .where('chapterId', '==', BOARD_ID)
          .where('isPinned', '==', true)
          .get();
        PINNED_CACHE.clear();
        snap.forEach(d => PINNED_CACHE.add(d.id));
      } catch (e) {
        // Index may not exist yet — fall back to client-side scan
        try {
          const snap = await db.collection('comments')
            .where('chapterId', '==', BOARD_ID)
            .get();
          PINNED_CACHE.clear();
          snap.forEach(d => { if (d.data().isPinned) PINNED_CACHE.add(d.id); });
        } catch (_) {}
      }
    },

    /** Add pinned badges, admin Pin/Unpin actions, and re-order. */
    decorate() {
      if (this._decorating) return;
      const list = document.getElementById('commentsList');
      if (!list) return;
      const cards = Array.from(list.querySelectorAll(':scope > .comment-card'));
      if (!cards.length) return;

      this._decorating = true;
      // CRITICAL: stop the observer for the duration of our writes,
      // otherwise every prepend re-schedules another decorate() pass
      // and the page freezes.
      this._disconnect();

      try {
        const canPin = !!(window.Auth && Auth.hasRole && Auth.hasRole('moderator'));

        cards.forEach(card => {
          const id = card.dataset.commentId;
          if (!id) return;
          const isPinned = PINNED_CACHE.has(id);

          // Pinned badge in header (idempotent)
          if (isPinned && !card.querySelector('.discussion-pinned-badge')) {
            const badges = card.querySelector('.comment-badges');
            if (badges) {
              const span = document.createElement('span');
              span.className = 'discussion-pinned-badge';
              span.innerHTML = '<i class="fas fa-thumbtack"></i> PINNED';
              badges.prepend(span);
            }
            card.classList.add('comment-pinned');
          } else if (!isPinned) {
            const stale = card.querySelector('.discussion-pinned-badge');
            if (stale) stale.remove();
            card.classList.remove('comment-pinned');
          }

          // Admin/Mod Pin or Unpin menu item (idempotent — refresh label)
          if (canPin) {
            const dropdown = card.querySelector('.comment-menu-dropdown');
            if (dropdown) {
              let btn = dropdown.querySelector('[data-pin-action]');
              if (!btn) {
                btn = document.createElement('button');
                btn.className = 'menu-item';
                btn.setAttribute('data-pin-action', '');
                btn.addEventListener('click', () => {
                  const currentlyPinned = PINNED_CACHE.has(id);
                  this.togglePin(id, !currentlyPinned);
                });
                dropdown.prepend(btn);
              }
              btn.innerHTML = isPinned
                ? '<i class="fas fa-thumbtack"></i> Unpin'
                : '<i class="fas fa-thumbtack"></i> Pin to top';
            }
          }
        });

        // Compute desired order: pinned first (preserving their relative
        // order), then everything else in current order. Only mutate the
        // DOM if the current order doesn't already match — this prevents
        // unnecessary reflows AND ensures a no-op when re-running.
        const desired = [
          ...cards.filter(c => PINNED_CACHE.has(c.dataset.commentId)),
          ...cards.filter(c => !PINNED_CACHE.has(c.dataset.commentId)),
        ];
        const currentOrder = Array.from(list.children);
        let sameOrder = currentOrder.length === desired.length;
        if (sameOrder) {
          for (let i = 0; i < desired.length; i++) {
            if (currentOrder[i] !== desired[i]) { sameOrder = false; break; }
          }
        }
        if (!sameOrder) {
          const frag = document.createDocumentFragment();
          desired.forEach(n => frag.appendChild(n));
          list.appendChild(frag);
        }
      } finally {
        this._decorating = false;
        // Re-attach observer for future Comments-driven changes.
        this._observe();
      }
    },

    async togglePin(id, makePinned) {
      try {
        await db.collection('comments').doc(id).update({ isPinned: !!makePinned });
        if (makePinned) PINNED_CACHE.add(id); else PINNED_CACHE.delete(id);
        if (typeof showToast === 'function') {
          showToast(makePinned ? 'Post pinned' : 'Post unpinned', 'success');
        }
        this._scheduleDecorate();
      } catch (e) {
        console.error('[Discussion] pin toggle failed', e);
        if (typeof showToast === 'function') showToast('Failed to update pin', 'error');
      }
    },

    openRules() {
      if (window.Comments && Comments.openRules) Comments.openRules();
    }
  };

  window.Discussion = Discussion;
})();
