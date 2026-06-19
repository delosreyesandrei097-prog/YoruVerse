/**
 * ============================================================
 * MANHWA PLATFORM - FIREBASE CONFIGURATION
 * ============================================================
 * 
 * INSTRUCTIONS:
 * 1. Create a Firebase project at https://console.firebase.google.com
 * 2. Enable Authentication (Email/Password and Google)
 * 3. Create a Firestore database
 * 4. Enable Firebase Cloud Messaging
 * 5. Replace the placeholder config below with your actual Firebase config
 * 6. Update Firestore security rules
 * 
 * ============================================================
 */

// Firebase configuration - Replace with your actual config
const firebaseConfig = {
  apiKey: "AIzaSyAY2w1cfansDZ1ZsS_-SU40MrG68Pn3Ndw",
  authDomain: "manhwa-7d544.firebaseapp.com",
  projectId: "manhwa-7d544",
  storageBucket: "manhwa-7d544.firebasestorage.app",
  messagingSenderId: "296957053322",
  appId: "1:296957053322:web:4ad1c88f8a9ac9bffc6073",
  measurementId: "G-61M831TW2K"
};

// Initialize Firebase
let app, auth, db, messaging;

function initializeFirebase() {
  try {
    // Guard against double initialization (would throw error on second call)
    if (firebase.apps.length > 0) {
      app = firebase.apps[0];
    } else {
      app = firebase.initializeApp(firebaseConfig);
    }
    
    auth = firebase.auth();
    db = firebase.firestore();
    
    // Explicitly set auth persistence to LOCAL (survives across pages and refreshes)
    // This is the default but we set it explicitly for clarity and reliability
    auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(err => {
      console.warn('Failed to set auth persistence:', err);
    });
    
    // Enable offline persistence
    db.enablePersistence({ synchronizeTabs: true })
      .catch(err => {
        if (err.code === 'failed-precondition') {
          console.warn('Multiple tabs open, persistence enabled in first tab only');
        } else if (err.code === 'unimplemented') {
          console.warn('Browser does not support offline persistence');
        }
      });
    
    // Initialize FCM if supported
    if (firebase.messaging.isSupported()) {
      messaging = firebase.messaging();
      messaging.onMessage(payload => {
        console.log('FCM Message received:', payload);
        showToast(payload.notification?.title || 'New Notification', 'info');
      });
    }
    
    console.log('Firebase initialized successfully');
    return { app, auth, db, messaging };
  } catch (error) {
    console.error('Firebase initialization error:', error);
    throw error;
  }
}

// Auth state observer with callbacks
let authStateCallbacks = [];

function onAuthStateChanged(callback) {
  authStateCallbacks.push(callback);
}

function notifyAuthStateChanged(user) {
  authStateCallbacks.forEach(cb => cb(user));
}

// Initialize auth state listener
function initAuthListener() {
  auth.onAuthStateChanged(user => {
    notifyAuthStateChanged(user);
    // Defer UI sync until DOM is ready so [data-auth-required]/[data-auth-guest]
    // selectors actually find the header/menu nodes. Previously the listener
    // could fire before <body> was parsed, leaving the Login button visible
    // for already-logged-in users on every page load.
    const syncUI = () => updateUIForAuthState(user);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', syncUI, { once: true });
    } else {
      syncUI();
    }

    if (user) {
      // Store FCM token
      storeFCMToken(user.uid);
      // Update user's online status
      updateUserPresence(user.uid);
    }
  });

  // Safety net: re-sync once when DOM is ready, in case the initial auth
  // event was already dispatched (current user available but UI not yet bound).
  document.addEventListener('DOMContentLoaded', () => {
    updateUIForAuthState(auth.currentUser || null);
  }, { once: true });
}

// Update UI based on auth state
function updateUIForAuthState(user) {
  // Mark the body so the CSS rule that hides auth-gated elements
  // (to prevent the "Login button flash" for already-logged-in users)
  // can finally reveal the correct UI.
  if (document.body) document.body.classList.add('auth-resolved');

  const authRequiredElements = document.querySelectorAll('[data-auth-required]');
  const authGuestElements = document.querySelectorAll('[data-auth-guest]');
  const adminElements = document.querySelectorAll('[data-admin-only]');

  authRequiredElements.forEach(el => {
    el.style.display = user ? '' : 'none';
  });

  authGuestElements.forEach(el => {
    el.style.display = user ? 'none' : '';
  });


  
  // Check admin role
  if (user) {
    db.collection('users').doc(user.uid).get()
      .then(doc => {
        const userData = doc.data();
        const isAdmin = userData?.role === 'admin' || userData?.role === 'moderator';
        adminElements.forEach(el => {
          el.style.display = isAdmin ? '' : 'none';
        });
        
        // Update avatar
        const avatarElements = document.querySelectorAll('[data-user-avatar]');
        avatarElements.forEach(el => {
          el.src = userData?.avatar || user.photoURL || '/images/default-avatar.png';
        });
        
        // Update username
        const nameElements = document.querySelectorAll('[data-user-name]');
        nameElements.forEach(el => {
          el.textContent = userData?.username || user.displayName || user.email;
        });
      });
  } else {
    adminElements.forEach(el => {
      el.style.display = 'none';
    });
  }
}

// Store FCM token
async function storeFCMToken(userId) {
  if (!messaging) return;
  
  try {
    const token = await messaging.getToken({
      vapidKey: 'BALbPHXrgI5GOipmKcDj4B5EA4zhcDl4Nbb5MwZcvzuUwsMASHkJIHoJtFyehWZMQc3x-3nTEIB8gYPzMKoLc3U'
    });
    
    if (token) {
      await db.collection('users').doc(userId).update({
        fcmToken: token,
        fcmTokenUpdatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    }
  } catch (error) {
    console.error('Error storing FCM token:', error);
  }
}

// Update user presence
// FIX: Previously set online: true then immediately set online: false (race condition)
// Now uses beforeunload event to set offline only when user actually leaves/closes page
function updateUserPresence(userId) {
  const userRef = db.collection('users').doc(userId);
  
  // Set user online now
  userRef.update({
    lastActive: firebase.firestore.FieldValue.serverTimestamp(),
    online: true
  }).catch(err => {
    // Document may not exist yet (e.g., new user)
    console.warn('Could not update presence:', err.message);
  });
  
  // Set offline when page is actually being unloaded/navigated away
  // Use sendBeacon for reliability during page unload
  const setOffline = () => {
    // Use Firestore directly for a best-effort update
    userRef.update({
      online: false,
      lastActive: firebase.firestore.FieldValue.serverTimestamp()
    }).catch(() => {}); // Silently catch - page is unloading anyway
  };
  
  // Remove any previous listener to avoid duplicates
  window.removeEventListener('beforeunload', window._presenceOfflineHandler);
  window._presenceOfflineHandler = setOffline;
  window.addEventListener('beforeunload', window._presenceOfflineHandler);
  
  // Also set offline on visibility change (tab switch)
  document.removeEventListener('visibilitychange', window._visibilityHandler);
  window._visibilityHandler = () => {
    if (document.visibilityState === 'hidden') {
      userRef.update({
        online: false,
        lastActive: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    } else if (document.visibilityState === 'visible' && auth.currentUser) {
      userRef.update({
        online: true,
        lastActive: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }
  };
  document.addEventListener('visibilitychange', window._visibilityHandler);
}

// Request notification permission
async function requestNotificationPermission() {
  if (!messaging) {
    showToast('Notifications not supported in this browser', 'warning');
    return false;
  }
  
  try {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      const token = await messaging.getToken({ vapidKey: 'BALbPHXrgI5GOipmKcDj4B5EA4zhcDl4Nbb5MwZcvzuUwsMASHkJIHoJtFyehWZMQc3x-3nTEIB8gYPzMKoLc3U' });
      const user = auth.currentUser;
      if (user && token) {
        await db.collection('users').doc(user.uid).update({
          fcmToken: token,
          notificationsEnabled: true
        });
      }
      showToast('Notifications enabled!', 'success');
      return true;
    } else {
      showToast('Notification permission denied', 'warning');
      return false;
    }
  } catch (error) {
    console.error('Error requesting notification permission:', error);
    showToast('Failed to enable notifications', 'error');
    return false;
  }
}

// Initialize Firebase IMMEDIATELY (not on DOMContentLoaded) so that the
// auth-state listener is attached before any page script calls Auth.requireAuth().
// Previously this waited for DOMContentLoaded, which fired AFTER inline page
// scripts that called Auth.requireAuth(), causing logged-in users to be
// redirected to /login on every navigation.
(function bootstrapFirebase() {
  if (typeof firebase === 'undefined') {
    console.error('Firebase SDK not loaded. Please include Firebase scripts.');
    return;
  }
  initializeFirebase();
  initAuthListener();
  // Initialize the Auth module so it registers its own onAuthStateChanged
  // listener and resolves _authStateReady. Without this, Auth.currentUser
  // stays null forever and requireAuth() always redirects to /login.
  if (typeof Auth !== 'undefined' && typeof Auth.init === 'function') {
    Auth.init();
  } else {
    // auth.js may load after this file. Wait briefly and try again.
    document.addEventListener('DOMContentLoaded', () => {
      if (typeof Auth !== 'undefined' && typeof Auth.init === 'function' && !Auth._authStateReady) {
        Auth.init();
      }
    });
  }
})();

// Export for use in other modules
window.firebaseApp = { initializeFirebase, auth, db, messaging, onAuthStateChanged };
