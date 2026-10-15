import { Server } from 'socket.io';
import { parseCookie } from 'cookie';
import cookieParser from 'cookie-parser';
import { db, sessionInfo, endSession, isStandingSession, blockedEither, activityOn, shareActivity, statusOf, saveStatus, clearStatus } from './db.js';
import { cfg } from './env.js';
import { userFromToken } from './auth.js';
import { isHuman } from './security.js';
import { cleanName, cleanBody, normalizeSessionId, isSessionId } from './util.js';

const MAX_PEOPLE = 6; // full-mesh WebRTC: every person connects to every other person
let io;
const online = new Map(); // userId -> Set(socket ids)
const rooms = new Map(); // sessionId -> Map(socket id -> { nickname, userId })

export const isOnline = (userId) => online.has(userId);
export const roomCount = (sessionId) => rooms.get(sessionId)?.size ?? 0;
// Disconnects a person's live connections (the ones whose login cookie matches), so logging out or signing out other
// devices also makes them go offline instead of staying "online" on a page that is no longer signed in.
export function dropSockets(userId, shouldDrop) {
  for (const sid of [...(online.get(userId) ?? [])]) {
    const s = io?.sockets.sockets.get(sid);
    if (s && shouldDrop(s.data.cookies?.sid)) s.disconnect(true);
  }
}
export const emitTo = (userId, event, data) => io?.to(`u:${userId}`).emit(event, data);

const MAX_RECAP_ITEMS = 100; // per call, so a room can't be used to fill the database
const recapItems = db.prepare('SELECT id, kind, body, owner_name, owner_user_id, done FROM recap_items WHERE session_id = ? ORDER BY id');
const recapOne = db.prepare('SELECT id, kind, body, owner_name, owner_user_id, done FROM recap_items WHERE id = ?');
const recapCount = db.prepare('SELECT COUNT(*) AS n FROM recap_items WHERE session_id = ?');
const recapInsert = db.prepare('INSERT INTO recap_items(session_id, kind, body, owner_name, owner_user_id, created_by, created_at) VALUES (?,?,?,?,?,?,?)');
const watchers = db.prepare('SELECT user_id FROM friends WHERE friend_id = ?');
const insertCall = db.prepare('INSERT OR IGNORE INTO call_log(user_id, session_id, day, started_at) VALUES (?,?,?,?)');

function broadcastPresence(userId, isOn) {
  for (const w of watchers.all(userId)) emitTo(w.user_id, 'presence', { id: userId, online: isOn });
}

/* ---------- status: tell friends (and my other tabs), and set "In a meeting" by itself while I'm in a call ---------- */
export function announceStatus(userId) {
  const status = statusOf(userId);
  const ids = new Set([userId, ...watchers.all(userId).map((r) => r.user_id)]);
  for (const id of ids) if (id === userId || !blockedEither(id, userId)) emitTo(id, 'status', { id: userId, status });
  return status;
}
export const isInCall = (userId) => { for (const room of rooms.values()) for (const m of room.values()) if (m.userId === userId) return true; return false; };
// Call after someone joins or leaves a call. In a call: "In a meeting" (replacing an automatic "Away", never something they picked).
// Not in a call: an automatic "In a meeting" goes away again.
export function syncCallStatus(userId) {
  if (userId == null) return;
  const s = statusOf(userId);
  if (isInCall(userId)) {
    if (s && (!s.auto || s.kind === 'meeting')) return;
    saveStatus(userId, 'meeting', { auto: true });
    announceStatus(userId);
  } else if (s?.auto && s.kind === 'meeting') {
    clearStatus(userId);
    announceStatus(userId);
  }
}
// A status you picked with "clear after" can run out while you're still in the call: pick the automatic one back up.
function resyncCalls() {
  const ids = new Set();
  for (const room of rooms.values()) for (const m of room.values()) if (m.userId) ids.add(m.userId);
  ids.forEach(syncCallStatus);
}

function logCall(sessionId, room) {
  const now = Date.now();
  for (const m of room.values()) if (m.userId) insertCall.run(m.userId, sessionId, Math.floor(now / 86_400_000), now);
}

function leaveRoom(socket) {
  const id = socket.data.room;
  if (!id) return;
  socket.data.room = null;
  socket.leave(`r:${id}`);
  const room = rooms.get(id);
  if (!room) return;
  room.delete(socket.id);
  socket.to(`r:${id}`).emit('room:peer-left', { id: socket.id });
  if (!room.size) rooms.delete(id);
  syncCallStatus(socket.data.user?.id);
}

// The host is the session's owner (signed-in creator) or whoever holds the signed host cookie made when they created it.
function isHostOf(socket, id, info) {
  if (info.owner_id != null && info.owner_id === socket.data.user?.id) return true;
  const raw = socket.data.cookies?.['h_' + id];
  return !!raw?.startsWith('s:') && cookieParser.signedCookie(raw, cfg.cookieSecret) === '1';
}

function joinRoom(socket, p = {}, ack) {
  const reply = typeof ack === 'function' ? ack : () => {};
  const id = normalizeSessionId(p.sessionId);
  const info = isSessionId(id) ? sessionInfo(id) : null;
  if (!info) return reply({ error: 'session_not_found' });
  if (info.ended_at) return reply({ error: 'session_ended' });
  // Signed-in people always appear under their display name; only guests choose a nickname.
  const user = socket.data.user;
  const nickname = user ? cleanName(user.display_name, 40) : cleanName(p.nickname, 24);
  if (!nickname) return reply({ error: 'nickname_required' }); // guests must set a nickname before entering
  if (socket.data.room) leaveRoom(socket);
  const room = rooms.get(id) ?? new Map();
  // One seat per account: you can't join a call you're already in (another tab, browser or device), so nobody
  // ends up in a call with themselves, e.g. by opening their own invite link.
  if (user && [...room].some(([sid, m]) => m.userId === user.id && sid !== socket.id)) return reply({ error: 'already_in_call' });
  // If you and someone already in the call have blocked each other (either way), you can't join. The error is generic on purpose.
  if (user && [...room.values()].some((m) => m.userId && m.userId !== user.id && blockedEither(user.id, m.userId))) return reply({ error: 'cannot_join' });
  if (room.size >= MAX_PEOPLE) return reply({ error: 'room_full' });
  const peers = [...room].map(([sid, m]) => ({ id: sid, nickname: m.nickname, handle: m.handle, avatarAt: m.avatarAt }));
  const handle = user?.handle ?? null; // lets other people open this person's profile card (guests have none)
  const avatarAt = user?.avatar_at ?? null;
  const host = isHostOf(socket, id, info);
  room.set(socket.id, { nickname, userId: user?.id ?? null, handle, avatarAt, host });
  rooms.set(id, room);
  socket.data.room = id;
  socket.join(`r:${id}`);
  socket.to(`r:${id}`).emit('room:peer-joined', { id: socket.id, nickname, handle, avatarAt });
  if (room.size >= 2) logCall(id, room);
  syncCallStatus(user?.id);
  reply({ ok: true, selfId: socket.id, nickname, host, peers, recap: recapItems.all(id).map(publicRecap) });
}

const publicRecap = (r) => ({ id: r.id, kind: r.kind, body: r.body, owner_name: r.owner_name, owner_user_id: r.owner_user_id, done: !!r.done });

function onConnect(socket) {
  const me = socket.data.user;
  if (me) {
    socket.join(`u:${me.id}`);
    if (!online.has(me.id)) {
      online.set(me.id, new Set());
      broadcastPresence(me.id, true);
    }
    online.get(me.id).add(socket.id);
  }

  socket.on('room:join', (payload, ack) => joinRoom(socket, payload, ack));

  // Relay WebRTC offers/answers/ICE candidates, but only between people in the same room.
  socket.on('room:signal', (msg) => {
    const roomId = socket.data.room;
    const room = roomId && rooms.get(roomId);
    if (!room || !msg || !room.has(msg.to) || typeof msg.data !== 'object') return;
    const me = room.get(socket.id);
    io.to(msg.to).emit('room:signal', { from: socket.id, nickname: me.nickname, handle: me.handle, avatarAt: me.avatarAt, data: msg.data });
  });

  /* ---------- smart recap: shared decisions + follow-ups for this call ---------- */
  const inRoom = () => {
    const roomId = socket.data.room;
    const room = roomId && rooms.get(roomId);
    return room && room.has(socket.id) ? { roomId, room } : null;
  };
  socket.on('recap:add', (p = {}) => {
    const ctx = inRoom();
    const body = cleanBody(p.body, 300);
    const now = Date.now();
    if (!ctx || !body || !['decision', 'action'].includes(p.kind) || now - (socket.data.lastRecap || 0) < 250) return;
    if (recapCount.get(ctx.roomId).n >= MAX_RECAP_ITEMS) return;
    socket.data.lastRecap = now;
    const owner = p.kind === 'action' ? ctx.room.get(String(p.ownerId)) : null; // the owner must be someone in this call
    const info = recapInsert.run(ctx.roomId, p.kind, body, owner?.nickname ?? null, owner?.userId ?? null, me?.id ?? null, now);
    io.to(`r:${ctx.roomId}`).emit('recap:item', publicRecap(recapOne.get(Number(info.lastInsertRowid))));
  });
  socket.on('recap:done', (p = {}) => {
    const ctx = inRoom();
    if (!ctx) return;
    const row = recapOne.get(Number(p.id));
    const own = row && db.prepare('SELECT 1 FROM recap_items WHERE id = ? AND session_id = ?').get(row.id, ctx.roomId);
    if (!own || row.kind !== 'action') return;
    db.prepare('UPDATE recap_items SET done = ? WHERE id = ?').run(p.done ? 1 : 0, row.id);
    io.to(`r:${ctx.roomId}`).emit('recap:item', publicRecap(recapOne.get(row.id)));
  });
  socket.on('recap:remove', (p = {}) => {
    const ctx = inRoom();
    if (!ctx) return;
    const info = db.prepare('DELETE FROM recap_items WHERE id = ? AND session_id = ?').run(Number(p.id), ctx.roomId);
    if (info.changes) io.to(`r:${ctx.roomId}`).emit('recap:removed', { id: Number(p.id) });
  });

  socket.on('room:chat', (text) => {
    const roomId = socket.data.room;
    const self = roomId && rooms.get(roomId)?.get(socket.id);
    const body = cleanBody(text, 1000);
    const now = Date.now();
    if (!self || !body || now - (socket.data.lastChat || 0) < 250) return;
    socket.data.lastChat = now;
    io.to(`r:${roomId}`).emit('room:chat', { from: socket.id, nickname: self.nickname, body, at: now });
  });

  /* ---------- typing indicators (never stored; only sent between people who share them) ---------- */
  // { to } for a direct chat, { group_id } for a group. `on: false` means they stopped. Starts are throttled.
  socket.on('typing', (p = {}) => {
    if (!me || !p || typeof p !== 'object') return;
    const on = p.on !== false;
    const now = Date.now();
    if (on && now - (socket.data.lastTyping || 0) < 1500) return;
    if (on) socket.data.lastTyping = now;
    const name = db.prepare('SELECT display_name FROM users WHERE id = ?').get(me.id)?.display_name;
    if (!name) return;
    if (p.group_id != null) {
      const gid = Number(p.group_id);
      const ids = Number.isInteger(gid) ? db.prepare('SELECT user_id FROM group_members WHERE group_id = ?').all(gid).map((r) => r.user_id) : [];
      if (!ids.includes(me.id) || !activityOn(me.id)) return;
      for (const id of ids) if (id !== me.id && activityOn(id) && !blockedEither(id, me.id)) emitTo(id, 'typing', { group_id: gid, from: me.id, name, on });
    } else {
      const to = Number(p.to);
      if (Number.isInteger(to) && to !== me.id && shareActivity(me.id, to)) emitTo(to, 'typing', { from: me.id, name, on });
    }
  });
  // Typing in a call's chat: shown to the others in the same call.
  socket.on('room:typing', (on) => {
    const roomId = socket.data.room;
    const self = roomId && rooms.get(roomId)?.get(socket.id);
    const now = Date.now();
    if (!self || (on !== false && now - (socket.data.lastRoomTyping || 0) < 1500)) return;
    if (on !== false) socket.data.lastRoomTyping = now;
    socket.to(`r:${roomId}`).emit('room:typing', { from: socket.id, nickname: self.nickname, on: on !== false });
  });

  // Only the host can end the session: everyone is told, removed from the room, and the code stops working.
  socket.on('room:end', (ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const ctx = inRoom();
    if (!ctx || !ctx.room.get(socket.id)?.host) return reply({ error: 'not_host' });
    endSession(ctx.roomId);
    socket.to(`r:${ctx.roomId}`).emit('room:ended', { standing: isStandingSession(ctx.roomId) }); // everyone except the host: the host gets the ack below. Telling the host too made its page close the socket before the ack arrived, so it showed a false "couldn't end" error.
    for (const sid of ctx.room.keys()) {
      const s = io.sockets.sockets.get(sid);
      if (s) { s.data.room = null; s.leave(`r:${ctx.roomId}`); }
    }
    rooms.delete(ctx.roomId);
    for (const m of ctx.room.values()) syncCallStatus(m.userId); // the call is over for everyone in it
    reply({ ok: true });
  });

  socket.on('room:leave', () => leaveRoom(socket));

  socket.on('disconnect', () => {
    leaveRoom(socket);
    if (!me) return;
    const sockets = online.get(me.id);
    sockets?.delete(socket.id);
    if (sockets && !sockets.size) {
      online.delete(me.id);
      broadcastPresence(me.id, false);
    }
  });
}

export function attachRealtime(server) {
  // Calls live in memory, so after a restart nobody is in one: drop any automatic "In a meeting" / "Away" left over from before.
  db.prepare('UPDATE users SET status_kind = NULL, status_emoji = NULL, status_text = NULL, status_until = NULL, status_auto = 0 WHERE status_auto = 1').run();
  setInterval(resyncCalls, 30_000).unref();
  io = new Server(server, {
    maxHttpBufferSize: 1e5,
    // Notice a vanished browser (closed laptop, dead wifi) in about 15 seconds instead of the 45 default, so "online" stays honest.
    pingInterval: 8000,
    pingTimeout: 7000,
    // Same-origin only: reject WebSocket/polling requests that come from another website.
    allowRequest: (req, cb) => {
      const origin = req.headers.origin;
      try {
        cb(null, !origin || new URL(origin).host === req.headers.host);
      } catch {
        cb(null, false);
      }
    },
  });

  io.use((socket, next) => {
    const cookies = parseCookie(socket.request.headers.cookie || '');
    // Only accept a *signed* human cookie (cookieParser.signedCookie returns unsigned input as-is, so check the prefix).
    const signed = cookies.human?.startsWith('s:') ? cookieParser.signedCookie(cookies.human, cfg.cookieSecret) : false;
    if (!signed || !isHuman(signed)) return next(new Error('captcha_required'));
    socket.data.user = userFromToken(cookies.sid);
    socket.data.cookies = cookies; // read later for the per-session host cookie
    next();
  });

  io.on('connection', onConnect);
}
