import { api, h, icon, toast, errText, avatarEl, openModal } from './common.js';
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

    const methods = [me.has_google && 'Google', me.email && 'Email code', me.phone && 'Phone code'].filter(Boolean).join(', ') || 'n/a';
    const na = (v) => v || 'n/a';
    body.replaceChildren(
      h('div', { class: 'profile-head', style: 'margin-top:0' },
        avatarEl(me, 88),
        h('div', {}, h('h2', { style: 'font-size:1.6rem' }, me.display_name), h('p', { class: 'sub' }, '@' + me.handle),
          h('div', { class: 'pic-actions' }, change, remove))),
      file,
      h('p', { class: 'hint' }, 'PNG, JPG, WebP or GIF, up to 3 MB. You’ll crop it to fit the circle.'),
      msg,
      h('h3', {}, 'Account'),
      h('dl', { class: 'facts-list' },
        h('dt', {}, 'Username'), h('dd', {}, '@' + me.handle),
        h('dt', {}, 'Name at signup'), h('dd', {}, me.signup_name),
        h('dt', {}, 'Gmail / email'), h('dd', {}, na(me.email)),
        h('dt', {}, 'Mobile number'), h('dd', {}, na(me.phone)),
        h('dt', {}, 'Sign-in methods'), h('dd', {}, methods),
        h('dt', {}, 'Account created'), h('dd', {}, fmtDate(me.created_at))),
      // In a call, Settings opens in a new tab so you don't leave the call.
      h('a', { class: 'btn sm settings-link', href: '/settings', ...(inCall ? { target: '_blank', rel: 'noopener' } : {}) }, h('span', { class: 'btn-ic' }, icon('gear', 16)), 'Settings'));
  }
}
