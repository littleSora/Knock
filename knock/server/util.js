import crypto from 'node:crypto';

// 32 characters (no l, o, 0, 1 look-alikes) so `byte & 31` is unbiased. 32^10 is about 1.1e15 codes.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const SESSION_LEN = 10;
const SESSION_RE = new RegExp(`^[${ALPHABET}]{${SESSION_LEN}}$`);

export const newSessionId = () => Array.from(crypto.randomBytes(SESSION_LEN), (b) => ALPHABET[b & 31]).join('');
export const normalizeSessionId = (s) => String(s ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
export const isSessionId = (s) => SESSION_RE.test(s);

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
export const randomToken = () => crypto.randomBytes(32).toString('base64url');
export const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Defense in depth: the client renders everything with textContent, but we also strip markup/control characters.
export const cleanName = (s, max) =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
export const cleanBody = (s, max) =>
  String(s ?? '').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, '').trim().slice(0, max);
