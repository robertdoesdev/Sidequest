import {
  quests,
  categories,
  interestGroups,
  questById,
  matchingQuests
} from './data.js';

const $ = (s, root = document) => root.querySelector(s);
const app = $('#app');
const KEY = 'sidequest-v1';

const state = {
  interests: [],
  saved: [],
  completed: [],
  onboarded: false,
  active: null
};

try {
  Object.assign(
    state,
    JSON.parse(localStorage.getItem(KEY) || '{}')
  );
} catch {}

const save = () =>
  localStorage.setItem(
    KEY,
    JSON.stringify({
      interests: state.interests,
      saved: state.saved,
      completed: state.completed,
      onboarded: state.onboarded
    })
  );

const esc = (s) =>
  String(s).replace(
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
  location.hash = p;
  window.scrollTo({
    top: 0,
    behavior: 'smooth'
  });
};

const meta = (q) =>
  `<span>${q.category}</span><span>${q.minutes} min</span><span>${q.difficulty}</span>`;

function shell(content, { immersive = false } = {}) {
  if (immersive) {
    return `<main class="immersive-main">${content}</main>`;
  }

  return `
    <header class="site-header">
      <div class="header-inner">
        <a class="brand" href="#/">
          <span>sidequest<span class="brand-dot">.</span></span>
        </a>

        <nav class="desktop-nav">
          <a href="#/" data-nav="/">Home</a>
          <a href="#/discover" data-nav="/discover">Discover</a>
          <a href="#/my-quests" data-nav="/my-quests">My Quests</a>
          <a href="#/showcase" data-nav="/showcase">Showcase</a>
          <a href="#/progress" data-nav="/progress">Progress</a>
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

    <nav class="mobile-nav">
      <a href="#/">
        ⌂
        <span>Home</span>
      </a>

      <a href="#/discover">
        ◉
        <span>Discover</span>
      </a>

      <a href="#/roll" class="mobile-roll">✣</a>

      <a href="#/my-quests">
        ▱
        <span>My Quests</span>
      </a>

      <a href="#/progress">
        ◌
        <span>Profile</span>
      </a>
    </nav>
  `;
}

function questCard(q) {
  return `
    <article class="quest-card">
      <div class="quest-art art-${q.category.toLowerCase()}">
        <span class="quest-art-icon">${icon(q)}</span>
        <span class="art-index">SQ / ${q.id.padStart(3, '0')}</span>
      </div>

      <div class="quest-card-content">
        <div class="card-topline">
          <span class="eyebrow">
            ${q.category} / ${q.minutes} min / ${q.difficulty}
          </span>

          <button
            class="btn btn-icon"
            data-save="${q.id}"
            aria-label="Save"
          >
            ${state.saved.includes(q.id) ? '★' : '☆'}
          </button>
        </div>

        <a
          href="#/quest/${q.id}"
          class="quest-title-link"
        >
          <h3>${esc(q.title)}</h3>
        </a>

        <p>${esc(q.description)}</p>

        <div class="quest-card-bottom">
          <span class="muted">
            ✦ You'll gain: ${esc(q.skill)}
          </span>

          <button
            class="btn btn-ghost btn-sm"
            data-start="${q.id}"
          >
            Start quest ↗
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

function home() {
  const matches = matchingQuests(state.interests);

  const picked =
    matches.find((q) => q.id !== '1') || quests[1];

  const different =
    quests.find(
      (q) =>
        !matches.some((m) => m.id === q.id) &&
        q.id !== '1'
    ) || quests[0];

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
                class="btn btn-outline btn-xl"
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

          <a
            class="section-link"
            href="#/discover"
          >
            Explore all quests ↗
          </a>
        </div>

        <div class="home-feature-grid">
          <div class="recommendation-lead">
            <div class="recommendation-badge">
              ✦ PICKED FOR YOU
            </div>

            <p>
              ${
                state.interests.length
                  ? 'Because you are into something interesting...'
                  : 'A little something to get you started.'
              }
            </p>

            <h3>${esc(picked.title)}</h3>

            <div class="recommendation-meta">
              ${picked.minutes} MIN ·
              ${picked.category.toUpperCase()} ·
              ${picked.difficulty.toUpperCase()}
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
                ${different.category} ·
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

      <section class="content-section popular-section">
        <div class="section-heading">
          <div>
            <span class="eyebrow section-kicker">
              02 / PICK YOUR PATH
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

        <a href="#/onboarding">
          ${
            state.onboarded
              ? 'Edit interests'
              : 'Choose your interests'
          }
          ↗
        </a>
      </footer>
    </div>
  `;
}

function discover() {
  const qs = state.discover || {};

  const filtered = quests.filter(
    (q) =>
      (!qs.cat || q.category === qs.cat) &&
      (!qs.time || q.minutes <= +qs.time) &&
      (!qs.diff || q.difficulty === qs.diff) &&
      (
        !qs.search ||
        `${q.title} ${q.skill} ${q.category} ${q.interests.join(' ')}`
          .toLowerCase()
          .includes(qs.search.toLowerCase())
      )
  );

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
            value="${esc(qs.search || '')}"
            placeholder="Search quests, skills, categories..."
          />

          <div class="filter-line">
            <div class="category-filters">
              <button
                class="filter-pill ${!qs.cat ? 'active' : ''}"
                data-filter-cat=""
              >
                All
              </button>

              ${categories
                .map(
                  (c) => `
                    <button
                      class="filter-pill ${
                        qs.cat === c ? 'active' : ''
                      }"
                      data-filter-cat="${c}"
                    >
                      ${c}
                    </button>
                  `
                )
                .join('')}
            </div>

            <div class="select-filters">
              <button
                class="filter-pill ${!qs.time ? 'active' : ''}"
                data-filter-time=""
              >
                Any time
              </button>

              <button
                class="filter-pill ${
                  qs.time === '5' ? 'active' : ''
                }"
                data-filter-time="5"
              >
                Under 5
              </button>

              <button
                class="filter-pill ${
                  qs.time === '15' ? 'active' : ''
                }"
                data-filter-time="15"
              >
                Under 15
              </button>

              <button
                class="filter-pill ${
                  qs.time === '30' ? 'active' : ''
                }"
                data-filter-time="30"
              >
                Under 30
              </button>
            </div>
          </div>
        </section>

        <div class="results-line">
          <span>${filtered.length} quests found</span>
          <span>Pick something and go.</span>
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

function bored() {
  const b = state.bored || {
    step: 1,
    time: null,
    mood: null,
    result: null
  };

  let body = '';

  if (b.result) {
    const q = questById(b.result);

    body = `
      <span class="eyebrow">WE HAVE A MATCH ✳</span>

      <div class="bored-result-icon">
        ${icon(q)}
      </div>

      <h2>${esc(q.title)}</h2>

      <p>${esc(q.description)}</p>

      <div class="eyebrow">
        ${q.minutes} MIN ·
        ${q.category.toUpperCase()} ·
        ${q.difficulty.toUpperCase()}
      </div>

      <button
        class="btn btn-lime btn-xl"
        data-start="${q.id}"
      >
        LET'S DO IT →
      </button>

      <button
        class="choice-btn"
        data-bored-reset
      >
        ↻ TRY ANOTHER
      </button>
    `;
  } else if (!b.time) {
    body = `
      <span class="eyebrow">FIRST THINGS FIRST</span>

      <h2>
        How much time<br>
        do you have?
      </h2>

      ${[
        [5, '5 MIN'],
        [10, '10 MIN'],
        [30, '30 MIN'],
        [999, "I DON'T CARE"]
      ]
        .map(
          ([v, l]) => `
            <button
              class="choice-btn"
              data-bored-time="${v}"
            >
              ${l}
              <span>→</span>
            </button>
          `
        )
        .join('')}
    `;
  } else {
    body = `
      <span class="eyebrow">ONE MORE THING</span>

      <h2>
        What sounds<br>
        good?
      </h2>

      ${[
        'MAKE SOMETHING',
        'LEARN SOMETHING',
        'MOVE',
        'SOCIALIZE',
        'SURPRISE ME'
      ]
        .map(
          (m) => `
            <button
              class="choice-btn"
              data-bored-mood="${m}"
            >
              ${m}
              <span>→</span>
            </button>
          `
        )
        .join('')}

      <button
        class="choice-btn"
        data-bored-time="reset"
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

            <div class="bored-decoration">
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

function roll() {
  const r = state.roll || {
    phase: 'idle',
    display: quests[0],
    count: 0
  };

  const q = questById(r.display);

  return `
    <div class="roll-page ${
      r.phase === 'rolling' ? 'rolling' : ''
    }">
      <div class="page-wrap-wide">
        <div class="roll-top">
          <a class="back-link" href="#/">
            ← BACK HOME
          </a>

          <span class="eyebrow">
            THE QUEST GENERATOR /
            ${String(r.count).padStart(3, '0')}
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
              NO. ${String(r.count).padStart(3, '0')}
            </span>
          </div>

          <div class="machine-window">
            <span class="machine-label">
              ${
                r.phase === 'reveal'
                  ? '✳ YOUR SIDEQUEST'
                  : r.phase === 'rolling'
                    ? 'FINDING YOUR NEXT STORY...'
                    : 'SOMETHING GOOD IS COMING...'
              }
            </span>

            <div class="machine-title">
              ${
                r.phase === 'idle'
                  ? 'WHAT WILL<br>YOU TRY?'
                  : esc(q.title)
              }
            </div>

            <div class="machine-bottom">
              ${
                r.phase === 'reveal'
                  ? `${q.minutes} MIN · ${q.category.toUpperCase()} · ${q.difficulty.toUpperCase()}`
                  : 'A WHOLE WORLD OF POSSIBILITIES'
              }
            </div>

            <span class="machine-cross cross-one">
              ✳
            </span>

            <span class="machine-cross cross-two">
              ✳
            </span>
          </div>

          <div class="machine-footer">
            <span>CHANCE LOOKS GOOD ON YOU.</span>
            <span>↗ ↗ ↗</span>
          </div>
        </div>

        ${
          r.phase === 'reveal'
            ? `
              <div class="roll-result">
                <div class="result-visual">
                  ${icon(q)}
                </div>

                <div>
                  <span class="eyebrow">
                    QUEST UNLOCKED ↗
                  </span>

                  <p>
                    ${esc(q.description)}
                  </p>

                  <div class="result-actions">
                    <button
                      class="btn btn-lime btn-xl"
                      data-start="${q.id}"
                    >
                      ACCEPT QUEST →
                    </button>

                    <button
                      class="btn btn-outline btn-xl"
                      data-roll-again
                    >
                      ↻ ROLL AGAIN
                    </button>
                  </div>
                </div>
              </div>
            `
            : `
              <div class="roll-action">
                <button
                  class="btn btn-lime btn-xl"
                  data-roll
                >
                  ${
                    r.phase === 'rolling'
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

function detail(id) {
  const q = questById(id);

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
              ${q.category} /
              ${q.minutes} MIN /
              ${q.difficulty}
            </span>

            <h1>${esc(q.title)}</h1>

            <p>${esc(q.description)}</p>

            <div class="detail-meta">
              ${meta(q)}
            </div>

            <div class="detail-actions">
              <button
                class="btn btn-dark btn-xl"
                data-start="${q.id}"
              >
                START QUEST →
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
            </div>
          </div>

          <div class="detail-image">
            ${visual(q, 'detail-symbol')}
          </div>
        </div>

        <div class="detail-sections">
          <section>
            <span class="eyebrow">
              WHY TRY IT?
            </span>

            <h2>
              MAKE THE<br>
              ORDINARY<br>
              INTERESTING.
            </h2>

            <p>${esc(q.why)}</p>

            <h3
              class="eyebrow"
              style="margin-top:40px"
            >
              YOU'LL GAIN
            </h3>

            <p>
              <strong>${esc(q.skill)}</strong>
            </p>
          </section>

          <section>
            <span class="eyebrow">
              PRE-FLIGHT CHECK
            </span>

            <h2>YOU'LL NEED</h2>

            <ul class="need-list">
              ${q.need
                .map((x) => `<li>${esc(x)}</li>`)
                .join('')}
            </ul>

            <h2 style="margin-top:50px">
              THE QUEST
            </h2>

            <ol class="step-list">
              ${q.steps
                .map((x) => `<li>${esc(x)}</li>`)
                .join('')}
            </ol>
          </section>
        </div>
      </div>
    </div>
  `;
}

function active(id) {
  const q = questById(id);

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
            <span class="eyebrow">
              THE QUEST
            </span>

            <ol class="step-list">
              ${q.steps
                .map((x) => `<li>${esc(x)}</li>`)
                .join('')}
            </ol>
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

function complete(id) {
  const q = questById(id);

  return `
    <div class="complete-page">
      <div class="complete-inner">
        <div class="completion-icon">
          ✓
        </div>

        <span class="eyebrow">
          SIDEQUEST COMPLETE
        </span>

        <h1>
          YOU DID<br>
          <em>THE THING.</em>
        </h1>

        <p>
          You just learned something you didn't know before.
        </p>

        <div class="reward-list">
          <div>
            <strong>+1</strong>
            <span>QUEST</span>
          </div>

          <div>
            <strong>+1</strong>
            <span>SKILL</span>
          </div>

          <div>
            <strong>+1</strong>
            <span>CATEGORY</span>
          </div>
        </div>

        <div class="reflection">
          <span class="eyebrow">
            HOW DID IT GO?
          </span>

          <div class="reflection-options">
            <button data-reflect="😭 Couldn't do it">
              😭 Couldn't do it
            </button>

            <button data-reflect="😅 Almost">
              😅 Almost
            </button>

            <button data-reflect="😎 Nailed it">
              😎 Nailed it
            </button>
          </div>
        </div>

        <button
          class="btn btn-lime btn-xl"
          style="margin-top:25px"
          data-completion-card="${q.id}"
        >
          CREATE MY SIDEQUEST CARD →
        </button>
      </div>
    </div>
  `;
}

function card(id) {
  const q = questById(id);

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

              <button
                class="btn btn-outline btn-lg"
                data-showcase="${q.id}"
              >
                ADD TO SHOWCASE
              </button>
            </div>
          </div>

          <div>
            <div
              class="showcase-card"
              id="share-card"
            >
              <div class="showcase-card-top">
                <span>SIDEQUEST CLEAR</span>
                <span>✳</span>
              </div>

              <div class="showcase-card-icon">
                ${icon(q)}
              </div>

              <h2>${esc(q.title)}</h2>

              <div class="showcase-card-details">
                <span>${q.minutes} MIN</span>
                <span>${q.category.toUpperCase()}</span>
                <span>+1 SKILL</span>
              </div>

              <div class="showcase-card-footer">
                <span>
                  ONE MORE THING I CAN DO NOW.
                </span>

                <span>
                  SQ / ${q.id.padStart(3, '0')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
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
                            ${q.category} / ${q.minutes} MIN
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
        </div>
      </section>

      <section class="progress-content">
        <div class="page-wrap-wide">
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

function onboarding() {
  return `
    <div class="onboarding">
      <div class="onboarding-inner">
        <div class="onboarding-heading">
          <span class="eyebrow">
            SIDEQUEST / PERSONALIZE
          </span>

          <h1>
            WHAT ARE<br>
            YOU INTO?
          </h1>

          <p class="muted">
            Pick a few. We'll use them to find quests
            you'll actually want to try.
          </p>
        </div>

        <div class="interest-groups">
          ${Object.entries(interestGroups)
            .map(
              ([group, items]) => `
                <section class="interest-group">
                  <span class="eyebrow">
                    ${group}
                  </span>

                  <h2>
                    Choose what sounds like you.
                  </h2>

                  <div class="interest-options">
                    ${items
                      .map(
                        (i) => `
                          <button
                            class="${
                              state.interests.includes(i)
                                ? 'active'
                                : ''
                            }"
                            data-interest="${esc(i)}"
                          >
                            ${esc(i)}
                          </button>
                        `
                      )
                      .join('')}
                  </div>
                </section>
              `
            )
            .join('')}
        </div>

        <div class="onboarding-bottom">
          <span class="eyebrow">
            ${state.interests.length} SELECTED
          </span>

          <button
            class="btn btn-dark btn-lg"
            data-finish-onboarding
          >
            CONTINUE →
          </button>
        </div>
      </div>
    </div>
  `;
}

function render() {
  const r = route();
  let content = '';

  if (r === '/') {
    content = home();
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
  } else if (r === '/onboarding') {
    app.innerHTML = onboarding();
    bind();
    return;
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

  document
    .querySelectorAll('[data-nav]')
    .forEach((a) => {
      if (a.dataset.nav === r) {
        a.classList.add('nav-active');
      }
    });

  bind();
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
      el.onclick = () => {
        state.active = el.dataset.start;
        save();
        go(`/quest/${el.dataset.start}/active`);
      };
    });

  document
    .querySelectorAll('[data-save]')
    .forEach((el) => {
      el.onclick = () => {
        const id = el.dataset.save;

        state.saved = state.saved.includes(id)
          ? state.saved.filter((x) => x !== id)
          : [...state.saved, id];

        save();
        render();
      };
    });

  document
    .querySelectorAll('[data-roll]')
    .forEach((el) => {
      el.onclick = () => {
        if (el.disabled) return;

        el.disabled = true;

        const current = state.roll || {};
        const count = (current.count || 0) + 1;

        state.roll = {
          phase: 'rolling',
          display: String(
            Math.floor(Math.random() * quests.length) + 1
          ),
          count
        };

        render();

        let ticks = 0;
        const total = 14;

        const timer = setInterval(() => {
          ticks++;

          state.roll.display = String(
            Math.floor(Math.random() * quests.length) + 1
          );

          render();

          if (ticks >= total) {
            clearInterval(timer);

            state.roll = {
              phase: 'reveal',
              display: String(
                Math.floor(Math.random() * quests.length) + 1
              ),
              count
            };

            render();
          }
        }, 80 + Math.min(ticks, 10) * 18);
      };
    });

  document
    .querySelectorAll('[data-roll-again]')
    .forEach((el) => {
      el.onclick = () => {
        state.roll = {
          phase: 'idle',
          display: '1',
          count: state.roll?.count || 0
        };

        render();
      };
    });

  document
    .querySelectorAll('[data-bored-time]')
    .forEach((el) => {
      el.onclick = () => {
        if (el.dataset.boredTime === 'reset') {
          state.bored = {
            step: 1,
            time: null
          };
        } else {
          state.bored = {
            step: 2,
            time: +el.dataset.boredTime
          };
        }

        render();
      };
    });

  document
    .querySelectorAll('[data-bored-mood]')
    .forEach((el) => {
      el.onclick = () => {
        const time = state.bored.time;
        const mood = el.dataset.boredMood;

        const pool = quests.filter(
          (q) =>
            (time >= 999 || q.minutes <= time) &&
            (
              mood === 'SURPRISE ME' ||
              mood === 'MAKE SOMETHING'
                ? ['Creative', 'Practical'].includes(q.category)
                : mood === 'MOVE'
                  ? q.category === 'Physical'
                  : mood === 'SOCIALIZE'
                    ? q.category === 'Social'
                    : ['Brain', 'Tech', 'Random'].includes(q.category)
            )
        );

        state.bored = {
          ...state.bored,
          result: (
            pool[
              Math.floor(Math.random() * pool.length)
            ] || quests[0]
          ).id
        };

        render();
      };
    });

  document
    .querySelectorAll('[data-bored-reset]')
    .forEach((el) => {
      el.onclick = () => {
        state.bored = {
          step: 2,
          time: state.bored.time
        };

        render();
      };
    });

  document
    .querySelectorAll('[data-complete]')
    .forEach((el) => {
      el.onclick = () => {
        state.active = el.dataset.complete;

        state.completed = state.completed.filter(
          (c) => c.id !== el.dataset.complete
        );

        state.completed.push({
          id: el.dataset.complete,
          reflection: '',
          public: false,
          date: Date.now()
        });

        save();

        go(`/quest/${el.dataset.complete}/complete`);
      };
    });

  document
    .querySelectorAll('[data-reflect]')
    .forEach((el) => {
      el.onclick = () => {
        if (!state.active) return;

        const c = state.completed.find(
          (x) => x.id === state.active
        );

        if (c) {
          c.reflection = el.dataset.reflect;
        }

        save();

        el.parentElement
          .querySelectorAll('button')
          .forEach((b) => {
            b.classList.remove('active');
          });

        el.classList.add('active');
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
        const c = state.completed.find(
          (x) => x.id === el.dataset.showcase
        );

        if (c) {
          c.public = true;
        }

        save();
        go('/showcase');
      };
    });

  document
    .querySelectorAll('[data-interest]')
    .forEach((el) => {
      el.onclick = () => {
        const i = el.dataset.interest;

        state.interests = state.interests.includes(i)
          ? state.interests.filter((x) => x !== i)
          : [...state.interests, i];

        save();
        render();
      };
    });

  document
    .querySelectorAll('[data-finish-onboarding]')
    .forEach((el) => {
      el.onclick = () => {
        state.onboarded = true;
        save();
        go('/');
      };
    });

  const search = $('#search');

  if (search) {
    search.oninput = () => {
      state.discover = {
        ...(state.discover || {}),
        search: search.value
      };

      save();
      render();
    };
  }

  document
    .querySelectorAll('[data-filter-cat]')
    .forEach((el) => {
      el.onclick = () => {
        state.discover = {
          ...(state.discover || {}),
          cat: el.dataset.filterCat
        };

        render();
      };
    });

  document
    .querySelectorAll('[data-filter-time]')
    .forEach((el) => {
      el.onclick = () => {
        state.discover = {
          ...(state.discover || {}),
          time: el.dataset.filterTime
        };

        render();
      };
    });

  document
    .querySelectorAll('[data-abandon]')
    .forEach((el) => {
      el.onclick = () => go('/');
    });

  const timer = $('#timer');

  if (timer && route().includes('/active')) {
    const q = questById(
      route().split('/')[2]
    );

    let seconds = Math.max(
      60,
      (q?.minutes || 5) * 60
    );

    const tick = () => {
      if (!document.body.contains(timer)) return;

      const m = String(
        Math.floor(seconds / 60)
      ).padStart(2, '0');

      const sec = String(
        seconds % 60
      ).padStart(2, '0');

      timer.textContent = `${m}:${sec}`;

      seconds = Math.max(0, seconds - 1);

      if (seconds > 0) {
        setTimeout(tick, 1000);
      }
    };

    tick();
  }

  document
    .querySelectorAll('[data-download-card]')
    .forEach((el) => {
      el.onclick = downloadCard;
    });
}

function downloadCard() {
  const card = $('#share-card');

  if (!card) return;

  const html = `
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="1200"
      height="1500"
    >
      <foreignObject
        width="100%"
        height="100%"
      >
        <div
          xmlns="http://www.w3.org/1999/xhtml"
          style="
            width:1200px;
            height:1500px;
            background:#eff9b6;
            color:#1f2a22;
            padding:80px;
            font-family:Arial
          "
        >
          <div
            style="
              font-size:28px;
              font-weight:bold;
              letter-spacing:5px
            "
          >
            SIDEQUEST CLEAR
          </div>

          <div
            style="
              font-size:180px;
              text-align:center;
              margin-top:180px
            "
          >
            ${icon(
              questById(
                route().split('/')[2]
              )
            )}
          </div>

          <div
            style="
              font-size:86px;
              font-weight:bold;
              line-height:.9;
              margin-top:80px
            "
          >
            ${
              esc(
                questById(
                  route().split('/')[2]
                ).title
              )
            }
          </div>

          <div
            style="
              margin-top:60px;
              border-top:2px solid #1f2a22;
              border-bottom:2px solid #1f2a22;
              padding:25px 0;
              font-weight:bold
            "
          >
            ${
              questById(
                route().split('/')[2]
              ).minutes
            }
            MIN

            &nbsp;&nbsp;

            ${
              questById(
                route().split('/')[2]
              ).category.toUpperCase()
            }

            &nbsp;&nbsp;

            +1 SKILL
          </div>

          <div
            style="
              margin-top:70px;
              font-size:24px;
              font-weight:bold;
              letter-spacing:3px
            "
          >
            ONE MORE THING I CAN DO NOW.
          </div>
        </div>
      </foreignObject>
    </svg>
  `;

  const a = document.createElement('a');

  a.href =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(html);

  a.download = 'sidequest-clear.svg';
  a.click();
}

window.addEventListener('hashchange', render);

render();