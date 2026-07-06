# Mobile App Strategy — Snap to List

Owner requirement: an app version that stays in sync with the website —
edits made in either place appear in both.

## Now shipped: installable web app (PWA)

The website IS the app. It's installable on any phone:

- **Android/Chrome**: visit the site → browser menu → "Add to Home screen"
  (Chrome shows an install prompt automatically on repeat visits).
- **iPhone/Safari**: Share → "Add to Home Screen."

Once installed it launches fullscreen (no browser bars), has the Snap to
List icon, a native-style bottom tab bar (Home / Snap / Items / Channels /
Billing), and uses the phone camera through the same capture flow. Because
it's the same application hitting the same database, **the "sync with the
website" requirement is satisfied by construction** — there is exactly one
source of truth.

Pieces involved: `app/manifest.ts` (web app manifest), `public/icons/*`
(generated app icons incl. maskable), `app/tab-bar.tsx` (mobile bottom
navigation), safe-area + tap-highlight polish in `app/globals.css`, and
`appleWebApp`/viewport metadata in `app/layout.tsx`.

## Later, if store presence is wanted: Capacitor wrapper

If being listed in the App Store / Play Store matters for acquisition,
wrap the same site with [Capacitor](https://capacitorjs.com): a native
shell that loads the existing web app, giving push notifications and store
distribution without a second codebase. Rough scope: ~1–2 weeks including
store review cycles, $99/yr Apple + $25 one-time Google developer accounts.
A full React Native rewrite is NOT recommended — it would fork the product
into two codebases and break the "one source of truth" property that makes
sync free today.

Decision rule: ship the PWA to real users first; invest in the store
wrapper only if user feedback says home-screen installs aren't enough.
