/* =====================================================================
   SideQuest V2 — recommendation engine (pure functions, no DOM)
   Everything here takes the app `state` plus a context and returns quests.
   ===================================================================== */
import { quests, allQuests, QUEST_TYPES } from './data.js';

const DAY = 86400000;

/* ---------- helpers ---------- */
export const todayKey = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/* Small deterministic PRNG so the Daily SideQuest is stable all day. */
const hashStr = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
};
export const seeded = (seed) => {
  let a = hashStr(String(seed)) || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const doneIds = (state) => new Set(state.completed.map((c) => c.id));

/* ---------- user taste profile, derived from what they actually do ---------- */
export function profile(state) {
  const done = state.completed.map((c) => allQuests.find((q) => q.id === c.id)).filter(Boolean);   // history includes retired quests
  const typeAff = {};
  const catAff = {};
  const skillSeen = new Set();
  let conf = 0, soc = 0, weird = 0;

  done.forEach((q) => {
    typeAff[q.type] = (typeAff[q.type] || 0) + 1;
    catAff[q.category] = (catAff[q.category] || 0) + 1;
    skillSeen.add(q.skill);
    conf += q.confidence;
    soc += q.socialLevel;
    weird += q.weirdness;
  });

  const n = done.length;
  /* Comfort levels start low and grow with experience, so new users get
     gentle quests and regulars get gradually bolder ones. */
  return {
    interests: state.interests,
    saved: new Set(state.saved),
    done: doneIds(state),
    typeAff,
    catAff,
    skillSeen,
    count: n,
    comfort: {
      confidence: n ? Math.min(3, conf / n + 0.8) : 1,
      social: n ? Math.min(2, soc / n + 0.6) : 1,
      weirdness: n ? Math.min(3, weird / n + 0.8) : 1.2
    },
    topTypes: Object.entries(typeAff).sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0])
  };
}

/* Skipped quests are down-weighted for a week. */
const recentSkips = (state) => {
  const cutoff = Date.now() - 7 * DAY;
  return new Set((state.skipped || []).filter((s) => s.t > cutoff).map((s) => s.id));
};

/* ---------- context filters ---------- */
export const TIME_FILTERS = { '5': 5, '10': 10, '30': 30 };

export function fits(q, ctx = {}) {
  if (ctx.time === '60') { if (q.minutes < 31) return false; }
  else if (ctx.time && TIME_FILTERS[ctx.time] && q.minutes > TIME_FILTERS[ctx.time]) return false;
  if (ctx.vibe && ctx.vibe !== 'surprise' && !q.vibes.includes(ctx.vibe)) return false;
  if (ctx.type && q.type !== ctx.type) return false;
  if (ctx.env === 'nearby' && !q.nearby) return false;
  if (ctx.env && ctx.env !== 'nearby' && q.environment !== ctx.env) return false;
  if (ctx.minWeird != null && q.weirdness < ctx.minWeird) return false;
  if (ctx.maxWeird != null && q.weirdness > ctx.maxWeird) return false;
  if (ctx.mystery === false && q.mystery) return false;
  return true;
}

/* ---------- scoring ---------- */
export function score(q, p, state, ctx = {}, rnd = Math.random) {
  let s = 0;

  const overlap = q.interests.filter((i) => p.interests.includes(i)).length;
  s += Math.min(overlap, 3) * 2.2;                    // interests
  if (p.saved.has(q.id)) s += 2.5;                    // saved quests
  s += Math.min(p.catAff[q.category] || 0, 3) * 0.5;  // category taste
  s += Math.min(p.typeAff[q.type] || 0, 3) * 0.6;     // type taste

  /* Comfort fit: prefer quests at or slightly above the user's level. */
  const gap = (v, c) => Math.abs(v - (c + 0.3));
  s -= gap(q.confidence, p.comfort.confidence) * 0.9;
  s -= gap(q.weirdness, p.comfort.weirdness) * 0.6;
  s -= Math.max(0, q.socialLevel - p.comfort.social - 0.4) * 1.2;

  /* Difficulty: beginners start easy. */
  const rank = { Easy: 0, Medium: 1, Hard: 2 }[q.difficulty] ?? 0;
  const ceiling = p.count < 3 ? 0 : p.count < 10 ? 1 : 2;
  if (rank > ceiling) s -= (rank - ceiling) * 2;

  /* Time fit: closer to the stated time = better. */
  if (ctx.time && TIME_FILTERS[ctx.time]) s += (q.minutes / TIME_FILTERS[ctx.time]) * 1.2;

  if (ctx.vibe && ctx.vibe !== 'surprise' && q.vibes.includes(ctx.vibe)) s += 1.5;
  if (ctx.mood && q.mood === ctx.mood) s += 1.2;

  /* Don't repeat yourself. */
  if (p.done.has(q.id)) s -= 100;
  if (p.skillSeen.has(q.skill)) s -= 1.5;
  if (recentSkips(state).has(q.id)) s -= 5;
  if (ctx.exclude && ctx.exclude.includes(q.id)) s -= 100;

  s += rnd() * (ctx.jitter ?? 3);                     // controlled randomness
  return s;
}

/* Pick one from the top K by weighted randomness. */
const pickFrom = (scored, rnd, k = 5) => {
  const top = scored.slice(0, k);
  if (!top.length) return null;
  const min = top[top.length - 1].s;
  const weights = top.map((t) => t.s - min + 1);
  let r = rnd() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < top.length; i++) {
    r -= weights[i];
    if (r <= 0) return top[i].q;
  }
  return top[0].q;
};

function ranked(state, ctx = {}, rnd = Math.random) {
  const p = profile(state);
  let pool = quests.filter((q) => fits(q, { mystery: false, ...ctx }));
  const fresh = pool.filter((q) => !p.done.has(q.id));
  if (fresh.length) pool = fresh;                     // only recycle when the pool is exhausted
  return pool
    .map((q) => ({ q, s: score(q, p, state, ctx, rnd) }))
    .sort((a, b) => b.s - a.s);
}

/* ---------- public API ---------- */

/** PICKED FOR YOU — n recommendations, personalised with some jitter. */
export function pickedForYou(state, n = 3, ctx = {}, rnd = Math.random) {
  const excluded = new Set(ctx.exclude || []);
  let pool = ranked(state, ctx, rnd).filter(({ q }) => !excluded.has(q.id)).slice();
  // If exclusions consume the entire filtered pool, relax them rather than returning no picks.
  if (!pool.length) pool = ranked(state, { ...ctx, exclude: [] }, rnd).slice();
  const out = [];
  while (out.length < n && pool.length) {
    const q = pickFrom(pool, rnd, Math.min(6, pool.length));
    if (!q) break;
    out.push(q);
    pool.splice(pool.findIndex((x) => x.q.id === q.id), 1);
  }
  return out;
}

/** SOMETHING DIFFERENT — intentionally outside the user's usual lane. */
export function somethingDifferent(state, ctx = {}, rnd = Math.random) {
  const p = profile(state);
  const usual = new Set(p.topTypes);
  const candidates = quests
    .filter((q) => fits(q, { mystery: false, ...ctx }) && !p.done.has(q.id))
    .filter((q) => q.interests.every((i) => !p.interests.includes(i)) || !usual.has(q.type))
    .filter((q) => !usual.has(q.type) || !p.interests.length)
    .filter((q) => q.difficulty === 'Easy' || p.count >= 3)
    .filter((q) => (ctx.exclude || []).indexOf(q.id) === -1);
  const pool = candidates.length
    ? candidates
    : quests.filter((q) => !q.mystery && !p.done.has(q.id) && !(ctx.exclude || []).includes(q.id));
  /* Novelty = distance from the user's typical comfort, kept gentle. */
  const scored = pool
    .map((q) => ({
      q,
      s:
        Math.abs(q.weirdness - p.comfort.weirdness) * 0.5 +
        (usual.has(q.type) ? 0 : 2) +
        (q.interests.some((i) => p.interests.includes(i)) ? 0 : 1.5) +
        rnd() * 3 -
        (q.confidence > p.comfort.confidence + 1 ? 4 : 0)
    }))
    .sort((a, b) => b.s - a.s);
  return pickFrom(scored, rnd, 6);
}

/** Roll filter chips -> context. */
export const ROLL_FILTERS = [
  { id: 'random', label: 'Random', ctx: {} },
  { id: 'weird', label: 'Weird', ctx: { minWeird: 2 } },
  { id: 'social', label: 'Social', ctx: { social: true } },
  { id: 'chill', label: 'Chill', ctx: { type: 'Chill' } },
  { id: 'confidence', label: 'Confidence', ctx: { type: 'Confidence' } },
  { id: 'quick', label: 'Quick', ctx: { time: '10' } },
  { id: 'outside', label: 'Outside', ctx: { outside: true } }
];

const rollMatch = (q, f) => {
  if (f.social) return q.socialLevel >= 1;
  if (f.outside) return ['outside', 'around-town'].includes(q.environment);
  return fits(q, { ...f, mystery: false });
};

/** Pick the quest that a roll will land on (decided up front, then dramatised). */
export function rollPick(state, filterId = 'random', exclude = [], rnd = Math.random, hardExclude = []) {
  const f = ROLL_FILTERS.find((x) => x.id === filterId)?.ctx || {};
  const p = profile(state);
  const hard = new Set(hardExclude);

  /* Occasionally a mystery quest lands. Only in the unfiltered roll, and rarely. */
  if (filterId === 'random' && rnd() < 0.08) {
    const mysteries = quests.filter(
      (q) => q.mystery && !state.revealed.includes(q.id) && !p.done.has(q.id) &&
        !exclude.includes(q.id) && !hard.has(q.id)
    );
    if (mysteries.length) return mysteries[Math.floor(rnd() * mysteries.length)];
  }

  let pool = quests.filter((q) => !q.mystery && rollMatch(q, f) &&
    !exclude.includes(q.id) && !hard.has(q.id));
  let fresh = pool.filter((q) => !p.done.has(q.id));
  if (fresh.length) pool = fresh;

  // Recent rolls are soft exclusions: once they exhaust the matching pool, allow them again.
  // Landing-page quests are hard exclusions and stay excluded while any alternative exists.
  if (!pool.length) {
    pool = quests.filter((q) => !q.mystery && rollMatch(q, f) && !hard.has(q.id));
    fresh = pool.filter((q) => !p.done.has(q.id));
    if (fresh.length) pool = fresh;
  }
  // Only relax the selected filter as a final fallback; never choose a currently displayed home quest
  // while any other non-mystery quest remains.
  if (!pool.length) {
    pool = quests.filter((q) => !q.mystery && !hard.has(q.id));
    fresh = pool.filter((q) => !p.done.has(q.id));
    if (fresh.length) pool = fresh;
  }
  if (!pool.length) pool = quests.filter((q) => !q.mystery);

  /* Rolls are mostly random, with a light nudge towards the user's taste. */
  const scored = pool
    .map((q) => ({ q, s: score(q, p, state, { jitter: 6, exclude }, rnd) }))
    .sort((a, b) => b.s - a.s);
  return pickFrom(scored, rnd, Math.min(12, scored.length));
}

/** Names to flicker through during the roll animation. */
export function rollReel(finalQuest, state, n = 14, rnd = Math.random) {
  const names = quests
    .filter((q) => !q.mystery && q.id !== finalQuest.id)
    .map((q) => q.title);
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  const reel = names.slice(0, n);
  if (finalQuest.mystery) reel.push('???');
  return reel;
}

/** I'm Bored — time + optional vibe. Falls back gracefully if nothing fits. */
export function boredPick(state, { time = 'any', vibe = 'surprise', exclude = [] } = {}, rnd = Math.random) {
  const t = time === 'any' ? undefined : time;
  const attempts = [
    { time: t, vibe },
    { time: t },
    { vibe },
    {}
  ];
  for (const a of attempts) {
    const ctx = { ...a, exclude, jitter: 4 };
    const r = ranked(state, ctx, rnd).filter((x) => x.s > -50);
    if (r.length) {
      /* “Surprise me” may deliver a mystery quest now and then. */
      if (vibe === 'surprise' && rnd() < 0.1) {
        const p = profile(state);
        const m = quests.filter(
          (q) => q.mystery && !p.done.has(q.id) && !state.revealed.includes(q.id) && fits(q, { time: t, mystery: undefined })
        );
        if (m.length) return m[Math.floor(rnd() * m.length)];
      }
      return pickFrom(r, rnd, 5);
    }
  }
  return quests[0];
}

/** SOMETHING WEIRD. level 1 = mild, 2 = weird, 3 = maximum. */
export function weirdPick(state, level = 2, exclude = [], rnd = Math.random) {
  const p = profile(state);
  const pool = quests.filter(
    (q) =>
      !q.mystery &&
      (level === 3 ? q.weirdness >= 3 : level === 1 ? q.weirdness === 2 : q.weirdness >= 2) &&
      !exclude.includes(q.id)
  );
  const fresh = pool.filter((q) => !p.done.has(q.id));
  const src = fresh.length ? fresh : pool;
  return src[Math.floor(rnd() * src.length)] || quests.find((q) => q.weirdness >= 2);
}

/* ---------- Daily SideQuest ---------- */
/* Rotating moods so the daily quest is never the same flavour twice in a row. */
export const DAILY_TYPES = [
  'Social Chaos', 'Confidence', 'Chill', 'Mildly Unhinged',
  'Weird', 'Creative', 'Physical', 'Random'
];

const moodOrder = (cycle) => {
  const order = DAILY_TYPES.slice();
  const rnd = seeded('mood' + cycle);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
};

/* Every 8-day cycle contains each mood exactly once, and a cycle never starts
   with the mood the previous one ended on. */
export function dailyMood(dateKey) {
  const day = Math.floor(Date.parse(dateKey + 'T00:00:00Z') / DAY);
  const cycle = Math.floor(day / DAILY_TYPES.length);
  const order = moodOrder(cycle);
  const prevLast = moodOrder(cycle - 1)[DAILY_TYPES.length - 1];
  if (order[0] === prevLast) [order[0], order[1]] = [order[1], order[0]];
  return order[day % DAILY_TYPES.length];
}

/** Deterministic for (date, skip count): same quest all day until the user skips. */
export function dailyPick(state, dateKey, skipCount = 0, shown = [], variantKey = '') {
  const mood = dailyMood(dateKey);
  const rnd = seeded(`${dateKey}#${skipCount}#${variantKey}`);
  const p = profile(state);
  const typeOk = (q) =>
    mood === 'Random' ||
    q.type === mood ||
    (mood === 'Physical' && q.category === 'Physical');

  let pool = quests.filter((q) => !q.mystery && typeOk(q) && !shown.includes(q.id));
  const fresh = pool.filter((q) => !p.done.has(q.id));
  if (fresh.length) pool = fresh;
  if (!pool.length) pool = quests.filter((q) => !q.mystery && !shown.includes(q.id));

  /* Keep the daily light-touch: fits a normal day, and respects comfort. */
  const scored = pool
    .map((q) => ({
      q,
      s: score(q, p, state, { jitter: 4, time: q.minutes <= 30 ? undefined : undefined }, rnd) - (q.minutes > 30 ? 3 : 0)
    }))
    .sort((a, b) => b.s - a.s);
  return { quest: pickFrom(scored, rnd, 6), mood };
}

/** Daily-quest streak: consecutive days (ending today or yesterday) with a daily completion. */
export function dailyStreak(state) {
  const days = Object.keys(state.dailyDone || {});
  if (!days.length) return 0;
  const set = new Set(days);
  let d = new Date();
  if (!set.has(todayKey(d))) d = new Date(d.getTime() - DAY);
  let n = 0;
  while (set.has(todayKey(d))) {
    n++;
    d = new Date(d.getTime() - DAY);
  }
  return n;
}

export { QUEST_TYPES };
