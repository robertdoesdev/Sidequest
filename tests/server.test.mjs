import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../server.mjs';

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

test.before(async () => {
  S = await startServer({ port: 0, dataDir: tmp, allowInsecurePush: true, schedule: false, quiet: true });
  base = `http://127.0.0.1:${S.port}`;
});
test.after(async () => { await S.close(); });

test('health exposes push key; static whitelist blocks server files', async () => {
  const h = await call('/api/health');
  assert.equal(h.data.ok, true);
  assert.ok(h.data.push.publicKey.length > 80);
  assert.equal((await fetch(base + '/server.mjs')).status, 404);
  assert.equal((await fetch(base + '/data/db.json')).status, 404);
  assert.equal((await fetch(base + '/../package.json')).status, 404);
  assert.equal((await fetch(base + '/index.html')).status, 200);
});

let ana, ben;
test('signup / login / validation / logout', async () => {
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'A!', password: 'longenough' } })).status, 400);
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'ana', password: 'short' } })).status, 400);
  const a = await call('/api/auth/signup', { method: 'POST', body: { username: 'Ana', password: 'longenough1', displayName: 'Ana <b>' } });
  assert.equal(a.status, 201);
  assert.equal(a.data.user.displayName, 'Ana b');           // markup stripped
  ana = a.data.token;
  assert.equal((await call('/api/auth/signup', { method: 'POST', body: { username: 'ana', password: 'longenough1' } })).status, 409);
  ben = (await call('/api/auth/signup', { method: 'POST', body: { username: 'ben', password: 'longenough2' } })).data.token;
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'nope' } })).status, 401);
  const l = await call('/api/auth/login', { method: 'POST', body: { username: 'ana', password: 'longenough1' } });
  assert.equal(l.status, 200);
  assert.equal((await call('/api/me', { token: l.data.token })).data.user.username, 'ana');
  await call('/api/auth/logout', { method: 'POST', token: l.data.token });
  assert.equal((await call('/api/me', { token: l.data.token })).status, 401);
  assert.equal((await call('/api/state')).status, 401);
});

test('state sync is sanitised and persisted', async () => {
  const put = await call('/api/state', { method: 'PUT', token: ana, body: { state: {
    interests: ['Drawing', '<script>'], saved: ['3', '99999', 'x'], completed: [{ id: '1', date: 5, learned: 'hi<b>', again: 'bogus' }, { id: 'nope' }],
    onboarded: true, evil: { a: 1 }, dailyDone: { '2026-01-02': '5', junk: 'x' }
  } } });
  assert.equal(put.status, 200);
  const got = (await call('/api/state', { token: ana })).data.state;
  assert.deepEqual(got.saved, ['3']);
  assert.equal(got.completed.length, 1);
  assert.equal(got.completed[0].learned, 'hib');
  assert.equal(got.completed[0].again, '');
  assert.equal(got.evil, undefined);
  assert.deepEqual(Object.keys(got.dailyDone), ['2026-01-02']);
  assert.equal(got.interests.includes('<script>'), false);
  assert.equal((await call('/api/state', { method: 'PUT', token: ana, body: { state: { pad: 'x'.repeat(300000) } } })).status, 413);
});

test('friends + challenge lifecycle', async () => {
  assert.equal((await call('/api/challenges', { method: 'POST', token: ana, body: { to: 'ben', questId: '5' } })).status, 403); // not friends
  assert.equal((await call('/api/friends/request', { method: 'POST', token: ana, body: { username: 'nobody' } })).status, 404);
  assert.equal((await call('/api/friends/request', { method: 'POST', token: ana, body: { username: 'ben' } })).status, 201);
  assert.equal((await call('/api/friends', { token: ben })).data.incoming[0].username, 'ana');
  assert.equal((await call('/api/friends/respond', { method: 'POST', token: ben, body: { username: 'ana', accept: true } })).status, 200);
  assert.equal((await call('/api/friends', { token: ana })).data.friends[0].username, 'ben');

  const c = await call('/api/challenges', { method: 'POST', token: ana, body: { to: 'ben', questId: '45', message: 'you got this' } });
  assert.equal(c.status, 201);
  const id = c.data.challenge.id;
  assert.equal((await call('/api/challenges', { method: 'POST', token: ana, body: { to: 'ben', questId: '45' } })).status, 409);
  assert.equal((await call('/api/challenges', { token: ben })).data.waiting, 1);
  assert.equal((await call(`/api/challenges/${id}/complete`, { method: 'POST', token: ana })).status, 404); // not accepted yet
  assert.equal((await call(`/api/challenges/${id}/respond`, { method: 'POST', token: ana, body: { accept: true } })).status, 404); // sender can't accept
  assert.equal((await call(`/api/challenges/${id}/respond`, { method: 'POST', token: ben, body: { accept: true } })).data.challenge.status, 'accepted');
  const a1 = await call(`/api/challenges/${id}/complete`, { method: 'POST', token: ana });
  assert.equal(a1.data.challenge.status, 'accepted');
  assert.equal(a1.data.challenge.youDone, true);
  const b1 = await call(`/api/challenges/${id}/complete`, { method: 'POST', token: ben });
  assert.equal(b1.data.challenge.status, 'completed');
  assert.equal((await call('/api/friends/ana', { method: 'DELETE', token: ben })).status, 200);
});

/* ---- real Web Push round trip against a local fake push service ---- */
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

test('web push: encrypted delivery, VAPID header, scheduler caps', async () => {
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

  assert.equal((await call('/api/push/subscribe', { method: 'POST', token: ben, body: { subscription: { ...sub, endpoint: 'https://evil.example/x' } } })).status, 400); // SSRF guard
  assert.equal((await call('/api/push/subscribe', { method: 'POST', token: ben, body: { subscription: sub, tzOffset: 0, prefs: { enabled: true, daily: true, time: '10:00' } } })).status, 200);

  // friend request triggers a push to ben
  await call('/api/friends/request', { method: 'POST', token: ana, body: { username: 'ben' } });
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
  await call('/api/state', { method: 'PUT', token: ben, body: { state: { completed: [{ id: '5', date: day + 12 * 3600000 }] } } });
  assert.equal(await S.runScheduler(day + 86400000 + 10.5 * 3600000), 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(JSON.parse(decryptAes128gcm(received[0].body, ua, authSecret)).title, 'Ready for another?');

  // disabled prefs => silence
  await call('/api/push/prefs', { method: 'POST', token: ben, body: { prefs: { enabled: false } } });
  assert.equal(await S.runScheduler(day + 3 * 86400000 + 10.5 * 3600000), 0);

  // account deletion removes everything
  assert.equal((await call('/api/me', { method: 'DELETE', token: ben, body: { password: 'wrong' } })).status, 403);
  assert.equal((await call('/api/me', { method: 'DELETE', token: ben, body: { password: 'longenough2' } })).status, 200);
  assert.equal(S.db.push.ben, undefined);
  fake.close();
});
