# SideQuest

**Do something with your boredom.** Tiny, specific, real-world quests: a daily one, a weird one, a roll of the dice, and one for exactly the time you have.

Front end: vanilla JS (ES modules), no build step. Back end: a small Node API on **PostgreSQL**. Guest mode works with no account and no server.

## Quick start (local)

```bash
npm install            # pg (production driver) + PGlite (embedded Postgres for local dev/tests)
npm start              # http://localhost:3000  (app + API + embedded database)
npm test               # 29 tests
npm run check          # syntax checks
```

With no `DATABASE_URL`, the server runs an **embedded PostgreSQL (PGlite)** stored in `./data/pg` and applies migrations on start. Set `DATABASE_URL` to use a real Postgres instead; the SQL is identical.

Front end only (no accounts, friends, challenges, community; everything else works): `python3 -m http.server 8080`.

## Architecture

| Layer | Choice | Why |
|---|---|---|
| Auth | Existing custom auth: scrypt password hashes, random 256-bit bearer tokens stored **hashed** (SHA-256) in `sessions`, 90-day expiry | Least disruptive: existing accounts keep working, and there is exactly one auth system |
| Database | PostgreSQL via `lib/db.mjs` (`pg` pool in production, PGlite locally) | Persistent, relational, constraints + indexes; works on Supabase, Neon, RDS, etc. |
| API | `lib/app.mjs` (`createApp({ db, ... })`) | One handler used by the local server and the Vercel function |
| Authorization | In the API, on every query, scoped to the authenticated user id (never to ids or usernames from the request) | Verified by tests that attack the endpoints as other users |
| Defence in depth | Row-level security **enabled with no policies** on every table | Supabase's public REST/anon key can't read or write any table; only the server's DB role can |

**Why not Supabase Auth?** The existing username/password system has no email, and switching would have orphaned existing accounts and added a second identity system. Supabase is still a fine *host*: use its Postgres connection string as `DATABASE_URL`.

### Schema (`migrations/001_init.sql`)

`users` (public profile fields: display_name, bio, avatar, profile_public), `sessions`, `user_state` (private synced progress, never joined into public queries), `friendships` (one canonical row per pair, `user_a < user_b`), `blocks`, `challenges` (state machine + partial unique index preventing duplicate open challenges), `showcase_posts` (`unique(user_id, quest_id)`: retries can't duplicate), `reports`, `push_subscriptions`, `push_settings`, `rate_limits` (DB-backed so limits hold across serverless instances), `schema_migrations`.

Apply migrations: `npm run migrate` (uses `DATABASE_URL`, or the local embedded DB). Re-running is safe; applied files are skipped.

### Importing the old JSON backend

```bash
node scripts/import-json.mjs ./data/db.json     # with DATABASE_URL set to target a real database
```
Users keep their original password hashes (passwords keep working), plus state, friends, challenges, push settings. Existing rows are never overwritten; old login sessions are not imported (everyone signs in once).

## Environment variables (see `.env.example`)

| Variable | Needed for | Notes |
|---|---|---|
| `DATABASE_URL` | production | Postgres connection string. For Supabase use the pooled (transaction) string. **Secret.** |
| `PGPOOL_MAX` | optional | Pool size, default 5 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | background push | Without these, push stays **off** and reminders are local-only. Private key is **secret**. Generate command is in `.env.example`. |
| `CRON_SECRET` | scheduled push on Vercel | Protects `/api/cron/push` |
| `SIDEQUEST_CORS_ORIGIN` | only if API and front end are on different origins | |
| `PORT`, `SIDEQUEST_DATA`, `TRUST_PROXY=1`, `SIDEQUEST_AUTH_IP_MAX` | local server | |

Nothing secret is read by the front end; no key is ever sent to the browser except the **public** VAPID key.

## Deploying to Vercel (prepared, NOT done)

1. Create a Postgres database (Supabase/Neon/etc.) and run `DATABASE_URL=... npm run migrate` once from your machine.
2. In Vercel, import the repo (no framework, no build command; `vercel.json` already routes `/api/*` to `api/index.mjs` and hides server files).
3. Set `DATABASE_URL` (and optionally the VAPID vars and `CRON_SECRET`) as Vercel environment variables.
4. Optional: `node scripts/import-json.mjs` against the production URL, only if you have legacy accounts to carry over.

Notes: Vercel Cron's every-minute schedule needs a plan that allows it (Hobby is limited to daily), so background push timing is only as precise as your cron plan. Static files are served by Vercel; the API runs as a function.

## What's in the app

- **Guest-first**: no login wall. Accounts add sync, friends, challenges and community sharing; local progress is merged in and never overwritten (a backup is kept).
- **Dedicated `#/login` and `#/signup`** with validation, show/hide password, loading/error states, duplicate and wrong-password handling, "continue as guest".
- **Community Showcase** (`#/showcase`): public feed with pagination, refresh, empty/error/retry states. Only quests you **explicitly publish** appear; you can unpublish at any time. The server only lets you publish quests that exist in your own synced completions.
- **Public profiles** (`#/u/username`): display name, bio, avatar, shared quests, friendship actions. A profile can be made private. Only whitelisted public fields are ever returned.
- **Friends**: request, cancel, accept, decline, remove, block, report. **Challenges**: create, accept/decline, cancel, complete (verified against synced progress), expiry (14 days to accept, 30 to finish).
- **Sharing**: Web Share API with clipboard fallback; links are canonical (`#/u/name`, `#/quest/id`) and never contain tokens.
- **Notifications**: local reminders where supported; background push only when VAPID keys and a stored subscription exist.
- **PWA**: installable; network-first service worker gives an offline fallback without ever serving stale code online; `/api/*` is never cached.

## Files

| File | What it does |
|---|---|
| `index.html`, `styles.css`, `app.css` | shell and styling |
| `data.js` | quest library (169 quests) |
| `recommend.js` | scoring, Daily, Roll, Weird, I'm Bored |
| `app.js` | state, routing, views |
| `cloud.js` | API client, sync engine and merge logic |
| `share.js` | canonical links + share/copy |
| `card.js`, `notify.js`, `splash.js`, `sw.js` | clear card, reminders/push client, launch splash, service worker |
| `lib/app.mjs`, `lib/db.mjs` | API handler, DB access + migrations |
| `server.mjs` | local long-lived server (static + API) |
| `api/index.mjs`, `vercel.json` | Vercel function entry + config |
| `migrations/`, `scripts/` | SQL schema, `migrate`, `import-json` |
| `webpush.mjs` | zero-dependency Web Push (RFC 8291/8292) |
| `tests/` | `node --test` suites |

## Status: implemented vs verified vs not yet verified

**Verified locally** (automated: 29 tests; browser: Playwright on mobile 390px and desktop 1280px): auth + validation + sessions, state sync + merge, profiles/privacy, showcase publish/dedupe/pagination/delete, friends + blocking, challenges + authorization + expiry, legacy import, cron auth, sharing helper, timer, completion, streak, offline reload.

**Not verified (needs credentials or a real host):** running against a hosted Postgres/Supabase (tested with the embedded Postgres, same SQL); the Vercel deployment itself (function routing, cron); real background push delivery to a phone (the encryption and VAPID header are tested against a fake push service). Do not call it production-verified until those are exercised.

**Known limits:** no email, so no password recovery or email verification (needs an email provider); sessions are bearer tokens in `localStorage`; moderation is limited to block + report (reports are stored, there is no admin UI); friends are found by exact username only.


## V3 upgrade notes

- **Profile hub** (`#/profile`, replaces Progress; `#/progress` still redirects). Sections: My Profile (`#/me`), My Quests, Showcase, Friends (`#/friends`), Friend Challenges, Activity (`#/activity`).
- **Back navigation** is one pattern, defined in `nav.js` (unit-tested): come-from context when sensible, fixed parent otherwise, none on top-level tabs.
- **Ongoing quest**: a bar shows on every screen while a quest is in progress. Starting a different quest asks first (resume / switch / cancel).
- **Migration 002** (`migrations/002_more_avatars.sql`) widens the avatar list from 6 to 24. Run it on the database **before** deploying this front end; a manual rollback is in `migrations/down/`. Until it is applied, picking a new avatar returns a friendly 409 and nothing else breaks.
- **Tests**: `npm test` (server tests need `npm install` for the embedded database). `tests/static.test.mjs` needs no database. Browser checks: `node tests/e2e/mock-server.mjs &` then `python3 tests/e2e/browser.py` (needs Playwright; uses a mock API, so it exercises the front end only).
