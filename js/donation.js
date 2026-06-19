/**
 * ============================================================
 * YORUVERSE - DONATION + CUSTOM TITLES SYSTEM
 * ============================================================
 * Adds the donation modal (homepage + anywhere it's loaded) and
 * provides admin helpers for the custom-title system (DONATOR,
 * VIP, VERIFIED, MODERATOR, ADMIN). Custom titles support
 * optional expiry (used for the monthly DONATOR status).
 *
 * Storage shape on the user doc (additive — pre-existing fields
 * are untouched):
 *
 *   customTitles : {
 *     donator : { active: true, expiresAt: <Timestamp|null>, grantedAt, grantedBy }
 *     vip     : { active: true, expiresAt: null, ... }
 *     ...
 *   }
 *
 * Configuration (admin-editable, stored at config/donation):
 *
 *   { donatorDurationDays: 30 }
 * ============================================================
 */

const Donation = {
  // PayPal donation target — update via Admin Dashboard if needed.
  PAYPAL_URL: 'https://www.paypal.me/AndreiDelosreyes96',
  CONTACT_EMAIL: 'YoruVerse6@gmail.com',

  // Default monthly duration (days) — overridable from config/donation.
  DEFAULT_DURATION_DAYS: 30,

  _configCache: null,

  async getConfig() {
    if (this._configCache) return this._configCache;
    try {
      const snap = await db.collection('config').doc('donation').get();
      const data = snap.exists ? snap.data() : {};
      this._configCache = {
        donatorDurationDays: Number(data.donatorDurationDays) || this.DEFAULT_DURATION_DAYS,
        paypalUrl: data.paypalUrl || this.PAYPAL_URL,
        contactEmail: data.contactEmail || this.CONTACT_EMAIL,
      };
    } catch (e) {
      console.warn('[Donation] config load failed, using defaults:', e?.message);
      this._configCache = {
        donatorDurationDays: this.DEFAULT_DURATION_DAYS,
        paypalUrl: this.PAYPAL_URL,
        contactEmail: this.CONTACT_EMAIL,
      };
    }
    return this._configCache;
  },

  async setConfig(patch) {
    await db.collection('config').doc('donation').set(patch, { merge: true });
    this._configCache = null;
  },

  // ---------- Modal ----------
  ensureModal() {
    if (document.getElementById('donateModalOverlay')) return;
    const cfg = this._configCache || {
      paypalUrl: this.PAYPAL_URL,
      contactEmail: this.CONTACT_EMAIL,
    };
    const html = `
      <div class="donate-modal-overlay" id="donateModalOverlay" role="dialog" aria-modal="true" aria-labelledby="donateModalTitle">
        <div class="donate-modal" onclick="event.stopPropagation()">
          <div class="donate-modal__header">
            <button class="donate-modal__close" aria-label="Close" onclick="Donation.close()"><i class="fas fa-times"></i></button>
            <h3 class="donate-modal__title" id="donateModalTitle">Support YoruVerse</h3>
            <p class="donate-modal__lead">Donations help support the growth, maintenance, and future development of YoruVerse.</p>
          </div>
          <div class="donate-modal__body">
            <h4>Your donations will be used for:</h4>
            <ul>
              <li>Purchasing and maintaining a custom domain</li>
              <li>Improving website performance and reliability</li>
              <li>Funding future features and upgrades</li>
              <li>Supporting automated systems and infrastructure</li>
              <li>Helping maintain and expand the manhwa library</li>
              <li>Covering hosting, storage, and operational costs</li>
              <li>Working toward more reliable chapter updates and automation</li>
            </ul>

            <h4>Why a custom domain matters</h4>
            <p style="color:var(--text-secondary);font-size:0.9rem;margin:0 0 var(--space-md);">
              A custom domain makes the website easier to access, more professional,
              easier to remember, and more reliable for users. It also helps establish
              a stronger identity for the YoruVerse project.
            </p>

            <a class="donate-paypal-btn" id="donatePaypalBtn" href="${cfg.paypalUrl}" target="_blank" rel="noopener">
              <i class="fab fa-paypal"></i> Donate via PayPal
            </a>

            <div class="donate-verify">
              <h4><i class="fas fa-shield-alt" style="color:#a78bfa;"></i> Get the <span class="exp-title exp-title--donator" style="margin-left:0;">DONATOR</span> title</h4>
              <p style="margin:6px 0;color:var(--text-secondary);font-size:0.88rem;">
                Donate <strong>$1 USD or more</strong>, then send proof of donation to
                <code id="donateEmail">${cfg.contactEmail}</code> using this format:
              </p>
              <ol>
                <li><strong>Username</strong> — your YoruVerse username</li>
                <li><strong>Donation Amount</strong> — e.g. $1, $5</li>
                <li><strong>Screenshot or Donation Receipt</strong></li>
                <li><strong>Optional Message</strong></li>
              </ol>
              <p style="margin:8px 0 0;font-size:0.8rem;color:var(--text-muted);">
                Donator status is reviewed manually by staff and remains active monthly while you continue to support the project.
              </p>
            </div>
          </div>
        </div>
      </div>
    `;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    document.body.appendChild(wrap.firstElementChild);
    document.getElementById('donateModalOverlay').addEventListener('click', () => this.close());
  },

  async open() {
    await this.getConfig();
    this.ensureModal();
    const cfg = this._configCache;
    const overlay = document.getElementById('donateModalOverlay');
    document.getElementById('donatePaypalBtn').href = cfg.paypalUrl;
    document.getElementById('donateEmail').textContent = cfg.contactEmail;
    overlay.classList.add('open');
    document.body.style.overflow = 'hidden';
  },

  close() {
    const overlay = document.getElementById('donateModalOverlay');
    if (overlay) overlay.classList.remove('open');
    document.body.style.overflow = '';
  },

  // ---------- Custom Title helpers (admin) ----------
  // Catalog of admin-assignable titles.
  CUSTOM_TITLES: [
    { id: 'donator',   label: 'DONATOR',   effect: 'donator',   supportsExpiry: true  },
    { id: 'vip',       label: 'VIP',       effect: 'vip',       supportsExpiry: true  },
    { id: 'verified',  label: 'VERIFIED',  effect: 'verified',  supportsExpiry: false },
    { id: 'moderator', label: 'MODERATOR', effect: 'moderator', supportsExpiry: false },
    { id: 'admin',     label: 'ADMIN',     effect: 'admin',     supportsExpiry: false },
  ],

  getCustomTitle(id) {
    return this.CUSTOM_TITLES.find(t => t.id === id) || null;
  },

  /**
   * Returns the currently-active custom title for a user data blob,
   * or null if none / expired. Prefers DONATOR > VIP > others.
   */
  getActiveCustomTitle(userData) {
    if (!userData || !userData.customTitles) return null;
    const now = Date.now();
    const order = ['admin', 'moderator', 'donator', 'vip', 'verified'];
    for (const id of order) {
      const entry = userData.customTitles[id];
      if (!entry || entry.active === false) continue;
      const exp = entry.expiresAt?.toMillis?.() ?? entry.expiresAt ?? null;
      if (exp && exp < now) continue;
      return { id, expiresAt: exp || null };
    }
    return null;
  },

  /**
   * Renders the DOM string for a custom title badge. Pure (no DB call).
   */
  renderCustomTitleBadge(titleId) {
    const t = this.getCustomTitle(titleId);
    if (!t) return '';
    return `<span class="exp-title exp-title--${t.effect}" title="${t.label}">${t.label}</span>`;
  },

  // ---------- Admin write operations ----------
  /**
   * Grant a custom title to a user. `durationDays` is only used when the
   * title supports expiry (DONATOR / VIP); pass null for permanent.
   */
  async grantTitle(uid, titleId, durationDays = null) {
    const me = auth.currentUser;
    if (!me) throw new Error('Not signed in');
    const t = this.getCustomTitle(titleId);
    if (!t) throw new Error('Unknown title');

    let expiresAt = null;
    if (t.supportsExpiry) {
      const cfg = await this.getConfig();
      const days = Number(durationDays) > 0 ? Number(durationDays) : cfg.donatorDurationDays;
      expiresAt = firebase.firestore.Timestamp.fromMillis(Date.now() + days * 86400000);
    }

    const entry = {
      active: true,
      expiresAt,
      grantedAt: firebase.firestore.FieldValue.serverTimestamp(),
      grantedBy: me.uid,
    };
    const payload = { customTitles: { [titleId]: entry } };
    // The DONATOR title is also listed on the public Profile -> Titles grid
    // so the user can select it. We surface it through the same
    // unlockedTitleIds array used by the level-based titles, but only after
    // an admin has explicitly granted it.
    if (titleId === 'donator') {
      payload.unlockedTitleIds = firebase.firestore.FieldValue.arrayUnion('donator');
    }
    await db.collection('users').doc(uid).set(payload, { merge: true });
  },

  /**
   * Extend an expiring title by N days from its current expiry (or now if
   * already expired / permanent).
   */
  async extendTitle(uid, titleId, addDays) {
    const snap = await db.collection('users').doc(uid).get();
    const data = snap.data() || {};
    const entry = data.customTitles?.[titleId];
    const base = entry?.expiresAt?.toMillis?.() ?? Date.now();
    const start = Math.max(base, Date.now());
    const expiresAt = firebase.firestore.Timestamp.fromMillis(start + Number(addDays) * 86400000);
    const payload = {
      customTitles: { [titleId]: { ...(entry || {}), active: true, expiresAt } }
    };
    if (titleId === 'donator') {
      payload.unlockedTitleIds = firebase.firestore.FieldValue.arrayUnion('donator');
    }
    await db.collection('users').doc(uid).set(payload, { merge: true });
  },

  async removeTitle(uid, titleId) {
    const payload = {
      customTitles: { [titleId]: { active: false, expiresAt: null } }
    };
    // Revoke the DONATOR selection so it disappears from comments / profile
    // as soon as an admin removes it.
    if (titleId === 'donator') {
      payload.unlockedTitleIds = firebase.firestore.FieldValue.arrayRemove('donator');
      const snap = await db.collection('users').doc(uid).get();
      if (snap.data()?.selectedTitleId === 'donator') {
        payload.selectedTitleId = null;
      }
    }
    await db.collection('users').doc(uid).set(payload, { merge: true });
  },

  /**
   * Find a user by username (case-insensitive exact match). Returns
   * { id, ...userData } or null.
   */
  async findUserByUsername(username) {
    const raw = String(username || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();

    // 1. Fast path: exact username match (case-sensitive, as stored).
    try {
      const q = await db.collection('users')
        .where('username', '==', raw)
        .limit(1).get();
      if (!q.empty) return { id: q.docs[0].id, ...q.docs[0].data() };
    } catch (e) { console.warn('[Donation] exact username query failed', e); }

    // 2. Lowercase variant (some projects store usernames lowercased).
    if (lower !== raw) {
      try {
        const q2 = await db.collection('users')
          .where('username', '==', lower)
          .limit(1).get();
        if (!q2.empty) return { id: q2.docs[0].id, ...q2.docs[0].data() };
      } catch (e) { console.warn('[Donation] lowercase username query failed', e); }
    }

    // 3. usernameLower field (if your schema stores one).
    try {
      const q3 = await db.collection('users')
        .where('usernameLower', '==', lower)
        .limit(1).get();
      if (!q3.empty) return { id: q3.docs[0].id, ...q3.docs[0].data() };
    } catch (e) { /* field may not exist; ignore */ }

    // 4. Email lookup (admins can search by email too).
    if (raw.includes('@')) {
      try {
        const q4 = await db.collection('users')
          .where('email', '==', raw)
          .limit(1).get();
        if (!q4.empty) return { id: q4.docs[0].id, ...q4.docs[0].data() };
        const q5 = await db.collection('users')
          .where('email', '==', lower)
          .limit(1).get();
        if (!q5.empty) return { id: q5.docs[0].id, ...q5.docs[0].data() };
      } catch (e) { console.warn('[Donation] email query failed', e); }
    }

    // 5. Case-insensitive fallback: scan a bounded slice of users client-side
    // so admins don't have to remember exact casing. Bounded to 500 users to
    // keep it cheap; for larger user bases, add a usernameLower index.
    try {
      const snap = await db.collection('users').limit(500).get();
      let match = null;
      snap.forEach(doc => {
        if (match) return;
        const d = doc.data() || {};
        const uname = String(d.username || '').toLowerCase();
        const email = String(d.email || '').toLowerCase();
        if (uname === lower || email === lower) {
          match = { id: doc.id, ...d };
        }
      });
      if (match) return match;
    } catch (e) { console.warn('[Donation] fallback scan failed', e); }

    return null;
  },

  /**
   * List every user who currently holds the DONATOR title (active and not
   * expired). Used by the admin dashboard to display a roster of donators.
   */
  async listDonatorUsers() {
    try {
      const snap = await db.collection('users')
        .where('customTitles.donator.active', '==', true)
        .get();
      const now = Date.now();
      const out = [];
      snap.forEach(doc => {
        const d = doc.data() || {};
        const entry = d.customTitles?.donator || {};
        const expMs = entry.expiresAt?.toMillis?.() ?? entry.expiresAt ?? null;
        if (expMs && expMs < now) return; // skip expired
        out.push({
          id: doc.id,
          username: d.username || 'Unknown',
          email: d.email || '',
          avatar: d.avatar || '../images/default-avatar.png',
          expiresAt: expMs || null,
          selectedTitleId: d.selectedTitleId || null,
        });
      });
      // Sort soonest-expiring first, permanent last.
      out.sort((a, b) => {
        if (a.expiresAt && b.expiresAt) return a.expiresAt - b.expiresAt;
        if (a.expiresAt) return -1;
        if (b.expiresAt) return 1;
        return a.username.localeCompare(b.username);
      });
      return out;
    } catch (err) {
      console.error('[Donation] listDonatorUsers failed:', err);
      return [];
    }
  },
};

if (typeof window !== 'undefined') window.Donation = Donation;
