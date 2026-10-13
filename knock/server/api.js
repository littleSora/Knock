import express, { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import crypto from 'node:crypto';
import { db, createSession, sessionExists, sessionInfo, hasBlocked, blockedEither, activityOn, shareActivity } from './db.js';
import { requireUser as needUser } from './auth.js';
import { normalizeSessionId, isSessionId, cleanName, cleanBody } from './util.js';
import { isOnline, emitTo, roomCount } from './realtime.js';
import { isProd } from './env.js';
import { parseTheme } from '../public/js/theme-core.js';
import { validateReport } from '../public/js/report-categories.js';
import { IMAGE_BODY } from '../public/js/reactions.js';
import { isReactionEmoji, sniffImage, saveChatImage, canSeeImage, loadReactions, toggleReaction } from './chat-extras.js';

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
         google_sub IS NOT NULL AS has_google, created_at, theme, chat_activity AS share_activity,
         first_name, last_name, middle_initial, birthday, workplace, country,
         (SELECT updated_at FROM avatars WHERE user_id = users.id) AS avatar_at
       FROM users WHERE id = ?`,
    )
    .get(req.user.id);
  let theme = null;
  try { theme = u.theme ? JSON.parse(u.theme) : null; } catch { /* ignore a bad stored value */ }
  delete u.theme;
  res.json({ user: { ...u, has_google: !!u.has_google, share_activity: !!u.share_activity }, theme });
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
// Pictures sent in chats: the browser shrinks them to at most 1280 px first, so 1.5 MB is generous.
const MAX_CHAT_IMAGE = 1.5 * 1024 * 1024;
const rawChatImage = express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: MAX_CHAT_IMAGE });
const parseChatImage = (req, res, next) => rawChatImage(req, res, (err) => (err ? res.status(413).json({ error: 'image_too_large' }) : next()));
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

// One switch for "seen" receipts and typing indicators. Off means you neither send nor see them.
api.put('/me/activity', needUser, (req, res) => {
  const on = req.body?.on === true;
  db.prepare('UPDATE users SET chat_activity = ? WHERE id = ?').run(on ? 1 : 0, req.user.id);
  res.json({ ok: true, on });
});

api.patch('/me', needUser, (req, res) => {
  const name = cleanName(req.body?.display_name, 40);
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ ok: true, display_name: name });
});

// Profile details (display name + optional personal info). Everything except the display name may be left blank.
const validBirthday = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return y >= 1900 && t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d && t.getTime() <= Date.now() + DAY;
};
api.put('/me/details', needUser, (req, res) => {
  const b = req.body ?? {};
  const display_name = cleanName(b.display_name, 40);
  if (!display_name) return res.status(400).json({ error: 'invalid_name' });
  const first_name = cleanName(b.first_name, 40) || null;
  const last_name = cleanName(b.last_name, 40) || null;
  const workplace = cleanName(b.workplace, 80) || null;
  const country = cleanName(b.country, 60) || null;
  let middle_initial = null;
  const rawInitial = String(b.middle_initial ?? '').trim();
  if (rawInitial) {
    if (!/^\p{L}\.?$/u.test(rawInitial)) return res.status(400).json({ error: 'invalid_initial' });
    middle_initial = rawInitial[0].toUpperCase();
  }
  let birthday = null;
  const rawBirthday = String(b.birthday ?? '').trim();
  if (rawBirthday) {
    if (!validBirthday(rawBirthday)) return res.status(400).json({ error: 'invalid_birthday' });
    birthday = rawBirthday;
  }
  db.prepare('UPDATE users SET display_name = ?, first_name = ?, last_name = ?, middle_initial = ?, birthday = ?, workplace = ?, country = ? WHERE id = ?')
    .run(display_name, first_name, last_name, middle_initial, birthday, workplace, country, req.user.id);
  res.json({ ok: true, display_name, first_name, last_name, middle_initial, birthday, workplace, country });
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
    .prepare(
      `SELECT id, handle, display_name FROM users
       WHERE id <> ? AND (handle LIKE ? OR lower(display_name) LIKE ?)
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.blocker_id = ? AND b.blocked_id = users.id) OR (b.blocker_id = users.id AND b.blocked_id = ?))
       ORDER BY handle LIMIT 10`,
    )
    .all(req.user.id, `${q}%`, `%${q}%`, req.user.id, req.user.id);
  res.json({ users });
});

api.get('/users/:handle', needUser, (req, res) => {
  const user = db
    .prepare('SELECT id, handle, display_name, COALESCE(signup_name, display_name) AS signup_name, created_at, first_name, last_name, middle_initial, birthday, workplace, country, (SELECT updated_at FROM avatars WHERE user_id = users.id) AS avatar_at FROM users WHERE handle = ?')
    .get(String(req.params.handle).toLowerCase());
  if (!user || hasBlocked(user.id, req.user.id)) return res.status(404).json({ error: 'user_not_found' }); // blocked by them: looks the same as "no such person"
  const relation = relationTo(req.user.id, user.id);
  res.json({ user, isSelf: relation === 'self', isFriend: relation === 'friend', relation });
});

/* ---------- friends: mutual, through requests ---------- */
// A friendship is two rows in `friends`, written when a request is accepted. That keeps everything that reads the
// table (spam filter, online status, group invites) working on "both people agreed". Until then nobody sees presence.
const areFriends = (a, b) => !!db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(a, b);
const REREQUEST_AFTER = 7 * DAY; // after a decline, the same person can ask again once this has passed
function relationTo(me, other) {
  if (me === other) return 'self';
  if (hasBlocked(me, other)) return 'blocked'; // you blocked them (if they blocked you, the profile isn't served at all)
  if (areFriends(me, other)) return 'friend';
  if (db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(me, other)) return 'outgoing'; // also shown if they declined, so a decline stays private
  if (db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ? AND declined_at IS NULL').get(other, me)) return 'incoming';
  return 'none';
}
function makeFriends(a, b) {
  const now = Date.now();
  db.exec('BEGIN');
  try {
    const add = db.prepare('INSERT OR IGNORE INTO friends(user_id, friend_id, created_at) VALUES (?,?,?)');
    add.run(a, b, now);
    add.run(b, a, now);
    db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(a, b, b, a);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
// Tell the person who sent a request that it was accepted (bell + live refresh), and refresh both friend lists.
function announceFriendship(accepterId, requesterId) {
  // One notice per pair: an earlier one (from a previous unfriend/re-friend) is replaced, not stacked.
  db.prepare("DELETE FROM notifications WHERE type = 'friend_accepted' AND user_id = ? AND from_id = ?").run(requesterId, accepterId);
  db.prepare("INSERT INTO notifications(user_id, type, from_id, created_at) VALUES (?, 'friend_accepted', ?, ?)").run(requesterId, accepterId, Date.now());
  emitTo(requesterId, 'notif:new', { type: 'friend_accepted' });
  emitTo(requesterId, 'friends:changed', {});
  emitTo(accepterId, 'friends:changed', {});
}
const targetUserId = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id !== req.user.id && db.prepare('SELECT 1 FROM users WHERE id = ?').get(id) ? id : null;
};

api.get('/friends', needUser, (req, res) => {
  const rows = db
    .prepare('SELECT u.id, u.handle, u.display_name, (SELECT updated_at FROM avatars WHERE user_id = u.id) AS avatar_at FROM friends f JOIN users u ON u.id = f.friend_id WHERE f.user_id = ?')
    .all(req.user.id)
    .map((f) => ({ ...f, online: isOnline(f.id) }));
  rows.sort((a, b) => b.online - a.online || a.display_name.localeCompare(b.display_name)); // online first
  res.json({ friends: rows });
});

// Send a friend request. If they already asked you, this simply accepts theirs.
api.post('/friends/:id', needUser, socialLimiter, (req, res) => {
  const me = req.user.id;
  const id = targetUserId(req);
  if (id == null) return res.status(400).json({ error: 'invalid_user' });
  if (hasBlocked(me, id)) return res.status(403).json({ error: 'unblock_first' });
  if (hasBlocked(id, me)) return res.json({ ok: true, state: 'outgoing' }); // silently dropped, like a decline: they aren't pestered and you aren't told
  if (areFriends(me, id)) return res.json({ ok: true, state: 'friend' });
  if (db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(id, me)) {
    makeFriends(me, id);
    announceFriendship(me, id);
    return res.json({ ok: true, state: 'friend' });
  }
  const now = Date.now();
  const existing = db.prepare('SELECT declined_at FROM friend_requests WHERE from_id = ? AND to_id = ?').get(me, id);
  let notify = false;
  if (!existing) {
    db.prepare('INSERT INTO friend_requests(from_id, to_id, created_at) VALUES (?,?,?)').run(me, id, now);
    notify = true;
  } else if (existing.declined_at && now - existing.declined_at > REREQUEST_AFTER) {
    db.prepare('UPDATE friend_requests SET created_at = ?, seen_at = NULL, declined_at = NULL WHERE from_id = ? AND to_id = ?').run(now, me, id);
    notify = true;
  } // else: still pending, or declined recently. Quietly nothing, so the other person isn't pestered.
  if (notify) emitTo(id, 'notif:new', { type: 'friend_request' });
  res.json({ ok: true, state: 'outgoing' });
});

api.post('/friends/requests/:id/accept', needUser, socialLimiter, (req, res) => {
  const me = req.user.id;
  const from = targetUserId(req);
  if (from == null || !db.prepare('SELECT 1 FROM friend_requests WHERE from_id = ? AND to_id = ?').get(from, me)) {
    return res.status(404).json({ error: 'request_not_found' });
  }
  makeFriends(me, from);
  announceFriendship(me, from);
  res.json({ ok: true });
});

// Declining is silent: the sender is not told, and can't ask again for a week.
api.post('/friends/requests/:id/decline', needUser, socialLimiter, (req, res) => {
  const from = targetUserId(req);
  const info = from == null ? { changes: 0 } : db.prepare('UPDATE friend_requests SET declined_at = ?, seen_at = COALESCE(seen_at, ?) WHERE from_id = ? AND to_id = ? AND declined_at IS NULL').run(Date.now(), Date.now(), from, req.user.id);
  if (!info.changes) return res.status(404).json({ error: 'request_not_found' });
  emitTo(req.user.id, 'friends:changed', {}); // refreshes the bell in your other tabs
  res.json({ ok: true });
});

// Take back a request you sent.
api.delete('/friends/requests/:id', needUser, (req, res) => {
  const to = targetUserId(req);
  if (to != null && db.prepare('DELETE FROM friend_requests WHERE from_id = ? AND to_id = ?').run(req.user.id, to).changes) {
    emitTo(to, 'notif:new', { type: 'friend_request_cancelled' });
  }
  res.json({ ok: true });
});

// Unfriending removes both sides, so neither of you sees the other's online status any more.
api.delete('/friends/:id', needUser, (req, res) => {
  const me = req.user.id;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_user' });
  db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(me, id, id, me);
  db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(me, id, id, me);
  db.prepare("DELETE FROM notifications WHERE type = 'friend_accepted' AND ((user_id = ? AND from_id = ?) OR (user_id = ? AND from_id = ?))").run(me, id, id, me);
  emitTo(id, 'friends:changed', {});
  emitTo(me, 'friends:changed', {});
  res.json({ ok: true });
});

/* ---------- blocking ---------- */
// Blocking is quiet: the other person gets no notice. It removes the friendship (both sides) and any pending requests,
// and from then on they can't message you, send you requests, find you in search, open your profile or join a call you are in.
// Their old messages stay in the database (reports may need them) but are hidden from your bell. Unblocking does NOT
// bring a friendship back; you would have to send a new request.
function blockUser(me, id) {
  db.exec('BEGIN');
  try {
    db.prepare('INSERT OR IGNORE INTO blocks(blocker_id, blocked_id, created_at) VALUES (?,?,?)').run(me, id, Date.now());
    db.prepare('DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)').run(me, id, id, me);
    db.prepare('DELETE FROM friend_requests WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)').run(me, id, id, me);
    db.prepare("DELETE FROM notifications WHERE type = 'friend_accepted' AND ((user_id = ? AND from_id = ?) OR (user_id = ? AND from_id = ?))").run(me, id, id, me);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  emitTo(id, 'friends:changed', {}); // looks exactly like being unfriended, which is all they learn
  emitTo(me, 'friends:changed', {});
}

api.get('/blocks', needUser, (req, res) => {
  const blocked = db
    .prepare(
      `SELECT u.id, u.handle, u.display_name, b.created_at, (SELECT updated_at FROM avatars WHERE user_id = u.id) AS avatar_at
       FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC LIMIT 500`,
    )
    .all(req.user.id);
  res.json({ blocked });
});

api.post('/blocks/:id', needUser, socialLimiter, (req, res) => {
  const id = targetUserId(req);
  if (id == null) return res.status(400).json({ error: 'invalid_user' });
  blockUser(req.user.id, id);
  res.json({ ok: true });
});

api.delete('/blocks/:id', needUser, socialLimiter, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_user' });
  db.prepare('DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?').run(req.user.id, id);
  res.json({ ok: true });
});

/* ---------- reporting ---------- */
// The reporter picks a category (and usually a reason) from public/js/report-categories.js, may add details, and may
// block at the same time. The reported person is never told. Where the report came from (a chat, a group, a call) is
// checked against the database, and for chats and groups the latest messages are copied into the report as evidence.
const EVIDENCE_MESSAGES = 20;
function reportContext(me, target, ctx) {
  const none = { type: 'profile', ref: null, evidence: null };
  const type = ctx?.type;
  if (type === 'dm') {
    const rows = db
      .prepare('SELECT from_id, body, created_at FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT ?')
      .all(me, target, target, me, EVIDENCE_MESSAGES)
      .reverse()
      .map((m) => ({ from: m.from_id === me ? 'reporter' : 'reported', body: m.body, at: m.created_at }));
    return { type: 'dm', ref: null, evidence: rows.length ? rows : null };
  }
  if (type === 'group') {
    const gid = Number(ctx.id);
    const mine = Number.isInteger(gid) && db.prepare('SELECT joined_at FROM group_members WHERE group_id = ? AND user_id = ?').get(gid, me);
    if (!mine || !isMember(gid, target)) return none; // not a group they share: treat as a plain profile report
    const rows = db
      .prepare("SELECT from_id, body, created_at FROM group_messages WHERE group_id = ? AND kind = 'msg' AND created_at >= ? ORDER BY id DESC LIMIT ?")
      .all(gid, mine.joined_at, EVIDENCE_MESSAGES)
      .reverse()
      .map((m) => ({ from: m.from_id === me ? 'reporter' : m.from_id === target ? 'reported' : 'other', body: m.body, at: m.created_at }));
    return { type: 'group', ref: String(gid), evidence: rows.length ? rows : null };
  }
  if (type === 'call') {
    const sid = normalizeSessionId(ctx.id);
    const both = isSessionId(sid) && db.prepare('SELECT COUNT(DISTINCT user_id) AS n FROM call_log WHERE session_id = ? AND user_id IN (?, ?)').get(sid, me, target).n === 2;
    return both ? { type: 'call', ref: sid, evidence: null } : none; // only calls you were both really in
  }
  return none;
}

api.post('/reports', needUser, limiter(10, 3_600_000), (req, res) => {
  const me = req.user.id;
  const target = Number(req.body?.userId);
  if (!Number.isInteger(target) || target === me || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(target)) {
    return res.status(400).json({ error: 'invalid_user' });
  }
  const picked = validateReport(req.body?.category, req.body?.reason);
  if (!picked) return res.status(400).json({ error: 'invalid_report' });
  const details = cleanBody(req.body?.details, 500);
  if (picked.category.details === 'required' && details.length < 3) return res.status(400).json({ error: 'details_required' });

  // Sending the same report twice in a day (double tap, second tab) records it once.
  const dup = db
    .prepare("SELECT 1 FROM reports WHERE reporter_id = ? AND reported_id = ? AND category = ? AND COALESCE(reason, '') = ? AND status = 'open' AND created_at > ?")
    .get(me, target, picked.category.id, picked.reason?.id ?? '', Date.now() - DAY);
  if (!dup) {
    const c = reportContext(me, target, req.body?.context);
    db.prepare('INSERT INTO reports(reporter_id, reported_id, category, reason, details, context_type, context_ref, evidence, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(me, target, picked.category.id, picked.reason?.id ?? null, details || null, c.type, c.ref, c.evidence ? JSON.stringify(c.evidence) : null, Date.now());
  }
  const blocked = req.body?.alsoBlock === true;
  if (blocked) blockUser(me, target);
  res.json({ ok: true, blocked });
});

/* ---------- messages + notifications ---------- */
// Whether a message is "spam" is decided by the RECIPIENT's friend list, at read time.
// Can I message this person? (Sends the error reply itself and returns false if not.)
function dmAllowed(req, res, to) {
  if (!Number.isInteger(to) || to === req.user.id || !db.prepare('SELECT 1 FROM users WHERE id = ?').get(to)) { res.status(400).json({ error: 'invalid_message' }); return false; }
  if (hasBlocked(req.user.id, to)) { res.status(403).json({ error: 'unblock_first' }); return false; }
  if (hasBlocked(to, req.user.id)) { res.status(403).json({ error: 'cannot_contact' }); return false; }
  return true;
}
function deliverDm(req, res, to, body, imageId = null) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO messages(from_id, to_id, body, created_at, image_id) VALUES (?,?,?,?,?)').run(req.user.id, to, body, now, imageId);
  const message = { id: Number(info.lastInsertRowid), from_id: req.user.id, to_id: to, body, created_at: now, image_id: imageId, reactions: [] };
  const spam = !db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?').get(to, req.user.id);
  emitTo(to, 'dm:new', { ...message, from: req.user, spam });
  emitTo(req.user.id, 'dm:echo', message); // keeps the sender's other tabs in sync
  res.json({ message });
}
api.post('/messages', needUser, socialLimiter, (req, res) => {
  const to = Number(req.body?.toId);
  const body = cleanBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'invalid_message' });
  if (!dmAllowed(req, res, to)) return;
  deliverDm(req, res, to, body);
});
// A picture (raw image bytes in the body; ?toId=… and an optional ?caption=…).
api.post('/messages/image', needUser, limiter(20), parseChatImage, (req, res) => {
  const to = Number(req.query.toId);
  const mime = sniffImage(req.body);
  if (!mime) return res.status(400).json({ error: 'invalid_image' });
  if (!dmAllowed(req, res, to)) return;
  deliverDm(req, res, to, cleanBody(req.query.caption, 500) || IMAGE_BODY, saveChatImage(req.user.id, mime, req.body));
});

// Tap an emoji to react, tap it again to take it back. Both people in the chat are told live.
api.put('/messages/:id/react', needUser, limiter(60), (req, res) => {
  const me = req.user.id;
  const id = Number(req.params.id);
  const emoji = String(req.body?.emoji ?? '');
  if (!isReactionEmoji(emoji)) return res.status(400).json({ error: 'invalid_reaction' });
  const m = Number.isInteger(id) ? db.prepare('SELECT from_id, to_id FROM messages WHERE id = ?').get(id) : null;
  if (!m || (m.from_id !== me && m.to_id !== me)) return res.status(404).json({ error: 'message_not_found' });
  const other = m.from_id === me ? m.to_id : m.from_id;
  if (blockedEither(me, other)) return res.status(403).json({ error: 'cannot_contact' });
  toggleReaction('dm', id, me, emoji);
  for (const uid of [me, other]) emitTo(uid, 'reaction:update', { kind: 'dm', message_id: id, reactions: loadReactions('dm', [id], uid).get(id) ?? [] });
  res.json({ reactions: loadReactions('dm', [id], me).get(id) ?? [] });
});

// Chat pictures are only served to people who are in the chat they were sent in.
api.get('/chat-images/:id', needUser, (req, res) => {
  const id = Number(req.params.id);
  const row = Number.isInteger(id) && canSeeImage(id, req.user.id) ? db.prepare('SELECT mime, data FROM chat_images WHERE id = ?').get(id) : null;
  if (!row) return res.status(404).end();
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.send(Buffer.from(row.data));
});

api.get('/messages/with/:id', needUser, (req, res) => {
  const me = req.user.id;
  const other = Number(req.params.id);
  const share = shareActivity(me, other);
  const messages = db
    .prepare('SELECT id, from_id, to_id, body, created_at, read_at, image_id FROM messages WHERE (from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?) ORDER BY id DESC LIMIT 50')
    .all(me, other, other, me)
    .reverse()
    // "Seen" is only for my own messages, and only when both of us share it. Nobody's read time is shown for other people's messages.
    .map(({ read_at, ...m }) => (m.from_id === me ? { ...m, read_at: share ? read_at : null } : m));
  const rx = loadReactions('dm', messages.map((m) => m.id), me);
  for (const m of messages) m.reactions = rx.get(m.id) ?? [];
  const now = Date.now();
  const marked = db.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND from_id = ? AND read_at IS NULL').run(now, me, other).changes;
  if (marked && share) emitTo(other, 'dm:read', { by: me, at: now }); // their "Seen" appears live
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
         AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.blocker_id = ? AND b.blocked_id = m.from_id)
       ORDER BY m.id DESC LIMIT 50`,
    )
    .all(me, me, me, me);
  const inbox = threads.filter((t) => t.is_friend);
  const spam = threads.filter((t) => !t.is_friend);
  // Friend requests waiting for an answer (declined ones are hidden), and "accepted your request" notices.
  const requests = db
    .prepare(
      `SELECT u.id, u.handle, u.display_name, (SELECT updated_at FROM avatars WHERE user_id = u.id) AS avatar_at, r.created_at, r.seen_at
       FROM friend_requests r JOIN users u ON u.id = r.from_id
       WHERE r.to_id = ? AND r.declined_at IS NULL ORDER BY r.created_at DESC LIMIT 50`,
    )
    .all(me);
  const accepted = db
    .prepare(
      `SELECT n.id, n.created_at, n.read_at, u.id AS from_id, u.handle, u.display_name
       FROM notifications n JOIN users u ON u.id = n.from_id
       WHERE n.user_id = ? AND n.type = 'friend_accepted' ORDER BY n.id DESC LIMIT 20`,
    )
    .all(me);
  const groups = unreadGroups(me);
  const sum = (list) => list.reduce((s, t) => s + t.unread, 0);
  // The bell badge counts friends' messages, group messages, new friend requests and acceptances. Spam is shown in its own tab and never alerts.
  const badge = sum(inbox) + sum(groups) + requests.filter((r) => !r.seen_at).length + accepted.filter((n) => !n.read_at).length;
  res.json({ inbox, spam, requests, accepted, groups, badge, spamUnread: sum(spam) });
});

// Opening the bell marks notices as seen. Message and group badges clear when you open that chat.
api.post('/notifications/read', needUser, (req, res) => {
  const now = Date.now();
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, req.user.id);
  db.prepare('UPDATE friend_requests SET seen_at = ? WHERE to_id = ? AND seen_at IS NULL').run(now, req.user.id);
  res.json({ ok: true });
});

// Everything read at once: messages (inbox and spam), groups, friend notices and requests. Pending requests stay
// pending (you still have to answer them); they just stop counting as new.
api.post('/notifications/read-all', needUser, (req, res) => {
  const me = req.user.id;
  const now = Date.now();
  const senders = db.prepare('SELECT DISTINCT from_id FROM messages WHERE to_id = ? AND read_at IS NULL').all(me).map((r) => r.from_id);
  db.prepare('UPDATE messages SET read_at = ? WHERE to_id = ? AND read_at IS NULL').run(now, me);
  for (const from of senders) if (shareActivity(me, from)) emitTo(from, 'dm:read', { by: me, at: now });
  db.prepare('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL').run(now, me);
  db.prepare('UPDATE friend_requests SET seen_at = ? WHERE to_id = ? AND seen_at IS NULL').run(now, me);
  db.prepare('UPDATE group_members SET last_read_id = COALESCE((SELECT MAX(id) FROM group_messages x WHERE x.group_id = group_members.group_id), 0) WHERE user_id = ?').run(me);
  for (const { group_id: gid } of db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').all(me)) announceGroupRead(gid, me);
  emitTo(me, 'notif:new', { type: 'read_all' }); // keeps your other tabs in sync
  res.json({ ok: true });
});

/* ---------- group chats ---------- */
// Rules: anyone in a group can rename it and add their own friends. Anyone can leave. Only the creator can remove other
// people. If the creator leaves, the longest-standing member becomes the creator. When the last person leaves, the group is deleted.
// People only see messages from after they joined (so someone added later doesn't read old conversations).
const MAX_GROUP = 20;
const isMember = (groupId, userId) => !!db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId);
const anyBlockBetween = (as, bs) => as.some((a) => bs.some((b) => a !== b && blockedEither(a, b)));
const memberIds = (groupId) => db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(groupId).map((r) => r.user_id);
const groupFor = (req, res) => {
  const id = Number(req.params.id);
  const g = Number.isInteger(id)
    ? db
        .prepare(
          `SELECT g.id, g.name, g.created_by, g.created_at, m.joined_at, (SELECT updated_at FROM group_avatars WHERE group_id = g.id) AS avatar_at FROM group_chats g
           JOIN group_members m ON m.group_id = g.id AND m.user_id = ? WHERE g.id = ?`,
        )
        .get(req.user.id, id)
    : null;
  if (!g) { res.status(404).json({ error: 'group_not_found' }); return null; }
  return g;
};
const markGroupRead = (groupId, userId) =>
  db
    .prepare('UPDATE group_members SET last_read_id = (SELECT COALESCE(MAX(id), 0) FROM group_messages WHERE group_id = ?) WHERE group_id = ? AND user_id = ?')
    .run(groupId, groupId, userId);

// Tell the rest of the group how far this person has read, so "Seen by ..." updates live. Skipped if they turned it off,
// and never sent to someone who is blocked either way.
function announceGroupRead(groupId, userId) {
  if (!activityOn(userId)) return;
  const last = db.prepare('SELECT last_read_id FROM group_members WHERE group_id = ? AND user_id = ?').get(groupId, userId)?.last_read_id;
  if (last == null) return;
  const name = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId).display_name;
  for (const id of memberIds(groupId)) if (id !== userId && !blockedEither(id, userId)) emitTo(id, 'group:read', { group_id: groupId, user_id: userId, name, last_read_id: last });
}
// How far each other member has read (null if they keep it private). Empty if you keep yours private.
function groupReads(groupId, me) {
  if (!activityOn(me)) return [];
  return db
    .prepare('SELECT u.id, u.display_name AS name, u.chat_activity AS on_, m.last_read_id FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? AND m.user_id <> ?')
    .all(groupId, me)
    .filter((r) => !blockedEither(me, r.id))
    .map((r) => ({ id: r.id, name: r.name, last_read_id: r.on_ ? r.last_read_id : null }));
}

// Groups with unread messages for the bell and the group rows. Your own messages and the "X left" notes never count.
function unreadGroups(me) {
  const rows = db
    .prepare(
      `SELECT g.id, g.name,
         (SELECT COUNT(*) FROM group_messages x WHERE x.group_id = g.id AND x.id > m.last_read_id AND x.created_at >= m.joined_at AND x.from_id <> ? AND x.kind = 'msg') AS unread
       FROM group_chats g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?`,
    )
    .all(me, me)
    .filter((r) => r.unread > 0);
  const last = db.prepare("SELECT u.display_name AS from_name, x.body, x.created_at FROM group_messages x JOIN users u ON u.id = x.from_id WHERE x.group_id = ? AND x.kind = 'msg' ORDER BY x.id DESC LIMIT 1");
  return rows.map((r) => ({ ...r, ...last.get(r.id) })).sort((a, b) => b.created_at - a.created_at);
}

// A note in the chat ("Sam left"). Sent to everyone still in the group.
function groupNote(group, actorId, text) {
  const now = Date.now();
  const info = db.prepare("INSERT INTO group_messages(group_id, from_id, body, created_at, kind) VALUES (?,?,?,?,'system')").run(group.id, actorId, text, now);
  const message = { id: Number(info.lastInsertRowid), from_id: actorId, from_name: '', body: text, created_at: now, kind: 'system' };
  for (const id of memberIds(group.id)) emitTo(id, 'group:msg', { group_id: group.id, group_name: group.name, message });
}
const joinList = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]);

api.get('/groups', needUser, (req, res) => {
  const groups = db
    .prepare(
      `SELECT g.id, g.name, g.created_by, g.created_at, (SELECT updated_at FROM group_avatars WHERE group_id = g.id) AS avatar_at,
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
  if (!ids.every((id) => areFriends(req.user.id, id))) return res.status(400).json({ error: 'not_a_friend' });
  if (anyBlockBetween(ids, ids)) return res.status(400).json({ error: 'cannot_add_member' });
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
  const group = { id: groupId, name, created_by: req.user.id, created_at: now, avatar_at: null, member_count: ids.length + 1 };
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
  const { joined_at, ...group } = g;
  res.json({ group, members });
});

// The group picture: any member can set or remove it (like renaming). Same cropper and limits as profile pictures.
api.get('/groups/:id/avatar', needUser, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const row = db.prepare('SELECT mime, data FROM group_avatars WHERE group_id = ?').get(g.id);
  if (!row) return res.status(404).end();
  res.set({ 'Content-Type': row.mime, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff' });
  res.send(Buffer.from(row.data));
});
const announceGroupPicture = (g, req, avatarAt, text) => {
  for (const id of memberIds(g.id)) emitTo(id, 'group:avatar', { group_id: g.id, avatar_at: avatarAt });
  groupNote(g, req.user.id, `${req.user.display_name} ${text}`);
};
api.put('/groups/:id/avatar', needUser, limiter(10), (req, res, next) => rawImage(req, res, (err) => (err ? res.status(413).json({ error: 'image_too_large' }) : next())), (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const mime = sniffImage(req.body);
  if (!mime) return res.status(400).json({ error: 'invalid_image' });
  const now = Date.now();
  db.prepare(
    `INSERT INTO group_avatars(group_id, mime, data, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(group_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
  ).run(g.id, mime, req.body, now);
  announceGroupPicture(g, req, now, 'changed the group picture');
  res.json({ ok: true, avatar_at: now });
});
api.delete('/groups/:id/avatar', needUser, limiter(10), (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  if (db.prepare('DELETE FROM group_avatars WHERE group_id = ?').run(g.id).changes) announceGroupPicture(g, req, null, 'removed the group picture');
  res.json({ ok: true, avatar_at: null });
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

// Add people. Each one has to be on YOUR friend list; they get no history from before they joined.
api.post('/groups/:id/members', needUser, socialLimiter, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const me = req.user.id;
  const ids = [...new Set((Array.isArray(req.body?.memberIds) ? req.body.memberIds : []).map(Number))].filter((n) => Number.isInteger(n) && n !== me);
  if (!ids.length) return res.status(400).json({ error: 'invalid_group' });
  const current = new Set(memberIds(g.id));
  const fresh = ids.filter((id) => !current.has(id));
  if (!fresh.every((id) => areFriends(me, id))) return res.status(400).json({ error: 'not_a_friend' });
  if (current.size + fresh.length > MAX_GROUP) return res.status(400).json({ error: 'group_full' });
  if (!fresh.length) return res.json({ ok: true, added: 0 });
  if (anyBlockBetween(fresh, [...current, ...fresh])) return res.status(400).json({ error: 'cannot_add_member' });
  const now = Date.now();
  db.exec('BEGIN');
  try {
    const lastId = db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM group_messages WHERE group_id = ?').get(g.id).n;
    const add = db.prepare('INSERT INTO group_members(group_id, user_id, joined_at, last_read_id) VALUES (?,?,?,?)');
    for (const id of fresh) add.run(g.id, id, now, lastId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  const names = fresh.map((id) => db.prepare('SELECT display_name FROM users WHERE id = ?').get(id).display_name);
  const group = { id: g.id, name: g.name, created_by: g.created_by, created_at: g.created_at, avatar_at: g.avatar_at ?? null, member_count: current.size + fresh.length };
  for (const id of fresh) emitTo(id, 'group:new', { group, by: req.user.display_name });
  groupNote(g, me, `${req.user.display_name} added ${joinList(names)}`);
  for (const id of memberIds(g.id)) emitTo(id, 'group:members', { group_id: g.id });
  res.json({ ok: true, added: fresh.length });
});

// Leave (your own id) or remove someone (creator only).
api.delete('/groups/:id/members/:userId', needUser, socialLimiter, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const me = req.user.id;
  const target = Number(req.params.userId);
  if (!Number.isInteger(target) || !isMember(g.id, target)) return res.status(404).json({ error: 'member_not_found' });
  if (target !== me && g.created_by !== me) return res.status(403).json({ error: 'not_group_creator' });
  const name = db.prepare('SELECT display_name FROM users WHERE id = ?').get(target).display_name;
  let remaining;
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM group_members WHERE group_id = ? AND user_id = ?').run(g.id, target);
    remaining = memberIds(g.id);
    if (!remaining.length) db.prepare('DELETE FROM group_chats WHERE id = ?').run(g.id); // messages go with it
    else if (g.created_by === target) {
      const heir = db.prepare('SELECT user_id FROM group_members WHERE group_id = ? ORDER BY joined_at, user_id LIMIT 1').get(g.id).user_id;
      db.prepare('UPDATE group_chats SET created_by = ? WHERE id = ?').run(heir, g.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  emitTo(target, 'group:removed', { group_id: g.id, group_name: g.name, left: target === me }); // includes their other tabs
  if (remaining.length) {
    groupNote(g, me, target === me ? `${name} left` : `${req.user.display_name} removed ${name}`);
    for (const id of remaining) emitTo(id, 'group:members', { group_id: g.id });
  }
  res.json({ ok: true });
});

api.post('/groups/:id/read', needUser, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  markGroupRead(g.id, req.user.id);
  announceGroupRead(g.id, req.user.id);
  res.json({ ok: true });
});

// Opening a group's messages marks them read.
api.get('/groups/:id/messages', needUser, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const messages = db
    .prepare(
      `SELECT m.id, m.from_id, u.display_name AS from_name, m.body, m.created_at, m.kind, m.image_id
       FROM group_messages m JOIN users u ON u.id = m.from_id WHERE m.group_id = ? AND m.created_at >= ? ORDER BY m.id DESC LIMIT 50`,
    )
    .all(g.id, g.joined_at)
    .reverse();
  const rx = loadReactions('group', messages.map((m) => m.id), req.user.id);
  for (const m of messages) m.reactions = rx.get(m.id) ?? [];
  markGroupRead(g.id, req.user.id);
  announceGroupRead(g.id, req.user.id);
  res.json({ messages, reads: groupReads(g.id, req.user.id) });
});

function deliverGroupMessage(g, req, res, body, imageId = null) {
  const now = Date.now();
  const info = db.prepare('INSERT INTO group_messages(group_id, from_id, body, created_at, image_id) VALUES (?,?,?,?,?)').run(g.id, req.user.id, body, now, imageId);
  const message = { id: Number(info.lastInsertRowid), from_id: req.user.id, from_name: req.user.display_name, body, created_at: now, kind: 'msg', image_id: imageId, reactions: [] };
  for (const id of memberIds(g.id)) emitTo(id, 'group:msg', { group_id: g.id, group_name: g.name, message }); // includes the sender's other tabs
  res.json({ message });
}
api.post('/groups/:id/messages', needUser, socialLimiter, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const body = cleanBody(req.body?.body, 2000);
  if (!body) return res.status(400).json({ error: 'invalid_message' });
  deliverGroupMessage(g, req, res, body);
});
// A picture in the group (raw image bytes; optional ?caption=…).
api.post('/groups/:id/messages/image', needUser, limiter(20), parseChatImage, (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const mime = sniffImage(req.body);
  if (!mime) return res.status(400).json({ error: 'invalid_image' });
  deliverGroupMessage(g, req, res, cleanBody(req.query.caption, 500) || IMAGE_BODY, saveChatImage(req.user.id, mime, req.body));
});
// React to a group message. Only people who were already in the group when it was sent can see (or add to) its reactions.
api.put('/groups/:id/messages/:mid/react', needUser, limiter(60), (req, res) => {
  const g = groupFor(req, res);
  if (!g) return;
  const me = req.user.id;
  const mid = Number(req.params.mid);
  const emoji = String(req.body?.emoji ?? '');
  if (!isReactionEmoji(emoji)) return res.status(400).json({ error: 'invalid_reaction' });
  const m = Number.isInteger(mid) ? db.prepare('SELECT from_id, created_at, kind FROM group_messages WHERE id = ? AND group_id = ?').get(mid, g.id) : null;
  if (!m || m.kind !== 'msg' || m.created_at < g.joined_at) return res.status(404).json({ error: 'message_not_found' });
  if (m.from_id !== me && blockedEither(me, m.from_id)) return res.status(403).json({ error: 'cannot_contact' });
  toggleReaction('group', mid, me, emoji);
  const viewers = db.prepare('SELECT user_id FROM group_members WHERE group_id = ? AND joined_at <= ?').all(g.id, m.created_at).map((r) => r.user_id);
  for (const uid of viewers) emitTo(uid, 'reaction:update', { kind: 'group', group_id: g.id, message_id: mid, reactions: loadReactions('group', [mid], uid).get(mid) ?? [] });
  res.json({ reactions: loadReactions('group', [mid], me).get(mid) ?? [] });
});

/* ---------- chats list: every conversation you have, newest first ---------- */
// Friends you've messaged (or who messaged you) plus your groups, each with its last message and unread count.
// The bell only shows what's unread; this is where read conversations live.
api.get('/chats', needUser, (req, res) => {
  const me = req.user.id;
  const dms = db
    .prepare(
      `SELECT p.other AS id, u.handle, u.display_name, (SELECT updated_at FROM avatars WHERE user_id = u.id) AS avatar_at,
         m.body, m.from_id, m.created_at,
         (SELECT COUNT(*) FROM messages x WHERE x.to_id = ? AND x.from_id = p.other AND x.read_at IS NULL) AS unread
       FROM (SELECT CASE WHEN from_id = ? THEN to_id ELSE from_id END AS other, MAX(id) AS last_id
             FROM messages WHERE from_id = ? OR to_id = ? GROUP BY other) p
       JOIN messages m ON m.id = p.last_id
       JOIN users u ON u.id = p.other
       WHERE EXISTS (SELECT 1 FROM friends f WHERE f.user_id = ? AND f.friend_id = p.other)
       ORDER BY m.id DESC LIMIT 100`,
    )
    .all(me, me, me, me, me)
    .map((r) => ({ type: 'dm', id: r.id, handle: r.handle, display_name: r.display_name, avatar_at: r.avatar_at, preview: r.body, mine: r.from_id === me, at: r.created_at, unread: r.unread }));
  const lastMsg = db.prepare("SELECT u.display_name AS from_name, x.from_id, x.body, x.created_at FROM group_messages x JOIN users u ON u.id = x.from_id WHERE x.group_id = ? AND x.kind = 'msg' AND x.created_at >= ? ORDER BY x.id DESC LIMIT 1");
  const groups = db
    .prepare(
      `SELECT g.id, g.name, g.created_at, m.joined_at, (SELECT updated_at FROM group_avatars WHERE group_id = g.id) AS avatar_at,
         (SELECT COUNT(*) FROM group_members z WHERE z.group_id = g.id) AS member_count,
         (SELECT COUNT(*) FROM group_messages x WHERE x.group_id = g.id AND x.id > m.last_read_id AND x.created_at >= m.joined_at AND x.from_id <> ? AND x.kind = 'msg') AS unread
       FROM group_chats g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?`,
    )
    .all(me, me)
    .map((g) => {
      const l = lastMsg.get(g.id, g.joined_at);
      return { type: 'group', id: g.id, name: g.name, avatar_at: g.avatar_at, member_count: g.member_count, preview: l ? l.body : null, from_name: l?.from_name ?? null, mine: l ? l.from_id === me : false, at: l ? l.created_at : g.created_at, unread: g.unread };
    });
  res.json({ chats: [...dms, ...groups].sort((a, b) => b.at - a.at) });
});
