import { api, h, icon, toast, errText, avatarEl, openModal, statusChip, activeStatus } from './common.js';
import { cropAvatar } from './cropper.js';

const MAX_UPLOAD = 3 * 1024 * 1024; // 3 MB, checked on the file the person picks (before cropping)
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const buttons = new Set();

// The round profile-picture button for the top right corner. `user` is shared with the page, so edits show everywhere.
export function profileButton(user) {
  const btn = h('button', { class: 'me-btn', type: 'button', 'aria-label': 'Your profile', title: 'Your profile', 'aria-haspopup': 'dialog', onclick: () => openAccount(user) });
  const paint = () => btn.replaceChildren(avatarEl(user, 38));
  paint();
  buttons.add({ btn, paint });
  return btn;
}
window.addEventListener('profile-updated', () => buttons.forEach((b) => (b.btn.isConnected ? b.paint() : buttons.delete(b))));
const announce = () => window.dispatchEvent(new Event('profile-updated'));

async function uploadAvatar(blob) {
  const res = await fetch('/api/me/avatar', { method: 'PUT', headers: { 'Content-Type': blob.type }, body: blob, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'request_failed'), { status: res.status, code: data.error });
  return data;
}

// Your status. Automatic by default: "In a meeting" while you're in a call, "Away" after 10 minutes away from the tab. Or pick one
// yourself from the drop-down. Friends see it next to your online dot; "Do not disturb" also stops push notifications.
const MODES = [['auto', 'Automatic'], ['meeting', '📅 In a meeting'], ['dnd', '⛔ Do not disturb'], ['away', '🌙 Away']];
const DURATIONS = [['', 'Don’t clear'], ['30', '30 minutes'], ['60', '1 hour'], ['240', '4 hours'], ['today', 'Today']];
let chosenFor = ''; // the "Clear after" you picked last, so the drop-down still shows it after the section redraws
function statusSection(me, rerender) {
  const msg = h('p', { class: 'error', role: 'alert' });
  const active = activeStatus(me.status);
  const picked = active && !active.auto && MODES.some(([k]) => k === active.kind) ? active.kind : 'auto'; // what *you* chose; Knock's own is "Automatic"
  const mode = h('select', { id: 'statusMode', 'aria-label': 'Status' }, MODES.map(([v, t]) => h('option', { value: v, selected: v === picked }, t)));
  const dur = h('select', { id: 'statusFor', 'aria-label': 'Clear status after', disabled: picked === 'auto' }, DURATIONS.map(([v, t]) => h('option', { value: v, selected: v === (picked !== 'auto' && active.until != null ? chosenFor : '') }, t)));
  const minutes = () => (dur.value === '' ? null : dur.value === 'today' ? Math.max(1, Math.ceil((new Date().setHours(24, 0, 0, 0) - Date.now()) / 60000)) : Number(dur.value));
  const save = async () => {
    msg.textContent = '';
    dur.disabled = mode.value === 'auto'; // "Clear after" only means something for a status you picked
    chosenFor = mode.value === 'auto' ? '' : dur.value;
    try { me.status = (await api('/api/me/status', { method: 'PUT', body: { kind: mode.value, minutes: mode.value === 'auto' ? null : minutes() } })).status; rerender(); }
    catch (err) { msg.textContent = errText(err); }
  };
  mode.addEventListener('change', save);
  dur.addEventListener('change', () => { if (mode.value !== 'auto') save(); }); // a new "clear after" applies to the status already picked
  const current = statusChip(me.status);
  return h('div', { class: 'status-editor' },
    h('h3', {}, 'Status'),
    h('p', { class: 'hint' }, current ? ['Friends see: ', current] : 'Friends can see your status next to your online dot. “Do not disturb” also pauses push notifications.'),
    h('label', { class: 'status-for', for: 'statusMode' }, 'Show as', mode),
    h('label', { class: 'status-for', for: 'statusFor' }, 'Clear after', dur),
    h('p', { class: 'hint' }, 'Automatic shows “In a meeting” while you’re in a call and “Away” after 10 minutes away from this tab.'),
    msg);
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });

async function openAccount(user) {
  const inCall = location.pathname.startsWith('/s/');
  const body = h('div', {}, h('p', { class: 'hint' }, 'Loading…'));
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close profile', onclick: () => m.close() }, icon('x', 16));
  const m = openModal({ label: 'Your profile', wide: true }, h('div', { class: 'pop-head' }, h('span', { class: 'grow' }), closeBtn), body);
  let me;
  try { me = (await api('/api/me')).user; } catch (err) { body.replaceChildren(h('p', { class: 'error' }, errText(err))); return; }
  render();

  function render() {
    const msg = h('p', { class: 'error', role: 'alert' });
    const file = h('input', { type: 'file', accept: TYPES.join(','), hidden: true, 'aria-label': 'Choose a profile picture' });
    const change = h('button', { class: 'btn sm', type: 'button', 'data-autofocus': '' }, h('span', { class: 'btn-ic' }, icon('camera', 16)), me.avatar_at ? 'Change picture' : 'Add a picture');
    change.addEventListener('click', () => file.click());
    const remove = me.avatar_at ? h('button', { class: 'link-btn danger', type: 'button' }, 'Remove') : null;

    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      msg.textContent = '';
      if (!f) return;
      if (!TYPES.includes(f.type)) { msg.textContent = 'Pick a PNG, JPG, WebP or GIF picture.'; return; }
      if (f.size > MAX_UPLOAD) { msg.textContent = `That file is ${(f.size / 1024 / 1024).toFixed(1)} MB. Pick one that’s 3 MB or smaller.`; return; }
      let blob;
      try { blob = await cropAvatar(f); } catch { msg.textContent = 'We couldn’t open that picture. Try a different one.'; return; }
      if (!blob) return; // cancelled
      change.disabled = true;
      try {
        const r = await uploadAvatar(blob);
        me.avatar_at = r.avatar_at;
        user.avatar_at = r.avatar_at;
        announce();
        toast('Profile picture updated');
        render();
      } catch (err) { change.disabled = false; msg.textContent = errText(err); }
    });
    remove?.addEventListener('click', async () => {
      try {
        await api('/api/me/avatar', { method: 'DELETE' });
        me.avatar_at = null;
        user.avatar_at = null;
        announce();
        toast('Profile picture removed');
        render();
      } catch (err) { msg.textContent = errText(err); }
    });

    const na = (v) => v || 'n/a';
    body.replaceChildren(
      h('div', { class: 'profile-head', style: 'margin-top:0' },
        avatarEl(me, 88),
        h('div', {}, h('h2', { style: 'font-size:1.6rem' }, me.display_name), h('p', { class: 'sub' }, '@' + me.handle),
          h('div', { class: 'pic-actions' }, change, remove))),
      file,
      h('p', { class: 'hint' }, 'PNG, JPG, WebP or GIF, up to 3 MB. You’ll crop it to fit the circle.'),
      msg,
      statusSection(me, render),
      h('h3', {}, 'Account'),
      h('dl', { class: 'facts-list' },
        h('dt', {}, 'Username'), h('dd', {}, '@' + me.handle),
        h('dt', {}, 'Name at signup'), h('dd', {}, me.signup_name),
        h('dt', {}, 'Email'), h('dd', {}, na(me.email)),
        h('dt', {}, 'Sign-in'), h('dd', {}, me.has_password ? 'Email and password' : 'Email (set a password in Settings)'),
        h('dt', {}, 'Account created'), h('dd', {}, fmtDate(me.created_at))),
      // In a call, Settings opens in a new tab so you don't leave the call.
      h('a', { class: 'btn sm settings-link', href: '/settings', ...(inCall ? { target: '_blank', rel: 'noopener' } : {}) }, h('span', { class: 'btn-ic' }, icon('gear', 16)), 'Settings'));
  }
}
