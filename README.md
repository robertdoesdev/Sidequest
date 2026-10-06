# SideQuest

**Do something with your boredom.** Tiny, specific, real-world quests: a daily one, a weird one, a roll of the dice, and one for exactly the time you have.

Vanilla JS (ES modules), no build step, no framework. Optional zero-dependency Node backend for accounts, sync, friend challenges and background notifications.

## Run it

```bash
# Everything (app + API + accounts + push):
node server.mjs            # http://localhost:3000   (Node 18+)

# Front end only (no accounts/challenges/background push):
python3 -m http.server 8080
```

The app works fully without the server. Account features show as "not connected" instead of pretending to work.

| Env var | Purpose |
|---|---|
| `PORT` | default 3000 |
| `SIDEQUEST_DATA` | where `db.json` + `vapid.json` live (default `./data`, git-ignored) |
| `VAPID_SUBJECT` | `mailto:you@yourdomain` sent to push services (set a real one) |
| `SIDEQUEST_CORS_ORIGIN` | only if the front end is hosted on a different origin |
| `TRUST_PROXY=1` | behind a reverse proxy (uses `X-Forwarded-For` for rate limits) |

To point a statically hosted front end at an API elsewhere, set `window.SIDEQUEST_API = 'https://api.example.com'` before `app.js` loads (and `SIDEQUEST_CORS_ORIGIN` on the server).

**Production notes:** serve over HTTPS (required for service workers and push outside localhost). Storage is a single JSON file with atomic writes, which is fine for a small deployment; swap it for a real database if you grow. Sessions are bearer tokens kept in `localStorage`.

## Files

| File | What it does |
|---|---|
| `index.html`, `styles.css`, `app.css` | shell and styling (V2 styles appended to `app.css`) |
| `data.js` | quest library + metadata (139 quests) |
| `recommend.js` | scoring, serendipity, Daily, Roll, Weird, I'm Bored (pure functions) |
| `app.js` | state, routing, views |
| `card.js` | Clear Card canvas renderer, download, share |
| `cloud.js` | accounts, merge-safe sync, friends, challenges client |
| `notify.js`, `sw.js` | notification permission flow, local scheduling, service worker |
| `server.mjs`, `webpush.mjs` | backend and Web Push (VAPID + RFC 8291) |
| `tests/` | `npm test` |

## Quest data

Every quest has: `id, title, category, type, minutes, difficulty, skill, interests, mood, environment, socialLevel (0–2), weirdness (0–3), confidence (0–3), questChain, mystery, detail{what, mission, say, where, notes, complete, variation}`, plus derived `nearby` and `vibes`. IDs `1–44` are the original quests and must never change (saved/completed lists reference them). Add new quests to the end of the `extra` array in `data.js`; `npm test` validates the schema and checks for risky wording.

Safety is part of the data: any quest involving other people automatically gets the respect/consent boundaries, outdoor quests get a surroundings note.

## Storage

Same `localStorage` key as V1 (`sidequest-v1`). V2 only adds fields, so V1 users keep everything. Signing in merges local and cloud data (never overwrites), keeps a one-time backup in `sidequest-v1-premerge`, and tracks save/unsave with timestamps so removals sync correctly.
