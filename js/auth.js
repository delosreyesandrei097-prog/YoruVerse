/**
 * ============================================================
 * MANHWA PLATFORM - AUTHENTICATION MODULE
 * ============================================================
 * Handles all authentication operations including:
 * - Email/Password registration and login
 * - Google Sign-In
 * - Password reset
 * - Role-based access control
 * - Session management
 * ============================================================
 */

const Auth = {
  // Current user cache
  currentUser: null,
  userData: null,

  // Promise that resolves when auth state has been determined
  // This prevents race conditions where requireAuth() is called
  // before onAuthStateChanged has fired
  _authStateReady: null,
  _resolveAuthState: null,

  /**
   * Initialize auth module
   */
  init() {
    // Create a promise that resolves once auth state is first determined
    this._authStateReady = new Promise((resolve) => {
      this._resolveAuthState = resolve;
    });

    // FIX (Google login on mobile): When signInWithPopup falls back to a
    // redirect on mobile or in restricted browsers, the credential arrives via
    // getRedirectResult on the next page load. Process it once so the new-user
    // bootstrap (createUserDocument / lastActive) still runs.
    try {
      auth.getRedirectResult().then(async (result) => {
        if (result && result.user) {
          const isNewUser = result.additionalUserInfo?.isNewUser;
          if (isNewUser) {
            await this.createUserDocument(result.user);
          } else {
            try {
              await db.collection('users').doc(result.user.uid).update({
                lastActive: firebase.firestore.FieldValue.serverTimestamp()
              });
            } catch (_) {}
          }
          showToast('Welcome!', 'success');
        }
      }).catch(err => {
        if (err && err.code && err.code !== 'auth/no-auth-event') {
          console.error('Google redirect result error:', err);
          showToast(this._mapGoogleError(err) || 'Google login failed', 'error');
        }
      });
    } catch (_) {}

    auth.onAuthStateChanged(async user => {
      this.currentUser = user;
      if (user) {
        await this.loadUserData(user.uid);
      } else {
        this.userData = null;
      }
      
      // Resolve the auth state promise on first determination
      if (this._resolveAuthState) {
        this._resolveAuthState(user);
        this._resolveAuthState = null; // Only resolve once
      }
      
      // Dispatch custom event for other modules
      window.dispatchEvent(new CustomEvent('authStateChanged', { 
        detail: { user, userData: this.userData } 
      }));
    });
  },

  /**
   * Load user data from Firestore
   */
  async loadUserData(uid) {
    try {
      const doc = await db.collection('users').doc(uid).get();
      if (doc.exists) {
        this.userData = doc.data();
      } else if (this.currentUser && this.currentUser.uid === uid) {
        // Only bootstrap a profile when we are CERTAIN the document is
        // missing for the currently-signed-in user. createUserDocument is
        // now merge-safe and re-reads the doc before writing, so an admin
        // profile cannot be wiped by a transient read returning empty.
        this.userData = await this.createUserDocument(this.currentUser);
      }
    } catch (error) {
      // IMPORTANT: do NOT call createUserDocument on read errors. A
      // transient Firestore error here used to fall through and overwrite
      // admin/moderator profiles with default 'user' data.
      console.error('Error loading user data (profile left untouched):', error);
    }
  },

  /**
   * Create user document in Firestore
   */
  async createUserDocument(user, additionalData = {}) {
    const userRef = db.collection('users').doc(user.uid);

    // SAFETY: if a profile already exists (e.g. an admin/moderator signing
    // in again, or Firebase Auth reporting isNewUser=true after a relink),
    // NEVER overwrite it. We only patch lastActive + any explicitly-passed
    // additionalData fields, and we never touch `role`, `xp`, `level`,
    // `library`, `permissions`, `badges`, `customTitles`, etc.
    let existing = null;
    try {
      const snap = await userRef.get();
      if (snap.exists) existing = snap.data() || {};
    } catch (e) {
      console.error('createUserDocument: failed to read existing profile, aborting write to avoid data loss', e);
      return null;
    }

    if (existing) {
      const patch = {
        lastActive: firebase.firestore.FieldValue.serverTimestamp(),
        ...additionalData
      };
      // Never let a caller downgrade an existing staff role through this path.
      if (existing.role === 'admin' || existing.role === 'moderator') {
        delete patch.role;
      }
      try {
        await userRef.set(patch, { merge: true });
      } catch (e) {
        console.error('createUserDocument: merge update failed', e);
      }
      return { ...existing, ...patch };
    }

    const userData = {
      uid: user.uid,
      email: user.email,
      username: additionalData.username || user.displayName || user.email.split('@')[0],
      avatar: user.photoURL || '/images/default-avatar.png',
      role: 'user',
      favorites: [],
      followedSeries: [],
      readingHistory: [],
      library: [],
      notificationsEnabled: false,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      lastActive: firebase.firestore.FieldValue.serverTimestamp(),
      ...additionalData
    };

    // merge:true so a concurrent write (e.g. seed) cannot clobber fields.
    await userRef.set(userData, { merge: true });

    // Keep the Admin Dashboard "Total Users" stat in sync. Without this
    // increment, registering a new account does not bump the cached counter
    // so the dashboard kept showing 0 even after multiple sign-ups.
    if (typeof DB !== 'undefined' && typeof DB._incrementStatsCounter === 'function') {
      DB._incrementStatsCounter('totalUsers', 1);
    }

    return userData;
  },

  /**
   * Register with email and password
   */
  async register(email, password, username) {
    try {
      // Create auth user
      const userCredential = await auth.createUserWithEmailAndPassword(email, password);
      const user = userCredential.user;

      // Update profile
      await user.updateProfile({ displayName: username });

      // Create user document
      await this.createUserDocument(user, { username });

      // Send email verification
      await user.sendEmailVerification();

      showToast('Account created! Please verify your email.', 'success');
      return { success: true, user };
    } catch (error) {
      console.error('Registration error:', error);
      let message = 'Failed to create account';
      
      switch (error.code) {
        case 'auth/email-already-in-use':
          message = 'Email is already registered';
          break;
        case 'auth/invalid-email':
          message = 'Invalid email address';
          break;
        case 'auth/weak-password':
          message = 'Password must be at least 6 characters';
          break;
      }
      
      showToast(message, 'error');
      return { success: false, error: message };
    }
  },

  /**
   * Map Firebase Google sign-in errors to a friendly message.
   * Centralised so both popup and redirect flows show consistent text.
   */
  _mapGoogleError(error) {
    if (!error) return '';
    switch (error.code) {
      case 'auth/popup-closed-by-user':
      case 'auth/cancelled-popup-request':
        return 'Login cancelled';
      case 'auth/popup-blocked':
        return 'Popup blocked. Allow popups or try again — redirecting...';
      case 'auth/account-exists-with-different-credential':
        return 'This email is already registered with a different sign-in method.';
      case 'auth/unauthorized-domain':
        return 'This domain is not authorized for Google sign-in. Please contact the site admin.';
      case 'auth/operation-not-allowed':
        return 'Google sign-in is not enabled for this project.';
      case 'auth/network-request-failed':
        return 'Network error. Please check your connection and try again.';
      case 'auth/internal-error':
        return 'Authentication service error. Please try again in a moment.';
      default:
        return error.message || 'Google login failed';
    }
  },

  /**
   * Apply the Remember Me preference to the auth session BEFORE signing in.
   * - true  -> LOCAL persistence: session survives browser restart.
   * - false -> SESSION persistence: cleared when the tab/browser closes.
   * Returning errors is non-fatal; we still attempt sign-in.
   */
  async _applyPersistence(rememberMe) {
    try {
      const target = rememberMe
        ? firebase.auth.Auth.Persistence.LOCAL
        : firebase.auth.Auth.Persistence.SESSION;
      await auth.setPersistence(target);
    } catch (e) {
      console.warn('Could not set auth persistence:', e?.message || e);
    }
  },

  /**
   * Login with email and password
   * @param {boolean} rememberMe - keep the user signed in across browser restarts
   */
  async login(email, password, rememberMe = true) {
    try {
      await this._applyPersistence(rememberMe);
      const userCredential = await auth.signInWithEmailAndPassword(email, password);
      const user = userCredential.user;

      // Check if admin account needs password change
      if (email === 'admin@example.com') {
        const userDoc = await db.collection('users').doc(user.uid).get();
        const userData = userDoc.data();
        
        if (userData?.requirePasswordChange) {
          window.location.href = AppPath.to('pages/settings.html?changePassword=true');
          return { success: true, user, requirePasswordChange: true };
        }
      }

      showToast('Welcome back!', 'success');
      return { success: true, user };
    } catch (error) {
      console.error('Login error:', error);
      let message = 'Login failed';
      
      switch (error.code) {
        case 'auth/user-not-found':
          message = 'Account not found';
          break;
        case 'auth/wrong-password':
          message = 'Incorrect password';
          break;
        case 'auth/invalid-email':
          message = 'Invalid email address';
          break;
        case 'auth/user-disabled':
          message = 'Account has been disabled';
          break;
        case 'auth/too-many-requests':
          message = 'Too many attempts. Please try again later.';
          break;
      }
      
      showToast(message, 'error');
      return { success: false, error: message };
    }
  },

  /**
   * Login with Google
   */
  async loginWithGoogle(rememberMe = true) {
    try {
      await this._applyPersistence(rememberMe);
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.addScope('email');
      provider.addScope('profile');
      provider.setCustomParameters({ prompt: 'select_account' });

      // FIX (mobile / in-app browsers): popups are unreliable on Android
      // Chrome, Samsung Internet, Facebook/Instagram in-app browsers, etc.
      // Use redirect there; popup elsewhere.
      const ua = navigator.userAgent || '';
      const isInApp = /(FBAN|FBAV|Instagram|Line\/|MicroMessenger|Twitter|TikTok)/i.test(ua);
      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) && !/Tablet/i.test(ua);

      if (isInApp || isMobile) {
        // Redirect flow — result handled by getRedirectResult() in init().
        await auth.signInWithRedirect(provider);
        return { success: true, redirected: true };
      }

      let userCredential;
      try {
        userCredential = await auth.signInWithPopup(provider);
      } catch (popupErr) {
        // Fall back to redirect when popups are blocked or fail to open.
        if (
          popupErr?.code === 'auth/popup-blocked' ||
          popupErr?.code === 'auth/popup-closed-by-user' ||
          popupErr?.code === 'auth/cancelled-popup-request'
        ) {
          await auth.signInWithRedirect(provider);
          return { success: true, redirected: true };
        }
        throw popupErr;
      }

      const user = userCredential.user;
      const isNewUser = userCredential.additionalUserInfo?.isNewUser;

      if (isNewUser) {
        await this.createUserDocument(user);
      } else {
        try {
          await db.collection('users').doc(user.uid).update({
            lastActive: firebase.firestore.FieldValue.serverTimestamp()
          });
        } catch (_) {}
      }

      showToast('Welcome!', 'success');
      return { success: true, user };
    } catch (error) {
      console.error('Google login error:', error);
      const message = this._mapGoogleError(error);
      showToast(message, 'error');
      return { success: false, error: message };
    }
  },

  /**
   * Logout
   */
  async logout() {
    try {
      // Update online status
      if (this.currentUser) {
        await db.collection('users').doc(this.currentUser.uid).update({
          online: false,
          lastActive: firebase.firestore.FieldValue.serverTimestamp()
        });
      }

      await auth.signOut();
      this.currentUser = null;
      this.userData = null;
      
      showToast('Logged out successfully', 'info');
      window.location.href = AppPath.home();
    } catch (error) {
      console.error('Logout error:', error);
      showToast('Failed to logout', 'error');
    }
  },

  /**
   * Reset password
   */
  async resetPassword(email) {
    try {
      // Only pass actionCodeSettings when the current origin is a real
      // http(s) URL. When the app is opened from file:// (mobile preview)
      // or any non-web origin, Firebase rejects the continue URL with
      // auth/invalid-continue-uri / auth/unauthorized-continue-uri, which
      // surfaces as "Failed to send reset email". Falling back to no
      // actionCodeSettings lets Firebase use its default hosted handler,
      // which works on every project without extra domain configuration.
      const origin = (typeof window !== 'undefined' && window.location && window.location.origin) || '';
      const isWebOrigin = /^https?:\/\//i.test(origin);

      if (isWebOrigin) {
        try {
          const url = `${origin}${typeof AppPath !== 'undefined' ? AppPath.to('pages/login.html') : '/pages/login.html'}`;
          await auth.sendPasswordResetEmail(email, { url, handleCodeInApp: false });
        } catch (innerErr) {
          // If the continue URL is rejected (domain not in Firebase
          // Authorized Domains), retry once without actionCodeSettings so
          // the user still receives the email via Firebase's default URL.
          if (innerErr && (innerErr.code === 'auth/invalid-continue-uri' ||
                           innerErr.code === 'auth/unauthorized-continue-uri' ||
                           innerErr.code === 'auth/missing-continue-uri')) {
            console.warn('[Auth] Continue URL rejected, retrying without actionCodeSettings.', innerErr.code);
            await auth.sendPasswordResetEmail(email);
          } else {
            throw innerErr;
          }
        }
      } else {
        await auth.sendPasswordResetEmail(email);
      }

      showToast('Password reset email sent. Check your inbox (and spam folder).', 'success');
      return { success: true };
    } catch (error) {
      console.error('Password reset error:', error);
      let message = 'Failed to send reset email';

      switch (error.code) {
        case 'auth/user-not-found':
          // Don't leak account existence: show a neutral message but still
          // log the real reason for the developer.
          message = 'If that email is registered, a reset link has been sent.';
          showToast(message, 'success');
          return { success: true };
        case 'auth/invalid-email':
          message = 'Invalid email address';
          break;
        case 'auth/missing-email':
          message = 'Please enter your email address';
          break;
        case 'auth/too-many-requests':
          message = 'Too many attempts. Please try again later.';
          break;
        case 'auth/network-request-failed':
          message = 'Network error. Check your connection and try again.';
          break;
        case 'auth/invalid-continue-uri':
        case 'auth/unauthorized-continue-uri':
          message = 'Reset link domain is not authorized in Firebase Console.';
          break;
      }

      showToast(message, 'error');
      return { success: false, error: message };
    }
  },

  /**
   * Change password
   */
  async changePassword(currentPassword, newPassword) {
    try {
      const user = auth.currentUser;
      const credential = firebase.auth.EmailAuthProvider.credential(
        user.email, 
        currentPassword
      );
      
      // Re-authenticate
      await user.reauthenticateWithCredential(credential);
      
      // Update password
      await user.updatePassword(newPassword);
      
      // Remove requirePasswordChange flag if present
      await db.collection('users').doc(user.uid).update({
        requirePasswordChange: firebase.firestore.FieldValue.delete()
      });
      
      showToast('Password updated successfully', 'success');
      return { success: true };
    } catch (error) {
      console.error('Change password error:', error);
      let message = 'Failed to change password';
      
      switch (error.code) {
        case 'auth/wrong-password':
          message = 'Current password is incorrect';
          break;
        case 'auth/weak-password':
          message = 'New password must be at least 6 characters';
          break;
      }
      
      showToast(message, 'error');
      return { success: false, error: message };
    }
  },

  /**
   * Update user profile
   */
  async updateProfile(data) {
    try {
      const user = auth.currentUser;
      
      if (data.displayName) {
        await user.updateProfile({ displayName: data.displayName });
      }
      
      if (data.photoURL) {
        await user.updateProfile({ photoURL: data.photoURL });
      }
      
      // Update Firestore
      const updateData = {};
      if (data.username) updateData.username = data.username;
      if (data.avatar !== undefined) updateData.avatar = data.avatar;
      if (data.coverImage !== undefined) updateData.coverImage = (data.coverImage || '').slice(0, 1000);
      // Cover photo positioning (percent X/Y, 0-100). Kept as plain
      // numbers so the values survive read-back without coercion.
      if (data.coverPositionX !== undefined) updateData.coverPositionX = Math.max(0, Math.min(100, Number(data.coverPositionX) || 50));
      if (data.coverPositionY !== undefined) updateData.coverPositionY = Math.max(0, Math.min(100, Number(data.coverPositionY) || 50));
      if (data.bio !== undefined) updateData.bio = (data.bio || '').slice(0, 500);
      
      await db.collection('users').doc(user.uid).update(updateData);
      
      // Reload user data
      await this.loadUserData(user.uid);
      
      showToast('Profile updated', 'success');
      return { success: true };
    } catch (error) {
      console.error('Update profile error:', error);
      showToast('Failed to update profile', 'error');
      return { success: false, error: error.message };
    }
  },

  /**
   * Check if user has role
   */
  hasRole(role) {
    if (!this.userData) return false;
    
    const userRole = this.userData.role || 'user';
    
    switch (role) {
      case 'admin':
        return userRole === 'admin';
      case 'moderator':
        return userRole === 'admin' || userRole === 'moderator';
      case 'user':
        return true;
      default:
        return false;
    }
  },

  async isAdmin(uid = null) {
    const targetUid = uid || this.currentUser?.uid || auth?.currentUser?.uid;
    if (!targetUid || typeof db === 'undefined' || !db) return false;

    if (this.currentUser && targetUid === this.currentUser.uid && this.userData) {
      return this.hasRole('moderator');
    }

    try {
      const doc = await db.collection('users').doc(targetUid).get();
      const role = doc.data()?.role;
      return role === 'admin' || role === 'moderator';
    } catch (error) {
      console.error('Admin role check failed:', error);
      return false;
    }
  },

  /**
   * Check if user is authenticated
   */
  isAuthenticated() {
    return this.currentUser !== null;
  },

  /**
   * Get current user
   */
  getUser() {
    return this.currentUser;
  },

  /**
   * Get user data
   */
  getUserData() {
    return this.userData;
  },

  /**
   * Require authentication (redirect if not logged in)
   * ASYNC VERSION - waits for auth state to be determined before checking.
   * Previously this was synchronous and always failed because onAuthStateChanged
   * hadn't fired yet when requireAuth() was called in DOMContentLoaded.
   * 
   * @param {number} timeout - Max ms to wait for auth state (default 5000)
   * @returns {Promise<boolean>} - true if authenticated, false if redirected
   */
  async requireAuth(timeout = 5000) {
    // Fast path
    if (this.currentUser || (typeof auth !== 'undefined' && auth.currentUser)) {
      this.currentUser = this.currentUser || auth.currentUser;
      return true;
    }

    // Authoritative check: wait for Firebase to resolve persisted session.
    // We subscribe directly so we never depend on Auth.init() having run.
    const user = await new Promise((resolve) => {
      if (typeof auth === 'undefined' || !auth) return resolve(null);
      const timer = setTimeout(() => { try { unsub(); } catch(_){} resolve(null); }, timeout);
      const unsub = auth.onAuthStateChanged((u) => {
        clearTimeout(timer);
        try { unsub(); } catch(_){}
        resolve(u);
      });
    });

    if (user) {
      this.currentUser = user;
      try { await this.loadUserData(user.uid); } catch(_) {}
      return true;
    }

    showToast('Please login to access this page', 'warning');
    window.location.href = AppPath.to('pages/login.html?redirect=') + encodeURIComponent(window.location.pathname);
    return false;
  },

  /**
   * Require specific role
   * ASYNC VERSION - calls async requireAuth()
   */
  async requireRole(role) {
    if (!(await this.requireAuth())) return false;
    
    if (!this.hasRole(role)) {
      showToast('You do not have permission to access this page', 'error');
      window.location.href = AppPath.home();
      return false;
    }
    return true;
  },

  /**
   * Seed default admin account
   * Call this once during setup
   */
  async seedAdminAccount() {
    try {
      // Check if admin exists
      const adminQuery = await db.collection('users')
        .where('email', '==', 'admin@example.com')
        .limit(1)
        .get();
      
      if (!adminQuery.empty) {
        console.log('Admin account already exists');
        return;
      }

      // Create admin user
      const userCredential = await auth.createUserWithEmailAndPassword(
        'admin@example.com',
        'Admin123!'
      );
      
      const user = userCredential.user;
      
      await user.updateProfile({ displayName: 'Administrator' });
      
      await db.collection('users').doc(user.uid).set({
        uid: user.uid,
        email: 'admin@example.com',
        username: 'Administrator',
        avatar: '/images/default-avatar.png',
        role: 'admin',
        requirePasswordChange: true,
        favorites: [],
        followedSeries: [],
        readingHistory: [],
        library: [],
        notificationsEnabled: true,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        lastActive: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      console.log('Admin account created successfully');
      console.log('Email: admin@example.com');
      console.log('Password: Admin123!');
      console.log('Please change password after first login');
      
      // Sign out after creation
      await auth.signOut();
    } catch (error) {
      console.error('Error seeding admin account:', error);
    }
  }
};

// Initialize auth module
document.addEventListener('DOMContentLoaded', () => {
  // Wait for Firebase to be initialized
  const checkFirebase = setInterval(() => {
    if (typeof auth !== 'undefined' && auth) {
      clearInterval(checkFirebase);
      Auth.init();
    }
  }, 100);
});

// Expose Auth globally
window.Auth = Auth;
