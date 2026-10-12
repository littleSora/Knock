import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import crypto from 'node:crypto';
import { db, createSession, sessionExists } from './db.js';
import { requireUser as needUser } from './auth.js';
import { normalizeSessionId, isSessionId, cleanName, cleanBody } from './util.js';
import { isOnline, emitTo, roomCount } from './realtime.js';
import { isProd } from './env.js';

export const api = Router();
const DAY = 86_400_000;
const limiter = (limit, windowMs = 60_000) => rateLimit({ windowMs, limit, standardHeaders: 'draft-7', legacyHeaders: false });
const sessionLimiter = limiter(30, 3_600_000);
const socialLimiter = limiter(40);

/* ---------- public-by-design config (secrets never appear here) ---------- */
api.get('/config', (_req, res) => res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || null, devMode: !isProd }));

// Short-lived TURN credentials (coturn "use-auth-secret"): the TURN secret itself stays on the server.
api.get('/ice', (_req, res) => {
  const iceServers = [{ urls: process.env.STUN_URL || 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL && process.env.TURN_SECRET) {
    const username = `${Math.floor(Date.now() / 1000) + 3600}:knock`;
    const credential = crypto.createHmac('sha1', process.env.TURN_SECRET).update(username).digest('base64');
    iceServers.push({ urls: process.env.TURN_URL.split(','), username, credential });
  }
  res.json({ iceServers });
});

/* ---------- call sessions (guests allowed) ---------- */
api.post('/sessions', sessionLimiter, (req, res) => res.json({ id: createSession(req.user?.id ?? null) }));

api.get('/sessions/:id', (req, res) => {
  const id = normalizeSessionId(req.params.id);
  if (!isSessionId(id) || !sessionExists(id)) return res.status(404).json({ error: 'session_not_found' });
  res.json({ id, participants: roomCount(id) });
});

/* ---------- everything below needs a login ---------- */
api.patch('/me', needUser, (req, res) => {
  const name = cleanName(req.body?.display_name, 40);
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true, display_name: name });
});

/* ---------- dashboard ---------- */
api.get('/dashboard', needUser, (req, res) => {
  const t0 = Number(req.query.dayStart); // the browser sends its local midnight so "yesterday" matches the user's timezone
  if (!Number.isFinite(t0) || Math.abs(t0 - Date.now()) > 2 * DAY) return res.status(400).json({ error: 'bad_range' });
  const count = db.prepare('SELECT COUNT(*) AS n FROM call_log WHERE user_id = ? AND started_at >= ? AND started_at < ?');
  const week = Array.from({ length: 7 }, (_, i) => {
    const from = t0 - (7 - i) * DAY;
    return count.get(req.user.id, from, from + DAY).n;
  });
  // The user's whole schedule, soonest first. The browser splits it into upcoming and earlier.
  const schedule = db
    .prepare('SELECT id, title, scheduled_at, session_id FROM appointments WHERE owner_id = ? ORDER BY scheduled_at LIMIT 500')
    .all(req.user.id);
  res.json({ yesterday: week[6], week, schedule });
});

/* ---------- smart recaps: what was decided and who owns each follow-up, per call ---------- */
// A recap shows up for everyone who was in the call (call_log), not just whoever typed it in.
api.get('/recaps', needUser, (req, res) => {
  const me = req.user.id;
  const sessions = db
    .prepare(
      `SELECT cl.session_id, MIN(cl.started_at) AS at,
         (SELECT title FROM appointments a WHERE a.session_id = cl.session_id LIMIT 1) AS title
       FROM call_log cl
       WHERE cl.user_id = ? AND EXISTS (SELECT 1 FROM recap_items r WHERE r.session_id = cl.session_id)
       GROUP BY cl.session_id ORDER BY at DESC LIMIT 20`,
    )
    .all(me);
  const items = db.prepare('SELECT id, kind, body, owner_name, owner_user_id, done FROM recap_items WHERE session_id = ? ORDER BY id');
  const recaps = sessions.map((s) => {
    const all = items.all(s.session_id).map((i) => ({ id: i.id, kind: i.kind, body: i.body, owner_name: i.owner_name, mine: i.owner_user_id === me, done: !!i.done }));
    return { session_id: s.session_id, title: s.title, at: s.at, decisions: all.filter((i) => i.kind === 'decision'), actions: all.filter((i) => i.kind === 'action') };
  });
  res.json({ recaps });
});

api.patch('/recaps/items/:id', needUser, (req, res) => {
  const done = req.body?.done ? 1 : 0;
  const info = db
    .prepare("UPDATE recap_items SET done = ? WHERE id = ? AND kind = 'action' AND session_id IN (SELECT session_id FROM call_log WHERE user_id = ?)")
    .run(done, Number(req.params.id), req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, done: !!done });
});

api.post('/appointments', needUser, (req, res) => {
  const title = cleanName(req.body?.title, 80);
  const at = Number(req.body?.scheduledAt);
  if (!title || !Number.isFinite(at) || at < Date.now() - 3_600_000 || at > Date.now() + 366 * DAY) {
    return res.status(400).json({ error: 'invalid_appointment' });
  }
  const sessionId = createSession(req.user.id);
  const info = db.prepare('INSERT INTO appointments(owner_id, title, scheduled_at, session_id) VALUES (?,?,?,?)').run(req.user.id, title, at, sessionId);
  res.json({ id: Number(info.lastInsertRowid), session_id: sessionId });
});
api.delete('/appointments/:id', needUser, (req, res) => {
  db.prepare('DELETE FROM appointments WHERE id = ? AND owner_id = ?').run(Number(req.params.id), req.user.id);
  res.json({ ok: true });
});

/* ---------- people ---------- */
api.get('/users/search', needUser, socialLimiter, (req, res) => {
  const q = String(req.query.q ?? '').trim().toLowerCase().replace(/[%_\\]/g, '');
  if (q.length < 2) return res.json({ users: [] });
  const users = db
    .prepare('SELECT id, handle, display_name FROM users WHERE id <> ? AND (handle LIKE ? OR lower(display_name) LIKE ?) ORDER BY handle LIMIT 10')
    .all(req.user.id, `${q}%`, `%${q}%`);
  res.json({ users });
});

api.get('/users/:handle', needUser, (req, res) => {
  const user = db
    .prepare('SELECT id, handle, display_name, COALESCE(signup_name, display_name) AS signup_name, created_at FROM users WHERE handle = ?')
    .get(String(req.params.handle).toLowerCase());
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const isFriend = !!db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(req.user.id, user.id);
  res.json({ user, isSelf: user.id === req.user.id, isFriend });
});

/* ---------- friends ---------- */
api.get('/friends', needUser, (req, res) => {
  const rows = db
    .prepare('SELECT u.id, u.handle, u.display_name FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?')
    .all(req.user.id)
    .map((f) => ({ ...f, online: isOnline(f.id) }));
  rows.sort((a, b) => b.online - a.online || a.display_name.localeCompare(b.display_name)); // online first
  res.json({ friends: rows });
});

api.post('/friends/:id', needUser, socialLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) {
    return res.status(400).json({ error: 'invalid_user' });
  }
  const added = db.prepare('INSERT OR IGNORE INTO friends VALUES (?, ?, ?)').run(req.user.id, id, Date.now()).changes;
  // Notify the other person (at most once per day per sender, so add/unfriend loops can't spam them).
  const recent = db
    .prepare("SELECT 1 FROM notifications WHERE user_id = ? AND from_id = ? AND type = 'friend_add' AND created_at > ?")
    .get(id, req.user.id, Date.now() - DAY);
  if (added && !recent) {
    db.prepare("INSERT INTO notifications(user_id, type, from_id, created_at) VALUES (?, 'friend_add', ?, ?)").run(id, req.user.id, Date.now());
    emitTo(id, 'notif:new', { type: 'friend_add' });
  }
  res.json({ ok: true });
});

api.delete('/friends/:id', needUser, (req, res) => {
  db.prepare('DELETE FROM friends WHERE user_id = ? AND friend_id = ?').run(req.user.id, Number(req.params.id));
  res.json({ ok: true });
});

/* ---------- messages + notifications ---------- */
// Whether a message is "spam" is decided by the RECIPIENT's friend list, at read time.
api.post('/messages', needUser, socialLimiter, (req, res) => {
  const to = Number(req.body?.toId);
  const body = cleanBody(req.body?.body, 2000);
  if (!body || !Number.isInteger(to) || to === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(to)) {
    return res.status(400).json({ error: 'invalid_message' });
  }
  const now = Date.now();
  const info = db.prepare('INSERT INTO messages(from_id, to_id, body, created_at) VALUES (?,?,?,?)').run(req.user.id, to, body, now);
  const message = { id: Number(info.lastInsertRowid), from_id: req.user.id, to_id: to, body, created_at: now };
  const spam = !db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(to, req.user.id);
  emitTo(to, 'dm:new', { ...message, from: req.user, spam });
  emitTo(req.user.id, 'dm:echo', message); // keeps the sender's other tabs in sync
  res.json({ message });
});

api.get('/messages/with/:id', needUser, (req, res) => {
  const me = req.user.id;
  const other = Number(req.params.id);
  const messages = db
    .prepare('SELECT id, from_id, to_id, body, created_at FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT 50')
    .all(me, other, other, me)
    .reverse();
  db.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL').run(Date.now(), me, other);
  res.json({ messages });
});

api.get('/notifications', needUser, (req, res) => {
  const me = req.user.id;
  const threads = db
    .prepare(
      `SELECT m.from_id AS id, u.handle, u.display_name, m.body, m.created_at,
         (SELECT COUNT(*) FROM messages x WHERE x.to_id = ? AND x.from_id = m.from_id AND x.read_at IS NULL) AS unread,
         EXISTS (SELECT 1 FROM friends f WHERE f.user_id = ? AND f.friend_id = m.from_id) AS is_friend
       FROM messages m JOIN users u ON u.id = m.from_id
       WHERE m.id IN (SELECT MAX(id) FROM messages WHERE to_id = ? GROUP BY from_id)
       ORDER BY m.id DESC LIMIT 50`,
    )
    .all(me, me, me);
  const inbox = threads.filter((t) => t.is_friend);
  const spam = threads.filter((t) => !t.is_friend);
  const friendAdds = db
    .prepare(
      `SELECT n.id, n.created_at, n.read_at, u.id AS from_id, u.handle, u.display_name
       FROM notifications n JOIN users u ON u.id = n.from_id
       WHERE n.user_id = ? AND n.type = 'friend_add' ORDER BY n.id DESC LIMIT 20`,
    )
    .all(me);
  const sum = (list) => list.reduce((s, t) => s + t.unread, 0);
  // The bell badge counts friends' messages and new-friend alerts. Spam is shown in its own tab and never alerts.
  res.json({ inbox, spam, friendAdds, badge: sum(inbox) + friendAdds.filter((n) => !n.read_at).length, spamUnread: sum(spam) });
});

api.post('/notifications/read', needUser, (req, res) => {
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(Date.now(), req.user.id);
  res.json({ ok: true });
});
