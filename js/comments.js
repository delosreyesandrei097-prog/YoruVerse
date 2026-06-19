/**
 * ============================================================
 * MANHWA PLATFORM - COMMENTS/DISCUSSION MODULE
 * ============================================================
 * Handles chapter discussion system with:
 * - Creating comments and replies
 * - Liking comments
 * - Editing/deleting own comments
 * - Real-time updates
 * - Sorting (newest, oldest, most liked)
 * - Nested replies
 * ============================================================
 */

const Comments = {
  chapterId: null,
  currentSort: 'newest',
  lastCursor: null,
  hasMore: true,
  isLoading: false,
  unsubscribe: null,

  /**
   * Initialize comments section
   */
  init(chapterId) {
    this.chapterId = chapterId;
    this.currentSort = 'newest';
    this.lastCursor = null;
    this.hasMore = true;
    this.isLoading = false;

    this.bindEvents();
    // Make sure inline-image CSS is present before any comment renders.
    if (typeof this._ensureImageStyles === 'function') this._ensureImageStyles();
    // Hydrate blocked-users list from the user's profile (cross-device sync),
    // THEN load comments so blocks apply immediately on first render.
    this._hydrateBlockedFromProfile().finally(() => this.loadComments());
    this.setupRealtimeUpdates();
  },

  async _hydrateBlockedFromProfile() {
    try {
      if (!auth.currentUser) return;
      const snap = await db.collection('users').doc(auth.currentUser.uid).get();
      const remote = snap.data()?.blockedUsers || [];
      if (!Array.isArray(remote) || !remote.length) return;
      const local = this._getBlocked();
      const merged = Array.from(new Set([...local, ...remote]));
      this._setBlocked(merged);
    } catch (_) {}
  },

  /**
   * Bind DOM events
   */
  bindEvents() {
    // Submit comment form
    // FIX: Duplicate submissions previously occurred because the submit button
    // had BOTH an inline onclick="Comments.submitComment()" attribute AND this
    // addEventListener('click', ...) handler — every click fired the post twice.
    // We now remove the inline handler at bind-time and attach exactly one
    // guarded listener that also blocks rapid double-clicks while a submit
    // is in flight (`Comments.isSubmitting`).
    const submitBtn = document.getElementById('submitComment');
    const commentInput = document.getElementById('commentInput');

    if (submitBtn) {
      submitBtn.removeAttribute('onclick');
      // Clone-and-replace strips any previously attached listeners (in case
      // bindEvents() runs more than once, e.g. on auth state change).
      const fresh = submitBtn.cloneNode(true);
      submitBtn.parentNode.replaceChild(fresh, submitBtn);
      fresh.addEventListener('click', (e) => {
        e.preventDefault();
        if (this.isSubmitting) return;
        this.submitComment();
      });
    }



    if (commentInput) {
      commentInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          this.submitComment();
        }
      });
    }

    // Sort buttons
    document.querySelectorAll('[data-comment-sort]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const sort = e.currentTarget.dataset.commentSort;
        this.changeSort(sort);
      });
    });

    // Comment actions (delegated)
    const commentsList = document.getElementById('commentsList');
    if (commentsList) {
      commentsList.addEventListener('click', (e) => this.handleCommentClick(e));
    }

    // Reply form toggle
    const repliesContainer = document.getElementById('repliesContainer');
    if (repliesContainer) {
      repliesContainer.addEventListener('click', (e) => this.handleReplyClick(e));
    }
  },

  /**
   * Load comments
   */
  async loadComments(append = false) {
    if (this.isLoading || (!this.hasMore && append)) return;

    this.isLoading = true;
    const loadingEl = document.getElementById('commentsLoading');
    const commentsList = document.getElementById('commentsList');

    if (!append && loadingEl) loadingEl.classList.remove('hidden');

    try {
      const sortField = this.currentSort === 'mostLiked' ? 'likes' : 'createdAt';
      
      const result = await DB.getComments(this.chapterId, {
        sortBy: sortField,
        limit: 20,
        cursor: append ? this.lastCursor : null
      });

      this.lastCursor = result.lastCursor;
      this.hasMore = result.hasMore;

      if (!append) {
        this.renderComments(result.comments);
      } else {
        this.appendComments(result.comments);
      }

      // Update comment count
      this.updateCommentCount();

    } catch (error) {
      console.error('Error loading comments:', error);
      if (!append && commentsList) {
        commentsList.innerHTML = `
          <div class="empty-state">
            <p>Failed to load comments. Please try again.</p>
          </div>
        `;
      }
    } finally {
      this.isLoading = false;
      if (loadingEl) loadingEl.classList.add('hidden');
    }
  },

  /**
   * Setup real-time updates.
   * Listens for ALL new comment activity on this chapter (top-level AND
   * replies) so the UI updates instantly for every user — no refresh
   * required. The initial snapshot is ignored (loadComments already
   * rendered history); only docChanges AFTER `since` are applied.
   */
  setupRealtimeUpdates() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    const since = firebase.firestore.Timestamp.now();
    this._rtSeen = new Set();

    this.unsubscribe = db.collection('comments')
      .where('chapterId', '==', this.chapterId)
      .where('createdAt', '>=', since)
      .onSnapshot(snapshot => {
        snapshot.docChanges().forEach(change => {
          const id = change.doc.id;
          const data = change.doc.data();
          const comment = { id, ...data };

          if (change.type === 'added') {
            // Skip if we've already rendered this id (either from the local
            // optimistic add in submitComment OR a previous snapshot).
            if (this._rtSeen.has(id)) return;
            if (document.querySelector(`[data-comment-id="${id}"]`)) {
              this._rtSeen.add(id);
              return;
            }
            this._rtSeen.add(id);
            if (comment.parentCommentId) {
              this.appendReply(comment.parentCommentId, comment);
            } else {
              this.prependComment({ ...comment, replies: [] });
            }
            this.updateCommentCount();
          } else if (change.type === 'modified') {
            this.updateCommentInDOM(id, data);
          } else if (change.type === 'removed') {
            this.removeCommentFromDOM(id);
          }
        });
      }, error => {
        console.error('Realtime comments error:', error);
      });
  },

  /**
   * Submit a new comment
   */
  async submitComment(parentCommentId = null) {
    const input = parentCommentId 
      ? document.querySelector(`[data-reply-input="${parentCommentId}"]`)
      : document.getElementById('commentInput');

    const content = input?.value?.trim();
    if (!content) return;

    // Check auth
    if (!auth.currentUser) {
      showToast('Please login to comment', 'warning');
      window.location.href = AppPath.to(`pages/login.html?redirect=${encodeURIComponent(window.location.pathname + window.location.search)}`);
      return;
    }

    // Guard against double-submission (rapid clicks / Enter spam)
    if (this.isSubmitting) return;
    this.isSubmitting = true;

    const submitBtn = parentCommentId
      ? document.querySelector(`[data-reply-submit="${parentCommentId}"]`)
      : document.getElementById('submitComment');

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<div class="spinner spinner-sm" style="border-color:currentColor;"></div>';
    }


    try {
      // Read spoiler + pending image. Spoiler is supported for both top-level
      // comments and replies; image attachments stay top-level only.
      const isSpoiler = parentCommentId
        ? !!document.getElementById(`replySpoiler-${parentCommentId}`)?.checked
        : !!document.getElementById('commentSpoiler')?.checked;
      const pendingFile = !parentCommentId ? this._pendingImage : null;
      let imageUrl = null;
      if (pendingFile) {
        try {
          imageUrl = await DB.uploadCommentImage(pendingFile);
        } catch (upErr) {
          showToast(upErr.message || 'Image upload failed', 'error');
          throw upErr;
        }
      }

      const comment = await DB.addComment(
        this.chapterId, content, parentCommentId, { imageUrl, isSpoiler }
      );

      // Clear input + attachment + spoiler flag
      input.value = '';
      if (!parentCommentId) {
        this._pendingImage = null;
        const preview = document.getElementById('commentImagePreview');
        if (preview) preview.innerHTML = '';
        const fileInput = document.getElementById('commentImageInput');
        if (fileInput) fileInput.value = '';
        const spoilerEl = document.getElementById('commentSpoiler');
        if (spoilerEl) spoilerEl.checked = false;
      }
      
      // If reply, hide reply form + reset spoiler checkbox
      if (parentCommentId) {
        const replyForm = document.querySelector(`[data-reply-form="${parentCommentId}"]`);
        if (replyForm) replyForm.classList.add('hidden');
        const rs = document.getElementById(`replySpoiler-${parentCommentId}`);
        if (rs) rs.checked = false;
      }

      // Add to UI (and mark seen so the realtime listener doesn't double-render)
      if (this._rtSeen) this._rtSeen.add(comment.id);
      if (!parentCommentId) {
        this.prependComment({ ...comment, replies: [] });
      } else {
        this.appendReply(parentCommentId, comment);
      }

      // Fire @mention notifications (best-effort, never blocks).
      this.notifyMentions(content, comment.id, parentCommentId)
        .catch(err => console.warn('[mention] notify failed:', err));

      this.updateCommentCount();
      showToast('Comment posted!', 'success');

    } catch (error) {
      console.error('Error posting comment:', error);
      showToast(error.message || 'Failed to post comment', 'error');
    } finally {
      this.isSubmitting = false;
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerHTML = parentCommentId
          ? 'Reply'
          : '<i class="fas fa-paper-plane"></i> Post Comment';
      }
    }
  },


  /**
   * Edit comment
   */
  async editComment(commentId) {
    const commentEl = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (!commentEl) return;
    // Prefer the raw markdown stored on the card; fall back to the rendered
    // text if (very old cards) the data-raw-content attribute is missing.
    const raw = commentEl.getAttribute('data-raw-content');
    const fallback = commentEl.querySelector('.comment-content')?.textContent || '';
    const initial = raw !== null ? raw : fallback;

    this.openEditCommentModal({
      initial,
      onSave: async (newContent) => {
        const trimmed = (newContent || '').trim();
        if (!trimmed) { showToast('Comment cannot be empty', 'warning'); return false; }
        if (trimmed === initial.trim()) return true; // no-op close
        try {
          await DB.updateComment(commentId, trimmed);
          const contentEl = commentEl.querySelector('.comment-content');
          if (contentEl) {
            contentEl.innerHTML = this.formatContent(trimmed) +
              ' <span style="font-size:0.75rem;color:var(--text-muted);">(edited)</span>';
          }
          commentEl.setAttribute('data-raw-content', this.escapeHtml(trimmed));
          showToast('Comment updated', 'success');
          return true;
        } catch (error) {
          showToast(error.message || 'Failed to update comment', 'error');
          return false;
        }
      }
    });
  },

  /**
   * Generic "Edit Comment" modal. Reused by Chapter Comments, Chapter
   * Replies, and the Community Discussion Board (those all flow through
   * Comments.editComment). The Reviews module opens this same modal too
   * — keeping the editing UX consistent everywhere on the site.
   *
   * Options:
   *   initial : string  — markdown/text to pre-fill in the editor.
   *   onSave  : async (newText) => boolean   — return true to close on success.
   *   title   : string  — optional header label.
   */
  openEditCommentModal({ initial = '', onSave = null, title = 'Edit Comment' } = {}) {
    this._ensureImageStyles();
    const existing = document.getElementById('editCommentModal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'editCommentModal';
    overlay.className = 'modal-overlay edit-comment-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal" style="max-width:560px;width:100%;">
        <div class="modal-header">
          <h3 class="modal-title"><i class="far fa-edit"></i> ${this.escapeHtml(title)}</h3>
          <button type="button" class="modal-close" data-ecm-cancel aria-label="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="padding:var(--space-md,1rem);">
          <div class="format-toolbar" role="toolbar" aria-label="Text formatting" style="margin-bottom:.5rem;">
            <button type="button" class="format-btn" data-ecm-fmt="bold" title="Bold (**text**)"><b>B</b></button>
            <button type="button" class="format-btn" data-ecm-fmt="italic" title="Italic (*text*)"><i>I</i></button>
            <button type="button" class="format-btn" data-ecm-fmt="strike" title="Strikethrough (/text/)"><s>S</s></button>
            <button type="button" class="format-btn" data-format-image data-ecm-fmt="image" title="Insert Image (URL)"><i class="far fa-image"></i></button>
          </div>
          <textarea id="ecmInput" class="comment-input" rows="6"
            style="width:100%;min-height:140px;padding:.65rem .8rem;border-radius:8px;border:1px solid var(--border-color,#333);background:var(--bg-input,#161616);color:var(--text-primary,#fff);resize:vertical;"></textarea>
          <p style="font-size:.75rem;color:var(--text-muted,#888);margin:.5rem 0 0;">
            Supports <b>**bold**</b>, <i>*italic*</i>, <s>/strike/</s>, @mentions, spoiler tags, and image URLs.
          </p>
        </div>
        <div class="modal-footer" style="display:flex;gap:.5rem;justify-content:flex-end;padding:var(--space-md,1rem);border-top:1px solid var(--border-color,#222);">
          <button type="button" class="btn btn-ghost btn-sm" data-ecm-cancel>Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" id="ecmSave">
            <i class="fas fa-save"></i> Save Changes
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('active'));

    const input = overlay.querySelector('#ecmInput');
    const saveBtn = overlay.querySelector('#ecmSave');
    input.value = initial || '';

    const close = () => {
      overlay.removeEventListener('click', backdropClose);
      document.removeEventListener('keydown', escClose);
      overlay.classList.remove('active');
      setTimeout(() => overlay.remove(), 150);
    };
    const backdropClose = (e) => { if (e.target === overlay) close(); };
    const escClose = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', backdropClose);
    document.addEventListener('keydown', escClose);
    overlay.querySelectorAll('[data-ecm-cancel]').forEach(b =>
      b.addEventListener('click', close));

    // Toolbar bindings — reuse applyFormat / insertImageInto so the
    // syntax matches the main comment composer.
    overlay.querySelectorAll('[data-ecm-fmt]').forEach(btn => {
      btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus
      btn.addEventListener('click', () => {
        const fmt = btn.dataset.ecmFmt;
        if (fmt === 'image') this.insertImageInto(input);
        else this.applyFormat(input, fmt);
      });
    });

    saveBtn.addEventListener('click', async () => {
      if (!onSave) { close(); return; }
      saveBtn.disabled = true;
      const orig = saveBtn.innerHTML;
      saveBtn.innerHTML = '<div class="spinner spinner-sm" style="border-color:currentColor;"></div>';
      try {
        const ok = await onSave(input.value);
        if (ok !== false) close();
      } finally {
        saveBtn.disabled = false;
        saveBtn.innerHTML = orig;
      }
    });

    setTimeout(() => { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 50);
  },

  /**
   * Delete comment
   */
  async deleteComment(commentId) {
    if (!confirm('Are you sure you want to delete this comment?')) return;

    try {
      await DB.deleteComment(commentId);
      this.removeCommentFromDOM(commentId);
      this.updateCommentCount();
      showToast('Comment deleted', 'success');
    } catch (error) {
      showToast(error.message || 'Failed to delete comment', 'error');
    }
  },

  /**
   * Toggle like on comment
   */
  async toggleLike(commentId) {
    if (!auth.currentUser) {
      showToast('Please login to like', 'warning');
      return;
    }

    try {
      const result = await DB.toggleLikeComment(commentId);
      
      const likeBtn = document.querySelector(`[data-like-btn="${commentId}"]`);
      const likeCount = document.querySelector(`[data-like-count="${commentId}"]`);
      
      if (likeBtn) {
        likeBtn.classList.toggle('liked', result.liked);
        const icon = likeBtn.querySelector('i');
        if (icon) {
          icon.className = result.liked ? 'fas fa-heart' : 'far fa-heart';
        }
      }
      
      if (likeCount) {
        const currentCount = parseInt(likeCount.textContent) || 0;
        likeCount.textContent = result.liked ? currentCount + 1 : Math.max(0, currentCount - 1);
      }

    } catch (error) {
      showToast(error.message || 'Failed to like comment', 'error');
    }
  },

  /**
   * Change sort order
   */
  changeSort(sort) {
    if (this.currentSort === sort) return;
    
    this.currentSort = sort;
    this.lastCursor = null;
    this.hasMore = true;

    // Update active sort button
    document.querySelectorAll('[data-comment-sort]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.commentSort === sort);
    });

    this.loadComments(false);
  },

  /**
   * Toggle reply form
   */
  toggleReplyForm(commentId) {
    const replyForm = document.querySelector(`[data-reply-form="${commentId}"]`);
    if (replyForm) {
      replyForm.classList.toggle('hidden');
      if (!replyForm.classList.contains('hidden')) {
        const input = replyForm.querySelector('textarea');
        if (input) input.focus();
      }
    }
  },

  /**
   * Render comments list
   */
  renderComments(comments) {
    const container = document.getElementById('commentsList');
    if (!container) return;

    if (comments.length === 0) {
      container.innerHTML = `
        <div class="empty-state" style="padding: 2rem;">
          <div class="empty-state-icon"><i class="far fa-comments"></i></div>
          <h3 class="empty-state-title">No comments yet</h3>
          <p class="empty-state-desc">Be the first to share your thoughts!</p>
        </div>
      `;
      return;
    }

    container.innerHTML = comments.map(comment => this.renderComment(comment)).join('');
    // After rendering, scroll/highlight a comment if the URL points to one.
    // Supports both #comment-<id> hash and ?highlight=<id> query coming from
    // the notifications page deep-links.
    try { this._highlightFromUrl && this._highlightFromUrl(); } catch (_) {}
  },

  /**
   * Scroll to + highlight a comment referenced in the URL.
   * Called automatically after renderComments().
   */
  _highlightFromUrl() {
    let id = null;
    if (location.hash && location.hash.startsWith('#comment-')) {
      id = location.hash.slice('#comment-'.length);
    } else {
      try {
        const q = new URLSearchParams(location.search);
        id = q.get('highlight');
      } catch (_) {}
    }
    if (!id) return;
    const el = document.querySelector(`[data-comment-id="${id}"]`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('comment-highlight');
    setTimeout(() => el.classList.remove('comment-highlight'), 2500);
  },

  /**
   * Render single comment
   */
  renderComment(comment, isReply = false) {
    const user = auth.currentUser;
    const isOwner = user && comment.userId === user.uid;
    const isAdmin = Auth.hasRole?.('moderator');
    const canDelete = isOwner || isAdmin;
    const canEdit = isOwner;

    // Hide comments from users the current viewer has blocked
    if (this.isBlocked && this.isBlocked(comment.userId)) {
      return `<div class="comment-thread comment-blocked" data-comment-id="${comment.id}">
        <div class="comment-blocked-body">
          <i class="fas fa-ban"></i> Comment hidden — you blocked this user.
          <button class="comment-blocked-unhide" onclick="Comments.unblockUser('${comment.userId}')">Unblock</button>
        </div>
      </div>`;
    }

    const date = this.formatRelative
      ? this.formatRelative(comment.createdAt)
      : (comment.createdAt?.toDate?.() ? comment.createdAt.toDate().toLocaleDateString() : 'Just now');

    const likedClass = comment.likedBy?.includes(user?.uid) ? 'liked' : '';
    const heartIcon = likedClass ? 'fas fa-heart' : 'far fa-heart';

    const replyCount = comment.replies?.length || 0;
    const repliesHtml = !isReply && replyCount > 0
      ? `<div class="replies-toggle" data-replies-toggle="${comment.id}">
          <button class="replies-toggle-btn" onclick="Comments.toggleReplies('${comment.id}')">
            <i class="fas fa-chevron-down"></i>
            <span data-replies-label="${comment.id}">View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
          </button>
        </div>
        <div class="replies-container hidden" data-replies-container="${comment.id}">
          ${comment.replies.map(reply => this.renderComment(reply, true)).join('')}
        </div>`
      : '';

    const replyFormHtml = !isReply
      ? `<div class="comment-form reply-form hidden" data-reply-form="${comment.id}">
          <div class="comment-input-wrapper" style="width:100%;">
            <div class="format-toolbar" role="toolbar" aria-label="Text formatting">
              <button type="button" class="format-btn" title="Bold" onclick="Comments.applyFormat('[data-reply-input=\\'${comment.id}\\']','bold')"><b>B</b></button>
              <button type="button" class="format-btn" title="Italic" onclick="Comments.applyFormat('[data-reply-input=\\'${comment.id}\\']','italic')"><i>I</i></button>
              <button type="button" class="format-btn" title="Strikethrough" onclick="Comments.applyFormat('[data-reply-input=\\'${comment.id}\\']','strike')"><s>S</s></button>
              <button type="button" class="format-btn" data-format-image title="Insert Image (URL)" onclick="Comments.insertImageInto('[data-reply-input=\\'${comment.id}\\']')"><i class="far fa-image"></i></button>
            </div>
            <textarea class="comment-input" data-reply-input="${comment.id}" placeholder="Write a reply..." rows="2"></textarea>
            <div class="comment-actions" style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;">
              <label style="display:inline-flex;align-items:center;gap:.4rem;font-size:.8125rem;color:var(--text-secondary);cursor:pointer;margin-right:auto;">
                <input type="checkbox" id="replySpoiler-${comment.id}" style="width:14px;height:14px;">
                <i class="fas fa-eye-slash"></i> Mark as spoiler
              </label>
              <button class="btn btn-ghost btn-sm" onclick="Comments.toggleReplyForm('${comment.id}')">Cancel</button>
              <button class="btn btn-primary btn-sm" data-reply-submit="${comment.id}" onclick="Comments.submitComment('${comment.id}')">Reply</button>
            </div>
          </div>
        </div>`
      : '';

    // Custom (admin-assigned) title — DONATOR / VIP / etc. Skip if expired.
    let customTitleBadge = '';
    if (typeof Donation !== 'undefined' && comment.authorCustomTitleId) {
      const exp = comment.authorCustomTitleExpiresAt;
      const expMs = exp?.toMillis?.() ?? exp ?? null;
      if (!expMs || expMs > Date.now()) {
        customTitleBadge = Donation.renderCustomTitleBadge(comment.authorCustomTitleId);
      }
    }
    const titleBadge = (!customTitleBadge && typeof EXPSystem !== 'undefined' && comment.authorTitleId)
      ? EXPSystem.renderTitleBadge(comment.authorTitleId) : '';
    const levelBadge = (typeof EXPSystem !== 'undefined' && comment.authorLevel)
      ? EXPSystem.renderLevelBadge(comment.authorLevel) : '';
    const userHref = comment.userId
      ? (typeof AppPath !== 'undefined' ? AppPath.to(`pages/user.html?uid=${comment.userId}`) : `user.html?uid=${comment.userId}`)
      : '#';

    let roleBadgeHtml = '';
    const role = comment.authorRole || '';
    if (role === 'admin') {
      roleBadgeHtml = `<span class="role-badge role-badge-admin" title="Administrator"><i class="fas fa-crown"></i> ADMIN</span>`;
    } else if (role === 'moderator') {
      roleBadgeHtml = `<span class="role-badge role-badge-moderator" title="Moderator"><i class="fas fa-shield-alt"></i> MOD</span>`;
    }
    const staffClass = (role === 'admin' || role === 'moderator') ? ' comment-staff' : '';

    // ---- Spoiler-aware content rendering (with formatting + mentions) ----
    const safeContent = this.formatContent(comment.content || '');
    const imgHtml = comment.imageUrl
      ? `<div class="comment-image-wrap"><img src="${this.escapeHtml(comment.imageUrl)}" alt="Comment attachment" class="comment-image" loading="lazy" onclick="window.open(this.src,'_blank')"></div>`
      : '';
    const innerContent = `<div class="comment-content">${safeContent}</div>${imgHtml}`;
    const bodyHtml = comment.isSpoiler
      ? `<div class="comment-spoiler" data-spoiler-comment="${comment.id}" onclick="Comments.revealSpoiler('${comment.id}')">
          <div class="spoiler-warning"><i class="fas fa-eye-slash"></i> Spoiler — click to reveal</div>
          <div class="spoiler-content" hidden>${innerContent}</div>
        </div>`
      : innerContent;

    // Three-dot menu items
    const menuItems = [];
    if (!isOwner) {
      menuItems.push(`<button class="menu-item" onclick="Comments.reportComment('${comment.id}')"><i class="far fa-flag"></i> Report</button>`);
      if (comment.userId) {
        menuItems.push(`<button class="menu-item" onclick="Comments.blockUser('${comment.userId}','${this.escapeHtml(comment.username || 'user')}','${this.escapeHtml(comment.avatar || '../images/default-avatar.png').replace(/'/g, "\\'")}')"><i class="fas fa-user-slash"></i> Block User</button>`);
      }
    }
    if (canEdit) {
      menuItems.push(`<button class="menu-item" onclick="Comments.editComment('${comment.id}')"><i class="far fa-edit"></i> Edit</button>`);
    }
    if (canDelete) {
      menuItems.push(`<button class="menu-item menu-item-danger" onclick="Comments.deleteComment('${comment.id}')"><i class="far fa-trash-alt"></i> Delete</button>`);
    }
    const menuHtml = menuItems.length ? `
      <div class="comment-menu">
        <button class="comment-menu-trigger" aria-label="More options" onclick="Comments.toggleMenu(event,'${comment.id}')">
          <i class="fas fa-ellipsis-h"></i>
        </button>
        <div class="comment-menu-dropdown hidden" data-comment-menu="${comment.id}">
          ${menuItems.join('')}
        </div>
      </div>` : '';

    return `
      <div class="comment-card${staffClass}${isReply ? ' comment-reply' : ''}" data-comment-id="${comment.id}" data-raw-content="${this.escapeHtml(comment.content || '')}" data-raw-spoiler="${comment.isSpoiler ? '1' : '0'}" data-raw-image="${this.escapeHtml(comment.imageUrl || '')}">
        <a href="${userHref}" class="comment-avatar-link">
          <img src="${comment.avatar || '../images/default-avatar.png'}" alt="${this.escapeHtml(comment.username || 'User')}" class="comment-avatar" onerror="this.src='../images/default-avatar.png'">
        </a>
        <div class="comment-body">
          <div class="comment-header">
            <div class="comment-meta">
              <a href="${userHref}" class="comment-author-link"><span class="comment-author">${this.escapeHtml(comment.username || 'User')}</span></a>
              <div class="comment-badges">${customTitleBadge}${roleBadgeHtml}${levelBadge}${titleBadge}</div>
            </div>
            ${menuHtml}
          </div>
          <div class="comment-time">${date}${comment.isEdited ? ' · edited' : ''}</div>
          ${bodyHtml}
          <div class="comment-footer">
            <button class="comment-btn ${likedClass}" data-like-btn="${comment.id}" onclick="Comments.toggleLike('${comment.id}')">
              <i class="${heartIcon}"></i>
              <span data-like-count="${comment.id}">${comment.likes || 0}</span>
            </button>
            ${!isReply
              ? `<button class="comment-btn" onclick="Comments.toggleReplyForm('${comment.id}')"><i class="far fa-comment"></i> Reply</button>`
              : `<button class="comment-btn" onclick="Comments.replyToReply('${comment.parentCommentId}','${this.escapeHtml(comment.username || 'User').replace(/'/g, "\\'")}')"><i class="far fa-comment"></i> Reply</button>`}
          </div>
          ${replyFormHtml}
          ${repliesHtml}
        </div>
      </div>
    `;
  },

  /**
   * Toggle the three-dot menu. Closes any other open menu first and
   * registers a one-shot outside-click listener so taps elsewhere dismiss it.
   */
  toggleMenu(event, commentId) {
    event.stopPropagation();
    const dropdown = document.querySelector(`[data-comment-menu="${commentId}"]`);
    if (!dropdown) return;
    document.querySelectorAll('.comment-menu-dropdown').forEach(el => {
      if (el !== dropdown) el.classList.add('hidden');
    });
    const willOpen = dropdown.classList.contains('hidden');
    dropdown.classList.toggle('hidden');
    if (willOpen) {
      setTimeout(() => {
        const close = (e) => {
          if (!dropdown.contains(e.target)) {
            dropdown.classList.add('hidden');
            document.removeEventListener('click', close);
          }
        };
        document.addEventListener('click', close);
      }, 0);
    }
  },

  /**
   * Collapse / expand the replies container under a top-level comment.
   */
  toggleReplies(commentId) {
    const container = document.querySelector(`[data-replies-container="${commentId}"]`);
    const label = document.querySelector(`[data-replies-label="${commentId}"]`);
    const toggle = document.querySelector(`[data-replies-toggle="${commentId}"] i`);
    if (!container) return;
    const isHidden = container.classList.toggle('hidden');
    const count = container.querySelectorAll(':scope > .comment-card').length;
    if (label) {
      label.textContent = isHidden
        ? `View ${count} ${count === 1 ? 'reply' : 'replies'}`
        : `Hide ${count === 1 ? 'reply' : 'replies'}`;
    }
    if (toggle) {
      toggle.className = isHidden ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
    }
  },

  /**
   * Client-side block list (persisted in localStorage). Hides comments and
   * replies from the blocked user for the current viewer only — does not
   * call the backend, so it works even without a server schema for blocks.
   */
  _blockKey() { return `mw_blocked_users_${auth.currentUser?.uid || 'anon'}`; },
  _getBlocked() {
    try { return JSON.parse(localStorage.getItem(this._blockKey()) || '[]'); }
    catch (_) { return []; }
  },
  _setBlocked(list) {
    try { localStorage.setItem(this._blockKey(), JSON.stringify(list)); } catch (_) {}
  },
  isBlocked(userId) {
    if (!userId) return false;
    return this._getBlocked().includes(userId);
  },
  blockUser(userId, username, avatar) {
    if (!userId) return;
    // Try to enrich avatar from the visible comment card if not supplied.
    if (!avatar) {
      const card = document.querySelector(`[data-comment-id] .comment-avatar`);
      const inferred = document.querySelector(
        `.comment-card[data-comment-id] .comment-avatar-link img`
      );
      // Find an avatar from any comment by this user.
      const userCard = Array.from(document.querySelectorAll('.comment-card'))
        .find(c => c.querySelector(`[onclick*="blockUser('${userId}'"]`));
      const img = userCard?.querySelector('.comment-avatar');
      avatar = img?.src || '../images/default-avatar.png';
    }
    this._openBlockConfirm({ userId, username: username || 'this user', avatar });
  },

  /**
   * Confirmation popup before blocking a user.
   * Shows avatar + username + explanation, with Cancel / Block actions.
   * Block is only applied after the user clicks the Block button.
   */
  _openBlockConfirm({ userId, username, avatar }) {
    let modal = document.getElementById('blockUserModal');
    const show = (m) => { m.style.display = 'flex'; m.style.visibility = 'visible'; m.style.opacity = '1'; };
    const hide = (m) => { m.style.display = 'none'; m.style.visibility = 'hidden'; m.style.opacity = '0'; };
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'blockUserModal';
      modal.style.cssText = 'display:none;visibility:hidden;opacity:0;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.75);align-items:center;justify-content:center;padding:1rem;';
      modal.innerHTML = `
        <div style="max-width:380px;width:100%;background:var(--bg-card,#141414);border:1px solid var(--border-color,#2a2a2a);border-radius:12px;padding:1.25rem;color:var(--text-primary,#fff);">
          <div style="display:flex;align-items:center;gap:.75rem;margin-bottom:1rem;">
            <img id="blockUserAvatar" src="" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;background:#1a1a1a;" onerror="this.src='../images/default-avatar.png'">
            <div>
              <div style="font-size:.8rem;color:var(--text-muted,#888);">Block user</div>
              <div id="blockUserName" style="font-weight:600;font-size:1rem;"></div>
            </div>
          </div>
          <p style="margin:0 0 1rem;font-size:.9rem;line-height:1.45;color:var(--text-secondary,#cfcfcf);">
            Their comments won't show up for you anymore. You can unblock them anytime from your Settings.
          </p>
          <div style="display:flex;justify-content:flex-end;gap:.5rem;">
            <button type="button" class="btn btn-ghost btn-sm" data-block-cancel>Cancel</button>
            <button type="button" class="btn btn-primary btn-sm" id="blockUserConfirm" style="background:#ef4444;border-color:#ef4444;">Block</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
      modal.addEventListener('click', (e) => {
        if (e.target === modal || e.target.matches('[data-block-cancel]')) hide(modal);
      });
    }
    modal.querySelector('#blockUserAvatar').src = avatar;
    modal.querySelector('#blockUserName').textContent = username;
    // Re-bind confirm to drop stale listeners
    const oldBtn = modal.querySelector('#blockUserConfirm');
    const btn = oldBtn.cloneNode(true);
    oldBtn.parentNode.replaceChild(btn, oldBtn);
    btn.addEventListener('click', () => {
      const list = this._getBlocked();
      if (!list.includes(userId)) list.push(userId);
      this._setBlocked(list);
      // Best-effort persist to user profile so the block survives devices.
      try {
        if (auth.currentUser) {
          db.collection('users').doc(auth.currentUser.uid).set(
            { blockedUsers: firebase.firestore.FieldValue.arrayUnion(userId) },
            { merge: true }
          ).catch(() => {});
        }
      } catch (_) {}
      hide(modal);
      showToast(`Blocked ${username}`, 'success');
      // Immediately remove all visible cards from this user (no refresh).
      document.querySelectorAll('.comment-card').forEach(card => {
        const inside = card.innerHTML || '';
        if (inside.includes(`blockUser('${userId}'`) || inside.includes(`user.html?uid=${userId}`)) {
          card.outerHTML = `<div class="comment-thread comment-blocked" data-comment-id="${card.dataset.commentId}">
            <div class="comment-blocked-body">
              <i class="fas fa-ban"></i> Comment hidden — you blocked this user.
              <button class="comment-blocked-unhide" onclick="Comments.unblockUser('${userId}')">Unblock</button>
            </div>
          </div>`;
        }
      });
    });
    show(modal);
  },

  unblockUser(userId) {
    const list = this._getBlocked().filter(id => id !== userId);
    this._setBlocked(list);
    try {
      if (auth.currentUser) {
        db.collection('users').doc(auth.currentUser.uid).set(
          { blockedUsers: firebase.firestore.FieldValue.arrayRemove(userId) },
          { merge: true }
        ).catch(() => {});
      }
    } catch (_) {}
    showToast('User unblocked', 'success');
    this.loadComments(false);
  },

  /**
   * Human-friendly relative timestamp ("3m", "2h", "1d") with full-date fallback.
   */
  formatRelative(ts) {
    const date = ts?.toDate?.() ? ts.toDate() : (ts instanceof Date ? ts : null);
    if (!date) return 'Just now';
    const diff = (Date.now() - date.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    return date.toLocaleDateString();
  },

  /**
   * Reveal a spoiler comment in-place. Idempotent: re-clicking does nothing
   * once the content is visible.
   */
  revealSpoiler(commentId) {
    const wrap = document.querySelector(`[data-spoiler-comment="${commentId}"]`);
    if (!wrap || wrap.classList.contains('revealed')) return;
    wrap.classList.add('revealed');
    const warn = wrap.querySelector('.spoiler-warning');
    const body = wrap.querySelector('.spoiler-content');
    if (warn) warn.remove();
    if (body) body.hidden = false;
  },

  /**
   * Attach a pending image to the next comment submission. The file is
   * uploaded inside submitComment() so the UI can show a preview first
   * without burning storage on canceled posts.
   */
  attachImage(fileInput) {
    const file = fileInput?.files?.[0];
    const preview = document.getElementById('commentImagePreview');
    if (!file) { this._pendingImage = null; if (preview) preview.innerHTML = ''; return; }
    const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    const MAX_BYTES = 4 * 1024 * 1024;
    if (!ALLOWED.includes(file.type)) {
      showToast('Only JPG, PNG, GIF or WEBP images are allowed.', 'error');
      fileInput.value = '';
      return;
    }
    if (file.size > MAX_BYTES) {
      showToast('Image is too large (max 4 MB).', 'error');
      fileInput.value = '';
      return;
    }
    this._pendingImage = file;
    if (preview) {
      const url = URL.createObjectURL(file);
      preview.innerHTML = `
        <div class="comment-image-pending">
          <img src="${url}" alt="Selected image">
          <button type="button" class="btn btn-ghost btn-sm" onclick="Comments.clearAttachment()">Remove</button>
        </div>`;
    }
  },

  clearAttachment() {
    this._pendingImage = null;
    const fileInput = document.getElementById('commentImageInput');
    if (fileInput) fileInput.value = '';
    const preview = document.getElementById('commentImagePreview');
    if (preview) preview.innerHTML = '';
  },

  /**
   * Toggle a reaction. Optimistically updates the visible count, then
   * re-syncs from the transaction result so concurrent reactions stay
   * consistent.
   */
  async toggleReaction(commentId, key) {
    if (!auth.currentUser) {
      showToast('Please login to react', 'warning');
      return;
    }
    // Prevent duplicate concurrent requests for the same comment. Spam-clicks
    // used to fire a fresh Firestore transaction every click — the contention
    // exploded into transaction retries that exhausted the daily write quota
    // ("Quota Exceeded" error). One in-flight request per comment is enough;
    // additional clicks while pending are ignored.
    this._reactionLocks = this._reactionLocks || new Set();
    if (this._reactionLocks.has(commentId)) return;
    this._reactionLocks.add(commentId);

    const container = document.querySelector(`[data-reactions="${commentId}"]`);
    if (container) container.querySelectorAll('.reaction-btn').forEach(b => b.disabled = true);

    try {
      const { reactions, mine } = await DB.toggleReaction(commentId, key);
      if (!container) return;
      Object.entries(reactions).forEach(([k, v]) => {
        const countEl = container.querySelector(`[data-reaction-count="${commentId}-${k}"]`);
        if (countEl) countEl.textContent = v;
      });
      container.querySelectorAll('.reaction-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.reaction === mine);
      });
    } catch (e) {
      showToast(e.message || 'Failed to react', 'error');
    } finally {
      this._reactionLocks.delete(commentId);
      if (container) container.querySelectorAll('.reaction-btn').forEach(b => b.disabled = false);
    }
  },

  /**
   * Open the commenting-rules modal. Rules come from meta/commentRules so
   * admins can edit them later without a code change.
   */
  async openRules() {
    let rules;
    try { rules = await DB.getCommentRules(); }
    catch (_) { rules = []; }
    const list = (rules && rules.length)
      ? rules.map(r => `<li>${this.escapeHtml(r)}</li>`).join('')
      : '<li>No rules configured yet.</li>';
    let modal = document.getElementById('commentRulesModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'commentRulesModal';
      modal.className = 'modal-overlay';
      modal.innerHTML = `
        <div class="modal" style="max-width:480px;">
          <div class="modal-header">
            <h3 class="modal-title"><i class="fas fa-gavel"></i> Commenting Rules</h3>
            <button class="modal-close" onclick="UI.closeModal('commentRulesModal')"><i class="fas fa-times"></i></button>
          </div>
          <div class="modal-body">
            <ol id="commentRulesList" style="padding-left:1.25rem;line-height:1.8;color:var(--text-secondary);"></ol>
            <p style="margin-top:1rem;font-size:0.8125rem;color:var(--text-muted);">
              Breaking these rules may result in comment removal or account suspension.
            </p>
          </div>
          <div class="modal-footer">
            <button class="btn btn-primary" onclick="UI.closeModal('commentRulesModal')">Got it</button>
          </div>
        </div>`;
      document.body.appendChild(modal);
    }
    modal.querySelector('#commentRulesList').innerHTML = list;
    UI.openModal('commentRulesModal');
  },

  appendComments(comments) {
    const container = document.getElementById('commentsList');
    if (!container) return;
    
    comments.forEach(comment => {
      container.insertAdjacentHTML('beforeend', this.renderComment(comment));
    });
  },

  /**
   * Prepend single comment to list
   */
  prependComment(comment) {
    const container = document.getElementById('commentsList');
    if (!container) return;
    
    const emptyState = container.querySelector('.empty-state');
    if (emptyState) emptyState.remove();
    
    container.insertAdjacentHTML('afterbegin', this.renderComment(comment));
  },

  /**
   * Append reply to comment
   */
  appendReply(parentId, reply) {
    const parentComment = document.querySelector(`[data-comment-id="${parentId}"]`);
    if (!parentComment) return;

    // Ensure the toggle + container exist (first reply on a fresh comment).
    let toggleWrap = parentComment.querySelector(`[data-replies-toggle="${parentId}"]`);
    let container = parentComment.querySelector(`[data-replies-container="${parentId}"]`);
    const body = parentComment.querySelector('.comment-body');

    if (!container) {
      toggleWrap = document.createElement('div');
      toggleWrap.className = 'replies-toggle';
      toggleWrap.setAttribute('data-replies-toggle', parentId);
      toggleWrap.innerHTML = `
        <button class="replies-toggle-btn" onclick="Comments.toggleReplies('${parentId}')">
          <i class="fas fa-chevron-up"></i>
          <span data-replies-label="${parentId}">Hide reply</span>
        </button>`;
      container = document.createElement('div');
      container.className = 'replies-container';
      container.setAttribute('data-replies-container', parentId);
      body.appendChild(toggleWrap);
      body.appendChild(container);
    } else {
      // Make sure the newly-added reply is visible immediately.
      container.classList.remove('hidden');
      const icon = parentComment.querySelector(`[data-replies-toggle="${parentId}"] i`);
      if (icon) icon.className = 'fas fa-chevron-up';
    }

    container.insertAdjacentHTML('beforeend', this.renderComment(reply, true));

    // Refresh the label count.
    const count = container.querySelectorAll(':scope > .comment-card').length;
    const label = parentComment.querySelector(`[data-replies-label="${parentId}"]`);
    if (label) label.textContent = `Hide ${count === 1 ? 'reply' : 'replies'}`;
  },

  /**
   * Update comment in DOM
   */
  updateCommentInDOM(commentId, data) {
    const commentEl = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (!commentEl) return;

    const contentEl = commentEl.querySelector('.comment-content');
    if (contentEl && data.content) {
      contentEl.innerHTML = this.formatContent(data.content);
    }

    const likeCount = commentEl.querySelector(`[data-like-count="${commentId}"]`);
    if (likeCount && data.likes !== undefined) {
      likeCount.textContent = data.likes;
    }
  },

  /**
   * Remove comment from DOM
   */
  removeCommentFromDOM(commentId) {
    const commentEl = document.querySelector(`[data-comment-id="${commentId}"]`);
    if (commentEl) {
      commentEl.style.opacity = '0';
      setTimeout(() => commentEl.remove(), 300);
    }
  },

  /**
   * Update comment count display
   */
  updateCommentCount() {
    const countEl = document.getElementById('commentCount');
    if (!countEl) return;

    db.collection('comments')
      .where('chapterId', '==', this.chapterId)
      .get()
      .then(snapshot => {
        countEl.textContent = snapshot.size;
      });
  },

  /**
   * Handle comment list click events
   */
  handleCommentClick(e) {
    // Handle delegated events if needed
  },

  /**
   * Handle reply click events
   */
  handleReplyClick(e) {
    // Handle delegated events if needed
  },

  /**
   * Report a comment. Saves a full report record (reporter, reason, content
   * id, content snippet, timestamp, status) AND creates an in-app
   * notification for every admin/moderator so they see it in the bell menu
   * and in the Admin Dashboard reports tab.
   */
  async reportComment(commentId) {
    const user = auth.currentUser;
    if (!user) {
      showToast('Please log in to report a comment', 'warning');
      return;
    }
    // Match the Community Reviews report popup design + workflow:
    // dropdown of standard reasons + optional details textarea.
    const reasonObj = await this._openReportModal();
    if (!reasonObj) return;
    const reason = reasonObj.details
      ? `${reasonObj.reason} — ${reasonObj.details}`
      : reasonObj.reason;

    try {
      // Pull the comment + reporter profile for richer report context.
      const [commentSnap, reporterSnap] = await Promise.all([
        db.collection('comments').doc(commentId).get(),
        db.collection('users').doc(user.uid).get()
      ]);
      const comment = commentSnap.exists ? commentSnap.data() : {};
      const reporter = reporterSnap.exists ? reporterSnap.data() : {};
      const snippet = (comment.content || '').slice(0, 200);

      // Resolve seriesId/title + chapter number so moderators can jump
      // straight to the reported comment from the Admin Dashboard.
      let seriesId = comment.seriesId || null;
      let seriesTitle = '';
      let chapterNumber = null;
      try {
        if (comment.chapterId) {
          const chapSnap = await db.collection('chapters').doc(comment.chapterId).get();
          if (chapSnap.exists) {
            const ch = chapSnap.data();
            chapterNumber = ch.chapterNumber ?? null;
            if (!seriesId) seriesId = ch.seriesId || null;
          }
        }
        if (seriesId) {
          const sSnap = await db.collection('series').doc(seriesId).get();
          if (sSnap.exists) seriesTitle = sSnap.data().title || '';
        }
      } catch (lookupErr) {
        console.warn('Report context lookup failed:', lookupErr.message);
      }

      // If this is a reply, fetch the parent comment for added context.
      let parentSnippet = '';
      if (comment.parentCommentId) {
        try {
          const ps = await db.collection('comments').doc(comment.parentCommentId).get();
          if (ps.exists) parentSnippet = (ps.data().content || '').slice(0, 200);
        } catch (_) {}
      }

      const isReply = !!comment.parentCommentId;
      const reportRef = await db.collection('reports').add({
        contentType: isReply ? 'commentReply' : 'comment',
        contentId: commentId,
        commentId,                         // kept for backwards-compat
        parentId: comment.parentCommentId || null,
        parentSnippet,
        chapterId: comment.chapterId || null,
        chapterNumber,
        seriesId,
        seriesTitle,
        snippet,
        authorId: comment.userId || null,
        authorName: comment.username || null,
        reason: reason.trim(),
        reportedBy: user.uid,
        reporterUsername: reporter.username || user.displayName || user.email,
        reportedAt: firebase.firestore.FieldValue.serverTimestamp(),
        timestamp: firebase.firestore.FieldValue.serverTimestamp(),
        status: 'pending'
      });

      // Fire-and-forget: notify every admin/moderator so they get a bell
      // notification AND see the new report in the dashboard immediately.
      try {
        const staffSnap = await db.collection('users')
          .where('role', 'in', ['admin', 'moderator']).get();
        const batch = db.batch();
        staffSnap.forEach(doc => {
          const notifRef = db.collection('notifications').doc();
          batch.set(notifRef, {
            userId: doc.id,
            type: 'report',
            title: 'New content report',
            message: `${reporter.username || 'A user'} reported a ${isReply ? 'reply' : 'comment'}` +
                     (seriesTitle ? ` on "${seriesTitle}"${chapterNumber != null ? ` Ch.${chapterNumber}` : ''}` : '') +
                     `: "${snippet.slice(0, 80)}"`,
            reportId: reportRef.id,
            link: 'pages/admin.html#reports',
            read: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        });
        await batch.commit();
      } catch (notifyErr) {
        console.warn('Could not notify staff about report:', notifyErr.message);
      }

      showToast('Comment reported. Thank you for helping keep the community safe.', 'success');
    } catch (error) {
      console.error('Report failed:', error);
      showToast('Failed to submit report', 'error');
    }
  },

  /**
   * Render comment content: escape HTML, then apply lightweight markdown
   * (**bold**, *italic*, /strike/), highlight @mentions, and preserve newlines.
   */
  /**
   * Open a report modal matching the Community Reviews design.
   * Resolves to { reason, details } when submitted, or null on cancel.
   */
  _openReportModal() {
    const REASONS = ['Spam','Harassment','Hate Speech','Inappropriate Content','Misleading Information','Other'];
    return new Promise((resolve) => {
      let modal = document.getElementById('commentReportModal');
      const show = (m) => { m.style.display = 'flex'; m.style.visibility = 'visible'; m.style.opacity = '1'; };
      const hide = (m) => { m.style.display = 'none'; m.style.visibility = 'hidden'; m.style.opacity = '0'; };
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'commentReportModal';
        modal.style.cssText = 'display:none;visibility:hidden;opacity:0;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.75);align-items:center;justify-content:center;padding:1rem;';
        modal.innerHTML = `
          <div class="modal" style="max-width:440px;width:100%;background:var(--bg-card,#141414);border:1px solid var(--border-color,#2a2a2a);border-radius:12px;padding:1.25rem;color:var(--text-primary,#fff);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:1.1rem;"><i class="fas fa-flag"></i> Report Comment</h3>
              <button type="button" data-close style="background:transparent;border:0;color:#888;cursor:pointer;font-size:1.2rem;">&times;</button>
            </div>
            <label style="display:block;margin-bottom:.4rem;font-size:.85rem;color:var(--text-secondary,#cfcfcf);">Reason</label>
            <select id="commentReportReason" class="form-input" style="width:100%;margin-bottom:.75rem;">
              ${REASONS.map(r => `<option value="${r}">${r}</option>`).join('')}
            </select>
            <label style="display:block;margin-bottom:.4rem;font-size:.85rem;color:var(--text-secondary,#cfcfcf);">Details (optional)</label>
            <textarea id="commentReportDetails" class="form-input" rows="3" style="width:100%;resize:vertical;" placeholder="Give moderators a bit more context…"></textarea>
            <div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem;">
              <button type="button" class="btn btn-ghost btn-sm" data-close>Cancel</button>
              <button type="button" class="btn btn-primary btn-sm" id="commentReportSubmit">Submit Report</button>
            </div>
          </div>`;
        document.body.appendChild(modal);
      }
      const close = (val) => { hide(modal); resolve(val); };
      // Re-bind handlers each open to avoid stacking.
      modal.querySelectorAll('[data-close]').forEach(b => {
        const fresh = b.cloneNode(true); b.parentNode.replaceChild(fresh, b);
        fresh.addEventListener('click', () => close(null));
      });
      const oldSubmit = modal.querySelector('#commentReportSubmit');
      const submit = oldSubmit.cloneNode(true);
      oldSubmit.parentNode.replaceChild(submit, oldSubmit);
      submit.addEventListener('click', () => {
        const reason = modal.querySelector('#commentReportReason').value;
        const details = modal.querySelector('#commentReportDetails').value.trim();
        modal.querySelector('#commentReportDetails').value = '';
        close({ reason, details });
      });
      modal.onclick = (e) => { if (e.target === modal) close(null); };
      show(modal);
    });
  },

  /**
   * Notify mentioned users (@username) about a new comment/reply.
   * - Dedupes mentions in the same comment
   * - Skips the author themselves
   * - Resolves usernames to uids via the `users` collection
   * - Notification deep-links via ?highlight=<commentId>#comment-<commentId>
   */
  async notifyMentions(content, commentId, parentCommentId) {
    try {
      if (!content || !auth.currentUser) return;
      const matches = Array.from(content.matchAll(/@([A-Za-z0-9_\-\.]+)/g))
        .map(m => m[1]);
      const unique = Array.from(new Set(matches)).slice(0, 10);
      if (!unique.length) return;

      // Resolve series/chapter context (best-effort)
      let seriesId = null, seriesTitle = '', chapterNumber = null;
      try {
        const chSnap = await db.collection('chapters').doc(this.chapterId).get();
        if (chSnap.exists) {
          const ch = chSnap.data();
          seriesId = ch.seriesId || null;
          chapterNumber = ch.chapterNumber || null;
          if (seriesId) {
            const sSnap = await db.collection('series').doc(seriesId).get();
            if (sSnap.exists) seriesTitle = sSnap.data().title || '';
          }
        }
      } catch (_) {}

      const me = auth.currentUser;
      const myName = (await db.collection('users').doc(me.uid).get())
        .data()?.username || me.displayName || 'Someone';
      const preview = content.replace(/\s+/g, ' ').trim().slice(0, 140);

      // Find each user by username (case-insensitive best-effort: try exact first).
      await Promise.all(unique.map(async (uname) => {
        try {
          const snap = await db.collection('users')
            .where('username', '==', uname).limit(1).get();
          if (snap.empty) return;
          const target = snap.docs[0];
          if (target.id === me.uid) return; // don't notify self
          // Dedupe: skip if an identical mention notification was already
          // sent for this same comment id.
          const dupe = await db.collection('notifications')
            .where('userId', '==', target.id)
            .where('type', '==', 'mention')
            .where('commentId', '==', commentId)
            .limit(1).get().catch(() => ({ empty: true }));
          if (!dupe.empty) return;
          await db.collection('notifications').add({
            userId: target.id,
            type: 'mention',
            category: 'comments',
            title: `${myName} mentioned you`,
            message: `${myName} mentioned you in a ${parentCommentId ? 'reply' : 'comment'}` +
                     (seriesTitle ? ` on ${seriesTitle}${chapterNumber ? ' - Chapter ' + chapterNumber : ''}` : ''),
            preview,
            mentionerId: me.uid,
            mentionerUsername: myName,
            seriesId, seriesTitle, chapterNumber,
            chapterId: this.chapterId,
            commentId,
            parentCommentId: parentCommentId || null,
            link: (typeof AppPath !== 'undefined'
              ? AppPath.to(`pages/chapter.html?id=${this.chapterId}&highlight=${commentId}#comment-${commentId}`)
              : `pages/chapter.html?id=${this.chapterId}&highlight=${commentId}#comment-${commentId}`),
            read: false,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
          });
        } catch (e) {
          console.warn('[mention] notify for @' + uname + ' failed:', e.message);
        }
      }));
    } catch (e) {
      console.warn('notifyMentions error:', e);
    }
  },

  /**
   * Render comment content: escape HTML, then apply lightweight markdown
   * (**bold**, *italic*, /strike/), highlight @mentions, and preserve newlines.
   */
  formatContent(text) {
    let s = this.escapeHtml(text || '');
    // Inline image markdown: ![alt](https://...)
    // Rendered BEFORE other inline markers so URL characters aren't
    // eaten by bold/italic/strike regexes.
    s = s.replace(
      /!\[([^\]]*?)\]\((https?:\/\/[^\s)]+?)\)/g,
      (m, alt, url) =>
        `<img src="${url}" alt="${alt || 'image'}" class="comment-image" loading="lazy" referrerpolicy="no-referrer" onclick="window.open(this.src,'_blank')" onerror="this.classList.add('comment-image-broken');this.alt='Image failed to load';">`
    );
    // Bold first so the inner ** isn't eaten by italic.
    s = s.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^\*])\*([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^\/\w])\/([^\/\n]+?)\/(?!\w)/g, '$1<s>$2</s>');
    s = s.replace(/@([A-Za-z0-9_\-\.]+)/g, '<span class="comment-mention">@$1</span>');
    s = s.replace(/\n/g, '<br>');
    return s;
  },

  /**
   * Wrap (or insert) selection in a textarea with the given marker pair.
   * type: 'bold' | 'italic' | 'strike'
   */
  applyFormat(selector, type) {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) return;
    const markers = { bold: ['**', '**'], italic: ['*', '*'], strike: ['/', '/'] }[type];
    if (!markers) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    const selected = el.value.slice(start, end) || 'text';
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    el.value = before + markers[0] + selected + markers[1] + after;
    el.focus();
    const cursorStart = start + markers[0].length;
    el.selectionStart = cursorStart;
    el.selectionEnd = cursorStart + selected.length;
  },

  /**
   * Insert an image (by URL) into a textarea-based comment editor.
   * Renders as ![image](URL) markdown which formatContent() expands
   * back into an <img class="comment-image"> when the comment is shown.
   *
   * Use insertImageInto(selector) for inline triggering from a toolbar
   * button — it opens the modal and inserts on confirm.
   */
  insertImageInto(selector) {
    const el = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!el) return;
    this.openImageUrlModal((url) => {
      const snippet = `\n![image](${url})\n`;
      if (typeof el.value === 'string') {
        // <textarea> path
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        const before = el.value.slice(0, start);
        const after = el.value.slice(end);
        el.value = before + snippet + after;
        el.focus();
        const pos = (before + snippet).length;
        el.selectionStart = el.selectionEnd = pos;
      } else {
        // contenteditable path — insert a real <img> at the caret
        el.focus();
        const html = `<img src="${this.escapeHtml(url)}" alt="image" class="comment-image" loading="lazy" referrerpolicy="no-referrer">`;
        try {
          document.execCommand('insertHTML', false, html + '<br>');
        } catch (_) {
          el.insertAdjacentHTML('beforeend', html);
        }
        // Notify any 'input' listeners (e.g. placeholder toggle)
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });
  },

  /**
   * Show the "Insert Image" popup. Mirrors the Avatar / Cover Photo
   * URL flow used elsewhere on the site: user pastes a URL, sees a
   * live preview, then confirms.
   *
   * Calls onInsert(url) only on successful validation.
   */
  openImageUrlModal(onInsert) {
    // Make sure styles are present (one-time injection).
    this._ensureImageStyles();

    // Tear down any previous instance so opening twice doesn't stack
    // overlays (which would cause the page to look "frozen").
    const existing = document.getElementById('insertImageModal');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'insertImageModal';
    overlay.className = 'modal-overlay image-url-modal';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.innerHTML = `
      <div class="modal" style="max-width:480px;width:100%;">
        <div class="modal-header">
          <h3 class="modal-title"><i class="far fa-image"></i> Insert Image</h3>
          <button type="button" class="modal-close" data-iim-cancel aria-label="Close"><i class="fas fa-times"></i></button>
        </div>
        <div class="modal-body" style="padding:var(--space-md,1rem);">
          <label for="iimUrl" style="display:block;font-size:.875rem;color:var(--text-secondary);margin-bottom:.4rem;">
            Image URL
          </label>
          <input type="url" id="iimUrl" class="form-control"
                 placeholder="https://example.com/image.jpg"
                 autocomplete="off" spellcheck="false"
                 style="width:100%;padding:.6rem .75rem;border-radius:8px;border:1px solid var(--border-color,#333);background:var(--bg-input,#161616);color:var(--text-primary,#fff);">
          <p id="iimMsg" style="font-size:.8125rem;color:var(--text-muted,#888);margin:.5rem 0 0;">
            Paste a direct link ending in .jpg, .png, .gif, .webp, or .avif.
          </p>
          <div id="iimPreviewWrap" style="margin-top:.75rem;display:none;">
            <div style="font-size:.75rem;color:var(--text-muted,#888);margin-bottom:.25rem;">Preview</div>
            <img id="iimPreview" alt="Preview" class="iim-preview">
          </div>
        </div>
        <div class="modal-footer" style="display:flex;gap:.5rem;justify-content:flex-end;padding:var(--space-md,1rem);border-top:1px solid var(--border-color,#222);">
          <button type="button" class="btn btn-ghost btn-sm" data-iim-cancel>Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" id="iimInsert" disabled>
            <i class="far fa-image"></i> Insert Image
          </button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    // Force the overlay visible. The shared .modal-overlay CSS keeps
    // the layer at opacity:0/visibility:hidden until '.active' is set;
    // without this the popup is in the DOM but invisible — which is
    // exactly the "image button does nothing" bug.
    requestAnimationFrame(() => overlay.classList.add('active'));

    const input = overlay.querySelector('#iimUrl');
    const msg = overlay.querySelector('#iimMsg');
    const previewWrap = overlay.querySelector('#iimPreviewWrap');
    const preview = overlay.querySelector('#iimPreview');
    const insertBtn = overlay.querySelector('#iimInsert');

    const close = () => {
      overlay.removeEventListener('click', backdropClose);
      document.removeEventListener('keydown', escClose);
      overlay.remove();
    };
    const backdropClose = (e) => { if (e.target === overlay) close(); };
    const escClose = (e) => { if (e.key === 'Escape') close(); };
    overlay.addEventListener('click', backdropClose);
    document.addEventListener('keydown', escClose);
    overlay.querySelectorAll('[data-iim-cancel]').forEach(b =>
      b.addEventListener('click', close));

    const URL_RE = /^https?:\/\/[^\s<>"']+$/i;
    const IMG_EXT_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)(\?.*)?$/i;

    let lastValidUrl = null;
    const validate = () => {
      const url = (input.value || '').trim();
      lastValidUrl = null;
      if (!url) {
        msg.textContent = 'Paste a direct link ending in .jpg, .png, .gif, .webp, or .avif.';
        msg.style.color = 'var(--text-muted,#888)';
        previewWrap.style.display = 'none';
        insertBtn.disabled = true;
        return;
      }
      if (!URL_RE.test(url)) {
        msg.textContent = 'Enter a valid http(s) URL.';
        msg.style.color = 'var(--danger,#ef4444)';
        previewWrap.style.display = 'none';
        insertBtn.disabled = true;
        return;
      }
      // Try a live preview. We don't strictly require a known
      // extension (some CDNs hide it), but a failed load disables Insert.
      preview.onload = () => {
        msg.textContent = IMG_EXT_RE.test(url)
          ? 'Looks good. Click Insert Image to add it.'
          : 'Preview loaded. Click Insert Image to add it.';
        msg.style.color = 'var(--success,#10b981)';
        lastValidUrl = url;
        insertBtn.disabled = false;
      };
      preview.onerror = () => {
        msg.textContent = 'Could not load that URL as an image.';
        msg.style.color = 'var(--danger,#ef4444)';
        previewWrap.style.display = 'none';
        insertBtn.disabled = true;
        lastValidUrl = null;
      };
      previewWrap.style.display = 'block';
      preview.src = url;
    };

    let debounceId = null;
    input.addEventListener('input', () => {
      clearTimeout(debounceId);
      debounceId = setTimeout(validate, 250);
    });
    input.addEventListener('paste', () => setTimeout(validate, 0));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !insertBtn.disabled) {
        e.preventDefault();
        insertBtn.click();
      }
    });

    insertBtn.addEventListener('click', () => {
      const url = lastValidUrl || (input.value || '').trim();
      if (!url || !URL_RE.test(url)) return;
      close();
      try { onInsert && onInsert(url); } catch (e) { console.error(e); }
    });

    setTimeout(() => input.focus(), 0);
  },

  /**
   * Inject CSS once for inline comment images and the image-URL modal.
   * Kept here (instead of main.css) so the feature is self-contained.
   */
  _ensureImageStyles() {
    if (document.getElementById('commentImageStyles')) return;
    const s = document.createElement('style');
    s.id = 'commentImageStyles';
    s.textContent = `
      .comment-content img.comment-image,
      .comment-image-wrap img.comment-image,
      .review-content img,
      .comment-input.review-editor img {
        display: block;
        max-width: 100%;
        max-height: 420px;
        width: auto;
        height: auto;
        object-fit: contain;
        border-radius: 8px;
        margin: .5rem 0;
        cursor: zoom-in;
        background: rgba(255,255,255,.03);
      }
      @media (max-width: 640px) {
        .comment-content img.comment-image,
        .comment-image-wrap img.comment-image,
        .review-content img { max-height: 320px; }
      }
      .comment-image-broken {
        opacity: .6;
        outline: 1px dashed var(--border-color,#555);
        padding: 1rem;
        cursor: default;
      }
      .image-url-modal .iim-preview {
        display: block;
        max-width: 100%;
        max-height: 220px;
        width: auto;
        object-fit: contain;
        border-radius: 8px;
        background: rgba(255,255,255,.03);
      }
      .format-btn[data-format-image] i { pointer-events: none; }
    `;
    document.head.appendChild(s);
  },

  /**
   * Reply to a reply: opens the parent comment's reply form (replies stay
   * in a single flat thread — no nested cards) and pre-fills "@username ".
   */
  replyToReply(parentCommentId, username) {
    if (!parentCommentId) return;
    const form = document.querySelector(`[data-reply-form="${parentCommentId}"]`);
    if (!form) return;
    form.classList.remove('hidden');
    const input = form.querySelector('textarea');
    if (!input) return;
    const mention = `@${username} `;
    if (!input.value.startsWith(mention)) {
      input.value = mention + input.value;
    }
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
    form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  },

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  },

  /**
   * Render + wire up the chapter-level reactions bar (the 6 emoji buttons
   * shown ABOVE the Discussion section). State is persisted via
   * DB.toggleChapterReaction / DB.getChapterReactions in a single
   * `meta/chapterReactions_<chapterId>` document so we never touch the
   * comments collection or Firestore rules.
   */
  CHAPTER_REACTIONS: [
    ['upvote',    '👍', 'Upvote'],
    ['funny',     '😂', 'Funny'],
    ['love',      '❤️', 'Love'],
    ['surprised', '😲', 'Surprised'],
    ['angry',     '😡', 'Angry'],
    ['sad',       '😢', 'Sad']
  ],

  async initChapterReactions(chapterId) {
    this.chapterReactionsId = chapterId;
    const grid = document.getElementById('chapterReactionsGrid');
    if (!grid) return;

    const user = auth.currentUser;
    let counts = {}, mine = null;
    try {
      const data = await DB.getChapterReactions(chapterId);
      counts = data.counts || {};
      mine = (user && data.userReactions) ? data.userReactions[user.uid] : null;
    } catch (e) {
      console.warn('Could not load chapter reactions:', e.message);
    }

    grid.innerHTML = this.CHAPTER_REACTIONS.map(([key, emoji, label]) => `
      <button type="button"
              class="chapter-reaction-btn ${mine === key ? 'active' : ''}"
              data-chapter-reaction="${key}"
              onclick="Comments.toggleChapterReaction('${key}')"
              style="display:flex;flex-direction:column;align-items:center;gap:.25rem;
                     padding:var(--space-md) var(--space-sm);
                     background:${mine === key ? 'var(--primary-soft, rgba(139,92,246,.15))' : 'transparent'};
                     border:1px solid ${mine === key ? 'var(--primary)' : 'var(--border-color)'};
                     border-radius:var(--radius-md);cursor:pointer;color:var(--text-primary);
                     transition:transform .12s ease, background .12s ease;">
        <span style="font-size:1.75rem;line-height:1;">${emoji}</span>
        <span class="chapter-reaction-count" data-chapter-count="${key}"
              style="font-weight:600;">${counts[key] || 0}</span>
        <span style="font-size:.75rem;color:var(--text-muted);">${label}</span>
      </button>`).join('');

    this.updateChapterReactionsTotal(counts);
  },

  updateChapterReactionsTotal(counts) {
    const total = Object.values(counts || {}).reduce((a, b) => a + (Number(b) || 0), 0);
    const el = document.getElementById('chapterReactionsTotal');
    if (el) el.textContent = total;
  },

  async toggleChapterReaction(key) {
    if (!auth.currentUser) {
      showToast('Please login to react', 'warning');
      return;
    }
    if (!this.chapterReactionsId) return;
    // Single-flight guard — see comments.toggleReaction for the rationale
    // (prevents transaction-retry storms that caused "Quota Exceeded").
    if (this._chapterReactionInFlight) return;
    this._chapterReactionInFlight = true;
    const btns = document.querySelectorAll('.chapter-reaction-btn');
    btns.forEach(b => b.disabled = true);
    try {
      const { counts, mine } = await DB.toggleChapterReaction(this.chapterReactionsId, key);
      Object.entries(counts).forEach(([k, v]) => {
        const el = document.querySelector(`[data-chapter-count="${k}"]`);
        if (el) el.textContent = v;
      });
      document.querySelectorAll('.chapter-reaction-btn').forEach(btn => {
        const active = btn.dataset.chapterReaction === mine;
        btn.classList.toggle('active', active);
        btn.style.background = active ? 'var(--primary-soft, rgba(139,92,246,.15))' : 'transparent';
        btn.style.borderColor = active ? 'var(--primary)' : 'var(--border-color)';
      });
      this.updateChapterReactionsTotal(counts);
    } catch (e) {
      showToast(e.message || 'Failed to react', 'error');
    } finally {
      this._chapterReactionInFlight = false;
      btns.forEach(b => b.disabled = false);
    }
  },

  /**
   * Cleanup
   */
  destroy() {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }
};

// Expose globally
window.Comments = Comments;
