import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import crypto from 'node:crypto';
import { db, createSession, sessionExists, sessionInfo } from './db.js';
import { requireUser as needUser } from './auth.js';
import { normalizeSessionId, isSessionId, cleanName, cleanBody } from './util.js';
import { isOnline, emitTo, roomCount } from './realtime.js';
import { isProd } from './env.js';
import { parseTheme } from '../public/js/theme-core.js';

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
// Whoever creates a session is its host. Signed-in creators are recorded as the owner; everyone (guests included)
// also gets a signed, httpOnly cookie for that one session, so a guest host stays the host if they log in mid-call.
api.post('/sessions', sessionLimiter, (req, res) => {
  const id = createSession(req.user?.id ?? null);
  res.cookie('h_' + id, '1', { signed: true, httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 48 * 3600 * 1000, path: '/' });
  res.json({ id });
});

api.get('/sessions/:id', (req, res) => {
  const id = normalizeSessionId(req.params.id);
  const info = isSessionId(id) ? sessionInfo(id) : null;
  if (!info) return res.status(404).json({ error: 'session_not_found' });
  res.json({ id, participants: roomCount(id), ended: !!info.ended_at });
});

/* ---------- profile pictures (public once the human check passes, like a display name) ---------- */
api.get('/avatars/:handle', (req, res) => {
  const row = db
    .prepare('SELECT a.mime, a.data FROM avatars a JOIN users u ON u.id = a.user_id WHERE u.handle = ?')
    .get(String(req.params.handle).toLowerCase());
  if (!row) return res.status(404).end();
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(row.data));
});

/* ---------- everything below needs a login ---------- */
// Full account details are only ever returned to the account's owner (never put these on req.user, which is shared with other people).
api.get('/me', needUser, (req, res) => {
  const u = db
    .prepare(
      `SELECT id, handle, display_name, COALESCE(signup_name, display_name) AS signup_name, email, phone,
         google_sub IS NOT NULL AS has_google, created_at, theme,
         (SELECT updated_at FROM avatars WHERE user_id = users.id) AS avatar_at
       FROM users WHERE id = ?`,
    )
    .get(req.user.id);
  let theme = null;
  try { theme = u.theme ? JSON.parse(u.theme) : null; } catch { /* ignore a bad stored value */ }
  delete u.theme;
  res.json({ user: { ...u, has_google: !!u.has_google }, theme });
});

// The look of the app is saved on the account so it follows the person to every device.
api.put('/me/theme', needUser, limiter(60), (req, res) => {
  const theme = parseTheme(req.body?.theme);
  if (!theme) return res.status(400).json({ error: 'invalid_theme' });
  db.prepare('UPDATE users SET theme = ? WHERE id = ?').run(JSON.stringify(theme), req.user.id);
  res.json({ ok: true, theme });
});
api.delete('/me/theme', needUser, (req, res) => {
  db.prepare('UPDATE users SET theme = NULL WHERE id = ?').run(req.user.id);
  res.json({ ok: true });
});

api.patch('/me/username', needUser, limiter(5, 3_600_000), (req, res) => {
  const handle = String(req.body?.handle ?? '').trim().toLowerCase();
  if (!/^[a-z0-9]{3,20}$/.test(handle)) return res.status(400).json({ error: 'invalid_username' });
  if (handle === req.user.handle) return res.json({ ok: true, handle });
  try {
    db.prepare('UPDATE users SET handle = ? WHERE id = ?').run(handle, req.user.id);
  } catch {
    return res.status(409).json({ error: 'username_taken' }); // handle is UNIQUE
  }
  res.json({ ok: true, handle });
});

// The browser crops the picture to a 256px square first (after checking the 3 MB limit on the original file),
// so what arrives here is small. We accept only real PNG/JPEG/WebP bytes (never SVG) and cap the size.
const MAX_AVATAR = 512 * 1024;
const rawImage = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_AVATAR });
function sniffImage(b) {
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
api.put('/me/avatar', needUser, limiter(10), (req, res, next) => rawImage(req, res, (err) => (err ? res.status(413).json({ error: 'image_too_large' }) : next())), (req, res) => {
  const mime = Buffer.isBuffer(req.body) ? sniffImage(req.body) : null;
  if (!mime) return res.status(400).json({ error: 'invalid_image' });
  const now = Date.now();
  db.prepare(
    `INSERT INTO avatars(user_id, mime, data, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(req.user.id, mime, req.body, now);
  res.json({ ok: true, avatar_at: now });
});
api.delete('/me/avatar', needUser, (req, res) => {
  db.prepare('DELETE FROM avatars WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true, avatar_at: null });
});

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
    .prepare('SELECT id, handle, display_name, COALESCE(signup_name, display_name) AS signup_name, created_at, (SELECT updated_at FROM avatars WHERE user_id = users.id) AS avatar_at FROM users WHERE handle = ?')
    .get(String(req.params.handle).toLowerCase());
  if (!user) return res.status(404).json({ error: 'user_not_found' });
  const isFriend = !!db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(req.user.id, user.id);
  res.json({ user, isSelf: user.id === req.user.id, isFriend });
});

/* ---------- friends ---------- */
api.get('/friends', needUser, (req, res) => {
  const rows = db
    .prepare('SELECT u.id, u.handle, u.display_name, (SELECT updated_at FROM avatars WHERE user_id = u.id) AS avatar_at FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?')
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

/* ---------- group chats ---------- */
const MAX_GROUP = 20;
const isMember = (groupId, userId) => !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
const memberIds = (groupId) => db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId).map((r) => r.user_id);
const groupFor = (req, res) => {
  const id = Number(req.params.id);
  const g = Number.isInteger(id) ? db.prepare('SELECT id, name, created_by, created_at FROM group_chats WHERE id = ?').get(id) : null;
  if (!g || !isMember(g.id, req.user.id)) { res.status(404).json({ error: 'group_not_found' }); return null; }
  return g;
};

api.get('/groups', needUser, (req, res) => {
  const groups = db
    .prepare(
      `SELECT g.id, g.name, g.created_at,
         (SELECT COUNT(*) FROM group_members x WHERE x.group_id = g.id) AS member_count
       FROM group_chats g JOIN group_members m ON m.group_id = g.id
       WHERE m.user_id = ? ORDER BY g.created_at DESC`,
    )
    .all(req.user.id);
  res.json({ groups });
});

// Create a group. The creator can only add people who are on their own friend list.
api.post('/groups', needUser, socialLimiter, (req, res) => {
  const name = cleanName(req.body?.name, 40);
  const ids = [...new Set((Array.isArray(req.body?.memberIds) ? req.body.memberIds : []).map(Number))].filter((n) => Number.isInteger(n) && n !== req.user.id);
  if (!name || !ids.length || ids.length + 1 > MAX_GROUP) return res.status(400).json({ error: 'invalid_group' });
  const isFriend = db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?');
  if (!ids.every((id) => isFriend.get(req.user.id, id))) return res.status(400).json({ error: 'not_a_friend' });
  const now = Date.now();
  let groupId;
  db.exec('BEGIN');
  try {
    groupId = Number(db.prepare('INSERT INTO group_chats(name, created_by, created_at) VALUES (?,?,?)').run(name, req.user.id, now).lastInsertRowid);
    const add = db.prepare('INSERT INTO group_members(group_id, user_id, joined_at) VALUES (?,?,?)');
    for (const id of [req.user.id, ...ids]) add.run(groupId, id, now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const group = { id: groupId, name, created_at: now, member_count: ids.length + 1 };
  for (const id of ids) emitTo(id, 'group:new', { group, by: req.user.display_name });
  res.json({ group });
});

// Name, creation date and member list, for the group's info card.
api.get('/groups/:id', needUser, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const members = db
    .prepare(
      `SELECT u.id, u.handle, u.display_name, (SELECT updated_at FROM avatars WHERE user_id = u.id) AS avatar_at, m.joined_at
       FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY m.joined_at, u.id`,
    )
    .all(g.id)
    .map((u) => ({ ...u, is_creator: u.id === g.created_by }));
  res.json({ group: g, members });
});

// Any member can rename the group.
api.patch('/groups/:id', needUser, socialLimiter, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const name = cleanName(req.body?.name, 40);
  if (!name) return res.status(400).json({ error: 'invalid_group' });
  db.prepare('UPDATE group_chats SET name = ? WHERE id = ?').run(name, g.id);
  for (const id of memberIds(g.id)) emitTo(id, 'group:renamed', { group_id: g.id, name });
  res.json({ ok: true, name });
});

api.get('/groups/:id/messages', needUser, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const messages = db
    .prepare(
      `SELECT m.id, m.from_id, u.display_name AS from_name, m.body, m.created_at
       FROM group_messages m JOIN users u ON u.id = m.from_id WHERE m.group_id = ? ORDER BY m.id DESC LIMIT 50`,
    )
    .all(g.id)
    .reverse();
  res.json({ messages });
});

api.post('/groups/:id/messages', needUser, socialLimiter, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const body = cleanBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'invalid_message' });
  const now = Date.now();
  const info = db.prepare('INSERT INTO group_messages(group_id, from_id, body, created_at) VALUES (?,?,?,?)').run(g.id, req.user.id, body, now);
  const message = { id: Number(info.lastInsertRowid), from_id: req.user.id, from_name: req.user.display_name, body, created_at: now };
  for (const id of memberIds(g.id)) emitTo(id, 'group:msg', { group_id: g.id, group_name: g.name, message }); // includes the sender's other tabs
  res.json({ message });
});
