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
show(new URLSearchParams(location.search).get('mode') === 'signup' ? 'signupForm' : 'loginForm');

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

// Forgot password.
let resetEmail = '';
submit('resetReq', async () => {
  resetEmail = $('rsEmail').value.trim();
  await post('reset/request', { email: resetEmail });
  $('rsSent').textContent = `If an account uses ${resetEmail}, we sent it a 6-digit code.`;
  show('resetDo', 'reset');
});
submit('resetDo', async () => { await post('reset/verify', { email: resetEmail, code: $('rsCode').value, password: $('rsPass').value }); go(); });
