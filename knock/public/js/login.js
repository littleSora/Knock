import { api, errText, fmtCountdown, safeNext } from './common.js';
import { mountTopbar } from './topbar.js';

const $ = (id) => document.getElementById(id);
let lockTimer; // live "try again in m:ss" countdown after too many wrong passwords
const go = () => location.replace(safeNext(new URLSearchParams(location.search).get('next')) || '/dashboard');

const { user } = await api('/api/auth/me');
if (user) go();
mountTopbar(null);

const FORMS = ['loginForm', 'signupForm', 'signupCode', 'resetReq', 'resetDo'];
const COPY = {
  login: ['Log in', 'Welcome back. Log in with the email and password you signed up with.'],
  signup: ['Create an account', 'New here? Make an account with your email. You’ll confirm it with a code we send you.'],
  reset: ['Reset your password', 'Confirm your email with a code, then choose a new password.'],
};
function show(form, copy = form === 'loginForm' ? 'login' : form.startsWith('signup') ? 'signup' : 'reset') {
  FORMS.forEach((f) => ($(f).hidden = f !== form));
  clearInterval(lockTimer);
  $('msg').textContent = '';
  $('title').textContent = COPY[copy][0];
  $('lede').textContent = COPY[copy][1];
  $('tabs').hidden = form !== 'loginForm' && form !== 'signupForm';
  document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('on', (t.dataset.mode === 'login') === (form === 'loginForm')));
  $(form).querySelector('input')?.focus();
}
document.querySelectorAll('#tabs .tab').forEach((t) => t.addEventListener('click', () => show(t.dataset.mode === 'login' ? 'loginForm' : 'signupForm')));
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show('loginForm')));
$('forgot').addEventListener('click', () => { $('rsEmail').value = $('liEmail').value; show('resetReq'); });
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => store.set('knock-reset-email', '')));

// Forgot password. On a phone people leave to read the email and the page may reload, so the email is kept for this tab.
const store = { get: (k) => { try { return sessionStorage.getItem(k) || ''; } catch { return ''; } }, set: (k, v) => { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* storage blocked: fine */ } } };
let resetEmail = '';
const WAIT = 90; // seconds before another code can be asked for (the server enforces the same wait)
let cooldown;
function runCooldown() {
  clearInterval(cooldown);
  const tick = () => {
    const left = WAIT - Math.floor((Date.now() - Number(store.get('knock-reset-sent-at') || 0)) / 1000);
    // While waiting, show a countdown instead of the button; when it hits zero the button appears.
    $('resend').hidden = left > 0;
    $('resendTimer').hidden = left <= 0;
    $('resendTimer').textContent = `Send a new code in ${fmtCountdown(Math.max(left, 0))}`;
    if (left <= 0) clearInterval(cooldown);
  };
  tick();
  cooldown = setInterval(tick, 1000);
}
// justSent: a code was emailed a moment ago, so start the wait. Otherwise (link, reload, "I already have a code") just show the code step.
const goToResetStep = (email, justSent = false) => {
  resetEmail = email;
  store.set('knock-reset-email', email);
  if (justSent) store.set('knock-reset-sent-at', String(Date.now()));
  $('rsSent').textContent = justSent
    ? `We sent a 6-digit code to ${email}. Use the newest one if you ask for more than one.`
    : `Enter the 6-digit code we emailed to ${email}.`;
  show('resetDo', 'reset');
  runCooldown();
};

const params = new URLSearchParams(location.search);
const linkEmail = (params.get('email') || '').trim().slice(0, 254);
if (params.get('mode') === 'reset') {
  // Opened from the link in the reset email: jump straight to "enter code + new password".
  if (linkEmail) goToResetStep(linkEmail); else show('resetReq');
  history.replaceState(null, '', location.pathname); // keep the email address out of the address bar and history
} else if (store.get('knock-reset-email') && params.get('mode') !== 'signup') {
  goToResetStep(store.get('knock-reset-email'));
} else {
  show(params.get('mode') === 'signup' ? 'signupForm' : 'loginForm');
}

// When an email is locked, show how long is left and count down live.
function showError(err) {
  clearInterval(lockTimer);
  // Two errors come with a wait time: a locked email, and asking for a code too soon. Both count down live.
  const DONE = { too_many_attempts: 'You can try logging in again now.', wait_before_resend: 'You can ask for a new code now.' };
  const secs = DONE[err.code] ? err.data?.retry_after : 0;
  if (!secs) { $('msg').textContent = errText(err); return; }
  const until = Date.now() + secs * 1000;
  const tick = () => {
    const left = Math.ceil((until - Date.now()) / 1000);
    if (left <= 0) { clearInterval(lockTimer); $('msg').textContent = DONE[err.code]; return; }
    $('msg').textContent = errText({ code: err.code, data: { retry_after: left } });
  };
  tick();
  lockTimer = setInterval(tick, 1000);
}
const submit = (id, fn) => $(id).addEventListener('submit', async (e) => {
  e.preventDefault();
  clearInterval(lockTimer);
  $('msg').textContent = '';
  const btn = $(id).querySelector('.btn.primary');
  btn.disabled = true;
  try { await fn(); } catch (err) { showError(err); } finally { btn.disabled = false; }
});
const post = (path, body) => api('/api/auth/' + path, { method: 'POST', body });

// Log in: only works for an account that was created.
submit('loginForm', async () => { await post('login', { email: $('liEmail').value, password: $('liPass').value }); go(); });

// Create an account: the account is only made once the emailed code is entered.
let pendingEmail = '';
submit('signupForm', async () => {
  pendingEmail = $('suEmail').value.trim();
  const r = await post('signup/request', { name: $('suName').value, email: pendingEmail, password: $('suPass').value });
  if (r.done) return go(); // email confirmation is off in Supabase: the account is already made
  $('suSent').textContent = `We sent a 6-digit code to ${pendingEmail}. Use the newest one if you ask for more than one.`;
  show('signupCode', 'signup');
});
submit('signupCode', async () => { await post('signup/verify', { email: pendingEmail, code: $('suCode').value }); go(); });
$('suBack').addEventListener('click', () => show('signupForm'));

submit('resetReq', async () => {
  const email = $('rsEmail').value.trim();
  await post('reset/request', { email }); // errors with "no account" if nobody uses this email
  goToResetStep(email, true);
});
submit('resetDo', async () => {
  await post('reset/verify', { email: resetEmail, code: $('rsCode').value, password: $('rsPass').value });
  store.set('knock-reset-email', '');
  go();
});
// Already have a code (or the email took a while): skip to the code step.
$('haveCode').addEventListener('click', () => {
  const email = $('rsEmail').value.trim();
  if (!email || !$('rsEmail').checkValidity()) { $('msg').textContent = 'Type your email above first.'; $('rsEmail').focus(); return; }
  goToResetStep(email);
});
// Ask for another code.
$('resend').addEventListener('click', async () => {
  $('msg').textContent = '';
  $('resend').hidden = true;
  try {
    await post('reset/request', { email: resetEmail });
    store.set('knock-reset-sent-at', String(Date.now()));
    $('rsSent').textContent = `We sent a new code to ${resetEmail}. Use the newest one.`;
  } catch (err) { showError(err); if (err.code !== 'wait_before_resend') store.set('knock-reset-sent-at', '0'); }
  runCooldown();
});
// Codes are digits only: drop spaces or dashes if someone pastes "123 456".
for (const id of ['suCode', 'rsCode']) $(id).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
