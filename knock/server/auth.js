import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';
import { cfg, isProd } from './env.js';
import { dropSockets } from './realtime.js';
import { randomToken, sha256, hmac, safeEqual, cleanName } from './util.js';

const SESSION_MS = 30 * 24 * 3600 * 1000;
const OTP_TTL = 10 * 60 * 1000;
const RESEND_WAIT = 90 * 1000; // a new code can be asked for once every 1 minute 30 seconds
const scrypt = promisify(crypto.scrypt);

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

/* ---------- passwords: scrypt with a random salt per account; only the hash is stored ---------- */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}
async function verifyPassword(password, stored) {
  const [v, salt, key] = String(stored).split('$');
  if (v !== 's1' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}
const DUMMY_HASH = hashPassword('not-a-real-password'); // checked when an email isn't registered, so timing doesn't reveal it
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

/* ---------- accounts ---------- */
function makeHandle(base) {
  const slug = String(base || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
  for (;;) {
    const handle = slug + crypto.randomInt(1000, 10000);
    if (!db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return handle;
  }
}
function createUser({ email, name, pwHash }) {
  const info = db
    .prepare('INSERT INTO users(handle, display_name, signup_name, email, password_hash, created_at) VALUES (?,?,?,?,?,?)')
    .run(makeHandle(name), name, name, email, pwHash, Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

/* ---------- one-time codes, sent by email (verify a new account, reset a password, change email) ---------- */
const mailer = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

const MAIL = {
  verify: { subject: 'Your Knock verification code', text: (code) => `Your Knock code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this message.` },
  reset: { subject: 'Reset your Knock password', text: (code) => `Your Knock password reset code is ${code}. It expires in 10 minutes. If you didn't ask to reset your password, ignore this message and your password stays the same.` },
};

// kind: 'verify' (new account, change email) or 'reset' (forgot password). extra: more EmailJS template variables (name, reset_link).
async function deliver(to, code, kind = 'verify', extra = {}) {
  const { subject } = MAIL[kind];
  const text = MAIL[kind].text(code);
  // A reset can use its own EmailJS template (EMAILJS_RESET_TEMPLATE_ID); without one it falls back to the general template.
  const templateId = (kind === 'reset' && process.env.EMAILJS_RESET_TEMPLATE_ID) || process.env.EMAILJS_TEMPLATE_ID;
  if (mailer) {
    await mailer.sendMail({ from: process.env.MAIL_FROM, to, subject, text });
  } else if (process.env.BREVO_API_KEY) {
    // Email over HTTPS (Brevo's API). Use this where outgoing SMTP ports are blocked, such as free hosting tiers.
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(process.env.MAIL_FROM || '');
    const sender = m ? { name: m[1].trim() || 'Knock', email: m[2].trim() } : { name: 'Knock', email: (process.env.MAIL_FROM || '').trim() };
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject, textContent: text }),
    });
    if (!r.ok) throw new Error(`Brevo responded ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } else if (process.env.EMAILJS_SERVICE_ID && templateId && process.env.EMAILJS_PUBLIC_KEY && process.env.EMAILJS_PRIVATE_KEY) {
    // Email through EmailJS's REST API (it sends via your own connected Gmail). Server-side only: the private key never reaches the browser.
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: templateId,
        user_id: process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: { to_email: to, code, message: text, subject, kind, app_name: 'Knock', expires_in: '10 minutes', name: '', reset_link: cfg.publicUrl + '/login', ...extra },
      }),
    });
    if (!r.ok) throw new Error(`EmailJS responded ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } else if (!isProd) {
    console.log(`\n[dev] ${kind === 'reset' ? 'password reset' : 'email'} code for ${to}: ${code}\n`); // no email provider configured: print instead of sending
  } else {
    throw new Error('No email provider configured');
  }
}

function normalizeEmail(value) {
  const e = String(value ?? '').trim().toLowerCase();
  return e.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false });

export const auth = Router();

auth.get('/me', (req, res) => {
  const row = req.user && db.prepare('SELECT theme FROM users WHERE id = ?').get(req.user.id);
  let theme = null;
  try { theme = row?.theme ? JSON.parse(row.theme) : null; } catch { /* bad stored value: ignore */ }
  res.json({ user: req.user, theme });
});

// `key` is what the code is stored under: "signup:<email>", "reset:<email>" or "chg:<user>:email:<email>", so the flows can never overwrite each other.
async function sendOtp(key, to, kind = 'verify', extra = {}) {
  const prev = db.prepare('SELECT expires_at FROM otps WHERE target = ?').get(key);
  const waitMs = prev ? prev.expires_at - OTP_TTL + RESEND_WAIT - Date.now() : 0; // time left before another code may be sent
  if (waitMs > 0) return { error: 'wait_before_resend', retry_after: Math.ceil(waitMs / 1000) };
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('INSERT OR REPLACE INTO otps(target, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(
    key, hmac(cfg.cookieSecret, `${key}:${code}`), Date.now() + OTP_TTL,
  );
  try {
    await deliver(to, code, kind, extra);
  } catch (err) {
    console.error('Code delivery failed:', err.message);
    return 'delivery_failed';
  }
  return null;
}
// Returns null when the code is right (and uses it up), otherwise the error code to send back.
const OTP_TRIES = 5;
// limited=false (forgot password): any number of wrong guesses is allowed until the code expires.
function checkOtp(key, code, limited = true) {
  const row = db.prepare('SELECT * FROM otps WHERE target = ?').get(key);
  if (!row || row.expires_at < Date.now()) return 'code_expired';
  if (limited && row.attempts >= OTP_TRIES) return 'too_many_codes'; // 5 wrong tries use the code up; the person must ask for a new one
  db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE target = ?').run(key);
  if (!safeEqual(row.code_hash, hmac(cfg.cookieSecret, `${key}:${String(code ?? '').trim()}`))) {
    return limited ? { error: 'wrong_code', attempts_left: OTP_TRIES - row.attempts - 1 } : 'wrong_code';
  }
  db.prepare('DELETE FROM otps WHERE target = ?').run(key);
  return null;
}
const FAIL_STATUS = { wait_before_resend: 429, delivery_failed: 502, code_expired: 400, too_many_codes: 429, wrong_code: 400 };
// A failure is either a code string or { error, ...extra }.
const sendFail = (res, fail) => {
  const body = typeof fail === 'string' ? { error: fail } : fail;
  return res.status(FAIL_STATUS[body.error]).json(body);
};
const endSessions = (userId) => {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ?').run(userId);
  db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(userId);
  dropSockets(userId, () => true);
};

/* ---------- create an account: details -> code emailed -> the account exists only once the code is right ---------- */
auth.post('/signup/request', authLimiter, async (req, res) => {
  const name = cleanName(req.body?.name, 40);
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!name) return res.status(400).json({ error: 'invalid_name' });
  if (!email) return res.status(400).json({ error: 'invalid_email' });
  if (!goodPassword(password, email)) return res.status(400).json({ error: 'weak_password' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'email_taken' });
  db.prepare('INSERT OR REPLACE INTO pending_signups(email, name, pw_hash, expires_at) VALUES (?,?,?,?)').run(
    email, name, await hashPassword(password), Date.now() + OTP_TTL,
  );
  const fail = await sendOtp(`signup:${email}`, email);
  if (fail) return sendFail(res, fail);
  res.json({ ok: true });
});

auth.post('/signup/verify', authLimiter, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const pending = email && db.prepare('SELECT * FROM pending_signups WHERE email = ?').get(email);
  if (!pending || pending.expires_at < Date.now()) return res.status(400).json({ error: 'code_expired' });
  const fail = checkOtp(`signup:${email}`, req.body?.code);
  if (fail) return sendFail(res, fail);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return res.status(409).json({ error: 'email_taken' });
  const user = createUser({ email, name: pending.name, pwHash: pending.pw_hash });
  db.prepare('DELETE FROM pending_signups WHERE email = ?').run(email);
  issueSession(res, user.id);
  res.json({ ok: true });
});

/* ---------- log in: only an account that exists, with its password ---------- */
auth.post('/login', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!email || !password || password.length > 128) return res.status(401).json({ error: 'wrong_credentials' });
  if (lockedFor(email)) return res.status(429).json({ error: 'too_many_attempts', retry_after: lockedFor(email) });
  const user = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);
  const ok = await verifyPassword(password, user?.password_hash ?? (await DUMMY_HASH));
  if (user && !user.password_hash) return res.status(401).json({ error: 'no_password_set' }); // an older account made before passwords existed
  if (!user || !ok) {
    const left = noteFailure(email); // counted the same whether or not the account exists, so this reveals nothing
    if (left <= 0) return res.status(429).json({ error: 'too_many_attempts', retry_after: lockedFor(email) });
    return res.status(401).json({ error: 'wrong_credentials', attempts_left: left }); // same answer for "no such account" and "wrong password"
  }
  failures.delete(email);
  issueSession(res, user.id);
  res.json({ ok: true });
});

/* ---------- forgot password (also how an older account without a password sets one) ---------- */
auth.post('/reset/request', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'invalid_email' });
  const account = db.prepare('SELECT display_name FROM users WHERE email = ?').get(email);
  if (!account) return res.status(404).json({ error: 'no_account' }); // nothing is emailed to an address that has no Knock account
  const fail = await sendOtp(`reset:${email}`, email, 'reset', {
    name: account.display_name || '',
    reset_link: `${cfg.publicUrl}/login?mode=reset&email=${encodeURIComponent(email)}`, // opens the "enter code + new password" step with the email filled in
  });
  if (fail) return sendFail(res, fail);
  res.json({ ok: true });
});

auth.post('/reset/verify', authLimiter, async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!email || !goodPassword(password, email)) return res.status(400).json({ error: 'weak_password' });
  const user = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  const fail = user ? checkOtp(`reset:${email}`, req.body?.code, false) : 'code_expired';
  if (fail) return sendFail(res, fail);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  endSessions(user.id); // anyone logged in with the old password is signed out
  failures.delete(email);
  issueSession(res, user.id);
  res.json({ ok: true });
});

/* ---------- change password while logged in ---------- */
auth.post('/password', requireUser, authLimiter, async (req, res) => {
  const row = db.prepare('SELECT email, password_hash FROM users WHERE id = ?').get(req.user.id);
  if (row.password_hash && !(await verifyPassword(String(req.body?.current ?? ''), row.password_hash))) {
    return res.status(400).json({ error: 'wrong_password' });
  }
  if (!goodPassword(req.body?.password, row.email)) return res.status(400).json({ error: 'weak_password' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), req.user.id);
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

/* ---------- change email (the new address must be proven with a code sent to it) ---------- */
const changeKey = (uid, target) => `chg:${uid}:email:${target}`;

auth.post('/contact/request', requireUser, authLimiter, async (req, res) => {
  const target = normalizeEmail(req.body?.target);
  if (!target) return res.status(400).json({ error: 'invalid_email' });
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id);
  if (me.email === target) return res.status(400).json({ error: 'same_as_current' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(target, req.user.id)) return res.status(409).json({ error: 'already_in_use' });
  const fail = await sendOtp(changeKey(req.user.id, target), target);
  if (fail) return sendFail(res, fail);
  res.json({ ok: true });
});

auth.post('/contact/verify', requireUser, authLimiter, (req, res) => {
  const target = normalizeEmail(req.body?.target);
  if (!target) return res.status(400).json({ error: 'invalid_email' });
  const fail = checkOtp(changeKey(req.user.id, target), req.body?.code);
  if (fail) return sendFail(res, fail);
  try {
    db.prepare('UPDATE users SET email = ? WHERE id = ?').run(target, req.user.id);
  } catch {
    return res.status(409).json({ error: 'already_in_use' }); // someone else verified it first
  }
  res.json({ ok: true, email: target });
});

// "Sign out of other devices": ends every login for this account except the one making the request.
auth.post('/signout-others', requireUser, (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND session_hash != ?').run(req.user.id, sha256(req.cookies.sid));
  const info = db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha256(req.cookies.sid));
  dropSockets(req.user.id, (sid) => sid !== req.cookies.sid);
  res.json({ ok: true, signedOut: Number(info.changes) });
});
