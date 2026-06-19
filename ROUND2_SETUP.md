# Round 2 — Setup checklist

Code-side fixes are already applied in this build. A few **one-time settings in
the Firebase / Netlify consoles** are required for everything to work end-to-end.

---

## 1. Google Login (`auth/unauthorized-domain` → "Google login failed")

Firebase blocks Google sign-in for domains it doesn't trust. Add your Netlify
domain (and any preview / custom domain you use):

1. Open https://console.firebase.google.com/project/manhwa-7d544/authentication/settings
2. Scroll to **Authorized domains**.
3. Click **Add domain** and add:
   - `hwaversee.netlify.app`
   - `localhost` (already there by default — keep it)
   - any custom domain you connect later
4. While you're there, open the **Sign-in method** tab and make sure
   **Google** is **enabled** (toggle on, set a support email).

That's it — no code change needed on your side; the patched `auth.js` already:
- shows clear errors for `auth/unauthorized-domain`, `auth/operation-not-allowed`,
  `auth/network-request-failed`, etc.
- automatically falls back to `signInWithRedirect` on mobile and in-app
  browsers (Facebook, Instagram, TikTok), and when the popup is blocked.
- finishes the redirect handshake on the next page load via
  `auth.getRedirectResult()` in `Auth.init()`.

## 2. Password Reset emails

Reset emails are sent by Firebase. They are throttled and sometimes land in
spam — that's normal.

1. Open https://console.firebase.google.com/project/manhwa-7d544/authentication/emails
2. Click **Password reset** → **Edit template** and confirm the
   **Action URL** points to your project (default is fine, you can
   customise the subject/body).
3. Make sure the reply-to address is one users will recognise.

The patched `Auth.resetPassword()` already passes an explicit
`actionCodeSettings.url` so the link comes back to **your** login page, and
returns a neutral "If that email is registered..." message for unknown
addresses so account existence isn't leaked.

## 3. Storage rules (image uploads in comments)

Deploy the new `storage.rules` file:

```bash
firebase deploy --only storage
```

Limits enforced by the rules **and** by `DB.uploadCommentImage`:
- JPG, PNG, GIF, or WEBP only
- Max 4 MB
- Path: `comment-images/{uid}/...`  (only the owner can upload)

## 4. Firestore rules (reactions)

The reactions system writes to existing `comments/{id}` documents but only
touches the `reactions` and `userReactions` fields. The patched
`firestore.rules` now allows that for any authenticated user. Deploy with:

```bash
firebase deploy --only firestore:rules
```

## 5. Editable commenting rules

The **Rules** button in the discussion section reads from `meta/commentRules`
in Firestore. If that document doesn't exist yet, a sensible default list is
shown. To customise the rules:

1. Open Firestore in the Firebase console.
2. Create document `meta/commentRules` with one field:
   - `rules` (array of strings) — one rule per entry.
3. You can wire this into the Admin Dashboard later (the data shape is
   already what `DB.getCommentRules()` expects).

## 6. Series Import — 1000+ chapter series

The 500-chapter cap came from RoliaScan's WP REST endpoint, not the importer.
`sources/source-roliascan-series.js` now **paginates** the
`/auth/manga-chapters` endpoint in chunks of 500 until exhausted (hard
safety cap: 10 000 chapters) and sorts the result ascending so the import
starts from Chapter 1, not Chapter 690.

No console / config change needed — One Piece will now return ~1184 chapters
in correct reading order, and the importer's existing per-chapter retry logic
keeps going even when individual chapters fail.
