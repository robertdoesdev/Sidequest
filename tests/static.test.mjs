import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { backFor, parentOf, routeLabel, isProfileRoute } from '../nav.js';
import { buildActivity } from '../activity.js';
import { detectInstall } from '../install.js';
import { quests, allQuests } from '../data.js';

const read = (f) => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');

/* ---------- navigation ---------- */
test('nav: top-level tabs have no back link; deeper screens always have a fallback', () => {
  for (const r of ['/', '/discover', '/profile', '/progress']) assert.equal(backFor(r, '/friends'), null, r);
  for (const r of ['/daily', '/weird', '/me', '/my-quests', '/friends', '/activity', '/challenges', '/settings', '/account', '/showcase',
    '/challenge/new', '/challenge/new/ben', '/u/ana', '/quest/5', '/quest/5/active', '/quest/5/complete', '/quest/5/card']) {
    const b = backFor(r, null);                       // direct link / refresh: never a dead end
    assert.ok(b && b.href.startsWith('/') && b.label, r);
    assert.notEqual(b.href, r, 'back must not point at itself: ' + r);
  }
});

test('nav: profile sections go back to the Profile hub by default', () => {
  for (const r of ['/me', '/my-quests', '/friends', '/activity', '/challenges', '/settings', '/account'])
    assert.deepEqual(backFor(r, null), { href: '/profile', label: 'Profile', fromContext: false }, r);
});

test('nav: context is preserved when it makes sense', () => {
  assert.equal(backFor('/u/ana', '/friends').href, '/friends');           // public profile opened from Friends
  assert.equal(backFor('/u/ana', '/showcase').href, '/showcase');
  assert.equal(backFor('/u/ana', null).href, '/showcase');                // direct link
  assert.equal(backFor('/u/ana', '/u/ben').href, '/showcase');            // no profile-to-profile ping-pong
  assert.equal(backFor('/quest/5', '/daily').href, '/daily');
  assert.equal(backFor('/quest/5', '/u/ana').href, '/u/ana');
  assert.equal(backFor('/quest/5', null).href, '/discover');
  assert.equal(backFor('/quest/5', '/quest/6/active').href, '/discover'); // never back into a flow screen
  assert.equal(backFor('/showcase', '/profile').href, '/profile');
  assert.equal(backFor('/friends', '/u/ana').href, '/u/ana');
  assert.equal(backFor('/quest/5/card', '/quest/5/complete').href, '/quest/5/complete');
});

test('nav: a hostile previous-route value is ignored, never echoed', () => {
  for (const evil of ['/u/"><img src=x onerror=alert(1)>', 'javascript:alert(1)', '//evil.example', '/friends?x=<script>', 42, {}, '/' + 'a'.repeat(200)]) {
    const b = backFor('/u/ana', evil);
    assert.deepEqual(b, { href: '/showcase', label: 'Showcase', fromContext: false }, String(evil));
  }
});

test('nav: flow screens use fixed parents and never trap the user', () => {
  assert.equal(backFor('/quest/5/active', '/daily').href, '/quest/5');
  assert.equal(backFor('/quest/5/complete', '/quest/5/active').href, '/');
  assert.equal(backFor('/login', '/friends').href, '/');
  assert.equal(parentOf('/challenge/new/ben'), '/challenges');
});

test('nav: profile highlighting and labels', () => {
  ['/profile', '/progress', '/friends', '/activity', '/me', '/showcase', '/challenge/new'].forEach((r) => assert.ok(isProfileRoute(r), r));
  ['/', '/daily', '/discover', '/roll'].forEach((r) => assert.ok(!isProfileRoute(r), r));
  assert.equal(routeLabel('/u/ana'), '@ana');
});

/* ---------- avatars: code, migration and rollback must agree ---------- */
test('avatars: server list matches migration 002 exactly, and rollback restores the originals', () => {
  const app = read('lib/app.mjs');
  const m = /const AVATARS = \[([\s\S]*?)\];/.exec(app);
  const server = [...m[1].matchAll(/'([a-z]*)'/g)].map((x) => x[1]);
  const mig = read('migrations/002_more_avatars.sql');
  const inCheck = [...(/check \(avatar in \(([^)]*)\)\)/.exec(mig)[1]).matchAll(/'([a-z]*)'/g)].map((x) => x[1]);
  assert.deepEqual(inCheck, server);
  assert.ok(server.length >= 24 && new Set(server).size === server.length);
  const down = read('migrations/down/002_more_avatars.down.sql');
  assert.match(down, /'sun', 'bolt', 'leaf', 'wave', 'star', 'moon'\)\);/);
  const init = read('migrations/001_init.sql');
  assert.ok(['sun', 'bolt', 'leaf', 'wave', 'star', 'moon'].every((k) => init.includes(`'${k}'`)));
  // the client must have a glyph for every server avatar
  const client = read('app.js');
  for (const k of server.filter(Boolean)) assert.ok(new RegExp(`\\b${k}:\\s*'`).test(client), 'glyph for ' + k);
});

test('migrations: 002 is additive and the runner ignores the down folder', () => {
  const mig = read('migrations/002_more_avatars.sql');
  assert.ok(!/drop table|delete from|truncate/i.test(mig));
  assert.deepEqual(fs.readdirSync(new URL('../migrations', import.meta.url)).filter((x) => x.endsWith('.sql')).sort(), ['001_init.sql', '002_more_avatars.sql']);
});

test('server: friends respond demands a real boolean and checks blocks; static whitelist has the new modules', () => {
  const app = read('lib/app.mjs');
  assert.match(app, /typeof b\.accept !== 'boolean'/);
  assert.match(app, /blockedEither\(a\.id, them\.id\)\) return send\(res, 404, \{ error: 'No such request/);
  for (const f of ['nav.js', 'activity.js', 'install.js']) { assert.ok(app.includes(`'${f}'`), f); assert.ok(fs.existsSync(new URL('../' + f, import.meta.url))); }
  assert.match(read('vercel.json'), /nav\|activity\|install/);
});

/* ---------- activity: derived from real records only ---------- */
test('activity: no data means no highlights or events (nothing is invented)', () => {
  const a = buildActivity({ completed: [], questById: () => null, streak: 0, challenges: [], friends: [] });
  assert.deepEqual(a.events, []);
  assert.deepEqual(a.highlights, []);
  assert.equal(a.totals.quests, 0);
});

test('activity: counts match the records, newest first', () => {
  const now = Date.parse('2026-10-17T12:00:00Z');
  const q = (id) => quests.find((x) => x.id === id);
  const completed = [{ id: '1', date: now - 1000 }, { id: '2', date: now - 3 * 86400000 }, { id: '3', date: now - 20 * 86400000 }, { id: '999', date: now }];
  const chals = [
    { id: 1, questId: '4', status: 'completed', mine: 'sender', to: { username: 'ben' }, from: { username: 'me' }, youDoneAt: now - 5000, theyDoneAt: now - 4000, updated: now - 4000 },
    { id: 2, questId: '5', status: 'pending', mine: 'recipient', from: { username: 'cat' }, to: { username: 'me' }, created: now - 9000 }
  ];
  const a = buildActivity({ completed, questById: (id) => q(id) || null, streak: 3, challenges: chals, friends: [{}, {}], now });
  assert.equal(a.totals.quests, 3);                       // the unknown quest id 999 is ignored, not counted
  assert.equal(a.totals.friends, 2);
  assert.ok(a.events.every((e, i, arr) => !i || arr[i - 1].at >= e.at));
  assert.ok(a.highlights.some((h) => /3-day streak/.test(h.title)));
  assert.ok(a.highlights.some((h) => /2 quests this week/.test(h.title)));
  assert.ok(a.highlights.some((h) => /1 challenge won together/.test(h.title)));
  assert.ok(a.events.some((e) => /challenged you/.test(e.text)));
});

test('discover: search updates while typing and includes quest descriptions', () => {
  const app = read('app.js');
  assert.match(app, /document\.addEventListener\('input', \(e\) => \{\s*const search = e\.target\.closest\('#search'\)/);
  assert.match(app, /state\.discover = \{ \.\.\.\(state\.discover \|\| \{\}\), search: search\.value \}/);
  assert.match(app, /render\(\{ keepFocus: true \}\)/);
  assert.match(app, /\$\{q\.title\} \$\{q\.description\}/);
});

/* ---------- install ---------- */
test('install: only promises what the browser can do', () => {
  const iosSafari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  const iosChrome = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1';
  const desktop = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';
  assert.equal(detectInstall({ ua: iosSafari }).mode, 'ios-safari');
  assert.equal(detectInstall({ ua: iosChrome }).mode, 'ios-other');
  assert.equal(detectInstall({ ua: desktop }).mode, 'unsupported');
  assert.equal(detectInstall({ ua: desktop, hasPrompt: true }).mode, 'prompt');
  assert.equal(detectInstall({ ua: iosSafari, iosStandalone: true }).mode, 'installed');
  assert.equal(detectInstall({ ua: desktop, standalone: true, hasPrompt: true }).mode, 'installed');
});

/* ---------- quest catalogue guardrails ---------- */
test('catalogue: curated additions remain safe, varied and appended with stable ids', () => {
  const fresh = allQuests.slice(169, 226); // original V4 curation; retain its historical ID checks
  assert.ok(fresh.length >= 30);
  fresh.forEach((q, i) => assert.equal(q.id, String(170 + i)));
  assert.equal(new Set(allQuests.map((q) => q.title.toLowerCase())).size, allQuests.length);   // no duplicate titles
  const bad = /\b(strangers?\b.*\b(film|record|follow)|trespass|scare|prank|steal|touch|hug a stranger|private information|home address|password)\b/i;
  fresh.forEach((q) => assert.ok(!bad.test([q.title, q.description, ...q.steps].join(' ')), q.title));
  assert.ok(fresh.filter((q) => q.weirdness >= 2).length >= 15, 'mostly weird/absurd');
  assert.ok(new Set(fresh.map((q) => q.type)).size >= 4, 'varied types');
  assert.ok(fresh.filter((q) => q.socialLevel >= 1).every((q) => q.detail.notes.some((n) => /pressure/i.test(n))), 'consent note on social dares');
  assert.ok(fresh.every((q) => q.steps.length >= 3 && q.detail.mission));

  const imported = allQuests.slice(226);
  assert.equal(imported.length, 380);
  imported.forEach((q, i) => assert.equal(q.id, String(227 + i)));
  const unsafe = /trespass|break into|steal|stunt|drunk|alcohol|drug|knife|fire\b|climb (a|the) (roof|building|fence)|follow (a )?(stranger|someone)|prank (a )?stranger/i;
  imported.forEach((q) => assert.ok(!unsafe.test([q.title, q.description, ...q.steps].join(' ')), q.title));
  assert.ok(imported.filter((q) => q.socialLevel >= 1).every((q) => q.detail.notes.some((n) => /pressure/i.test(n))), 'consent note on social quests');
});
