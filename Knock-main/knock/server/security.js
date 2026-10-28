import { isProd } from './env.js';

const HUMAN_MS = 12 * 3600 * 1000;

// The "human" cookie is signed by cookie-parser (HMAC with COOKIE_SECRET) and holds the time of verification.
export function setHumanCookie(res) {
  res.cookie('human', String(Date.now()), {
    signed: true, httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: HUMAN_MS, path: '/',
  });
}
export function isHuman(value) {
  const t = Number(value);
  return Number.isFinite(t) && t <= Date.now() + 1000 && Date.now() - t < HUMAN_MS;
}
export const humanApi = (req, res, next) =>
  isHuman(req.signedCookies.human) ? next() : res.status(403).json({ error: 'captcha_required' });
export const humanPage = (req, res, next) =>
  isHuman(req.signedCookies.human) ? next() : res.redirect('/verify?next=' + encodeURIComponent(req.originalUrl));

// Server-to-server check with Google. The secret never leaves the server.
export async function verifyCaptcha(token, ip) {
  const secret = process.env.RECAPTCHA_SECRET;
  if (!secret) return !isProd; // development convenience only; production refuses to boot without keys
  if (!token || typeof token !== 'string') return false;
  try {
    const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response: token, remoteip: ip || '' }),
    });
    return (await r.json()).success === true;
  } catch {
    return false;
  }
}

// Blocks cross-site state-changing requests (CSRF). Cookies are also SameSite=Lax and the API only accepts JSON.
export function originGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) return res.status(403).json({ error: 'bad_origin' });
    } catch {
      return res.status(403).json({ error: 'bad_origin' });
    }
  }
  next();
}
