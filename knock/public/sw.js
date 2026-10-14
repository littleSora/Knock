// Knock service worker. It only shows notifications and handles taps on them (some browsers, like Chrome on Android,
// can't create a notification from the page itself). It caches nothing and never touches your requests.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
      await self.clients.openWindow('/dashboard');
    }
  })());
});
