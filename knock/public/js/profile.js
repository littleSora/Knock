import { api, h, errText, toast, avatarEl, friendActions } from './common.js';
import { mountTopbar } from './topbar.js';
import { safetyActions } from './safety.js';

const { user } = await api('/api/auth/me');
mountTopbar(user);
const view = document.getElementById('view');

if (!user) {
  view.replaceChildren(h('h1', { style: 'font-size:2.2rem' }, 'Log in to see profiles'), h('p', { class: 'lede' }, 'Profiles, friends and messages are for signed-in people.'), h('a', { class: 'btn primary', href: '/login?next=' + encodeURIComponent(location.pathname) }, 'Log in'));
} else {
  const handle = decodeURIComponent(location.pathname.split('/').pop());
  try {
    const { user: p, isSelf, relation: first } = await api('/api/users/' + encodeURIComponent(handle));

    const box = h('textarea', { rows: '3', maxlength: '2000', 'aria-label': `Message ${p.display_name}`, placeholder: `Message ${p.display_name}` });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!box.value.trim()) return;
      try { await api('/api/messages', { method: 'POST', body: { toId: p.id, body: box.value } }); box.value = ''; toast('Message sent'); }
      catch (err) { toast(errText(err)); }
    } }, box, h('p', { class: 'hint' }, 'Until you’re friends, your message lands in their Spam tab.'), h('button', { class: 'btn primary' }, 'Send message'));

    // Personal details the person chose to fill in (shown only when present).
    const fmtBirthday = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' }); };
    const fullName = [p.first_name, p.middle_initial && p.middle_initial + '.', p.last_name].filter(Boolean).join(' ');
    const facts = [['Name', fullName], ['Birthday', p.birthday && fmtBirthday(p.birthday)], ['Workplace', p.workplace], ['Country', p.country]].filter(([, v]) => v);
    const details = facts.length
      ? h('dl', { class: 'facts-list' }, facts.map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]))
      : isSelf ? h('p', { class: 'hint' }, 'You haven’t added any details yet.') : null;
    const editLink = isSelf ? h('a', { class: 'btn sm', href: '/profile/edit' }, 'Edit details') : null;

    const paint = (relation) => view.replaceChildren(
      h('div', { class: 'profile-head' }, avatarEl(p, 80),
        h('div', {}, h('h1', { style: 'font-size:2.4rem' }, p.display_name), h('p', { class: 'sub' }, '@' + p.handle)), h('span', { class: 'grow' }), isSelf ? null : friendActions(p, relation, paint)),
      ...[details, editLink].filter(Boolean),
      ...(isSelf ? [h('p', { class: 'lede' }, 'This is how other people see you.')]
        : [relation === 'blocked' ? h('p', { class: 'lede' }, `You blocked ${p.display_name}, so you can’t message each other. Unblock them to talk again.`) : form,
          safetyActions(p, relation, { onChange: paint })]));
    paint(first);
    document.title = `${p.display_name} · Knock`;
  } catch {
    view.replaceChildren(h('h1', { style: 'font-size:2.2rem' }, 'We can’t find that person'), h('p', { class: 'lede' }, 'Check the @handle, or use search at the top of the page.'));
  }
}
