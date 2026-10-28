import { api, h, errText, toast, icon } from './common.js';
import { mountTopbar } from './topbar.js';

const { user } = await api('/api/auth/me');
if (!user) location.replace('/login?next=/profile/edit');
mountTopbar(user);
const root = document.getElementById('editView');
const { user: me } = await api('/api/me');

const today = new Date();
const maxDay = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

const field = (id, label, props) => {
  const input = h('input', { id, ...props });
  return { input, wrap: h('div', {}, h('label', { for: id }, label), input) };
};
const display = field('eDisplay', 'Display name', { maxlength: '40', required: true, autocomplete: 'nickname', value: me.display_name });
const first = field('eFirst', 'First name', { maxlength: '40', autocomplete: 'given-name', value: me.first_name || '' });
const initial = field('eInitial', 'Initial', { maxlength: '2', autocomplete: 'additional-name', placeholder: 'M', value: me.middle_initial || '' });
const last = field('eLast', 'Last name', { maxlength: '40', autocomplete: 'family-name', value: me.last_name || '' });
const birthday = field('eBirthday', 'Birthday', { type: 'date', min: '1900-01-01', max: maxDay, autocomplete: 'bday', value: me.birthday || '' });
const work = field('eWork', 'Workplace', { maxlength: '80', autocomplete: 'organization', placeholder: 'Where do you work?', value: me.workplace || '' });
const country = field('eCountry', 'Country', { maxlength: '60', autocomplete: 'country-name', value: me.country || '' });

const msg = h('p', { class: 'error', role: 'alert' });
const save = h('button', { class: 'btn primary', type: 'submit' }, 'Save details');
const view = h('a', { class: 'btn', href: '/u/' + encodeURIComponent(me.handle) }, 'View my full profile');

const form = h('form', {},
  display.wrap,
  h('div', { class: 'field-row' }, first.wrap, initial.wrap, last.wrap),
  birthday.wrap, work.wrap, country.wrap,
  msg,
  h('div', { class: 'pic-actions' }, save, view));

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  save.disabled = true;
  try {
    const r = await api('/api/me/details', { method: 'PUT', body: {
      display_name: display.input.value, first_name: first.input.value, middle_initial: initial.input.value,
      last_name: last.input.value, birthday: birthday.input.value, workplace: work.input.value, country: country.input.value,
    } });
    user.display_name = r.display_name;
    initial.input.value = r.middle_initial || '';
    window.dispatchEvent(new Event('profile-updated'));
    toast('Details saved');
  } catch (err) { msg.textContent = errText(err); }
  finally { save.disabled = false; }
});
root.replaceChildren(form);
