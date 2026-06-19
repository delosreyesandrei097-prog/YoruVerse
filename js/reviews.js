/**
 * ============================================================
 * YORUVERSE - COMMUNITY REVIEWS MODULE
 * ============================================================
 * Per-series review system that VISUALLY MIRRORS the Chapter
 * Comment Section (js/comments.js + the `.comment-*` styles in
 * css/main.css). Layout, cards, replies, three-dot menu, report
 * popup, block popup, mention highlight, timestamps and mobile
 * responsiveness are all sourced from the same primitives the
 * Chapter Comments use, so both surfaces feel identical.
 *
 * What stays unique to Community Reviews:
 *   - Helpful / Not Helpful voting buttons
 *   - Total Votes counter
 *   - Most Helpful / Newest / Oldest sort
 *
 * The DB contract (DB.addReview / DB.voteReview / DB.getReviews /
 * DB.getReviewReplies / DB.updateReview / DB.deleteReview /
 * DB.reportReview) is unchanged — only the UI was rebuilt.
 * ============================================================
 */
(function () {
  'use strict';

  const ALLOWED_TAGS = ['B', 'STRONG', 'I', 'EM', 'S', 'STRIKE', 'DEL', 'BR', 'IMG'];
  // Per-tag attribute allow-list. Anything not listed is stripped.
  const ALLOWED_ATTRS = {
    IMG: ['src', 'alt', 'class']
  };
  const REPORT_REASONS = [
    'Spam',
    'Harassment',
    'Hate Speech',
    'Inappropriate Content',
    'Misleading Information',
    'Other'
  ];

  /** Escape plain text for safe HTML insertion. */
  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Sanitize a contenteditable's HTML so only the formatting tags we
   * advertise survive. Everything else is reduced to its text content.
   */
  function sanitizeReviewHtml(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '');
    const walk = (node) => {
      const children = Array.from(node.childNodes);
      for (const child of children) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (!ALLOWED_TAGS.includes(child.tagName)) {
            const text = document.createTextNode(child.textContent || '');
            node.replaceChild(text, child);
          } else {
            const keep = ALLOWED_ATTRS[child.tagName] || [];
            for (const attr of Array.from(child.attributes || [])) {
              if (!keep.includes(attr.name.toLowerCase())) {
                child.removeAttribute(attr.name);
              }
            }
            // IMG hardening: only http(s) src, force safe class, no event
            // handlers (none survived attr filter anyway).
            if (child.tagName === 'IMG') {
              const src = (child.getAttribute('src') || '').trim();
              if (!/^https?:\/\//i.test(src)) {
                const text = document.createTextNode('');
                node.replaceChild(text, child);
                continue;
              }
              child.setAttribute('class', 'comment-image');
              child.setAttribute('loading', 'lazy');
              child.setAttribute('referrerpolicy', 'no-referrer');
              if (!child.getAttribute('alt')) child.setAttribute('alt', 'image');
              // IMG is a void element — no children to walk.
              continue;
            }
            walk(child);
          }
        }
      }
    };
    walk(wrap);
    return wrap.innerHTML.trim().slice(0, 5000);
  }

  /**
   * Post-process stored review HTML so @mentions get the same
   * `.comment-mention` highlight chapter comments use. We only touch
   * raw text nodes so existing <b>/<i>/<s> tags survive intact.
   */
  function decorateMentions(html) {
    const wrap = document.createElement('div');
    wrap.innerHTML = String(html || '');
    const walk = (node) => {
      const kids = Array.from(node.childNodes);
      for (const child of kids) {
        if (child.nodeType === Node.TEXT_NODE) {
          const t = child.nodeValue || '';
          if (!/@[A-Za-z0-9_\-.]+/.test(t)) continue;
          const tmp = document.createElement('span');
          tmp.innerHTML = esc(t).replace(
            /@([A-Za-z0-9_\-.]+)/g,
            '<span class="comment-mention">@$1</span>'
          );
          const frag = document.createDocumentFragment();
          while (tmp.firstChild) frag.appendChild(tmp.firstChild);
          node.replaceChild(frag, child);
        } else if (child.nodeType === Node.ELEMENT_NODE) {
          walk(child);
        }
      }
    };
    walk(wrap);
    return wrap.innerHTML;
  }

  function timeAgo(ts) {
    try {
      const ms = ts?.toMillis?.() || (typeof ts === 'number' ? ts : 0);
      if (!ms) return 'just now';
      const diff = Math.max(0, Date.now() - ms);
      const s = Math.floor(diff / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      const h = Math.floor(m / 60);
      if (h < 24) return `${h}h ago`;
      const d = Math.floor(h / 24);
      if (d < 30) return `${d}d ago`;
      const mo = Math.floor(d / 30);
      if (mo < 12) return `${mo}mo ago`;
      return `${Math.floor(mo / 12)}y ago`;
    } catch (_) { return 'just now'; }
  }

  function toast(msg, kind = 'info') {
    try {
      if (typeof showToast === 'function') return showToast(msg, kind);
      if (window.UI?.toast) return window.UI.toast(msg, kind);
    } catch (_) {}
    console.log(`[${kind}] ${msg}`);
  }

  const Reviews = {
    seriesId: null,
    currentSort: 'helpful',
    items: [],
    repliesByParent: {},
    myVotes: {},

    init(seriesId) {
      if (!seriesId) return;
      this.seriesId = seriesId;
      this.currentSort = 'helpful';
      this._injectStyles();
      // Ensure the shared comment-image CSS is present even if
      // Comments.init() never runs on this page.
      if (window.Comments && typeof Comments._ensureImageStyles === 'function') {
        Comments._ensureImageStyles();
      }
      this._mount();
      this._bind();
      this.load();
    },

    /**
     * Minimal extra CSS: the Helpful / Not Helpful / Total Votes
     * buttons (unique to reviews) and the sort toolbar. Everything else
     * (cards, headers, badges, mentions, replies, three-dot menu,
     * reply form) reuses the existing `.comment-*` styles from
     * css/main.css so the two surfaces look identical.
     */
    _injectStyles() {
      if (document.getElementById('reviewsModuleStyles')) return;
      const css = document.createElement('style');
      css.id = 'reviewsModuleStyles';
      css.textContent = `
        .reviews-toolbar{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:.75rem;margin-bottom:1rem;}
        .reviews-sort{display:flex;gap:.25rem;background:var(--bg-secondary,#1a1a1a);padding:.25rem;border-radius:8px;flex-wrap:wrap;}
        .reviews-sort button{padding:.4rem .8rem;border:0;background:transparent;color:var(--text-secondary,#bbb);border-radius:6px;cursor:pointer;font-size:.85rem;font-weight:500;}
        .reviews-sort button.active{background:var(--primary,#8b5cf6);color:#fff;}
        .comment-btn.review-vote.active.helpful{color:#22c55e;}
        .comment-btn.review-vote.active.helpful i{color:#22c55e;}
        .comment-btn.review-vote.active.not-helpful{color:#ef4444;}
        .comment-btn.review-vote.active.not-helpful i{color:#ef4444;}
        .review-vote-total{display:inline-flex;align-items:center;font-size:.8125rem;color:var(--text-muted,#888);margin-left:.25rem;}
        .review-empty{text-align:center;padding:2rem 1rem;color:var(--text-muted,#888);}
        .comment-card.review-blocked .comment-body{display:flex;align-items:center;justify-content:space-between;gap:.5rem;color:var(--text-muted,#888);font-size:.85rem;}
        .comment-card.review-blocked .comment-blocked-unhide{background:transparent;border:0;color:var(--primary,#8b5cf6);cursor:pointer;font-size:.85rem;}
      `;
      document.head.appendChild(css);
    },

    _mount() {
      const root = document.querySelector('[data-tab-content="reviews"]');
      if (!root) return;
      root.innerHTML = `
        <div class="reviews-toolbar">
          <div style="display:flex;align-items:center;gap:.6rem;">
            <h3 style="font-size:1.125rem;font-weight:600;margin:0;">Community Reviews</h3>
            <button type="button" id="reviewRulesBtn" class="btn btn-ghost btn-sm" title="Community review rules">
              <i class="fas fa-gavel"></i> Rules
            </button>
          </div>
          <div class="reviews-sort" id="reviewsSort">
            <button type="button" data-sort="helpful" class="active">Most Helpful</button>
            <button type="button" data-sort="newest">Newest</button>
            <button type="button" data-sort="oldest">Oldest</button>
          </div>
        </div>
        <div id="reviewComposerSlot"></div>
        <div id="reviewsList">
          <div class="review-empty"><div class="spinner" style="margin:0 auto;"></div></div>
        </div>
      `;
      this._renderComposer();
    },

    _bind() {
      document.getElementById('reviewsSort')?.addEventListener('click', (e) => {
        const btn = e.target.closest('button[data-sort]');
        if (!btn) return;
        this.changeSort(btn.dataset.sort);
      });
      document.getElementById('reviewRulesBtn')?.addEventListener('click', () => this.openRules());
      document.getElementById('reviewsList')?.addEventListener('click', (e) => this._onListClick(e));
      window.addEventListener('authStateChanged', () => {
        this._renderComposer();
        this.load();
      });
    },

    _renderComposer() {
      const slot = document.getElementById('reviewComposerSlot');
      if (!slot) return;
      const user = firebase.auth().currentUser;
      if (!user) {
        slot.innerHTML = `
          <div class="comment-form" style="justify-content:center;">
            <div style="flex:1;padding:var(--space-md);background:var(--bg-card);border-radius:var(--radius-md);text-align:center;">
              <p style="color:var(--text-secondary);margin-bottom:var(--space-md);">Sign in to share your review.</p>
              <a class="btn btn-primary" href="login.html">Login to post a review</a>
            </div>
          </div>`;
        return;
      }
      const avatar = (window.Auth?.userData?.avatar)
        || user.photoURL
        || '../images/default-avatar.png';
      slot.innerHTML = this._composerHtml({
        id: 'main',
        avatar,
        placeholder: 'Share your thoughts about this series...'
      });
      this._wireComposer(slot.querySelector('.comment-form'), { parentId: null });
    },

    /**
     * Composer markup that mirrors the Chapter Comments form: avatar +
     * format toolbar + contenteditable input + actions row. We keep
     * the editor as contenteditable so users can still apply Bold /
     * Italic / Strike (the existing DB contract stores review content
     * as HTML), but the surrounding wrapper uses the same `.comment-*`
     * classes so the visual chrome is byte-for-byte identical.
     */
    _composerHtml({ id, avatar, placeholder, initialHtml = '', submitLabel = null, showCancel = false }) {
      const label = submitLabel || (id.startsWith('reply-')
        ? 'Reply'
        : (id.startsWith('edit-') ? 'Save' : '<i class="fas fa-paper-plane"></i> Post Review'));
      const avatarImg = avatar
        ? `<img src="${esc(avatar)}" alt="You" class="comment-avatar" onerror="this.src='../images/default-avatar.png'">`
        : '';
      return `
        <div class="comment-form ${id.startsWith('reply-') ? 'reply-form' : ''}" data-composer="${esc(id)}">
          ${avatarImg}
          <div class="comment-input-wrapper" style="width:100%;">
            <div class="format-toolbar" role="toolbar" aria-label="Text formatting">
              <button type="button" class="format-btn" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
              <button type="button" class="format-btn" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
              <button type="button" class="format-btn" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
              <button type="button" class="format-btn" data-cmd="image" data-format-image title="Insert Image (URL)"><i class="far fa-image"></i></button>
            </div>
            <div class="comment-input review-editor" contenteditable="true"
                 data-placeholder="${esc(placeholder)}"
                 style="min-height:80px;max-height:260px;overflow:auto;">${initialHtml}</div>
            <div class="comment-actions" style="display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;">
              ${showCancel
                ? `<button type="button" class="btn btn-ghost btn-sm" data-action="cancel" style="margin-right:auto;">Cancel</button>`
                : `<span style="margin-right:auto;"></span>`}
              <button type="button" class="btn btn-primary btn-sm" data-action="submit">${label}</button>
            </div>
          </div>
        </div>`;
    },

    _wireComposer(rootEl, { parentId = null, reviewId = null, mode = 'create', onDone = null } = {}) {
      if (!rootEl) return;
      const editor = rootEl.querySelector('.review-editor');
      if (!editor) return;

      // Empty-state placeholder for contenteditable.
      const updatePlaceholder = () => {
        if (!editor.textContent.trim() && !editor.querySelector('img')) {
          editor.classList.add('is-empty');
        } else {
          editor.classList.remove('is-empty');
        }
      };
      // Inject one-time placeholder rule.
      if (!document.getElementById('reviewEditorPlaceholderStyle')) {
        const s = document.createElement('style');
        s.id = 'reviewEditorPlaceholderStyle';
        s.textContent = `.review-editor.is-empty:before{content:attr(data-placeholder);color:var(--text-muted,#777);pointer-events:none;}`;
        document.head.appendChild(s);
      }
      updatePlaceholder();
      editor.addEventListener('input', updatePlaceholder);

      rootEl.querySelectorAll('.format-btn').forEach(btn => {
        btn.addEventListener('mousedown', (e) => {
          e.preventDefault();
          editor.focus();
          const cmd = btn.dataset.cmd;
          if (cmd === 'image') {
            // Open the shared "Insert Image" popup from the Comments
            // module so reviews use the exact same UX as the chapter
            // comments and discussion board.
            if (window.Comments && typeof Comments.insertImageInto === 'function') {
              Comments.insertImageInto(editor);
              setTimeout(updatePlaceholder, 0);
            }
            return;
          }
          document.execCommand(cmd, false, null);
        });
      });
      editor.addEventListener('keydown', (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const k = e.key.toLowerCase();
        if (k === 'b' || k === 'i') {
          e.preventDefault();
          document.execCommand(k === 'b' ? 'bold' : 'italic');
        }
      });

      const cancelBtn = rootEl.querySelector('[data-action="cancel"]');
      const submitBtn = rootEl.querySelector('[data-action="submit"]');
      if (cancelBtn && onDone) {
        cancelBtn.addEventListener('click', () => onDone(false));
      }
      submitBtn.addEventListener('click', async () => {
        const html = sanitizeReviewHtml(editor.innerHTML);
        const plain = editor.textContent.trim();
        if (!plain) { toast('Please write something first', 'warning'); return; }
        submitBtn.disabled = true;
        const originalLabel = submitBtn.innerHTML;
        submitBtn.innerHTML = '<div class="spinner spinner-sm" style="border-color:currentColor;"></div>';
        try {
          if (mode === 'edit' && reviewId) {
            await DB.updateReview(reviewId, html);
            toast('Review updated', 'success');
          } else {
            await DB.addReview({ seriesId: this.seriesId, content: html, parentId });
            toast(parentId ? 'Reply posted' : 'Review posted', 'success');
          }
          editor.innerHTML = '';
          if (onDone) onDone(true);
          await this.load();
        } catch (e) {
          console.error(e);
          toast(e.message || 'Failed to post', 'error');
        } finally {
          submitBtn.disabled = false;
          submitBtn.innerHTML = originalLabel;
        }
      });
    },

    async changeSort(sort) {
      if (!['helpful', 'newest', 'oldest'].includes(sort)) return;
      this.currentSort = sort;
      document.querySelectorAll('#reviewsSort button').forEach(b => {
        b.classList.toggle('active', b.dataset.sort === sort);
      });
      await this.load();
    },

    async load() {
      const list = document.getElementById('reviewsList');
      if (!list) return;
      list.innerHTML = `<div class="review-empty"><div class="spinner" style="margin:0 auto;"></div></div>`;
      try {
        const items = await DB.getReviews(this.seriesId, { sort: this.currentSort });
        this.items = items;
        const replies = await Promise.all(
          items.map(r => DB.getReviewReplies(r.id).catch(() => []))
        );
        const me = firebase.auth().currentUser;
        const deriveVote = (r) => {
          if (!me) return null;
          if (Array.isArray(r.helpfulBy) && r.helpfulBy.includes(me.uid)) return 'helpful';
          if (Array.isArray(r.notHelpfulBy) && r.notHelpfulBy.includes(me.uid)) return 'not_helpful';
          return null;
        };
        this.repliesByParent = {};
        this.myVotes = {};
        items.forEach((r, i) => {
          this.repliesByParent[r.id] = replies[i] || [];
          this.myVotes[r.id] = deriveVote(r);
          (replies[i] || []).forEach(rp => { this.myVotes[rp.id] = deriveVote(rp); });
        });

        if (!items.length) {
          list.innerHTML = `
            <div class="empty-state" style="padding:2rem;">
              <div class="empty-state-icon"><i class="far fa-comments"></i></div>
              <h3 class="empty-state-title">No reviews yet</h3>
              <p class="empty-state-desc">Be the first to share your thoughts!</p>
            </div>`;
          return;
        }
        list.innerHTML = items.map(r => this._renderReview(r, false)).join('');
      } catch (e) {
        console.error('Failed to load reviews', e);
        list.innerHTML = `<div class="review-empty">Couldn't load reviews. <button class="btn btn-ghost btn-sm" onclick="Reviews.load()">Retry</button></div>`;
      }
    },

    /**
     * Render a single review or reply using the SAME `.comment-card`
     * structure as chapter comments. The only review-specific bits
     * (Helpful / Not Helpful / Total Votes) live in `.comment-footer`
     * as additional `.comment-btn` variants so spacing and alignment
     * stay consistent with the chapter comments footer.
     */
    _renderReview(r, isReply) {
      const me = firebase.auth().currentUser;
      const isMine = me && r.userId === me.uid;

      // Live-overlay current user's own profile so freshly-changed
      // avatars / titles show without re-querying Firestore.
      if (isMine && window.Auth?.userData) {
        const profile = Auth.userData;
        const activeCustomTitle = (typeof Donation !== 'undefined')
          ? Donation.getActiveCustomTitle?.(profile)
          : null;
        r = {
          ...r,
          userName: profile.username || profile.displayName || r.userName,
          userAvatar: profile.avatar || profile.avatarUrl || profile.photoURL || r.userAvatar,
          authorRole: profile.role || r.authorRole || 'user',
          authorLevel: profile.level || (typeof EXPSystem !== 'undefined' ? EXPSystem.levelFromExp(profile.exp || 0) : r.authorLevel),
          authorTitleId: profile.selectedTitleId || r.authorTitleId,
          authorCustomTitleId: activeCustomTitle?.id || r.authorCustomTitleId,
          authorCustomTitleExpiresAt: activeCustomTitle?.expiresAt || r.authorCustomTitleExpiresAt
        };
      }

      if (!isMine && this.isBlocked(r.userId)) {
        return `<div class="comment-card review-blocked" data-review-id="${esc(r.id)}">
          <div class="comment-body">
            <span><i class="fas fa-ban"></i> Review hidden — you blocked this user.</span>
            <button type="button" class="comment-blocked-unhide" data-action="unblock" data-user-id="${esc(r.userId || '')}">Unblock</button>
          </div>
        </div>`;
      }

      const defaultAvatar = '../images/default-avatar.png';
      const avatarSrc = r.userAvatar && String(r.userAvatar).trim() ? r.userAvatar : defaultAvatar;
      const authorName = r.userName || r.username || r.displayName || 'User';
      const userHref = r.userId
        ? (typeof AppPath !== 'undefined' ? AppPath.to(`pages/user.html?uid=${r.userId}`) : `user.html?uid=${r.userId}`)
        : '#';

      // Badges — identical order/markup to chapter comments.
      let customTitleBadge = '';
      if (typeof Donation !== 'undefined' && r.authorCustomTitleId) {
        const exp = r.authorCustomTitleExpiresAt;
        const expMs = exp?.toMillis?.() ?? exp ?? null;
        if (!expMs || expMs > Date.now()) {
          try { customTitleBadge = Donation.renderCustomTitleBadge(r.authorCustomTitleId) || ''; } catch (_) {}
        }
      }
      let titleBadge = '';
      if (!customTitleBadge && typeof EXPSystem !== 'undefined' && r.authorTitleId) {
        try { titleBadge = EXPSystem.renderTitleBadge(r.authorTitleId) || ''; } catch (_) {}
      }
      let levelBadge = '';
      if (typeof EXPSystem !== 'undefined' && r.authorLevel) {
        try { levelBadge = EXPSystem.renderLevelBadge(r.authorLevel) || ''; } catch (_) {}
      }
      let roleBadgeHtml = '';
      const role = r.authorRole || '';
      if (role === 'admin') {
        roleBadgeHtml = `<span class="role-badge role-badge-admin" title="Administrator"><i class="fas fa-crown"></i> ADMIN</span>`;
      } else if (role === 'moderator') {
        roleBadgeHtml = `<span class="role-badge role-badge-moderator" title="Moderator"><i class="fas fa-shield-alt"></i> MOD</span>`;
      }
      const staffClass = (role === 'admin' || role === 'moderator') ? ' comment-staff' : '';

      const myVote = this.myVotes[r.id] || null;
      const totalVotes = (r.totalVotes != null)
        ? r.totalVotes
        : ((r.helpfulCount || 0) + (r.notHelpfulCount || 0));

      // Three-dot menu (matches Chapter Comments markup).
      const isStaff = !!(window.Auth && typeof Auth.hasRole === 'function' && Auth.hasRole('moderator'));
      const menuItems = [];
      if (!isMine) {
        menuItems.push(`<button class="menu-item" data-mact="report"><i class="far fa-flag"></i> Report</button>`);
        if (r.userId) {
          menuItems.push(`<button class="menu-item" data-mact="block"><i class="fas fa-user-slash"></i> Block User</button>`);
        }
      }
      if (isMine) {
        menuItems.push(`<button class="menu-item" data-mact="edit"><i class="far fa-edit"></i> Edit</button>`);
      }
      if (isMine || isStaff) {
        menuItems.push(`<button class="menu-item menu-item-danger" data-mact="delete"><i class="far fa-trash-alt"></i> Delete</button>`);
      }
      const menuHtml = menuItems.length ? `
        <div class="comment-menu">
          <button class="comment-menu-trigger" aria-label="More options" data-action="menu-toggle">
            <i class="fas fa-ellipsis-h"></i>
          </button>
          <div class="comment-menu-dropdown hidden" data-review-menu="${esc(r.id)}">
            ${menuItems.join('')}
          </div>
        </div>` : '';

      const safeContent = decorateMentions(r.content || '');

      const replies = !isReply ? (this.repliesByParent[r.id] || []) : [];
      const replyCount = replies.length;
      const repliesHtml = !isReply && replyCount > 0
        ? `<div class="replies-toggle" data-replies-toggle="${esc(r.id)}">
            <button class="replies-toggle-btn" data-action="toggle-replies">
              <i class="fas fa-chevron-down"></i>
              <span data-replies-label="${esc(r.id)}">View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
            </button>
          </div>
          <div class="replies-container hidden" data-replies-container="${esc(r.id)}">
            ${replies.map(rp => this._renderReview(rp, true)).join('')}
          </div>`
        : '';

      const replyFormHtml = !isReply
        ? `<div data-reply-slot="${esc(r.id)}"></div>`
        : '';

      // Footer — chapter-comments layout with review-specific buttons.
      const helpfulBtn = `
        <button class="comment-btn review-vote ${myVote === 'helpful' ? 'active helpful' : ''}"
                data-action="vote" data-vote="helpful" title="Helpful">
          <i class="fas fa-thumbs-up"></i>
          <span>Helpful</span>
          <span data-helpful>${r.helpfulCount || 0}</span>
        </button>`;
      const notHelpfulBtn = `
        <button class="comment-btn review-vote ${myVote === 'not_helpful' ? 'active not-helpful' : ''}"
                data-action="vote" data-vote="not_helpful" title="Not Helpful">
          <i class="fas fa-thumbs-down"></i>
          <span>Not Helpful</span>
          <span data-nothelpful>${r.notHelpfulCount || 0}</span>
        </button>`;
      const totalEl = `<span class="review-vote-total">Total Votes: <span data-total>${totalVotes}</span></span>`;
      const replyBtn = !isReply
        ? `<button class="comment-btn" data-action="reply"><i class="far fa-comment"></i> Reply</button>`
        : `<button class="comment-btn" data-action="reply-to-reply" data-username="${esc(authorName)}" data-parent="${esc(r.parentId || '')}"><i class="far fa-comment"></i> Reply</button>`;

      return `
        <div class="comment-card${staffClass}${isReply ? ' comment-reply' : ''}" data-review-id="${esc(r.id)}" data-user-id="${esc(r.userId || '')}">
          <a href="${esc(userHref)}" class="comment-avatar-link">
            <img src="${esc(avatarSrc)}" alt="${esc(authorName)}" class="comment-avatar" onerror="this.onerror=null;this.src='${defaultAvatar}'">
          </a>
          <div class="comment-body">
            <div class="comment-header">
              <div class="comment-meta">
                <a href="${esc(userHref)}" class="comment-author-link"><span class="comment-author">${esc(authorName)}</span></a>
                <div class="comment-badges">${customTitleBadge}${roleBadgeHtml}${levelBadge}${titleBadge}</div>
              </div>
              ${menuHtml}
            </div>
            <div class="comment-time">${esc(timeAgo(r.createdAt))}${r.isEdited ? ' · edited' : ''}</div>
            <div class="comment-content" data-content>${safeContent}</div>
            <div class="comment-footer">
              ${helpfulBtn}
              ${notHelpfulBtn}
              ${totalEl}
              ${replyBtn}
            </div>
            ${replyFormHtml}
            ${repliesHtml}
          </div>
        </div>`;
    },

    async _onListClick(e) {
      // Three-dot toggle
      const menuToggle = e.target.closest('[data-action="menu-toggle"]');
      if (menuToggle) {
        e.stopPropagation();
        const card = menuToggle.closest('[data-review-id]');
        const dropdown = card?.querySelector('.comment-menu-dropdown');
        if (!dropdown) return;
        document.querySelectorAll('.comment-menu-dropdown').forEach(el => {
          if (el !== dropdown) el.classList.add('hidden');
        });
        const willOpen = dropdown.classList.contains('hidden');
        dropdown.classList.toggle('hidden');
        if (willOpen) {
          setTimeout(() => {
            const close = (ev) => {
              if (!dropdown.contains(ev.target)) {
                dropdown.classList.add('hidden');
                document.removeEventListener('click', close);
              }
            };
            document.addEventListener('click', close);
          }, 0);
        }
        return;
      }

      // Menu item actions
      const mactBtn = e.target.closest('[data-mact]');
      if (mactBtn) {
        const card = mactBtn.closest('[data-review-id]');
        const reviewId = card?.dataset.reviewId;
        const mact = mactBtn.dataset.mact;
        card?.querySelector('.comment-menu-dropdown')?.classList.add('hidden');
        if (!reviewId) return;
        if (mact === 'edit') this._beginEdit(reviewId);
        else if (mact === 'delete') {
          const review = this._findReview(reviewId);
          const me = firebase.auth().currentUser;
          const isMine = !!(me && review && review.userId === me.uid);
          const isStaff = !!(window.Auth?.hasRole?.('moderator'));
          this._confirmDelete(reviewId, { staff: isStaff && !isMine });
        }
        else if (mact === 'report') this.openReport(reviewId);
        else if (mact === 'block') {
          const review = this._findReview(reviewId);
          if (review) this.blockUser(review.userId, review.userName || review.username, review.userAvatar);
        }
        return;
      }

      // Item-level actions
      const item = e.target.closest('.comment-card[data-review-id]');
      if (!item) return;
      const reviewId = item.dataset.reviewId;
      const actionBtn = e.target.closest('[data-action]');
      if (!actionBtn) return;
      const action = actionBtn.dataset.action;

      if (action === 'vote') {
        const vote = actionBtn.dataset.vote;
        if (!firebase.auth().currentUser) { toast('Login to vote', 'warning'); return; }
        try {
          const res = await DB.voteReview(reviewId, vote);
          const hEl = item.querySelector('[data-helpful]');
          const nEl = item.querySelector('[data-nothelpful]');
          const tEl = item.querySelector('[data-total]');
          if (hEl) hEl.textContent = res.helpfulCount;
          if (nEl) nEl.textContent = res.notHelpfulCount;
          if (tEl) tEl.textContent = res.totalVotes != null ? res.totalVotes : ((res.helpfulCount || 0) + (res.notHelpfulCount || 0));
          item.querySelectorAll('.review-vote').forEach(b => {
            b.classList.remove('active', 'helpful', 'not-helpful');
            if (res.myVote && b.dataset.vote === res.myVote) {
              b.classList.add('active', res.myVote === 'helpful' ? 'helpful' : 'not-helpful');
            }
          });
          this.myVotes[reviewId] = res.myVote;
        } catch (err) {
          toast(err.message || 'Failed to vote', 'error');
        }
      } else if (action === 'unblock') {
        const uid = actionBtn.dataset.userId;
        if (uid) this.unblockUser(uid);
      } else if (action === 'reply') {
        if (!firebase.auth().currentUser) { toast('Login to reply', 'warning'); return; }
        const slot = item.querySelector(`[data-reply-slot="${reviewId}"]`);
        if (!slot) return;
        if (slot.firstChild) { slot.innerHTML = ''; return; }
        const avatar = (window.Auth?.userData?.avatar)
          || firebase.auth().currentUser.photoURL
          || '../images/default-avatar.png';
        slot.innerHTML = this._composerHtml({
          id: `reply-${reviewId}`,
          avatar,
          placeholder: 'Write a reply...',
          showCancel: true
        });
        this._wireComposer(slot.querySelector('.comment-form'), {
          parentId: reviewId,
          onDone: () => { slot.innerHTML = ''; }
        });
        slot.querySelector('.review-editor')?.focus();
      } else if (action === 'reply-to-reply') {
        if (!firebase.auth().currentUser) { toast('Login to reply', 'warning'); return; }
        const parentId = actionBtn.dataset.parent;
        const username = actionBtn.dataset.username;
        const parentCard = parentId
          ? document.querySelector(`.comment-card[data-review-id="${parentId}"]`)
          : null;
        if (!parentCard) return;
        const slot = parentCard.querySelector(`[data-reply-slot="${parentId}"]`);
        if (!slot) return;
        if (!slot.firstChild) {
          const avatar = (window.Auth?.userData?.avatar)
            || firebase.auth().currentUser.photoURL
            || '../images/default-avatar.png';
          slot.innerHTML = this._composerHtml({
            id: `reply-${parentId}`,
            avatar,
            placeholder: 'Write a reply...',
            showCancel: true
          });
          this._wireComposer(slot.querySelector('.comment-form'), {
            parentId,
            onDone: () => { slot.innerHTML = ''; }
          });
        }
        const editor = slot.querySelector('.review-editor');
        if (editor) {
          const mention = `@${username} `;
          const current = editor.textContent;
          if (!current.startsWith(mention)) {
            editor.textContent = mention + current;
          }
          editor.focus();
          // place caret at end
          const range = document.createRange();
          range.selectNodeContents(editor);
          range.collapse(false);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else if (action === 'toggle-replies') {
        const container = item.querySelector(`[data-replies-container="${reviewId}"]`);
        const label = item.querySelector(`[data-replies-label="${reviewId}"]`);
        const icon = item.querySelector(`[data-replies-toggle="${reviewId}"] i`);
        if (!container) return;
        const isHidden = container.classList.toggle('hidden');
        const count = container.querySelectorAll(':scope > .comment-card').length;
        if (label) {
          label.textContent = isHidden
            ? `View ${count} ${count === 1 ? 'reply' : 'replies'}`
            : `Hide ${count === 1 ? 'reply' : 'replies'}`;
        }
        if (icon) icon.className = isHidden ? 'fas fa-chevron-down' : 'fas fa-chevron-up';
      }
    },

    _findReview(reviewId) {
      const top = this.items.find(r => r.id === reviewId);
      if (top) return top;
      for (const list of Object.values(this.repliesByParent)) {
        const m = list.find(r => r.id === reviewId);
        if (m) return m;
      }
      return null;
    },

    _beginEdit(reviewId) {
      const item = document.querySelector(`.comment-card[data-review-id="${reviewId}"]`);
      if (!item) return;
      const contentEl = item.querySelector('[data-content]');
      if (!contentEl) return;
      const originalHtml = contentEl.innerHTML;

      // Prefer the unified Edit Comment modal (shared with the chapter
      // comments and discussion board) so the editing UX is identical
      // across the whole site.
      if (window.Comments && typeof Comments.openEditCommentModal === 'function') {
        // Convert <br> back to newlines so the textarea shows the same
        // line breaks the user originally typed. Other HTML is kept as
        // raw markup so bold/italic/strike/image tags survive the round
        // trip and are re-sanitized on save.
        const initial = String(originalHtml || '').replace(/<br\s*\/?\s*>/gi, '\n');
        Comments.openEditCommentModal({
          initial,
          title: 'Edit Review',
          onSave: async (newText) => {
            const trimmed = (newText || '').trim();
            if (!trimmed) { toast('Review cannot be empty', 'warning'); return false; }
            try {
              const cleaned = sanitizeReviewHtml(trimmed.replace(/\n/g, '<br>'));
              await DB.updateReview(reviewId, cleaned);
              toast('Review updated', 'success');
              await this.load();
              return true;
            } catch (e) {
              console.error(e);
              toast(e.message || 'Failed to update review', 'error');
              return false;
            }
          }
        });
        return;
      }

      // Fallback (Comments module not loaded for some reason): keep the
      // original inline composer so editing never fully breaks.
      const avatar = (window.Auth?.userData?.avatar)
        || firebase.auth().currentUser?.photoURL
        || '../images/default-avatar.png';
      const wrap = document.createElement('div');
      wrap.innerHTML = this._composerHtml({
        id: `edit-${reviewId}`,
        avatar,
        placeholder: 'Edit your review...',
        initialHtml: originalHtml,
        showCancel: true
      });
      const composer = wrap.firstElementChild;
      contentEl.replaceWith(composer);
      this._wireComposer(composer, {
        reviewId,
        mode: 'edit',
        onDone: () => this.load()
      });
    },

    async _confirmDelete(reviewId, opts = {}) {
      const msg = opts.staff
        ? 'Delete this review as a moderator? This cannot be undone.'
        : 'Delete this review? This cannot be undone.';
      if (!confirm(msg)) return;
      try {
        await DB.deleteReview(reviewId);
        toast(opts.staff ? 'Review removed by moderator' : 'Review deleted', 'success');
        await this.load();
      } catch (e) {
        toast(e.message || 'Failed to delete', 'error');
      }
    },

    /**
     * Report popup — same design + workflow as the Chapter Comments
     * report popup (dropdown of reasons + optional details textarea).
     */
    openReport(reviewId) {
      if (!firebase.auth().currentUser) { toast('Login to report', 'warning'); return; }
      let modal = document.getElementById('reviewReportModal');
      const showModal = (m) => { m.style.display = 'flex'; m.style.visibility = 'visible'; m.style.opacity = '1'; m.classList.add('active'); };
      const hideModal = (m) => { m.style.display = 'none'; m.style.visibility = 'hidden'; m.style.opacity = '0'; m.classList.remove('active'); };
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'reviewReportModal';
        modal.className = 'review-report-modal';
        modal.style.cssText = 'display:none;visibility:hidden;opacity:0;position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.75);align-items:center;justify-content:center;padding:1rem;';
        modal.innerHTML = `
          <div class="modal" style="max-width:440px;width:100%;background:var(--bg-card,#141414);border:1px solid var(--border-color,#2a2a2a);border-radius:12px;padding:1.25rem;color:var(--text-primary,#fff);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:1.1rem;"><i class="fas fa-flag"></i> Report Review</h3>
              <button type="button" class="icon-btn" data-close style="background:transparent;border:0;color:#888;cursor:pointer;font-size:1.2rem;">&times;</button>
            </div>
            <label class="form-label" style="display:block;margin-bottom:.4rem;font-size:.85rem;color:var(--text-secondary,#cfcfcf);">Reason</label>
            <select id="reviewReportReason" class="form-input" style="width:100%;margin-bottom:.75rem;">
              ${REPORT_REASONS.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
            </select>
            <label class="form-label" style="display:block;margin-bottom:.4rem;font-size:.85rem;color:var(--text-secondary,#cfcfcf);">Details (optional)</label>
            <textarea id="reviewReportDetails" class="form-input" rows="3" style="width:100%;resize:vertical;" placeholder="Give moderators a bit more context..."></textarea>
            <div style="display:flex;justify-content:flex-end;gap:.5rem;margin-top:1rem;">
              <button type="button" class="btn btn-ghost btn-sm" data-close>Cancel</button>
              <button type="button" class="btn btn-primary btn-sm" id="reviewReportSubmit">Submit Report</button>
            </div>
          </div>`;
        document.body.appendChild(modal);
        modal.querySelectorAll('[data-close]').forEach(b =>
          b.addEventListener('click', () => hideModal(modal)));
        modal.addEventListener('click', (e) => {
          if (e.target === modal) hideModal(modal);
        });
      }
      modal.dataset.targetReviewId = reviewId;
      showModal(modal);
      const oldBtn = modal.querySelector('#reviewReportSubmit');
      const submit = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(submit, oldBtn);
      submit.addEventListener('click', async () => {
        const targetId = modal.dataset.targetReviewId;
        const reason = modal.querySelector('#reviewReportReason').value;
        const details = modal.querySelector('#reviewReportDetails').value;
        submit.disabled = true;
        try {
          await DB.reportReview(targetId, reason, details);
          toast('Report submitted. Thank you.', 'success');
          hideModal(modal);
          modal.querySelector('#reviewReportDetails').value = '';
        } catch (e) {
          toast(e.message || 'Failed to report', 'error');
        } finally {
          submit.disabled = false;
        }
      });
    },

    async openRules() {
      let rules = [];
      try {
        if (typeof DB.getCommentRules === 'function') {
          rules = await DB.getCommentRules();
        }
      } catch (_) {}
      const list = (rules && rules.length)
        ? rules.map(r => `<li>${esc(r)}</li>`).join('')
        : `<li>Be respectful and constructive.</li>
           <li>No spam, harassment, or hate speech.</li>
           <li>Use spoiler warnings when discussing plot details.</li>
           <li>Stay on topic — discuss the series, not other users.</li>`;
      let modal = document.getElementById('reviewRulesModal');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'reviewRulesModal';
        modal.style.cssText = 'display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.75);align-items:center;justify-content:center;padding:1rem;';
        modal.innerHTML = `
          <div style="max-width:480px;width:100%;background:var(--bg-card,#141414);border:1px solid var(--border-color,#2a2a2a);border-radius:12px;padding:1.25rem;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;">
              <h3 style="margin:0;font-size:1.1rem;"><i class="fas fa-gavel"></i> Community Review Rules</h3>
              <button type="button" data-close style="background:transparent;border:0;color:#888;font-size:1.3rem;cursor:pointer;">&times;</button>
            </div>
            <ol id="reviewRulesList" style="padding-left:1.25rem;line-height:1.8;color:var(--text-secondary,#cfcfcf);margin:0;"></ol>
            <p style="margin-top:1rem;font-size:.8rem;color:var(--text-muted,#888);">
              Breaking these rules may result in comment removal or account suspension.
            </p>
            <div style="display:flex;justify-content:flex-end;margin-top:1rem;">
              <button type="button" class="btn btn-primary btn-sm" data-close>Got it</button>
            </div>
          </div>`;
        document.body.appendChild(modal);
        modal.querySelectorAll('[data-close]').forEach(b =>
          b.addEventListener('click', () => modal.style.display = 'none'));
      }
      modal.querySelector('#reviewRulesList').innerHTML = list;
      modal.style.display = 'flex';
    },

    /**
     * Block User — delegates to Comments.blockUser when that module is
     * loaded so the confirmation popup, localStorage key, and
     * cross-device profile sync are byte-for-byte identical to the
     * Chapter Comments section.
     */
    _blockKey() {
      const uid = firebase.auth().currentUser?.uid || 'anon';
      return `mw_blocked_users_${uid}`;
    },
    _getBlocked() {
      if (window.Comments?._getBlocked) return window.Comments._getBlocked();
      try { return JSON.parse(localStorage.getItem(this._blockKey()) || '[]'); }
      catch (_) { return []; }
    },
    _setBlocked(list) {
      if (window.Comments?._setBlocked) return window.Comments._setBlocked(list);
      try { localStorage.setItem(this._blockKey(), JSON.stringify(list)); } catch (_) {}
    },
    isBlocked(userId) {
      if (!userId) return false;
      const me = firebase.auth().currentUser;
      if (me && me.uid === userId) return false;
      return this._getBlocked().includes(userId);
    },

    blockUser(userId, username, avatar) {
      if (!userId) return;
      if (!firebase.auth().currentUser) { toast('Login to block users', 'warning'); return; }
      const defaultAvatar = '../images/default-avatar.png';
      const safeAvatar = (avatar && String(avatar).trim()) ? avatar : defaultAvatar;
      if (window.Comments?.blockUser) {
        const result = window.Comments.blockUser(userId, username || 'this user', safeAvatar);
        // Re-render reviews after the block so blocked cards immediately
        // collapse here too (Comments only refreshes its own list).
        setTimeout(() => this.load(), 50);
        return result;
      }
      this._openBlockConfirm({ userId, username: username || 'this user', avatar: safeAvatar });
    },

    _openBlockConfirm({ userId, username, avatar }) {
      const defaultAvatar = '../images/default-avatar.png';
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
              <img id="blockUserAvatar" src="" alt="" style="width:44px;height:44px;border-radius:50%;object-fit:cover;background:#1a1a1a;" onerror="this.onerror=null;this.src='${defaultAvatar}'">
              <div>
                <div style="font-size:.8rem;color:var(--text-muted,#888);">Block user</div>
                <div id="blockUserName" style="font-weight:600;font-size:1rem;"></div>
              </div>
            </div>
            <p style="margin:0 0 1rem;font-size:.9rem;line-height:1.45;color:var(--text-secondary,#cfcfcf);">
              Their reviews and replies won't show up for you anymore. You can unblock them anytime from your Settings.
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
      modal.querySelector('#blockUserAvatar').src = avatar || defaultAvatar;
      modal.querySelector('#blockUserName').textContent = username;
      const oldBtn = modal.querySelector('#blockUserConfirm');
      const btn = oldBtn.cloneNode(true);
      oldBtn.parentNode.replaceChild(btn, oldBtn);
      btn.addEventListener('click', () => {
        const list = this._getBlocked();
        if (!list.includes(userId)) list.push(userId);
        this._setBlocked(list);
        try {
          const me = firebase.auth().currentUser;
          if (me && window.db && firebase.firestore?.FieldValue) {
            db.collection('users').doc(me.uid).set(
              { blockedUsers: firebase.firestore.FieldValue.arrayUnion(userId) },
              { merge: true }
            ).catch(() => {});
          }
        } catch (_) {}
        hide(modal);
        toast(`Blocked ${username}`, 'success');
        this.load();
      });
      show(modal);
    },

    unblockUser(userId) {
      if (!userId) return;
      if (window.Comments?.unblockUser) {
        window.Comments.unblockUser(userId);
      } else {
        const list = this._getBlocked().filter(id => id !== userId);
        this._setBlocked(list);
        try {
          const me = firebase.auth().currentUser;
          if (me && window.db && firebase.firestore?.FieldValue) {
            db.collection('users').doc(me.uid).set(
              { blockedUsers: firebase.firestore.FieldValue.arrayRemove(userId) },
              { merge: true }
            ).catch(() => {});
          }
        } catch (_) {}
        toast('User unblocked', 'success');
      }
      this.load();
    }
  };

  // Close any open three-dot dropdown when clicking outside (mirrors
  // the Chapter Comments outside-click behavior).
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.comment-menu')) {
      document.querySelectorAll('[data-review-menu]').forEach(m => m.classList.add('hidden'));
    }
  });

  window.Reviews = Reviews;
})();
