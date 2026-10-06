import {
  quests,
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
import * as notify from './notify.js';
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
  account: { mode: 'signin', error: '', busy: false, pending: null, confirmDelete: false },
  chal: { quest: '', friend: '', message: '', busy: false },
  sync: { state: 'idle', last: 0 },
  backendChecked: false,
  rollTimer: null
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

const icon = (q) => q.icon;

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
  state.active = { id, startedAt: Date.now() };
  reveal(id);
  save();
  go(`/quest/${id}/active`);
};

const PROFILE_ROUTES = ['/progress', '/my-quests', '/challenges', '/settings', '/account'];
const isProfileRoute = (r) => PROFILE_ROUTES.includes(r) || r.startsWith('/challenge/');

function navSvg(kind) {
  const paths = {
    home: '<path d="M3 10.5 12 3l9 7.5v8a1.5 1.5 0 0 1-1.5 1.5h-5v-6h-5v6h-5A1.5 1.5 0 0 1 3 18.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2.1 4.9-4.9 2.1 2.1-4.9z"/>',
    profile: '<circle cx="12" cy="8" r="3.5"/><path d="M5 21c.8-4 3.1-6 7-6s6.2 2 7 6"/>'
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[kind] || paths.home}</svg>`;
}

function shell(content, { immersive = false } = {}) {
  if (immersive) {
    return `<main class="immersive-main">${content}</main>`;
  }

  const r = route();
  const here = (p) =>
    p === r || (p === '/progress' && isProfileRoute(r)) ? ' nav-active' : '';
  const mHere = (p) =>
    p === r || (p === '/progress' && isProfileRoute(r)) ? ' mobile-active' : '';

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
          <a href="#/progress" data-nav="/progress" class="${here('/progress').trim()}">Progress${
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
      <a href="#/discover" class="${mHere('/discover').trim()}">
        <span class="nav-icon" aria-hidden="true">${navSvg('compass')}</span>
        <span>Discover</span>
      </a>
      <a href="#/roll" class="mobile-roll" aria-label="Roll a quest">
        <span class="roll-glyph" aria-hidden="true">✣</span>
      </a>
      <a href="#/progress" class="${mHere('/progress').trim()}">
        <span class="nav-icon" aria-hidden="true">${navSvg('profile')}</span>
        <span>Profile${
          ui.net.waiting ? '<i class="nav-dot" aria-label="Challenges waiting"></i>' : ''
        }</span>
      </a>
    </nav>
  `;
}

const QUEST_IMAGES = {
  Creative: 'https://images.unsplash.com/photo-1658786335126-6e00866428ae?auto=format&fit=crop&fm=jpg&q=82&w=1400',
  Brain: 'https://images.unsplash.com/photo-1658877915390-cbdda4d7e1f5?auto=format&fit=crop&fm=jpg&q=82&w=1400',
  Practical: 'https://images.unsplash.com/photo-1755436612908-fdef1439f18d?auto=format&fit=crop&fm=jpg&q=82&w=1400',
  Tech: 'https://images.unsplash.com/photo-1755436612908-fdef1439f18d?auto=format&fit=crop&fm=jpg&q=82&w=1400',
  Physical: 'https://images.unsplash.com/photo-1547941126-3d5322b218b0?auto=format&fit=crop&fm=jpg&q=82&w=1400',
  Social: 'https://images.unsplash.com/photo-1774802442730-da32263d7574?auto=format&fit=crop&fm=jpg&q=82&w=1400',
  Random: 'https://images.unsplash.com/photo-1771146077085-d1fec95c4afe?auto=format&fit=crop&fm=jpg&q=82&w=1400'
};
const questImage = (q) => QUEST_IMAGES[q.category] || QUEST_IMAGES.Random;

function questCard(q) {
  const f = face(q);

  return `
    <article class="quest-card">
      <div class="quest-art art-${q.category.toLowerCase()}" data-category="${esc(q.category)}">
        <img class="quest-art-image" src="${questImage(q)}" alt="" loading="lazy" decoding="async">
        <span class="quest-art-scrim"></span>
        <span class="art-index">SQ / ${q.id.padStart(3, '0')}</span>
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
  const image =
    q.id === '1'
      ? 'assets/card-flourish.jpg'
      : q.id === '3'
        ? 'assets/moonwalk.jpg'
        : null;

  return image
    ? `<img src="${image}" alt="${esc(q.title)}"/>`
    : `<span class="${cls}">${icon(q)}</span>`;
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
  return `
    <div class="daily-actions">
      <button class="btn btn-dark btn-xl" data-start="${q.id}">ACCEPT QUEST →</button>
      <button class="btn btn-outline btn-xl" data-act="daily-skip" ${d.skipsLeft ? '' : 'disabled'}>
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
          ${d.streak ? `<span class="daily-streak">🔥 ${d.streak} DAY${d.streak === 1 ? '' : 'S'} IN A ROW</span>` : ''}
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
          <a class="back-link" href="#/">← HOME</a>
          <span class="eyebrow">${fmtDay()}</span>
        </div>

        <div class="detail-hero">
          <div class="detail-copy">
            <span class="eyebrow">✳ YOUR SIDEQUEST FOR TODAY</span>
            <h1>${esc(q.title)}</h1>
            <p class="type-tagline">${t.icon} ${esc(t.tagline)}</p>
            <p>${esc(q.description)}</p>
            <p class="daily-meta">${metaLine(q)}</p>
            ${
              d.streak
                ? `<p class="daily-streak-line">🔥 ${d.streak} day${d.streak === 1 ? '' : 's'} in a row</p>`
                : ''
            }
            ${dailyActions(d, { details: false })}
            <div class="detail-actions">
              <button class="btn btn-outline btn-lg" data-save="${q.id}">
                ${state.saved.includes(q.id) ? '★ SAVED' : '☆ SAVE FOR LATER'}
              </button>
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
              ${visual(quests[0])}
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
            quests[0],
            quests[2],
            quests[12]
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
              data-go="/progress"
            >
              SEE YOUR PROGRESS ↗
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
        <a class="back-link" href="#/">← BACK HOME</a>

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
            <div class="filter-row"><span class="filter-label">TOPIC</span><div class="category-filters">${pill('cat', '', 'All')}${categories.map((c) => pill('cat', c, c)).join('')}</div></div>
          </div>
          <div class="filter-mobile" aria-label="Quest filters">
            <details class="filter-dropdown"><summary>VIBE <b>${esc(qs.type || 'All')}</b></summary><div class="filter-dropdown-options">${pill('type', '', 'All')}${QUEST_TYPES.map((t) => pill('type', t.id, `${t.icon} ${t.id}`)).join('')}</div></details>
            <details class="filter-dropdown"><summary>TIME <b>${esc(qs.time ? qs.time + ' MIN' : 'Any')}</b></summary><div class="filter-dropdown-options">${TIME_PILLS.map(([v, l]) => pill('time', v, l)).join('')}</div></details>
            <details class="filter-dropdown"><summary>WHERE <b>${esc(qs.env || 'Anywhere')}</b></summary><div class="filter-dropdown-options">${ENV_PILLS.map(([v, l]) => pill('env', v, l)).join('')}</div></details>
            <details class="filter-dropdown"><summary>TOPIC <b>${esc(qs.cat || 'All')}</b></summary><div class="filter-dropdown-options">${pill('cat', '', 'All')}${categories.map((c) => pill('cat', c, c)).join('')}</div></details>
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
        <a class="back-link" href="#/">
          ← BACK HOME
        </a>

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
          <a class="back-link" href="#/">
            ← BACK HOME
          </a>

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
          <a class="back-link" href="#/discover">
            ← DISCOVER
          </a>

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
  reveal(id);
  const q = questById(id);
  const d = q.detail;

  return `
    <div class="active-page">
      <div class="active-inner">
        <div class="active-top">
          <a
            class="back-link"
            href="#/quest/${id}"
          >
            ← QUEST
          </a>

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

              <strong id="timer">
                ${String(q.minutes).padStart(2, '0')}:00
              </strong>

              <p class="muted">
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
      <div class="complete-inner">
        <div class="completion-art">
          <img src="${questImage(q)}" alt="" />
          <span>QUEST CLEAR</span>
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

        ${wasDaily && streak > 1 ? `<p class="daily-streak-line">${streak} DAYS IN A ROW</p>` : ''}

        <div class="reward-list">
          <div>
            <strong>+1</strong>
            <span>QUEST</span>
          </div>

          <div>
            <strong>${newSkill ? '+1' : '—'}</strong>
            <span>${newSkill ? 'NEW SKILL' : 'SKILL LEVELLED'}</span>
          </div>

          <div>
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
              .map(([v, l]) => `<button data-reflect="${esc(v)}" aria-pressed="${e.reflection === v}" class="${e.reflection === v ? 'active' : ''}">${l}</button>`)
              .join('')}
          </div>

          <span class="eyebrow reflect-gap">WOULD YOU DO IT AGAIN?</span>
          <div class="reflection-options again-options" role="group" aria-label="Would you do it again?">
            ${AGAIN.map(([v, l]) => `<button data-again="${v}" aria-pressed="${e.again === v}" class="${e.again === v ? 'active' : ''}">${l}</button>`).join('')}
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
          <a
            class="back-link"
            href="#/progress"
          >
            ← PROGRESS
          </a>

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

function progress() {
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
            return s ? `<p class="daily-streak-line">🔥 ${s} day${s === 1 ? '' : 's'} in a row on the Daily SideQuest</p>` : '';
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

function showcase() {
  const done = state.completed
    .filter((c) => c.public)
    .map((c) => ({
      c,
      q: questById(c.id)
    }));

  return `
    <div class="list-page">
      <div class="page-wrap-wide">
        <section class="page-heading">
          <span class="eyebrow">
            THE SHOWCASE
          </span>

          <h1>
            THINGS PEOPLE<br>
            <em>ACTUALLY DID.</em>
          </h1>

          <p>
            Small skills, strange experiments and tiny wins
            worth remembering.
          </p>
        </section>

        <div class="showcase-grid">
          ${
            done.length
              ? done
                  .map(
                    ({ c, q }) => `
                      <article class="showcase-tile">
                        <div>
                          <span class="eyebrow">
                            SIDEQUEST CLEAR / @you
                          </span>

                          <div class="showcase-tile-icon">
                            ${icon(q)}
                          </div>

                          <h2>
                            ${esc(q.title)}
                          </h2>
                        </div>

                        <span class="eyebrow">
                          ${q.skill} ·
                          ${new Date(c.date).toLocaleDateString()}
                        </span>
                      </article>
                    `
                  )
                  .join('')
              : '<p class="muted">Your public completions will appear here. Finish a quest and add it to the showcase.</p>'
          }
        </div>
      </div>
    </div>
  `;
}

/* ---------------- Profile hub (tabs) ---------------- */
function profileTabs(active) {
  const tabs = [
    ['/progress', 'Progress'],
    ['/my-quests', 'My Quests'],
    ['/challenges', 'Challenges'],
    ['/settings', 'Settings'],
    ['/account', 'Account']
  ];
  return `
    <nav class="profile-tabs" aria-label="Profile sections">
      ${tabs
        .map(
          ([p, l]) => `
        <a href="#${p}" class="${active === p ? 'active' : ''}" ${active === p ? 'aria-current="page"' : ''}>
          ${l}${p === '/challenges' && ui.net.waiting ? `<i class="nav-dot" aria-label="${ui.net.waiting} waiting"></i>` : ''}
        </a>`
        )
        .join('')}
    </nav>`;
}

const unavailable = (what) => `
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
    <a class="btn btn-dark btn-lg" href="#/account">SIGN IN OR CREATE ACCOUNT →</a>
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
          <span class="avatar" aria-hidden="true">${esc((u.displayName || u.username).slice(0, 1).toUpperCase())}</span>
          <div>
            <h2>${esc(u.displayName)}</h2>
            <p class="muted">@${esc(u.username)}</p>
          </div>
        </div>
        <form class="form-row" data-form="profile-name">
          <label for="dn">Display name</label>
          <div class="inline-form">
            <input id="dn" name="displayName" maxlength="30" value="${esc(u.displayName)}" autocomplete="nickname" />
            <button class="btn btn-outline btn-md" type="submit">SAVE</button>
          </div>
        </form>
      </div>

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
    const signup = a.mode === 'signup';
    body = `
      <div class="panel">
        <div class="seg" role="tablist">
          <button role="tab" aria-selected="${!signup}" class="${!signup ? 'active' : ''}" data-act="account-tab" data-v="signin">SIGN IN</button>
          <button role="tab" aria-selected="${signup}" class="${signup ? 'active' : ''}" data-act="account-tab" data-v="signup">CREATE ACCOUNT</button>
        </div>
        <form class="auth-form" data-form="auth" novalidate>
          <label for="au">Username</label>
          <input id="au" name="username" value="${esc(a.form?.username || '')}" autocomplete="username" autocapitalize="none" spellcheck="false" maxlength="20" required />
          ${signup ? `<label for="ad">Display name <span class="muted">(optional)</span></label>
                      <input id="ad" name="displayName" value="${esc(a.form?.displayName || '')}" maxlength="30" autocomplete="nickname" />` : ''}
          <label for="ap">Password</label>
          <input id="ap" name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="8" required />
          ${a.error ? `<p class="form-error" role="alert">${esc(a.error)}</p>` : ''}
          <button class="btn btn-dark btn-xl" type="submit" ${a.busy ? 'disabled' : ''}>
            ${a.busy ? 'ONE SEC…' : signup ? 'CREATE ACCOUNT →' : 'SIGN IN →'}
          </button>
        </form>
        <p class="muted">${signup
          ? 'Usernames are 3–20 characters (a–z, 0–9, _). Passwords need 8+. There’s no email, so there’s no password reset yet. Keep it somewhere safe.'
          : 'Everything on this device is kept and merged in. Nothing gets overwritten.'}</p>
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
          <span><strong>Daily reminder time</strong><small>Local time. We’ll never send outside 8am–9pm.</small></span>
          <input type="time" data-notif-time value="${esc(n.time)}" ${on ? '' : 'disabled'} aria-label="Daily reminder time" />
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
    declined: 'Declined'
  }[c.status];

  let actions = '';
  if (c.status === 'pending' && c.mine === 'recipient') {
    actions = `<button class="btn btn-dark btn-md" data-act="chal-respond" data-id="${c.id}" data-v="1">ACCEPT</button>
               <button class="btn btn-outline btn-md" data-act="chal-respond" data-id="${c.id}" data-v="0">NOT NOW</button>`;
  } else if (c.status === 'accepted' && !meDone) {
    actions = `<button class="btn btn-lime btn-md" data-start="${q.id}">START QUEST →</button>`;
  } else if (c.status === 'completed' || (c.status === 'accepted' && meDone)) {
    actions = `<button class="btn btn-outline btn-md" data-completion-card="${q.id}">VIEW MY CARD</button>`;
  }

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
      ${!ch.length && !n.loading ? '<p class="muted">No challenges yet. Add a friend, then send the first one.</p>' : ''}

      <section class="list-section">
        <div class="list-heading"><h2>FRIENDS</h2><span class="eyebrow">${fr.friends.length}</span></div>

        ${fr.incoming.map((p) => `
          <div class="friend-row">
            <span><strong>${personName(p)}</strong> <small>@${esc(p.username)} wants to be friends</small></span>
            <span>
              <button class="btn btn-dark btn-sm" data-act="friend-respond" data-u="${esc(p.username)}" data-v="1">ACCEPT</button>
              <button class="btn btn-outline btn-sm" data-act="friend-respond" data-u="${esc(p.username)}" data-v="0">DECLINE</button>
            </span>
          </div>`).join('')}

        ${fr.friends.map((p) => `
          <div class="friend-row">
            <span><strong>${personName(p)}</strong> <small>@${esc(p.username)}</small></span>
            <span>
              <a class="btn btn-outline btn-sm" href="#/challenge/new" data-act="chal-friend" data-u="${esc(p.username)}">CHALLENGE</a>
              <button class="link-btn danger-link" data-act="friend-remove" data-u="${esc(p.username)}">Remove</button>
            </span>
          </div>`).join('')}

        ${fr.outgoing.map((p) => `
          <div class="friend-row muted"><span>${personName(p)} <small>@${esc(p.username)} · request sent</small></span></div>`).join('')}

        ${!fr.friends.length && !fr.incoming.length && !fr.outgoing.length ? '<p class="muted">No friends yet.</p>' : ''}

        <form class="inline-form friend-add" data-form="friend-add">
          <label class="sr-only" for="fu">Friend’s username</label>
          <input id="fu" name="username" placeholder="Add a friend by username" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="21" required />
          <button class="btn btn-dark btn-md" type="submit">ADD</button>
        </form>
        <p class="muted">Friends are found by exact username only. Nobody can browse other users.</p>
      </section>`;
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
    Object.assign(state, merged);
    persist();
    ui.home = null;
  },
  status: (s) => {
    ui.sync = { state: s.state === 'signedout' ? 'idle' : s.state, last: cloud.syncInfo.last };
    if (s.state === 'signedout') ui.net = { friends: null, challenges: null, waiting: 0, loading: false, error: '' };
    if (['/account', '/settings'].includes(route())) rerenderIfSafe();
  }
});

async function afterAuth(user) {
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
    ui.account = { ...ui.account, mode: 'signin', error: '', form: null, confirmDelete: false, pending: null };
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

  'friend-respond': async (el) => {
    const r = await cloud.respondFriend(el.dataset.u, el.dataset.v === '1');
    if (!r.ok) toast(r.data.error || 'Something went wrong.');
    await loadNet({ silent: true });
  },
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

document.addEventListener('click', (e) => {
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
    save();
    await notify.syncPrefs(state.prefs.notif);
    return;
  }
  const tm = e.target.closest('[data-notif-time]');
  if (tm && /^\d\d:\d\d$/.test(tm.value)) {
    state.prefs.notif.time = tm.value;
    save();
    await notify.syncPrefs(state.prefs.notif);
    toast(`Daily reminder at ${tm.value}.`);
  }
});

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  const kind = form.dataset.form;

  if (kind === 'auth') {
    const a = ui.account;
    a.busy = true;
    a.error = '';
    a.form = { username: data.username, displayName: data.displayName };
    render();
    const r = a.mode === 'signup'
      ? await cloud.signUp(data.username, data.password, data.displayName)
      : await cloud.signIn(data.username, data.password);
    a.busy = false;
    if (!r.ok) {
      a.error = r.status === 0 ? 'Can’t reach the SideQuest server right now.' : r.data.error || 'Something went wrong.';
      render();
      return;
    }
    a.form = null;
    await afterAuth(r.data.user);
    render();
    toast(`Welcome${a.mode === 'signup' ? '' : ' back'}, ${r.data.user.displayName}.`);
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

/* keep the radio highlight + quest preview in sync without re-rendering the form */
document.addEventListener('change', (e) => {
  if (e.target.name === 'quest') { ui.chal.quest = e.target.value; render({ keepFocus: true }); }
  if (e.target.name === 'friend') { ui.chal.friend = e.target.value; render({ keepFocus: true }); }
});

const TITLES = {
  '/': 'SideQuest', '/daily': 'Today’s SideQuest', '/discover': 'Discover', '/roll': 'Quest Roll',
  '/bored': 'I’m Bored', '/weird': 'Something Weird', '/my-quests': 'My Quests', '/progress': 'Progress',
  '/showcase': 'Showcase', '/challenges': 'Friend Challenges', '/settings': 'Settings', '/account': 'Account',
};

function render({ keepFocus = false, fromNav = false } = {}) {
  const r = route();
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
  } else if (r === '/progress') {
    content = progress();
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
  document.title = r.startsWith('/quest/') ? `${face(questById(r.split('/')[2])).title} · SideQuest` : TITLES[r] ? `${TITLES[r]} · SideQuest` : 'SideQuest';

  bind();

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
  if (r.endsWith('/card')) paintCard();
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
      el.onclick = () => {
        const c = entryFor(el.dataset.showcase);

        if (c) {
          c.public = true;
        }

        save();
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
  lastRoute = r;
  render({ fromNav: true });
  if (isProfileRoute(r) && cloud.signedIn() && cloud.backend()) loadNet({ silent: true });
});

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
})();

let lastVis = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || Date.now() - lastVis < 60000) return;
  lastVis = Date.now();
  armNotifications();
  if (cloud.signedIn() && cloud.backend()) {
    cloud.syncNow().then(() => loadNet({ silent: true }));
  }
});
