const params = new URLSearchParams(location.search).get('next') || '/';
const next = params.startsWith('/') && !params.startsWith('//') && !params.includes('\\') ? params : '/';
const msg = document.getElementById('msg');

async function pass(token) {
  const res = await fetch('/api/captcha', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  if (res.ok) location.replace(next);
  else { msg.textContent = 'That check didn’t pass. Tick the box again.'; window.grecaptcha?.reset(); }
}

const { siteKey, bypass } = await (await fetch('/api/captcha/site-key')).json();
if (bypass || !siteKey) {
  const dev = document.getElementById('dev');
  dev.hidden = false;
  dev.addEventListener('click', () => pass(''));
} else {
  window.onRecaptchaLoad = () => window.grecaptcha.render('captcha', { sitekey: siteKey, callback: pass });
  const s = document.createElement('script');
  s.src = 'https://www.google.com/recaptcha/api.js?onload=onRecaptchaLoad&render=explicit';
  s.async = true;
  document.head.append(s);
}
