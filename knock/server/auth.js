import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import nodemailer from 'nodemailer';
import { OAuth2Client } from 'google-auth-library';
import crypto from 'node:crypto';
import { db } from './db.js';
import { cfg, isProd } from './env.js';
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

auth.get('/me', (req, res) => res.json({ user: req.user }));

auth.post('/otp/request', authLimiter, async (req, res) => {
  const { channel } = req.body ?? {};
  const target = normalizeTarget(channel, req.body?.target);
  if (!target) return res.status(400).json({ error: 'invalid_target' });
  const prev = db.prepare('SELECT expires_at FROM otps WHERE target = ?').get(target);
  if (prev && prev.expires_at - OTP_TTL > Date.now() - 30_000) return res.status(429).json({ error: 'wait_before_resend' });
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  db.prepare('INSERT OR REPLACE INTO otps(target, code_hash, expires_at, attempts) VALUES (?,?,?,0)').run(
    target, hmac(cfg.cookieSecret, `${target}:${code}`), Date.now() + OTP_TTL,
  );
  try {
    await deliver(channel, target, code);
  } catch (err) {
    console.error('Code delivery failed:', err.message);
    return res.status(502).json({ error: 'delivery_failed' });
  }
  res.json({ ok: true }); // same response whether or not an account exists
});

auth.post('/otp/verify', authLimiter, (req, res) => {
  const { channel } = req.body ?? {};
  const target = normalizeTarget(channel, req.body?.target);
  const row = target && db.prepare('SELECT * FROM otps WHERE target = ?').get(target);
  if (!row || row.expires_at < Date.now() || row.attempts >= 5) return res.status(400).json({ error: 'code_expired' });
  db.prepare('UPDATE otps SET attempts = attempts + 1 WHERE target = ?').run(target);
  const guess = hmac(cfg.cookieSecret, `${target}:${String(req.body?.code ?? '').trim()}`);
  if (!safeEqual(row.code_hash, guess)) return res.status(400).json({ error: 'wrong_code' });
  db.prepare('DELETE FROM otps WHERE target = ?').run(target);
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
  } catch {
    res.status(401).json({ error: 'google_failed' });
  }
});

auth.post('/logout', (req, res) => {
  if (req.cookies.sid) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(sha256(req.cookies.sid));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});
