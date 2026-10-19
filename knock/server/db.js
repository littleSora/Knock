import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { newSessionId } from './util.js';

const file = process.env.DB_PATH || path.resolve('data/knock.db');
fs.mkdirSync(path.dirname(file), { recursive: true });
export const db = new DatabaseSync(file);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  email TEXT UNIQUE,
  phone TEXT UNIQUE,
  google_sub TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  target TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
-- Mutual: a friendship is two rows (A->B and B->A), written together when a request is accepted.
CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS friends_by_friend ON friends(friend_id);
-- A pending friend request. Declining keeps the row (declined_at) so the sender can't simply re-send it every minute.
CREATE TABLE IF NOT EXISTS friend_requests (
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  seen_at INTEGER,
  declined_at INTEGER,
  PRIMARY KEY (from_id, to_id)
);
CREATE INDEX IF NOT EXISTS friend_requests_by_to ON friend_requests(to_id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  to_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE INDEX IF NOT EXISTS messages_by_to ON messages(to_id, from_id);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  from_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  read_at INTEGER
);
CREATE TABLE IF NOT EXISTS call_sessions (
  id TEXT PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
-- A "call" = a session where the user was present with at least one other person. day = UTC day number.
CREATE TABLE IF NOT EXISTS call_log (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  day INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, session_id, day)
);
CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  session_id TEXT NOT NULL REFERENCES call_sessions(id)
);
-- Smart recaps: decisions and follow-ups jotted down during a call. Anyone in the call can add them.
CREATE TABLE IF NOT EXISTS recap_items (
  id INTEGER PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES call_sessions(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('decision', 'action')),
  body TEXT NOT NULL,
  owner_name TEXT,
  owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS recap_by_session ON recap_items(session_id);
-- Group chats: created from a friend's profile card. Members are always friends of whoever added them.
CREATE TABLE IF NOT EXISTS group_chats (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
  group_id INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_by_user ON group_members(user_id);
CREATE TABLE IF NOT EXISTS group_messages (
  id INTEGER PRIMARY KEY,
  group_id INTEGER NOT NULL REFERENCES group_chats(id) ON DELETE CASCADE,
  from_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS group_messages_by_group ON group_messages(group_id, id);
-- Profile pictures: the browser crops to a small square before upload, so each row is tiny.
-- Blocking: one row per direction. Whoever blocks is blocker_id. The blocked person is never told.
CREATE TABLE IF NOT EXISTS blocks (
  blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);
CREATE INDEX IF NOT EXISTS blocks_by_blocked ON blocks(blocked_id);
-- Reports for the review team. category/reason come from public/js/report-categories.js. evidence is a JSON snapshot
-- (recent messages) taken at report time, so it survives the sender deleting or the call ending. status: open | actioned | dismissed.
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY,
  reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reported_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  reason TEXT,
  details TEXT,
  context_type TEXT NOT NULL DEFAULT 'profile',
  context_ref TEXT,
  evidence TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  reviewed_at INTEGER,
  review_note TEXT
);
CREATE INDEX IF NOT EXISTS reports_by_status ON reports(status, created_at);
CREATE INDEX IF NOT EXISTS reports_by_reported ON reports(reported_id);
CREATE TABLE IF NOT EXISTS avatars (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`);

// A host can end a session for everyone; ended sessions can't be rejoined.
if (!db.prepare('PRAGMA table_info(call_sessions)').all().some((c) => c.name === 'ended_at')) {
  db.exec('ALTER TABLE call_sessions ADD COLUMN ended_at INTEGER');
}

// The name an account was created with (display_name can be changed later). Older accounts get their current name.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'signup_name')) {
  db.exec('ALTER TABLE users ADD COLUMN signup_name TEXT');
  db.exec('UPDATE users SET signup_name = display_name WHERE signup_name IS NULL');
}

// Saved look of the app (JSON, validated by public/js/theme-core.js). NULL = default.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'theme')) {
  db.exec('ALTER TABLE users ADD COLUMN theme TEXT');
}

// Group unread badges: each member remembers the last message they have read.
if (!db.prepare('PRAGMA table_info(group_members)').all().some((c) => c.name === 'last_read_id')) {
  db.exec('ALTER TABLE group_members ADD COLUMN last_read_id INTEGER NOT NULL DEFAULT 0');
  // Existing history counts as read, so nobody wakes up to a wall of badges after upgrading.
  db.exec('UPDATE group_members SET last_read_id = COALESCE((SELECT MAX(id) FROM group_messages x WHERE x.group_id = group_members.group_id), 0)');
}
// 'system' rows are the little notes in a group chat ("Sam left", "Ana added Ben"). They never count as unread.
if (!db.prepare('PRAGMA table_info(group_messages)').all().some((c) => c.name === 'kind')) {
  db.exec("ALTER TABLE group_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'msg'");
}

// One-time move from one-way friend adds to mutual friendships (PRAGMA user_version tracks it).
// A pair that already added each other stays friends. A one-way add becomes a pending request from the person who
// added, so the other person decides; until they accept, neither can see the other's online status.
if (db.prepare('PRAGMA user_version').get().user_version < 1) {
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT OR IGNORE INTO friend_requests(from_id, to_id, created_at, seen_at)
       SELECT f.user_id, f.friend_id, f.created_at, ? FROM friends f
       WHERE NOT EXISTS (SELECT 1 FROM friends r WHERE r.user_id = f.friend_id AND r.friend_id = f.user_id)`,
    ).run(Date.now());
    db.exec('DELETE FROM friends WHERE NOT EXISTS (SELECT 1 FROM friends r WHERE r.user_id = friends.friend_id AND r.friend_id = friends.user_id)');
    db.exec("DELETE FROM notifications WHERE type = 'friend_add'"); // replaced by real requests
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// v2: collapse duplicate "accepted your friend request" notices from before they were de-duplicated (keep the newest per pair).
if (db.prepare('PRAGMA user_version').get().user_version < 2) {
  db.exec(`DELETE FROM notifications WHERE type = 'friend_accepted' AND id NOT IN (
    SELECT MAX(id) FROM notifications WHERE type = 'friend_accepted' GROUP BY user_id, from_id)`);
  db.exec('PRAGMA user_version = 2');
}

// "Seen" receipts and typing indicators can be switched off per person (1 = on, the default). Off means both: you don't show
// them and you don't see anyone else's.
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'chat_activity')) {
  db.exec('ALTER TABLE users ADD COLUMN chat_activity INTEGER NOT NULL DEFAULT 1');
}

// Optional profile details people can fill in in Settings (all NULL until then). birthday is 'YYYY-MM-DD'.
for (const col of ['first_name', 'last_name', 'middle_initial', 'birthday', 'workplace', 'country']) {
  if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
}

// Chat pictures, emoji reactions and group pictures.
// chat_images: one row per picture sent in a chat (the browser shrinks it first). Who may see it is decided from the
// message that carries it (see server/chat-extras.js), never from the id alone.
// reactions: kind is 'dm' (messages.id) or 'group' (group_messages.id); one row per person per emoji per message.
db.exec(`
CREATE TABLE IF NOT EXISTS chat_images (
  id INTEGER PRIMARY KEY,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reactions (
  kind TEXT NOT NULL CHECK (kind IN ('dm', 'group')),
  message_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, message_id, user_id, emoji)
);
CREATE TABLE IF NOT EXISTS group_avatars (
  group_id INTEGER PRIMARY KEY REFERENCES group_chats(id) ON DELETE CASCADE,
  mime TEXT NOT NULL,
  data BLOB NOT NULL,
  updated_at INTEGER NOT NULL
);
`);
for (const table of ['messages', 'group_messages']) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === 'image_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN image_id INTEGER`);
}

// Editing, deleting and pinning messages. A deleted message keeps its row (so a report can still quote it) but its content is
// never sent to anyone's browser again: chats show “This message was deleted” in its place. Pictures are removed for good.
const ensureColumn = (table, col, ddl) => {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
};
for (const table of ['messages', 'group_messages']) for (const col of ['edited_at', 'deleted_at', 'pinned_at', 'pinned_by']) ensureColumn(table, col, 'INTEGER');

// Repeating calls: how often (none, daily, weekdays, weekly, biweekly, monthly), an optional last day, and the browser's UTC
// offset when the call was made (only used to write "every weekday" correctly in the .ics file).
ensureColumn('appointments', 'recurrence', "TEXT NOT NULL DEFAULT 'none'");
ensureColumn('appointments', 'repeat_until', 'INTEGER');
ensureColumn('appointments', 'tz_offset', 'INTEGER NOT NULL DEFAULT 0');

// Group roles. The creator (group_chats.created_by) is always an admin and can make other members admins. The creator can also
// limit who may rename the group and who may add people; by default nothing is limited, exactly as before.
ensureColumn('group_members', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('group_chats', 'only_admins_rename', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('group_chats', 'only_admins_add', 'INTEGER NOT NULL DEFAULT 0');

// Custom status ("In a meeting", "Do not disturb", or your own words), shown to friends next to the online dot.
// status_kind: NULL (none) | 'meeting' | 'dnd' | 'away' | 'custom'. status_until (ms) is when it clears by itself; NULL = until you clear it.
ensureColumn('users', 'status_kind', 'TEXT');
ensureColumn('users', 'status_emoji', 'TEXT');
ensureColumn('users', 'status_text', 'TEXT');
ensureColumn('users', 'status_until', 'INTEGER');
// status_auto: 1 when Knock set the status by itself ("In a meeting" while you're in a call, "Away" after 10 minutes away from
// the tab). Anything you pick yourself is 0, and Knock never overwrites that.
ensureColumn('users', 'status_auto', 'INTEGER NOT NULL DEFAULT 0');

// Browser push subscriptions (one row per browser). `preview` = may the notification show the message text.
// Also a tiny key/value table, used to keep the push (VAPID) keys so they survive restarts without any setup.
db.exec(`
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  preview INTEGER NOT NULL DEFAULT 1,
  session_hash TEXT NOT NULL, -- the login (auth_sessions.token_hash) that turned it on: logging out of it turns the push off
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS push_by_user ON push_subscriptions(user_id);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`);

// What a friend may see of someone's status: nothing once it has expired. Used by every place that shows one.
const statusRow = db.prepare('SELECT status_kind, status_emoji, status_text, status_until, status_auto FROM users WHERE id = ?');
export function statusOf(id, now = Date.now()) {
  const s = statusRow.get(id);
  if (!s || !s.status_kind || (s.status_until != null && s.status_until <= now)) return null;
  return { kind: s.status_kind, emoji: s.status_emoji || '', text: s.status_text || '', until: s.status_until, auto: !!s.status_auto };
}
export const isDnd = (id) => statusOf(id)?.kind === 'dnd';
// The only statuses there are: [emoji, text]. Picked from the Status drop-down, or set by Knock itself (meeting, away).
export const STATUS_PRESETS = { meeting: ['📅', 'In a meeting'], dnd: ['⛔', 'Do not disturb'], away: ['🌙', 'Away'] };
const writeStatus = db.prepare('UPDATE users SET status_kind = ?, status_emoji = ?, status_text = ?, status_until = ?, status_auto = ? WHERE id = ?');
// auto = true: Knock set it (no end time). The callers decide whether that is allowed; this just writes. An unknown kind clears it.
export function saveStatus(id, kind, { until = null, auto = false } = {}) {
  const preset = STATUS_PRESETS[kind];
  if (!preset) writeStatus.run(null, null, null, null, 0, id);
  else writeStatus.run(kind, preset[0], preset[1], until, auto ? 1 : 0, id);
}
export const clearStatus = (id) => saveStatus(id, null);

// Blocking helpers. hasBlocked(a, b): a blocked b. blockedEither: either of them blocked the other.
const blockOne = db.prepare('SELECT 1 FROM blocks WHERE blocker_id = ? AND blocked_id = ?');
export const hasBlocked = (a, b) => !!blockOne.get(a, b);
export const blockedEither = (a, b) => hasBlocked(a, b) || hasBlocked(b, a);

const activityRow = db.prepare('SELECT chat_activity FROM users WHERE id = ?');
const friendRow = db.prepare('SELECT 1 FROM friends WHERE user_id = ? AND friend_id = ?');
export const activityOn = (id) => activityRow.get(id)?.chat_activity === 1;
// Receipts / typing between two people in a direct chat: both switched it on, they are friends of each other, and neither blocked the other.
export const shareActivity = (a, b) => activityOn(a) && activityOn(b) && !!friendRow.get(a, b) && !!friendRow.get(b, a) && !blockedEither(a, b);

export function createSession(ownerId = null) {
  const insert = db.prepare('INSERT OR IGNORE INTO call_sessions(id, owner_id, created_at) VALUES (?, ?, ?)');
  for (;;) {
    const id = newSessionId();
    if (insert.run(id, ownerId, Date.now()).changes) return id;
  }
}
export const sessionExists = (id) => !!db.prepare('SELECT 1 FROM call_sessions WHERE id = ?').get(id);
export const sessionInfo = (id) => db.prepare('SELECT owner_id, ended_at FROM call_sessions WHERE id = ?').get(id) ?? null;
// A repeating call keeps one standing link: the host ending it sends everyone out, but the code works again at the next one.
export const isStandingSession = (id) => !!db.prepare("SELECT 1 FROM appointments WHERE session_id = ? AND recurrence <> 'none'").get(id);
export const endSession = (id) => {
  if (isStandingSession(id)) return;
  db.prepare('UPDATE call_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), id);
};

export function purgeExpired() {
  const now = Date.now();
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM otps WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM pending_signups WHERE expires_at < ?').run(now);
  db.exec('DELETE FROM push_subscriptions WHERE session_hash NOT IN (SELECT token_hash FROM auth_sessions)');
  // Pictures whose message is gone (a deleted group, a removed account) and reactions on messages that no longer exist.
  db.exec(`DELETE FROM chat_images WHERE id NOT IN (SELECT image_id FROM messages WHERE image_id IS NOT NULL)
             AND id NOT IN (SELECT image_id FROM group_messages WHERE image_id IS NOT NULL)`);
  db.exec(`DELETE FROM reactions WHERE (kind = 'dm' AND message_id NOT IN (SELECT id FROM messages))
             OR (kind = 'group' AND message_id NOT IN (SELECT id FROM group_messages))`);
  db.prepare(
    `DELETE FROM call_sessions WHERE created_at < ?
       AND id NOT IN (SELECT session_id FROM appointments)
       AND id NOT IN (SELECT session_id FROM recap_items)`, // keep sessions whose recap people still want to read
  ).run(now - 48 * 3600 * 1000);
}

// Email + password accounts. password_hash is NULL for older accounts that were made before passwords existed (they set one
// with "Forgot password"). pending_signups holds a new sign-up until its emailed code is entered; only then is a user created.
ensureColumn('users', 'password_hash', 'TEXT');
db.exec(`CREATE TABLE IF NOT EXISTS pending_signups (
  email TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
)`);
