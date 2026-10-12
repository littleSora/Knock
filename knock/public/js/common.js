export const $ = (sel, root = document) => root.querySelector(sel);

// Tiny element builder. Text goes in via append(), never innerHTML, so user-supplied names/messages can't inject markup.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
  return el;
}

const ICONS = {
  bell: '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6Z"/><path d="M10 19a2 2 0 0 0 4 0"/>',
  users: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.4"/><path d="M17 14c2.5 0 4 2 4 5"/>',
  userPlus: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M19 8v6M16 11h6"/>',
  userCheck: '<circle cx="10" cy="8" r="3.5"/><path d="M3.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="m16 11 2 2 4-4"/>',
  send: '<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4Z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M4 4l16 16"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3Z"/>',
  videoOff: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3ZM3 3l18 18"/>',
  leave: '<path d="M4 15c4-4 12-4 16 0l-2 3-3-1.5v-2.5a8 8 0 0 0-6 0v2.5L6 18Z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  recap: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 13l2 2 4-4"/>',
};
export function icon(name, size = 20) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  svg.innerHTML = ICONS[name]; // static strings above only
  return svg;
}

export function toast(text) {
  const t = h('div', { class: 'toast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

// All calls go to same-origin /api. No keys or third-party URLs are ever used from the browser here.
export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 403 && data.error === 'captcha_required') {
    location.href = '/verify?next=' + encodeURIComponent(location.pathname + location.search);
    throw Object.assign(new Error('captcha_required'), { code: 'captcha_required' });
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, code: data.error });
  return data;
}

const MESSAGES = {
  wrong_code: 'That code is wrong. Check it and try again.',
  code_expired: 'That code has expired. Ask for a new one.',
  wait_before_resend: 'Wait 30 seconds before asking for another code.',
  invalid_target: 'Enter a valid phone number with country code (like +639171234567) or a valid email address.',
  delivery_failed: 'We couldn’t send the code. Try again in a minute.',
  session_not_found: 'No session matches that code. Check it with the person who shared it.',
  google_failed: 'Google sign-in didn’t work. Try again.',
};
export const errText = (e) => (e.status === 429 ? 'Too many tries. Wait a few minutes and try again.' : MESSAGES[e.code] || 'Something went wrong. Try again.');

export const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : null);
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Renders a session code as two groups of five tiles. animate=true plays the flip-in.
export function renderCode(el, id, { animate = false } = {}) {
  const chars = id ? [...id] : Array(10).fill('·');
  const tile = (c, i) => h('span', { class: 'tile' + (id ? '' : ' blank') + (animate ? ' flip' : ''), style: `--i:${i}` }, c);
  el.replaceChildren(h('span', { class: 'grp' }, chars.slice(0, 5).map(tile)), h('span', { class: 'grp' }, chars.slice(5).map((c, i) => tile(c, i + 5))));
  el.setAttribute('aria-label', id ? `Session code ${[...id].join(' ')}` : 'No code yet');
}
