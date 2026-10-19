import { api, errText, safeNext } from './common.js';
import { mountTopbar } from './topbar.js';

const $ = (id) => document.getElementById(id);
const go = () => location.replace(safeNext(new URLSearchParams(location.search).get('next')) || '/dashboard');

const [{ user }, cfg] = await Promise.all([api('/api/auth/me'), api('/api/config')]);
if (user) go();
mountTopbar(null);
$('devHint').hidden = !cfg.devMode;

const FORMS = ['loginForm', 'signupForm', 'signupCode', 'resetReq', 'resetDo'];
const COPY = {
  login: ['Log in', 'Welcome back. Log in with the email and password you signed up with.'],
  signup: ['Create an account', 'New here? Make an account with your email. You’ll confirm it with a code we send you.'],
  reset: ['Reset your password', 'Confirm your email with a code, then choose a new password.'],
};
function show(form, copy = form === 'loginForm' ? 'login' : form.startsWith('signup') ? 'signup' : 'reset') {
  FORMS.forEach((f) => ($(f).hidden = f !== form));
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
const goToResetStep = (email) => {
  resetEmail = email;
  store.set('knock-reset-email', email);
  $('rsSent').textContent = `If an account uses ${email}, we sent it a 6-digit code. It expires in 10 minutes.`;
  show('resetDo', 'reset');
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

const submit = (id, fn) => $(id).addEventListener('submit', async (e) => {
  e.preventDefault();
  $('msg').textContent = '';
  const btn = $(id).querySelector('.btn.primary');
  btn.disabled = true;
  try { await fn(); } catch (err) { $('msg').textContent = errText(err); } finally { btn.disabled = false; }
});
const post = (path, body) => api('/api/auth/' + path, { method: 'POST', body });

// Log in: only works for an account that was created.
submit('loginForm', async () => { await post('login', { email: $('liEmail').value, password: $('liPass').value }); go(); });

// Create an account: the account is only made once the emailed code is entered.
let pendingEmail = '';
submit('signupForm', async () => {
  pendingEmail = $('suEmail').value.trim();
  await post('signup/request', { name: $('suName').value, email: pendingEmail, password: $('suPass').value });
  $('suSent').textContent = `We sent a 6-digit code to ${pendingEmail}. It expires in 10 minutes.`;
  show('signupCode', 'signup');
});
submit('signupCode', async () => { await post('signup/verify', { email: pendingEmail, code: $('suCode').value }); go(); });
$('suBack').addEventListener('click', () => show('signupForm'));

submit('resetReq', async () => {
  const email = $('rsEmail').value.trim();
  await post('reset/request', { email });
  goToResetStep(email);
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
// Ask for another code (the server allows one every 30 seconds).
let cooldown;
$('resend').addEventListener('click', async () => {
  const btn = $('resend');
  $('msg').textContent = '';
  btn.disabled = true;
  try {
    await post('reset/request', { email: resetEmail });
    $('rsSent').textContent = `We sent a new code to ${resetEmail} if an account uses it. Use the newest one.`;
  } catch (err) { $('msg').textContent = errText(err); }
  let left = 30;
  clearInterval(cooldown);
  cooldown = setInterval(() => {
    btn.textContent = left > 0 ? `Send a new code (${left--}s)` : 'Send a new code';
    if (left < 0) { clearInterval(cooldown); btn.disabled = false; }
  }, 1000);
});
// Codes are digits only: drop spaces or dashes if someone pastes "123 456".
for (const id of ['suCode', 'rsCode']) $(id).addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); });
