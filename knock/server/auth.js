import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';
import { db } from './db.js';
import { cfg, isProd } from './env.js';
import { dropSockets } from './realtime.js';
import { randomToken, sha256, hmac, safeEqual } from './util.js';

const SESSION_MS = 30 * 24 * 3600 * 1000;
const OTP_TTL = 10 * 60 * 1000;

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

/* ---------- accounts ---------- */
function makeHandle(base) {
  const slug = String(base || 'user').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12) || 'user';
  for (;;) {
    const handle = slug + crypto.randomInt(1000, 10000);
    if (!db.prepare('SELECT 1 FROM users WHERE handle = ?').get(handle)) return handle;
  }
}
function findOrCreateUser({ email, phone, googleSub, name }) {
  let u = null;
  if (googleSub) u = db.prepare('SELECT * FROM users WHERE google_sub = ?').get(googleSub);
  if (!u && email) u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u && phone) u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
  if (u) {
    if (googleSub && !u.google_sub) db.prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(googleSub, u.id);
    return u;
  }
  const display = (name || (email ? email.split('@')[0] : `Friend ${crypto.randomInt(1000, 10000)}`)).slice(0, 40);
  const info = db
    .prepare('INSERT INTO users(handle, display_name, signup_name, email, phone, google_sub, created_at) VALUES (?,?,?,?,?,?,?)')
    .run(makeHandle(display), display, display, email ?? null, phone ?? null, googleSub ?? null, Date.now());
  return db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
}

/* ---------- one-time codes (email + SMS) ---------- */
const mailer = process.env.SMTP_URL ? nodemailer.createTransport(process.env.SMTP_URL) : null;

async function deliver(channel, to, code) {
  const text = `Your Knock code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this message.`;
  if (channel === 'email' && mailer) {
    await mailer.sendMail({ from: process.env.MAIL_FROM, to, subject: 'Your Knock sign-in code', text });
  } else if (channel === 'email' && process.env.BREVO_API_KEY) {
    // Email over HTTPS (Brevo's API). Use this where outgoing SMTP ports are blocked, such as free hosting tiers.
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(process.env.MAIL_FROM || '');
    const sender = m ? { name: m[1].trim() || 'Knock', email: m[2].trim() } : { name: 'Knock', email: (process.env.MAIL_FROM || '').trim() };
    const r = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ sender, to: [{ email: to }], subject: 'Your Knock sign-in code', textContent: text }),
    });
    if (!r.ok) throw new Error(`Brevo responded ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } else if (channel === 'email' && process.env.EMAILJS_SERVICE_ID && process.env.EMAILJS_TEMPLATE_ID && process.env.EMAILJS_PUBLIC_KEY && process.env.EMAILJS_PRIVATE_KEY) {
    // Email through EmailJS's REST API (it sends via your own connected Gmail). Server-side only: the private key never reaches the browser.
    const r = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        service_id: process.env.EMAILJS_SERVICE_ID,
        template_id: process.env.EMAILJS_TEMPLATE_ID,
        user_id: process.env.EMAILJS_PUBLIC_KEY,
        accessToken: process.env.EMAILJS_PRIVATE_KEY,
        template_params: { to_email: to, code, message: text },
      }),
    });
    if (!r.ok) throw new Error(`EmailJS responded ${r.status}: ${(await r.text()).slice(0, 200)}`);
  } else if (channel === 'phone' && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM) {
    const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM: from } = process.env;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: to, From: from, Body: text }),
    });
    if (!r.ok) throw new Error(`Twilio responded ${r.status}`);
  } else if (!isProd) {
    console.log(`\n[dev] ${channel} sign-in code for ${to}: ${code}\n`); // no provider configured: print instead of sending
  } else {
    throw new Error(`No ${channel} provider configured`);
  }
}

function normalizeTarget(channel, value) {
  const v = String(value ?? '').trim();
  if (channel === 'email') {
    const e = v.toLowerCase();
    return e.length <= 254 && /^[^\s@]{1,64}@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
  }
  if (channel === 'phone') {
    const p = v.replace(/[\s().-]/g, '');
    return /^\+[1-9]\d{7,14}$/.test(p) ? p : null;
  }
  return null;
}

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false });
const google = new OAuth2Client();

export const auth = Router();

auth.get('/me', (req, res) => {
  const row = req.user && db.prepare('SELECT theme FROM users WHERE id = ?').get(req.user.id);
  let theme = null;
  try { theme = row?.theme ? JSON.parse(row.theme) : null; } catch { /* bad stored value: ignore */ }
  res.json({ user: req.user, theme });
});

// Shared by sign-in and by "change my email / phone". `key` is what the code is stored under (the target itself for
// sign-in, "chg:<user>:<channel>:<target>" for a change, so the two can never overwrite each other).
async function sendOtp(key, channel, to) {
  const prev = db.prepare('SELECT expires_at FROM otps WHERE target = ?').get(key);
  if (prev && prev.expires_at - OTP_TTL > Date.now() - 30_000) return 'wait_before_resend';
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('INSERT OR REPLACE INTO otps(target, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(
    key, hmac(cfg.cookieSecret, `${key}:${code}`), Date.now() + OTP_TTL,
  );
  try {
    await deliver(channel, to, code);
  } catch (err) {
    console.error('Code delivery failed:', err.message);
    return 'delivery_failed';
  }
  return null;
}
// Returns null when the code is right (and uses it up), otherwise the error code to send back.
function checkOtp(key, code) {
  const row = db.prepare('SELECT * FROM otps WHERE target = ?').get(key);
  if (!row || row.expires_at < Date.now() || row.attempts >= 5) return 'code_expired';
  db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE target = ?').run(key);
  if (!safeEqual(row.code_hash, hmac(cfg.cookieSecret, `${key}:${String(code ?? '').trim()}`))) return 'wrong_code';
  db.prepare('DELETE FROM otps WHERE target = ?').run(key);
  return null;
}
const FAIL_STATUS = { wait_before_resend: 429, delivery_failed: 502, code_expired: 400, wrong_code: 400 };

auth.post('/otp/request', authLimiter, async (req, res) => {
  const { channel } = req.body ?? {};
  const target = normalizeTarget(channel, req.body?.target);
  if (!target) return res.status(400).json({ error: 'invalid_target' });
  const fail = await sendOtp(target, channel, target);
  if (fail) return res.status(FAIL_STATUS[fail]).json({ error: fail });
  res.json({ ok: true }); // same response whether or not an account exists
});

auth.post('/otp/verify', authLimiter, (req, res) => {
  const { channel } = req.body ?? {};
  const target = normalizeTarget(channel, req.body?.target);
  const fail = target ? checkOtp(target, req.body?.code) : 'code_expired';
  if (fail) return res.status(FAIL_STATUS[fail]).json({ error: fail });
  const user = findOrCreateUser(channel === 'email' ? { email: target } : { phone: target });
  issueSession(res, user.id);
  res.json({ ok: true });
});

// "Continue with Google": the browser sends Google's signed ID token; we verify it server-side.
auth.post('/google', authLimiter, async (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) return res.status(501).json({ error: 'google_not_configured' });
  try {
    const ticket = await google.verifyIdToken({
      idToken: String(req.body?.credential ?? ''),
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const p = ticket.getPayload();
    const user = findOrCreateUser({
      googleSub: p.sub,
      email: p.email_verified && p.email ? p.email.toLowerCase() : null,
      name: p.name,
    });
    issueSession(res, user.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Google sign-in failed:', err.message); // shows the real reason in the server logs
    res.status(401).json({ error: 'google_failed' });
  }
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

/* ---------- change email / phone (the new one must be proven with a code sent to it) ---------- */
const changeKey = (uid, channel, target) => `chg:${uid}:${channel}:${target}`;
const takenBy = (channel, target, uid) =>
  !!db.prepare(`SELECT 1 FROM users WHERE ${channel === 'email' ? 'email' : 'phone'} = ? AND id != ?`).get(target, uid);

auth.post('/contact/request', requireUser, authLimiter, async (req, res) => {
  const { channel } = req.body ?? {};
  const target = normalizeTarget(channel, req.body?.target);
  if (!target) return res.status(400).json({ error: 'invalid_target' });
  const me = db.prepare('SELECT email, phone FROM users WHERE id = ?').get(req.user.id);
  if (me[channel] === target) return res.status(400).json({ error: 'same_as_current' });
  if (takenBy(channel, target, req.user.id)) return res.status(409).json({ error: 'already_in_use' });
  const fail = await sendOtp(changeKey(req.user.id, channel, target), channel, target);
  if (fail) return res.status(FAIL_STATUS[fail]).json({ error: fail });
  res.json({ ok: true });
});

auth.post('/contact/verify', requireUser, authLimiter, (req, res) => {
  const { channel } = req.body ?? {};
  const target = normalizeTarget(channel, req.body?.target);
  if (!target) return res.status(400).json({ error: 'invalid_target' });
  const fail = checkOtp(changeKey(req.user.id, channel, target), req.body?.code);
  if (fail) return res.status(FAIL_STATUS[fail]).json({ error: fail });
  try {
    db.prepare(`UPDATE users SET ${channel === 'email' ? 'email' : 'phone'} = ? WHERE id = ?`).run(target, req.user.id);
  } catch {
    return res.status(409).json({ error: 'already_in_use' }); // someone else verified it first
  }
  res.json({ ok: true, [channel]: target });
});

// Removing one is fine as long as another way to sign in is left.
auth.delete('/contact/:channel', requireUser, (req, res) => {
  const channel = req.params.channel;
  if (channel !== 'email' && channel !== 'phone') return res.status(400).json({ error: 'invalid_target' });
  const u = db.prepare('SELECT email, phone, google_sub FROM users WHERE id = ?').get(req.user.id);
  const other = channel === 'email' ? u.phone : u.email;
  if (!other && !u.google_sub) return res.status(400).json({ error: 'last_sign_in_method' });
  db.prepare(`UPDATE users SET ${channel} = NULL WHERE id = ?`).run(req.user.id);
  res.json({ ok: true });
});

// "Sign out of other devices": ends every login for this account except the one making the request.
auth.post('/signout-others', requireUser, (req, res) => {
  db.prepare('DELETE FROM push_subscriptions WHERE user_id = ? AND session_hash != ?').run(req.user.id, sha256(req.cookies.sid));
  const info = db.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, sha256(req.cookies.sid));
  dropSockets(req.user.id, (sid) => sid !== req.cookies.sid);
  res.json({ ok: true, signedOut: Number(info.changes) });
});
