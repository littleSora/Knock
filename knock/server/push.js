// Browser push: a notification that reaches a person even when no Knock tab is open (or the browser is closed).
// The server signs each push with a VAPID key pair. If VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY aren't set in .env, a pair is made
// on first start and kept in the database, so push works with no setup. (Keep the same pair: a new one drops every subscription.)
import webpush from 'web-push';
import { db, isDnd } from './db.js';

const kv = {
  get: (k) => db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value ?? null,
  set: (k, v) => db.prepare('INSERT INTO kv(key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v),
};

let keys = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
if (!keys.publicKey || !keys.privateKey) {
  keys = { publicKey: kv.get('vapid_public'), privateKey: kv.get('vapid_private') };
  if (!keys.publicKey || !keys.privateKey) {
    keys = webpush.generateVAPIDKeys();
    kv.set('vapid_public', keys.publicKey);
    kv.set('vapid_private', keys.privateKey);
  }
}
// The contact must be a mailto: or https: address; push services may use it to reach the site owner if something is wrong.
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', keys.publicKey, keys.privateKey);
export const vapidPublicKey = keys.publicKey;

const MAX_PER_USER = 10; // browsers per account
const GONE = new Set([404, 410]); // the browser unsubscribed (or was uninstalled): forget it

export function saveSubscription(userId, sessionHash, sub, preview) {
  db.prepare(
    `INSERT INTO push_subscriptions(endpoint, user_id, p256dh, auth, preview, session_hash, created_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
       preview = excluded.preview, session_hash = excluded.session_hash`,
  ).run(sub.endpoint, userId, sub.keys.p256dh, sub.keys.auth, preview ? 1 : 0, sessionHash, Date.now());
  // Keep only the newest few, so an account can't pile up subscriptions.
  db.prepare(
    `DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint NOT IN (
       SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
  ).run(userId, userId, MAX_PER_USER);
}
export const removeSubscription = (userId, endpoint) => db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').run(userId, endpoint).changes;
export const hasSubscription = (userId, endpoint) => !!db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ? AND endpoint = ?').get(userId, endpoint);

// Fire and forget. Nobody gets a push while their status is "Do not disturb". The service worker also stays quiet
// when a Knock tab is in front, so you aren't told about something you're already looking at.
// payload: { title, body, tag, open }.
export function pushTo(userId, payload, { force = false } = {}) {
  if (!force && isDnd(userId)) return;
  const subs = db.prepare('SELECT endpoint, p256dh, auth, preview FROM push_subscriptions WHERE user_id = ?').all(userId);
  for (const s of subs) {
    const body = JSON.stringify({ ...payload, body: s.preview || payload.force ? payload.body : 'New message' });
    webpush
      .sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, { TTL: 3600, urgency: 'high' })
      .catch((err) => { if (GONE.has(err?.statusCode)) db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(s.endpoint); });
  }
}
