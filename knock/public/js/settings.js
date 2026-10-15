import { api, h, errText, toast, confirmDialog, avatarEl } from './common.js';
import { mountTopbar } from './topbar.js';
import { PRESETS, resolve, specOf, toCustom, readability, parseTheme } from './theme-core.js';
import { setTheme, getTheme, prefersDark } from './theme.js';
import { ColorWheel } from './colorwheel.js';
import * as notify from './notify.js';

const { user } = await api('/api/auth/me');
if (!user) location.replace('/login?next=/settings');
mountTopbar(user);
const root = document.getElementById('settings');
const [{ user: me }, cfg] = await Promise.all([api('/api/me'), api('/api/config').catch(() => ({}))]);
const announce = () => window.dispatchEvent(new Event('profile-updated'));
const section = (id, title, ...kids) => h('section', { class: 'block set-block', 'aria-labelledby': id }, h('h2', { id }, title), ...kids);

/* =====================================================================================
   Appearance
   ===================================================================================== */
function appearance() {
  const saveState = h('span', { class: 'save-state', role: 'status' });
  let timer;
  const save = (theme) => {
    clearTimeout(timer);
    saveState.textContent = 'Saving…';
    timer = setTimeout(async () => {
      try { await api('/api/me/theme', { method: 'PUT', body: { theme } }); saveState.textContent = 'Saved to your account'; }
      catch (err) { saveState.textContent = ''; toast(errText(err)); }
    }, 500);
  };
  // The theme the person is looking at. No saved theme means the default look, which is the Day preset.
  const shown = () => getTheme() ?? { preset: 'day' };

  /* ----- presets ----- */
  const previewBg = (p) => {
    if (p.id === 'auto') {
      const l = resolve(specOf({ preset: 'day' })).vars, d = resolve(specOf({ preset: 'night' })).vars;
      return `linear-gradient(135deg, ${l['--paper']} 50%, ${d['--paper']} 50%)`;
    }
    return resolve(p.spec).vars['--page'];
  };
  const cards = PRESETS.map((p) => {
    const v = p.spec ? resolve(p.spec).vars : null;
    const btn = h('button', { type: 'button', class: 'theme-card', role: 'radio', onclick: () => choose({ preset: p.id }) },
      h('span', { class: 'theme-prev', style: `background:${previewBg(p)}` },
        v ? [h('i', { style: `background:${v['--pink']}` }), h('i', { style: `background:${v['--yellow']}` }), h('b', { style: `background:${v['--card']};border-color:${v['--ink']}` })] : null),
      h('span', { class: 'theme-name' }, p.name));
    btn.dataset.id = p.id;
    return btn;
  });
  const grid = h('div', { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme presets' }, cards);
  function markPresets() {
    const t = shown();
    for (const c of cards) { const on = t.preset === c.dataset.id; c.setAttribute('aria-checked', String(on)); c.classList.toggle('on', on); }
  }
  function choose(theme) {
    setTheme(theme);
    save(theme);
    loadCustomFromTheme();
    markPresets();
  }

  /* ----- custom colours ----- */
  let custom = toCustom(shown(), prefersDark()).custom;
  let editing = 'a'; // which colour the wheel is changing: a (background), b (gradient end), accent, highlight
  const SLOTS = [
    { key: 'a', label: () => (custom.bg.kind === 'gradient' ? 'Gradient start' : 'Background'), get: () => custom.bg.a },
    { key: 'b', label: () => 'Gradient end', get: () => custom.bg.b, only: () => custom.bg.kind === 'gradient' },
    { key: 'accent', label: () => 'Buttons & links', get: () => custom.accent },
    { key: 'highlight', label: () => 'Highlights', get: () => custom.highlight },
  ];
  const wheel = ColorWheel(custom.bg.a, (hex) => {
    if (editing === 'a') custom.bg.a = hex;
    else if (editing === 'b') custom.bg.b = hex;
    else custom[editing] = hex;
    applyCustom();
  }, { label: 'Colour' });
  const chips = h('div', { class: 'chips', role: 'radiogroup', 'aria-label': 'Which colour to change' });
  const angle = h('input', { type: 'range', min: '0', max: '359', id: 'gAngle' });
  angle.addEventListener('input', () => { custom.bg.angle = Number(angle.value); applyCustom(); });
  const angleRow = h('label', { class: 'angle-row', for: 'gAngle' }, 'Gradient direction', angle);
  const kindBtns = ['solid', 'gradient'].map((k) => h('button', { type: 'button', class: 'tab', role: 'radio', onclick: () => setKind(k) }, k === 'solid' ? 'Solid colour' : 'Gradient'));
  const toneBtns = [[undefined, 'Auto'], ['light', 'Dark text'], ['dark', 'Light text']].map(([t, name]) =>
    h('button', { type: 'button', class: 'tab', role: 'radio', onclick: () => { t ? (custom.tone = t) : delete custom.tone; applyCustom(); } }, name));
  const toneVals = [undefined, 'light', 'dark'];
  const readout = h('p', { class: 'hint', role: 'status' });
  const strip = h('div', { class: 'strip', 'aria-hidden': 'true' });

  function setKind(k) {
    if (k === custom.bg.kind) return;
    custom.bg = k === 'gradient' ? { kind: 'gradient', a: custom.bg.a, b: custom.accent, angle: 135 } : { kind: 'solid', a: custom.bg.a };
    if (k === 'solid' && editing === 'b') editing = 'a';
    applyCustom(); refreshCustomUi();
  }
  function refreshCustomUi() {
    const slots = SLOTS.filter((s) => !s.only || s.only());
    chips.replaceChildren(...slots.map((s) => h('button', { type: 'button', role: 'radio', 'aria-checked': String(s.key === editing), class: 'chip' + (s.key === editing ? ' on' : ''),
      onclick: () => { editing = s.key; wheel.set(s.get()); refreshCustomUi(); } },
      h('i', { style: `background:${s.get()}` }), s.label())));
    kindBtns.forEach((b, i) => { const on = (i ? 'gradient' : 'solid') === custom.bg.kind; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    toneBtns.forEach((b, i) => { const on = toneVals[i] === custom.tone; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    angleRow.hidden = custom.bg.kind !== 'gradient';
    angle.value = String(custom.bg.angle ?? 135);
    strip.style.background = resolve(custom).vars['--page'];
    const r = readability(custom);
    readout.textContent = r >= 4.5 ? `Text is easy to read on this background (${r.toFixed(1)}:1).` : `Text may be hard to read on this background (${r.toFixed(1)}:1). Try a lighter or darker background, or change the text colour above.`;
    readout.classList.toggle('error', r < 4.5);
  }
  function applyCustom() {
    const theme = parseTheme({ preset: 'custom', custom });
    setTheme(theme); save(theme); markPresets(); refreshCustomUi();
  }
  // When the active theme changes (a preset click), the editor starts from that look.
  function loadCustomFromTheme() {
    custom = toCustom(shown(), prefersDark()).custom;
    if (custom.bg.kind !== 'gradient' && editing === 'b') editing = 'a';
    wheel.set(SLOTS.find((s) => s.key === editing).get());
    refreshCustomUi();
  }

  const reset = h('button', { type: 'button', class: 'btn sm', onclick: async () => {
    setTheme(null); loadCustomFromTheme(); markPresets();
    try { await api('/api/me/theme', { method: 'DELETE' }); saveState.textContent = 'Back to the default look'; } catch (err) { toast(errText(err)); }
  } }, 'Reset to default');

  markPresets();
  refreshCustomUi();
  return section('apH', 'Appearance',
    h('p', { class: 'hint' }, 'Pick a look and it changes the whole app right away. It’s saved to your account, so it follows you to other devices.'),
    h('div', { class: 'set-head' }, h('h3', { style: 'margin:0' }, 'Presets'), saveState),
    grid,
    h('h3', {}, 'Make your own'),
    h('p', { class: 'hint' }, 'Choose a solid colour or a gradient, then tap a colour below and drag on the wheel. The preview is the real page, so you’ll see it change as you go.'),
    h('div', { class: 'tabs seg', role: 'radiogroup', 'aria-label': 'Background style' }, kindBtns),
    chips,
    wheel.el,
    angleRow,
    strip,
    h('h3', {}, 'Text style'),
    h('div', { class: 'tabs seg', role: 'radiogroup', 'aria-label': 'Text style' }, toneBtns),
    readout,
    h('div', { class: 'set-actions' }, reset));
}

/* =====================================================================================
   Sign-in & contact: change email / phone with a code sent to the new one
   ===================================================================================== */
function contactRow(channel) {
  const isEmail = channel === 'email';
  const label = isEmail ? 'Gmail / email' : 'Mobile number';
  const row = h('div', { class: 'contact' });
  let step = 'view'; // view | enter | code
  let pending = '';

  async function remove() {
    const ok = await confirmDialog({ title: `Remove your ${isEmail ? 'email' : 'phone number'}?`, body: `You won’t be able to sign in with it anymore. You can add one again later.`, confirmText: 'Remove', cancelText: 'Keep it' });
    if (!ok) return;
    try { await api('/api/auth/contact/' + channel, { method: 'DELETE' }); me[channel] = null; toast('Removed'); step = 'view'; render(); }
    catch (err) { toast(errText(err)); }
  }
  function render() {
    const msg = h('p', { class: 'error', role: 'alert' });
    const value = me[channel];
    const head = h('div', { class: 'contact-head' },
      h('div', {}, h('div', { class: 'sub' }, label), h('div', { class: 'name wrap' }, value || 'n/a')),
      step === 'view' ? h('div', { class: 'contact-actions' },
        h('button', { type: 'button', class: 'btn sm', onclick: () => { step = 'enter'; render(); } }, value ? 'Change' : 'Add'),
        value ? h('button', { type: 'button', class: 'link-btn danger', onclick: remove }, 'Remove') : null) : null);
    let form = null;
    if (step === 'enter') {
      const input = h('input', { id: `new-${channel}`, type: isEmail ? 'email' : 'tel', autocomplete: isEmail ? 'email' : 'tel', required: true, 'data-autofocus': '', placeholder: isEmail ? 'new@gmail.com' : '+639171234567' });
      const go = h('button', { class: 'btn sm' }, 'Send code');
      form = h('form', { class: 'contact-form' },
        h('label', { for: `new-${channel}` }, isEmail ? 'New email address' : 'New phone number (with country code)'),
        input, h('p', { class: 'hint' }, `We’ll send a 6-digit code to the new ${isEmail ? 'address' : 'number'} to make sure it’s yours.`),
        h('div', { class: 'set-actions' }, go, h('button', { type: 'button', class: 'link-btn', onclick: () => { step = 'view'; render(); } }, 'Cancel')), msg);
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); msg.textContent = ''; go.disabled = true;
        try { await api('/api/auth/contact/request', { method: 'POST', body: { channel, target: input.value } }); pending = input.value.trim(); step = 'code'; render(); }
        catch (err) { go.disabled = false; msg.textContent = errText(err); }
      });
      queueMicrotask(() => input.focus());
    } else if (step === 'code') {
      const input = h('input', { id: `code-${channel}`, inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', required: true });
      const go = h('button', { class: 'btn sm' }, 'Confirm');
      form = h('form', { class: 'contact-form' },
        h('label', { for: `code-${channel}` }, '6-digit code'), input,
        h('p', { class: 'hint' }, `Sent to ${pending}.` + (cfg.devMode ? ' (Dev mode: the code is printed in the server terminal.)' : '')),
        h('div', { class: 'set-actions' }, go, h('button', { type: 'button', class: 'link-btn', onclick: () => { step = 'enter'; render(); } }, 'Use a different one')), msg);
      form.addEventListener('submit', async (e) => {
        e.preventDefault(); msg.textContent = ''; go.disabled = true;
        try {
          const r = await api('/api/auth/contact/verify', { method: 'POST', body: { channel, target: pending, code: input.value } });
          me[channel] = r[channel]; step = 'view'; toast(`${isEmail ? 'Email' : 'Phone number'} updated`); render();
        } catch (err) { go.disabled = false; msg.textContent = errText(err); }
      });
      queueMicrotask(() => input.focus());
    }
    row.replaceChildren(...[head, form].filter(Boolean));
  }
  render();
  return row;
}

function signIn() {
  return section('siH', 'Email, phone and sign-in',
    h('p', { class: 'hint' }, 'These are the ways you can sign in. A new email or number only replaces the old one after you enter the code we send to it.'),
    contactRow('email'), contactRow('phone'),
    h('div', { class: 'contact' }, h('div', { class: 'contact-head' }, h('div', {},
      h('div', { class: 'sub' }, 'Google'),
      h('div', { class: 'name wrap' }, me.has_google ? 'Linked' : 'Not linked'),
      me.has_google ? null : h('p', { class: 'hint' }, 'Sign in once with “Continue with Google” using the same email address as above and it links automatically.')))));
}

/* =====================================================================================
   Profile details (display name + optional personal info shown on your full profile)
   ===================================================================================== */
function details() {
  const today = new Date();
  const maxDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const field = (id, label, props, { wide = false, hint = null } = {}) => {
    const input = h('input', { id, ...props });
    return { input, wrap: h('div', { class: 'detail-cell' + (wide ? ' wide' : '') }, h('label', { for: id }, label), input, hint ? h('p', { class: 'hint' }, hint) : null) };
  };
  const display = field('dName', 'Display name', { maxlength: '40', required: true, autocomplete: 'nickname', value: me.display_name }, { wide: true, hint: 'What people see in calls and chats.' });
  const first = field('dFirst', 'First name', { maxlength: '40', autocomplete: 'given-name', value: me.first_name || '' });
  const last = field('dLast', 'Last name', { maxlength: '40', autocomplete: 'family-name', value: me.last_name || '' });
  const initial = field('dInitial', 'Middle initial', { maxlength: '2', autocomplete: 'additional-name', placeholder: 'M', value: me.middle_initial || '' });
  const birthday = field('dBirthday', 'Birthday', { type: 'date', min: '1900-01-01', max: maxDay, autocomplete: 'bday', value: me.birthday || '' });
  const country = field('dCountry', 'Country', { maxlength: '60', autocomplete: 'country-name', value: me.country || '' });
  const work = field('dWork', 'Workplace', { maxlength: '80', autocomplete: 'organization', value: me.workplace || '' }, { wide: true });

  const msg = h('p', { class: 'error', role: 'alert' });
  const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save details');
  const form = h('form', { class: 'detail-form' },
    h('p', { class: 'hint' }, 'Only your display name is required. The rest is optional and shows on your full profile for other signed-in people.'),
    h('div', { class: 'detail-group' }, h('h3', {}, 'Name'), h('div', { class: 'detail-grid' }, display.wrap, first.wrap, last.wrap, initial.wrap)),
    h('div', { class: 'detail-group' }, h('h3', {}, 'About you'), h('div', { class: 'detail-grid' }, birthday.wrap, country.wrap, work.wrap)),
    msg,
    h('div', { class: 'set-actions' }, save));
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.textContent = '';
    save.disabled = true;
    try {
      const r = await api('/api/me/details', { method: 'PUT', body: {
        display_name: display.input.value, first_name: first.input.value, last_name: last.input.value, middle_initial: initial.input.value,
        birthday: birthday.input.value, country: country.input.value, workplace: work.input.value,
      } });
      Object.assign(me, r);
      user.display_name = r.display_name;
      initial.input.value = r.middle_initial || '';
      announce();
      toast('Details saved');
    } catch (err) { msg.textContent = errText(err); }
    finally { save.disabled = false; }
  });
  return section('dtH', 'Profile details', form);
}

/* =====================================================================================
   Username + security
   ===================================================================================== */
function names() {
  const msg = h('p', { class: 'error', role: 'alert' });
  const handle = h('input', { id: 'sHandle', maxlength: '20', required: true, autocomplete: 'username', spellcheck: 'false', value: me.handle });
  const handleForm = h('form', {}, h('label', { for: 'sHandle' }, 'Username'), handle,
    h('p', { class: 'hint' }, '3 to 20 letters or numbers. Friends find you with @username, and your profile link uses it. You can change it up to 5 times an hour.'),
    h('button', { class: 'btn sm' }, 'Save username'));
  handleForm.addEventListener('submit', async (e) => {
    e.preventDefault(); msg.textContent = '';
    try { const r = await api('/api/me/username', { method: 'PATCH', body: { handle: handle.value } }); me.handle = user.handle = r.handle; handle.value = r.handle; announce(); toast('Username saved'); }
    catch (err) { msg.textContent = errText(err); }
  });
  return section('prH', 'Username', handleForm, msg);
}

function security() {
  const btn = h('button', { type: 'button', class: 'btn sm', onclick: async () => {
    const ok = await confirmDialog({ title: 'Sign out of other devices?', body: 'Every other phone or computer signed in to your account will be logged out. This device stays signed in.', confirmText: 'Sign them out', cancelText: 'Cancel' });
    if (!ok) return;
    try { const r = await api('/api/auth/signout-others', { method: 'POST' }); toast(r.signedOut ? `Signed out of ${r.signedOut} other ${r.signedOut === 1 ? 'login' : 'logins'}` : 'No other devices were signed in'); }
    catch (err) { toast(errText(err)); }
  } }, 'Sign out of other devices');
  return section('seH', 'Security', h('p', { class: 'hint' }, 'Lost a phone or used a shared computer? End every other login at once.'), h('div', { class: 'set-actions' }, btn));
}

function chatPrivacy() {
  const box = h('input', { type: 'checkbox', id: 'shareAct', checked: me.share_activity });
  box.addEventListener('change', async () => {
    try {
      await api('/api/me/activity', { method: 'PUT', body: { on: box.checked } });
      window.dispatchEvent(new CustomEvent('activity-updated', { detail: box.checked }));
      toast(box.checked ? 'Read receipts and typing indicators are on' : 'Read receipts and typing indicators are off');
    } catch (err) { box.checked = !box.checked; toast(errText(err)); }
  });
  return section('chH', 'Chat privacy',
    h('label', { class: 'check-row', for: 'shareAct' }, box, h('span', {}, 'Show when I’ve read messages and when I’m typing')),
    h('p', { class: 'hint' }, 'Friends see “Seen” under their messages once you’ve opened the chat, and “typing…” while you write. It only works between friends. If you turn this off you also stop seeing it for other people.'));
}

// Browser notifications: per browser, because the permission is. Only shown while you're not looking at a Knock tab.
function notifications() {
  const status = h('p', { class: 'hint', role: 'status' });
  const toggle = h('button', { type: 'button', class: 'btn sm' });
  const test = h('button', { type: 'button', class: 'btn sm', onclick: async () => {
    if (!notify.pushOn()) return notify.test();
    try { await notify.testPush(); } catch { toast('Couldn’t send the test. Try turning notifications off and on again.'); }
  } }, 'Send a test');
  const preview = h('input', { type: 'checkbox', id: 'notifPreview', checked: notify.previewOn() });
  preview.addEventListener('change', () => notify.setPreview(preview.checked));
  const previewRow = h('label', { class: 'check-row', for: 'notifPreview' }, preview, h('span', {}, 'Show the message text in the notification'));
  function paint() {
    const perm = notify.permission();
    const on = notify.enabled();
    toggle.hidden = perm === 'unsupported' || perm === 'denied';
    test.hidden = previewRow.hidden = !on;
    toggle.textContent = on ? 'Turn off' : 'Turn on notifications';
    status.classList.remove('error');
    if (perm === 'unsupported') { status.textContent = 'This browser doesn’t support notifications.'; status.classList.add('error'); }
    else if (perm === 'denied') { status.textContent = 'Notifications are blocked for this site. Allow them in your browser’s site settings, then come back here.'; status.classList.add('error'); }
    else if (!on) status.textContent = 'Off in this browser.';
    else if (notify.pushOn()) status.textContent = 'On in this browser. You’ll get a notification for new messages and friend requests whenever you’re not on Knock, even if the tab or the browser is closed.';
    else status.textContent = 'On in this browser, but only while Knock is open in a tab or window. Push isn’t available here (it needs https, or localhost).';
  }
  toggle.addEventListener('click', async () => {
    toggle.disabled = true;
    if (notify.enabled()) notify.disable();
    else {
      const result = await notify.enable();
      if (result === 'default') toast('Notifications weren’t turned on. Choose “Allow” when your browser asks.');
    }
    toggle.disabled = false;
    paint();
  });
  paint();
  return section('ntH', 'Notifications',
    h('p', { class: 'hint' }, 'Get a browser notification when a friend or group messages you, or when you get a friend request, while you’re not looking at Knock. Messages from people who aren’t your friends (Spam) never notify. Setting your status to “Do not disturb” pauses all of them. This is a per-browser choice, so turn it on in each browser you use.'),
    status, previewRow, h('div', { class: 'set-actions' }, toggle, test));
}

function blocked() {
  const list = h('div', {}, h('p', { class: 'hint' }, 'Loading…'));
  const paint = (people) => list.replaceChildren(people.length
    ? h('ul', { class: 'rows' }, people.map((u) => h('li', { class: 'row blocked-row' },
      avatarEl(u, 34),
      h('div', { class: 'row-main' }, h('span', { class: 'name' }, u.display_name), h('span', { class: 'sub' }, '@' + u.handle)),
      h('button', { class: 'btn sm', type: 'button', 'aria-label': `Unblock ${u.display_name}`, onclick: async () => {
        try { await api('/api/blocks/' + u.id, { method: 'DELETE' }); toast(`Unblocked ${u.display_name}`); paint(people.filter((x) => x.id !== u.id)); }
        catch (err) { toast(errText(err)); }
      } }, 'Unblock'))))
    : h('p', { class: 'empty' }, 'You haven’t blocked anyone.'));
  api('/api/blocks').then((r) => paint(r.blocked)).catch((err) => list.replaceChildren(h('p', { class: 'error' }, errText(err))));
  return section('blH', 'Blocked people', h('p', { class: 'hint' }, 'Blocked people can’t message you, send you friend requests, find your profile or join a call you’re in. They aren’t told. Unblocking doesn’t bring a friendship back.'), list);
}

root.replaceChildren(appearance(), signIn(), details(), names(), chatPrivacy(), notifications(), blocked(), security());
