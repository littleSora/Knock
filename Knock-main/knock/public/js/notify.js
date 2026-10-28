// Browser notifications for new chat messages and friend requests, shown only while you are NOT looking at a Knock tab.
// The choice is per browser (the browser's permission is too), so it lives in localStorage rather than on the account.
// Two layers: real push (the server sends it through the browser's push service, so it arrives even when no Knock tab is
// open or the browser is closed), and a plain in-page notification as the fallback where push isn't available.
const KEY = 'knock.notify'; // 'on' | 'off'
const PUSH_KEY = 'knock.push'; // 'on' once this browser is subscribed to push on the server
const PREVIEW_KEY = 'knock.notify.preview'; // '0' = don't put the message text in the notification
const ACTIVE_KEY = 'knock.activeTab'; // "<tab id>:<time>", written by whichever Knock tab is in front

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: skip */ } };

export const supported = () => typeof Notification !== 'undefined';
export const permission = () => (supported() ? Notification.permission : 'unsupported');
export const enabled = () => supported() && Notification.permission === 'granted' && read(KEY) === 'on';
export const previewOn = () => read(PREVIEW_KEY) !== '0';
export const setPreview = (on) => { write(PREVIEW_KEY, on ? '1' : '0'); if (pushOn()) syncPush(); }; // the server needs to know too: it writes the push text

async function registerWorker() {
  try { return (await navigator.serviceWorker?.register('/sw.js')) || null; } catch { return null; /* needs https or localhost; plain notifications still work */ }
}

/* ----- push ----- */
export const pushSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof PushManager !== 'undefined';
export const pushOn = () => enabled() && read(PUSH_KEY) === 'on';
const b64ToBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const sameKey = (buf, bytes) => !!buf && new Uint8Array(buf).length === bytes.length && new Uint8Array(buf).every((v, i) => v === bytes[i]);
async function json(path, method, body) {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (!res.ok) throw new Error(String(res.status));
  return res.json().catch(() => ({}));
}
// Subscribe this browser (or refresh the server's copy, which also ties it to whoever is logged in now). Returns true if push is on.
async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  try {
    const reg = (await navigator.serviceWorker.ready) || (await registerWorker());
    const { key } = await json('/api/push/key', 'GET');
    const bytes = b64ToBytes(key);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options?.applicationServerKey, bytes)) { await sub.unsubscribe(); sub = null; } // the server's key changed
    sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes });
    await json('/api/push/subscription', 'PUT', { subscription: sub.toJSON(), preview: previewOn() });
    write(PUSH_KEY, 'on');
    return true;
  } catch {
    write(PUSH_KEY, 'off'); // not logged in, no https, or the push service said no: the in-page notifications still work
    return false;
  }
}
async function dropPush() {
  write(PUSH_KEY, 'off');
  try {
    const sub = await (await navigator.serviceWorker?.getRegistration())?.pushManager.getSubscription();
    if (!sub) return;
    await json('/api/push/subscription', 'DELETE', { endpoint: sub.endpoint }).catch(() => {});
    await sub.unsubscribe();
  } catch { /* nothing to undo */ }
}
// Asks the server to push a test through the real push service (shown even if this tab is in front).
export async function testPush() {
  const sub = await (await navigator.serviceWorker?.getRegistration())?.pushManager.getSubscription();
  if (!sub) throw new Error('no_subscription');
  await json('/api/push/test', 'POST', { endpoint: sub.endpoint });
}

// Your own status. While it is "Do not disturb" nothing here makes a sound or a pop-up.
let myStatus = null;
export const setStatus = (s) => { myStatus = s; };
const dnd = () => myStatus?.kind === 'dnd' && (myStatus.until == null || myStatus.until > Date.now());

// Must be called from a click. Resolves 'granted', 'denied', 'default' (dismissed) or 'unsupported'.
export async function enable() {
  if (!supported()) return 'unsupported';
  let p = Notification.permission;
  if (p === 'default') p = await Notification.requestPermission();
  if (p !== 'granted') return p;
  write(KEY, 'on');
  await registerWorker();
  await syncPush();
  return 'granted';
}
export const disable = () => { write(KEY, 'off'); dropPush(); };

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
if (enabled()) registerWorker().then(syncPush);

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
  if (!force && (dnd() || read(PUSH_KEY) === 'on')) return; // push already covers this (the service worker shows it), and Do not disturb silences everything
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
