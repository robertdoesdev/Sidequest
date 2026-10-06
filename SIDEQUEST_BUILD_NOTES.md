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
