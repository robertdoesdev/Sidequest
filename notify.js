/* =====================================================================
   SideQuest V2 — notifications
   - Permission is only ever requested from an explicit user click.
   - With an account + backend: real background Web Push (VAPID).
   - Without: local notifications that fire while SideQuest is open
     (UI says so honestly).
   ===================================================================== */
import * as cloud from './cloud.js';

export const DEFAULT_NOTIF = {
  enabled: false,
  daily: true,
  challenges: true,
  reminders: true,
  followups: true,
  time: '10:00'
};

export const supported = () =>
  typeof Notification !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;

export const permission = () => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission);

let reg = null;
export async function registerSW() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    reg = await navigator.serviceWorker.register('./sw.js');
    await navigator.serviceWorker.ready;
    return reg;
  } catch {
    return null;
  }
}
const getReg = async () => reg || (await registerSW());

const b64ToU8 = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Does this setup deliver in the background? */
export const deliveryMode = () =>
  cloud.signedIn() && cloud.backend()?.push?.publicKey ? 'push' : 'local';

/** Call ONLY from a click handler. Returns { ok, reason?, mode? } */
export async function enable(prefs) {
  if (!supported()) return { ok: false, reason: 'unsupported' };
  const result = await Notification.requestPermission();
  if (result !== 'granted') return { ok: false, reason: result };
  const r = await getReg();
  if (!r) return { ok: false, reason: 'no-sw' };

  if (deliveryMode() === 'push') {
    try {
      let sub = await r.pushManager.getSubscription();
      if (!sub) {
        sub = await r.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToU8(cloud.backend().push.publicKey)
        });
      }
      const res = await cloud.pushSubscribe(sub.toJSON(), prefs);
      if (res.ok) return { ok: true, mode: 'push' };
    } catch {
      /* fall through to local mode */
    }
    return { ok: true, mode: 'local', note: 'push-failed' };
  }
  return { ok: true, mode: 'local' };
}

export async function disable() {
  clearLocal();
  const r = await getReg();
  try {
    const sub = await r?.pushManager?.getSubscription();
    if (sub) {
      if (cloud.signedIn()) await cloud.pushUnsubscribe(sub.endpoint);
      await sub.unsubscribe();
    }
  } catch {}
}

export async function syncPrefs(prefs) {
  if (deliveryMode() === 'push' && prefs.enabled) await cloud.pushUpdatePrefs(prefs);
}

export async function show(title, body, url = '#/', tag = 'sidequest') {
  if (permission() !== 'granted') return false;
  const r = await getReg();
  if (!r) return false;
  await r.showNotification(title, {
    body, tag, icon: 'favicon/android-chrome-192x192.png', badge: 'favicon/favicon-32x32.png', data: { url }
  });
  return true;
}

export const sendTest = () => show('SideQuest', 'Notifications are working. Your next quest is waiting.', '#/daily', 'sq-test');

/* ---------- local scheduling (tab must be open) ---------- */
let timers = [];
export function clearLocal() { timers.forEach(clearTimeout); timers = []; }

const msUntil = (hhmm) => {
  const [h, m] = (hhmm || '10:00').split(':').map(Number);
  const t = new Date();
  t.setHours(h, m, 0, 0);
  return t.getTime() - Date.now();
};

/** Re-arm local timers. Never fires in quiet hours (21:00–08:00). */
export function scheduleLocal({ prefs, dailyDoneToday, active, todayKey, getQuestTitle }) {
  clearLocal();
  if (!prefs.enabled || permission() !== 'granted' || deliveryMode() === 'push') return;
  const quiet = () => { const h = new Date().getHours(); return h >= 21 || h < 8; };
  const key = (k) => `sq-notified-${k}`;
  const once = (k) => { if (localStorage.getItem(key(k))) return false; localStorage.setItem(key(k), '1'); return true; };

  if (prefs.daily && !dailyDoneToday) {
    const ms = msUntil(prefs.time);
    if (ms > 0 && ms < 2147483000) {
      timers.push(setTimeout(() => {
        if (!quiet() && once('daily-' + todayKey)) show('Your SideQuest for today', 'It’s waiting for you.', '#/daily', 'sq-daily');
      }, ms));
    }
  }
  if (prefs.reminders && active) {
    const due = active.startedAt + 3 * 3600000 - Date.now();
    if (due > 0 && due < 2147483000) {
      timers.push(setTimeout(() => {
        if (!quiet() && once(`rem-${active.id}-${active.startedAt}`)) {
          show('You still have a SideQuest waiting', getQuestTitle(active.id) || 'Finish what you started.', `#/quest/${active.id}/active`, 'sq-reminder');
        }
      }, due));
    }
  }
}
