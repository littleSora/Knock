import { api, renderCode, errText } from './common.js';
import { mountTopbar } from './topbar.js';

const { user } = await api('/api/auth/me');
mountTopbar(user);

const code = document.getElementById('code');
const $ = (id) => document.getElementById(id);
let current = null;
renderCode(code, null);

$('start').addEventListener('click', async () => {
  try {
    current = (await api('/api/sessions', { method: 'POST' })).id;
    renderCode(code, current, { animate: true });
    $('start').hidden = true;
    $('enter').hidden = false;
    $('copy').hidden = false;
  } catch (e) { $('joinMsg').textContent = errText(e); }
});
$('enter').addEventListener('click', () => (location.href = '/s/' + current));
$('copy').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(`${location.origin}/s/${current}`); $('copy').textContent = 'Link copied'; }
  catch { $('copy').textContent = 'Copy failed'; }
});

$('join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('joinCode').value.trim().split('/').filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  $('joinMsg').textContent = '';
  if (id.length !== 10) { $('joinMsg').textContent = 'Codes have 10 letters and numbers.'; return; }
  try { await api('/api/sessions/' + id); location.href = '/s/' + id; }
  catch (err) { $('joinMsg').textContent = errText(err); }
});
