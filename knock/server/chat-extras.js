// Emoji reactions and chat pictures: the rules for who may react to / see what. Kept apart from api.js so they are easy to read.
import { db, blockedEither } from './db.js';
import { REACTION_EMOJI } from '../public/js/reactions.js';

export const isReactionEmoji = (e) => REACTION_EMOJI.includes(e);

// Pictures are stored as shrunk JPEG/PNG/WebP only (never SVG). Same sniffing as profile pictures.
export function sniffImage(b) {
  if (!Buffer.isBuffer(b)) return null;
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
export function saveChatImage(ownerId, mime, data) {
  return Number(db.prepare('INSERT INTO chat_images(owner_id, mime, data, created_at) VALUES (?,?,?,?)').run(ownerId, mime, data, Date.now()).lastInsertRowid);
}

// Can this person see picture `id`? Only people in the chat that carries it (and, in a group, only if they were
// already a member when it was sent). Someone who blocked / was blocked by the sender doesn't get it either.
export function canSeeImage(id, me) {
  const dm = db.prepare('SELECT from_id, to_id FROM messages WHERE image_id = ?').get(id);
  if (dm) return (dm.from_id === me || dm.to_id === me) && !blockedEither(dm.from_id, dm.to_id);
  const gm = db
    .prepare('SELECT m.from_id FROM group_messages m JOIN group_members g ON g.group_id = m.group_id AND g.user_id = ? WHERE m.image_id = ? AND m.created_at >= g.joined_at')
    .get(me, id);
  return !!gm && (gm.from_id === me || !blockedEither(gm.from_id, me));
}

// Reactions for a batch of messages, as the viewer should see them: [{ emoji, users: [ids] }] per message id.
// People the viewer has a block with (either way) are left out.
export function loadReactions(kind, ids, viewer) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = db
    .prepare(`SELECT message_id, emoji, user_id FROM reactions WHERE kind = ? AND message_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, user_id`)
    .all(kind, ...ids);
  for (const r of rows) {
    if (r.user_id !== viewer && blockedEither(viewer, r.user_id)) continue;
    const list = out.get(r.message_id) ?? [];
    let entry = list.find((x) => x.emoji === r.emoji);
    if (!entry) list.push((entry = { emoji: r.emoji, users: [] }));
    entry.users.push(r.user_id);
    out.set(r.message_id, list);
  }
  return out;
}

// Tap once to add your reaction, tap again to take it back. Returns true if it is now on.
export function toggleReaction(kind, messageId, userId, emoji) {
  const has = db.prepare('SELECT 1 FROM reactions WHERE kind = ? AND message_id = ? AND user_id = ? AND emoji = ?').get(kind, messageId, userId, emoji);
  if (has) {
    db.prepare('DELETE FROM reactions WHERE kind = ? AND message_id = ? AND user_id = ? AND emoji = ?').run(kind, messageId, userId, emoji);
    return false;
  }
  db.prepare('INSERT INTO reactions(kind, message_id, user_id, emoji, created_at) VALUES (?,?,?,?,?)').run(kind, messageId, userId, emoji, Date.now());
  return true;
}
