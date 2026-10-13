# SideQuest V2 — Full Build Notes

This build keeps the existing zero-dependency Node backend and adds a cleaner product layer on top.

## Run

```powershell
npm install
npm start
```

Open the localhost URL printed by Node. Do not use a static HTML preview when testing accounts, push notifications, or API-backed features.

## Backend

The Node server now exposes `/api/quests` and `/api/daily` in addition to the existing account, sync, friends, challenges and Web Push endpoints. Persistent user state remains server-side when signed in; browser storage is only used for local/offline state and harmless UI preferences.

## Product direction

- Image-led quest cards instead of emoji-first cards.
- Daily/Mystery/Weird/Roll loops are surfaced as return paths.
- My Quests lives inside Profile.
- Account creation remains optional until cross-device persistence is desired.
- Mobile discovery filters become compact horizontal filter controls.
- Daily SideQuest uses a calmer editorial treatment without the previous stripe/pink poster styling.

## Real accounts, friends and notifications

This build keeps the real Node backend enabled. Run `START_SIDEQUEST.bat` on Windows or `node server.mjs` from the project folder, then open **http://localhost:3000**. Do not open `index.html` directly: the account, friendship/challenge APIs and background push registration need the server origin.

The backend includes:
- username/password signup and login
- persistent local account/session storage in `data/db.json`
- cross-device state sync
- friend requests + accept/decline/remove
- friend challenges + completion state
- Web Push subscriptions and scheduled retention notifications
- VAPID key generation under `data/vapid.json`

For a public production deployment, deploy the Node server on a host with persistent storage and HTTPS. The frontend's friendship and push features should not be pointed at a static-only deployment.

## Daily SideQuest

The Daily SideQuest is deterministic per date **and installation**, so two different devices/people can receive different daily quests while each person keeps the same quest for that day. Skipping still rotates it for that device.

## Photography

Quest cards now use real Unsplash photography instead of the generated SVG illustrations. See `PHOTO_CREDITS.md` for the source pages and photographers.

## V2.1 (surgical pass)

- Mobile nav is Home, Today, Roll, Discover, Profile with Roll centred (SVG die icon).
- Quest timer counts down from the persisted `active.startedAt`. One interval at most, cleared on every render and when leaving the screen. "Abandon quest" is now wired up.
- Reminder time is editable at any time with an explicit Save. Reminder choices (`notifPrefs`, latest save wins) sync with the account and update the server push schedule. The browser permission flag is never synced.
- Completion screen restored to dark ink with explicit text colours. An earlier layer had lightened the background and left light text on it.
- Streak is a stamped badge with a 7-pip week meter (`streakBadge()` in `app.js`).
- Launch splash (`splash.js` + `#sq-splash`) shows once per session; skipped for reduced motion.
- 30 new quests (IDs 140-169), appended so existing IDs are unchanged.

Known limits: friend search is by exact username; real background push needs HTTPS and persistent storage on the host; no new photography was added in this pass, so `PHOTO_CREDITS.md` is unchanged.

## V3 (persistent backend + community)

- Storage moved from a JSON file to PostgreSQL (`lib/db.mjs`, `migrations/001_init.sql`); the same SQL runs on `pg` in production and on embedded PGlite locally/in tests. Custom auth retained (existing accounts import with `scripts/import-json.mjs`).
- API logic lives in `lib/app.mjs` (`createApp`), used by `server.mjs` locally and `api/index.mjs` on Vercel.
- New: public profiles, community Showcase (explicit publish/unpublish), friend cancel/block/report, challenge cancel + expiry + server-verified completion, password change, DB-backed rate limits, cron endpoint for scheduled push.
- New client: dedicated `#/login` / `#/signup`, `#/u/:username`, `share.js`, network-first offline service worker.
- Not done / needs external setup: hosted-database run, Vercel deploy, real push delivery, email-based recovery.
