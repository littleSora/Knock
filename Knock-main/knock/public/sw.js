// Knock service worker. It shows push notifications (even when no Knock tab is open) and handles taps on notifications.
// It caches nothing and never touches your page requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// A push from the server: { title, body, tag, open, force }. Stay quiet while a Knock tab is in front (you can already see it),
// unless it's the test button (force).
self.addEventListener('push', (event) => {
  let d = null;
  try { d = event.data?.json(); } catch { /* not JSON */ }
  const title = typeof d?.title === 'string' && d.title ? d.title : 'Knock';
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!d?.force && tabs.some((t) => t.visibilityState === 'visible' && t.focused)) return;
    await self.registration.showNotification(title, {
      body: typeof d?.body === 'string' ? d.body : 'New message',
      tag: typeof d?.tag === 'string' ? d.tag : undefined,
      renotify: typeof d?.tag === 'string',
      data: { open: d?.open ?? null },
    });
  })());
});

// The browser renewed or dropped our subscription: sign up the new one (the login cookie comes along with the request).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const old = event.oldSubscription;
      const sub = event.newSubscription || (old ? await self.registration.pushManager.subscribe(old.options) : null);
      if (!sub) return;
      await fetch('/api/push/subscription', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ subscription: sub.toJSON() }) });
    } catch { /* the page will sync again the next time it opens */ }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const open = event.notification.data?.open ?? null; // which chat the notification was about
  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((t) => 'focus' in t);
    if (tab) {
      await tab.focus();
      tab.postMessage({ type: 'knock:open', open });
    } else {
      // No Knock tab: open one, and the dashboard opens that chat once it has loaded.
      await self.clients.openWindow('/dashboard' + (open ? '?open=' + encodeURIComponent(JSON.stringify(open)) : ''));
    }
  })());
});
