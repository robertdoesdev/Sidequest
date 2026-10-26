import {
  quests,
  allQuests,
  categoryInfo,
  categories,
  questById,
  matchingQuests,
  QUEST_TYPES,
  ENVIRONMENTS,
  typeInfo,
  typeColor
} from './data.js';
import {
  todayKey,
  pickedForYou,
  somethingDifferent,
  rollPick,
  rollReel,
  boredPick,
  weirdPick,
  dailyPick,
  dailyMood,
  dailyStreak,
  seeded,
  fits,
} from './recommend.js';
import * as cloud from './cloud.js';
import { backFor, isProfileRoute } from './nav.js';
import { buildActivity } from './activity.js';
import { initInstall, installInfo, promptInstall, onInstallChange } from './install.js';
import * as notify from './notify.js';
import { profileUrl, questUrl, shareLink, shareMessage } from './share.js';
import {
  drawClearCard,
  downloadCard,
  shareCard,
  canNativeShare,
  shareText
} from './card.js';

const $ = (s, root = document) => root.querySelector(s);
const app = $('#app');
const KEY = 'sidequest-v1';
const INSTALL_KEY = 'sidequest-install-id';
const installId = (() => {
  try {
    let id = localStorage.getItem(INSTALL_KEY);
    if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(INSTALL_KEY, id); }
    return id;
  } catch { return 'guest-device'; }
})();

/* ---------------------------------------------------------------
   State. Same localStorage key as V1 so nobody loses anything.
   V2 only ADDS fields; missing ones are filled with defaults.
   --------------------------------------------------------------- */
const state = {
  v: 2,
  interests: [],
  saved: [],
  completed: [],
  onboarded: false,
  active: null,              // { id, startedAt } while a quest is in progress
  revealed: [],              // mystery quests the person has opened
  stamps: { saved: {}, interests: {} },
  dailyDone: {},             // { 'YYYY-MM-DD': questId }
  daily: null,               // today's Daily SideQuest (per device)
  skipped: [],               // [{ id, t }] used to avoid re-recommending
  prefs: { notif: { ...notify.DEFAULT_NOTIF }, asked: 0 }
};

try {
  const stored = JSON.parse(localStorage.getItem(KEY) || '{}');
  Object.assign(state, stored);
  state.prefs = {
    asked: 0,
    ...(stored.prefs || {}),
    notif: { ...notify.DEFAULT_NOTIF, ...(stored.prefs?.notif || {}) }
  };
  state.stamps = { saved: {}, interests: {}, ...(stored.stamps || {}) };
  if (typeof state.active === 'string') state.active = null; // never persisted in V1
  ['interests', 'saved', 'completed', 'revealed', 'skipped'].forEach((k) => {
    if (!Array.isArray(state[k])) state[k] = [];
  });
  if (!state.dailyDone || typeof state.dailyDone !== 'object') state.dailyDone = {};
  state.v = 2;
} catch {}

/* Transient, never persisted. */
const ui = {
  home: null,
  weird: { level: 2, id: null, shown: [] },
  net: { friends: null, challenges: null, waiting: 0, loading: false, error: '' },
  account: { mode: 'signin', error: '', errors: {}, busy: false, pending: null, confirmDelete: false, next: '' },
  showcase: { drafts: {}, tab: 'community', community: { posts: [], next: null, loading: false, loaded: false, error: '' }, mine: { posts: [], next: null, loading: false, loaded: false, error: '' } },
  profile: { username: '', status: 'idle' },
  blocks: null,
  chal: { quest: '', friend: '', message: '', busy: false },
  sync: { state: 'idle', last: 0 },
  backendChecked: false,
  rollTimer: null,
  conflict: null
};

const persist = () => {
  try {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        v: 2,
        interests: state.interests,
        saved: state.saved,
        completed: state.completed,
        onboarded: state.onboarded,
        revealed: state.revealed,
        stamps: state.stamps,
        dailyDone: state.dailyDone,
        daily: state.daily,
        skipped: state.skipped.slice(-60),
        prefs: state.prefs,
        active: state.active
      })
    );
  } catch {}
};

const save = () => {
  persist();
  cloud.scheduleSync();
  armNotifications();
};

/* Membership toggles record a timestamp so sync can tell
   “removed on purpose” from “never had it”. */
const setMember = (list, id, on) => {
  const has = state[list].includes(id);
  if (on && !has) state[list] = [...state[list], id];
  if (!on && has) state[list] = state[list].filter((x) => x !== id);
  state.stamps[list] = { ...state.stamps[list], [id]: { on, t: Date.now() } };
};

const esc = (s) =>
  String(s ?? '').replace(
    /[&<>'"]/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
      })[c]
  );

/* One emoji per quest, stored on the quest itself (data.js). Falls back so a visual is never empty. */
const icon = (q) => (q && typeof q.icon === 'string' && q.icon.trim()) || categoryInfo(q?.category).fallback || '✨';

const route = () =>
  (location.hash.replace(/^#/, '') || '/').split('?')[0];

const go = (p) => {
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  location.hash = p;
  window.scrollTo({
    top: 0,
    behavior: reduce ? 'auto' : 'smooth'
  });
};

const meta = (q) =>
  `<span>${typeInfo(q.type).icon} ${q.type}</span><span>${q.minutes} min</span><span>${q.difficulty}</span><span>${ENVIRONMENTS[q.environment].label}</span>`;

const metaLine = (q) =>
  `${q.minutes} MIN · ${q.type.toUpperCase()} · ${q.difficulty.toUpperCase()}`;

/* Mystery quests stay hidden until the person accepts them. */
const unlocked = (q) =>
  !q.mystery ||
  state.revealed.includes(q.id) ||
  state.completed.some((c) => c.id === q.id);

const face = (q) =>
  unlocked(q)
    ? { title: q.title, description: q.description, icon: q.icon, skill: q.skill }
    : {
        title: 'Mystery SideQuest',
        description: q.mystery.teaser.join(' '),
        icon: '🎁',
        skill: '???'
      };

const reveal = (id) => {
  if (!state.revealed.includes(id)) {
    state.revealed = [...state.revealed, id];
    save();
  }
};

const list = (items, cls = '') =>
  `<ul class="${cls}">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

const entryFor = (id) => state.completed.find((c) => c.id === id);
const fmtDay = (d = new Date()) =>
  d.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }).toUpperCase();

/* Small polite live-region toast (outside #app so re-renders don't wipe it). */
let toastTimer = null;
function toast(msg) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

const startQuest = (id) => {
  /* Never silently replace a quest in progress: same quest resumes, a different one asks first. */
  if (state.active && state.active.id !== id && allQuests.some((q) => q.id === state.active.id)) {
    ui.conflict = { to: id };
    render();
    return;
  }
  const target = `/quest/${id}/active`;
  if (!(state.active && state.active.id === id)) {
    state.active = { id, startedAt: Date.now() };
    reveal(id);
    save();
  }
  if (route() === target) render();        // already on that URL (e.g. deep link + Switch): the hash won't change, so redraw
  else go(target);
};

/* Profile route grouping and back-navigation rules live in nav.js. */
let prevRoute = null;

function navSvg(kind) {
  const paths = {
    home: '<path d="M3 10.5 12 3l9 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-5v-6h-5v6h-5A1.5 1.5 0 0 1 3 18.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z"/>',
    profile: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21c.8-4 3.1-6 7-6s6.2 2 7 6"/>',
    roll: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="8.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/><circle cx="8.5" cy="15.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="15.5" cy="15.5" r="1.1" fill="currentColor" stroke="none"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[kind] || paths.home}</svg>`;
}

function shell(content, { immersive = false } = {}) {
  if (immersive) {
    return `<main class="immersive-main">${content}</main>`;
  }

  const r = route();
  const here = (p) =>
    p === r || (p === '/profile' && isProfileRoute(r) && r !== '/showcase') ? ' nav-active' : '';
  const mHere = (p) =>
    p === r || (p === '/profile' && isProfileRoute(r)) ? ' mobile-active' : '';

  return `
    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="#/">
          <span>sidequest<span class="brand-dot">.</span></span>
        </a>

        <nav class="desktop-nav" aria-label="Main">
          <a href="#/" data-nav="/" class="${here('/').trim()}">Home</a>
          <a href="#/daily" data-nav="/daily" class="${here('/daily').trim()}">Today</a>
          <a href="#/discover" data-nav="/discover" class="${here('/discover').trim()}">Discover</a>
          <a href="#/showcase" data-nav="/showcase" class="${here('/showcase').trim()}">Showcase</a>
          <a href="#/profile" data-nav="/profile" class="${here('/profile').trim()}">Profile${
            ui.net.waiting ? '<i class="nav-dot" aria-label="Challenges waiting"></i>' : ''
          }</a>
        </nav>

        <button
          class="btn btn-dark btn-lg header-roll"
          data-go="/roll"
        >
          ✣ Roll a quest ↗
        </button>
      </div>
    </header>
    ${ongoingBar()}
    ${r === '/' ? installPanel({ banner: true }) : ''}

    <main class="main-content">
      ${content}
    </main>

    <nav class="mobile-nav" aria-label="Main">
      <a href="#/" class="${mHere('/').trim()}">
        <span class="nav-icon" aria-hidden="true">${navSvg('home')}</span>
        <span>Home</span>
      </a>
      <a href="#/daily" class="${mHere('/daily').trim()}">
        <span class="nav-icon" aria-hidden="true">${navSvg('sun')}</span>
        <span>Today</span>
      </a>
      <a href="#/roll" class="mobile-roll${r === '/roll' ? ' mobile-active' : ''}" aria-label="Roll a quest"${r === '/roll' ? ' aria-current="page"' : ''}>
        <span class="roll-glyph" aria-hidden="true">${navSvg('roll')}</span>
      </a>
      <a href="#/discover" class="${mHere('/discover').trim()}">
        <span class="nav-icon" aria-hidden="true">${navSvg('compass')}</span>
        <span>Discover</span>
      </a>
      <a href="#/profile" class="${mHere('/profile').trim()}">
        <span class="nav-icon" aria-hidden="true">${navSvg('profile')}</span>
        <span>Profile${
          ui.net.waiting ? '<i class="nav-dot" aria-label="Challenges waiting"></i>' : ''
        }</span>
      </a>
    </nav>
    ${conflictDialog()}
  `;
}

function questCard(q) {
  const f = face(q);

  return `
    <article class="quest-card">
      <div class="quest-art art-${categoryInfo(q.category).slug}" data-category="${esc(q.category)}" style="--cat:${categoryInfo(q.category).color}">
        <span class="art-index">SQ / ${q.id.padStart(3, '0')}</span>
        <span class="quest-emoji" role="img" aria-label="${esc(f.title)}">${esc(f.icon)}</span>
        <span class="quest-art-category">${esc(q.category)}</span>
      </div>

      <div class="quest-card-content">
        <div class="card-topline">
          <span class="eyebrow">
            ${typeInfo(q.type).icon} ${q.type} / ${q.minutes} min / ${q.difficulty}
          </span>

          <button
            class="btn btn-icon"
            data-save="${q.id}"
            aria-label="${state.saved.includes(q.id) ? 'Unsave' : 'Save'} quest"
          >
            ${state.saved.includes(q.id) ? '★' : '☆'}
          </button>
        </div>

        <a
          href="#/quest/${q.id}"
          class="quest-title-link"
        >
          <h3>${esc(f.title)}</h3>
        </a>

        <p>${esc(f.description)}</p>

        <div class="quest-card-bottom">
          <span class="muted">
            ✦ You'll gain: ${esc(f.skill)}
          </span>

          <button
            class="btn btn-ghost btn-sm"
            data-start="${q.id}"
          >
            ${q.mystery && !unlocked(q) ? 'Reveal quest ↗' : 'Start quest ↗'}
          </button>
        </div>
      </div>
    </article>
  `;
}

function visual(q, cls = '') {
  return `<span class="${cls}" role="img" aria-label="${esc(q.title)}">${icon(q)}</span>`;
}

/* Streak artifact: a small collectible stamp + a 7-pip week meter.
   variants: 'mini' (card corner), 'inline' (under a heading), 'full' (rewards / profile) */
const STREAK_MARKS = [3, 7, 14, 30, 60, 100];
function streakBadge(n, variant = 'full') {
  if (!n) return '';
  const on = ((n - 1) % 7) + 1;
  const next = STREAK_MARKS.find((m) => m > n);
  const pips = Array.from({ length: 7 }, (_, i) => `<i class="${i < on ? 'on' : ''}"></i>`).join('');
  const label = `${n} day${n === 1 ? '' : 's'} in a row`;
  return `
    <div class="streak-badge streak-${variant}" role="img" aria-label="${label}">
      <div class="streak-seal"><b>${n}</b><small>${n === 1 ? 'DAY' : 'DAYS'}</small></div>
      <div class="streak-meta">
        <span class="streak-title">IN A ROW</span>
        <span class="streak-pips" aria-hidden="true">${pips}</span>
        ${variant === 'mini' ? '' : `<span class="streak-next">${next ? `${next - n} more to the ${next}-day mark` : 'Legend status'}</span>`}
      </div>
    </div>`;
}

/* ---------------- Daily SideQuest ---------------- */
const MAX_SKIPS = 3;

function dailyData() {
  const today = todayKey();
  if (!state.daily || state.daily.date !== today) {
    state.daily = { date: today, skips: 0, shown: [], id: null };
  }
  if (!state.daily.id || !quests.some((q) => q.id === state.daily.id)) {
    const { quest } = dailyPick(state, today, state.daily.skips, state.daily.shown, installId);
    state.daily.id = quest.id;
    state.daily.shown = [...state.daily.shown, quest.id];
    persist();
  }
  return {
    q: questById(state.daily.id),
    mood: dailyMood(today),
    skipsLeft: Math.max(0, MAX_SKIPS - state.daily.skips),
    done: !!state.dailyDone[today],
    streak: dailyStreak(state)
  };
}

function dailyActions(d, { details = true } = {}) {
  const q = d.q;
  if (d.done) {
    return `
      <div class="daily-actions">
        <span class="daily-done">✓ DONE FOR TODAY</span>
        <button class="btn btn-dark btn-lg" data-completion-card="${q.id}">VIEW MY CARD ↗</button>
        <button class="btn btn-outline btn-lg" data-go="/roll">WANT ANOTHER? ROLL ↗</button>
      </div>`;
  }
  const resuming = state.active?.id === q.id;
  return `
    <div class="daily-actions">
      ${resuming
        ? `<a class="btn btn-lime btn-xl" href="#/quest/${q.id}/active">CONTINUE QUEST →</a>`
        : `<button class="btn btn-dark btn-xl" data-start="${q.id}">ACCEPT QUEST →</button>`}
      <button class="btn btn-outline btn-xl" data-act="daily-skip" ${d.skipsLeft && !resuming ? '' : 'disabled'}>
        ↻ SKIP / GET ANOTHER
      </button>
      ${details ? `<a class="text-link" href="#/daily">See the full plan ↗</a>` : ''}
    </div>
    <p class="daily-skips">${
      d.skipsLeft
        ? `${d.skipsLeft} swap${d.skipsLeft === 1 ? '' : 's'} left today`
        : 'No swaps left. Today’s quest is locked in. You’ve got this.'
    }</p>`;
}

function dailyCard() {
  const d = dailyData();
  const q = d.q;
  return `
    <section class="daily-section" aria-labelledby="daily-h">
      <div class="daily-card" style="--accent:${typeColor(q.type)}">
        <div class="daily-main">
          <span class="eyebrow">✳ YOUR SIDEQUEST FOR TODAY</span>
          <h2 id="daily-h">${esc(q.title)}</h2>
          <p class="daily-meta">${metaLine(q)}</p>
          <p class="daily-desc">${esc(q.description)}</p>
          ${dailyActions(d)}
        </div>
        <div class="daily-side" aria-hidden="true">
          <span class="daily-icon">${icon(q)}</span>
          <span class="daily-tag">${typeInfo(q.type).tagline}</span>
          ${streakBadge(d.streak, 'mini')}
        </div>
      </div>
    </section>
  `;
}

function daily() {
  const d = dailyData();
  const q = d.q;
  const t = typeInfo(q.type);

  return `
    <div class="quest-detail daily-page">
      <div class="page-wrap-wide">
        <div class="detail-top">
          ${backLink()}
          <span class="eyebrow">${fmtDay()}</span>
        </div>

        <div class="detail-hero">
          <div class="detail-copy">
            <span class="eyebrow">✳ YOUR SIDEQUEST FOR TODAY</span>
            <h1>${esc(q.title)}</h1>
            <p class="type-tagline">${t.icon} ${esc(t.tagline)}</p>
            <p>${esc(q.description)}</p>
            <p class="daily-meta">${metaLine(q)}</p>
            ${streakBadge(d.streak, 'inline')}
            ${dailyExtras(d)}
            ${dailyActions(d, { details: false })}
            <div class="detail-actions">
              <button class="btn btn-outline btn-lg" data-save="${q.id}">
                ${state.saved.includes(q.id) ? '★ SAVED' : '☆ SAVE FOR LATER'}
              </button>
              <button class="btn btn-outline btn-lg" data-act="challenge" data-quest="${q.id}">🤝 DARE A FRIEND</button>
            </div>
          </div>

          <div class="detail-image daily-image" style="--accent:${typeColor(q.type)}">
            ${visual(q, 'detail-symbol')}
          </div>
        </div>

        ${q.questChain ? `<p class="chain-line">⛓ PART ${q.questChain.step} OF ${q.questChain.of} · ${esc(q.questChain.name.toUpperCase())}</p>` : ''}
        ${questBody(q)}
      </div>
    </div>
  `;
}

/* ---------------- Home ---------------- */
function mysteryOfTheDay() {
  const day = todayKey();
  if (seeded('mystery' + day)() > 0.4) return null; // sparing: roughly 2 days in 5
  const pool = quests.filter((q) => q.mystery && !unlocked(q));
  return pool.length ? pool[Math.floor(seeded('m2' + day)() * pool.length)] : null;
}

function homePicks() {
  if (!ui.home) {
    const picked = pickedForYou(state, 1)[0];
    let different = somethingDifferent(state, { exclude: [picked.id] });
    ui.home = {
      picked,
      different,
      nearby: pickedForYou(state, 3, { env: 'nearby' }),
      mystery: mysteryOfTheDay()
    };
  }
  return ui.home;
}

function home() {
  const { picked, different, nearby, mystery } = homePicks();

  const categoriesDone = new Set(
    state.completed.map(
      (c) => questById(c.id)?.category
    )
  ).size;

  return `
    <div class="home-page">
      <div class="announcement">
        <span class="announcement-pulse"></span>
        THE WORLD IS MORE INTERESTING OFFLINE
        <span>✳</span>
        YOUR NEXT STORY STARTS HERE
      </div>

      <section class="home-hero">
        <div class="hero-inner">
          <div class="hero-copy">
            <span class="eyebrow hero-eyebrow">
              <span class="small-cross">✳</span>
              YOUR ANTI-SCROLL DEVICE
            </span>

            <h1>
              DO SOMETHING<br>
              WITH YOUR<br>
              <span>
                BOREDOM<span class="hero-period">.</span>
              </span>
            </h1>

            <p>
              You've got time. Let's do something with it.
            </p>

            <div class="hero-actions">
              <button
                class="btn btn-lime btn-xl"
                data-go="/roll"
              >
                ✣ ROLL THE QUEST ↗
              </button>

              <button
                class="btn btn-outline btn-xl bored-cta"
                data-go="/bored"
              >
                I'M BORED ↗
              </button>
            </div>

            <div class="hero-note">
              <span class="note-asterisk">✳</span>
              Less scrolling. More stories to tell.
            </div>
          </div>

          <div class="hero-visual">
            <div class="hero-visual-top">
              <span>QUEST NO. 001</span>
              <span>THE UNEXPECTED AWAITS ↗</span>
            </div>

            <div class="hero-image">
              <img src="assets/card-flourish.jpg" alt="${esc(quests[0].title)}"/>
            </div>

            <div class="hero-visual-bottom">
              <span>TRY SOMETHING NEW TODAY</span>
              <span class="hero-number">01 / ∞</span>
            </div>

            <div class="hero-sticker">
              REAL LIFE<br>
              IS THE<br>
              GAME
            </div>
          </div>
        </div>

        <div class="hero-bottom-line">
          <span>
            THE UNIVERSE OF THINGS YOU COULD DO IS BIGGER THAN YOU THINK.
          </span>
          <span>↘</span>
        </div>
      </section>

      <div class="ticker">
        <div>
          DO IT FOR THE PLOT
          <span>✳</span>
          TRY SOMETHING NEW
          <span>✳</span>
          MAKE A MEMORY
          <span>✳</span>
          DO IT FOR THE PLOT
          <span>✳</span>
        </div>
      </div>

      ${dailyCard()}

      <section class="return-strip" aria-label="Come back to SideQuest">
        <div>
          <span class="eyebrow">THE WORLD KEEPS MOVING</span>
          <h2>THERE'S ALWAYS<br><em>ANOTHER THING.</em></h2>
        </div>
        <div class="return-actions">
          <button class="return-chip" data-go="/daily"><b>DAILY</b><span>A new quest every day</span></button>
          <button class="return-chip" data-go="/weird"><b>WEIRD</b><span>Something you didn't expect</span></button>
          <button class="return-chip" data-go="/roll"><b>ROLL</b><span>Let chance choose</span></button>
        </div>
      </section>

      <section class="content-section quick-section" aria-labelledby="quick-h">
        <div class="section-heading">
          <div>
            <span class="eyebrow section-kicker">QUICK QUESTS</span>
            <h2 id="quick-h">HOW MUCH TIME?</h2>
          </div>
        </div>
        <div class="quick-row">
          ${[['5', '5 MIN', 'blink and it’s done'], ['10', '10 MIN', 'one good song'], ['30', '30 MIN', 'a proper detour'], ['60', '1 HOUR+', 'go all in']]
            .map(
              ([v, l, s]) => `
                <button class="quick-btn" data-discover="time:${v}">
                  <strong>${l}</strong><span>${s}</span>
                </button>`
            )
            .join('')}
        </div>
        <div class="quick-extras">
          <button class="chip-link" data-go="/weird">👁️ SOMETHING WEIRD ↗</button>
          <button class="chip-link" data-discover="env:nearby">📍 NEARBY SIDEQUESTS ↗</button>
          <button class="chip-link" data-go="/bored">🥱 I'M BORED ↗</button>
        </div>
      </section>

      ${
        mystery
          ? `
      <section class="content-section">
        <a class="mystery-card" href="#/quest/${mystery.id}">
          <span class="eyebrow">🎁 MYSTERY SIDEQUEST</span>
          <p class="mystery-lines">${mystery.mystery.teaser.map((x) => `<span>${esc(x)}</span>`).join('')}</p>
          <span class="mystery-cta">OPEN IT ↗</span>
        </a>
      </section>`
          : ''
      }

      <section class="content-section home-intro">
        <div class="section-intro-row">
          <span class="eyebrow">01 / START SOMEWHERE</span>
          <p>
            Small quests. Big “wait, I can do that?” energy.
          </p>
        </div>

        <div class="section-heading">
          <div>
            <span class="eyebrow section-kicker">
              THE GOOD STUFF
            </span>
            <h2>YOUR NEXT MOVE</h2>
          </div>

          <button class="section-link link-btn" data-act="home-shuffle">
            Shuffle picks ↻
          </button>
        </div>

        <div class="home-feature-grid">
          <div class="recommendation-lead">
            <div class="recommendation-badge">
              ✦ PICKED FOR YOU
            </div>

            <p>
A little something to get you started.
            </p>

            <h3>${esc(picked.title)}</h3>

            <div class="recommendation-meta">
              ${metaLine(picked)}
            </div>

            <p class="recommendation-description">
              ${esc(picked.description)}
            </p>

            <button
              class="btn btn-dark btn-lg"
              data-start="${picked.id}"
            >
              START QUEST ↗
            </button>

            <span class="recommendation-decoration">
              ${icon(picked)}
            </span>
          </div>

          <div class="different-panel">
            <span class="eyebrow">
              ✳ SOMETHING DIFFERENT
            </span>

            <div class="different-icon">
              ${icon(different)}
            </div>

            <div>
              <span class="subtle-label">
                Step outside your usual.
              </span>

              <h3>${esc(different.title)}</h3>

              <p>
                ${different.minutes} min ·
                ${different.type} ·
                ${different.difficulty}
              </p>

              <a
                href="#/quest/${different.id}"
                class="text-link"
              >
                Take a look ↗
              </a>
            </div>
          </div>
        </div>
      </section>

      <section class="content-section vibe-section" aria-labelledby="vibe-h">
        <div class="section-heading">
          <div>
            <span class="eyebrow section-kicker">02 / PICK YOUR VIBE</span>
            <h2 id="vibe-h">WHAT KIND OF DAY IS IT?</h2>
          </div>
        </div>
        <div class="vibe-grid">
          ${QUEST_TYPES.map(
            (t) => `
            <button class="vibe-tile" style="--accent:${typeColor(t.id)}" data-discover="type:${t.id}">
              <span class="vibe-icon" aria-hidden="true">${t.icon}</span>
              <strong>${t.id}</strong>
              <small>${t.tagline}</small>
            </button>`
          ).join('')}
        </div>
      </section>

      <section class="content-section nearby-section">
        <div class="section-heading">
          <div>
            <span class="eyebrow section-kicker">03 / NEARBY SIDEQUESTS</span>
            <h2>GO OUTSIDE. SOMETHING’S OUT THERE.</h2>
          </div>
          <button class="section-link link-btn" data-discover="env:nearby">
            See all nearby ↗
          </button>
        </div>
        <p class="muted nearby-note">
          No tracking, no maps. Just quests that work close to home.
        </p>
        <div class="quest-grid">
          ${nearby.map(questCard).join('')}
        </div>
      </section>

      <section class="content-section popular-section">
        <div class="section-heading">
          <div>
            <span class="eyebrow section-kicker">
              04 / PICK YOUR PATH
            </span>
            <h2>GOOD PLACE TO START</h2>
          </div>

          <a
            class="section-link"
            href="#/discover"
          >
            See all ${quests.length} quests
          </a>
        </div>

        <div class="quest-grid">
          ${[
            questById('1'),
            questById('3'),
            questById('13')
          ]
            .map(questCard)
            .join('')}
        </div>
      </section>

      <section class="progress-band">
        <div class="progress-inner">
          <div>
            <span class="eyebrow">
              YOUR STORY SO FAR
            </span>

            <h2>
              THE THINGS<br>
              YOU CAN DO<span>.</span>
            </h2>

            <p>
              Every quest becomes another little part of you.
            </p>

            <button
              class="btn btn-lime btn-lg"
              data-go="/profile"
            >
              SEE YOUR PROFILE ↗
            </button>
          </div>

          <div class="progress-stats">
            <div>
              <strong>${state.completed.length}</strong>
              <span>QUESTS COMPLETED</span>
            </div>

            <div>
              <strong>
                ${
                  new Set(
                    state.completed.map(
                      (c) => questById(c.id)?.skill
                    )
                  ).size
                }
              </strong>
              <span>SKILLS UNLOCKED</span>
            </div>

            <div>
              <strong>${categoriesDone}</strong>
              <span>CATEGORIES EXPLORED</span>
            </div>
          </div>
        </div>
      </section>

      <footer class="site-footer">
        <span>✳ sidequest.</span>
        <span>DO SOMETHING WITH YOUR BOREDOM.</span>
        <span class="footer-note">YOUR NEXT STORY STARTS OFFLINE.</span>
      </footer>
    </div>
  `;
}

/* ---------------- Something Weird ---------------- */
const WEIRD_LEVELS = [
  [1, '🙂 A LITTLE ODD'],
  [2, '👁️ WEIRD'],
  [3, '🌀 MAXIMUM']
];

function weird() {
  const w = ui.weird;
  if (!w.id) {
    const q = weirdPick(state, w.level, w.shown);
    w.id = q.id;
    w.shown = [...w.shown.slice(-10), q.id];
  }
  const q = questById(w.id);
  const line = q.detail.say[0];

  return `
    <div class="weird-page">
      <div class="page-wrap-wide">
        ${backLink()}

        <div class="weird-layout">
          <div class="weird-copy">
            <span class="eyebrow">👁️ SOMETHING WEIRD</span>
            <h1>NORMAL IS<br><em>OVERRATED.</em></h1>
            <p>Harmless, slightly odd, completely optional. Pick your weird.</p>
            <div class="category-filters weird-levels" role="group" aria-label="How weird?">
              ${WEIRD_LEVELS.map(
                ([n, l]) => `
                <button class="filter-pill ${ui.weird.level === n ? 'active' : ''}"
                  aria-pressed="${ui.weird.level === n}" data-act="weird-level" data-v="${n}">${l}</button>`
              ).join('')}
            </div>
          </div>

          <article class="weird-card" style="--accent:${typeColor(q.type)}" aria-live="polite">
            <span class="weird-card-top">
              <span>${typeInfo(q.type).icon} ${q.type.toUpperCase()}</span>
              <span>${q.minutes} MIN</span>
            </span>
            <span class="weird-icon" aria-hidden="true">${icon(q)}</span>
            <h2>${esc(q.title)}</h2>
            ${
              line
                ? `<blockquote>${esc(line)}</blockquote>`
                : `<p>${esc(q.detail.mission)}</p>`
            }
            <div class="weird-actions">
              <button class="btn btn-dark btn-xl" data-start="${q.id}">ACCEPT QUEST →</button>
              <button class="btn btn-outline btn-xl" data-act="weird-next">↻ ANOTHER WEIRD ONE</button>
            </div>
            <div class="weird-links">
              <a class="text-link" href="#/quest/${q.id}">Full details ↗</a>
              <button class="link-btn" data-save="${q.id}">${state.saved.includes(q.id) ? '★ Saved' : '☆ Save for later'}</button>
            </div>
          </article>
        </div>
      </div>
    </div>
  `;
}

/* ---------------- Discover ---------------- */
const TIME_PILLS = [['', 'Any time'], ['5', '5 MIN'], ['10', '10 MIN'], ['30', '30 MIN'], ['60', '1 HOUR+']];
const ENV_PILLS = [
  ['', 'Anywhere'],
  ['nearby', '📍 Nearby'],
  ['home', 'At home'],
  ['outside', 'Outside'],
  ['around-town', 'Around town'],
  ['school-work', 'School / work']
];

function discover() {
  const qs = state.discover || {};
  const term = (qs.search || '').trim().toLowerCase();

  const filtered = quests.filter(
    (q) =>
      (!qs.cat || q.category === qs.cat) &&
      (!qs.type || q.type === qs.type) &&
      (!qs.env || fits(q, { env: qs.env })) &&
      (!qs.time || fits(q, { time: qs.time })) &&
      (!qs.diff || q.difficulty === qs.diff) &&
      (!term ||
        (unlocked(q)
          ? `${q.title} ${q.skill} ${q.category} ${q.type} ${q.environment} ${q.interests.join(' ')}`
          : 'mystery'
        )
          .toLowerCase()
          .includes(term))
  );

  const pill = (key, val, label) => `
    <button class="filter-pill ${(qs[key] || '') === val ? 'active' : ''}"
      aria-pressed="${(qs[key] || '') === val}" data-filter="${key}:${esc(val)}">${label}</button>`;

  return `
    <div class="page-view">
      <div class="page-wrap-wide">
        <section class="page-heading">
          <span class="eyebrow">
            THE QUEST LIBRARY / ${quests.length} QUESTS
          </span>

          <h1>
            FIND YOUR<br>
            <em>NEXT THING.</em>
          </h1>

          <p>
            Browse tiny challenges, useful skills, weird experiments
            and things you can actually do today.
          </p>
        </section>

        <section class="discover-controls">
          <input
            class="search-field"
            id="search"
            type="search"
            aria-label="Search quests"
            value="${esc(qs.search || '')}"
            placeholder="Search quests, skills, categories..."
          />

          <div class="filter-stack filter-desktop">
            <div class="filter-row"><span class="filter-label">VIBE</span><div class="category-filters">${pill('type', '', 'All')}${QUEST_TYPES.map((t) => pill('type', t.id, `${t.icon} ${t.id}`)).join('')}</div></div>
            <div class="filter-row"><span class="filter-label">TIME</span><div class="category-filters">${TIME_PILLS.map(([v, l]) => pill('time', v, l)).join('')}</div></div>
            <div class="filter-row"><span class="filter-label">WHERE</span><div class="category-filters">${ENV_PILLS.map(([v, l]) => pill('env', v, l)).join('')}</div></div>
            <div class="filter-row"><span class="filter-label">CATEGORY</span><div class="category-filters">${pill('cat', '', 'All')}${categories.map((c) => pill('cat', c, c)).join('')}</div></div>
          </div>
          <div class="filter-mobile" aria-label="Quest filters">
            <details class="filter-dropdown"><summary>VIBE <b>${esc(qs.type || 'All')}</b></summary><div class="filter-dropdown-options">${pill('type', '', 'All')}${QUEST_TYPES.map((t) => pill('type', t.id, `${t.icon} ${t.id}`)).join('')}</div></details>
            <details class="filter-dropdown"><summary>TIME <b>${esc(qs.time ? qs.time + ' MIN' : 'Any')}</b></summary><div class="filter-dropdown-options">${TIME_PILLS.map(([v, l]) => pill('time', v, l)).join('')}</div></details>
            <details class="filter-dropdown"><summary>WHERE <b>${esc(qs.env || 'Anywhere')}</b></summary><div class="filter-dropdown-options">${ENV_PILLS.map(([v, l]) => pill('env', v, l)).join('')}</div></details>
            <details class="filter-dropdown"><summary>CATEGORY <b>${esc(qs.cat || 'All')}</b></summary><div class="filter-dropdown-options">${pill('cat', '', 'All')}${categories.map((c) => pill('cat', c, c)).join('')}</div></details>
          </div>
        </section>

        <div class="results-line">
          <span>${filtered.length} quests found</span>
          ${
            Object.values({ ...qs, search: '' }).some(Boolean) || term
              ? '<button class="link-btn" data-act="clear-filters">Clear filters ✕</button>'
              : '<span>Pick something and go.</span>'
          }
        </div>

        <div class="discover-cards">
          ${
            filtered.map(questCard).join('') ||
            '<p class="muted">Nothing matched. Try a wider filter.</p>'
          }
        </div>
      </div>
    </div>
  `;
}

/* ---------------- I'm Bored ---------------- */
const BORED_TIMES = [['5', '5 MIN'], ['10', '10 MIN'], ['30', '30 MIN'], ['any', "I DON'T CARE"]];
const BORED_VIBES = [
  ['make', 'MAKE'],
  ['learn', 'LEARN'],
  ['move', 'MOVE'],
  ['socialize', 'SOCIALIZE'],
  ['chill', 'CHILL'],
  ['weird', 'WEIRD'],
  ['surprise', 'SURPRISE ME']
];

function boredGenerate() {
  const b = state.bored;
  const exclude = b.shown || [];
  const time = b.time === 'any' ? undefined : b.time;
  let q = null;
  let diff = false;
  if (b.vibe === 'surprise' && Math.random() < 0.25) {
    q = somethingDifferent(state, { time, exclude });
    diff = !!q;
  }
  if (!q) q = boredPick(state, { time: b.time, vibe: b.vibe, exclude });
  state.bored = { ...b, result: q.id, diff, shown: [...exclude.slice(-12), q.id] };
}

function bored() {
  const b = state.bored || { time: null, vibe: null, result: null };

  let body = '';

  if (b.result) {
    const q = questById(b.result);
    const f = face(q);
    const timeLabel = BORED_TIMES.find((x) => x[0] === b.time)?.[1];
    const vibeLabel = BORED_VIBES.find((x) => x[0] === b.vibe)?.[1];

    body = `
      <span class="eyebrow">${b.diff ? '✳ SOMETHING DIFFERENT' : 'WE HAVE A MATCH ✳'}</span>

      <div class="bored-result-icon" aria-hidden="true">
        ${f.icon}
      </div>

      <h2>${esc(f.title)}</h2>

      <p>${esc(f.description)}</p>

      <div class="eyebrow">
        ${unlocked(q) ? metaLine(q) : `${q.minutes} MIN · MYSTERY`}
      </div>
      <p class="muted bored-why">
        ${[timeLabel && timeLabel !== "I DON'T CARE" ? `Fits your ${timeLabel.toLowerCase()}` : '', vibeLabel && vibeLabel !== 'SURPRISE ME' ? vibeLabel.toLowerCase() : '']
          .filter(Boolean)
          .join(' · ')}
      </p>

      <button
        class="btn btn-lime btn-xl"
        data-start="${q.id}"
      >
        ${q.mystery && !unlocked(q) ? 'ACCEPT THE MYSTERY →' : "LET'S DO IT →"}
      </button>

      <button class="choice-btn" data-act="bored-again">
        ↻ TRY ANOTHER
      </button>
      <button class="choice-btn" data-act="bored-vibe-reset">
        ← CHANGE WHAT SOUNDS GOOD
      </button>
      <button class="choice-btn" data-act="bored-time" data-v="reset">
        ← CHANGE MY TIME
      </button>
    `;
  } else if (!b.time) {
    body = `
      <span class="eyebrow">FIRST THINGS FIRST</span>

      <h2>
        How much time<br>
        do you have?
      </h2>

      ${BORED_TIMES.map(
        ([v, l]) => `
            <button
              class="choice-btn"
              data-act="bored-time"
              data-v="${v}"
            >
              ${l}
              <span>→</span>
            </button>
          `
      ).join('')}
    `;
  } else {
    body = `
      <span class="eyebrow">ONE MORE THING</span>

      <h2>
        What sounds<br>
        good?
      </h2>

      ${BORED_VIBES.map(
        ([v, l]) => `
            <button
              class="choice-btn"
              data-act="bored-vibe"
              data-v="${v}"
            >
              ${l}
              <span>→</span>
            </button>
          `
      ).join('')}

      <button
        class="choice-btn"
        data-act="bored-time"
        data-v="reset"
      >
        ← CHANGE MY TIME
      </button>
    `;
  }

  return `
    <div class="bored-page">
      <div class="page-wrap-wide">
        ${backLink()}

        <div class="bored-layout">
          <div>
            <span class="eyebrow">
              THE BOREDOM EXIT /
              ${b.result ? '03' : b.time ? '02' : '01'}
              OF 03
            </span>

            <h1>
              LET'S FIND<br>
              <em>YOUR THING.</em>
            </h1>

            <p>
              Don't overthink it. Go with your gut.
            </p>

            <div class="bored-decoration" aria-hidden="true">
              ✳
            </div>
          </div>

          <div class="bored-choices">
            ${body}
          </div>
        </div>
      </div>
    </div>
  `;
}

/* ---------------- Quest Roll 2.0 ---------------- */
const REDUCED = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

function clearRoll() {
  clearTimeout(ui.rollTimer);
  ui.rollTimer = null;
  if (state.roll?.phase === 'rolling') state.roll = { ...state.roll, phase: 'idle' };
}

function startRoll() {
  const cur = state.roll || {};
  if (cur.phase === 'rolling') return;
  const history = cur.history || [];
  const final = rollPick(state, 'random', history.slice(-6));
  const reel = rollReel(final, state, 16);
  const count = (cur.count || 0) + 1;

  state.roll = { ...cur, phase: 'rolling', final: final.id, count, history, filter: 'random' };
  render();

  const finish = () => {
    state.roll = { ...state.roll, phase: 'reveal', history: [...history, final.id].slice(-20) };
    ui.rollTimer = null;
    render();
    $('.roll-result [data-start]')?.focus({ preventScroll: true });
  };

  if (REDUCED()) {
    ui.rollTimer = setTimeout(finish, 450);
    return;
  }

  let i = 0;
  const step = () => {
    if (route() !== '/roll' || state.roll?.phase !== 'rolling') return;
    const el = $('#roll-title');
    if (el) {
      el.textContent = reel[i];
      el.classList.remove('tick');
      void el.offsetWidth;
      el.classList.add('tick');
    }
    i++;
    if (i >= reel.length) {
      ui.rollTimer = setTimeout(finish, 520);
      return;
    }
    /* Starts fast (~55ms), eases out to ~400ms before the reveal. */
    ui.rollTimer = setTimeout(step, 55 + Math.pow(i / reel.length, 2.2) * 350);
  };
  step();
}

function roll() {
  const r = state.roll || { phase: 'idle', filter: 'random', count: 0 };
  const q = r.final ? questById(r.final) : null;
  const f = q ? face(q) : null;
  const rolling = r.phase === 'rolling';
  const revealed = r.phase === 'reveal' && q;

  return `
    <div class="roll-page ${rolling ? 'rolling' : ''}">
      <div class="page-wrap-wide">
        <div class="roll-top">
          ${backLink()}

          <span class="eyebrow">
            THE QUEST GENERATOR /
            ${String(r.count || 0).padStart(3, '0')}
          </span>
        </div>

        <div class="roll-heading">
          <span class="eyebrow">
            ✦ LEAVE IT TO CHANCE
          </span>

          <h1>
            LET FATE<br>
            <em>DECIDE.</em>
          </h1>

          <p>
            One roll. One unexpected thing to try.
          </p>
        </div>

        <div class="roll-machine">
          <div class="machine-top">
            <span>✳ SIDEQUEST RANDOMIZER</span>
            <span>
              NO. ${String(r.count || 0).padStart(3, '0')}
            </span>
          </div>

          <div class="machine-window">
            <span class="machine-label">
              ${
                revealed
                  ? '✳ YOUR SIDEQUEST'
                  : rolling
                    ? 'FINDING YOUR NEXT STORY...'
                    : 'SOMETHING GOOD IS COMING...'
              }
            </span>

            <div class="machine-title" id="roll-title" ${rolling ? 'aria-hidden="true"' : ''}>
              ${
                revealed
                  ? esc(f.title)
                  : rolling
                    ? '· · ·'
                    : 'WHAT WILL<br>YOU TRY?'
              }
            </div>

            <div class="machine-bottom">
              ${
                revealed
                  ? unlocked(q) ? metaLine(q) : `${q.minutes} MIN · MYSTERY`
                  : 'A WHOLE WORLD OF POSSIBILITIES'
              }
            </div>

            <span class="machine-cross cross-one" aria-hidden="true">
              ✳
            </span>

            <span class="machine-cross cross-two" aria-hidden="true">
              ✳
            </span>
          </div>

          <div class="machine-footer">
            <span>CHANCE LOOKS GOOD ON YOU.</span>
            <span>↗ ↗ ↗</span>
          </div>
        </div>

        <div class="sr-only" role="status" aria-live="polite">${revealed ? `Rolled: ${esc(f.title)}` : rolling ? 'Rolling' : ''}</div>

        ${
          revealed
            ? `
              <div class="roll-result">
                <div class="result-visual" aria-hidden="true">
                  ${f.icon}
                </div>

                <div>
                  <span class="eyebrow">
                    QUEST UNLOCKED ↗
                  </span>

                  <p>
                    ${esc(f.description)}
                  </p>

                  ${
                    unlocked(q)
                      ? `<div class="roll-details">
                          <div><span class="eyebrow">YOUR MISSION</span><p>${esc(q.detail.mission)}</p></div>
                          <div><span class="eyebrow">WHY TRY IT?</span><p>${esc(q.why)}</p></div>
                          <div class="detail-meta">${meta(q)}</div>
                        </div>`
                      : `<p class="muted">Accept to find out what it is.</p>`
                  }

                  <div class="result-actions">
                    <button
                      class="btn btn-lime btn-xl"
                      data-start="${q.id}"
                    >
                      ACCEPT QUEST →
                    </button>

                    <button
                      class="btn btn-outline btn-xl"
                      data-act="roll-again"
                    >
                      ↻ ROLL AGAIN
                    </button>
                  </div>
                  ${unlocked(q) ? `<a class="text-link" href="#/quest/${q.id}">See the full plan ↗</a>` : ''}
                </div>
              </div>
            `
            : `
              <div class="roll-action">
                <button
                  class="btn btn-lime btn-xl"
                  data-act="roll"
                  ${rolling ? 'disabled' : ''}
                >
                  ${
                    rolling
                      ? 'ROLLING...'
                      : '✣ ROLL THE QUEST →'
                  }
                </button>

                <p>
                  Not feeling it? You can always roll again.
                </p>
              </div>
            `
        }
      </div>
    </div>
  `;
}

/* ---------------- Shared quest body (detail + daily) ---------------- */
function questBody(q) {
  const d = q.detail;
  const env = ENVIRONMENTS[q.environment];
  const locked = !unlocked(q);

  const block = (label, body, cls = '') => `
    <section class="d-block ${cls}">
      <span class="eyebrow">${label}</span>
      ${body}
    </section>
  `;

  if (locked) {
    return `
      <div class="detail-body detail-body-locked">
        ${block(
          "WHAT'S THE CATCH?",
          `<p class="mystery-lines">${q.mystery.teaser
            .map((x) => `<span>${esc(x)}</span>`)
            .join('')}</p>
           <p>The full instructions unlock when you accept. That’s the whole point.</p>`,
          'mission-card'
        )}
      </div>
    `;
  }

  return `
      <div class="detail-body">
        ${block('WHAT YOU’RE DOING', `<p>${esc(d.what)}</p>`)}

        ${block(
          'WHY TRY IT?',
          `<p>${esc(q.why)}</p>
           <p class="gain">✦ You’ll gain: <strong>${esc(q.skill)}</strong></p>`
        )}

        ${block(
          'YOUR MISSION',
          `<p class="mission-text">${esc(d.mission)}</p>`,
          'mission-card'
        )}

        ${block(
          'HOW TO DO IT',
          `<ol class="step-list">${q.steps
            .map((x) => `<li>${esc(x)}</li>`)
            .join('')}</ol>`
        )}

        ${
          d.say.length
            ? block(
                'TRY SAYING…',
                `<ul class="say-list">${d.say
                  .map((x) => `<li>${esc(x)}</li>`)
                  .join('')}</ul>`
              )
            : ''
        }

        ${block('YOU’LL NEED', list(q.need, 'need-list'))}

        ${block(
          'WHERE',
          `<p><strong class="where-label">${env.label}${q.nearby ? ' · nearby' : ''}</strong><br>${esc(d.where)}</p>`
        )}

        ${
          d.notes.length
            ? block('A FEW THINGS TO KNOW', list(d.notes, 'notes-list'))
            : ''
        }

        ${block(
          'WHAT COUNTS AS COMPLETE?',
          `<p class="complete-text">✓ ${esc(d.complete)}</p>`,
          'complete-box'
        )}

        ${
          d.variation
            ? block('OPTIONAL VARIATION', `<p>${esc(d.variation)}</p>`)
            : ''
        }
      </div>
    `;
}

function detail(id) {
  const q = questById(id);
  const d = q.detail;
  const f = face(q);
  const locked = !unlocked(q);
  const env = ENVIRONMENTS[q.environment];
  const t = typeInfo(q.type);

  const body = questBody(q);

  return `
    <div class="quest-detail">
      <div class="page-wrap-wide">
        <div class="detail-top">
          ${backLink()}

          <span class="eyebrow">
            SQ / ${q.id.padStart(3, '0')}
          </span>
        </div>

        <div class="detail-hero">
          <div class="detail-copy">
            <span class="eyebrow">
              ${locked ? '🎁 MYSTERY' : `${t.icon} ${q.type}`} /
              ${q.minutes} MIN /
              ${q.difficulty}
            </span>

            <h1>${esc(f.title)}</h1>

            ${
              locked
                ? `<p>${esc(f.description)}</p>`
                : `<p class="type-tagline">${esc(t.tagline)}</p>
                   <p>${esc(q.description)}</p>`
            }

            <div class="detail-meta">
              ${meta(q)}
            </div>

            <div class="detail-actions">
              <button
                class="btn btn-dark btn-xl"
                data-start="${q.id}"
              >
                ${locked ? 'ACCEPT MYSTERY →' : 'START QUEST →'}
              </button>

              <button
                class="btn btn-outline btn-xl"
                data-save="${q.id}"
              >
                ${
                  state.saved.includes(q.id)
                    ? '★ SAVED'
                    : '☆ SAVE FOR LATER'
                }
              </button>

              ${
                !locked && cloud.backend()
                  ? `<button class="btn btn-outline btn-xl" data-act="challenge" data-quest="${q.id}">⚔ CHALLENGE A FRIEND</button>`
                  : ''
              }
            </div>
          </div>

          <div class="detail-image">
            ${locked ? `<span class="detail-symbol">${f.icon}</span>` : visual(q, 'detail-symbol')}
          </div>
        </div>

        ${
          q.questChain && !locked
            ? `<p class="chain-line">⛓ PART ${q.questChain.step} OF ${q.questChain.of} · ${esc(q.questChain.name.toUpperCase())}</p>`
            : ''
        }

        ${body}
      </div>
    </div>
  `;
}

function active(id) {
  /* Deep link / reload while ANOTHER quest is in progress: offer a choice, never overwrite it. */
  if (state.active && state.active.id !== id && allQuests.some((x) => x.id === state.active.id)) return conflictPanel(id);
  reveal(id);
  const q = questById(id);
  const d = q.detail;

  return `
    <div class="active-page">
      <div class="active-inner">
        <div class="active-top">
          ${backLink()}

          <span class="eyebrow">
            ACTIVE SIDEQUEST
          </span>
        </div>

        <div class="active-heading">
          <span class="eyebrow">
            NO. ${q.id.padStart(3, '0')} / ${q.category}
          </span>

          <h1>${esc(q.title)}</h1>
        </div>

        <div class="active-columns">
          <section>
            <div class="mission-card active-mission">
              <span class="eyebrow">YOUR MISSION</span>
              <p class="mission-text">${esc(d.mission)}</p>
            </div>

            <span class="eyebrow">
              THE QUEST
            </span>

            <ol class="step-list">
              ${q.steps
                .map((x) => `<li>${esc(x)}</li>`)
                .join('')}
            </ol>

            ${
              d.say.length
                ? `<span class="eyebrow">TRY SAYING…</span>
                   <ul class="say-list">${d.say
                     .map((x) => `<li>${esc(x)}</li>`)
                     .join('')}</ul>`
                : ''
            }

            <p class="complete-text">✓ ${esc(d.complete)}</p>
          </section>

          <aside>
            <div class="timer-panel">
              <span class="eyebrow">
                ESTIMATED TIME
              </span>

              <strong id="timer" data-minutes="${q.minutes}" role="timer" aria-live="off">
                ${String(q.minutes).padStart(2, '0')}:00
              </strong>

              <div class="timer-bar" aria-hidden="true"><i id="timer-fill"></i></div>

              <p class="muted" id="timer-note">
                You don't have to rush.
                The timer is just a suggestion.
              </p>
            </div>

            ${
              d.notes.length
                ? `<div class="notes-panel">
                     <span class="eyebrow">KEEP IN MIND</span>
                     ${list(d.notes, 'notes-list')}
                   </div>`
                : ''
            }
          </aside>
        </div>

        <div class="active-footer">
          <button
            class="btn btn-dark btn-xl"
            data-complete="${q.id}"
          >
            I'M DONE ✓
          </button>

          <button
            class="btn btn-outline btn-xl"
            data-abandon
            data-act="abandon"
          >
            ABANDON QUEST
          </button>
        </div>
      </div>
    </div>
  `;
}

/* ---------------- Completion / reflection ---------------- */
const AGAIN = [['yes', 'YES'], ['maybe', 'MAYBE'], ['no', 'NOT REALLY']];

function notifPrompt() {
  const n = state.prefs.notif;
  const day = 14 * 86400000;
  if (!notify.supported() || !['default', 'granted'].includes(notify.permission()) || n.enabled) return '';
  if (Date.now() - (state.prefs.asked || 0) < day) return '';
  return `
    <div class="notif-prompt" role="region" aria-label="Reminders">
      <div>
        <strong>Want a nudge for tomorrow’s SideQuest?</strong>
        <p>One gentle reminder a day at most. Turn it off any time in Settings.</p>
      </div>
      <div class="notif-prompt-actions">
        <button class="btn btn-dark btn-sm" data-act="notif-enable">REMIND ME</button>
        <button class="btn btn-outline btn-sm" data-act="notif-later">NOT NOW</button>
      </div>
    </div>`;
}

function complete(id) {
  const q = questById(id);
  const e = entryFor(id) || {};
  const today = todayKey();
  const wasDaily = state.dailyDone[today] === id;
  const streak = dailyStreak(state);

  /* Honest rewards: only count a skill / category if it's genuinely new. */
  const others = state.completed.filter((c) => c.id !== id).map((c) => questById(c.id));
  const newSkill = !others.some((o) => o.skill === q.skill);
  const newCat = !others.some((o) => o.category === q.category);

  const next = q.questChain
    ? quests.find((x) => x.questChain?.name === q.questChain.name && x.questChain.step === q.questChain.step + 1 && !entryFor(x.id))
    : null;

  return `
    <div class="complete-page">
      <div class="confetti" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
      <div class="complete-inner">
        <div class="completion-art">
          <b class="completion-emoji" role="img" aria-label="${esc(q.title)}">${esc(icon(q))}</b>
          <span>QUEST CLEAR</span>
          <em class="completion-no">NO. ${q.id.padStart(3, '0')}</em>
        </div>

        <span class="eyebrow">
          SIDEQUEST COMPLETE
        </span>

        <h1>
          YOU DID<br>
          <em>THE THING.</em>
        </h1>

        <p>
          ${esc(q.title)}. ${wasDaily ? 'Today’s SideQuest is in the bag.' : 'Nice one.'}
        </p>

        ${wasDaily && streak > 1 ? streakBadge(streak, 'full') : ''}

        <div class="reward-list" aria-label="What you collected">
          <div class="reward-tile earned">
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.7 2.7L16.3 9.5"/></svg>
            <strong>+1</strong>
            <span>QUEST</span>
          </div>

          <div class="reward-tile ${newSkill ? 'earned' : ''}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18"/></svg>
            <strong>${newSkill ? '+1' : '—'}</strong>
            <span>${newSkill ? 'NEW SKILL' : 'SKILL LEVELLED'}</span>
          </div>

          <div class="reward-tile ${newCat ? 'earned' : ''}">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/></svg>
            <strong>${newCat ? '+1' : '—'}</strong>
            <span>${newCat ? 'NEW CATEGORY' : 'CATEGORY'}</span>
          </div>
        </div>

        <div class="reflection">
          <span class="eyebrow">
            HOW DID IT GO?
          </span>

          <div class="reflection-options" role="group" aria-label="How did it go?">
            ${[['Couldn\'t do it', 'COULDN’T DO IT'], ['Almost', 'ALMOST'], ['Nailed it', 'NAILED IT']]
              .map(([v, l], i) => `<button data-reflect="${esc(v)}" aria-pressed="${e.reflection === v}" class="${e.reflection === v ? 'active' : ''}"><i class="rf-mark" aria-hidden="true">${i + 1}</i><span>${l}</span></button>`)
              .join('')}
          </div>

          <span class="eyebrow reflect-gap">WOULD YOU DO IT AGAIN?</span>
          <div class="reflection-options again-options" role="group" aria-label="Would you do it again?">
            ${AGAIN.map(([v, l], i) => `<button data-again="${v}" aria-pressed="${e.again === v}" class="${e.again === v ? 'active' : ''}"><i class="rf-mark" aria-hidden="true">${i + 1}</i><span>${l}</span></button>`).join('')}
          </div>

          <details class="reflect-note" ${e.surprise || e.learned ? 'open' : ''}>
            <summary>Add a quick note (optional)</summary>
            <label for="note-surprise">What surprised you?</label>
            <input id="note-surprise" data-note="surprise" maxlength="100" value="${esc(e.surprise || '')}" placeholder="Anything. A few words is plenty." />
            <label for="note-learned">What did you learn?</label>
            <input id="note-learned" data-note="learned" maxlength="100" value="${esc(e.learned || '')}" placeholder="Totally optional." />
          </details>
        </div>

        ${
          next
            ? `<p class="chain-next">⛓ NEXT IN “${esc(q.questChain.name.toUpperCase())}”: <a href="#/quest/${next.id}">${esc(unlocked(next) ? next.title : 'Mystery SideQuest')}</a></p>`
            : ''
        }

        ${notifPrompt()}

        <button
          class="btn btn-lime btn-xl"
          style="margin-top:25px"
          data-completion-card="${q.id}"
        >
          CREATE MY SIDEQUEST CARD →
        </button>

        <button class="btn btn-outline btn-lg complete-again" data-go="/roll">
          ✣ ROLL ANOTHER
        </button>
      </div>
    </div>
  `;
}

/* ---------------- Clear Card ---------------- */
function card(id) {
  const q = questById(id);
  const e = entryFor(id);

  return `
    <div class="card-page">
      <div class="page-wrap-wide">
        <div class="card-page-top">
          ${backLink()}

          <span class="eyebrow">
            SIDEQUEST CLEAR
          </span>
        </div>

        <div class="card-page-layout">
          <div class="card-page-copy">
            <span class="eyebrow">
              ONE MORE THING YOU CAN DO NOW
            </span>

            <h1>
              KEEP<br>
              THE<br>
              RECEIPT.
            </h1>

            <p class="muted">
              Save the card, share it, or add this quest
              to your showcase.
            </p>

            <div class="card-controls">
              <button
                class="btn btn-dark btn-lg"
                data-download-card
              >
                ↓ SAVE CARD IMAGE
              </button>

              <button class="btn btn-lime btn-lg" data-act="share-card">
                ${canNativeShare() ? '↗ SHARE' : '⧉ COPY SUMMARY'}
              </button>

              <button
                class="btn btn-outline btn-lg"
                data-showcase="${q.id}"
                ${e ? '' : 'disabled'}
              >
                ADD TO SHOWCASE
              </button>
            </div>
            ${e ? '' : '<p class="muted">Complete this quest to add it to your showcase.</p>'}
          </div>

          <div class="clear-card-frame" id="share-card">
            <canvas id="clear-canvas" role="img"
              aria-label="SideQuest Clear Card: ${esc(q.title)}"></canvas>
          </div>
        </div>
      </div>
    </div>
  `;
}

function cardData(id) {
  const q = questById(id);
  const e = entryFor(id);
  const sorted = [...state.completed].sort((a, b) => (a.date || 0) - (b.date || 0));
  const idx = e ? sorted.findIndex((c) => c.id === id) + 1 : sorted.length + 1;
  return { quest: q, entry: e, number: idx, icon: q.icon };
}

async function paintCard() {
  const c = $('#clear-canvas');
  if (!c) return;
  const id = route().split('/')[2];
  await drawClearCard(c, cardData(id));
}

function myQuests() {
  const saved = state.saved.map(questById);
  const done = state.completed.map(
    (c) => questById(c.id)
  );

  return `
    <div class="list-page">
      <div class="page-wrap-wide">
        <div class="section-back">${backLink()}</div>
        <section class="page-heading">
          <span class="eyebrow">
            YOUR SIDEQUESTS
          </span>

          <h1>
            THINGS YOU<br>
            <em>KEPT.</em>
          </h1>

          <p>
            Your saved and completed quests live here.
          </p>
          <div class="sync-callout">
            <strong>KEEP YOUR STORY WITH YOU.</strong>
            <span>Sign in only if you want your quests and progress on another device.</span>
            ${cloud.signedIn() ? '<span class="sync-ok">✓ SYNCING ACROSS DEVICES</span>' : '<a href="#/account">OPTIONAL: SAVE TO AN ACCOUNT →</a>'}
          </div>
        </section>

        <section class="list-section">
          <div class="list-heading">
            <h2>SAVED</h2>
            <span class="eyebrow">
              ${saved.length}
            </span>
          </div>

          <div class="completed-list">
            ${
              saved.length
                ? saved.map(questCard).join('')
                : '<p class="muted">Nothing saved yet. Find something weird.</p>'
            }
          </div>
        </section>

        <section class="list-section">
          <div class="list-heading">
            <h2>COMPLETED</h2>
            <span class="eyebrow">
              ${done.length}
            </span>
          </div>

          <div class="completed-list">
            ${
              done.length
                ? done
                    .map(
                      (q) => `
                        <div class="mini-card">
                          <div class="icon">
                            ${icon(q)}
                          </div>

                          <span class="eyebrow">
                            ${typeInfo(q.type).icon} ${q.type} / ${q.minutes} MIN
                          </span>

                          <h3>
                            ${esc(q.title)}
                          </h3>

                          <button
                            class="btn btn-dark btn-sm"
                            data-completion-card="${q.id}"
                          >
                            VIEW CARD
                          </button>
                        </div>
                      `
                    )
                    .join('')
                : '<p class="muted">Your first completed quest will appear here.</p>'
            }
          </div>
        </section>
      </div>
    </div>
  `;
}

function myProfile() {
  const skills = [
    ...new Map(
      state.completed.map((c) => {
        const q = questById(c.id);
        return [q.skill, q];
      })
    ).values()
  ];

  const cats = new Set(
    state.completed.map(
      (c) => questById(c.id)?.category
    )
  ).size;

  return `
    <div>
      <section class="progress-cover">
        <div class="page-wrap-wide">
          ${profileTabs('/progress')}
          <span class="eyebrow">
            YOUR STORY SO FAR
          </span>

          <h1>
            THE THINGS<br>
            YOU CAN DO<span>.</span>
          </h1>

          <div class="profile-stats">
            <div>
              <strong>${state.completed.length}</strong>
              <span>QUESTS COMPLETED</span>
            </div>

            <div>
              <strong>${skills.length}</strong>
              <span>SKILLS UNLOCKED</span>
            </div>

            <div>
              <strong>${cats}</strong>
              <span>CATEGORIES EXPLORED</span>
            </div>
          </div>
          ${(() => {
            const s = dailyStreak(state);
            return streakBadge(s, 'full');
          })()}
        </div>
      </section>

      <section class="progress-content">
        <div class="page-wrap-wide">
          ${(() => {
            const counts = {};
            state.completed.forEach((c) => { const t = questById(c.id).type; counts[t] = (counts[t] || 0) + 1; });
            const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            return rows.length
              ? `<div class="list-heading"><h2>YOUR FLAVOURS</h2><span class="eyebrow">${rows.length} TYPES</span></div>
                 <div class="flavours">${rows.map(([t, n]) => `<span class="flavour" style="--accent:${typeColor(t)}">${typeInfo(t).icon} ${t} <b>×${n}</b></span>`).join('')}</div>`
              : '';
          })()}
          <div class="list-heading">
            <h2>THINGS I CAN DO NOW</h2>
            <span class="eyebrow">
              ${skills.length} SKILLS
            </span>
          </div>

          <div class="skills-grid">
            ${
              skills.length
                ? skills
                    .map(
                      (q) => `
                        <div class="skill-tile">
                          <span class="skill-tile-icon">
                            ${icon(q)}
                          </span>

                          <strong>
                            ${esc(q.skill)}
                          </strong>

                          <small>
                            ${q.category.toUpperCase()}
                          </small>
                        </div>
                      `
                    )
                    .join('')
                : '<p class="muted">Complete a quest and your first skill unlocks here.</p>'
            }
          </div>
        </div>
      </section>
    </div>
  `;
}

/* ---------------- Community: avatars, post tiles, feeds ---------------- */
const AVATAR_GLYPH = {
  sun: '✺', bolt: 'ϟ', leaf: '❦', wave: '≈', star: '★', moon: '☾',
  fox: '🦊', owl: '🦉', cat: '🐱', frog: '🐸', crab: '🦀', ghost: '👻', rocket: '🚀', cactus: '🌵', pizza: '🍕',
  comet: '☄️', mushroom: '🍄', robot: '🤖', ufo: '🛸', gem: '💎', flame: '🔥', cloud: '☁️', dino: '🦖', bee: '🐝'
};
const AVATARS = Object.keys(AVATAR_GLYPH);
const avatarEl = (p, cls = '') =>
  `<span class="avatar ${cls} av-${esc(p.avatar || 'none')}" aria-hidden="true">${AVATAR_GLYPH[p.avatar] || esc((p.displayName || p.username || '?').slice(0, 1).toUpperCase())}</span>`;
const newFeed = () => ({ posts: [], next: null, loading: false, loaded: false, error: '' });
const offlineMsg = 'You’re offline. Check your connection and try again.';

function postTile(po, { author = true, remove = false } = {}) {
  const q = questById(po.questId);
  const known = q && q.id === po.questId;
  const accent = known ? typeColor(q.type) : '#d7f05a';
  const signed = cloud.signedIn() && cloud.backend();
  return `
    <article class="showcase-tile showcase-post post-card" style="--accent:${accent}">
      <div class="post-banner">
        <span class="post-icon" aria-hidden="true">${known ? icon(q) : '✳'}</span>
        ${known ? `<span class="post-type">${typeInfo(q.type).icon} ${esc(q.type.toUpperCase())}</span>` : ''}
      </div>
      <div class="post-body">
        <h2>${esc(known ? q.title : 'A SideQuest')}</h2>
        ${po.reflection ? `<span class="post-reflection">${esc(po.reflection)}</span>` : ''}
        ${po.note ? `<p class="post-note">“${esc(po.note)}”</p>` : ''}
        <span class="eyebrow">${known ? `${esc(q.skill)} · ` : ''}${new Date(po.completedAt).toLocaleDateString()}</span>
      </div>
      ${author ? `<a class="post-author" href="#/u/${esc(po.author.username)}">${avatarEl(po.author, 'avatar-xs')}<span><strong>${esc(po.author.displayName)}</strong> <small>@${esc(po.author.username)}</small></span></a>` : ''}
      <div class="post-actions">
        <button class="link-btn" data-act="share-post" data-u="${esc(po.author.username)}" data-q="${esc(po.questId)}">Share</button>
        ${known ? `<a class="link-btn" href="#/quest/${esc(po.questId)}">Try it</a>` : ''}
        ${known && signed && !remove ? `<button class="link-btn" data-act="challenge" data-quest="${esc(po.questId)}">Challenge a friend</button>` : ''}
        ${remove ? `<button class="link-btn danger-link" data-act="showcase-unpublish" data-pid="${po.id}" data-q="${esc(po.questId)}">Unpublish</button>` : ''}
      </div>
    </article>`;
}

function feedBlock(f, key, emptyHtml, opts = {}) {
  if (f.error && !f.posts.length)
    return `<div class="panel panel-note"><p role="alert">${esc(f.error)}</p><button class="btn btn-dark btn-md" data-act="feed-retry" data-k="${key}">TRY AGAIN</button></div>`;
  if (!f.loaded) return '<p class="muted" role="status">Loading…</p>';
  if (!f.posts.length) return emptyHtml;
  return `
    <div class="showcase-grid">${f.posts.map((po) => postTile(po, { ...opts, remove: opts.remove ?? po.mine })).join('')}</div>
    ${f.error ? `<p class="form-error" role="alert">${esc(f.error)} <button class="link-btn" data-act="feed-retry" data-k="${key}">Retry</button></p>` : ''}
    ${f.next
      ? `<div class="feed-more"><button class="btn btn-outline btn-lg" data-act="feed-more" data-k="${key}" ${f.loading ? 'disabled' : ''}>${f.loading ? 'LOADING…' : 'LOAD MORE'}</button></div>`
      : '<p class="muted end-note">That’s everything so far.</p>'}`;
}
const feedFor = (key) => (key === 'profile' ? ui.profile.feed : ui.showcase[key]);

async function loadFeed(feed, fetcher, { more = false } = {}) {
  if (feed.loading) return;
  feed.loading = true;
  feed.error = '';
  if (more) rerenderIfSafe();
  const r = await fetcher(more ? feed.next : null);
  feed.loading = false;
  if (!r.ok) feed.error = r.status === 0 ? offlineMsg : r.data.error || 'Couldn’t load right now.';
  else {
    const seen = new Set(more ? feed.posts.map((x) => x.id) : []);
    feed.posts = [...(more ? feed.posts : []), ...r.data.posts.filter((x) => !seen.has(x.id))];
    feed.next = r.data.next;
    feed.loaded = true;
  }
  rerenderIfSafe();
}
async function loadMine() {
  const m = ui.showcase.mine;
  if (m.loading) return;
  await loadFeed(m, (c) => cloud.getShowcase({ mine: true, cursor: c }));
  for (let i = 0; i < 10 && m.next && !m.error; i++) await loadFeed(m, (c) => cloud.getShowcase({ mine: true, cursor: c }), { more: true });
}
function ensureShowcase() {
  if (!ui.backendChecked || !cloud.backend()) return;
  const sc = ui.showcase;
  if (sc.tab === 'community' && !sc.community.loaded && !sc.community.loading && !sc.community.error)
    loadFeed(sc.community, (c) => cloud.getShowcase({ cursor: c }));
  if (sc.tab === 'mine' && cloud.signedIn() && !sc.mine.loaded && !sc.mine.loading && !sc.mine.error) loadMine();
}

function showcase() {
  const sc = ui.showcase;
  const be = cloud.backend();
  const signed = cloud.signedIn();
  const tabs = `
    <div class="seg" role="tablist" aria-label="Showcase">
      <button role="tab" aria-selected="${sc.tab === 'community'}" class="${sc.tab === 'community' ? 'active' : ''}" data-act="showcase-tab" data-v="community">COMMUNITY</button>
      <button role="tab" aria-selected="${sc.tab === 'mine'}" class="${sc.tab === 'mine' ? 'active' : ''}" data-act="showcase-tab" data-v="mine">MY POSTS</button>
    </div>`;
  let body;
  if (!ui.backendChecked) body = '<p class="muted" role="status">Looking for the SideQuest server…</p>';
  else if (!be) body = unavailable('The community Showcase');
  else if (sc.tab === 'community') {
    body = feedBlock(sc.community, 'community', `
      <div class="panel panel-note">
        <span class="eyebrow">NOTHING HERE YET</span>
        <h2>Nobody has shared a quest yet.</h2>
        <p>Finish a quest, then publish it from <strong>My posts</strong>. You’ll be the first thing people see here.</p>
        <button class="btn btn-dark btn-md" data-act="showcase-tab" data-v="mine">GO TO MY POSTS →</button>
      </div>`);
  } else if (!signed) body = needSignIn('Sharing to the Showcase');
  else {
    const m = sc.mine;
    const published = new Set(m.posts.map((x) => x.questId));
    const ready = m.loaded ? state.completed.filter((c) => !published.has(c.id) && questById(c.id)).sort((x, y) => (y.date || 0) - (x.date || 0)) : [];
    body = `
      <div class="panel panel-note">
        <span class="eyebrow">YOU DECIDE WHAT’S PUBLIC</span>
        <p>Only quests you publish here appear in the community. People see your display name, @username, the quest, and your “how did it go” answer. Your private notes and the rest of your progress are never shown.</p>
      </div>
      <h2 class="feed-title">PUBLISHED</h2>
      ${feedBlock(m, 'mine', '<p class="muted">You haven’t published anything yet.</p>', { remove: true })}
      ${ready.length ? `<h2 class="feed-title">READY TO SHARE</h2>
        <div class="ready-grid">${ready.map((c) => { const q = questById(c.id); const d = ui.showcase.drafts?.[c.id] || ''; const busy = ui.showcase.busy === c.id; return `
          <div class="ready-card" style="--accent:${typeColor(q.type)}">
            <span class="ready-icon" aria-hidden="true">${icon(q)}</span>
            <div class="ready-main">
              <strong>${esc(q.title)}</strong><small>Finished ${new Date(c.date).toLocaleDateString()}${c.reflection ? ` · ${esc(c.reflection)}` : ''}</small>
              <label class="sr-only" for="pub-${esc(c.id)}">Optional note for the Showcase</label>
              <textarea id="pub-${esc(c.id)}" data-draft="${esc(c.id)}" maxlength="140" rows="2" placeholder="Add a line about how it went (optional, public)">${esc(d)}</textarea>
              <button class="btn btn-dark btn-sm" data-act="showcase-publish" data-q="${esc(c.id)}" ${ui.showcase.busy ? 'disabled' : ''}>${busy ? 'PUBLISHING…' : 'PUBLISH TO SHOWCASE'}</button>
            </div>
          </div>`; }).join('')}</div>` : ''}`;
  }

  return `
    <div class="list-page">
      <div class="page-wrap-wide">
        <div class="section-back">${backLink()}</div>
        <section class="page-heading">
          <span class="eyebrow">THE SHOWCASE</span>
          <h1>THINGS PEOPLE<br><em>ACTUALLY DID.</em></h1>
          <p>Small skills, strange experiments and tiny wins worth remembering.</p>
        </section>
        <div class="feed-toolbar">${tabs}${be ? '<button class="btn btn-outline btn-sm" data-act="feed-refresh">REFRESH ↻</button>' : ''}</div>
        ${body}
      </div>
    </div>`;
}

/* ---------------- Dedicated login / signup ---------------- */
function validateAuth(signup, d) {
  const e = {};
  const u = String(d.username || '').trim().toLowerCase();
  if (!u) e.username = 'Enter your username.';
  else if (signup && !/^[a-z0-9_]{3,20}$/.test(u)) e.username = 'Use 3–20 characters: letters, numbers or underscores.';
  const pw = String(d.password || '');
  if (!pw) e.password = signup ? 'Choose a password.' : 'Enter your password.';
  else if (signup && pw.length < 8) e.password = 'Use at least 8 characters.';
  else if (pw.length > 128) e.password = 'That’s a bit long. Keep it under 128 characters.';
  if (signup) {
    if (!d.confirm) e.confirm = 'Type the password again.';
    else if (d.confirm !== pw) e.confirm = 'The passwords don’t match.';
  }
  return e;
}

const field = ({ id, name, label, type = 'text', value = '', autocomplete = 'off', err = '', extra = '', hint = '' }) => `
  <div class="field ${err ? 'has-error' : ''}">
    <label for="${id}">${label}</label>
    <div class="field-input">
      <input id="${id}" name="${name}" type="${type}" value="${esc(value)}" autocomplete="${autocomplete}" ${err ? `aria-invalid="true" aria-describedby="${id}-err"` : hint ? `aria-describedby="${id}-hint"` : ''} ${extra} />
      ${type === 'password' ? '<button type="button" class="pw-toggle" data-act="pw-toggle" aria-pressed="false" aria-label="Show password">SHOW</button>' : ''}
    </div>
    ${hint && !err ? `<small class="hint" id="${id}-hint">${hint}</small>` : ''}
    ${err ? `<small class="field-error" id="${id}-err" role="alert">${esc(err)}</small>` : ''}
  </div>`;

function authPage(mode) {
  const signup = mode === 'signup';
  const a = ui.account;
  const err = a.errors || {};
  const guest = `
    <div class="auth-guest">
      <a class="btn btn-outline btn-lg" href="#/">CONTINUE AS GUEST</a>
      <p class="muted">No account needed. Your quests stay on this device, and you can create an account later without losing anything.</p>
    </div>`;
  let panel;
  if (!ui.backendChecked) panel = '<div class="panel"><p class="muted" role="status">Looking for the SideQuest server…</p></div>';
  else if (!cloud.backend()) panel = `${unavailable('Accounts')}${guest}`;
  else if (cloud.signedIn()) {
    const u = cloud.getAccount().user;
    panel = `<div class="panel"><span class="eyebrow">YOU’RE SIGNED IN</span><h2>Hi, ${esc(u.displayName)}.</h2>
      <div class="panel-actions"><a class="btn btn-dark btn-lg" href="#/">BACK TO SIDEQUEST →</a><a class="btn btn-outline btn-lg" href="#/account">MY ACCOUNT</a></div></div>`;
  } else {
    panel = `
      <form class="panel auth-form" data-form="auth" data-mode="${signup ? 'signup' : 'signin'}" novalidate>
        <h2>${signup ? 'Create your account' : 'Welcome back'}</h2>
        ${a.error ? `<p class="form-error" role="alert">${esc(a.error)}</p>` : ''}
        ${field({ id: 'au', name: 'username', label: 'Username', value: a.form?.username || '', autocomplete: 'username', err: err.username, extra: 'autocapitalize="none" spellcheck="false" maxlength="20"', hint: signup ? '3–20 characters: a–z, 0–9 and _. Friends find you by this.' : '' })}
        ${signup ? field({ id: 'ad', name: 'displayName', label: 'Display name <span class="muted">(optional)</span>', value: a.form?.displayName || '', autocomplete: 'nickname', err: err.displayName, extra: 'maxlength="30"' }) : ''}
        ${field({ id: 'ap', name: 'password', label: 'Password', type: 'password', autocomplete: signup ? 'new-password' : 'current-password', err: err.password, hint: signup ? 'At least 8 characters.' : '' })}
        ${signup ? field({ id: 'ac', name: 'confirm', label: 'Confirm password', type: 'password', autocomplete: 'new-password', err: err.confirm }) : ''}
        <button class="btn btn-dark btn-xl" type="submit" ${a.busy ? 'disabled aria-busy="true"' : ''}>${a.busy ? 'ONE SEC…' : signup ? 'CREATE ACCOUNT →' : 'SIGN IN →'}</button>
        <p class="auth-switch">${signup ? 'Already have an account? <a href="#/login">Sign in</a>' : 'New here? <a href="#/signup">Create an account</a>'}</p>
        <p class="muted">${signup ? 'There’s no email on SideQuest, so there’s no password reset yet. Keep your password somewhere safe.' : 'Everything on this device is kept and merged in. Nothing gets overwritten.'}</p>
      </form>
      ${guest}`;
  }
  return `
    <div class="auth-page">
      <aside class="auth-aside">
        <a class="auth-back" href="#/">← Back to SideQuest</a>
        <span class="eyebrow">${signup ? 'JOIN IN' : 'WELCOME BACK'}</span>
        <h1>${signup ? 'KEEP YOUR<br>STORY<span>.</span>' : 'PICK UP<br>WHERE YOU<br>LEFT OFF<span>.</span>'}</h1>
        <p>${signup ? 'Sync your quests across devices, add friends, challenge them and share what you did.' : 'Your quests, your streak and your friends are waiting.'}</p>
      </aside>
      <section class="auth-main">${panel}</section>
    </div>`;
}

/* ---------------- Public profile ---------------- */
function profilePage(username) {
  const p = ui.profile;
  let body;
  if (!ui.backendChecked || p.status === 'idle' || p.status === 'loading') body = '<p class="muted" role="status">Loading profile…</p>';
  else if (!cloud.backend()) body = unavailable('Public profiles');
  else if (p.status === 'missing')
    body = `<div class="panel panel-note"><span class="eyebrow">NOT FOUND</span><h2>There’s no SideQuester called @${esc(username)}.</h2><p>They may have changed their account, or the link might have a typo.</p><a class="btn btn-dark btn-md" href="#/showcase">BROWSE THE SHOWCASE →</a></div>`;
  else if (p.status === 'private')
    body = `<div class="panel panel-note"><span class="eyebrow">PRIVATE PROFILE</span><h2>@${esc(username)} keeps their profile private.</h2><a class="btn btn-dark btn-md" href="#/showcase">BROWSE THE SHOWCASE →</a></div>`;
  else if (p.status === 'error')
    body = `<div class="panel panel-note"><p role="alert">${esc(p.error)}</p><button class="btn btn-dark btn-md" data-act="profile-retry">TRY AGAIN</button></div>`;
  else {
    const pr = p.data;
    const f = p.friendship;
    const u = esc(pr.username);
    const signed = cloud.signedIn();
    let friendBtns = '';
    if (f === 'self') friendBtns = '<a class="btn btn-outline btn-md" href="#/account">EDIT MY PROFILE</a>';
    else if (!signed) friendBtns = `<a class="btn btn-dark btn-md" href="#/login" data-act="set-next" data-next="/u/${u}">SIGN IN TO ADD FRIEND</a>`;
    else if (f === 'none') friendBtns = `<button class="btn btn-dark btn-md" data-act="pf-add" data-u="${u}" ${p.busy ? 'disabled' : ''}>ADD FRIEND</button>`;
    else if (f === 'outgoing') friendBtns = `<span class="pill">REQUEST SENT</span><button class="btn btn-outline btn-md" data-act="pf-cancel" data-u="${u}">CANCEL REQUEST</button>`;
    else if (f === 'incoming') friendBtns = `<button class="btn btn-dark btn-md" data-act="pf-respond" data-u="${u}" data-v="1" aria-label="Accept friend request from @${u}">ACCEPT REQUEST</button><button class="btn btn-reject btn-md" data-act="pf-respond" data-u="${u}" data-v="0" aria-label="Reject friend request from @${u}">REJECT</button>`;
    else if (f === 'friends') friendBtns = `<span class="pill">FRIENDS ✓</span><a class="btn btn-lime btn-md" href="#/challenge/new" data-act="chal-friend" data-u="${u}">CHALLENGE</a><button class="link-btn danger-link" data-act="pf-remove" data-u="${u}">Remove friend</button>`;
    const posts = p.feed.posts;
    const tc = {};
    posts.forEach((x) => { const t = questById(x.questId)?.type; if (t) tc[t] = (tc[t] || 0) + 1; });
    const vibe = Object.entries(tc).sort((a, b) => b[1] - a[1])[0];
    const newest = posts[0];
    const nq = newest ? questById(newest.questId) : null;
    body = `
      <section class="pp-hero pp-card">
        <div class="pp-banner av-${esc(pr.avatar || 'none')}" aria-hidden="true"></div>
        <div class="pp-id">
          ${avatarEl(pr, 'avatar-xl')}
          <div>
            <h1>${esc(pr.displayName)}</h1>
            <p class="muted">@${u} · joined ${new Date(pr.joined).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</p>
          </div>
        </div>
        <p class="pp-bio">${pr.bio ? esc(pr.bio) : '<span class="muted">No bio yet.</span>'}</p>
        <div class="pp-chips">
          <span class="chip"><b>${pr.stats.shared}</b> quest${pr.stats.shared === 1 ? '' : 's'} shared</span>
          ${vibe && p.feed.loaded && !p.feed.next ? `<span class="chip">${typeInfo(vibe[0]).icon} Mostly ${esc(vibe[0])}</span>` : ''}
        </div>
        <div class="pp-actions">${friendBtns}
          <button class="btn btn-outline btn-md" data-act="share-profile" data-u="${u}" data-n="${esc(pr.displayName)}">SHARE PROFILE</button>
          ${signed && f !== 'self' ? `<button class="link-btn" data-act="pf-report" data-u="${u}">Report</button><button class="link-btn danger-link" data-act="pf-block" data-u="${u}">Block</button>` : ''}
        </div>
      </section>
      ${nq ? `<section class="pp-highlight" style="--accent:${typeColor(nq.type)}" aria-label="Latest shared quest"><span class="post-icon" aria-hidden="true">${icon(nq)}</span><div><span class="eyebrow">LATEST SHARED QUEST</span><h2>${esc(nq.title)}</h2>${newest.note ? `<p class="post-note">“${esc(newest.note)}”</p>` : `<p class="muted">${esc(nq.description)}</p>`}<a class="btn btn-dark btn-sm" href="#/quest/${esc(nq.id)}">TRY IT YOURSELF →</a></div></section>` : ''}
      <h2 class="feed-title">SHARED QUESTS</h2>
      ${feedBlock(p.feed, 'profile', `<p class="muted">${f === 'self' ? 'You haven’t published anything yet. Share a finished quest from the Showcase page.' : `${esc(pr.displayName)} hasn’t shared anything yet.`}</p>`, { author: false, remove: f === 'self' })}`;
  }
  return `<div class="list-page profile-page"><div class="page-wrap-wide">${backLink()}${body}</div></div>`;
}

function ensureProfile(username) {
  if (ui.profile.username !== username) ui.profile = { username, status: 'idle', data: null, friendship: 'none', feed: newFeed(), busy: false };
  if (!ui.backendChecked || !cloud.backend()) return;
  if (ui.profile.status === 'idle') loadProfile(username);
}
async function loadProfile(username) {
  const p = ui.profile;
  p.status = 'loading';
  const r = await cloud.getProfile(username);
  if (ui.profile !== p) return;                       // navigated elsewhere meanwhile
  if (r.ok) { p.status = 'ok'; p.data = r.data.profile; p.friendship = r.data.friendship; }
  else if (r.status === 404) p.status = 'missing';
  else if (r.status === 403 && r.data.code === 'private') p.status = 'private';
  else { p.status = 'error'; p.error = r.status === 0 ? offlineMsg : r.data.error || 'Couldn’t load this profile.'; }
  rerenderIfSafe();
  if (p.status === 'ok') loadFeed(p.feed, (c) => cloud.getProfilePosts(username, c));
}
const reloadProfile = () => { ui.profile = { username: '', status: 'idle' }; render(); };

/* ---------------- Profile hub (tabs) ---------------- */
/* Section screens get ONE contextual back link instead of a tab strip: the Profile hub is the menu. */
function profileTabs() {
  return backLink('cover-back');
}

const unavailable = (what) => navigator.onLine === false ? `
  <div class="panel panel-note">
    <span class="eyebrow">OFFLINE</span>
    <h2>${what} needs a connection.</h2>
    <p>You’re offline right now. Your quests are saved on this device and everything else keeps working. This will come back when you’re online again.</p>
  </div>` : `
  <div class="panel panel-note">
    <span class="eyebrow">☁ NOT CONNECTED</span>
    <h2>${what} needs the SideQuest server.</h2>
    <p>
      This copy of SideQuest is running as a standalone site, so everything works
      on this device but accounts, sync, friend challenges and background
      notifications are switched off. Nothing is lost; your quests are saved locally.
    </p>
    <p class="muted">Running <code>node server.mjs</code> serves the app and the API together.</p>
  </div>`;

const needSignIn = (what) => `
  <div class="panel panel-note">
    <span class="eyebrow">👤 SIGN IN</span>
    <h2>${what} needs an account.</h2>
    <p>Create a free account to sync your quests across devices and challenge friends. Your local progress is kept and merged in.</p>
    <a class="btn btn-dark btn-lg" href="#/login" data-act="set-next" data-next="${route()}">SIGN IN</a>
    <a class="btn btn-outline btn-lg" href="#/signup" data-act="set-next" data-next="${route()}">CREATE ACCOUNT</a>
  </div>`;

/* ---------------- Account ---------------- */
const ago = (t) => {
  if (!t) return '';
  const s = Math.round((Date.now() - t) / 1000);
  return s < 10 ? 'just now' : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
};

function accountView() {
  const be = cloud.backend();
  const acct = cloud.getAccount();
  const a = ui.account;
  let body = '';

  if (!ui.backendChecked) {
    body = `<div class="panel"><p class="muted">Looking for the SideQuest server…</p></div>`;
  } else if (!be) {
    body = unavailable('Accounts');
  } else if (a.pending) {
    body = `
      <div class="panel panel-note">
        <span class="eyebrow">⚠ DIFFERENT ACCOUNT</span>
        <h2>This device has quests from another account.</h2>
        <p>You’re signing in as <strong>@${esc(a.pending)}</strong>, but the progress on this device was last linked to <strong>@${esc(localStorage.getItem('sidequest-last-user') || 'someone else')}</strong>.</p>
        <div class="panel-actions">
          <button class="btn btn-dark btn-lg" data-act="account-merge">MERGE INTO @${esc(a.pending.toUpperCase())}</button>
          <button class="btn btn-outline btn-lg" data-act="account-fresh">START WITH @${esc(a.pending.toUpperCase())}’S CLOUD DATA ONLY</button>
        </div>
        <p class="muted">A backup of this device’s data is kept either way.</p>
      </div>`;
  } else if (acct?.token) {
    const u = acct.user;
    const st = ui.sync.state;
    const sync =
      st === 'syncing' ? 'Syncing…'
      : st === 'ok' ? `Synced ${ago(ui.sync.last)}`
      : st === 'offline' ? 'Offline. Changes are saved here and will sync when you’re back.'
      : st === 'error' ? 'Couldn’t sync. We’ll retry.'
      : 'Ready';
    body = `
      <div class="panel">
        <div class="profile-card">
          ${avatarEl(u, 'avatar-lg')}
          <div>
            <h2>${esc(u.displayName)}</h2>
            <p class="muted">@${esc(u.username)} · ${u.profilePublic === false ? 'private profile' : 'public profile'}</p>
          </div>
        </div>
        <div class="panel-actions">
          <a class="btn btn-outline btn-md" href="#/u/${esc(u.username)}">VIEW PUBLIC PROFILE</a>
          <button class="btn btn-outline btn-md" data-act="share-profile" data-u="${esc(u.username)}" data-n="${esc(u.displayName)}">SHARE PROFILE</button>
        </div>
        <form class="auth-form profile-form" data-form="profile-edit">
          ${field({ id: 'dn', name: 'displayName', label: 'Display name', value: u.displayName, autocomplete: 'nickname', extra: 'maxlength="30" required' })}
          <div class="field">
            <label for="bio">Bio <span class="muted">(optional, 160 characters)</span></label>
            <div class="field-input"><textarea id="bio" name="bio" maxlength="160" rows="3" placeholder="What are you into?">${esc(u.bio || '')}</textarea></div>
          </div>
          <fieldset class="avatar-pick avatar-grid">
            <legend>Avatar <span class="muted">(pick one, or keep your initial)</span></legend>
            <label class="pick pick-av ${!u.avatar ? 'active' : ''}"><input type="radio" name="avatar" value="" ${!u.avatar ? 'checked' : ''} /><span class="avatar avatar-md av-none" aria-hidden="true">${esc((u.displayName || u.username || '?').slice(0, 1).toUpperCase())}</span><span class="pick-name">initial</span></label>
            ${AVATARS.map((k) => `<label class="pick pick-av ${u.avatar === k ? 'active' : ''}"><input type="radio" name="avatar" value="${k}" ${u.avatar === k ? 'checked' : ''} /><span class="avatar avatar-md av-${k}" aria-hidden="true">${AVATAR_GLYPH[k]}</span><span class="pick-name">${k}</span></label>`).join('')}
          </fieldset>
          <label class="check-row"><input type="checkbox" name="profilePublic" ${u.profilePublic === false ? '' : 'checked'} /> <span><strong>Public profile.</strong> Anyone with your link can see your name, bio and the quests you publish. Turn it off to hide your profile and your Showcase posts.</span></label>
          <button class="btn btn-dark btn-md" type="submit">SAVE PROFILE</button>
        </form>
      </div>

      <div class="panel">
        <span class="eyebrow">PASSWORD</span>
        <form class="auth-form" data-form="password" novalidate>
          ${field({ id: 'pc', name: 'current', label: 'Current password', type: 'password', autocomplete: 'current-password' })}
          ${field({ id: 'pn', name: 'next', label: 'New password', type: 'password', autocomplete: 'new-password', hint: 'At least 8 characters. Changing it signs you out on other devices.' })}
          ${field({ id: 'pm', name: 'confirm', label: 'Confirm new password', type: 'password', autocomplete: 'new-password' })}
          ${a.pwError ? `<p class="form-error" role="alert">${esc(a.pwError)}</p>` : ''}
          <button class="btn btn-outline btn-md" type="submit">CHANGE PASSWORD</button>
        </form>
      </div>

      ${ui.blocks && ui.blocks.length ? `<div class="panel"><span class="eyebrow">BLOCKED PEOPLE</span>${ui.blocks.map((b) => `<div class="friend-row"><span>${esc(b.displayName)} <small>@${esc(b.username)}</small></span><button class="btn btn-outline btn-sm" data-act="unblock" data-u="${esc(b.username)}">UNBLOCK</button></div>`).join('')}</div>` : ''}

      <div class="panel">
        <span class="eyebrow">☁ CLOUD SYNC</span>
        <p class="sync-line"><span class="sync-dot sync-${st}"></span>${sync}</p>
        <p class="muted">Saved quests, completed quests and progress sync across your devices. This device always keeps its own copy too.</p>
        <button class="btn btn-outline btn-md" data-act="account-sync" ${st === 'syncing' ? 'disabled' : ''}>SYNC NOW ↻</button>
      </div>

      <div class="panel">
        <button class="btn btn-dark btn-md" data-act="account-signout">SIGN OUT</button>
        <p class="muted">Signing out keeps your quests on this device.</p>
        ${
          a.confirmDelete
            ? `<form class="form-row danger" data-form="delete-account">
                 <label for="dpw">Enter your password to delete your account and cloud data. This can’t be undone.</label>
                 <div class="inline-form">
                   <input id="dpw" type="password" name="password" autocomplete="current-password" required />
                   <button class="btn btn-outline btn-md" type="submit">DELETE FOREVER</button>
                 </div>
               </form>`
            : `<button class="link-btn danger-link" data-act="account-delete">Delete my account…</button>`
        }
      </div>`;
  } else {
    body = `
      <div class="panel panel-note">
        <span class="eyebrow">YOU’RE PLAYING AS A GUEST</span>
        <h2>Everything works without an account.</h2>
        <p>Create one to sync across devices, add friends, take on challenges and share to the community Showcase. Your quests on this device are kept and merged in.</p>
        <div class="panel-actions">
          <a class="btn btn-dark btn-lg" href="#/signup">CREATE ACCOUNT →</a>
          <a class="btn btn-outline btn-lg" href="#/login">SIGN IN</a>
        </div>
      </div>`;
  }

  return `
    <div class="settings-page">
      <section class="progress-cover compact-cover">
        <div class="page-wrap-wide">
          ${profileTabs('/account')}
          <span class="eyebrow">ACCOUNT / LOGIN + SIGN UP</span>
          <h1>KEEP YOUR<br>STORY<span>.</span></h1>
        </div>
      </section>
      <section class="progress-content"><div class="page-wrap-wide narrow">${body}</div></section>
    </div>`;
}

/* ================= V3: navigation, ongoing quest, Profile hub, Friends, Activity, install ================= */

/* One consistent back link (rules live in nav.js). Shows where it goes, and keeps context when it can. */
function backLink(extra = '') {
  const b = backFor(route(), prevRoute);
  if (!b) return '';
  return `<a class="back-link ${extra}" href="#${esc(b.href)}" aria-label="Back to ${esc(b.label)}">← ${esc(b.label.toUpperCase())}</a>`;
}

/* ---- Ongoing quest: always visible, one tap to resume ---- */
const activeQuest = () => (state.active ? allQuests.find((x) => x.id === state.active.id) || null : null);
function elapsedText(startedAt) {
  const m = Math.max(0, Math.floor((Date.now() - startedAt) / 60000));
  if (m < 1) return 'Just started';
  if (m < 60) return `Started ${m} min ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `Started ${h} h ago` : 'Started a while ago';
}
function ongoingBar() {
  const q = activeQuest();
  if (!q || /^\/quest\/[^/]+\/active$/.test(route())) return '';
  return `
    <aside class="ongoing-bar" aria-label="Quest in progress">
      <span class="ongoing-pulse" aria-hidden="true"></span>
      <div class="ongoing-copy"><strong>IN PROGRESS · ${esc(q.title)}</strong><small>${elapsedText(state.active.startedAt)}</small></div>
      <a class="btn btn-lime btn-sm" href="#/quest/${esc(q.id)}/active">RESUME →</a>
    </aside>`;
}

/* ---- Starting a quest while another is active: always a clear choice, never silent loss ---- */
const conflictCopy = (to) => {
  const cur = activeQuest();
  const next = quests.find((x) => x.id === to);
  if (!cur || !next) return '';
  return `
    <span class="eyebrow">ONE QUEST AT A TIME</span>
    <h2 id="cf-h">You’re already on “${esc(cur.title)}”.</h2>
    <p>${elapsedText(state.active.startedAt)}. Switching to “${esc(next.title)}” drops that timer. Nothing you’ve finished is affected.</p>
    <div class="conflict-actions">
      <a class="btn btn-lime btn-lg" href="#/quest/${esc(cur.id)}/active" data-act="conflict-resume">RESUME “${esc(cur.title.slice(0, 22).toUpperCase())}${cur.title.length > 22 ? '…' : ''}”</a>
      <button class="btn btn-dark btn-lg" data-act="conflict-switch" data-to="${esc(to)}">SWITCH TO THE NEW ONE</button>
      <button class="btn btn-outline btn-lg" data-act="conflict-cancel">CANCEL</button>
    </div>`;
};
function conflictDialog() {
  if (!ui.conflict) return '';
  const inner = conflictCopy(ui.conflict.to);
  if (!inner) return '';
  return `<div class="modal-backdrop" data-act="conflict-cancel-bg"><div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="cf-h">${inner}</div></div>`;
}
function conflictPanel(to) {
  return `<div class="list-page"><div class="page-wrap-wide narrow">${backLink()}<div class="panel panel-note conflict-panel">${conflictCopy(to)}</div></div></div>`;
}

/* ---- Friend requests ---- */
async function respondToRequest(username, accept) {
  ui.net.busy = ui.net.busy || {};
  if (ui.net.busy[username]) return null;                        // ignore repeated clicks while in flight
  ui.net.busy[username] = accept ? 'accept' : 'reject';
  rerenderIfSafe();
  const r = await cloud.respondFriend(username, accept);
  delete ui.net.busy[username];
  if (r.ok) toast(accept ? `You and @${username} are now friends.` : `Rejected the request from @${username}.`);
  else if (r.status === 404) toast('That request isn’t pending any more. Refreshing the list.');
  else toast(r.status === 0 ? offlineMsg : r.data.error || 'Something went wrong. Please try again.');
  await loadNet({ silent: true });                               // refreshes list, friends and the badge count
  return r;
}

function requestRow(p) {
  const u = esc(p.username);
  const busy = ui.net.busy?.[p.username] || '';
  const name = personName(p);
  return `
    <li class="request-row">
      <span class="request-who">${avatarEl(p, 'avatar-sm')}<span><a href="#/u/${u}"><strong>${name}</strong></a><small>@${u} wants to be friends</small></span></span>
      <span class="request-actions">
        <button class="btn btn-dark btn-sm" data-act="friend-respond" data-u="${u}" data-v="1" aria-label="Accept friend request from ${name}" ${busy ? 'disabled' : ''}>${busy === 'accept' ? 'ACCEPTING…' : 'ACCEPT'}</button>
        <button class="btn btn-reject btn-sm" data-act="friend-respond" data-u="${u}" data-v="0" aria-label="Reject friend request from ${name}" ${busy ? 'disabled' : ''}>${busy === 'reject' ? 'REJECTING…' : 'REJECT'}</button>
      </span>
    </li>`;
}

function netGate() {
  if (!ui.backendChecked) return '<div class="panel"><p class="muted" role="status">Looking for the SideQuest server…</p></div>';
  if (!cloud.backend()) return unavailable('Friends');
  if (!cloud.signedIn()) return needSignIn('Friends and challenges');
  return '';
}

function friendsView() {
  const n = ui.net;
  let body = netGate();
  if (!body) {
    const fr = n.friends;
    if (!fr) body = n.error ? `<p class="form-error" role="alert">${esc(n.error)}</p>` : '<p class="muted" role="status">Loading your friends…</p>';
    else body = `
      ${n.error ? `<p class="form-error" role="alert">${esc(n.error)}</p>` : ''}
      <section class="panel requests-panel ${fr.incoming.length ? 'has-requests' : ''}" aria-labelledby="req-h">
        <div class="list-heading"><h2 id="req-h">FRIEND REQUESTS</h2><span class="count-badge" aria-label="${fr.incoming.length} pending">${fr.incoming.length}</span></div>
        ${fr.incoming.length
          ? `<ul class="request-list">${fr.incoming.map(requestRow).join('')}</ul>`
          : '<p class="muted">No requests waiting. When someone adds you, they’ll show up here.</p>'}
      </section>

      <section class="list-section" aria-labelledby="fr-h">
        <div class="list-heading"><h2 id="fr-h">YOUR FRIENDS</h2><span class="eyebrow">${fr.friends.length}</span></div>
        ${fr.friends.length ? fr.friends.map((p) => `
          <div class="friend-row">
            <span class="request-who">${avatarEl(p, 'avatar-sm')}<span><a href="#/u/${esc(p.username)}"><strong>${personName(p)}</strong></a><small>@${esc(p.username)}</small></span></span>
            <span class="request-actions">
              <a class="btn btn-lime btn-sm" href="#/challenge/new" data-act="chal-friend" data-u="${esc(p.username)}">CHALLENGE</a>
              <button class="link-btn danger-link" data-act="friend-remove" data-u="${esc(p.username)}">Remove</button>
            </span>
          </div>`).join('') : '<p class="muted">No friends yet. Add someone by username below, then dare them to do something strange.</p>'}
      </section>

      ${fr.outgoing.length ? `<section class="list-section" aria-labelledby="out-h">
        <div class="list-heading"><h2 id="out-h">SENT REQUESTS</h2><span class="eyebrow">${fr.outgoing.length}</span></div>
        ${fr.outgoing.map((p) => `<div class="friend-row muted"><span class="request-who">${avatarEl(p, 'avatar-sm')}<span><a href="#/u/${esc(p.username)}">${personName(p)}</a><small>@${esc(p.username)} · waiting for a reply</small></span></span><button class="link-btn" data-act="friend-cancel" data-u="${esc(p.username)}">Cancel request</button></div>`).join('')}
      </section>` : ''}

      <section class="panel" aria-labelledby="add-h">
        <span class="eyebrow">ADD A FRIEND</span>
        <h2 id="add-h">Know their username?</h2>
        <form class="inline-form friend-add" data-form="friend-add">
          <label class="sr-only" for="fu">Friend’s username</label>
          <input id="fu" name="username" placeholder="username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="21" required />
          <button class="btn btn-dark btn-md" type="submit">SEND REQUEST</button>
        </form>
        <p class="muted">Friends are found by exact username only. Nobody can browse other users.</p>
      </section>`;
  }
  return `
    <div class="settings-page">
      <section class="progress-cover compact-cover"><div class="page-wrap-wide">
        ${backLink()}
        <span class="eyebrow">YOUR PEOPLE</span>
        <h1>FRIENDS<span>.</span></h1>
      </div></section>
      <section class="progress-content"><div class="page-wrap-wide narrow">${body}</div></section>
    </div>`;
}

/* ---- Profile hub ---- */
function profileHub() {
  const signed = cloud.signedIn() && cloud.backend();
  const acct = cloud.getAccount();
  const u = acct?.user;
  const fr = ui.net.friends;
  const requests = fr ? fr.incoming.length : 0;
  const chalWaiting = (ui.net.challenges || []).filter((c) => (c.status === 'pending' && c.mine === 'recipient')).length;
  const streak = dailyStreak(state);
  const skills = new Set(state.completed.map((c) => questById(c.id)?.skill).filter(Boolean)).size;
  const act = buildActivity({ completed: state.completed, questById: (id) => allQuests.find((x) => x.id === id) || null, streak, challenges: ui.net.challenges });
  const lock = signed ? '' : '<small class="card-lock">Sign in to use</small>';
  const card = (href, icon, title, sub, { badge = 0, tone = '' } = {}) => `
    <a class="hub-card ${tone}" href="#${href}">
      <span class="hub-icon" aria-hidden="true">${icon}</span>
      <span class="hub-text"><strong>${title}</strong><small>${sub}</small></span>
      ${badge ? `<span class="count-badge" aria-label="${badge} waiting">${badge}</span>` : ''}
      <span class="hub-arrow" aria-hidden="true">→</span>
    </a>`;
  const latest = act.events[0];
  return `
    <div class="profile-hub">
      <section class="progress-cover compact-cover"><div class="page-wrap-wide">
        <div class="hub-head">
          ${u ? avatarEl(u, 'avatar-lg') : '<span class="avatar avatar-lg av-none" aria-hidden="true">🎲</span>'}
          <div>
            <span class="eyebrow">${u ? `@${esc(u.username)}` : 'PLAYING AS A GUEST'}</span>
            <h1>${u ? esc(u.displayName) : 'YOUR SIDEQUEST<br>HQ'}<span>.</span></h1>
            <p class="hub-meta">${state.completed.length} quest${state.completed.length === 1 ? '' : 's'} finished${streak >= 2 ? ` · ${streak}-day streak` : ''}${skills ? ` · ${skills} skill${skills === 1 ? '' : 's'}` : ''}</p>
          </div>
        </div>
      </div></section>
      <section class="progress-content"><div class="page-wrap-wide">
        <div class="hub-grid">
          ${card('/me', '🧭', 'My Profile', `${skills} skill${skills === 1 ? '' : 's'} unlocked · your story so far`)}
          ${card('/my-quests', '🎒', 'My Quests', `${state.saved.length} saved · ${state.completed.length} finished`)}
          ${card('/showcase', '🌟', 'Showcase', 'Share what you did. See what others did.')}
          ${card('/friends', '👯', 'Friends', signed ? (fr ? `${fr.friends.length} friend${fr.friends.length === 1 ? '' : 's'}${requests ? ` · ${requests} request${requests === 1 ? '' : 's'}` : ''}` : 'Requests and your people') : 'Requests and your people', { badge: requests, tone: requests ? 'hub-attn' : '' })}
          ${card('/challenges', '⚔️', 'Friend Challenges', signed ? (chalWaiting ? `${chalWaiting} waiting for you` : 'Dare a friend to do a quest') : 'Dare a friend to do a quest', { badge: chalWaiting, tone: chalWaiting ? 'hub-attn' : '' })}
          ${card('/activity', '⚡', 'Activity', latest ? esc(latest.text) : 'Your streak, wins and highlights')}
        </div>
        ${!signed ? `<p class="hub-note">${lock} Friends, challenges and the Showcase need a free account. <a href="#/account">Create one →</a></p>` : ''}
        <div class="hub-links"><a href="#/settings">Settings &amp; reminders</a><a href="#/account">Account</a>${u ? `<a href="#/u/${esc(u.username)}">View my public profile</a>` : ''}</div>
        ${installPanel()}
      </div></section>
    </div>`;
}

/* ---- Activity (derived only from real records) ---- */
function activityView() {
  const streak = dailyStreak(state);
  const a = buildActivity({ completed: state.completed, questById: (id) => allQuests.find((x) => x.id === id) || null, streak, challenges: ui.net.challenges, friends: ui.net.friends?.friends });
  const when = (t) => { const d = Math.floor((Date.now() - t) / 86400000); return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : d < 7 ? `${d} days ago` : new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); };
  return `
    <div class="settings-page">
      <section class="progress-cover compact-cover"><div class="page-wrap-wide">
        ${backLink()}
        <span class="eyebrow">WHAT YOU’VE BEEN UP TO</span>
        <h1>ACTIVITY<span>.</span></h1>
      </div></section>
      <section class="progress-content"><div class="page-wrap-wide narrow">
        ${a.highlights.length ? `<div class="highlight-grid">${a.highlights.map((h) => `<div class="highlight"><span aria-hidden="true">${h.icon}</span><strong>${esc(h.title)}</strong><small>${esc(h.text)}</small></div>`).join('')}</div>` : ''}
        <div class="list-heading"><h2>RECENT</h2><span class="eyebrow">${a.events.length}</span></div>
        ${a.events.length ? `<ol class="timeline">${a.events.slice(0, 40).map((e) => `<li><span class="tl-icon" aria-hidden="true">${e.icon}</span><a href="${esc(e.href)}"><strong>${esc(e.text)}</strong><small>${when(e.at)}${e.shared ? ' · shared to Showcase' : ''}</small></a></li>`).join('')}</ol>`
          : `<div class="panel panel-note"><span class="eyebrow">NOTHING YET</span><h2>Your first quest starts the timeline.</h2><p>Finish a quest and it lands here, along with streaks and challenges.</p><a class="btn btn-dark btn-md" href="#/daily">SEE TODAY’S QUEST →</a></div>`}
      </div></section>
    </div>`;
}

/* ---- Install ---- */
const INSTALL_DISMISS_KEY = 'sidequest-install-dismissed';
const installDismissed = () => { try { return Date.now() - Number(localStorage.getItem(INSTALL_DISMISS_KEY) || 0) < 14 * 86400000; } catch { return false; } };
function installPanel({ banner = false } = {}) {
  const i = installInfo();
  if (banner && (installDismissed() || !['prompt', 'ios-safari', 'ios-other'].includes(i.mode))) return '';
  if (i.mode === 'installed') return banner ? '' : '<div class="install-card installed"><span aria-hidden="true">✅</span><div><strong>Installed</strong><small>You’re using SideQuest as an app.</small></div></div>';
  let text, action = '';
  if (i.mode === 'prompt') { text = 'Add SideQuest to your device for one-tap access, like a normal app.'; action = '<button class="btn btn-dark btn-md" data-act="install-now">INSTALL SIDEQUEST</button>'; }
  else if (i.mode === 'ios-safari') text = 'On iPhone or iPad: tap the <strong>Share</strong> button <span aria-hidden="true">⬆︎</span>, then choose <strong>Add to Home Screen</strong>.';
  else if (i.mode === 'ios-other') text = 'On iPhone or iPad, installing only works from Safari. Open this page in Safari, tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.';
  else { if (banner) return ''; text = 'Your browser doesn’t offer one-tap install. SideQuest works fine in the browser, and you can bookmark it.'; }
  return `<div class="install-card ${banner ? 'install-banner' : ''}"><span aria-hidden="true">📲</span><div><strong>${banner ? 'Put SideQuest on your home screen' : 'Install the app'}</strong><small>${text}</small>${action}</div>${banner ? '<button class="link-btn" data-act="install-dismiss" aria-label="Dismiss install suggestion">Not now</button>' : ''}</div>`;
}

/* ---- Today helpers: countdown + this week, from real completions ---- */
function untilTomorrow() {
  const n = new Date(); const t = new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1);
  const m = Math.max(1, Math.round((t - n) / 60000));
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}
function weekStrip() {
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000);
    days.push({ k: todayKey(d), l: d.toLocaleDateString(undefined, { weekday: 'narrow' }), done: !!state.dailyDone[todayKey(d)], today: i === 0 });
  }
  const n = days.filter((d) => d.done).length;
  return `<div class="week-strip" role="img" aria-label="${n} of the last 7 daily quests finished">${days.map((d) => `<span class="wk ${d.done ? 'wk-done' : ''} ${d.today ? 'wk-today' : ''}"><i>${d.done ? '✓' : ''}</i><b>${d.l}</b></span>`).join('')}</div>`;
}
function dailyExtras(d) {
  return `<div class="daily-extras"><span class="chip">NEW DARE IN ${untilTomorrow()}</span><span class="chip">MOOD · ${esc(String(d.mood || '').toUpperCase())}</span></div>${weekStrip()}`;
}


/* ---------------- Settings / notifications ---------------- */
function settingsView() {
  const n = state.prefs.notif;
  const perm = notify.permission();
  const mode = notify.deliveryMode();
  const on = n.enabled && perm === 'granted';
  let body = '';

  if (!notify.supported()) {
    body = `<div class="panel panel-note"><span class="eyebrow">🔕 NOT AVAILABLE</span>
      <p>This browser (or this connection) doesn’t support web notifications. They need a modern browser on <strong>https</strong> or localhost. On iPhone, add SideQuest to your Home Screen first.</p></div>`;
  } else {
    const toggle = (k, label, sub) => `
      <label class="switch-row">
        <span><strong>${label}</strong><small>${sub}</small></span>
        <input type="checkbox" data-notif="${k}" ${n[k] ? 'checked' : ''} ${on ? '' : 'disabled'} />
      </label>`;

    body = `
      <div class="panel">
        <div class="panel-head">
          <div>
            <span class="eyebrow">🔔 NOTIFICATIONS</span>
            <h2>${on ? 'On' : 'Off'}</h2>
          </div>
          ${on
            ? `<button class="btn btn-outline btn-md" data-act="notif-disable">TURN OFF</button>`
            : `<button class="btn btn-dark btn-md" data-act="notif-enable" ${perm === 'denied' ? 'disabled' : ''}>TURN ON</button>`}
        </div>
        ${perm === 'denied'
          ? `<p class="form-error">Notifications are blocked for this site. Allow them in your browser’s site settings, then come back.</p>`
          : `<p class="muted">Useful, not spammy: at most one reminder a day, never between 9pm and 8am. Your browser will ask for permission when you tap Turn on.</p>`}
        <p class="delivery-note">${
          mode === 'push'
            ? '✓ Background delivery is available: you’ll get these even when SideQuest is closed.'
            : cloud.backend() && !cloud.signedIn()
              ? 'Right now reminders only arrive while SideQuest is open in a tab. <a href="#/account">Sign in</a> to get them in the background.'
              : cloud.backend()
                ? 'Right now reminders only arrive while SideQuest is open in a tab.'
                : 'Reminders only arrive while SideQuest is open in a tab. Background push needs the SideQuest server.'
        }</p>
      </div>

      <div class="panel">
        ${toggle('daily', 'Daily SideQuest', 'Your SideQuest for today is waiting.')}
        ${toggle('challenges', 'Friend challenges', 'When a friend challenges you or finishes one.')}
        ${toggle('reminders', 'Quest reminders', 'If you start a quest and don’t finish it.')}
        ${toggle('followups', 'Follow-ups', 'A gentle “ready for another?” the day after you complete one.')}
        <div class="switch-row time-row">
          <span><strong>Daily reminder time</strong><small>Local time, between 8:00am and 8:59pm. Saved: <b data-notif-time-saved>${esc(n.time)}</b></small></span>
          <div class="time-edit">
            <input type="time" id="notif-time" data-notif-time value="${esc(n.time)}" min="08:00" max="20:59" step="60" aria-label="Daily reminder time" />
            <button class="btn btn-dark btn-sm" data-act="notif-time-save" disabled>SAVE</button>
          </div>
        </div>
        <button class="btn btn-outline btn-md" data-act="notif-test" ${on ? '' : 'disabled'}>SEND A TEST NOTIFICATION</button>
      </div>`;
  }

  return `
    <div class="settings-page">
      <section class="progress-cover compact-cover">
        <div class="page-wrap-wide">
          ${profileTabs('/settings')}
          <span class="eyebrow">SETTINGS</span>
          <h1>YOUR<br>RULES<span>.</span></h1>
        </div>
      </section>
      <section class="progress-content"><div class="page-wrap-wide narrow">${body}
      </div></section>
    </div>`;
}

/* ---------------- Friends & challenges ---------------- */
const personName = (p) => esc(p.displayName || p.username);

function challengeCard(c) {
  const q = questById(c.questId);
  const f = face(q);
  const other = c.mine === 'sender' ? c.to : c.from;
  const meDone = c.youDone;
  const themDone = c.theyDone;
  const status = {
    pending: c.mine === 'sender' ? `Waiting for ${personName(other)} to accept` : `${personName(other)} challenged you`,
    accepted: 'In progress',
    completed: '🎉 You both did it',
    declined: 'Declined',
    cancelled: 'Cancelled',
    expired: 'Expired'
  }[c.status] || 'Challenge';

  let actions = '';
  if (c.status === 'pending' && c.mine === 'recipient') {
    actions = `<button class="btn btn-dark btn-md" data-act="chal-respond" data-id="${c.id}" data-v="1">ACCEPT</button>
               <button class="btn btn-outline btn-md" data-act="chal-respond" data-id="${c.id}" data-v="0">NOT NOW</button>`;
  } else if (c.status === 'accepted' && !meDone) {
    actions = `<button class="btn btn-lime btn-md" data-start="${q.id}">START QUEST →</button>`;
  } else if (c.status === 'completed' || (c.status === 'accepted' && meDone)) {
    actions = `<button class="btn btn-outline btn-md" data-completion-card="${q.id}">VIEW MY CARD</button>`;
  }

  if (c.mine === 'sender' && ['pending', 'accepted'].includes(c.status))
    actions += ` <button class="link-btn danger-link" data-act="chal-cancel" data-id="${c.id}">Cancel challenge</button>`;
  actions += ` <button class="link-btn" data-act="share-quest" data-q="${q.id}">Share quest</button>`;

  return `
    <article class="chal-card ${c.status}">
      <div class="chal-icon" aria-hidden="true">${f.icon}</div>
      <div class="chal-main">
        <span class="eyebrow">${esc(status.replace(/<[^>]+>/g, ''))}</span>
        <h3>${esc(f.title)}</h3>
        ${c.message ? `<p class="chal-msg">“${esc(c.message)}”</p>` : ''}
        ${c.status === 'accepted' || c.status === 'completed'
          ? `<p class="chal-progress">
               <span class="${meDone ? 'done' : ''}">${meDone ? '✓' : '○'} You</span>
               <span class="${themDone ? 'done' : ''}">${themDone ? '✓' : '○'} ${personName(other)}</span>
             </p>` : ''}
        <div class="chal-actions">${actions}</div>
      </div>
    </article>`;
}

function challengesView() {
  const be = cloud.backend();
  let body = '';
  const n = ui.net;

  if (!ui.backendChecked) body = `<div class="panel"><p class="muted">Looking for the SideQuest server…</p></div>`;
  else if (!be) body = unavailable('Friend challenges');
  else if (!cloud.signedIn()) body = needSignIn('Friend challenges');
  else {
    const ch = n.challenges || [];
    const waiting = ch.filter((c) => c.status === 'pending' && c.mine === 'recipient');
    const active = ch.filter((c) => c.status === 'accepted');
    const sent = ch.filter((c) => c.status === 'pending' && c.mine === 'sender');
    const done = ch.filter((c) => c.status === 'completed');
    const past = ch.filter((c) => ['declined', 'cancelled', 'expired'].includes(c.status));
    const fr = n.friends || { friends: [], incoming: [], outgoing: [] };
    const section = (title, items, empty = '') =>
      items.length ? `<section class="list-section"><div class="list-heading"><h2>${title}</h2><span class="eyebrow">${items.length}</span></div>${items.map(challengeCard).join('')}</section>` : empty;

    body = `
      ${n.error ? `<p class="form-error" role="alert">${esc(n.error)}</p>` : ''}
      <div class="panel panel-cta">
        <div>
          <span class="eyebrow">✳ CHALLENGE A FRIEND</span>
          <h2>Pick a quest. Pick a friend. Both do it.</h2>
        </div>
        <a class="btn btn-dark btn-lg" href="#/challenge/new">NEW CHALLENGE →</a>
      </div>

      ${section('WAITING FOR YOU', waiting)}
      ${section('IN PROGRESS', active)}
      ${section('SENT', sent)}
      ${section('COMPLETED', done)}
      ${section('PAST', past)}
      ${!ch.length && !n.loading ? '<p class="muted">No challenges yet. Add a friend, then send the first one.</p>' : ''}

      <a class="hub-card" href="#/friends">
        <span class="hub-icon" aria-hidden="true">👯</span>
        <span class="hub-text"><strong>Friends</strong><small>${fr.friends.length} friend${fr.friends.length === 1 ? '' : 's'}${fr.incoming.length ? ` · ${fr.incoming.length} request${fr.incoming.length === 1 ? '' : 's'} waiting` : ''} · add or manage</small></span>
        ${fr.incoming.length ? `<span class="count-badge" aria-label="${fr.incoming.length} waiting">${fr.incoming.length}</span>` : ''}
        <span class="hub-arrow" aria-hidden="true">→</span>
      </a>`;
  }

  return `
    <div class="settings-page">
      <section class="progress-cover compact-cover">
        <div class="page-wrap-wide">
          ${profileTabs('/challenges')}
          <span class="eyebrow">SIDE BY SIDE</span>
          <h1>FRIEND<br>CHALLENGES<span>.</span></h1>
        </div>
      </section>
      <section class="progress-content"><div class="page-wrap-wide narrow">${body}</div></section>
    </div>`;
}

function challengeNew(preQuest) {
  const be = cloud.backend();
  let body = '';
  if (!ui.backendChecked) body = `<div class="panel"><p class="muted">Looking for the SideQuest server…</p></div>`;
  else if (!be) body = unavailable('Friend challenges');
  else if (!cloud.signedIn()) body = needSignIn('Friend challenges');
  else {
    const c = ui.chal;
    if (preQuest && !c.quest) c.quest = preQuest;
    const friends = ui.net.friends?.friends || [];
    const opts = quests
      .filter((q) => !q.mystery)
      .slice()
      .sort((a, b) => a.title.localeCompare(b.title));
    const q = c.quest ? questById(c.quest) : null;

    body = friends.length
      ? `
      <form class="panel auth-form" data-form="chal-send">
        <span class="eyebrow">1 / CHOOSE A QUEST</span>
        <label class="sr-only" for="cq">Quest</label>
        <select id="cq" name="quest" required>
          <option value="">Pick a quest…</option>
          ${opts.map((o) => `<option value="${o.id}" ${c.quest === o.id ? 'selected' : ''}>${esc(o.title)} · ${o.minutes} min</option>`).join('')}
        </select>
        ${q ? `<p class="muted">${esc(q.detail.mission)}</p>` : ''}

        <span class="eyebrow">2 / CHOOSE A FRIEND</span>
        <div class="friend-pick" role="radiogroup" aria-label="Friend">
          ${friends.map((p) => `
            <label class="pick ${c.friend === p.username ? 'active' : ''}">
              <input type="radio" name="friend" value="${esc(p.username)}" ${c.friend === p.username ? 'checked' : ''} required />
              ${personName(p)} <small>@${esc(p.username)}</small>
            </label>`).join('')}
        </div>

        <span class="eyebrow">3 / ADD A NOTE <span class="muted">(optional)</span></span>
        <label class="sr-only" for="cm">Message</label>
        <input id="cm" name="message" maxlength="140" value="${esc(c.message)}" placeholder="You’ve got this." />

        ${c.error ? `<p class="form-error" role="alert">${esc(c.error)}</p>` : ''}
        <button class="btn btn-dark btn-xl" type="submit" ${c.busy ? 'disabled' : ''}>${c.busy ? 'SENDING…' : 'SEND CHALLENGE →'}</button>
        <p class="muted">They can accept or pass. Once they accept, you both do the quest. Nobody gets pushed into anything.</p>
      </form>`
      : `<div class="panel panel-note"><h2>You need a friend first.</h2>
          <p>Add someone by username, and once they accept you can challenge them.</p>
          <a class="btn btn-dark btn-lg" href="#/challenges">ADD A FRIEND →</a></div>`;
  }

  return `
    <div class="settings-page">
      <section class="progress-cover compact-cover">
        <div class="page-wrap-wide">
          ${profileTabs('/challenges')}
          <span class="eyebrow">CHALLENGE A FRIEND</span>
          <h1>DARE THEM<span>.</span> NICELY<span>.</span></h1>
        </div>
      </section>
      <section class="progress-content"><div class="page-wrap-wide narrow">${body}</div></section>
    </div>`;
}

/* =====================================================================
   Logic: network (friends/challenges), notifications, sync wiring
   ===================================================================== */
const typing = () => {
  const a = document.activeElement;
  return !!a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName) && a.id !== 'search';
};
const rerenderIfSafe = () => {
  if (typing() || state.roll?.phase === 'rolling') return;
  render({ keepFocus: true });
};

const localHasData = () => state.saved.length || state.completed.length;

async function loadBlocks() {
  ui.blocks = [];
  const r = await cloud.getBlocks();
  if (r.ok) { ui.blocks = r.data.blocked; if (r.data.blocked.length) rerenderIfSafe(); }
}

async function loadNet({ silent = false } = {}) {
  if (!cloud.signedIn() || !cloud.backend()) {
    ui.net = { friends: null, challenges: null, waiting: 0, loading: false, error: '' };
    return;
  }
  if (!silent) {
    ui.net.loading = true;
  }
  const [f, c] = await Promise.all([cloud.getFriends(), cloud.getChallenges()]);
  ui.net.loading = false;
  if (f.ok) ui.net.friends = f.data;
  if (c.ok) ui.net.challenges = c.data.challenges;
  ui.net.waiting = (c.ok ? c.data.waiting : 0) + (f.ok ? f.data.incoming.length : 0);
  ui.net.error = !f.ok || !c.ok ? (f.status === 0 ? 'Offline. Showing what we had.' : 'Couldn’t load everything.') : '';
  await reconcileChallenges();
  rerenderIfSafe();
}

/* If you finished a challenged quest (even offline, even earlier), tell the server. */
async function reconcileChallenges() {
  const ch = ui.net.challenges || [];
  for (const c of ch) {
    if (c.status !== 'accepted' || c.youDone) continue;
    const e = entryFor(c.questId);
    if (e && (e.date || 0) >= (c.created || 0)) {
      const r = await cloud.completeChallenge(c.id);
      if (r.ok) Object.assign(c, r.data.challenge);
    }
  }
}

async function enableNotifications() {
  const n = state.prefs.notif;
  state.prefs.asked = Date.now();
  const res = await notify.enable({ ...n, enabled: true });
  if (res.ok) {
    n.enabled = true;
    save();
    await notify.syncPrefs(n);
    toast(
      res.mode === 'push'
        ? 'Notifications on. We’ll nudge you, even when SideQuest is closed.'
        : 'Notifications on while SideQuest is open.'
    );
  } else {
    persist();
    toast(
      res.reason === 'denied'
        ? 'Notifications are blocked in your browser settings.'
        : res.reason === 'default'
          ? 'No problem. You can turn them on any time in Settings.'
          : 'Notifications aren’t available here.'
    );
  }
  render({ keepFocus: true });
}

function armNotifications() {
  try {
    notify.scheduleLocal({
      prefs: state.prefs.notif,
      dailyDoneToday: !!state.dailyDone[todayKey()],
      active: state.active,
      todayKey: todayKey(),
      getQuestTitle: (id) => face(questById(id)).title
    });
  } catch {}
}

cloud.initSync({
  get: () => state,
  apply: (merged) => {
    const np = merged.notifPrefs;
    Object.assign(state, merged);
    delete state.notifPrefs;
    if (np && (np.at || 0) >= (state.prefs.notifAt || 0)) {
      ['daily', 'challenges', 'reminders', 'followups'].forEach((k) => { state.prefs.notif[k] = !!np[k]; });
      if (/^\d\d:\d\d$/.test(np.time)) state.prefs.notif.time = np.time;
      state.prefs.notifAt = np.at || 0;
    }
    persist();
    ui.home = null;
  },
  status: (s) => {
    ui.sync = { state: s.state === 'signedout' ? 'idle' : s.state, last: cloud.syncInfo.last };
    if (s.state === 'signedout') ui.net = { friends: null, challenges: null, waiting: 0, loading: false, error: '' };
    if (['/account', '/settings', '/login', '/signup', '/showcase', '/challenges'].includes(route()) || route().startsWith('/u/')) rerenderIfSafe();
  }
});

async function afterAuth(user) {
  ui.showcase.mine = newFeed();
  ui.profile = { username: '', status: 'idle' };
  ui.blocks = null;
  const last = localStorage.getItem('sidequest-last-user');
  if (last && last !== user.username && localHasData()) {
    ui.account.pending = user.username;
    return;
  }
  localStorage.setItem('sidequest-last-user', user.username);
  await cloud.syncNow();
  loadNet();
}

/* =====================================================================
   Actions (delegated, so re-rendering never loses a handler)
   ===================================================================== */
const setDiscover = (key, val) => {
  state.discover = { ...(state.discover || {}), [key]: val };
};

const actions = {
  'home-shuffle': () => { ui.home = null; render(); },

  'daily-skip': () => {
    const d = dailyData();
    if (d.done || d.skipsLeft <= 0) return;
    state.skipped = [...state.skipped, { id: d.q.id, t: Date.now() }];
    state.daily.skips += 1;
    state.daily.id = null;
    persist();
    render();
    $('#daily-h, .daily-page h1')?.setAttribute('tabindex', '-1');
    toast('New SideQuest picked.');
  },

  'weird-level': (el) => { ui.weird.level = +el.dataset.v; ui.weird.id = null; render(); },
  'weird-next': () => { ui.weird.id = null; render(); },

  roll: () => startRoll(),
  'roll-again': () => startRoll(),

  'bored-time': (el) => {
    const v = el.dataset.v;
    state.bored = v === 'reset' ? { time: null, vibe: null, result: null } : { time: v, vibe: null, result: null, shown: [] };
    render();
  },
  'bored-vibe': (el) => {
    state.bored = { ...state.bored, vibe: el.dataset.v };
    boredGenerate();
    render();
  },
  'bored-again': () => { boredGenerate(); render(); },
  'bored-vibe-reset': () => {
    state.bored = { time: state.bored.time, vibe: null, result: null, shown: state.bored.shown };
    render();
  },

  'clear-filters': () => { state.discover = {}; render(); },

  'share-card': async () => {
    const c = $('#clear-canvas');
    if (!c) return;
    const id = route().split('/')[2];
    const { quest, entry } = cardData(id);
    const r = await shareCard(c, quest, entry);
    if (r === 'copied') toast('Summary copied. Paste it anywhere.');
    else if (r === 'failed') toast('Couldn’t share from here. Try Save card image.');
  },

  'notif-time-save': async () => {
    const input = $('#notif-time');
    const v = input?.value || '';
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) { toast('Pick a valid time first.'); return; }
    if (v < '08:00' || v > '20:59') { toast('Reminders only go out between 8:00am and 8:59pm.'); return; }
    state.prefs.notif.time = v;
    state.prefs.notifAt = Date.now();
    save();                                              // local + account state (syncs across devices)
    const synced = await notify.syncPrefs(state.prefs.notif); // background scheduler, when push is active
    toast(
      cloud.signedIn() && cloud.backend() ? `Reminder time saved: ${v}.` : `Reminder time saved on this device: ${v}.`
    );
    render({ keepFocus: false });
  },

  abandon: () => {
    const id = state.active?.id || route().split('/')[2];
    state.active = null;
    save();
    toast('Quest dropped. It’ll be here if you change your mind.');
    go(`/quest/${id}`);
  },

  'notif-enable': () => enableNotifications(),
  'notif-later': () => { state.prefs.asked = Date.now(); persist(); render(); },
  'notif-disable': async () => {
    state.prefs.notif.enabled = false;
    await notify.disable();
    if (cloud.signedIn() && cloud.backend()) await cloud.pushUpdatePrefs(state.prefs.notif);
    save();
    toast('Notifications off.');
    render();
  },
  'notif-test': async () => {
    const ok = await notify.sendTest();
    toast(ok ? 'Test sent. Check your notifications.' : 'Couldn’t show a notification.');
  },

  'account-tab': (el) => { ui.account = { ...ui.account, mode: el.dataset.v, error: '', form: null }; render(); },
  'account-signout': async () => {
    await notify.disable();
    state.prefs.notif.enabled = false;
    await cloud.signOut();
    ui.showcase.mine = newFeed();
    ui.profile = { username: '', status: 'idle' };
    ui.blocks = null;
    ui.account = { ...ui.account, mode: 'signin', error: '', errors: {}, form: null, confirmDelete: false, pending: null };
    persist();
    toast('Signed out. Your quests stay on this device.');
    render();
  },
  'account-sync': async () => { await cloud.syncNow(); render({ keepFocus: true }); },
  'account-delete': () => { ui.account.confirmDelete = true; render(); },
  'account-merge': async () => {
    const u = ui.account.pending;
    ui.account.pending = null;
    localStorage.setItem('sidequest-last-user', u);
    await cloud.syncNow();
    loadNet();
    render();
  },
  'account-fresh': async () => {
    const u = ui.account.pending;
    ui.account.pending = null;
    localStorage.setItem('sidequest-last-user', u);
    await cloud.syncNow({ mode: 'cloud' });
    loadNet();
    render();
  },

  'pw-toggle': (el) => {
    const input = el.parentElement.querySelector('input');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    el.textContent = show ? 'HIDE' : 'SHOW';
    el.setAttribute('aria-pressed', String(show));
    el.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  },
  'set-next': (el) => { ui.account.next = el.dataset.next || ''; ui.account.error = ''; ui.account.errors = {}; },

  'showcase-tab': (el) => { ui.showcase.tab = el.dataset.v; render(); },
  'feed-refresh': () => { ui.showcase.community = newFeed(); ui.showcase.mine = newFeed(); render(); },
  'feed-retry': (el) => {
    if (el.dataset.k === 'profile') { reloadProfile(); return; }
    ui.showcase[el.dataset.k].error = '';
    ui.showcase[el.dataset.k].loaded = ui.showcase[el.dataset.k].posts.length > 0;
    render();
  },
  'feed-more': (el) => {
    const k = el.dataset.k;
    const f = feedFor(k);
    const fetcher = k === 'profile' ? (c) => cloud.getProfilePosts(ui.profile.username, c)
      : (c) => cloud.getShowcase({ mine: k === 'mine', cursor: c });
    return loadFeed(f, fetcher, { more: true });
  },
  'showcase-publish': async (el) => {
    const id = el.dataset.q;
    if (ui.showcase.busy) return;
    ui.showcase.busy = id;
    render({ keepFocus: true });
    const note = (ui.showcase.drafts?.[id] || '').trim().slice(0, 140);
    const r = await cloud.publishPost(id, note);
    ui.showcase.busy = null;
    if (r.ok && ui.showcase.drafts) delete ui.showcase.drafts[id];
    if (r.ok) {
      const c = entryFor(id); if (c) { c.public = true; save(); }
      ui.showcase.mine.posts = [r.data.post, ...ui.showcase.mine.posts.filter((x) => x.id !== r.data.post.id)];
      ui.showcase.community = newFeed();
      toast('Published to the Showcase.');
    } else toast(r.status === 0 ? offlineMsg : r.data.error || 'Couldn’t publish.');
    render({ keepFocus: true });
  },
  'showcase-unpublish': async (el) => {
    if (!confirm('Remove this from the Showcase? You can publish it again later.')) return;
    const r = await cloud.unpublishPost(el.dataset.pid);
    if (!r.ok && r.status !== 404) { toast(r.status === 0 ? offlineMsg : r.data.error || 'Couldn’t remove it.'); return; }
    const c = entryFor(el.dataset.q); if (c) { c.public = false; save(); }
    const gone = (x) => String(x.id) !== String(el.dataset.pid);
    ui.showcase.mine.posts = ui.showcase.mine.posts.filter(gone);
    ui.showcase.community.posts = ui.showcase.community.posts.filter(gone);
    if (ui.profile.feed) ui.profile.feed.posts = ui.profile.feed.posts.filter(gone);
    if (ui.profile.data) ui.profile.data.stats.shared = Math.max(0, ui.profile.data.stats.shared - 1);
    toast('Removed from the Showcase.');
    render({ keepFocus: true });
  },

  'share-profile': async (el) => {
    const m = shareMessage(await shareLink({ title: `${el.dataset.n} on SideQuest`, text: `Check out ${el.dataset.n} (@${el.dataset.u}) on SideQuest`, url: profileUrl(el.dataset.u) }));
    if (m) toast(m);
  },
  'share-post': async (el) => {
    const q = questById(el.dataset.q);
    const m = shareMessage(await shareLink({ title: 'A SideQuest worth seeing', text: `@${el.dataset.u} did: ${q ? q.title : 'a SideQuest'}`, url: profileUrl(el.dataset.u) }));
    if (m) toast(m);
  },
  'share-quest': async (el) => {
    const q = questById(el.dataset.q);
    const m = shareMessage(await shareLink({ title: q.mystery ? 'A Mystery SideQuest' : q.title, text: q.mystery ? 'Try this Mystery SideQuest' : `Try this SideQuest: ${q.title}`, url: questUrl(q.id) }));
    if (m) toast(m);
  },

  'profile-retry': () => reloadProfile(),
  'pf-add': async (el) => {
    ui.profile.busy = true; render({ keepFocus: true });
    const r = await cloud.requestFriend(el.dataset.u);
    toast(r.ok ? (r.data.status === 'accepted' ? 'You’re friends now!' : 'Friend request sent.') : r.status === 0 ? offlineMsg : r.data.error || 'Couldn’t send.');
    loadNet({ silent: true });
    reloadProfile();
  },
  'pf-cancel': async (el) => {
    const r = await cloud.cancelFriendRequest(el.dataset.u);
    toast(r.ok ? 'Request cancelled.' : r.data.error || 'Couldn’t cancel.');
    loadNet({ silent: true });
    reloadProfile();
  },
  'pf-respond': async (el) => {
    await respondToRequest(el.dataset.u, el.dataset.v === '1');
    reloadProfile();
  },
  'pf-remove': async (el) => {
    if (!confirm(`Remove @${el.dataset.u}? Open challenges with them will be cancelled.`)) return;
    const r = await cloud.removeFriend(el.dataset.u);
    toast(r.ok ? 'Friend removed.' : r.data.error || 'Something went wrong.');
    loadNet({ silent: true });
    reloadProfile();
  },
  'pf-block': async (el) => {
    if (!confirm(`Block @${el.dataset.u}? Your friendship (if any) ends, open challenges are cancelled, and neither of you will see the other.`)) return;
    const r = await cloud.blockUser(el.dataset.u);
    if (!r.ok) { toast(r.data.error || 'Couldn’t block.'); return; }
    toast(`Blocked @${el.dataset.u}.`);
    ui.blocks = null; ui.showcase.community = newFeed();
    loadNet({ silent: true });
    go('/showcase');
  },
  'pf-report': async (el) => {
    const reason = prompt(`Report @${el.dataset.u}. What’s wrong? (optional)`);
    if (reason === null) return;
    const r = await cloud.reportUser(el.dataset.u, reason);
    toast(r.ok ? 'Thanks. We’ve recorded your report.' : r.data.error || 'Couldn’t send the report.');
  },
  unblock: async (el) => {
    const r = await cloud.unblockUser(el.dataset.u);
    toast(r.ok ? `Unblocked @${el.dataset.u}.` : r.data.error || 'Couldn’t unblock.');
    ui.blocks = null; loadBlocks(); render({ keepFocus: true });
  },
  'friend-cancel': async (el) => {
    const r = await cloud.cancelFriendRequest(el.dataset.u);
    if (!r.ok) toast(r.data.error || 'Something went wrong.');
    await loadNet({ silent: true });
  },
  'chal-cancel': async (el) => {
    if (!confirm('Cancel this challenge?')) return;
    const r = await cloud.cancelChallenge(el.dataset.id);
    if (!r.ok) toast(r.data.error || 'Couldn’t cancel.');
    await loadNet({ silent: true });
  },

  'friend-respond': (el) => respondToRequest(el.dataset.u, el.dataset.v === '1'),
  'conflict-resume': () => { ui.conflict = null; },                  // the link itself navigates to the active quest
  'conflict-cancel': () => { ui.conflict = null; render(); },
  'conflict-switch': (el) => {
    const to = el.dataset.to;
    ui.conflict = null;
    state.active = null;
    save();
    toast('Switched quests. The old timer was dropped.');
    startQuest(to);
  },
  'install-now': async () => {
    const out = await promptInstall();
    if (out === 'accepted') toast('Installing SideQuest…');
    rerenderIfSafe();
  },
  'install-dismiss': () => { try { localStorage.setItem(INSTALL_DISMISS_KEY, String(Date.now())); } catch {} render({ keepFocus: true }); },
  'friend-remove': async (el) => {
    if (!confirm(`Remove @${el.dataset.u}? Open challenges with them will be cancelled.`)) return;
    const r = await cloud.removeFriend(el.dataset.u);
    if (!r.ok) toast(r.data.error || 'Something went wrong.');
    await loadNet({ silent: true });
  },
  'chal-friend': (el) => { ui.chal.friend = el.dataset.u; },
  challenge: (el) => { ui.chal = { quest: el.dataset.quest, friend: '', message: '', busy: false }; go('/challenge/new'); },
  'chal-respond': async (el) => {
    const r = await cloud.respondChallenge(el.dataset.id, el.dataset.v === '1');
    if (!r.ok) toast(r.data.error || 'Something went wrong.');
    else toast(el.dataset.v === '1' ? 'Challenge accepted. Go get it.' : 'No worries.');
    await loadNet({ silent: true });
  }
};

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && ui.conflict) { ui.conflict = null; render(); }
});
document.addEventListener('input', (e) => {
  const dr = e.target.closest('[data-draft]');
  if (dr) { ui.showcase.drafts = ui.showcase.drafts || {}; ui.showcase.drafts[dr.dataset.draft] = dr.value.slice(0, 140); }
});

document.addEventListener('click', (e) => {
  if (e.target.classList?.contains('modal-backdrop') && ui.conflict) { ui.conflict = null; render(); return; }
  const act = e.target.closest('[data-act]');
  if (act && !act.disabled && actions[act.dataset.act]) {
    Promise.resolve(actions[act.dataset.act](act, e)).catch(() => toast('Something went wrong. Try again.'));
    return;
  }

  const f = e.target.closest('[data-filter]');
  if (f) {
    const i = f.dataset.filter.indexOf(':');
    setDiscover(f.dataset.filter.slice(0, i), f.dataset.filter.slice(i + 1));
    render({ keepFocus: true });
    return;
  }

  const d = e.target.closest('[data-discover]');
  if (d) {
    const i = d.dataset.discover.indexOf(':');
    state.discover = { [d.dataset.discover.slice(0, i)]: d.dataset.discover.slice(i + 1) };
    go('/discover');
  }
});

/* Reflection: buttons + short notes */
document.addEventListener('click', (e) => {
  const rb = e.target.closest('[data-reflect]');
  const ab = e.target.closest('[data-again]');
  if (!rb && !ab) return;
  const id = route().split('/')[2];
  const entry = entryFor(id);
  if (!entry) return;
  const group = (rb || ab).parentElement;
  const same = (rb || ab).classList.contains('active');
  if (rb) entry.reflection = same ? '' : rb.dataset.reflect;
  if (ab) entry.again = same ? '' : ab.dataset.again;
  save();
  group.querySelectorAll('button').forEach((b) => {
    b.classList.remove('active');
    b.setAttribute('aria-pressed', 'false');
  });
  if (!same) {
    (rb || ab).classList.add('active');
    (rb || ab).setAttribute('aria-pressed', 'true');
  }
});

let noteTimer = null;
document.addEventListener('input', (e) => {
  const n = e.target.closest('[data-note]');
  if (!n) return;
  const entry = entryFor(route().split('/')[2]);
  if (!entry) return;
  entry[n.dataset.note] = n.value.slice(0, 100);
  clearTimeout(noteTimer);
  noteTimer = setTimeout(save, 600);
});

document.addEventListener('change', async (e) => {
  const t = e.target.closest('[data-notif]');
  if (t) {
    state.prefs.notif[t.dataset.notif] = t.checked;
    state.prefs.notifAt = Date.now();
    save();
    await notify.syncPrefs(state.prefs.notif);
    return;
  }
});

/* Reminder time: editing only enables SAVE; nothing changes until it is pressed. */
const timeDraftChanged = (el) => {
  const btn = el.closest('.time-edit')?.querySelector('[data-act="notif-time-save"]');
  if (btn) btn.disabled = !/^\d\d:\d\d$/.test(el.value) || el.value === state.prefs.notif.time;
};
document.addEventListener('input', (e) => { const tm = e.target.closest('[data-notif-time]'); if (tm) timeDraftChanged(tm); });
document.addEventListener('change', (e) => { const tm = e.target.closest('[data-notif-time]'); if (tm) timeDraftChanged(tm); });

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const kind = form.dataset.form;

  if (kind === 'auth') {
    const a = ui.account;
    const signup = form.dataset.mode === 'signup';
    a.form = { username: data.username, displayName: data.displayName };
    a.errors = validateAuth(signup, data);
    a.error = '';
    if (Object.keys(a.errors).length) {
      render();
      document.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    a.busy = true;
    render();
    const r = signup
      ? await cloud.signUp(data.username.trim(), data.password, data.displayName)
      : await cloud.signIn(data.username.trim(), data.password);
    a.busy = false;
    if (!r.ok) {
      if (r.status === 0) a.error = 'Can’t reach the SideQuest server right now. Check your connection and try again.';
      else if (r.data.field && ['username', 'password', 'displayName'].includes(r.data.field)) a.errors = { [r.data.field]: r.data.error };
      else a.error = r.data.error || 'Something went wrong. Please try again.';
      render();
      document.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }
    a.form = null;
    a.errors = {};
    await afterAuth(r.data.user);
    toast(`Welcome${signup ? '' : ' back'}, ${r.data.user.displayName}.`);
    const next = a.pending ? '/account' : a.next || '/';
    a.next = '';
    if (route() === next) render(); else go(next);
    return;
  }

  if (kind === 'profile-edit') {
    const r = await cloud.updateProfile({ displayName: data.displayName, bio: data.bio || '', avatar: data.avatar || '', profilePublic: !!data.profilePublic });
    toast(r.ok ? 'Profile saved.' : r.status === 0 ? offlineMsg : r.data.error || 'Couldn’t save.');
    ui.profile = { username: '', status: 'idle' };
    render({ keepFocus: true });
  }

  if (kind === 'password') {
    const a = ui.account;
    a.pwError = '';
    if (!data.current) a.pwError = 'Enter your current password.';
    else if (!data.next || data.next.length < 8) a.pwError = 'The new password needs at least 8 characters.';
    else if (data.next !== data.confirm) a.pwError = 'The new passwords don’t match.';
    if (!a.pwError) {
      const r = await cloud.changePassword(data.current, data.next);
      if (r.ok) { toast('Password changed. Other devices were signed out.'); form.reset(); }
      else a.pwError = r.status === 0 ? offlineMsg : r.data.error || 'Couldn’t change the password.';
    }
    render({ keepFocus: true });
  }

  if (kind === 'profile-name') {
    const r = await cloud.updateProfile(data.displayName);
    toast(r.ok ? 'Saved.' : r.data.error || 'Couldn’t save.');
    render({ keepFocus: true });
  }

  if (kind === 'delete-account') {
    const r = await cloud.deleteAccount(data.password);
    if (r.ok) {
      ui.account.confirmDelete = false;
      await notify.disable();
      state.prefs.notif.enabled = false;
      persist();
      toast('Account deleted. Your quests are still on this device.');
    } else toast(r.data.error || 'Couldn’t delete.');
    render();
  }

  if (kind === 'friend-add') {
    const r = await cloud.requestFriend(data.username);
    toast(r.ok ? (r.data.status === 'accepted' ? 'You’re friends now!' : 'Friend request sent.') : r.data.error || 'Couldn’t send.');
    if (r.ok) form.reset();
    await loadNet({ silent: true });
  }

  if (kind === 'chal-send') {
    const c = ui.chal;
    Object.assign(c, { quest: data.quest, friend: data.friend, message: data.message || '', busy: true, error: '' });
    render();
    const r = await cloud.sendChallenge(data.friend, data.quest, data.message);
    c.busy = false;
    if (!r.ok) { c.error = r.data.error || 'Couldn’t send.'; render(); return; }
    ui.chal = { quest: '', friend: '', message: '', busy: false };
    await loadNet({ silent: true });
    toast('Challenge sent.');
    go('/challenges');
  }
});

/* Clear a field's error as soon as the person edits it. */
document.addEventListener('input', (e) => {
  const f = e.target.closest('.field.has-error');
  if (!f || !e.target.name) return;
  f.classList.remove('has-error');
  e.target.removeAttribute('aria-invalid');
  e.target.removeAttribute('aria-describedby');
  f.querySelector('.field-error')?.remove();
  if (ui.account.errors) delete ui.account.errors[e.target.name === 'confirm' ? 'confirm' : e.target.name];
});

/* keep the radio highlight + quest preview in sync without re-rendering the form */
document.addEventListener('change', (e) => {
  if (e.target.name === 'quest') { ui.chal.quest = e.target.value; render({ keepFocus: true }); }
  if (e.target.name === 'friend') { ui.chal.friend = e.target.value; render({ keepFocus: true }); }
});

const TITLES = {
  '/': 'SideQuest', '/daily': 'Today’s SideQuest', '/discover': 'Discover', '/roll': 'Quest Roll',
  '/bored': 'I’m Bored', '/weird': 'Something Weird', '/my-quests': 'My Quests', '/profile': 'Profile', '/me': 'My Profile', '/friends': 'Friends', '/activity': 'Activity',
  '/showcase': 'Showcase', '/challenges': 'Friend Challenges', '/settings': 'Settings', '/account': 'Account',
  '/login': 'Sign in', '/signup': 'Create account',
};

/* ---------------- Quest timer ----------------
   One interval at most, ever. Remaining time is derived from the
   persisted startedAt, so re-renders, tab switches and returning to the
   quest later can never drift or stack timers. */
let timerHandle = null;
function stopTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}
const fmtClock = (ms) => {
  const t = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(t / 60);
  return `${String(m).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
function startTimer(id) {
  stopTimer();
  const el = $('#timer');
  if (!el) return;
  /* Opening the active screen directly (reload, deep link) still has to start the clock. */
  if (!state.active) {
    state.active = { id, startedAt: Date.now() };
    save();
  }
  if (state.active.id !== id) return;                 // another quest is in progress: active() shows the choice instead
  const total = Number(el.dataset.minutes) * 60000;
  const startedAt = state.active.startedAt;
  const fill = $('#timer-fill');
  const note = $('#timer-note');
  const panel = el.closest('.timer-panel');
  const tick = () => {
    const left = total - (Date.now() - startedAt);
    el.textContent = fmtClock(left);
    if (fill) fill.style.width = `${Math.min(100, Math.max(0, ((total - left) / total) * 100))}%`;
    if (left <= 0) {
      stopTimer();
      panel?.classList.add('timer-done');
      el.setAttribute('aria-live', 'polite');
      if (note) note.textContent = 'Time’s up. Finish up whenever you’re ready: no pressure.';
    }
  };
  tick();
  if (total - (Date.now() - startedAt) > 0) timerHandle = setInterval(tick, 250);
}

function render({ keepFocus = false, fromNav = false } = {}) {
  if (route() === '/progress') { location.replace('#/profile'); return; }   // old Progress links keep working
  const r = route();
  stopTimer();
  let content = '';

  const prev = document.activeElement;
  const fid = prev && prev.id;
  const fstart = prev && prev.selectionStart;
  const fend = prev && prev.selectionEnd;

  if (r === '/') {
    content = home();
  } else if (r === '/daily') {
    content = daily();
  } else if (r === '/weird') {
    content = weird();
  } else if (r === '/discover') {
    content = discover();
  } else if (r === '/roll') {
    content = roll();
  } else if (r === '/bored') {
    content = bored();
  } else if (r === '/my-quests') {
    content = myQuests();
  } else if (r === '/profile') {
    content = profileHub();
  } else if (r === '/me') {
    content = myProfile();
  } else if (r === '/friends') {
    content = friendsView();
  } else if (r === '/activity') {
    content = activityView();
  } else if (r === '/showcase') {
    content = showcase();
  } else if (r === '/challenges') {
    content = challengesView();
  } else if (r.startsWith('/challenge/new')) {
    content = challengeNew(r.split('/')[3] || '');
  } else if (r === '/settings') {
    content = settingsView();
  } else if (r === '/account') {
    content = accountView();
  } else if (r === '/login' || r === '/signup') {
    content = authPage(r === '/signup' ? 'signup' : 'signin');
  } else if (/^\/u\/[a-z0-9_]{3,20}$/.test(r)) {
    content = profilePage(r.split('/')[2]);
  } else if (r.startsWith('/u/')) {
    content = `<div class="list-page"><div class="page-wrap-wide"><div class="panel panel-note"><span class="eyebrow">NOT FOUND</span><h2>That doesn’t look like a SideQuest username.</h2><a class="btn btn-dark btn-md" href="#/showcase">BROWSE THE SHOWCASE →</a></div></div></div>`;
  } else if (r.startsWith('/quest/')) {
    const parts = r.split('/').filter(Boolean);
    const id = parts[1];
    const sub = parts[2];

    if (sub === 'active') {
      content = active(id);
    } else if (sub === 'complete') {
      content = complete(id);
    } else if (sub === 'card') {
      content = card(id);
    } else {
      content = detail(id);
    }
  } else {
    content = home();
  }

  app.innerHTML = shell(content);
  document.title = r.startsWith('/u/') ? `@${r.split('/')[2]} · SideQuest` : r.startsWith('/quest/') ? `${face(questById(r.split('/')[2])).title} · SideQuest` : TITLES[r] ? `${TITLES[r]} · SideQuest` : 'SideQuest';

  bind();
  if (r === '/showcase') ensureShowcase();
  if (/^\/u\/[a-z0-9_]{3,20}$/.test(r)) ensureProfile(r.split('/')[2]);
  if (r === '/account' && cloud.signedIn() && cloud.backend() && ui.blocks === null) loadBlocks();

  if (keepFocus && fid) {
    const el = document.getElementById(fid);
    if (el) {
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(fstart, fend); } catch {}
    }
  }
  if (fromNav) {
    const h = $('h1');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }
  if (ui.conflict) $('.modal-card .btn')?.focus();
  if (r.endsWith('/card')) paintCard();
  if (/^\/quest\/[^/]+\/active$/.test(r)) startTimer(r.split('/')[2]);
}

function bind() {
  document
    .querySelectorAll('[data-go]')
    .forEach((el) => {
      el.onclick = () => go(el.dataset.go);
    });

  document
    .querySelectorAll('[data-start]')
    .forEach((el) => {
      el.onclick = () => startQuest(el.dataset.start);
    });

  document
    .querySelectorAll('[data-save]')
    .forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.save;
        setMember('saved', id, !state.saved.includes(id));
        save();
        render({ keepFocus: true });
      };
    });

  document
    .querySelectorAll('[data-complete]')
    .forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.complete;
        const prev = entryFor(id);
        const today = todayKey();

        state.completed = state.completed.filter((c) => c.id !== id);
        state.completed.push({
          id,
          reflection: '',
          again: '',
          surprise: '',
          learned: '',
          public: !!prev?.public,
          date: Date.now()
        });

        if (state.daily?.date === today && state.daily.id === id) {
          state.dailyDone = { ...state.dailyDone, [today]: id };
        }
        state.active = null;
        ui.home = null;
        save();

        /* Friend challenges: mark my side done (reconciled later if offline). */
        if (cloud.signedIn() && cloud.backend()) {
          const open = (ui.net.challenges || []).filter((c) => c.status === 'accepted' && c.questId === id && !c.youDone);
          open.forEach(async (c) => {
            const r = await cloud.completeChallenge(c.id);
            if (r.ok) { Object.assign(c, r.data.challenge); toast(r.data.challenge.status === 'completed' ? 'Challenge complete. You both did it! 🎉' : 'Challenge updated. Your friend’s turn.'); }
          });
        }

        go(`/quest/${id}/complete`);
      };
    });

  document
    .querySelectorAll('[data-completion-card]')
    .forEach((el) => {
      el.onclick = () =>
        go(`/quest/${el.dataset.completionCard}/card`);
    });

  document
    .querySelectorAll('[data-showcase]')
    .forEach((el) => {
      el.onclick = async () => {
        const id = el.dataset.showcase;
        const c = entryFor(id);
        if (c) c.public = true;
        save();
        if (!cloud.backend() || !cloud.signedIn()) {
          toast('Create an account or sign in to share this with the community.');
          ui.account.next = '/showcase';
          go(cloud.backend() ? '/signup' : '/showcase');
          return;
        }
        el.disabled = true;
        const r = await cloud.publishPost(id);
        el.disabled = false;
        if (!r.ok) {
          if (c) c.public = false;
          save();
          toast(r.status === 0 ? offlineMsg : r.data.error || 'Couldn’t publish.');
          return;
        }
        ui.showcase.mine = newFeed();
        ui.showcase.community = newFeed();
        ui.showcase.tab = 'mine';
        toast('Published to the Showcase.');
        go('/showcase');
      };
    });



  document
    .querySelectorAll('[data-download-card]')
    .forEach((el) => {
      el.onclick = async () => {
        const c = $('#clear-canvas');
        if (!c) return;
        const { quest } = cardData(route().split('/')[2]);
        await downloadCard(c, quest);
        toast('Card saved.');
      };
    });
}

let lastRoute = route();
window.addEventListener('hashchange', () => {
  const r = route();
  if (lastRoute === '/roll' && r !== '/roll') clearRoll();
  if (r === '/weird' && lastRoute !== '/weird') ui.weird.id = null;
  if (r === '/bored' && lastRoute !== '/bored') state.bored = null;
  if (r === '/roll' && lastRoute !== '/roll' && state.roll) state.roll = { ...state.roll, phase: 'idle', final: null };
  if (r === '/' && lastRoute !== '/') {
    /* keep picks stable while browsing, refresh when the day changes */
  }
  prevRoute = lastRoute;
  ui.conflict = null;
  lastRoute = r;
  render({ fromNav: true });
  if (isProfileRoute(r) && cloud.signedIn() && cloud.backend()) loadNet({ silent: true });
});

initInstall();
onInstallChange(() => rerenderIfSafe());
render();

/* ---------------- Boot (never blocks first paint) ---------------- */
(async function boot() {
  await cloud.checkBackend();
  ui.backendChecked = true;
  if (cloud.signedIn() && cloud.backend()) {
    await cloud.refreshMe();
    await cloud.syncNow();
    await loadNet({ silent: true });
  }
  if (notify.supported() && state.prefs.notif.enabled) {
    await notify.registerSW();
    if (notify.permission() !== 'granted') {
      state.prefs.notif.enabled = false;           // permission was revoked in the browser
      persist();
    }
  }
  armNotifications();
  rerenderIfSafe();
  notify.registerSW();                         // offline fallback + notifications; never blocks first paint
})();

window.addEventListener('offline', () => toast('You’re offline. Your quests are saved on this device and will sync when you’re back.'));
window.addEventListener('online', () => {
  toast('Back online.');
  if (cloud.signedIn() && cloud.backend()) cloud.syncNow().then(() => loadNet({ silent: true }));
  else cloud.checkBackend().then(() => rerenderIfSafe());
});

let lastVis = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || Date.now() - lastVis < 60000) return;
  lastVis = Date.now();
  armNotifications();
  if (cloud.signedIn() && cloud.backend()) {
    cloud.syncNow().then(() => loadNet({ silent: true }));
  }
});
