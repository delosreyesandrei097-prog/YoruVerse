# YoruVerse - Manhwa Reading Platform

A complete manhwa reading, tracking, and discovery platform built with HTML, CSS, JavaScript, and Firebase.

## Features

- **Homepage** - Featured slider, trending series, recently updated, new releases, latest chapters
- **Browse/Search** - Filter by genre, status, sort options, infinite scroll
- **Genre Page** - Browse series by genre categories
- **Series Details** - Full info, chapter list, follow/favorite/share
- **Chapter Reader** - Vertical scrolling, lazy loading, chapter navigation, reading progress
- **Discussion System** - Comments, replies, likes, real-time updates, sorting
- **User System** - Registration, login, Google auth, profiles
- **Library** - Continue reading, favorites, followed series
- **Reading History** - Track all read chapters
- **Notifications** - New chapter alerts via FCM
- **Admin Dashboard** - Series/chapter management, import tool, user management, analytics
- **Chapter Import** - URL-based extraction with source plugin system
- **Dark/Light Theme** - Toggle between themes
- **Fully Responsive** - Mobile-first design

## Technology Stack

- HTML5, CSS3, Vanilla JavaScript
- Firebase Authentication (Email/Password, Google)
- Firebase Firestore (database)
- Firebase Cloud Messaging (notifications)
- Firebase Hosting

## Setup Guide

### 1. Create Firebase Project

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Click "Add Project" and follow the setup wizard
3. Enable Google Analytics (optional)

### 2. Enable Authentication

1. Go to **Authentication** > **Sign-in method**
2. Enable **Email/Password** provider
3. Enable **Google** provider
4. Add your domain to **Authorized domains**

### 3. Create Firestore Database

1. Go to **Firestore Database** > **Create database**
2. Start in **test mode** (update security rules later)
3. Select a region close to your users

### 4. Deploy Security Rules

1. Go to **Firestore Database** > **Rules**
2. Copy the contents of `firestore.rules` from this project
3. Click **Publish**

### 5. Create Firestore Indexes

1. Go to **Firestore Database** > **Indexes**
2. Click **Add index** for each index in `firestore.indexes.json`
3. Or use Firebase CLI: `firebase deploy --only firestore:indexes`

### 6. Get Firebase Config

1. Go to **Project Settings** > **General**
2. Under "Your apps", click the web icon (**</>**)
3. Register app with a nickname
4. Copy the `firebaseConfig` object
5. Paste it into `js/firebase-config.js`, replacing the placeholder values

### 7. Enable Firebase Cloud Messaging

1. Go to **Project Settings** > **Cloud Messaging**
2. Note your **Server key** and **Sender ID**
3. Generate a **Web Push certificate** key pair
4. Copy the VAPID key to `js/firebase-config.js`

### 8. Install Firebase CLI

```bash
npm install -g firebase-tools
```

### 9. Login and Initialize

```bash
firebase login
firebase init
```

Select:
- Firestore
- Hosting

Set public directory to `.` (current directory)

### 10. Deploy

```bash
firebase deploy
```

Your site will be live at `https://YOUR-PROJECT-ID.web.app`

## Admin Setup

### Create Admin Account

**Option 1: Console Method**

1. Register a new account with email `admin@example.com`
2. Go to Firestore Database > users collection
3. Find the document for admin@example.com
4. Change the `role` field to `"admin"`
5. Set `requirePasswordChange: true`

**Option 2: JavaScript Console**

After logging in as admin@example.com, open browser console and run:

```javascript
db.collection('users').doc(auth.currentUser.uid).update({
  role: 'admin',
  requirePasswordChange: true
});
```

### Default Admin Credentials

- **Email**: admin@example.com
- **Password**: Admin123!

You will be forced to change the password on first login.

## Project Structure

```
manhwa-platform/
  css/
    variables.css          - CSS custom properties and design tokens
    reset.css              - CSS reset and utility classes
    main.css               - Main styles for all components
  js/
    firebase-config.js     - Firebase initialization and config
    auth.js                - Authentication module
    db.js                  - Firestore database operations
    ui.js                  - UI utilities and helpers
    comments.js            - Discussion/comment system
    import-tool.js         - Chapter import functionality
    source-registry.js     - Source plugin management
  sources/
    source-template.js     - Template for new source plugins
    source-example.js      - Example source plugin
  pages/
    index.html             - Homepage
    browse.html            - Browse/search page
    genre.html             - Genre browsing page
    series.html            - Series details page
    chapter.html           - Chapter reader
    login.html             - Login page
    register.html          - Registration page
    profile.html           - User profile
    library.html           - Personal library
    favorites.html         - Favorites page
    history.html           - Reading history
    notifications.html     - Notifications page
    settings.html          - User settings
    about.html             - About page
    admin.html             - Admin dashboard
  images/
    placeholder.svg        - Placeholder image
    default-avatar.svg     - Default user avatar
  firestore.rules          - Firestore security rules
  firestore.indexes.json   - Firestore indexes
  firebase.json            - Firebase configuration
```

## Adding New Source Plugins

1. Copy `sources/source-template.js`
2. Rename and customize for your target website
3. Implement `detect()` and `extract()` methods
4. Register in `source-registry.js` or call `SourceRegistry.register()`

**Note:** Due to CORS restrictions in browsers, most sites will block direct fetching. The import system handles failures gracefully.

## Security Notes

- Update Firestore rules before production use
- The default test-mode rules allow all reads/writes for 30 days
- Always validate user input on both client and server (security rules)
- Never expose Firebase Admin SDK keys in client-side code

## License

This project is for educational purposes. Respect content creators' rights and applicable laws.
