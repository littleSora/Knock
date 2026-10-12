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
-- One-way: a row means user_id has friend_id in their own friend list.
CREATE TABLE IF NOT EXISTS friends (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS friends_by_friend ON friends(friend_id);
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
-- Group chats: created from a friend's profile card. Members are always friends of the creator at creation time.
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

export function createSession(ownerId = null) {
  const insert = db.prepare('INSERT OR IGNORE INTO call_sessions(id, owner_id, created_at) VALUES (?, ?, ?)');
  for (;;) {
    const id = newSessionId();
    if (insert.run(id, ownerId, Date.now()).changes) return id;
  }
}
export const sessionExists = (id) => !!db.prepare('SELECT 1 FROM call_sessions WHERE id = ?').get(id);
export const sessionInfo = (id) => db.prepare('SELECT owner_id, ended_at FROM call_sessions WHERE id = ?').get(id) ?? null;
export const endSession = (id) => db.prepare('UPDATE call_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(Date.now(), id);

export function purgeExpired() {
  const now = Date.now();
  db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM otps WHERE expires_at < ?').run(now);
  db.prepare(
    `DELETE FROM call_sessions WHERE created_at < ?
       AND id NOT IN (SELECT session_id FROM appointments)
       AND id NOT IN (SELECT session_id FROM recap_items)`, // keep sessions whose recap people still want to read
  ).run(now - 48 * 3600 * 1000);
}
