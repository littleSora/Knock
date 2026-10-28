import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import crypto from 'node:crypto';
import { db } from './db.js';
import { isProd } from './env.js';
import { dropSockets } from './realtime.js';
import { supabaseEnabled, authClient, adminAuth, findAuthUserByEmail, saveNewAccount, syncAccount } from './supabase.js';
import { randomToken, sha256, cleanName } from './util.js';

// Passwords, email codes and "is this really your email" are all done by Supabase Auth. Knock never sees a stored password.
// What Knock keeps itself is the app side: a profile row per person (id, @handle, name...) and the login cookie below.
const SESSION_MS = 30 * 24 * 3600 * 1000;

/* ---------- login sessions (opaque random token in an httpOnly cookie; only its hash is stored) ---------- */
function issueSession(res, userId) {
  const token = randomToken();
  db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + SESSION_MS);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: SESSION_MS, path: '/' });
}
export function userFromToken(token) {
  if (!token) return null;
  return (
    db
      .prepare(
        `SELECT u.id, u.handle, u.display_name,
           (SELECT updated_at FROM avatars a WHERE a.user_id = u.id) AS avatar_at
         FROM auth_sessions s
         JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(token), Date.now()) || null
  );
}
export const attachUser = (req, _res, next) => {
  req.user = userFromToken(req.cookies.sid);
  next();
};
export const requireUser = (req, res, next) => (req.user ? next() : res.status(401).json({ error: 'login_required' }));

const goodPassword = (pw, email) => typeof pw === 'string' && pw.length >= 8 && pw.length <= 128 && pw.toLowerCase() !== email;

// 5 wrong passwords for one email within 15 minutes locks that email for 30 minutes (a successful password reset lifts it).
const MAX_TRIES = 5, TRY_WINDOW = 15 * 60 * 1000, LOCK_MS = 30 * 60 * 1000;
const failures = new Map(); // email -> { n, first, lockUntil }
const lockedFor = (email) => Math.max(0, Math.ceil(((failures.get(email)?.lockUntil ?? 0) - Date.now()) / 1000)); // seconds left, 0 if not locked
function noteFailure(email) {
  let f = failures.get(email);
  if (!f || (!f.lockUntil && f.first + TRY_WINDOW < Date.now()) || (f.lockUntil && f.lockUntil < Date.now())) {
    f = { n: 0, first: Date.now(), lockUntil: 0 };
    failures.set(email, f);
  }
  if (++f.n >= MAX_TRIES) f.lockUntil = Date.now() + LOCK_MS;
  return MAX_TRIES - f.n; // tries left before the lock (0 = locked now)
}
setInterval(() => { for (const [k, f] of failures) if (Math.max(f.first + TRY_WINDOW, f.lockUntil) < Date.now()) failures.delete(k); }, 600_000).unref();

/* ---------- accounts (the Knock side: a profile row linked to the Supabase Auth user by auth_uid) ---------- */
function makeHandle(base) {
  const slug = String(base || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
  for (;;) {
    const handle = slug + crypto.randomInt(1000, 10000);
    if (!db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return handle;
  }
}
// Makes sure a Supabase Auth user has its Knock profile, and returns the Knock user id. Safe to call again for the same person.
// It is how a sign-up finishes, and also how a login repairs an account whose profile did not get saved the first time.
async function ensureProfile(authUser) {
  const existing = db.prepare('SELECT id FROM users WHERE auth_uid = ?').get(authUser.id);
  if (existing) return existing.id;
  const email = normalizeEmail(authUser.email);
  if (!email || db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw Object.assign(new Error('email already has a profile'), { emailTaken: true });
  const name = cleanName(authUser.user_metadata?.name, 40) || cleanName(email.split('@')[0], 40) || 'Knock user';
  const info = db
    .prepare('INSERT INTO users(handle, display_name, signup_name, email, auth_uid, created_at) VALUES (?,?,?,?,?,?)')
    .run(makeHandle(name), name, name, email, authUser.id, Date.now());
  const id = Number(info.lastInsertRowid);
  try {
    await saveNewAccount(id); // the account counts only once it is saved in Supabase; if not, undo it so it can be tried again
  } catch (err) {
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    throw err;
  }
  return id;
}

function normalizeEmail(value) {
  const e = String(value ?? '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

// Turns a Supabase Auth error into one of Knock's own error codes (the page has a message for each).
function authFail(res, err) {
  const c = err?.code;
  if (c === 'over_email_send_rate_limit' || c === 'over_request_rate_limit' || c === 'over_sms_send_rate_limit' || err?.status === 429) {
    return res.status(429).json({ error: 'wait_before_resend', retry_after: 60 });
  }
  if (c === 'otp_expired' || c === 'otp_disabled') return res.status(400).json({ error: 'bad_code' });
  if (c === 'email_address_invalid') return res.status(400).json({ error: 'invalid_email' });
  if (c === 'weak_password') return res.status(400).json({ error: 'weak_password' });
  if (c === 'user_already_exists' || c === 'email_exists') return res.status(409).json({ error: 'email_taken' });
  if (c === 'email_not_confirmed') return res.status(401).json({ error: 'email_not_confirmed' });
  const hint = /sending.*email|smtp/i.test(err?.message || '') ? ' -> Supabase could not send the email: set up custom SMTP (Authentication -> Emails -> SMTP Settings), see supabase/email-templates.md'
    : /api key|jwt/i.test(err?.message || '') ? ' -> SUPABASE_SERVICE_ROLE_KEY is wrong or cut off'
    : /fetch failed|abort|ENOTFOUND/i.test(err?.message || '') ? ' -> cannot reach Supabase: check SUPABASE_URL' : '';
  console.error('Supabase Auth error:', c || '', err?.status || '', err?.message || err, hint);
  return res.status(502).json({ error: 'auth_unavailable' });
}
const needSupabase = (_req, res, next) => (supabaseEnabled ? next() : res.status(503).json({ error: 'auth_unavailable' }));
const profileFail = (res, err) => {
  if (err?.emailTaken) return res.status(409).json({ error: 'email_taken' });
  console.error('Saving the account failed:', err?.message || err);
  return res.status(502).json({ error: 'storage_failed' });
};

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

export const auth = Router();

auth.get('/me', (req, res) => {
  const row = req.user && db.prepare('SELECT theme FROM users WHERE id = ?').get(req.user.id);
  let theme = null;
  try { theme = row?.theme ? JSON.parse(row.theme) : null; } catch { /* bad stored value: ignore */ }
  res.json({ user: req.user, theme });
});

const endSessions = (userId) => {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  dropSockets(userId, () => true);
};
// A Knock account made before Supabase Auth has no Supabase user yet. This makes one (already confirmed, since the person was
// let in before) and links it, so "Forgot password" / "Set a password" can finish the move.
async function linkLegacy(local, email, password = randomToken()) {
  let { data, error } = await adminAuth().createUser({ email, password, email_confirm: true });
  let uid = data?.user?.id;
  if (error && (error.code === 'email_exists' || error.code === 'user_already_exists')) {
    uid = (await findAuthUserByEmail(email))?.id; // it already exists in Supabase: link to that one
    error = uid ? null : error;
  }
  if (error) throw error;
  db.prepare('UPDATE users SET auth_uid = ? WHERE id = ?').run(uid, local.id);
  syncAccount(local.id);
  return uid;
}

/* ---------- create an account: details -> Supabase emails a code -> the account exists once the code is right ---------- */
auth.post('/signup/request', authLimiter, needSupabase, async (req, res) => {
  const name = cleanName(req.body?.name, 40);
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  if (!email) return res.status(400).json({ error: 'invalid_email' });
  if (!goodPassword(password, email)) return res.status(400).json({ error: 'weak_password' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'email_taken' });
  const { data, error } = await authClient().signUp({ email, password, options: { data: { name } } });
  if (error) return authFail(res, error);
  // With "Confirm email" on, Supabase answers an already-registered address with a user that has no identities (it never says so outright).
  // That person has a Supabase account but no Knock profile yet (it failed to save once): logging in finishes it.
  if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) return res.status(409).json({ error: 'email_taken' });
  if (data.session) {
    // "Confirm email" is switched off in Supabase: the account is ready straight away and there is no code to enter.
    try { issueSession(res, await ensureProfile(data.user)); } catch (err) { return profileFail(res, err); }
    return res.json({ ok: true, done: true });
  }
  res.json({ ok: true });
});

auth.post('/signup/verify', authLimiter, needSupabase, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = String(req.body?.code ?? '').trim();
  if (!email || !/^\d{6,10}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
  const { data, error } = await authClient().verifyOtp({ email, token: code, type: 'signup' });
  if (error) return authFail(res, error);
  try {
    issueSession(res, await ensureProfile(data.user));
  } catch (err) {
    return profileFail(res, err); // the email is confirmed in Supabase by now, so the person can simply log in to finish
  }
  res.json({ ok: true });
});

/* ---------- log in: only an account that exists, with its password ---------- */
auth.post('/login', authLimiter, needSupabase, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || password.length > 128) return res.status(401).json({ error: 'wrong_credentials' });
  if (lockedFor(email)) return res.status(429).json({ error: 'too_many_attempts', retry_after: lockedFor(email) });
  const local = db.prepare('SELECT id, auth_uid FROM users WHERE email = ?').get(email);
  if (local && !local.auth_uid) return res.status(401).json({ error: 'no_password_set' }); // an older account made before Supabase Auth
  const { data, error } = await authClient().signInWithPassword({ email, password });
  if (error) {
    if (error.code !== 'invalid_credentials') return authFail(res, error);
    const left = noteFailure(email); // counted the same whether or not the account exists, so this reveals nothing
    if (left <= 0) return res.status(429).json({ error: 'too_many_attempts', retry_after: lockedFor(email) });
    return res.status(401).json({ error: 'wrong_credentials', attempts_left: left }); // same answer for "no such account" and "wrong password"
  }
  let userId;
  try { userId = await ensureProfile(data.user); } catch (err) { return profileFail(res, err); }
  failures.delete(email);
  issueSession(res, userId);
  res.json({ ok: true });
});

/* ---------- forgot password (also how an older account without Supabase login sets its first password) ---------- */
auth.post('/reset/request', authLimiter, needSupabase, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'invalid_email' });
  const local = db.prepare('SELECT id, auth_uid FROM users WHERE email = ?').get(email);
  if (!local) return res.status(404).json({ error: 'no_account' }); // nothing is emailed to an address that has no Knock account
  try {
    if (!local.auth_uid) await linkLegacy(local, email);
  } catch (err) { return authFail(res, err); }
  const { error } = await authClient().resetPasswordForEmail(email);
  if (error) return authFail(res, error);
  res.json({ ok: true });
});

auth.post('/reset/verify', authLimiter, needSupabase, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || !goodPassword(password, email)) return res.status(400).json({ error: 'weak_password' });
  const code = String(req.body?.code ?? '').trim();
  const local = db.prepare('SELECT id, auth_uid FROM users WHERE email = ?').get(email);
  if (!local?.auth_uid || !/^\d{6,10}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
  const { data, error } = await authClient().verifyOtp({ email, token: code, type: 'recovery' });
  if (error) return authFail(res, error);
  if (data.user?.id !== local.auth_uid) return res.status(400).json({ error: 'bad_code' });
  const { error: setErr } = await adminAuth().updateUserById(local.auth_uid, { password });
  if (setErr) return authFail(res, setErr);
  endSessions(local.id); // anyone logged in with the old password is signed out
  failures.delete(email);
  issueSession(res, local.id);
  res.json({ ok: true });
});

/* ---------- change password while logged in ---------- */
auth.post('/password', requireUser, authLimiter, needSupabase, async (req, res) => {
  const row = db.prepare('SELECT id, email, auth_uid FROM users WHERE id = ?').get(req.user.id);
  const password = req.body?.password;
  if (row.auth_uid) {
    const { error } = await authClient().signInWithPassword({ email: row.email, password: String(req.body?.current ?? '').slice(0, 128) });
    if (error) return error.code === 'invalid_credentials' ? res.status(400).json({ error: 'wrong_password' }) : authFail(res, error);
  }
  if (!goodPassword(password, row.email)) return res.status(400).json({ error: 'weak_password' });
  try {
    if (row.auth_uid) {
      const { error } = await adminAuth().updateUserById(row.auth_uid, { password });
      if (error) throw error;
    } else {
      await linkLegacy(row, row.email, password); // an older account choosing its first password
    }
  } catch (err) { return authFail(res, err); }
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND session_hash != ?').run(req.user.id, sha256(req.cookies.sid));
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha256(req.cookies.sid)); // other devices must log in again
  dropSockets(req.user.id, (sid) => sid !== req.cookies.sid);
  res.json({ ok: true });
});

auth.post('/logout', (req, res) => {
  if (req.user) dropSockets(req.user.id, (sid) => sid === req.cookies.sid);
  if (req.cookies.sid) {
    db.prepare('DELETE FROM push_subscriptions WHERE session_hash = ?').run(sha256(req.cookies.sid)); // no more pushes to a browser that logged out
    db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(req.cookies.sid));
  }
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

/* ---------- change email (the new address must be proven with a code sent to it by Supabase) ---------- */
auth.post('/contact/request', requireUser, authLimiter, needSupabase, async (req, res) => {
  const target = normalizeEmail(req.body?.target);
  if (!target) return res.status(400).json({ error: 'invalid_email' });
  const me = db.prepare('SELECT email, auth_uid FROM users WHERE id = ?').get(req.user.id);
  if (me.email === target) return res.status(400).json({ error: 'same_as_current' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(target, req.user.id)) return res.status(409).json({ error: 'already_in_use' });
  if (!me.auth_uid) return res.status(400).json({ error: 'no_password_set' }); // set a password first (that moves the account to Supabase)
  try {
    // Supabase only changes an email for a signed-in person, so sign them in quietly (no email is sent for this step).
    const { data: link, error: linkErr } = await adminAuth().generateLink({ type: 'magiclink', email: me.email });
    if (linkErr) throw linkErr;
    const sb = authClient();
    const { error: inErr } = await sb.verifyOtp({ token_hash: link.properties.hashed_token, type: 'email' });
    if (inErr) throw inErr;
    const { error } = await sb.updateUser({ email: target }); // Supabase emails the code to the new address
    if (error) throw error;
  } catch (err) {
    if (err?.code === 'email_exists') return res.status(409).json({ error: 'already_in_use' });
    return authFail(res, err);
  }
  res.json({ ok: true });
});

auth.post('/contact/verify', requireUser, authLimiter, needSupabase, async (req, res) => {
  const target = normalizeEmail(req.body?.target);
  const code = String(req.body?.code ?? '').trim();
  if (!target) return res.status(400).json({ error: 'invalid_email' });
  const me = db.prepare('SELECT auth_uid FROM users WHERE id = ?').get(req.user.id);
  if (!me?.auth_uid || !/^\d{6,10}$/.test(code)) return res.status(400).json({ error: 'bad_code' });
  const { data, error } = await authClient().verifyOtp({ email: target, token: code, type: 'email_change' });
  if (error) return authFail(res, error);
  // If "Secure email change" is on in Supabase, a second code goes to the old address and the change is not finished yet.
  if (data.user?.id !== me.auth_uid || normalizeEmail(data.user?.email) !== target) return res.status(400).json({ error: 'bad_code' });
  try {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(target, req.user.id);
  } catch {
    return res.status(409).json({ error: 'already_in_use' }); // someone else verified it first
  }
  syncAccount(req.user.id);
  res.json({ ok: true, email: target });
});

// "Sign out of other devices": ends every login for this account except the one making the request.
auth.post('/signout-others', requireUser, (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND session_hash != ?').run(req.user.id, sha256(req.cookies.sid));
  const info = db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha256(req.cookies.sid));
  dropSockets(req.user.id, (sid) => sid !== req.cookies.sid);
  res.json({ ok: true, signedOut: Number(info.changes) });
});
