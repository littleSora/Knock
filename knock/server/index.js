import './env.js'; // must be first: loads .env before other modules read it
import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cfg, isProd } from './env.js';
import { purgeExpired } from './db.js';
import { humanApi, humanPage, originGuard, setHumanCookie, verifyCaptcha } from './security.js';
import { auth, attachUser } from './auth.js';
import { api } from './api.js';
import { attachRealtime } from './realtime.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
app.disable('x-powered-by');
if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

app.use(
  helmet({
    crossOriginEmbedderPolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'script-src': ["'self'", 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
        'frame-src': ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'],
        'connect-src': ["'self'"],
        'img-src': ["'self'", 'data:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        'font-src': ["'self'", 'https://fonts.gstatic.com'],
        'media-src': ["'self'", 'blob:'],
        ...(isProd ? {} : { 'upgrade-insecure-requests': null }),
      },
    },
  }),
);
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser(cfg.cookieSecret));
app.use(originGuard);
app.use('/assets', express.static(path.join(root, 'public'), { maxAge: isProd ? '1h' : 0 }));
// The notification service worker has to be served from the site root to be allowed to control every page. It holds no secrets.
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript').sendFile(path.join(root, 'public', 'sw.js'));
});

/* ---------- API: global rate limit, then the human check, then login lookup ---------- */
app.use('/api', rateLimit({ windowMs: 60_000, limit: 300, standardHeaders: 'draft-7', legacyHeaders: false }));

app.get('/api/captcha/site-key', (_req, res) =>
  res.json({ siteKey: process.env.RECAPTCHA_SITE_KEY || null, bypass: !process.env.RECAPTCHA_SECRET }),
);
app.post(
  '/api/captcha',
  rateLimit({ windowMs: 10 * 60_000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false }),
  async (req, res) => {
    if (!(await verifyCaptcha(req.body?.token, req.ip))) return res.status(400).json({ error: 'captcha_failed' });
    setHumanCookie(res);
    res.json({ ok: true });
  },
);

app.use('/api', humanApi, attachUser);
app.use('/api/auth', auth);
app.use('/api', api);
app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));

/* ---------- pages ---------- */
const view = (name) => (_req, res) => res.sendFile(path.join(root, 'views', name));
const needLogin = (req, res, next) => (req.user ? next() : res.redirect('/login?next=' + encodeURIComponent(req.originalUrl)));

app.get('/verify', view('verify.html')); // the only page reachable before the human check
app.get('/', humanPage, view('index.html'));
app.get('/login', humanPage, view('login.html'));
app.get('/dashboard', humanPage, attachUser, needLogin, view('dashboard.html'));
app.get('/settings', humanPage, attachUser, needLogin, view('settings.html'));
app.get('/s/:id', humanPage, view('room.html'));
app.get('/u/:handle', humanPage, view('profile.html'));

app.use((_req, res) => res.status(404).type('text').send('Not found'));
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'server_error' }); // never leak stack traces or config
});

const server = http.createServer(app);
attachRealtime(server);
purgeExpired();
setInterval(purgeExpired, 3_600_000).unref();
server.listen(cfg.port, () => console.log(`Knock is running on http://localhost:${cfg.port}`));
