// Loads .env and validates configuration. Import this first, before anything that reads process.env.
try { process.loadEnvFile(); } catch { /* no .env file: real environment variables are used */ }

const e = process.env;
export const isProd = e.NODE_ENV === 'production';

if (isProd) {
  const missing = ['COOKIE_SECRET', 'RECAPTCHA_SITE_KEY', 'RECAPTCHA_SECRET'].filter((k) => !e[k]);
  if (missing.length) throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  if (e.COOKIE_SECRET.length < 32) throw new Error('COOKIE_SECRET must be at least 32 characters');
}

export const cfg = {
  port: Number(e.PORT) || 3000,
  // Used for the link in emails. Set PUBLIC_URL on your host (no trailing slash).
  publicUrl: (e.PUBLIC_URL || (isProd ? 'https://knock-0rsz.onrender.com' : `http://localhost:${Number(e.PORT) || 3000}`)).replace(/\/+$/, ''),
  cookieSecret: e.COOKIE_SECRET || 'dev-only-secret-do-not-use-in-production',
  trustProxy: /^\d+$/.test(e.TRUST_PROXY || '') ? Number(e.TRUST_PROXY) : e.TRUST_PROXY || false,
};
