/* Navigation rules. Pure functions only (no DOM), so they can be unit-tested.

   One pattern everywhere: every deeper screen shows ONE back link.
   - If the person just came from a sensible screen (allow-listed per route), go back to it,
     so context is kept (public profile opened from Friends goes back to Friends).
   - Otherwise fall back to the route's fixed parent, so direct links and refreshes
     are never a dead end.
   - Top-level tabs (Home, Discover, Today, Profile) have no back link. */

const SECTION = ['/me', '/my-quests', '/friends', '/challenges', '/activity', '/settings', '/account'];
export const PROFILE_ROUTES = ['/profile', '/progress', ...SECTION];
export const isProfileRoute = (r) => PROFILE_ROUTES.includes(r) || r.startsWith('/challenge/') || r === '/showcase';

const LABELS = {
  '/': 'Home', '/discover': 'Discover', '/daily': 'Today', '/profile': 'Profile', '/progress': 'Profile',
  '/showcase': 'Showcase', '/friends': 'Friends', '/challenges': 'Challenges', '/my-quests': 'My quests',
  '/activity': 'Activity', '/me': 'My profile', '/settings': 'Settings', '/account': 'Account',
  '/roll': 'Roll', '/weird': 'Weird', '/bored': 'I’m bored'
};

export function routeLabel(r) {
  if (LABELS[r]) return LABELS[r];
  let m;
  if ((m = /^\/u\/([a-z0-9_]{3,20})$/.exec(r))) return `@${m[1]}`;
  if (/^\/challenge\//.test(r)) return 'Challenges';
  if (/^\/quest\/[^/]+$/.test(r)) return 'Quest';
  if (/^\/quest\/[^/]+\/complete$/.test(r)) return 'Quest complete';
  return 'Back';
}

/* Screens that are mid-flow or transient: never a good place to "go back" to. */
const isFlow = (r) => /^\/quest\/[^/]+\/(active|complete)$/.test(r) || r === '/login' || r === '/signup';

const kind = (r) => (r.startsWith('/u/') ? 'user' : r.startsWith('/quest/') ? 'quest' : r.startsWith('/challenge/') ? 'challenge' : r);

/* Fixed parent for each route (the fallback). null = top-level, no back link. */
export function parentOf(r) {
  if (r === '/' || r === '/discover' || r === '/daily' || r === '/profile' || r === '/progress') return r === '/daily' ? '/' : null;
  if (['/weird', '/bored', '/roll'].includes(r)) return '/';
  if (SECTION.includes(r)) return '/profile';
  if (r === '/showcase') return '/profile';
  if (r.startsWith('/challenge/')) return '/challenges';
  if (/^\/u\/[a-z0-9_]{3,20}$/.test(r)) return '/showcase';
  let m;
  if ((m = /^\/quest\/([^/]+)\/active$/.exec(r))) return `/quest/${m[1]}`;
  if ((m = /^\/quest\/([^/]+)\/complete$/.exec(r))) return '/';
  if ((m = /^\/quest\/([^/]+)\/card$/.exec(r))) return '/my-quests';
  if (/^\/quest\/[^/]+$/.test(r)) return '/discover';
  if (r === '/login' || r === '/signup') return '/';
  return '/';
}

/* Which previous screens count as a natural "came from" for a given route. */
const ALLOW = {
  user: ['/showcase', '/friends', '/challenges', '/profile', '/activity', '/me', '/', '/daily'],
  quest: ['/', '/discover', '/daily', '/roll', '/weird', '/bored', '/my-quests', '/showcase', '/challenges', '/friends', '/profile', '/activity', 'user', '/me'],
  '/showcase': ['/', '/profile', '/daily', '/discover', '/friends', 'user'],
  '/challenges': ['/profile', '/friends', 'user', '/', '/daily', 'quest'],
  '/friends': ['/profile', 'user', '/challenges', '/'],
  '/challenge': ['/challenges', '/friends', 'user', 'quest', '/'],
  '/activity': ['/profile', '/'],
  '/my-quests': ['/profile', '/me', '/', '/daily', '/activity']
};

export function backFor(r, prev) {
  if (r === '/progress') r = '/profile';
  /* `prev` comes from the URL hash, so only accept plain route-shaped values. */
  if (typeof prev !== 'string' || !/^\/[A-Za-z0-9_/-]{0,80}$/.test(prev)) prev = null;
  const parent = parentOf(r);
  if (parent === null) return null;
  const k = kind(r);
  const isCard = /^\/quest\/[^/]+\/card$/.test(r);
  let allow = ALLOW[k];
  if (isCard) allow = ['/', '/daily', '/my-quests', '/profile', '/activity', 'user', '/showcase'];
  if (/^\/quest\/[^/]+\/(active|complete)$/.test(r)) allow = null;       // flow screens use their fixed parent
  if (prev && allow && prev !== r && (!isFlow(prev) || (isCard && /^\/quest\/[^/]+\/complete$/.test(prev)))) {
    const pk = kind(prev);
    const quest = /^\/quest\/[^/]+$/.test(prev);
    const ok = allow.includes(prev) || (allow.includes(pk) && pk !== k) || (quest && allow.includes('quest') && k !== 'quest')
      || (isCard && /^\/quest\/[^/]+\/complete$/.test(prev));
    if (ok && prev !== '/progress') return { href: prev, label: routeLabel(prev), fromContext: true };
  }
  return { href: parent, label: routeLabel(parent), fromContext: false };
}
