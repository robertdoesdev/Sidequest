import test from 'node:test';
import assert from 'node:assert/strict';
import { quests, QUEST_TYPES, ENVIRONMENTS, timeBucket } from '../data.js';
import { dailyPick, dailyMood, DAILY_TYPES, rollPick, boredPick, weirdPick, pickedForYou, somethingDifferent, seeded } from '../recommend.js';
import { mergeStates } from '../cloud.js';

const blank = () => ({ interests: [], saved: [], completed: [], revealed: [], skipped: [], dailyDone: {}, stamps: { saved: {}, interests: {} } });
const types = new Set(QUEST_TYPES.map((t) => t.id));

test('quest data integrity', () => {
  assert.ok(quests.length >= 120);
  quests.forEach((q, i) => {
    assert.equal(q.id, String(i + 1));
    assert.ok(types.has(q.type), q.id);
    assert.ok(ENVIRONMENTS[q.environment], q.id);
    assert.ok(q.steps.length >= 3 && q.detail.mission && q.detail.complete && q.detail.where, q.id);
    assert.ok(q.vibes && Array.isArray(q.vibes));
    if (q.socialLevel >= 1) assert.ok(q.detail.notes.some((n) => /pressure/i.test(n)), 'boundaries ' + q.id);
    if (q.nearby) assert.ok(q.detail.notes.some((n) => /surroundings/.test(n)), 'outside safety ' + q.id);
    if (q.mystery) assert.equal(q.mystery.teaser.length, 3);
  });
  QUEST_TYPES.forEach((t) => assert.ok(quests.some((q) => q.type === t.id), 'type used ' + t.id));
  ['5', '10', '30', '60'].forEach((b) => assert.ok(quests.some((q) => timeBucket(q) === b), 'bucket ' + b));
});

test('safety: nothing in the library is risky', () => {
  const bad = /trespass|break into|steal|stunt|drunk|alcohol|drug|knife|fire\b|climb (a|the) (roof|building|fence)|follow (a )?(stranger|someone)|prank (a )?stranger/i;
  quests.forEach((q) => assert.ok(!bad.test([q.title, q.description, q.steps.join(' ')].join(' ')), q.id + ' ' + q.title));
});

test('daily is deterministic, rotates mood, varies on skip', () => {
  const s = blank();
  assert.equal(dailyPick(s, '2026-10-03', 0).quest.id, dailyPick(s, '2026-10-03', 0).quest.id);
  const DAY = 86400000, N = DAILY_TYPES.length;
  const key = (i) => new Date(i * DAY).toISOString().slice(0, 10);
  const start = Math.floor(Date.parse('2026-11-01') / DAY / N) * N;   // a cycle boundary
  const seen = new Set();
  for (let i = 0; i < N; i++) seen.add(dailyMood(key(start + i)));
  assert.equal(seen.size, N);                                        // every mood once per cycle
  for (let i = start - 400; i < start + 400; i++) assert.notEqual(dailyMood(key(i)), dailyMood(key(i + 1)), 'no back-to-back ' + key(i));
  const first = dailyPick(s, '2026-10-03', 0);
  const second = dailyPick(s, '2026-10-03', 1, [first.quest.id]);
  assert.notEqual(first.quest.id, second.quest.id);
  assert.ok(!first.quest.mystery);
  const deviceA = dailyPick(s, '2026-10-03', 0, [], 'device-a').quest.id;
  const deviceB = dailyPick(s, '2026-10-03', 0, [], 'device-b').quest.id;
  assert.notEqual(deviceA, deviceB);
});

test('recommendations avoid completed, respect time/vibe, mix in serendipity', () => {
  const s = blank();
  s.interests = ['Drawing', 'Music'];
  s.completed = quests.slice(0, 30).map((q) => ({ id: q.id, date: 1 }));
  for (let i = 0; i < 40; i++) {
    pickedForYou(s, 3).forEach((q) => assert.ok(!s.completed.some((c) => c.id === q.id)));
    const q = boredPick(s, { time: '5', vibe: 'weird' });
    assert.ok(q.minutes <= 5 || q.mystery, 'time ' + q.id);
  }
  const ids = new Set();
  for (let i = 0; i < 60; i++) ids.add(pickedForYou(s, 1)[0].id);
  assert.ok(ids.size > 5, 'not predictable');
  const sd = somethingDifferent(s);
  assert.ok(sd && !s.completed.some((c) => c.id === sd.id));
  for (let i = 0; i < 30; i++) assert.ok(weirdPick(s, 2).weirdness >= 2);
  ['random', 'weird', 'social', 'chill', 'confidence', 'quick', 'outside'].forEach((f) => assert.ok(rollPick(s, f), f));
  assert.ok(rollPick(s, 'quick').minutes <= 10);
  assert.ok(rollPick(s, 'outside').nearby);
});

test('merge never loses local data and respects unsaves', () => {
  const local = { ...blank(), interests: ['Music'], saved: ['1', '2'], completed: [{ id: '1', date: 10, reflection: 'x' }], stamps: { saved: { 2: { on: true, t: 100 } }, interests: {} } };
  const cloud = { ...blank(), interests: ['Drawing'], saved: ['2', '3'], completed: [{ id: '5', date: 20 }, { id: '1', date: 5, learned: 'older note' }], stamps: { saved: { 2: { on: false, t: 200 } }, interests: {} } };
  const m = mergeStates(local, cloud);
  assert.deepEqual(m.interests.sort(), ['Drawing', 'Music']);
  assert.deepEqual(m.saved.sort(), ['1', '3']);                       // 2 was unsaved later on the other device
  assert.deepEqual(m.completed.map((c) => c.id).sort(), ['1', '5']);
  assert.equal(m.completed.find((c) => c.id === '1').learned, 'older note'); // fills gaps, keeps newer fields
});

test('merge keeps the most recently saved reminder preferences', () => {
  const a = { ...blank(), notifPrefs: { time: '09:00', daily: true, at: 100 } };
  const b = { ...blank(), notifPrefs: { time: '18:30', daily: false, at: 200 } };
  assert.equal(mergeStates(a, b).notifPrefs.time, '18:30');
  assert.equal(mergeStates(b, a).notifPrefs.time, '18:30');
  assert.equal(mergeStates(a, blank()).notifPrefs.time, '09:00');
  assert.equal(mergeStates(blank(), blank()).notifPrefs, undefined);
});

test('V2.1 quests are appended, never renumbered', () => {
  assert.ok(quests.length >= 169);
  assert.equal(quests[0].title, 'Learn a card flourish');
  assert.equal(quests[43].id, '44');
  assert.ok(quests.slice(139).every((q) => q.id === String(quests.indexOf(q) + 1)));
});
