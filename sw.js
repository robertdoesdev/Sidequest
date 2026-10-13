/* SideQuest service worker: notifications + a SAFE offline fallback.

   Offline strategy is network-first: while you are online every request goes to the
   network, so you can never be served stale app code. Only when the network fails do we
   fall back to the last copy we saw. /api/* is never touched: account, sync and social
   calls always hit the network and fail honestly when offline. */
const CACHE = 'sq-shell-v3';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) =>
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('sq-shell-')).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(async () => {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        if (req.mode === 'navigate') {
          const shell = (await caches.match('./index.html')) || (await caches.match('./'));
          if (shell) return shell;
        }
        return new Response('You’re offline and this isn’t saved yet.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      })
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'SideQuest', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'SideQuest';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || 'sidequest',
      icon: 'favicon/android-chrome-192x192.png',
      badge: 'favicon/favicon-32x32.png',
      data: { url: data.url || '#/' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '#/', self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
          c.navigate(target).catch(() => {});
          return c.focus();
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
