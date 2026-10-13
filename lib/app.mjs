/* =====================================================================
   SideQuest API + static file handler, backed by PostgreSQL (see lib/db.mjs).
   createApp({ db, vapid, ... }) returns { handle(req, res), runScheduler(now) }.
   It is used by server.mjs (local, long-lived) and api/index.mjs (Vercel).

   Authorisation is enforced HERE, on the server: every query that touches
   private data is scoped to the authenticated user's id, never to an id or
   username supplied by the client.
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sendPush } from '../webpush.mjs';
import { quests } from '../data.js';
import { ms } from './db.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const questIds = new Set(quests.map((q) => q.id));
const questTitle = (id) => {
  const q = quests.find((x) => x.id === id);
  return !q ? 'a SideQuest' : q.mystery ? 'a Mystery SideQuest' : q.title;
};

const STATIC = new Set([
  'index.html', 'app.js', 'app.css', 'styles.css', 'data.js', 'recommend.js',
  'cloud.js', 'notify.js', 'card.js', 'share.js', 'sw.js', 'splash.js', 'Sidequest.png'
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json'
};
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/
];
const AVATARS = ['', 'sun', 'bolt', 'leaf', 'wave', 'star', 'moon'];
const USERNAME = /^[a-z0-9_]{3,20}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const DAY = 86400000;
const CHALLENGE_TTL = { pending: 14 * DAY, accepted: 30 * DAY };

export function createApp({
  db, vapid = null, subject = 'mailto:admin@example.com',
  allowInsecurePush = false, corsOrigin = '', cronSecret = '', trustProxy = false, authIpMax = 20
}) {
  /* ---------- helpers ---------- */
  const send = (res, status, obj, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req, limit = 262144) =>
    new Promise((resolve, reject) => {
      let size = 0, tooBig = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit * 8) { req.destroy(); return; }
        if (size > limit) tooBig = true; else chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return reject(Object.assign(new Error('Request too large'), { status: 413 }));
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
      });
      req.on('error', reject);
    });
  const one = async (sql, params) => (await db.query(sql, params))[0] || null;

  /* Rate limits live in the database so they hold across serverless instances. */
  const limited = async (key, max, windowMs) => {
    const secs = windowMs / 1000;
    const r = await one(
      `insert into rate_limits(key, window_start, hits) values ($1, now(), 1)
       on conflict (key) do update set
         window_start = case when rate_limits.window_start < now() - make_interval(secs => $2::float8) then now() else rate_limits.window_start end,
         hits = case when rate_limits.window_start < now() - make_interval(secs => $2::float8) then 1 else rate_limits.hits + 1 end
       returning hits`, [key.slice(0, 120), secs]);
    return r.hits > max;
  };
  const ipOf = (req) => (trustProxy && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket?.remoteAddress || '?';

  const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') });
  const checkPw = (pw, salt, hash) => {
    const h = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'));
    const r = Buffer.from(hash);
    return h.length === r.length && crypto.timingSafeEqual(h, r);
  };

  /** What the account owner sees about themselves. */
  const meView = (u) => ({
    username: u.username, displayName: u.display_name, created: ms(u.created_at),
    bio: u.bio, avatar: u.avatar, profilePublic: u.profile_public
  });
  /** The ONLY shape in which another person is ever exposed. */
  const personView = (r) => ({ username: r.username, displayName: r.display_name, avatar: r.avatar || '' });

  const userByName = (name) => one('select * from users where username = $1', [name]);
  const pairOf = (a, b) => (a < b ? [a, b] : [b, a]);
  const blockedEither = async (a, b) =>
    !!(await one('select 1 from blocks where (blocker=$1 and blocked=$2) or (blocker=$2 and blocked=$1)', [a, b]));

  const newSession = async (userId) => {
    const token = crypto.randomBytes(32).toString('hex');
    await db.query("insert into sessions(token_hash, user_id, expires_at) values ($1, $2, now() + interval '90 days')", [sha(token), userId]);
    if (Math.random() < 0.05) db.query('delete from sessions where expires_at < now()').catch(() => {});
    return token;
  };
  /** Resolves the bearer token to a user row. Returns null when absent/invalid/expired. */
  const authed = async (req) => {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const r = await one(
      `select u.*, s.token_hash from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and s.expires_at > now()`, [sha(m[1])]);
    return r || null;
  };
  const needAuth = async (req, res) => {
    const a = await authed(req);
    if (!a) send(res, 401, { error: 'Not signed in.', code: 'auth' });
    return a;
  };

  /* Whitelist-sanitise client state so the server never stores arbitrary blobs. */
  const arr = (a, max, len) => (Array.isArray(a) ? a.slice(0, max).map((x) => clean(x, len)).filter(Boolean) : []);
  const sanitizeStamps = (o, max) => {
    const out = {};
    Object.entries(o && typeof o === 'object' ? o : {}).slice(0, max).forEach(([k, v]) => {
      if (v && typeof v === 'object') out[clean(k, 40)] = { on: !!v.on, t: Number(v.t) || 0 };
    });
    return out;
  };
  const DEFAULT_PREFS = { enabled: true, daily: true, challenges: true, reminders: true, followups: true, time: '10:00' };
  const sanitizePrefs = (p = {}) => ({
    enabled: p.enabled !== false,
    daily: p.daily !== false, challenges: p.challenges !== false,
    reminders: p.reminders !== false, followups: p.followups !== false,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(p.time) ? p.time : DEFAULT_PREFS.time
  });
  const sanitizeNotifPrefs = (p) => {
    if (!p || typeof p !== 'object') return null;
    const base = sanitizePrefs(p);
    return { daily: base.daily, challenges: base.challenges, reminders: base.reminders, followups: base.followups, time: base.time, at: Number(p.at) || 0 };
  };
  const sanitizeState = (s) => {
    s = s && typeof s === 'object' ? s : {};
    const completed = (Array.isArray(s.completed) ? s.completed : []).slice(0, 2000)
      .filter((c) => c && questIds.has(String(c.id)))
      .map((c) => ({
        id: String(c.id), date: Number(c.date) || 0,
        reflection: clean(c.reflection, 40), again: ['yes', 'maybe', 'no'].includes(c.again) ? c.again : '',
        surprise: clean(c.surprise, 140), learned: clean(c.learned, 140), public: !!c.public
      }));
    const dd = {};
    Object.entries(s.dailyDone && typeof s.dailyDone === 'object' ? s.dailyDone : {}).slice(0, 800).forEach(([k, v]) => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k)) dd[k] = clean(v, 6);
    });
    const a = s.active && questIds.has(String(s.active.id)) ? { id: String(s.active.id), startedAt: Number(s.active.startedAt) || Date.now() } : null;
    return {
      v: 2,
      interests: arr(s.interests, 60, 40),
      saved: arr(s.saved, 400, 6).filter((id) => questIds.has(id)),
      completed,
      onboarded: !!s.onboarded,
      revealed: arr(s.revealed, 400, 6).filter((id) => questIds.has(id)),
      stamps: { saved: sanitizeStamps(s.stamps?.saved, 600), interests: sanitizeStamps(s.stamps?.interests, 100) },
      dailyDone: dd,
      active: a,
      notifPrefs: sanitizeNotifPrefs(s.notifPrefs)
    };
  };

  /* ---------- push ---------- */
  const endpointOk = (ep) => {
    try {
      const u = new URL(ep);
      if (allowInsecurePush && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
      return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
    } catch { return false; }
  };
  const localOf = (tzOffset, now) => {
    const d = new Date(now - (tzOffset || 0) * 60000);
    const p = (n) => String(n).padStart(2, '0');
    return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, hhmm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`, hour: d.getUTCHours() };
  };
  const loadPush = async (userId) => {
    const s = await one('select prefs, tz_offset, sent from push_settings where user_id = $1', [userId]);
    if (!s) return null;
    const subs = (await db.query('select sub from push_subscriptions where user_id = $1 order by created_at', [userId])).map((r) => r.sub);
    return { subs, prefs: s.prefs, tzOffset: s.tz_offset, sent: s.sent || {} };
  };
  const saveSent = (userId, sent) => db.query('update push_settings set sent = $2::jsonb where user_id = $1', [userId, JSON.stringify(sent)]);

  /* Delivery only happens when VAPID keys are configured AND the user has a stored subscription. */
  async function pushTo(userId, message, kind, now = Date.now()) {
    if (!vapid) return 0;
    const rec = await loadPush(userId);
    if (!rec?.subs?.length || !rec.prefs?.enabled || rec.prefs[kind] === false) return 0;
    if (kind === 'challenges') {                                    // hard cap on friend-driven pushes
      const day = localOf(rec.tzOffset, now).date;
      const c = rec.sent.challengeDay?.date === day ? rec.sent.challengeDay.n : 0;
      if (c >= 5) return 0;
      rec.sent.challengeDay = { date: day, n: c + 1 };
      await saveSent(userId, rec.sent);
    }
    let delivered = 0;
    for (const sub of rec.subs) {
      const r = await sendPush(sub, message, vapid, { subject });
      if (r.ok) delivered++;
      if (r.gone) await db.query('delete from push_subscriptions where endpoint = $1', [sub.endpoint]);
    }
    return delivered;
  }
  const bgPush = (...a) => { pushTo(...a).catch(() => {}); };

  /** Run every minute (local) or from the cron endpoint. At most ONE retention push per user per local day, never in quiet hours. */
  async function runScheduler(now = Date.now()) {
    if (!vapid) return 0;
    let sentCount = 0;
    const rows = await db.query(
      `select ps.user_id, st.state from push_settings ps
       left join user_state st on st.user_id = ps.user_id
       where coalesce(ps.prefs->>'enabled', 'true') <> 'false'
         and exists (select 1 from push_subscriptions s where s.user_id = ps.user_id)`);
    for (const row of rows) {
      const rec = await loadPush(row.user_id);
      if (!rec?.subs?.length || !rec.prefs?.enabled) continue;
      const loc = localOf(rec.tzOffset, now);
      if (loc.hour < 8 || loc.hour >= 21) continue;
      if (rec.sent.retentionDate === loc.date) continue;
      const st = row.state;
      const prefs = rec.prefs;
      let msg = null, mark = null;

      const act = st?.active;
      if (!msg && prefs.reminders && act && now - act.startedAt > 3 * 3600000 && now - act.startedAt < 48 * 3600000 &&
          rec.sent.reminder !== `${act.id}:${act.startedAt}`) {
        msg = { title: 'You still have a SideQuest waiting', body: questTitle(act.id), url: `#/quest/${act.id}/active`, tag: 'sq-reminder' };
        mark = () => (rec.sent.reminder = `${act.id}:${act.startedAt}`);
      }
      const last = st?.completed?.length ? st.completed.reduce((a, b) => ((a.date || 0) > (b.date || 0) ? a : b)) : null;
      if (!msg && prefs.followups && last && loc.hhmm >= prefs.time) {
        const lastLocal = localOf(rec.tzOffset, last.date).date;
        const yesterday = localOf(rec.tzOffset, now - DAY).date;
        if (lastLocal === yesterday && rec.sent.followup !== String(last.date)) {
          msg = { title: 'Ready for another?', body: 'You completed a SideQuest yesterday. Fancy another?', url: '#/daily', tag: 'sq-followup' };
          mark = () => (rec.sent.followup = String(last.date));
        }
      }
      if (!msg && prefs.daily && loc.hhmm >= prefs.time && rec.sent.daily !== loc.date && !st?.dailyDone?.[loc.date]) {
        const doneToday = st?.completed?.some((c) => localOf(rec.tzOffset, c.date).date === loc.date);
        if (!doneToday) {
          msg = { title: 'Your SideQuest for today', body: 'It’s waiting for you.', url: '#/daily', tag: 'sq-daily' };
          mark = () => (rec.sent.daily = loc.date);
        }
      }
      if (msg) {
        const n = await pushTo(row.user_id, msg, 'retention', now);
        if (n > 0) {
          const fresh = (await loadPush(row.user_id))?.sent || {};  // pushTo may have updated counters
          Object.assign(rec.sent, fresh, {});
          mark();
          rec.sent.retentionDate = loc.date;
          await saveSent(row.user_id, rec.sent);
          sentCount += 1;
        }
      }
    }
    return sentCount;
  }

  /* ---------- API ---------- */
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });
  const GENERIC_404 = 'No SideQuester with that username.';

  route('GET', '/api/health', async (req, res) => {
    let dbOk = true;
    try { await db.query('select 1'); } catch { dbOk = false; }
    send(res, dbOk ? 200 : 503, {
      ok: dbOk, name: 'sidequest', version: 3, db: db.kind,
      push: vapid ? { publicKey: vapid.publicKey } : null
    });
  });

  /* ----- auth ----- */
  route('POST', '/api/auth/signup', async (req, res) => {
    if (await limited('auth:' + ipOf(req), authIpMax, 600000)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await readBody(req, 4096);
    const username = String(b.username || '').toLowerCase();
    if (!USERNAME.test(username)) return send(res, 400, { error: 'Usernames are 3–20 characters: a–z, 0–9 and _.', field: 'username' });
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128)
      return send(res, 400, { error: 'Passwords need at least 8 characters.', field: 'password' });
    const { salt, hash } = hashPw(b.password);
    let u;
    try {
      u = await one('insert into users(username, display_name, pass_salt, pass_hash) values ($1, $2, $3, $4) returning *',
        [username, clean(b.displayName, 30) || username, salt, hash]);
    } catch (e) {
      if (e.code === '23505') return send(res, 409, { error: 'That username is taken.', field: 'username' });
      throw e;
    }
    send(res, 201, { token: await newSession(u.id), user: meView(u) });
  });

  route('POST', '/api/auth/login', async (req, res) => {
    const b = await readBody(req, 4096);
    const username = String(b.username || '').toLowerCase();
    if ((await limited('auth:' + ipOf(req), authIpMax, 600000)) || (await limited('login:' + username, 8, 600000)))
      return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const u = await userByName(username);
    if (!u || typeof b.password !== 'string' || !checkPw(b.password, u.pass_salt, u.pass_hash))
      return send(res, 401, { error: 'Wrong username or password.' });
    send(res, 200, { token: await newSession(u.id), user: meView(u) });
  });

  route('POST', '/api/auth/logout', async (req, res) => {
    const a = await authed(req);
    if (a) await db.query('delete from sessions where token_hash = $1', [a.token_hash]);
    send(res, 200, { ok: true });
  });

  route('GET', '/api/me', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    send(res, 200, { user: meView(a) });
  });

  route('PATCH', '/api/me', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 2048);
    const sets = [], vals = [];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if ('displayName' in b) {
      const n = clean(b.displayName, 30);
      if (!n) return send(res, 400, { error: 'Display name can’t be empty.', field: 'displayName' });
      add('display_name', n);
    }
    if ('bio' in b) add('bio', clean(b.bio, 160));
    if ('avatar' in b) {
      if (!AVATARS.includes(b.avatar)) return send(res, 400, { error: 'Unknown avatar.', field: 'avatar' });
      add('avatar', b.avatar);
    }
    if ('profilePublic' in b) add('profile_public', !!b.profilePublic);
    if (!sets.length) return send(res, 400, { error: 'Nothing to update.' });
    vals.push(a.id);
    const u = await one(`update users set ${sets.join(', ')} where id = $${vals.length} returning *`, vals);
    send(res, 200, { user: meView(u) });
  });

  route('POST', '/api/me/password', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    if (await limited('pw:' + a.id, 8, 600000)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await readBody(req, 4096);
    if (typeof b.current !== 'string' || !checkPw(b.current, a.pass_salt, a.pass_hash)) return send(res, 403, { error: 'Current password is wrong.', field: 'current' });
    if (typeof b.next !== 'string' || b.next.length < 8 || b.next.length > 128) return send(res, 400, { error: 'Passwords need at least 8 characters.', field: 'next' });
    const { salt, hash } = hashPw(b.next);
    await db.tx(async (q) => {
      await q('update users set pass_salt = $2, pass_hash = $3 where id = $1', [a.id, salt, hash]);
      await q('delete from sessions where user_id = $1 and token_hash <> $2', [a.id, a.token_hash]);   // sign out every other device
    });
    send(res, 200, { ok: true });
  });

  route('DELETE', '/api/me', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 2048);
    if (typeof b.password !== 'string' || !checkPw(b.password, a.pass_salt, a.pass_hash)) return send(res, 403, { error: 'Wrong password.' });
    await db.query('delete from users where id = $1', [a.id]);       // cascades to every table
    send(res, 200, { ok: true });
  });

  /* ----- private synced state ----- */
  route('GET', '/api/state', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const r = await one('select state, updated_at from user_state where user_id = $1', [a.id]);
    send(res, 200, { state: r?.state ?? null, updatedAt: ms(r?.updated_at) });
  });

  route('PUT', '/api/state', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req);
    const state = sanitizeState(b.state);
    const r = await db.tx(async (q) => {
      const row = (await q(
        `insert into user_state(user_id, state, updated_at) values ($1, $2::jsonb, now())
         on conflict (user_id) do update set state = excluded.state, updated_at = now() returning updated_at`,
        [a.id, JSON.stringify(state)]))[0];
      const np = state.notifPrefs;                                   // keep the background scheduler in step
      if (np) {
        const cur = (await q('select prefs from push_settings where user_id = $1', [a.id]))[0];
        if (cur) await q('update push_settings set prefs = $2::jsonb where user_id = $1', [a.id, JSON.stringify(sanitizePrefs({ ...np, enabled: cur.prefs?.enabled }))]);
      }
      return row;
    });
    send(res, 200, { ok: true, updatedAt: ms(r.updated_at) });
  });

  /* ----- public quest data ----- */
  route('GET', '/api/quests', async (req, res) => {
    const sp = new URL(req.url, 'http://localhost').searchParams;
    const category = clean(sp.get('category'), 40), type = clean(sp.get('type'), 40), time = Number(sp.get('time') || 0);
    const list = quests.filter((q) => (!category || q.category === category) && (!type || q.type === type) && (!time || q.minutes <= time));
    send(res, 200, { quests: list.map(({ id, title, category, minutes, difficulty, type, skill, description, interests, environment, mystery }) => ({ id, title, category, minutes, difficulty, type, skill, description, interests, environment, mystery: !!mystery })) });
  });

  route('GET', '/api/daily', async (req, res) => {
    const sp = new URL(req.url, 'http://localhost').searchParams;
    const day = sp.get('date') || new Date().toISOString().slice(0, 10);
    const variant = clean(sp.get('variant'), 120) || 'guest';
    const seed = crypto.createHash('sha256').update(day + ':sidequest-daily:' + variant).digest('hex');
    send(res, 200, { date: day, quest: quests[parseInt(seed.slice(0, 8), 16) % quests.length] });
  });

  /* ----- public profiles ----- */
  const postView = (r, meId) => ({
    id: r.id, questId: r.quest_id, completedAt: ms(r.completed_at), reflection: r.reflection, note: r.note,
    createdAt: ms(r.created_at), mine: r.user_id === meId,
    author: personView(r)
  });
  const clampLimit = (v, d = 12) => Math.max(1, Math.min(30, parseInt(v, 10) || d));
  const POST_SELECT = `select p.id, p.user_id, p.quest_id, p.completed_at, p.reflection, p.note, p.created_at, u.username, u.display_name, u.avatar
                       from showcase_posts p join users u on u.id = p.user_id`;

  route('GET', '/api/profiles/([a-z0-9_]{3,20})', async (req, res, m) => {
    const viewer = await authed(req);
    const u = await userByName(m[1]);
    if (!u || (viewer && viewer.id !== u.id && await blockedEither(viewer.id, u.id))) return send(res, 404, { error: GENERIC_404, code: 'not_found' });
    const self = viewer?.id === u.id;
    if (!u.profile_public && !self) return send(res, 403, { error: 'This profile is private.', code: 'private', username: u.username });
    const stats = await one('select count(*)::int as shared from showcase_posts where user_id = $1', [u.id]);
    let friendship = 'none';
    if (self) friendship = 'self';
    else if (viewer) {
      const [x, y] = pairOf(viewer.id, u.id);
      const f = await one('select status, requester from friendships where user_a = $1 and user_b = $2', [x, y]);
      if (f) friendship = f.status === 'accepted' ? 'friends' : f.requester === viewer.id ? 'outgoing' : 'incoming';
    }
    send(res, 200, {
      profile: { username: u.username, displayName: u.display_name, bio: u.bio, avatar: u.avatar || '', joined: ms(u.created_at), profilePublic: u.profile_public, stats: { shared: stats.shared } },
      friendship
    });
  });

  route('GET', '/api/profiles/([a-z0-9_]{3,20})/posts', async (req, res, m) => {
    const viewer = await authed(req);
    const u = await userByName(m[1]);
    if (!u || (viewer && viewer.id !== u.id && await blockedEither(viewer.id, u.id))) return send(res, 404, { error: GENERIC_404, code: 'not_found' });
    if (!u.profile_public && viewer?.id !== u.id) return send(res, 403, { error: 'This profile is private.', code: 'private' });
    const sp = new URL(req.url, 'http://localhost').searchParams;
    const limit = clampLimit(sp.get('limit'));
    const cursor = parseInt(sp.get('cursor'), 10) || 2147483647;
    const rows = await db.query(`${POST_SELECT} where p.user_id = $1 and p.id < $2 order by p.id desc limit $3`, [u.id, cursor, limit + 1]);
    const page = rows.slice(0, limit);
    send(res, 200, { posts: page.map((r) => postView(r, viewer?.id)), next: rows.length > limit ? page[page.length - 1].id : null });
  });

  /* ----- showcase ----- */
  route('GET', '/api/showcase', async (req, res) => {
    const viewer = await authed(req);
    const sp = new URL(req.url, 'http://localhost').searchParams;
    const limit = clampLimit(sp.get('limit'));
    const cursor = parseInt(sp.get('cursor'), 10) || 2147483647;
    let rows;
    if (sp.get('mine') === '1') {
      if (!viewer) return send(res, 401, { error: 'Not signed in.', code: 'auth' });
      rows = await db.query(`${POST_SELECT} where p.user_id = $1 and p.id < $2 order by p.id desc limit $3`, [viewer.id, cursor, limit + 1]);
    } else {
      rows = await db.query(
        `${POST_SELECT} where u.profile_public and p.id < $1
           and ($2::int is null or not exists (select 1 from blocks b where (b.blocker = $2 and b.blocked = p.user_id) or (b.blocker = p.user_id and b.blocked = $2)))
         order by p.id desc limit $3`, [cursor, viewer?.id ?? null, limit + 1]);
    }
    const page = rows.slice(0, limit);
    send(res, 200, { posts: page.map((r) => postView(r, viewer?.id)), next: rows.length > limit ? page[page.length - 1].id : null });
  });

  route('POST', '/api/showcase', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    if (await limited('pub:' + a.id, 40, 3600000)) return send(res, 429, { error: 'Slow down a little.' });
    const b = await readBody(req, 2048);
    const questId = String(b.questId || '');
    if (!questIds.has(questId)) return send(res, 400, { error: 'Unknown quest.' });
    if (!a.profile_public) return send(res, 409, { error: 'Your profile is private. Make it public first so people can see your post.', code: 'private' });
    /* Only completions the account really has can be published: no claiming other people's quests. */
    const st = await one('select state from user_state where user_id = $1', [a.id]);
    const done = (st?.state?.completed || []).filter((c) => c.id === questId).sort((x, y) => y.date - x.date)[0];
    if (!done) return send(res, 409, { error: 'Finish this quest while signed in (and synced) before sharing it.', code: 'not_completed' });
    const r = await one(
      `insert into showcase_posts(user_id, quest_id, completed_at, reflection, note)
       values ($1, $2, to_timestamp($3::float8 / 1000), $4, $5)
       on conflict (user_id, quest_id) do update set note = excluded.note, reflection = excluded.reflection
       returning id`,
      [a.id, questId, done.date || Date.now(), clean(done.reflection, 40), clean(b.note, 140)]);
    const row = await one(`${POST_SELECT} where p.id = $1`, [r.id]);
    send(res, 200, { post: postView(row, a.id) });
  });

  route('DELETE', '/api/showcase/(\\d{1,9})', async (req, res, m) => {
    const a = await needAuth(req, res); if (!a) return;
    const r = await one('delete from showcase_posts where id = $1 and user_id = $2 returning id', [Number(m[1]), a.id]);
    if (!r) return send(res, 404, { error: 'No such post.' });
    send(res, 200, { ok: true });
  });

  /* ----- blocking & reporting ----- */
  route('GET', '/api/blocks', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const rows = await db.query('select u.username, u.display_name, u.avatar from blocks b join users u on u.id = b.blocked where b.blocker = $1 order by b.created_at desc', [a.id]);
    send(res, 200, { blocked: rows.map(personView) });
  });

  route('POST', '/api/blocks', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 512);
    const them = await userByName(String(b.username || '').toLowerCase().replace(/^@/, ''));
    if (!them) return send(res, 404, { error: GENERIC_404 });
    if (them.id === a.id) return send(res, 400, { error: 'You can’t block yourself.' });
    await db.tx(async (q) => {
      await q('insert into blocks(blocker, blocked) values ($1, $2) on conflict do nothing', [a.id, them.id]);
      const [x, y] = pairOf(a.id, them.id);
      await q('delete from friendships where user_a = $1 and user_b = $2', [x, y]);
      await q(`update challenges set status = 'cancelled', updated_at = now()
               where status in ('pending', 'accepted') and ((from_user = $1 and to_user = $2) or (from_user = $2 and to_user = $1))`, [a.id, them.id]);
    });
    send(res, 200, { ok: true });
  });

  route('DELETE', '/api/blocks/([a-z0-9_]{3,20})', async (req, res, m) => {
    const a = await needAuth(req, res); if (!a) return;
    const them = await userByName(m[1]);
    if (them) await db.query('delete from blocks where blocker = $1 and blocked = $2', [a.id, them.id]);
    send(res, 200, { ok: true });
  });

  route('POST', '/api/report', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    if (await limited('report:' + a.id, 10, 86400000)) return send(res, 429, { error: 'Thanks. You’ve sent a lot of reports today.' });
    const b = await readBody(req, 1024);
    const them = await userByName(String(b.username || '').toLowerCase());
    if (!them || them.id === a.id) return send(res, 404, { error: GENERIC_404 });
    const sid = Number(b.showcaseId) || null;
    await db.query('insert into reports(reporter, target_user, showcase_id, reason) values ($1, $2, $3, $4)', [a.id, them.id, sid, clean(b.reason, 300)]);
    send(res, 201, { ok: true });
  });

  /* ----- friends ----- */
  route('GET', '/api/friends', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const rows = await db.query(
      `select f.status, f.requester, u.username, u.display_name, u.avatar
       from friendships f join users u on u.id = case when f.user_a = $1 then f.user_b else f.user_a end
       where (f.user_a = $1 or f.user_b = $1)
         and not exists (select 1 from blocks b where (b.blocker = $1 and b.blocked = u.id) or (b.blocker = u.id and b.blocked = $1))
       order by u.username`, [a.id]);
    const out = { friends: [], incoming: [], outgoing: [] };
    rows.forEach((r) => {
      if (r.status === 'accepted') out.friends.push(personView(r));
      else if (r.requester === a.id) out.outgoing.push(personView(r));
      else out.incoming.push(personView(r));
    });
    send(res, 200, out);
  });

  route('POST', '/api/friends/request', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    if (await limited('freq:' + a.id, 20, 3600000)) return send(res, 429, { error: 'Slow down a little.' });
    const b = await readBody(req, 1024);
    const name = String(b.username || '').toLowerCase().replace(/^@/, '');
    if (name === a.username) return send(res, 400, { error: 'That’s you!' });
    const them = USERNAME.test(name) ? await userByName(name) : null;
    if (!them || await blockedEither(a.id, them.id)) return send(res, 404, { error: GENERIC_404 });
    const [x, y] = pairOf(a.id, them.id);
    const ex = await one('select status, requester from friendships where user_a = $1 and user_b = $2', [x, y]);
    if (ex?.status === 'accepted') return send(res, 409, { error: 'You’re already friends.' });
    if (ex && ex.requester === them.id) {                            // they already asked us: this is an acceptance
      await db.query("update friendships set status = 'accepted', updated_at = now() where user_a = $1 and user_b = $2", [x, y]);
      return send(res, 200, { status: 'accepted' });
    }
    if (ex) return send(res, 409, { error: 'Request already sent.' });
    try {
      await db.query("insert into friendships(user_a, user_b, requester, status) values ($1, $2, $3, 'pending')", [x, y, a.id]);
    } catch (e) {
      if (e.code === '23505') return send(res, 409, { error: 'Request already sent.' });   // double-tap race
      throw e;
    }
    bgPush(them.id, { title: 'New friend request', body: `${a.display_name} wants to be SideQuest friends.`, url: '#/challenges', tag: 'sq-friend' }, 'challenges');
    send(res, 201, { status: 'pending' });
  });

  route('POST', '/api/friends/respond', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 1024);
    const them = await userByName(String(b.username || '').toLowerCase());
    if (!them) return send(res, 404, { error: 'No such request.' });
    const [x, y] = pairOf(a.id, them.id);
    /* Only the person who RECEIVED the request may answer it. */
    const sql = b.accept
      ? "update friendships set status = 'accepted', updated_at = now() where user_a = $1 and user_b = $2 and status = 'pending' and requester <> $3 returning 1"
      : "delete from friendships where user_a = $1 and user_b = $2 and status = 'pending' and requester <> $3 returning 1";
    if (!(await one(sql, [x, y, a.id]))) return send(res, 404, { error: 'No such request.' });
    send(res, 200, { ok: true });
  });

  route('POST', '/api/friends/cancel', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 1024);
    const them = await userByName(String(b.username || '').toLowerCase());
    if (!them) return send(res, 404, { error: 'No such request.' });
    const [x, y] = pairOf(a.id, them.id);
    if (!(await one("delete from friendships where user_a = $1 and user_b = $2 and status = 'pending' and requester = $3 returning 1", [x, y, a.id])))
      return send(res, 404, { error: 'No such request.' });
    send(res, 200, { ok: true });
  });

  route('DELETE', '/api/friends/([a-z0-9_]{3,20})', async (req, res, m) => {
    const a = await needAuth(req, res); if (!a) return;
    const them = await userByName(m[1]);
    if (!them) return send(res, 404, { error: 'Not friends.' });
    const [x, y] = pairOf(a.id, them.id);
    const ok = await db.tx(async (q) => {
      const r = await q("delete from friendships where user_a = $1 and user_b = $2 and status = 'accepted' returning 1", [x, y]);
      if (!r.length) return false;
      await q(`update challenges set status = 'cancelled', updated_at = now()
               where status in ('pending', 'accepted') and ((from_user = $1 and to_user = $2) or (from_user = $2 and to_user = $1))`, [a.id, them.id]);
      return true;
    });
    if (!ok) return send(res, 404, { error: 'Not friends.' });
    send(res, 200, { ok: true });
  });

  /* ----- challenges ----- */
  const CH_SELECT = `select c.*, f.username as f_user, f.display_name as f_name, f.avatar as f_avatar,
                            t.username as t_user, t.display_name as t_name, t.avatar as t_avatar
                     from challenges c join users f on f.id = c.from_user join users t on t.id = c.to_user`;
  const chView = (c, meId) => {
    const sender = c.from_user === meId;
    return {
      id: c.id, questId: c.quest_id, message: c.message, status: c.status,
      from: { username: c.f_user, displayName: c.f_name, avatar: c.f_avatar || '' },
      to: { username: c.t_user, displayName: c.t_name, avatar: c.t_avatar || '' },
      mine: sender ? 'sender' : 'recipient',
      youDone: !!(sender ? c.from_done_at : c.to_done_at), theyDone: !!(sender ? c.to_done_at : c.from_done_at),
      youDoneAt: ms(sender ? c.from_done_at : c.to_done_at), theyDoneAt: ms(sender ? c.to_done_at : c.from_done_at),
      created: ms(c.created_at), updated: ms(c.updated_at), expires: ms(c.expires_at)
    };
  };
  const expireFor = (userId) => db.query(
    `update challenges set status = 'expired', updated_at = now()
     where status in ('pending', 'accepted') and expires_at < now() and (from_user = $1 or to_user = $1)`, [userId]);
  const loadChallenge = async (id, meId) => {
    await expireFor(meId);
    return one(`${CH_SELECT} where c.id = $1 and (c.from_user = $2 or c.to_user = $2)`, [id, meId]);   // non-participants simply get "not found"
  };

  route('GET', '/api/challenges', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    await expireFor(a.id);
    const rows = await db.query(`${CH_SELECT} where c.from_user = $1 or c.to_user = $1 order by c.updated_at desc limit 100`, [a.id]);
    const mine = rows.map((c) => chView(c, a.id));
    send(res, 200, { challenges: mine, waiting: mine.filter((c) => c.status === 'pending' && c.mine === 'recipient').length });
  });

  route('POST', '/api/challenges', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 2048);
    const to = await userByName(String(b.to || '').toLowerCase());
    const questId = String(b.questId || '');
    if (!questIds.has(questId)) return send(res, 400, { error: 'Unknown quest.' });
    if (!to) return send(res, 403, { error: 'You can only challenge friends.' });
    const [x, y] = pairOf(a.id, to.id);
    const f = await one("select 1 from friendships where user_a = $1 and user_b = $2 and status = 'accepted'", [x, y]);
    if (!f || await blockedEither(a.id, to.id)) return send(res, 403, { error: 'You can only challenge friends.' });
    if (await limited('chal:' + a.id, 10, 86400000)) return send(res, 429, { error: 'That’s plenty of challenges for today.' });
    await expireFor(a.id);
    const open = await db.query("select quest_id from challenges where from_user = $1 and to_user = $2 and status in ('pending', 'accepted')", [a.id, to.id]);
    if (open.length >= 3) return send(res, 409, { error: 'You already have a few open challenges with them.' });
    if (open.some((c) => c.quest_id === questId)) return send(res, 409, { error: 'You’ve already challenged them to that one.' });
    const id = crypto.randomBytes(8).toString('hex');
    try {
      await db.query(
        `insert into challenges(id, from_user, to_user, quest_id, message, status, expires_at)
         values ($1, $2, $3, $4, $5, 'pending', now() + make_interval(secs => $6::float8))`,
        [id, a.id, to.id, questId, clean(b.message, 140), CHALLENGE_TTL.pending / 1000]);
    } catch (e) {
      if (e.code === '23505') return send(res, 409, { error: 'You’ve already challenged them to that one.' });
      throw e;
    }
    bgPush(to.id, { title: 'New SideQuest challenge', body: `${a.display_name} challenged you: ${questTitle(questId)}`, url: '#/challenges', tag: 'sq-challenge-' + id }, 'challenges');
    send(res, 201, { challenge: chView(await one(`${CH_SELECT} where c.id = $1`, [id]), a.id) });
  });

  route('POST', '/api/challenges/([a-f0-9]{16})/respond', async (req, res, m) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 512);
    await expireFor(a.id);
    const accept = !!b.accept;
    /* Single guarded UPDATE: only the recipient, only while pending. Replays and wrong users match zero rows. */
    const r = await one(
      `update challenges set status = $3, updated_at = now(),
         expires_at = case when $3 = 'accepted' then now() + make_interval(secs => $4::float8) else expires_at end
       where id = $1 and to_user = $2 and status = 'pending' returning id`,
      [m[1], a.id, accept ? 'accepted' : 'declined', CHALLENGE_TTL.accepted / 1000]);
    if (!r) return send(res, 404, { error: 'No such challenge.' });
    const c = await loadChallenge(m[1], a.id);
    if (accept) bgPush(c.from_user, { title: 'Challenge accepted', body: `${a.display_name} accepted: ${questTitle(c.quest_id)}`, url: '#/challenges', tag: 'sq-challenge-' + c.id }, 'challenges');
    send(res, 200, { challenge: chView(c, a.id) });
  });

  route('POST', '/api/challenges/([a-f0-9]{16})/cancel', async (req, res, m) => {
    const a = await needAuth(req, res); if (!a) return;
    await expireFor(a.id);
    const r = await one(
      `update challenges set status = 'cancelled', updated_at = now()
       where id = $1 and from_user = $2 and status in ('pending', 'accepted') returning id`, [m[1], a.id]);
    if (!r) return send(res, 404, { error: 'No such challenge.' });
    send(res, 200, { challenge: chView(await loadChallenge(m[1], a.id), a.id) });
  });

  route('POST', '/api/challenges/([a-f0-9]{16})/complete', async (req, res, m) => {
    const a = await needAuth(req, res); if (!a) return;
    const c = await loadChallenge(m[1], a.id);
    if (!c || !['accepted', 'completed'].includes(c.status)) return send(res, 404, { error: 'No such challenge.' });
    const sender = c.from_user === a.id;
    const alreadyMine = !!(sender ? c.from_done_at : c.to_done_at);
    if (!alreadyMine) {
      /* Results can't be forged: the account's synced progress must contain this quest, finished after the challenge began. */
      const st = await one('select state from user_state where user_id = $1', [a.id]);
      const ok = (st?.state?.completed || []).some((d) => d.id === c.quest_id && d.date >= ms(c.created_at) - 60000);
      if (!ok) return send(res, 409, { error: 'Finish the quest first. Your result will count once it has synced.', code: 'not_completed' });
      const both = await db.tx(async (q) => {
        const u = await q(
          `update challenges set
             from_done_at = case when from_user = $2 then coalesce(from_done_at, now()) else from_done_at end,
             to_done_at   = case when to_user   = $2 then coalesce(to_done_at,   now()) else to_done_at end,
             updated_at = now()
           where id = $1 and status = 'accepted' returning from_done_at, to_done_at`, [c.id, a.id]);
        if (!u.length) return null;
        const done = u[0].from_done_at && u[0].to_done_at;
        if (done) await q("update challenges set status = 'completed' where id = $1", [c.id]);
        return !!done;
      });
      if (both === null) return send(res, 409, { error: 'This challenge is no longer open.' });
      const otherId = sender ? c.to_user : c.from_user;
      bgPush(otherId, both
        ? { title: 'Challenge complete 🎉', body: `You both finished: ${questTitle(c.quest_id)}`, url: '#/challenges', tag: 'sq-challenge-' + c.id }
        : { title: 'Your friend finished it', body: `${a.display_name} completed ${questTitle(c.quest_id)}. Your turn?`, url: '#/challenges', tag: 'sq-challenge-' + c.id }, 'challenges');
    }
    send(res, 200, { challenge: chView(await loadChallenge(c.id, a.id), a.id) });
  });

  /* ----- push subscriptions ----- */
  const needPush = (res) => { if (!vapid) { send(res, 503, { error: 'Background notifications aren’t configured on this server.', code: 'push_unavailable' }); return false; } return true; };
  const tzOf = (b) => Math.max(-840, Math.min(840, parseInt(b.tzOffset, 10) || 0));

  route('POST', '/api/push/subscribe', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    if (!needPush(res)) return;
    const b = await readBody(req, 4096);
    const s = b.subscription;
    if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth || !endpointOk(s.endpoint)) return send(res, 400, { error: 'Invalid push subscription.' });
    const sub = { endpoint: String(s.endpoint), keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } };
    await db.tx(async (q) => {
      await q(`insert into push_subscriptions(endpoint, user_id, sub) values ($1, $2, $3::jsonb)
               on conflict (endpoint) do update set user_id = excluded.user_id, sub = excluded.sub`, [sub.endpoint, a.id, JSON.stringify(sub)]);
      await q(`delete from push_subscriptions where user_id = $1 and endpoint not in
               (select endpoint from push_subscriptions where user_id = $1 order by created_at desc limit 5)`, [a.id]);
      await q(`insert into push_settings(user_id, prefs, tz_offset) values ($1, $2::jsonb, $3)
               on conflict (user_id) do update set prefs = excluded.prefs, tz_offset = excluded.tz_offset, updated_at = now()`,
        [a.id, JSON.stringify(sanitizePrefs(b.prefs)), tzOf(b)]);
    });
    send(res, 200, { ok: true });
  });

  route('POST', '/api/push/prefs', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 2048);
    const r = await one('update push_settings set prefs = $2::jsonb, tz_offset = $3, updated_at = now() where user_id = $1 returning 1',
      [a.id, JSON.stringify(sanitizePrefs(b.prefs)), tzOf(b)]);
    if (!r) return send(res, 404, { error: 'No subscription on this account.' });
    send(res, 200, { ok: true });
  });

  route('POST', '/api/push/unsubscribe', async (req, res) => {
    const a = await needAuth(req, res); if (!a) return;
    const b = await readBody(req, 2048);
    await db.tx(async (q) => {
      await q('delete from push_subscriptions where user_id = $1 and endpoint = $2', [a.id, String(b.endpoint || '')]);
      await q('delete from push_settings where user_id = $1 and not exists (select 1 from push_subscriptions where user_id = $1)', [a.id]);
    });
    send(res, 200, { ok: true });
  });

  /* Scheduled delivery for serverless hosts (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`). */
  route('GET', '/api/cron/push', async (req, res) => {
    if (!cronSecret) return send(res, 503, { error: 'CRON_SECRET is not configured.' });
    const given = Buffer.from(req.headers.authorization || '');
    const want = Buffer.from(`Bearer ${cronSecret}`);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return send(res, 401, { error: 'Unauthorized.' });
    send(res, 200, { sent: await runScheduler() });
  });

  /* ---------- static (local / long-lived server only; Vercel serves these itself) ---------- */
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' https://images.unsplash.com data: blob:; connect-src 'self'; worker-src 'self'; " +
      "manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };

  function serveStatic(req, res, pathname) {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const top = rel.split('/')[0];
    const ok = STATIC.has(rel) || ((top === 'assets' || top === 'favicon') && !rel.includes('..'));
    const file = path.join(ROOT, rel);
    if (!ok || !file.startsWith(ROOT + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': top === 'assets' || top === 'favicon' ? 'public, max-age=86400' : 'no-cache',
      ...securityHeaders
    });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res, { serveFiles = true } = {}) {
    const { pathname } = new URL(req.url, 'http://x');
    try {
      if (pathname.startsWith('/api/')) {
        if (corsOrigin) {
          res.setHeader('Access-Control-Allow-Origin', corsOrigin);
          res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
          res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
          if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        }
        for (const r of routes) {
          const m = r.re.exec(pathname);
          if (m && r.method === req.method) return await r.handler(req, res, m);
        }
        return send(res, 404, { error: 'Not found' });
      }
      if (!serveFiles) return send(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      serveStatic(req, res, pathname);
    } catch (e) {
      if (!e.status) console.error('[api error]', e.message);      // never log request bodies, tokens or credentials
      if (!res.headersSent) send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    }
  }

  return { handle, runScheduler };
}
