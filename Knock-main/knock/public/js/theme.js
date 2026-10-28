// Applies the person's theme to the page. Imported by common.js, so every page gets it.
// Source of truth: the account (server) when signed in; this device (localStorage) otherwise.
import { build, parseTheme } from './theme-core.js';

const root = document.documentElement;
const SRC = 'knock.theme.src'; // the chosen theme, e.g. {"preset":"night"}
const APPLIED = 'knock.theme'; // resolved CSS variables, replayed by theme-boot.js before first paint
const dark = matchMedia('(prefers-color-scheme: dark)');
let current = null;
let applied = [];
const listeners = new Set();

const read = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked: theme still applies for this visit */ } };

function paint() {
  for (const k of applied) root.style.removeProperty(k);
  applied = [];
  const b = build(current);
  const r = !b ? null : b.auto ? (dark.matches ? b.auto.dark : b.auto.light) : b;
  if (!r) { root.style.removeProperty('color-scheme'); return; }
  for (const [k, v] of Object.entries(r.vars)) { root.style.setProperty(k, v); applied.push(k); }
  root.style.setProperty('color-scheme', r.scheme);
}

/** Apply (and remember on this device). Pass null to go back to the default look. */
export function setTheme(theme) {
  current = theme ? parseTheme(theme) : null;
  write(SRC, current ? JSON.stringify(current) : null);
  write(APPLIED, current ? JSON.stringify(build(current)) : null);
  paint();
  listeners.forEach((fn) => fn(current));
}
export const getTheme = () => current;
export const onTheme = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const prefersDark = () => dark.matches;

/** Called with the theme the server has for this account (from /api/auth/me). */
export function adoptServerTheme(raw) {
  const t = parseTheme(raw);
  if (t && JSON.stringify(t) !== JSON.stringify(current)) setTheme(t);
}

try { current = parseTheme(JSON.parse(read(SRC) || 'null')); } catch { current = null; }
paint();
dark.addEventListener('change', () => { if (current?.preset === 'auto') paint(); });
