// Browser notifications for new chat messages, shown only while you are NOT looking at a Knock tab.
// The choice is per browser (the browser's permission is too), so it lives in localStorage rather than on the account.
// This covers a tab that is open in the background or on another window; it does not wake a browser that is closed.
const KEY = 'knock.notify'; // 'on' | 'off'
const PREVIEW_KEY = 'knock.notify.preview'; // '0' = don't put the message text in the notification
const ACTIVE_KEY = 'knock.activeTab'; // "<tab id>:<time>", written by whichever Knock tab is in front

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: skip */ } };

export const supported = () => typeof Notification !== 'undefined';
export const permission = () => (supported() ? Notification.permission : 'unsupported');
export const enabled = () => supported() && Notification.permission === 'granted' && read(KEY) === 'on';
export const previewOn = () => read(PREVIEW_KEY) !== '0';
export const setPreview = (on) => write(PREVIEW_KEY, on ? '1' : '0');

async function registerWorker() {
  try { await navigator.serviceWorker?.register('/sw.js'); } catch { /* needs https or localhost; plain notifications still work */ }
}

// Must be called from a click. Resolves 'granted', 'denied', 'default' (dismissed) or 'unsupported'.
export async function enable() {
  if (!supported()) return 'unsupported';
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p !== 'granted') return p;
  write(KEY, 'on');
  registerWorker();
  return 'granted';
}
export const disable = () => write(KEY, 'off');

/* ----- "is anyone looking?" -----
   Several Knock tabs can be open. The one in front writes a heartbeat; a background tab stays quiet while another tab
   is in front, so you don't get a notification for something you can already see. */
const TAB = Math.random().toString(36).slice(2);
const here = () => document.visibilityState === 'visible' && document.hasFocus();
const activeTab = () => { const [id, t] = (read(ACTIVE_KEY) || '').split(':'); return { id, t: Number(t) || 0 }; };
function beat() {
  if (here()) write(ACTIVE_KEY, `${TAB}:${Date.now()}`);
  else if (activeTab().id === TAB) write(ACTIVE_KEY, ''); // leaving: the next message should notify straight away
}
const otherTabInFront = () => { const a = activeTab(); return !!a.id && a.id !== TAB && Date.now() - a.t < 5000; };
setInterval(beat, 2000);
for (const ev of ['focus', 'blur', 'visibilitychange']) (ev === 'visibilitychange' ? document : window).addEventListener(ev, beat);
beat();
if (enabled()) registerWorker();

/* ----- showing one ----- */
let opener = null;
// `fn(open)` is called when someone taps a notification, with the `open` info passed to show().
export function onOpen(fn) {
  opener = fn;
  navigator.serviceWorker?.addEventListener('message', (e) => { if (e.data?.type === 'knock:open' && e.data.open) opener?.(e.data.open); });
}

// `tag` groups a chat's notifications into one (a new message replaces the old one). `force` skips the "not looking" check (used for the test button).
export function show({ title, body, tag, open = null, force = false }) {
  if (!enabled()) return;
  if (!force && (here() || otherTabInFront())) return;
  const options = { body: force || previewOn() ? body : 'New message', tag, renotify: true };
  try {
    const n = new Notification(title, options);
    n.onclick = () => { window.focus(); n.close(); if (open) opener?.(open); };
  } catch { // Chrome on Android only allows notifications made through a service worker
    navigator.serviceWorker?.ready.then((reg) => reg.showNotification(title, { ...options, data: { open } })).catch(() => {});
  }
}
export const test = () => show({ title: 'Knock', body: 'Notifications are working.', tag: 'knock-test', force: true });
