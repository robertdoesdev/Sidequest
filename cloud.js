/* =====================================================================
   SideQuest V2 — cloud client: accounts, sync, friends, challenges.
   The app works fully without a backend. When /api/health answers,
   account features switch on; otherwise they are shown as unavailable
   (never faked).
   API base: window.SIDEQUEST_API, or localStorage 'sidequest-api',
   or same origin (default, used by `node server.mjs`).
   ===================================================================== */
const ACCOUNT_KEY = 'sidequest-account';
const BACKUP_KEY = 'sidequest-v1-premerge';

const base = () =>
  (typeof window !== 'undefined' && window.SIDEQUEST_API) ||
  localStorage.getItem('sidequest-api') ||
  '';

let health = null;

export const getAccount = () => {
  try { return JSON.parse(localStorage.getItem(ACCOUNT_KEY)) || null; } catch { return null; }
};
const setAccount = (a) => (a ? localStorage.setItem(ACCOUNT_KEY, JSON.stringify(a)) : localStorage.removeItem(ACCOUNT_KEY));
export const signedIn = () => !!getAccount()?.token;
export const backend = () => health;

export async function api(path, { method = 'GET', body, auth = true, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const acc = getAccount();
    if (auth && acc?.token) headers.Authorization = `Bearer ${acc.token}`;
    const res = await fetch(base() + path, {
      method, headers, signal: ctrl.signal,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = {};
    try { data = await res.json(); } catch {}
    if (res.status === 401 && auth && acc?.token) {
      setAccount(null);                         // session expired
      hooks.status?.({ state: 'signedout' });
    }
    return { ok: res.ok, status: res.status, data };
  } catch {
    return { ok: false, status: 0, data: { error: 'offline' } };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkBackend() {
  const r = await api('/api/health', { auth: false, timeout: 3500 });
  health = r.ok && r.data?.ok ? r.data : null;
  return health;
}

/* ---------- auth ---------- */
async function authCall(path, body) {
  const r = await api(path, { method: 'POST', body, auth: false });
  if (r.ok) setAccount({ token: r.data.token, user: r.data.user });
  return r;
}
export const signUp = (username, password, displayName) => authCall('/api/auth/signup', { username, password, displayName });
export const signIn = (username, password) => authCall('/api/auth/login', { username, password });
export async function signOut() {
  await api('/api/auth/logout', { method: 'POST' });
  setAccount(null);
  hooks.status?.({ state: 'signedout' });
}
export async function deleteAccount(password) {
  const r = await api('/api/me', { method: 'DELETE', body: { password } });
  if (r.ok) setAccount(null);
  return r;
}
export async function refreshMe() {
  const r = await api('/api/me');
  if (r.ok) { const a = getAccount(); if (a) setAccount({ ...a, user: r.data.user }); }
  return r;
}
export const updateProfile = async (displayName) => {
  const r = await api('/api/me', { method: 'PATCH', body: { displayName } });
  if (r.ok) { const a = getAccount(); if (a) setAccount({ ...a, user: r.data.user }); }
  return r;
};

/* ---------- merge (never destroys local data) ---------- */
const emptyStamps = () => ({ saved: {}, interests: {} });

function mergeMembership(aList, bList, aSt = {}, bSt = {}) {
  const ids = new Set([...aList, ...bList, ...Object.keys(aSt), ...Object.keys(bSt)]);
  const out = [];
  const stamps = {};
  ids.forEach((id) => {
    const cands = [aSt[id], bSt[id]].filter(Boolean).sort((x, y) => y.t - x.t);
    if (cands[0]) stamps[id] = cands[0];
    const on = cands[0] ? cands[0].on : aList.includes(id) || bList.includes(id);
    if (on) out.push(id);
  });
  return { list: out, stamps };
}

export function mergeStates(a, b) {
  const sa = a.stamps || emptyStamps();
  const sb = b.stamps || emptyStamps();
  const saved = mergeMembership(a.saved || [], b.saved || [], sa.saved, sb.saved);
  const interests = mergeMembership(a.interests || [], b.interests || [], sa.interests, sb.interests);

  const byId = new Map();
  [...(a.completed || []), ...(b.completed || [])].forEach((c) => {
    const prev = byId.get(c.id);
    if (!prev) return byId.set(c.id, { ...c });
    const [newer, older] = (c.date || 0) >= (prev.date || 0) ? [c, prev] : [prev, c];
    const merged = { ...older, ...newer };
    ['reflection', 'again', 'surprise', 'learned'].forEach((k) => { if (!merged[k] && older[k]) merged[k] = older[k]; });
    merged.public = !!(prev.public || c.public);
    byId.set(c.id, merged);
  });
  const completed = [...byId.values()].sort((x, y) => (x.date || 0) - (y.date || 0));

  let active = null;
  const cands = [a.active, b.active].filter(Boolean).sort((x, y) => y.startedAt - x.startedAt);
  if (cands[0]) {
    const done = byId.get(cands[0].id);
    if (!done || (done.date || 0) < cands[0].startedAt) active = cands[0];
  }

  return {
    v: 2,
    interests: interests.list,
    saved: saved.list,
    stamps: { saved: saved.stamps, interests: interests.stamps },
    completed,
    onboarded: !!(a.onboarded || b.onboarded),
    revealed: [...new Set([...(a.revealed || []), ...(b.revealed || [])])],
    dailyDone: { ...(b.dailyDone || {}), ...(a.dailyDone || {}) },
    active
  };
}

/* The synced slice of app state. Device-specific things (notification
   permission, skip history, UI state) are intentionally not synced. */
export const syncable = (s) => ({
  v: 2,
  interests: s.interests, saved: s.saved, completed: s.completed,
  onboarded: s.onboarded, revealed: s.revealed, stamps: s.stamps,
  dailyDone: s.dailyDone, active: s.active
});

/* ---------- sync engine ---------- */
const hooks = {};
let timer = null;
let busy = false;
export const syncInfo = { state: 'idle', last: 0 };

export function initSync(h) { Object.assign(hooks, h); }
const setStatus = (state, extra = {}) => {
  syncInfo.state = state;
  if (state === 'ok') syncInfo.last = Date.now();
  hooks.status?.({ state, ...extra });
};

export function scheduleSync(delay = 1500) {
  if (!signedIn() || !health) return;
  clearTimeout(timer);
  timer = setTimeout(() => syncNow(), delay);
}

/** mode: 'merge' (default) | 'cloud' (replace local with cloud, used when starting fresh) */
export async function syncNow({ mode = 'merge' } = {}) {
  if (!signedIn() || busy) return { ok: false, error: busy ? 'busy' : 'signedout' };
  busy = true;
  setStatus('syncing');
  try {
    const local = syncable(hooks.get());
    if (!localStorage.getItem(BACKUP_KEY)) {
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify(local)); } catch {}
    }
    const pulled = await api('/api/state');
    if (!pulled.ok) { setStatus(pulled.status === 0 ? 'offline' : 'error'); return { ok: false, error: pulled.data?.error }; }

    const cloud = pulled.data.state;
    let merged;
    if (!cloud) merged = local;
    else if (mode === 'cloud') merged = mergeStates(cloud, { v: 2, interests: [], saved: [], completed: [] });
    else merged = mergeStates(local, cloud);

    hooks.apply(merged);
    const put = await api('/api/state', { method: 'PUT', body: { state: merged } });
    if (!put.ok) { setStatus(put.status === 0 ? 'offline' : 'error'); return { ok: false }; }
    setStatus('ok');
    return { ok: true };
  } finally {
    busy = false;
  }
}

/* ---------- friends & challenges ---------- */
export const getFriends = () => api('/api/friends');
export const requestFriend = (username) => api('/api/friends/request', { method: 'POST', body: { username } });
export const respondFriend = (username, accept) => api('/api/friends/respond', { method: 'POST', body: { username, accept } });
export const removeFriend = (username) => api(`/api/friends/${encodeURIComponent(username)}`, { method: 'DELETE' });
export const getChallenges = () => api('/api/challenges');
export const sendChallenge = (to, questId, message) => api('/api/challenges', { method: 'POST', body: { to, questId, message } });
export const respondChallenge = (id, accept) => api(`/api/challenges/${id}/respond`, { method: 'POST', body: { accept } });
export const completeChallenge = (id) => api(`/api/challenges/${id}/complete`, { method: 'POST' });

/* ---------- push ---------- */
export const pushSubscribe = (subscription, prefs) => api('/api/push/subscribe', { method: 'POST', body: { subscription, prefs, tzOffset: new Date().getTimezoneOffset() } });
export const pushUpdatePrefs = (prefs) => api('/api/push/prefs', { method: 'POST', body: { prefs, tzOffset: new Date().getTimezoneOffset() } });
export const pushUnsubscribe = (endpoint) => api('/api/push/unsubscribe', { method: 'POST', body: { endpoint } });
