/* =====================================================================
   SideQuest V2 backend — zero dependencies, Node 18+.
   Serves the static app AND the JSON API from one process:
     node server.mjs        (PORT, SIDEQUEST_DATA, VAPID_SUBJECT env vars)

   Storage is a single JSON file (atomic writes). That is deliberately
   simple and fine for a small deployment; swap `store` for a real
   database if SideQuest outgrows it.
   ===================================================================== */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { generateVapid, sendPush } from './webpush.mjs';
import { quests } from './data.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const questIds = new Set(quests.map((q) => q.id));
const questTitle = (id) => {
  const q = quests.find((x) => x.id === id);
  return !q ? 'a SideQuest' : q.mystery ? 'a Mystery SideQuest' : q.title;
};

const STATIC = new Set([
  'index.html', 'app.js', 'app.css', 'styles.css', 'data.js', 'recommend.js',
  'cloud.js', 'notify.js', 'card.js', 'sw.js', 'Sidequest.png'
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

const USERNAME = /^[a-z0-9_]{3,20}$/;
const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, n);
const pairKey = (a, b) => [a, b].sort().join('|');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export async function startServer({
  port = Number(process.env.PORT) || 3000,
  dataDir = process.env.SIDEQUEST_DATA || path.join(ROOT, 'data'),
  allowInsecurePush = process.env.SIDEQUEST_ALLOW_INSECURE_PUSH === '1',
  corsOrigin = process.env.SIDEQUEST_CORS_ORIGIN || '',
  subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  schedule = true,
  quiet = false
} = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbFile = path.join(dataDir, 'db.json');
  const vapidFile = path.join(dataDir, 'vapid.json');

  /* ---------- store ---------- */
  let db = { users: {}, sessions: {}, friends: {}, challenges: {}, push: {}, counters: {} };
  try { db = { ...db, ...JSON.parse(fs.readFileSync(dbFile, 'utf8')) }; } catch {}
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 150);
  };
  const flush = () => {
    clearTimeout(saveTimer);
    const tmp = dbFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dbFile);
  };

  let vapid;
  try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); } catch {
    vapid = generateVapid();
    fs.writeFileSync(vapidFile, JSON.stringify(vapid), { mode: 0o600 });
  }

  /* ---------- helpers ---------- */
  const send = (res, status, obj, extra = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
    res.end(JSON.stringify(obj));
  };
  const readBody = (req, limit = 262144) =>
    new Promise((resolve, reject) => {
      let size = 0;
      let tooBig = false;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit * 8) { req.destroy(); return; }   // absurdly large: drop the connection
        if (size > limit) tooBig = true;                    // otherwise drain, then answer 413 cleanly
        else chunks.push(c);
      });
      req.on('end', () => {
        if (tooBig) return reject(Object.assign(new Error('Request too large'), { status: 413 }));
        if (!chunks.length) return resolve({});
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(Object.assign(new Error('bad json'), { status: 400 })); }
      });
      req.on('error', reject);
    });

  const rate = new Map();
  const limited = (key, max, windowMs) => {
    const now = Date.now();
    const hits = (rate.get(key) || []).filter((t) => now - t < windowMs);
    hits.push(now);
    rate.set(key, hits);
    return hits.length > max;
  };
  const ipOf = (req) => (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']?.split(',')[0].trim()) || req.socket.remoteAddress || '?';

  const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({
    salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex')
  });
  const checkPw = (pw, rec) => {
    const h = Buffer.from(crypto.scryptSync(pw, rec.salt, 64).toString('hex'));
    const r = Buffer.from(rec.hash);
    return h.length === r.length && crypto.timingSafeEqual(h, r);
  };
  const publicUser = (u) => ({ username: u.username, displayName: u.displayName, created: u.created });
  const nameOf = (un) => db.users[un]?.displayName || un;

  const newSession = (username) => {
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[sha(token)] = { u: username, exp: Date.now() + 90 * 86400000 };
    persist();
    return token;
  };
  const authed = (req) => {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!m) return null;
    const s = db.sessions[sha(m[1])];
    if (!s || s.exp < Date.now() || !db.users[s.u]) return null;
    return { username: s.u, user: db.users[s.u], tokenHash: sha(m[1]) };
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
      active: a
    };
  };

  /* ---------- push ---------- */
  const DEFAULT_PREFS = { enabled: true, daily: true, challenges: true, reminders: true, followups: true, time: '10:00' };
  const sanitizePrefs = (p = {}) => ({
    enabled: p.enabled !== false,
    daily: p.daily !== false, challenges: p.challenges !== false,
    reminders: p.reminders !== false, followups: p.followups !== false,
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(p.time) ? p.time : DEFAULT_PREFS.time
  });
  const endpointOk = (ep) => {
    try {
      const u = new URL(ep);
      if (allowInsecurePush && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return true;
      return u.protocol === 'https:' && PUSH_HOSTS.some((re) => re.test(u.hostname));
    } catch { return false; }
  };
  const localOf = (rec, now) => {
    const d = new Date(now - (rec.tzOffset || 0) * 60000);
    const p = (n) => String(n).padStart(2, '0');
    return { date: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`, hhmm: `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`, hour: d.getUTCHours() };
  };

  async function pushTo(username, message, kind, now = Date.now()) {
    const rec = db.push[username];
    if (!rec?.subs?.length || !rec.prefs?.enabled || rec.prefs[kind] === false) return 0;
    /* Hard cap on friend-driven pushes so nobody can be spammed. */
    if (kind === 'challenges') {
      const day = localOf(rec, now).date;
      rec.sent = rec.sent || {};
      const c = rec.sent.challengeDay?.date === day ? rec.sent.challengeDay.n : 0;
      if (c >= 5) return 0;
      rec.sent.challengeDay = { date: day, n: c + 1 };
    }
    let delivered = 0;
    for (const sub of [...rec.subs]) {
      const r = await sendPush(sub, message, vapid, { subject });
      if (r.ok) delivered++;
      if (r.gone) rec.subs = rec.subs.filter((s) => s.endpoint !== sub.endpoint);
    }
    persist();
    return delivered;
  }

  /** Called every minute. At most ONE retention push per user per local day, never in quiet hours. */
  async function runScheduler(now = Date.now()) {
    let sentCount = 0;
    for (const [username, rec] of Object.entries(db.push)) {
      if (!rec.subs?.length || !rec.prefs?.enabled) continue;
      const loc = localOf(rec, now);
      if (loc.hour < 8 || loc.hour >= 21) continue;
      rec.sent = rec.sent || {};
      if (rec.sent.retentionDate === loc.date) continue;

      const st = db.users[username]?.state;
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
        const lastLocal = localOf(rec, last.date).date;
        const yesterday = localOf(rec, now - 86400000).date;
        if (lastLocal === yesterday && rec.sent.followup !== String(last.date)) {
          msg = { title: 'Ready for another?', body: 'You completed a SideQuest yesterday. Fancy another?', url: '#/daily', tag: 'sq-followup' };
          mark = () => (rec.sent.followup = String(last.date));
        }
      }

      if (!msg && prefs.daily && loc.hhmm >= prefs.time && rec.sent.daily !== loc.date && !st?.dailyDone?.[loc.date]) {
        const doneToday = st?.completed?.some((c) => localOf(rec, c.date).date === loc.date);
        if (!doneToday) {
          msg = { title: 'Your SideQuest for today', body: 'It’s waiting for you.', url: '#/daily', tag: 'sq-daily' };
          mark = () => (rec.sent.daily = loc.date);
        }
      }

      if (msg) {
        const n = await pushTo(username, msg, 'retention', now);
        if (n > 0) {
          mark();
          rec.sent.retentionDate = loc.date;
          sentCount += 1;
        }
      }
    }
    persist();
    return sentCount;
  }

  /* ---------- API ---------- */
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

  route('GET', '/api/health', async (req, res) =>
    send(res, 200, { ok: true, name: 'sidequest', version: 2, push: { publicKey: vapid.publicKey } }));

  route('POST', '/api/auth/signup', async (req, res) => {
    if (limited('auth:' + ipOf(req), 20, 600000)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const b = await readBody(req, 4096);
    const username = String(b.username || '').toLowerCase();
    if (!USERNAME.test(username)) return send(res, 400, { error: 'Usernames are 3–20 characters: a–z, 0–9 and _.' });
    if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 128)
      return send(res, 400, { error: 'Passwords need at least 8 characters.' });
    if (db.users[username]) return send(res, 409, { error: 'That username is taken.' });
    db.users[username] = {
      username, displayName: clean(b.displayName, 30) || username, pass: hashPw(b.password),
      created: Date.now(), state: null, stateAt: 0
    };
    persist();
    send(res, 201, { token: newSession(username), user: publicUser(db.users[username]) });
  });

  route('POST', '/api/auth/login', async (req, res) => {
    const b = await readBody(req, 4096);
    const username = String(b.username || '').toLowerCase();
    if (limited('auth:' + ipOf(req), 20, 600000) || limited('login:' + username, 8, 600000))
      return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const u = db.users[username];
    if (!u || typeof b.password !== 'string' || !checkPw(b.password, u.pass))
      return send(res, 401, { error: 'Wrong username or password.' });
    send(res, 200, { token: newSession(username), user: publicUser(u) });
  });

  route('POST', '/api/auth/logout', async (req, res) => {
    const a = authed(req);
    if (a) { delete db.sessions[a.tokenHash]; persist(); }
    send(res, 200, { ok: true });
  });

  route('GET', '/api/me', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    send(res, 200, { user: publicUser(a.user) });
  });

  route('PATCH', '/api/me', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const b = await readBody(req, 2048);
    const name = clean(b.displayName, 30);
    if (!name) return send(res, 400, { error: 'Display name can’t be empty.' });
    a.user.displayName = name;
    persist();
    send(res, 200, { user: publicUser(a.user) });
  });

  route('DELETE', '/api/me', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const b = await readBody(req, 2048);
    if (typeof b.password !== 'string' || !checkPw(b.password, a.user.pass)) return send(res, 403, { error: 'Wrong password.' });
    const un = a.username;
    delete db.users[un];
    delete db.push[un];
    Object.keys(db.sessions).forEach((k) => db.sessions[k].u === un && delete db.sessions[k]);
    Object.keys(db.friends).forEach((k) => k.split('|').includes(un) && delete db.friends[k]);
    Object.keys(db.challenges).forEach((k) => {
      const c = db.challenges[k];
      if (c.from === un || c.to === un) delete db.challenges[k];
    });
    persist();
    send(res, 200, { ok: true });
  });

  route('GET', '/api/state', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    send(res, 200, { state: a.user.state, updatedAt: a.user.stateAt });
  });

  route('PUT', '/api/state', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const b = await readBody(req);
    a.user.state = sanitizeState(b.state);
    a.user.stateAt = Date.now();
    persist();
    send(res, 200, { ok: true, updatedAt: a.user.stateAt });
  });

  /* friends */
  const friendView = (un) => ({ username: un, displayName: nameOf(un) });
  route('GET', '/api/quests', async (req, res) => {
    const category = clean(new URL(req.url, 'http://localhost').searchParams.get('category'), 40);
    const type = clean(new URL(req.url, 'http://localhost').searchParams.get('type'), 40);
    const time = Number(new URL(req.url, 'http://localhost').searchParams.get('time') || 0);
    const list = quests.filter((q) => (!category || q.category === category) && (!type || q.type === type) && (!time || q.minutes <= time));
    return send(res, 200, { quests: list.map(({ id, title, category, minutes, difficulty, type, skill, description, interests, environment, mystery }) => ({ id, title, category, minutes, difficulty, type, skill, description, interests, environment, mystery: !!mystery })) });
  });

  route('GET', '/api/daily', async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const day = url.searchParams.get('date') || new Date().toISOString().slice(0, 10);
    const variant = clean(url.searchParams.get('variant'), 120) || 'guest';
    const seed = crypto.createHash('sha256').update(day + ':sidequest-daily:' + variant).digest('hex');
    const index = parseInt(seed.slice(0, 8), 16) % quests.length;
    const q = quests[index];
    return send(res, 200, { date: day, quest: q });
  });

  route('GET', '/api/friends', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const out = { friends: [], incoming: [], outgoing: [] };
    Object.values(db.friends).forEach((f) => {
      if (f.a !== a.username && f.b !== a.username) return;
      const other = f.a === a.username ? f.b : f.a;
      if (f.status === 'accepted') out.friends.push(friendView(other));
      else if (f.from === a.username) out.outgoing.push(friendView(other));
      else out.incoming.push(friendView(other));
    });
    send(res, 200, out);
  });

  route('POST', '/api/friends/request', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    if (limited('freq:' + a.username, 20, 3600000)) return send(res, 429, { error: 'Slow down a little.' });
    const b = await readBody(req, 1024);
    const them = String(b.username || '').toLowerCase().replace(/^@/, '');
    if (them === a.username) return send(res, 400, { error: 'That’s you!' });
    if (!db.users[them]) return send(res, 404, { error: 'No SideQuester with that username.' });
    const key = pairKey(a.username, them);
    const ex = db.friends[key];
    if (ex?.status === 'accepted') return send(res, 409, { error: 'You’re already friends.' });
    if (ex && ex.from === them) {
      ex.status = 'accepted';
      persist();
      return send(res, 200, { status: 'accepted' });
    }
    if (ex) return send(res, 409, { error: 'Request already sent.' });
    db.friends[key] = { a: key.split('|')[0], b: key.split('|')[1], from: a.username, status: 'pending', t: Date.now() };
    persist();
    pushTo(them, { title: 'New friend request', body: `${a.user.displayName} wants to be SideQuest friends.`, url: '#/challenges', tag: 'sq-friend' }, 'challenges').catch(() => {});
    send(res, 201, { status: 'pending' });
  });

  route('POST', '/api/friends/respond', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const b = await readBody(req, 1024);
    const them = String(b.username || '').toLowerCase();
    const key = pairKey(a.username, them);
    const f = db.friends[key];
    if (!f || f.status !== 'pending' || f.from === a.username) return send(res, 404, { error: 'No such request.' });
    if (b.accept) f.status = 'accepted'; else delete db.friends[key];
    persist();
    send(res, 200, { ok: true });
  });

  route('DELETE', '/api/friends/([a-z0-9_]{3,20})', async (req, res, m) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const key = pairKey(a.username, m[1]);
    if (!db.friends[key]) return send(res, 404, { error: 'Not friends.' });
    delete db.friends[key];
    Object.keys(db.challenges).forEach((id) => {
      const c = db.challenges[id];
      if (pairKey(c.from, c.to) === key && c.status !== 'completed') delete db.challenges[id];
    });
    persist();
    send(res, 200, { ok: true });
  });

  /* challenges */
  const chView = (c, me) => ({
    id: c.id, questId: c.questId, message: c.message, status: c.status,
    from: friendView(c.from), to: friendView(c.to), mine: c.from === me ? 'sender' : 'recipient',
    youDone: !!(c.from === me ? c.fromDone : c.toDone), theyDone: !!(c.from === me ? c.toDone : c.fromDone),
    created: c.created, updated: c.updated
  });

  route('GET', '/api/challenges', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const mine = Object.values(db.challenges)
      .filter((c) => c.from === a.username || c.to === a.username)
      .sort((x, y) => y.updated - x.updated).slice(0, 100)
      .map((c) => chView(c, a.username));
    send(res, 200, { challenges: mine, waiting: mine.filter((c) => c.status === 'pending' && c.mine === 'recipient').length });
  });

  route('POST', '/api/challenges', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const b = await readBody(req, 2048);
    const to = String(b.to || '').toLowerCase();
    const questId = String(b.questId || '');
    if (!questIds.has(questId)) return send(res, 400, { error: 'Unknown quest.' });
    if (db.friends[pairKey(a.username, to)]?.status !== 'accepted') return send(res, 403, { error: 'You can only challenge friends.' });
    if (limited('chal:' + a.username, 10, 86400000)) return send(res, 429, { error: 'That’s plenty of challenges for today.' });
    const open = Object.values(db.challenges).filter((c) => c.from === a.username && c.to === to && ['pending', 'accepted'].includes(c.status));
    if (open.length >= 3) return send(res, 409, { error: 'You already have a few open challenges with them.' });
    if (open.some((c) => c.questId === questId)) return send(res, 409, { error: 'You’ve already challenged them to that one.' });
    const id = crypto.randomBytes(8).toString('hex');
    const c = { id, from: a.username, to, questId, message: clean(b.message, 140), status: 'pending', fromDone: 0, toDone: 0, created: Date.now(), updated: Date.now() };
    db.challenges[id] = c;
    persist();
    pushTo(to, { title: 'New SideQuest challenge', body: `${a.user.displayName} challenged you: ${questTitle(questId)}`, url: '#/challenges', tag: 'sq-challenge-' + id }, 'challenges').catch(() => {});
    send(res, 201, { challenge: chView(c, a.username) });
  });

  route('POST', '/api/challenges/([a-f0-9]{16})/respond', async (req, res, m) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const c = db.challenges[m[1]];
    if (!c || c.to !== a.username || c.status !== 'pending') return send(res, 404, { error: 'No such challenge.' });
    const b = await readBody(req, 512);
    c.status = b.accept ? 'accepted' : 'declined';
    c.updated = Date.now();
    persist();
    if (b.accept) pushTo(c.from, { title: 'Challenge accepted', body: `${a.user.displayName} accepted: ${questTitle(c.questId)}`, url: '#/challenges', tag: 'sq-challenge-' + c.id }, 'challenges').catch(() => {});
    send(res, 200, { challenge: chView(c, a.username) });
  });

  route('POST', '/api/challenges/([a-f0-9]{16})/complete', async (req, res, m) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const c = db.challenges[m[1]];
    if (!c || (c.from !== a.username && c.to !== a.username) || !['accepted', 'completed'].includes(c.status))
      return send(res, 404, { error: 'No such challenge.' });
    const mineKey = c.from === a.username ? 'fromDone' : 'toDone';
    if (!c[mineKey]) {
      c[mineKey] = Date.now();
      c.updated = Date.now();
      const other = c.from === a.username ? c.to : c.from;
      if (c.fromDone && c.toDone) {
        c.status = 'completed';
        pushTo(other, { title: 'Challenge complete 🎉', body: `You both finished: ${questTitle(c.questId)}`, url: '#/challenges', tag: 'sq-challenge-' + c.id }, 'challenges').catch(() => {});
      } else {
        pushTo(other, { title: 'Your friend finished it', body: `${a.user.displayName} completed ${questTitle(c.questId)}. Your turn?`, url: '#/challenges', tag: 'sq-challenge-' + c.id }, 'challenges').catch(() => {});
      }
      persist();
    }
    send(res, 200, { challenge: chView(c, a.username) });
  });

  /* push subscriptions */
  route('POST', '/api/push/subscribe', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const b = await readBody(req, 4096);
    const s = b.subscription;
    if (!s?.endpoint || !s.keys?.p256dh || !s.keys?.auth || !endpointOk(s.endpoint))
      return send(res, 400, { error: 'Invalid push subscription.' });
    const rec = (db.push[a.username] ||= { subs: [], prefs: DEFAULT_PREFS, tzOffset: 0, sent: {} });
    rec.subs = rec.subs.filter((x) => x.endpoint !== s.endpoint);
    rec.subs.push({ endpoint: String(s.endpoint), keys: { p256dh: String(s.keys.p256dh), auth: String(s.keys.auth) } });
    rec.subs = rec.subs.slice(-5);
    rec.prefs = sanitizePrefs(b.prefs);
    rec.tzOffset = Math.max(-840, Math.min(840, parseInt(b.tzOffset, 10) || 0));
    persist();
    send(res, 200, { ok: true });
  });

  route('POST', '/api/push/prefs', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const b = await readBody(req, 2048);
    const rec = db.push[a.username];
    if (!rec) return send(res, 404, { error: 'No subscription on this account.' });
    rec.prefs = sanitizePrefs(b.prefs);
    rec.tzOffset = Math.max(-840, Math.min(840, parseInt(b.tzOffset, 10) || 0));
    persist();
    send(res, 200, { ok: true });
  });

  route('POST', '/api/push/unsubscribe', async (req, res) => {
    const a = authed(req);
    if (!a) return send(res, 401, { error: 'Not signed in.' });
    const b = await readBody(req, 2048);
    const rec = db.push[a.username];
    if (rec) {
      rec.subs = rec.subs.filter((x) => x.endpoint !== b.endpoint);
      if (!rec.subs.length) delete db.push[a.username];
      persist();
    }
    send(res, 200, { ok: true });
  });

  /* ---------- static ---------- */
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src https://fonts.gstatic.com; img-src 'self' https://images.unsplash.com data: blob:; connect-src 'self'; worker-src 'self'; " +
      "manifest-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  };

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
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

  const server = http.createServer(async (req, res) => {
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
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
      serveStatic(req, res, pathname);
    } catch (e) {
      send(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
    }
  });

  await new Promise((r) => server.listen(port, r));
  const actualPort = server.address().port;
  const tick = schedule ? setInterval(() => runScheduler().catch(() => {}), 60000) : null;
  tick?.unref();
  if (!quiet) console.log(`SideQuest running on http://localhost:${actualPort}`);

  return {
    server, port: actualPort, db, vapid, runScheduler, flush,
    close: async () => { clearInterval(tick); flush(); await new Promise((r) => server.close(r)); }
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  startServer();
}
