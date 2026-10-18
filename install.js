/* Install-to-home-screen support. Only promises what the browser can actually do:
   - Chromium browsers fire `beforeinstallprompt`, which gives us a real one-tap install.
   - iOS Safari has no such event, so we show the manual Share → Add to Home Screen steps.
   - Anything else gets nothing, rather than a promise we can't keep. */

export const detectInstall = ({ ua = '', standalone = false, iosStandalone = false, hasPrompt = false } = {}) => {
  const ios = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && /mobile/i.test(ua));
  const safari = /safari/i.test(ua) && !/crios|fxios|edgios|chrome|android/i.test(ua);
  const installed = !!(standalone || iosStandalone);
  if (installed) return { mode: 'installed' };
  if (hasPrompt) return { mode: 'prompt' };
  if (ios && safari) return { mode: 'ios-safari' };
  if (ios) return { mode: 'ios-other' };       // Chrome/Firefox on iOS: must open in Safari
  return { mode: 'unsupported' };
};

let deferred = null;
const listeners = new Set();
export const onInstallChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach((fn) => fn());

export function initInstall() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; notify(); });
  window.addEventListener('appinstalled', () => { deferred = null; notify(); });
  matchMedia('(display-mode: standalone)').addEventListener?.('change', notify);
}

export const installInfo = () => detectInstall({
  ua: navigator.userAgent,
  standalone: matchMedia('(display-mode: standalone)').matches,
  iosStandalone: navigator.standalone === true,
  hasPrompt: !!deferred
});

export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const e = deferred;
  deferred = null;
  e.prompt();
  const { outcome } = await e.userChoice.catch(() => ({ outcome: 'dismissed' }));
  notify();
  return outcome;                              // 'accepted' | 'dismissed'
}
