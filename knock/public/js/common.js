import { adoptServerTheme } from './theme.js';

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
  headphones: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/>',
  headphonesOff: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/><path d="M4 4l16 16"/>',
  video: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3Z"/>',
  videoOff: '<rect x="3" y="6" width="13" height="12" rx="3"/><path d="m16 10 5-3v10l-5-3ZM3 3l18 18"/>',
  leave: '<path d="M4 15c4-4 12-4 16 0l-2 3-3-1.5v-2.5a8 8 0 0 0-6 0v2.5L6 18Z"/>',
  chat: '<path d="M4 5h16v11H9l-5 4Z"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  recap: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 13l2 2 4-4"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1"/>',
  messages: '<path d="M3 4h12v9H8l-5 3Z"/><path d="M15 8h6v9l-3-2h-6v-2"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4Z"/><circle cx="12" cy="13" r="3.5"/>',
  back: '<path d="M15 18l-6-6 6-6"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>',
  ban: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="9" cy="9.5" r="1.7"/><path d="m21 16-5.5-5.5L7 19"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.2s1.2 1.8 3.5 1.8 3.5-1.8 3.5-1.8M9.2 9.6h.01M14.8 9.6h.01"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>',
  pin: '<path d="M9 4h6l-1 6 3 3H7l3-3Z"/><path d="M12 13v7"/>',
  more: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  screenOff: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4M4 3l16 18"/>',
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
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, code: data.error, data });
  if (path === '/api/auth/me' && data.user && data.theme) adoptServerTheme(data.theme); // the account's saved theme follows the person across devices
  return data;
}

const MESSAGES = {
  wrong_code: 'That code is wrong. Check it and try again.',
  too_many_codes: 'Too many wrong codes. Ask for a new code.',
  code_expired: 'That code has expired. Ask for a new one.',
  wait_before_resend: 'Please wait 1 minute 30 seconds before asking for another code.',
  no_account: 'No Knock account uses that email. Check the spelling, or create an account.',
  invalid_email: 'Enter a valid email address.',
  invalid_name: 'Enter your name.',
  weak_password: 'Use a password of 8 to 128 characters that isn’t just your email.',
  email_taken: 'That email already has an account. Log in instead.',
  wrong_credentials: 'Wrong email or password. If you haven’t created an account yet, create one first.',
  no_password_set: 'This account doesn’t have a password yet. Use “Forgot password?” to set one.',
  too_many_attempts: 'Too many wrong passwords. This email is locked for 30 minutes. You can wait, or use “Forgot password?” to reset it.',
  wrong_password: 'Your current password isn’t right.',
  delivery_failed: 'We couldn’t send the code. Try again in a minute.',
  session_not_found: 'No session matches that code. Check it with the person who shared it.',
  already_in_call: 'You’re already in this call in another tab or on another device. Close that one first, or just use it.',
  room_full: 'This call is full.',
  session_ended: 'That session has ended.',
  invalid_repeat: 'Check the repeat setting. The last day has to be after the first call.',
  already_in_use: 'That is already used by another account.',
  same_as_current: 'That is already on your account.',
  last_sign_in_method: 'You need at least one way to sign in, so this one can’t be removed.',
  invalid_username: 'Usernames are 3 to 20 letters or numbers.',
  username_taken: 'That username is taken. Try another.',
  invalid_name: 'Enter a name.',
  invalid_theme: 'That theme isn’t valid.',
  image_too_large: 'That picture is too big. Try a smaller crop.',
  invalid_group: 'Give the group a name and pick at least one friend.',
  not_a_friend: 'You can only add people who are on your friend list.',
  group_not_found: 'That group isn’t available any more.',
  invalid_message: 'Type a message first.',
  invalid_image: 'That file isn’t a picture we can use. Try a PNG, JPG, WebP or GIF.',
  group_full: 'That group is full.',
  not_group_creator: 'Only the person who created the group can remove people.',
  member_not_found: 'That person isn’t in the group any more.',
  request_not_found: 'That friend request is no longer there.',
  unblock_first: 'You blocked this person. Unblock them first.',
  cannot_contact: 'You can’t contact this person.',
  cannot_join: 'You can’t join this call right now.',
  cannot_add_member: 'You can’t add that person to this group.',
  invalid_report: 'Pick a reason for the report and try again.',
  details_required: 'Tell us a little about what happened.',
  user_not_found: 'We can’t find that person.',
  invalid_reaction: 'That reaction isn’t available.',
  message_not_found: 'That message isn’t available any more.',
  invalid_initial: 'The initial should be a single letter.',
  invalid_birthday: 'Enter a real birthday that isn’t in the future.',
  not_message_owner: 'You can only change your own messages.',
  invalid_edit: 'A picture with no caption has no text to edit.',
  too_many_pins: 'You can pin up to 10 messages in a chat. Unpin one first.',
  admins_only: 'Only group admins can do that in this group.',
  creator_only: 'Only the person who created the group can do that.',
  invalid_user: 'That person isn’t available.',
  invalid_status: 'Pick a status from the list.',
  invalid_subscription: 'This browser couldn’t be set up for push notifications.',
  not_subscribed: 'Push isn’t turned on in this browser.',
};
const left = (n) => `${n} ${n === 1 ? 'try' : 'tries'} left`;
// 87 -> "1 minute 27 seconds", 1800 -> "30 minutes"
export const fmtWords = (secs) => {
  const m = Math.floor(secs / 60), r = secs % 60;
  return [m && `${m} minute${m === 1 ? '' : 's'}`, (r || !m) && `${r} second${r === 1 ? '' : 's'}`].filter(Boolean).join(' ');
};
export const fmtCountdown = (secs) => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
export function errText(e) {
  const n = e.data?.attempts_left;
  if (e.code === 'wrong_credentials' && Number.isInteger(n)) return `Wrong email or password. You have ${left(n)} before this email is locked for 30 minutes.`;
  if (e.code === 'wrong_code' && Number.isInteger(n)) return `That code is wrong. You have ${left(n)} before you need a new code.`;
  if (e.code === 'wait_before_resend' && e.data?.retry_after) return `Please wait ${fmtWords(e.data.retry_after)} before asking for another code.`;
  if (e.code === 'too_many_attempts' && e.data?.retry_after) return `Too many wrong passwords. This email is locked. Try again in ${fmtWords(e.data.retry_after)}, or use “Forgot password?” to reset it.`;
  return MESSAGES[e.code] || (e.status === 429 ? 'Too many tries. Wait a few minutes and try again.' : 'Something went wrong. Try again.');
}

/* ---------- custom status ("📅 In a meeting"), shown to friends next to the online dot ---------- */
// null once it has expired (the server also stops sending it, but a page that's been open for hours still has the old value).
export const activeStatus = (s) => (s && (s.until == null || s.until > Date.now()) ? s : null);
export function statusChip(s, cls = 'status-chip') {
  const a = activeStatus(s);
  if (!a) return null;
  return h('span', { class: `${cls} status-${a.kind}`, title: a.text }, a.emoji ? h('span', { class: 'status-emoji', 'aria-hidden': 'true' }, a.emoji) : null, h('span', { class: 'status-text' }, a.text));
}

export const safeNext = (n) => (n && n.startsWith('/') && !n.startsWith('//') && !n.includes('\\') ? n : null);
export const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// Renders a session code as two groups of five tiles. animate=true plays the flip-in; masked=true hides the characters.
export function renderCode(el, id, { animate = false, masked = false } = {}) {
  const chars = id ? [...id] : Array(10).fill('·');
  const hide = !!id && masked;
  const tile = (c, i) => h('span', { class: 'tile' + (!id || hide ? ' blank' : '') + (animate ? ' flip' : ''), style: `--i:${i}` }, hide ? '•' : c);
  el.replaceChildren(h('span', { class: 'grp' }, chars.slice(0, 5).map(tile)), h('span', { class: 'grp' }, chars.slice(5).map((c, i) => tile(c, i + 5))));
  el.setAttribute('aria-label', hide ? 'Session code hidden' : id ? `Session code ${[...id].join(' ')}` : 'No code yet');
}

/* ---------- profile pictures: the picture if there is one, otherwise the first letter of the name ---------- */
export const avatarUrl = (handle, at) => `/api/avatars/${encodeURIComponent(handle)}?v=${at}`;
export function avatarEl({ handle, display_name: name, avatar_at: at } = {}, size = 40) {
  const el = h('span', { class: 'pic', style: `--s:${size}px`, 'aria-hidden': 'true' }, [...(name || '?')][0]?.toUpperCase() || '?');
  if (handle && at) {
    const img = h('img', { src: avatarUrl(handle, at), alt: '', draggable: 'false' });
    img.addEventListener('load', () => el.replaceChildren(img)); // keep the letter until the picture has loaded
  }
  return el;
}

// A group's picture if it has one, otherwise the people icon. Only group members can load it (the server checks).
export const groupAvatarUrl = (id, at) => `/api/groups/${encodeURIComponent(id)}/avatar?v=${at}`;
export function groupAvatarEl({ id, avatar_at: at } = {}, size = 40) {
  const el = h('span', { class: 'pic', style: `--s:${size}px`, 'aria-hidden': 'true' }, icon('users', Math.round(size * 0.5)));
  if (id && at) {
    const img = h('img', { src: groupAvatarUrl(id, at), alt: '', draggable: 'false' });
    img.addEventListener('load', () => el.replaceChildren(img)); // keep the icon until the picture has loaded
  }
  return el;
}

/* ---------- friend requests: one set of buttons for every place a person's profile shows up ---------- */
// relation: 'none' | 'outgoing' (you asked) | 'incoming' (they asked you) | 'friend' | 'blocked' (you blocked them)
export function friendActions(p, relation, onChange) {
  const box = h('div', { class: 'friend-actions' });
  const go = async (call, next, message) => {
    try {
      const res = await call();
      relation = typeof next === 'function' ? next(res) : next;
      paint();
      if (message) toast(typeof message === 'function' ? message(relation) : message);
      onChange?.(relation);
    } catch (err) { toast(errText(err)); }
  };
  function paint() {
    const id = encodeURIComponent(p.id);
    if (relation === 'blocked') {
      box.replaceChildren(h('span', { class: 'friend-state' }, icon('ban', 18), 'You blocked this person'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => go(() => api(`/api/blocks/${id}`, { method: 'DELETE' }), 'none', `Unblocked ${p.display_name}.`) }, 'Unblock'));
    } else if (relation === 'friend') {
      box.replaceChildren(h('span', { class: 'friend-state' }, icon('userCheck', 18), 'Friends'),
        h('button', { class: 'btn sm danger', type: 'button', 'aria-label': `Unfriend ${p.display_name}`, onclick: () => {
          if (!confirm(`Remove ${p.display_name} from your friends?`)) return;
          go(() => api(`/api/friends/${id}`, { method: 'DELETE' }), 'none', `You unfriended ${p.display_name}.`);
        } }, 'Unfriend'));
    } else if (relation === 'outgoing') {
      box.replaceChildren(h('span', { class: 'friend-state' }, 'Request sent'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => go(() => api(`/api/friends/requests/${id}`, { method: 'DELETE' }), 'none', 'Friend request cancelled.') }, 'Cancel'));
    } else if (relation === 'incoming') {
      box.replaceChildren(h('span', { class: 'friend-state' }, `${p.display_name} wants to be your friend`),
        h('button', { class: 'btn primary sm', type: 'button', onclick: () => go(() => api(`/api/friends/requests/${id}/accept`, { method: 'POST' }), 'friend', `You and ${p.display_name} are now friends.`) }, 'Accept'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => go(() => api(`/api/friends/requests/${id}/decline`, { method: 'POST' }), 'none') }, 'Decline'));
    } else {
      box.replaceChildren(h('button', { class: 'btn primary sm', type: 'button',
        onclick: () => go(() => api(`/api/friends/${id}`, { method: 'POST' }), (r) => (r.state === 'friend' ? 'friend' : 'outgoing'), (r) => (r === 'friend' ? `You and ${p.display_name} are now friends.` : `Friend request sent to ${p.display_name}.`)) },
      h('span', { class: 'btn-ic' }, icon('userPlus', 16)), 'Add friend'));
    }
  }
  paint();
  return box;
}

/* ---------- modal dialogs (one shared Escape / Tab-trap handler; the top-most dialog wins) ---------- */
const modals = [];
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
document.addEventListener('keydown', (e) => {
  const top = modals.at(-1);
  if (!top) return;
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); top.close(); return; }
  if (e.key !== 'Tab') return;
  const items = [...top.card.querySelectorAll(FOCUSABLE)].filter((x) => x.offsetParent !== null);
  if (!items.length) { e.preventDefault(); return; }
  const first = items[0];
  const last = items.at(-1);
  if (!top.card.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}, true);

export function openModal({ label, role = 'dialog', wide = false, describedBy, onClose } = {}, ...kids) {
  const opener = document.activeElement;
  const card = h('div', { class: 'profile-pop' + (wide ? ' wide' : ''), role, 'aria-modal': 'true', 'aria-label': label, 'aria-describedby': describedBy, tabindex: '-1' }, ...kids);
  const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) m.close(); } }, card);
  const m = {
    card,
    closed: false,
    close(result) {
      if (m.closed) return;
      m.closed = true;
      modals.splice(modals.indexOf(m), 1);
      overlay.remove();
      opener?.focus?.();
      onClose?.(result);
    },
  };
  modals.push(m);
  document.body.append(overlay);
  (card.querySelector('[data-autofocus]') || card).focus();
  return m;
}

// Resolves true if the person confirms, false if they cancel (button, Escape or clicking outside).
let dialogCount = 0;
export function confirmDialog({ title, body, confirmText = 'Confirm', cancelText = 'Cancel' }) {
  return new Promise((resolve) => {
    let result = false;
    const descId = 'dlg-desc-' + ++dialogCount;
    const no = h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => m.close() }, cancelText);
    const yes = h('button', { class: 'btn primary', type: 'button', onclick: () => { result = true; m.close(); } }, confirmText);
    const m = openModal({ label: title, role: 'alertdialog', describedBy: descId, onClose: () => resolve(result) },
      h('h2', { style: 'font-size:1.5rem;margin-top:.4rem' }, title),
      h('p', { id: descId, class: 'hint', style: 'margin:.6rem 0 0' }, body),
      h('div', { class: 'dialog-actions' }, no, yes));
  });
}

// Show a message on the next page load (used when an action ends by navigating away).
export const flash = (text) => { try { sessionStorage.setItem('knock.flash', text); } catch { /* storage blocked: skip */ } };
try {
  const f = sessionStorage.getItem('knock.flash');
  if (f) { sessionStorage.removeItem('knock.flash'); queueMicrotask(() => toast(f)); }
} catch { /* storage blocked: skip */ }
