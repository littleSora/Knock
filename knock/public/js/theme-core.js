// Theme maths and presets. Pure functions with no DOM access, so the browser (theme.js, settings.js) and the
// server (validation in server/api.js) share exactly one definition of what a valid theme is.

/* ---------- colour helpers ---------- */
const HEX = /^#[0-9a-f]{6}$/i;
export const isHex = (s) => typeof s === 'string' && HEX.test(s);
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const hex = (c) => '#' + c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
/** Blend: t=0 gives a, t=1 gives b. */
export const mix = (a, b, t) => { const x = rgb(a), y = rgb(b); return hex(x.map((v, i) => v + (y[i] - v) * t)); };
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const lum = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG contrast ratio, 1 to 21. */
export const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((p, q) => q - p); return (hi + 0.05) / (lo + 0.05); };
// Nudge `fg` toward `toward` until it reaches `min` contrast against every colour in `against`.
const ensure = (fg, against, min, toward) => {
  for (let t = 0; t <= 1.0001; t += 0.05) {
    const c = mix(fg, toward, Math.min(t, 1));
    if (against.every((bg) => contrast(c, bg) >= min)) return c;
  }
  return toward;
};
const DARK_INK = '#1b1840';
const LIGHT_INK = '#f1efff';
const onColor = (bg) => (contrast(bg, '#ffffff') >= contrast(bg, DARK_INK) ? '#ffffff' : DARK_INK);

/* ---------- presets (a preset is just a ready-made spec) ---------- */
// spec = { bg: {kind:'solid', a} | {kind:'gradient', a, b, angle}, accent, highlight, tone?: 'light'|'dark', hc?: bool, over?: {var: value} }
const solid = (a) => ({ kind: 'solid', a });
const grad = (a, b, angle) => ({ kind: 'gradient', a, b, angle });
export const PRESETS = [
  { id: 'auto', name: 'Match my device', note: 'Day or Night, following your system setting' },
  { id: 'day', name: 'Day', spec: { bg: solid('#f4f2ff'), accent: '#d42a68', highlight: '#ffd84d', tone: 'light', over: { '--line': '#d9d4f4', '--mute': '#625f86' } } },
  { id: 'night', name: 'Night', spec: { bg: solid('#13112b'), accent: '#ff6b9d', highlight: '#ffd84d', tone: 'dark' } },
  { id: 'contrast', name: 'High contrast', spec: { bg: solid('#000000'), accent: '#00e5ff', highlight: '#ffee00', tone: 'dark', hc: true } },
  { id: 'contrast-light', name: 'High contrast light', spec: { bg: solid('#ffffff'), accent: '#0036c7', highlight: '#ffd400', tone: 'light', hc: true } },
  { id: 'sunset', name: 'Sunset', spec: { bg: grad('#ffc79f', '#ff7a9c', 135), accent: '#5b21b6', highlight: '#ffe066' } },
  { id: 'ocean', name: 'Ocean', spec: { bg: grad('#bdeaf7', '#4fb0dc', 160), accent: '#0b4f8a', highlight: '#fff0a3' } },
  { id: 'candy', name: 'Candy', spec: { bg: grad('#fbd0ee', '#b7cdf5', 120), accent: '#b4185a', highlight: '#fff176' } },
  { id: 'aurora', name: 'Aurora', spec: { bg: grad('#0b1d2a', '#1f5a68', 160), accent: '#5eead4', highlight: '#c4b5fd' } },
  { id: 'nebula', name: 'Nebula', spec: { bg: grad('#1a1040', '#4a2386', 150), accent: '#ff7ac6', highlight: '#ffd84d' } },
];
export const PRESET_IDS = PRESETS.map((p) => p.id);
export const DEFAULT_CUSTOM = { bg: solid('#f4f2ff'), accent: '#d42a68', highlight: '#ffd84d' };

/* ---------- validation: what the server stores and the browser trusts ---------- */
const cleanHex = (s) => (isHex(s) ? s.toLowerCase() : null);
/** Returns a normalised theme ({preset} or {preset:'custom', custom}) or null if the input isn't a valid theme. */
export function parseTheme(input) {
  if (!input || typeof input !== 'object') return null;
  if (input.preset !== 'custom') return PRESET_IDS.includes(input.preset) ? { preset: input.preset } : null;
  const c = input.custom;
  if (!c || typeof c !== 'object' || !c.bg || typeof c.bg !== 'object') return null;
  const a = cleanHex(c.bg.a), accent = cleanHex(c.accent), highlight = cleanHex(c.highlight);
  if (!a || !accent || !highlight) return null;
  let bg;
  if (c.bg.kind === 'solid') bg = solid(a);
  else if (c.bg.kind === 'gradient') {
    const b = cleanHex(c.bg.b), angle = Number(c.bg.angle);
    if (!b || !Number.isFinite(angle)) return null;
    bg = grad(a, b, ((Math.round(angle) % 360) + 360) % 360);
  } else return null;
  const custom = { bg, accent, highlight };
  if (c.tone === 'light' || c.tone === 'dark') custom.tone = c.tone;
  return { preset: 'custom', custom };
}

/** The spec for a theme (never 'auto': use specsFor for that). */
export function specOf(theme) {
  if (theme.preset === 'custom') return theme.custom;
  return PRESETS.find((p) => p.id === theme.preset)?.spec ?? PRESETS[1].spec;
}
/** A custom theme that starts out looking like the given theme, so editing begins from what you see now. */
export function toCustom(theme, prefersDark = false) {
  const t = theme?.preset === 'auto' ? { preset: prefersDark ? 'night' : 'day' } : theme || { preset: 'day' };
  const s = structuredClone(specOf(t));
  // Text style stays on Auto so changing the background always picks readable text.
  return { preset: 'custom', custom: { bg: s.bg, accent: s.accent, highlight: s.highlight } };
}

/* ---------- turning a spec into CSS variables ---------- */
export function pickTone(ends) {
  const score = (ink) => Math.min(...ends.map((e) => contrast(ink, e)));
  return score(DARK_INK) >= score(LIGHT_INK) ? 'light' : 'dark';
}
/** Smallest text contrast the chosen text colour reaches on this background (for the readability warning). */
export function readability(spec) {
  const ends = spec.bg.kind === 'gradient' ? [spec.bg.a, spec.bg.b] : [spec.bg.a];
  const tone = spec.tone || pickTone(ends);
  const ink = spec.hc ? (tone === 'dark' ? '#ffffff' : '#000000') : tone === 'dark' ? LIGHT_INK : DARK_INK;
  return Math.min(...ends.map((e) => contrast(ink, e)));
}

export function resolve(spec) {
  const { bg, accent, highlight } = spec;
  const ends = bg.kind === 'gradient' ? [bg.a, bg.b] : [bg.a];
  const tone = spec.tone || pickTone(ends);
  const dark = tone === 'dark';
  const ink = spec.hc ? (dark ? '#ffffff' : '#000000') : dark ? LIGHT_INK : DARK_INK;
  const paper = bg.a;
  const card = spec.hc ? paper : dark ? mix(paper, '#ffffff', 0.08) : '#ffffff';
  const surfaces = [...ends, card];
  const vars = {
    '--ink': ink,
    '--paper': paper,
    '--card': card,
    '--line': spec.hc ? ink : mix(ink, paper, dark ? 0.78 : 0.86),
    '--mute': spec.hc ? ink : ensure(mix(ink, paper, 0.38), surfaces, 4.5, ink),
    '--yellow': highlight,
    '--pink': accent,
    '--on-yellow': onColor(highlight),
    '--on-pink': onColor(accent),
    '--pink-ink': ensure(accent, surfaces, 4.5, ink),
    '--danger': ensure(dark ? '#ff8aa8' : '#b3123f', surfaces, 4.5, ink),
    '--green': dark ? '#3ddc84' : '#1f9d55',
    '--gray': dark ? '#8c89b0' : '#a3a2b7',
    '--page': bg.kind === 'gradient' ? `linear-gradient(${bg.angle}deg, ${bg.a}, ${bg.b})` : paper,
    ...(spec.over || {}),
  };
  return { vars, scheme: dark ? 'dark' : 'light' };
}

/** What the browser applies and caches for a theme: one result, or a light/dark pair for "Match my device". */
export function build(theme) {
  if (!theme) return null;
  if (theme.preset === 'auto') return { auto: { light: resolve(specOf({ preset: 'day' })), dark: resolve(specOf({ preset: 'night' })) } };
  return resolve(specOf(theme));
}
