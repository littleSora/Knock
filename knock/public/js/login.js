import { api, errText, safeNext } from './common.js';
import { mountTopbar } from './topbar.js';

const $ = (id) => document.getElementById(id);
const go = () => location.replace(safeNext(new URLSearchParams(location.search).get('next')) || '/dashboard');

const [{ user }, cfg] = await Promise.all([api('/api/auth/me'), api('/api/config')]);
if (user) go();
mountTopbar(null);
$('devHint').hidden = !cfg.devMode;

let channel = 'phone';
let target = '';
const LABELS = {
  phone: ['Phone number', 'tel', '+63 917 123 4567', 'Include your country code, like +63 for the Philippines.'],
  email: ['Email address', 'email', 'you@gmail.com', 'Gmail or any other address works.'],
};

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === name));
  $('msg').textContent = '';
  $('verify').hidden = true;
  $('googlePane').hidden = name !== 'google';
  $('req').hidden = name === 'google';
  if (name === 'google') return initGoogle();
  channel = name;
  const [label, autocomplete, placeholder, hint] = LABELS[name];
  $('targetLabel').textContent = label;
  $('target').setAttribute('autocomplete', autocomplete);
  $('target').type = name === 'email' ? 'email' : 'tel';
  $('target').placeholder = placeholder;
  $('target').value = '';
  $('targetHint').textContent = hint;
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

$('req').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('msg').textContent = '';
  target = $('target').value.trim();
  try {
    await api('/api/auth/otp/request', { method: 'POST', body: { channel, target } });
    $('req').hidden = true;
    $('verify').hidden = false;
    $('sentTo').textContent = `We sent a 6-digit code to ${target}. It expires in 10 minutes.`;
    $('code').focus();
  } catch (err) { $('msg').textContent = errText(err); }
});
$('verify').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('msg').textContent = '';
  try {
    await api('/api/auth/otp/verify', { method: 'POST', body: { channel, target, code: $('code').value } });
    go();
  } catch (err) { $('msg').textContent = errText(err); }
});
$('back').addEventListener('click', () => showTab(channel));

let googleReady = false;
function initGoogle() {
  if (googleReady) return;
  if (!cfg.googleClientId) { $('gnote').textContent = 'Google sign-in isn’t set up on this server yet (GOOGLE_CLIENT_ID is empty).'; return; }
  googleReady = true;
  const s = document.createElement('script');
  s.src = 'https://accounts.google.com/gsi/client';
  s.async = true;
  s.onload = () => {
    window.google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      callback: async ({ credential }) => {
        try { await api('/api/auth/google', { method: 'POST', body: { credential } }); go(); }
        catch (err) { $('msg').textContent = errText(err); }
      },
    });
    window.google.accounts.id.renderButton($('gbtn'), { theme: 'outline', size: 'large', text: 'continue_with', shape: 'pill' });
  };
  document.head.append(s);
}
