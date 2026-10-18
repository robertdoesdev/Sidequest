import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer } from '../server.mjs';

process.env.CRON_SECRET = 'test-cron-secret';
process.env.SIDEQUEST_AUTH_IP_MAX = '1000';      // the per-IP limiter is tested separately below
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-'));
let S, base;
const call = async (p, { method = 'GET', body, token } = {}) => {
  const r = await fetch(base + p, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  let data = {};
  try { data = await r.json(); } catch {}
  return { status: r.status, data };
};
const signup = async (username, password = 'longenough1', displayName) => {
  const r = await call('/api/auth/signup', { method: 'POST', body: { username, password, displayName } });
  assert.equal(r.status, 201, `signup ${username}: ${JSON.stringify(r.data)}`);
  return r.data.token;
};
const post = (p, token, body = {}) => call(p, { method: 'POST', token, body });
const putState = (token, completed = [], extra = {}) => call('/api/state', { method: 'PUT', token, body: { state: { completed, ...extra } } });
const done = (id, date = Date.now()) => ({ id: String(id), date, reflection: 'Nailed it', surprise: 'PRIVATE-surprise', learned: 'PRIVATE-learned' });
const makeFriends = async (a, aName, b, bName) => {
  assert.equal((await post('/api/friends/request', a, { username: bName })).status, 201);
  assert.equal((await post('/api/friends/respond', b, { username: aName, accept: true })).status, 200);
};

test.before(async () => {
  S = await startServer({ port: 0, dataDir: tmp, allowInsecurePush: true, schedule: false, quiet: true });
  base = `http://127.0.0.1:${S.port}`;
});
test.after(async () => { await S.close(); });

test('health reports the database and push key; static whitelist blocks server files', async () => {
  const h = await call('/api/health');
  assert.equal(h.data.ok, true);
  assert.equal(h.data.db, 'pglite');
  assert.ok(h.data.push.publicKey.length > 80);
  for (const p of ['/server.mjs', '/lib/app.mjs', '/migrations/001_init.sql', '/data/db.json', '/../package.json', '/.env', '/tests/server.test.mjs'])
    assert.equal((await fetch(base + p)).status, 404, p);
  assert.equal((await fetch(base + '/index.html')).status, 200);
});

test('migrations are recorded and idempotent', async () => {
  const { migrate } = await import('../lib/db.mjs');
  assert.deepEqual(await migrate(S.db), []);
  assert.deepEqual((await S.db.query('select version from schema_migrations order by version')).map((r) => r.version), ['001_init.sql', '002_more_avatars.sql']);
  const rls = await S.db.query("select count(*)::int as n from pg_class where relkind = 'r' and relrowsecurity and relname in ('users','sessions','user_state','friendships','blocks','challenges','showcase_posts','reports','push_subscriptions','push_settings','rate_limits')");
  assert.equal(rls[0].n, 11);                                    // row-level security is on for every app table
});

let ana, ben, cat;
test('auth: validation, duplicates, wrong password, logout, expiry, rate limits', async () => {
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'A!', password: 'longenough' } })).status, 400);
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'ab', password: 'longenough' } })).status, 400);
  const short = await call('/api/auth/signup', { method: 'POST', body: { username: 'ana', password: 'short' } });
  assert.equal(short.status, 400);
  assert.equal(short.data.field, 'password');
  const a = await call('/api/auth/signup', { method: 'POST', body: { username: 'Ana', password: 'longenough1', displayName: 'Ana <b>' } });
  assert.equal(a.status, 201);
  assert.equal(a.data.user.displayName, 'Ana b');                // markup stripped
  assert.equal(a.data.user.username, 'ana');                     // normalised
  assert.ok(!JSON.stringify(a.data).match(/pass|salt|hash/i));   // credentials never leave the server
  ana = a.data.token;
  const dup = await call('/api/auth/signup', { method: 'POST', body: { username: 'ANA', password: 'longenough1' } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.field, 'username');
  ben = await signup('ben', 'longenough2', 'Ben');
  cat = await signup('cat', 'longenough3', 'Cat');

  const bad = await call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'nope-nope-nope' } });
  const none = await call('/api/auth/login', { method: 'POST', body: { username: 'ghost', password: 'nope-nope-nope' } });
  assert.equal(bad.status, 401);
  assert.equal(none.status, 401);
  assert.equal(bad.data.error, none.data.error);                 // no account enumeration
  const l = await call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'longenough1' } });
  assert.equal(l.status, 200);
  assert.equal((await call('/api/me', { token: l.data.token })).data.user.username, 'ana');
  assert.equal((await call('/api/me')).status, 401);
  assert.equal((await call('/api/me', { token: 'f'.repeat(64) })).status, 401);
  assert.equal((await call('/api/me', { token: 'not-a-token' })).status, 401);

  await post('/api/auth/logout', l.data.token);
  assert.equal((await call('/api/me', { token: l.data.token })).status, 401);   // logout really revokes it
  assert.equal((await call('/api/me', { token: ana })).status, 200);            // other sessions unaffected

  const l2 = await call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'longenough1' } });
  await S.db.query("update sessions set expires_at = now() - interval '1 minute' where token_hash = $1", [crypto.createHash('sha256').update(l2.data.token).digest('hex')]);
  assert.equal((await call('/api/me', { token: l2.data.token })).status, 401); // expired sessions are refused

  await signup('rate', 'longenough1');
  let last;
  for (let i = 0; i < 9; i++) last = await call('/api/auth/login', { method: 'POST', body: { username: 'rate', password: 'wrongwrongwrong' } });
  assert.equal(last.status, 429);                                              // brute force is throttled (DB-backed)
});

test('password change signs out other sessions and requires the current password', async () => {
  const t1 = await signup('pwuser', 'oldpassword1');
  const t2 = (await call('/api/auth/login', { method: 'POST', body: { username: 'pwuser', password: 'oldpassword1' } })).data.token;
  assert.equal((await post('/api/me/password', t1, { current: 'wrong-wrong', next: 'newpassword1' })).status, 403);
  assert.equal((await post('/api/me/password', t1, { current: 'oldpassword1', next: 'short' })).status, 400);
  assert.equal((await post('/api/me/password', t1, { current: 'oldpassword1', next: 'newpassword1' })).status, 200);
  assert.equal((await call('/api/me', { token: t1 })).status, 200);
  assert.equal((await call('/api/me', { token: t2 })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'pwuser', password: 'oldpassword1' } })).status, 401);
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'pwuser', password: 'newpassword1' } })).status, 200);
});

test('private state sync is sanitised, persisted and never public', async () => {
  const r = await call('/api/state', { method: 'PUT', token: ana, body: { state: {
    interests: ['Cooking', '<script>x</script>'], saved: ['1', '2', 'bogus'], onboarded: true,
    completed: [{ id: '1', date: 5, reflection: 'Nailed it', again: 'yes', surprise: 'secret note' }, { id: 'nope' }],
    evil: { huge: 'x'.repeat(1000) }
  } } });
  assert.equal(r.status, 200);
  const g = (await call('/api/state', { token: ana })).data.state;
  assert.deepEqual(g.saved, ['1', '2']);
  assert.equal(g.completed.length, 1);
  assert.equal(g.evil, undefined);
  assert.ok(!JSON.stringify(g).includes('<script>'));
  assert.equal((await call('/api/state', { token: ben })).data.state, null);    // each account sees only its own
  assert.equal((await call('/api/state')).status, 401);
  assert.equal((await call('/api/state', { method: 'PUT', body: { state: {} } })).status, 401);
  const oversize = await call('/api/state', { method: 'PUT', token: ana, body: { state: { pad: 'x'.repeat(400000) } } });
  assert.equal(oversize.status, 413);
});

test('reminder time is saved with the account and survives a fresh login', async () => {
  const put = await call('/api/state', { method: 'PUT', token: ana, body: { state: { notifPrefs: { daily: true, challenges: false, reminders: true, followups: true, time: '08:30', at: 1234 } } } });
  assert.equal(put.status, 200);
  const relog = await call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'longenough1' } });
  const got = (await call('/api/state', { token: relog.data.token })).data.state;
  assert.equal(got.notifPrefs.time, '08:30');
  assert.equal(got.notifPrefs.challenges, false);
  await call('/api/state', { method: 'PUT', token: ana, body: { state: { notifPrefs: { time: '25:99', at: 5 } } } });
  assert.equal((await call('/api/state', { token: ana })).data.state.notifPrefs.time, '10:00');   // junk falls back to the default
  await call('/api/state', { method: 'PUT', token: ana, body: { state: { notifPrefs: { time: '08:30', at: 1234 } } } });
});

test('profiles: public fields only, edits persist, privacy and authorisation', async () => {
  const bad = await call('/api/me', { method: 'PATCH', token: ana, body: { avatar: 'hacker' } });
  assert.equal(bad.status, 400);
  assert.equal((await call('/api/me', { method: 'PATCH', token: ana, body: { displayName: '   ' } })).status, 400);
  assert.equal((await call('/api/me', { method: 'PATCH', token: ana, body: {} })).status, 400);
  assert.equal((await call('/api/me', { method: 'PATCH' })).status, 401);
  const up = await call('/api/me', { method: 'PATCH', token: ana, body: { displayName: 'Ana A', bio: 'x'.repeat(400) + '<i>', avatar: 'sun' } });
  assert.equal(up.status, 200);
  assert.equal(up.data.user.bio.length, 160);                    // truncated, markup stripped
  assert.equal(up.data.user.avatar, 'sun');

  const pub = await call('/api/profiles/ana');                   // no auth needed for a public profile
  assert.equal(pub.status, 200);
  assert.deepEqual(Object.keys(pub.data.profile).sort(), ['avatar', 'bio', 'displayName', 'joined', 'profilePublic', 'stats', 'username']);
  assert.ok(!JSON.stringify(pub.data).match(/pass|salt|hash|email|"id"|token/i));
  assert.equal(pub.data.friendship, 'none');
  const relog = await call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'longenough1' } });
  assert.equal((await call('/api/me', { token: relog.data.token })).data.user.displayName, 'Ana A');   // persists across sessions
  assert.equal((await call('/api/profiles/ghost')).status, 404);
  assert.equal((await call('/api/profiles/ab')).status, 404);
  assert.equal((await call('/api/profiles/ana', { token: ana })).data.friendship, 'self');

  // private profile: hidden from everyone but its owner, and its posts disappear from the feed
  await call('/api/me', { method: 'PATCH', token: cat, body: { profilePublic: false, bio: 'secret bio' } });
  const priv = await call('/api/profiles/cat', { token: ben });
  assert.equal(priv.status, 403);
  assert.equal(priv.data.code, 'private');
  assert.ok(!JSON.stringify(priv.data).includes('secret bio'));
  assert.equal((await call('/api/profiles/cat/posts')).status, 403);
  assert.equal((await call('/api/profiles/cat', { token: cat })).status, 200);
  await call('/api/me', { method: 'PATCH', token: cat, body: { profilePublic: true } });
});

test('showcase: publish rules, idempotency, privacy, pagination, deletion', async () => {
  const dan = await signup('dan', 'longenough4', 'Dan');
  assert.equal((await post('/api/showcase', null, { questId: '1' })).status, 401);
  assert.equal((await post('/api/showcase', dan, { questId: 'zzz' })).status, 400);
  assert.equal((await post('/api/showcase', dan, { questId: '1' })).data.code, 'not_completed');     // can't publish what you haven't finished
  await putState(dan, [done(1), done(2), done(3), done(4), done(5)]);

  const first = await post('/api/showcase', dan, { questId: '1', note: 'So fun <b>' });
  assert.equal(first.status, 200);
  assert.equal(first.data.post.note, 'So fun b');
  const again = await post('/api/showcase', dan, { questId: '1', note: 'Edited' });                  // retry / double tap
  assert.equal(again.data.post.id, first.data.post.id);
  assert.equal((await S.db.query("select count(*)::int as n from showcase_posts p join users u on u.id = p.user_id where u.username = 'dan'"))[0].n, 1);
  for (const q of ['2', '3', '4', '5']) await post('/api/showcase', dan, { questId: q });

  const feed = await call('/api/showcase');                                                          // anonymous visitors can read the feed
  assert.equal(feed.status, 200);
  assert.equal(feed.data.posts[0].author.username, 'dan');
  assert.deepEqual(Object.keys(feed.data.posts[0].author).sort(), ['avatar', 'displayName', 'username']);
  const raw = JSON.stringify(feed.data);
  assert.ok(!raw.includes('PRIVATE-') && !raw.match(/pass|salt|hash|email|token/i));                 // private reflections never leak

  // pagination: limit 2 walks all five exactly once
  const ids = [];
  let cursor = null;
  for (let guard = 0; guard < 6; guard++) {
    const pg = await call(`/api/showcase?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
    ids.push(...pg.data.posts.map((p) => p.id));
    if (!pg.data.next) break;
    cursor = pg.data.next;
  }
  assert.equal(ids.length, 5);
  assert.equal(new Set(ids).size, 5);
  assert.deepEqual(ids, [...ids].sort((x, y) => y - x));                                             // newest first

  assert.equal((await call('/api/profiles/dan/posts?limit=3')).data.posts.length, 3);
  assert.equal((await call('/api/showcase?mine=1')).status, 401);
  assert.equal((await call('/api/showcase?mine=1', { token: dan })).data.posts.length, 5);
  assert.equal((await call('/api/showcase?mine=1', { token: ben })).data.posts.length, 0);

  // only the owner may delete
  assert.equal((await call(`/api/showcase/${first.data.post.id}`, { method: 'DELETE', token: ben })).status, 404);
  assert.equal((await call(`/api/showcase/${first.data.post.id}`, { method: 'DELETE' })).status, 401);
  assert.equal((await S.db.query('select 1 from showcase_posts where id = $1', [first.data.post.id])).length, 1);
  assert.equal((await call(`/api/showcase/${first.data.post.id}`, { method: 'DELETE', token: dan })).status, 200);
  assert.equal((await call(`/api/showcase/${first.data.post.id}`, { method: 'DELETE', token: dan })).status, 404);

  // a private profile can't publish and its existing posts vanish from the feed
  await call('/api/me', { method: 'PATCH', token: dan, body: { profilePublic: false } });
  assert.equal((await post('/api/showcase', dan, { questId: '1' })).data.code, 'private');
  assert.equal((await call('/api/showcase?limit=30')).data.posts.filter((p) => p.author.username === 'dan').length, 0);
  await call('/api/me', { method: 'PATCH', token: dan, body: { profilePublic: true } });
  assert.ok((await call('/api/showcase?limit=30')).data.posts.some((p) => p.author.username === 'dan'));

  // deleting the account removes its posts
  assert.equal((await call('/api/me', { method: 'DELETE', token: dan, body: { password: 'longenough4' } })).status, 200);
  assert.equal((await call('/api/showcase?limit=30')).data.posts.filter((p) => p.author.username === 'dan').length, 0);
  assert.equal((await call('/api/profiles/dan')).status, 404);
});

test('friends: lifecycle, states, duplicate/self guards and authorisation', async () => {
  assert.equal((await call('/api/friends')).status, 401);
  assert.equal((await post('/api/friends/request', ana, { username: 'ana' })).status, 400);
  assert.equal((await post('/api/friends/request', ana, { username: 'nobody1' })).status, 404);
  assert.equal((await post('/api/friends/request', ana, { username: '../etc' })).status, 404);
  assert.equal((await post('/api/friends/request', ana, { username: '@ben' })).status, 201);
  assert.equal((await post('/api/friends/request', ana, { username: 'ben' })).status, 409);           // duplicate
  // ben asks ana back: mutual requests merge into an acceptance instead of creating a duplicate
  const mutual = await post('/api/friends/request', ben, { username: 'ana' });
  assert.equal(mutual.status, 200);
  assert.equal(mutual.data.status, 'accepted');
  const af = (await call('/api/friends', { token: ana })).data;
  assert.deepEqual(af.friends.map((f) => f.username), ['ben']);
  assert.equal((await post('/api/friends/request', ana, { username: 'ben' })).status, 409);           // already friends
  assert.equal((await call('/api/profiles/ben', { token: ana })).data.friendship, 'friends');

  // authorisation on a separate pending request: ana -> cat
  assert.equal((await post('/api/friends/request', ana, { username: 'cat' })).status, 201);
  assert.equal((await call('/api/profiles/cat', { token: ana })).data.friendship, 'outgoing');
  assert.equal((await call('/api/profiles/ana', { token: cat })).data.friendship, 'incoming');
  assert.deepEqual((await call('/api/friends', { token: cat })).data.incoming.map((f) => f.username), ['ana']);
  assert.deepEqual((await call('/api/friends', { token: ana })).data.outgoing.map((f) => f.username), ['cat']);
  const mallory = await signup('mallory', 'longenough5');
  assert.equal((await post('/api/friends/respond', mallory, { username: 'ana', accept: true })).status, 404);   // third party
  assert.equal((await post('/api/friends/respond', mallory, { username: 'cat', accept: true })).status, 404);
  assert.equal((await post('/api/friends/respond', ana, { username: 'cat', accept: true })).status, 404);       // requester can't accept own request
  assert.equal((await post('/api/friends/cancel', cat, { username: 'ana' })).status, 404);                       // recipient can't "cancel"
  assert.equal((await call('/api/friends/ana', { method: 'DELETE', token: mallory })).status, 404);
  assert.equal((await call('/api/friends/cat', { method: 'DELETE', token: ana })).status, 404);                 // pending is not a friendship
  assert.equal((await post('/api/friends/cancel', ana, { username: 'cat' })).status, 200);
  assert.equal((await call('/api/friends', { token: cat })).data.incoming.length, 0);
  // reject path
  await post('/api/friends/request', ana, { username: 'cat' });
  assert.equal((await post('/api/friends/respond', cat, { username: 'ana', accept: false })).status, 200);
  assert.equal((await call('/api/friends', { token: ana })).data.outgoing.length, 0);
  // accept path then removal
  await post('/api/friends/request', cat, { username: 'ana' });
  assert.equal((await post('/api/friends/respond', ana, { username: 'cat', accept: true })).status, 200);
  assert.equal((await post('/api/friends/respond', ana, { username: 'cat', accept: true })).status, 404);       // replay
  assert.equal((await call('/api/friends/cat', { method: 'DELETE', token: ana })).status, 200);
  assert.equal((await call('/api/friends', { token: cat })).data.friends.length, 0);
  assert.equal((await S.db.query('select 1 from friendships f join users u on u.id = f.user_a where u.username = $1', ['mallory'])).length, 0);
});

test('friends: respond needs a real boolean, rejects stale/foreign requests, and a rejected request can be re-sent', async () => {
  const dora = await signup('dora', 'longenough6'); const eli = await signup('eli', 'longenough7'); const fay = await signup('fay', 'longenough8');
  assert.equal((await post('/api/friends/request', dora, { username: 'eli' })).status, 201);
  // "false" (a string) is truthy in JS: it must be refused, never treated as an accept
  assert.equal((await post('/api/friends/respond', eli, { username: 'dora', accept: 'false' })).status, 400);
  assert.equal((await post('/api/friends/respond', eli, { username: 'dora' })).status, 400);
  assert.equal((await post('/api/friends/respond', eli, { username: 'dora', accept: 1 })).status, 400);
  assert.equal((await call('/api/friends', { token: eli })).data.incoming.length, 1);           // nothing changed
  // sender and a bystander can't answer; unknown / self usernames are plain 404s
  assert.equal((await post('/api/friends/respond', dora, { username: 'eli', accept: true })).status, 404);
  assert.equal((await post('/api/friends/respond', fay, { username: 'dora', accept: true })).status, 404);
  assert.equal((await post('/api/friends/respond', eli, { username: 'nobody1', accept: true })).status, 404);
  assert.equal((await post('/api/friends/respond', eli, { username: 'eli', accept: true })).status, 404);
  assert.equal((await call('/api/friends/respond', { method: 'POST', body: { username: 'dora', accept: true } })).status, 401);
  // reject, then a repeated reject / accept is a harmless 404
  assert.equal((await post('/api/friends/respond', eli, { username: 'dora', accept: false })).status, 200);
  assert.equal((await post('/api/friends/respond', eli, { username: 'dora', accept: false })).status, 404);
  assert.equal((await post('/api/friends/respond', eli, { username: 'dora', accept: true })).status, 404);
  assert.equal((await call('/api/friends', { token: eli })).data.friends.length, 0);
  // policy: after a rejection the same person may ask again (rate limit only), but never twice at once
  assert.equal((await post('/api/friends/request', dora, { username: 'eli' })).status, 201);
  assert.equal((await post('/api/friends/request', dora, { username: 'eli' })).status, 409);
  assert.equal((await call('/api/friends', { token: eli })).data.incoming.length, 1);
  // a block hides the pending request from the person who blocked
  assert.equal((await post('/api/blocks', eli, { username: 'dora' })).status, 200);
  assert.equal((await post('/api/friends/respond', eli, { username: 'dora', accept: true })).status, 404);
  assert.equal((await S.db.query("select 1 from friendships f join users u on u.id = f.user_a or u.id = f.user_b where u.username = 'eli' and f.status = 'accepted'")).length, 0);
});

test('avatars: the expanded set is accepted, unknown values are not, and the database constraint matches', async () => {
  const gus = await signup('gus', 'longenough9');
  for (const av of ['fox', 'ufo', 'dino', 'sun', '']) {
    const r = await call('/api/me', { method: 'PATCH', token: gus, body: { avatar: av } });
    assert.equal(r.status, 200, av); assert.equal(r.data.user.avatar, av);
  }
  assert.equal((await call('/api/me', { method: 'PATCH', token: gus, body: { avatar: 'hacker' } })).status, 400);
  assert.equal((await call('/api/me', { method: 'PATCH', token: gus, body: { avatar: '<b>' } })).status, 400);
  // the database itself refuses values outside the list, even if the API were bypassed
  await assert.rejects(() => S.db.query("update users set avatar = 'nope' where username = 'gus'"));
  const pub = await call('/api/profiles/gus', { token: gus });
  assert.equal(pub.status, 200);
});

test('blocking removes the friendship, hides both users and can be undone; reports are stored', async () => {
  const eve = await signup('eve', 'longenough6', 'Eve');
  await makeFriends(ana, 'ana', eve, 'eve');
  assert.equal((await post('/api/blocks', ana, { username: 'ana' })).status, 400);
  assert.equal((await post('/api/blocks', ana, { username: 'ghost1' })).status, 404);
  assert.equal((await post('/api/blocks', ana, { username: 'eve' })).status, 200);
  assert.ok(!(await call('/api/friends', { token: ana })).data.friends.some((f) => f.username === 'eve'));
  assert.equal((await call('/api/friends', { token: eve })).data.friends.length, 0);
  assert.equal((await call('/api/profiles/ana', { token: eve })).status, 404);                              // looks like she doesn't exist
  assert.equal((await post('/api/friends/request', eve, { username: 'ana' })).status, 404);
  assert.deepEqual((await call('/api/blocks', { token: ana })).data.blocked.map((b) => b.username), ['eve']);
  assert.equal((await call('/api/blocks/eve', { method: 'DELETE', token: ana })).status, 200);
  assert.equal((await call('/api/profiles/ana', { token: eve })).status, 200);

  assert.equal((await post('/api/report', eve, { username: 'ana', reason: 'testing <b>' })).status, 201);
  assert.equal((await post('/api/report', eve, { username: 'eve' })).status, 404);
  assert.equal((await post('/api/report', null, { username: 'ana' })).status, 401);
  assert.equal((await S.db.query("select reason from reports"))[0].reason, 'testing b');
});

test('challenges: lifecycle, state machine, expiry and authorisation', async () => {
  const testSuffix = crypto.randomBytes(3).toString('hex');
  const gusName = 'gus' + testSuffix;
  const halName = 'hal' + testSuffix;
  const ivyName = 'ivy' + testSuffix;
  const gus = await signup(gusName, 'longenough7', 'Gus');
  const hal = await signup(halName, 'longenough8', 'Hal');
  const ivy = await signup(ivyName, 'longenough9', 'Ivy');
  await makeFriends(gus, gusName, hal, halName);

  assert.equal((await call('/api/challenges')).status, 401);
  assert.equal((await post('/api/challenges', gus, { to: ivyName, questId: '3' })).status, 403);           // not friends
  assert.equal((await post('/api/challenges', gus, { to: halName, questId: 'zzz' })).status, 400);
  assert.equal((await post('/api/challenges', gus, { to: 'ghost1', questId: '3' })).status, 403);
  const c = await post('/api/challenges', gus, { to: halName, questId: '3', message: 'Bet you canâ€™t <b>' });
  assert.equal(c.status, 201);
  assert.equal(c.data.challenge.message, 'Bet you canâ€™t b');
  const id = c.data.challenge.id;
  assert.equal((await post('/api/challenges', gus, { to: halName, questId: '3' })).status, 409);           // duplicate
  assert.equal((await call('/api/challenges', { token: hal })).data.waiting, 1);

  // outsiders and the wrong side can't touch it
  for (const who of [ivy, gus]) assert.equal((await post(`/api/challenges/${id}/respond`, who, { accept: true })).status, 404);
  for (const act of ['complete', 'cancel']) assert.equal((await post(`/api/challenges/${id}/${act}`, ivy)).status, 404);
  assert.equal((await call('/api/challenges', { token: ivy })).data.challenges.length, 0);
  assert.equal((await post(`/api/challenges/${id}/complete`, hal)).status, 404);                          // still pending: can't complete
  assert.equal((await post(`/api/challenges/${id}/cancel`, hal)).status, 404);                            // recipient can't cancel (can decline)

  assert.equal((await post(`/api/challenges/${id}/respond`, hal, { accept: true })).data.challenge.status, 'accepted');
  assert.equal((await post(`/api/challenges/${id}/respond`, hal, { accept: false })).status, 404);        // can't flip a decision

  // results can't be forged: completion must exist in the synced progress and postdate the challenge
  assert.equal((await post(`/api/challenges/${id}/complete`, gus)).data.code, 'not_completed');
  await putState(gus, [done(3, Date.now() - 3 * 86400000)]);
  assert.equal((await post(`/api/challenges/${id}/complete`, gus)).status, 409);
  await putState(gus, [done(3)]);
  const g1 = await post(`/api/challenges/${id}/complete`, gus);
  assert.equal(g1.data.challenge.youDone, true);
  assert.equal(g1.data.challenge.theyDone, false);
  assert.equal(g1.data.challenge.status, 'accepted');
  const g2 = await post(`/api/challenges/${id}/complete`, gus);                                           // duplicate completion is a no-op
  assert.equal(g2.data.challenge.youDoneAt, g1.data.challenge.youDoneAt);
  await putState(hal, [done(3)]);
  const h1 = await post(`/api/challenges/${id}/complete`, hal);
  assert.equal(h1.data.challenge.status, 'completed');
  assert.equal(h1.data.challenge.theyDone, true);
  assert.equal((await call('/api/challenges', { token: gus })).data.challenges[0].status, 'completed');
  assert.equal((await post(`/api/challenges/${id}/cancel`, gus)).status, 404);                            // finished challenges are final

  // decline + cancel + expiry
  const c2 = (await post('/api/challenges', gus, { to: halName, questId: '4' })).data.challenge;
  assert.equal((await post(`/api/challenges/${c2.id}/respond`, hal, { accept: false })).data.challenge.status, 'declined');
  const c3 = (await post('/api/challenges', gus, { to: halName, questId: '5' })).data.challenge;
  assert.equal((await post(`/api/challenges/${c3.id}/cancel`, gus)).data.challenge.status, 'cancelled');
  assert.equal((await post(`/api/challenges/${c3.id}/respond`, hal, { accept: true })).status, 404);
  const c4 = (await post('/api/challenges', gus, { to: halName, questId: '6' })).data.challenge;
  await S.db.query("update challenges set expires_at = now() - interval '1 hour' where id = $1", [c4.id]);
  assert.equal((await post(`/api/challenges/${c4.id}/respond`, hal, { accept: true })).status, 404);      // expired
  assert.equal((await call('/api/challenges', { token: gus })).data.challenges.find((x) => x.id === c4.id).status, 'expired');

  // removing the friend cancels open challenges but keeps finished results
  const c5 = (await post('/api/challenges', gus, { to: halName, questId: '7' })).data.challenge;
  await call(`/api/friends/${halName}`, { method: 'DELETE', token: gus });
  const after = (await call('/api/challenges', { token: gus })).data.challenges;
  assert.equal(after.find((x) => x.id === c5.id).status, 'cancelled');
  assert.equal(after.find((x) => x.id === id).status, 'completed');
});

test('legacy db.json accounts import with working passwords, without overwriting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-legacy-'));
  const salt = 'ab'.repeat(8);
  const hash = crypto.scryptSync('legacy-password', salt, 64).toString('hex');
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({
    users: {
      oldie: { username: 'oldie', displayName: 'Old Timer', pass: { salt, hash }, created: 1600000000000, state: { v: 2, completed: [{ id: '1', date: 5 }] }, stateAt: 7 },
      pal: { username: 'pal', displayName: 'Pal', pass: { salt, hash }, created: 1600000000001 }
    },
    friends: { 'oldie|pal': { a: 'oldie', b: 'pal', from: 'pal', status: 'accepted', t: 1 } },
    challenges: { '0123456789abcdef': { id: '0123456789abcdef', from: 'oldie', to: 'pal', questId: '2', message: 'hi', status: 'pending', fromDone: 0, toDone: 0, created: 1, updated: 2 } },
    sessions: {}, push: {}
  }));
const run = () => spawnSync(process.execPath, ['scripts/import-json.mjs'], {
  env: { ...process.env, SIDEQUEST_DATA: dir, DATABASE_URL: '' },
  encoding: 'utf8',
});

const clean = (output) => output.replace(/\u001b\[[0-9;]*m/g, '');

const r1 = run();
assert.equal(r1.status, 0, r1.stderr);
assert.match(clean(r1.stdout), /users: 2/);

const r2 = run();
assert.equal(r2.status, 0, r2.stderr);
assert.match(clean(r2.stdout), /users: 0/); // re-run adds nothing

const S2 = await startServer({
  port: 0,
  dataDir: dir,
  schedule: false,
  quiet: true,
});

const b2 = `http://127.0.0.1:${S2.port}`;
const login = await (
  await fetch(b2 + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'oldie',
      password: 'legacy-password',
    }),
  })
).json();

assert.ok(login.token, 'legacy password still works');
  const st = await (await fetch(b2 + '/api/state', { headers: { Authorization: `Bearer ${login.token}` } })).json();
  assert.equal(st.state.completed[0].id, '1');
  const fr = await (await fetch(b2 + '/api/friends', { headers: { Authorization: `Bearer ${login.token}` } })).json();
  assert.deepEqual(fr.friends.map((f) => f.username), ['pal']);
  const ch = await (await fetch(b2 + '/api/challenges', { headers: { Authorization: `Bearer ${login.token}` } })).json();
  assert.equal(ch.challenges[0].id, '0123456789abcdef');
  await S2.close();
});

test('signup is throttled per IP (default limit)', async () => {
  const saved = process.env.SIDEQUEST_AUTH_IP_MAX;
  delete process.env.SIDEQUEST_AUTH_IP_MAX;
  const S3 = await startServer({ port: 0, memory: true, schedule: false, quiet: true });
  process.env.SIDEQUEST_AUTH_IP_MAX = saved;
  const b3 = `http://127.0.0.1:${S3.port}`;
  let last = 0;
  for (let i = 0; i < 22; i++) {
    last = (await fetch(b3 + '/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'u' + i + 'xx', password: 'longenough1' }) })).status;
  }
  assert.equal(last, 429);
  await S3.close();
});

test('cron endpoint requires the shared secret', async () => {
  assert.equal((await call('/api/cron/push')).status, 401);
  assert.equal((await call('/api/cron/push', { token: 'x'.repeat(64) })).status, 401);
  const r = await fetch(base + '/api/cron/push', { headers: { Authorization: 'Bearer test-cron-secret' } });
  assert.equal(r.status, 200);
});

test('unknown routes and bad JSON fail cleanly', async () => {
  assert.equal((await call('/api/nope')).status, 404);
  const r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{not json' });
  assert.equal(r.status, 400);
});

function decryptAes128gcm(body, uaEcdh, authSecret) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const ct = body.subarray(21 + idlen);
  const uaPublic = uaEcdh.getPublicKey();
  const shared = uaEcdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2);
  return plain.subarray(0, plain.length - 1).toString();
}


test('web push: setup accounts', async () => {
  globalThis.__pam = await signup('pam', 'longenough1', 'Pam');
  globalThis.__quin = await signup('quin', 'longenough2', 'Quin');
});

test('web push: encrypted delivery, VAPID header, scheduler caps', async () => {
  const pam = globalThis.__pam, quin = globalThis.__quin;
  const received = [];
  const fake = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { received.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(201); res.end(); });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const endpoint = `http://127.0.0.1:${fake.address().port}/push/abc`;

  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const authSecret = crypto.randomBytes(16);
  const sub = { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: authSecret.toString('base64url') } };

  assert.equal((await call('/api/push/subscribe', { method: 'POST', token: quin, body: { subscription: { ...sub, endpoint: 'https://evil.example/x' } } })).status, 400); // SSRF guard
  assert.equal((await call('/api/push/subscribe', { method: 'POST', token: quin, body: { subscription: sub, tzOffset: 0, prefs: { enabled: true, daily: true, time: '10:00' } } })).status, 200);

  // friend request triggers a push to ben
  await call('/api/friends/request', { method: 'POST', token: pam, body: { username: 'quin' } });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.length, 1);
  const msg = JSON.parse(decryptAes128gcm(received[0].body, ua, authSecret));
  assert.equal(msg.title, 'New friend request');
  assert.match(received[0].headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
  assert.equal(received[0].headers['content-encoding'], 'aes128gcm');

  // VAPID signature verifies against the advertised public key
  const [, t, k] = /^vapid t=([^,]+), k=(.+)$/.exec(received[0].headers.authorization);
  const [h, p, sig] = t.split('.');
  const raw = Buffer.from(k, 'base64url');
  const pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: raw.subarray(1, 33).toString('base64url'), y: raw.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));

  // scheduler: quiet hours -> nothing; 10:30 -> one daily push; second tick same day -> none
  received.length = 0;
  const day = Date.UTC(2026, 9, 5);
  assert.equal(await S.runScheduler(day + 3 * 3600000), 0);          // 03:00 quiet
  assert.equal(await S.runScheduler(day + 10.5 * 3600000), 1);       // 10:30 daily
  assert.equal(await S.runScheduler(day + 11 * 3600000), 0);         // already sent today
  assert.equal(await S.runScheduler(day + 15 * 3600000), 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received.length, 1);
  assert.equal(JSON.parse(decryptAes128gcm(received[0].body, ua, authSecret)).title, 'Your SideQuest for today');

  // follow-up next day after a completion yesterday, only one push/day
  received.length = 0;
  await call('/api/state', { method: 'PUT', token: quin, body: { state: { completed: [{ id: '5', date: day + 12 * 3600000 }] } } });
  assert.equal(await S.runScheduler(day + 86400000 + 10.5 * 3600000), 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.parse(decryptAes128gcm(received[0].body, ua, authSecret)).title, 'Ready for another?');

  // disabled prefs => silence
  await call('/api/push/prefs', { method: 'POST', token: quin, body: { prefs: { enabled: false } } });
  assert.equal(await S.runScheduler(day + 3 * 86400000 + 10.5 * 3600000), 0);

  // account deletion removes everything
  assert.equal((await call('/api/me', { method: 'DELETE', token: quin, body: { password: 'wrong' } })).status, 403);
  assert.equal((await call('/api/me', { method: 'DELETE', token: quin, body: { password: 'longenough2' } })).status, 200);
  assert.equal((await S.db.query('select 1 from push_settings')).length, 0);
  assert.equal((await S.db.query("select 1 from users where username = 'quin'")).length, 0);
  fake.close();
});
