import { api, h, icon, errText, toast } from './common.js';
import { mountTopbar } from './topbar.js';

const { user } = await api('/api/auth/me');
mountTopbar(user);
const view = document.getElementById('view');

if (!user) {
  view.replaceChildren(h('h1', { style: 'font-size:2.2rem' }, 'Log in to see profiles'), h('p', { class: 'lede' }, 'Profiles, friends and messages are for signed-in people.'), h('a', { class: 'btn primary', href: '/login?next=' + encodeURIComponent(location.pathname) }, 'Log in'));
} else {
  const handle = decodeURIComponent(location.pathname.split('/').pop());
  try {
    const { user: p, isSelf, isFriend } = await api('/api/users/' + encodeURIComponent(handle));
    let friend = isFriend;
    const friendBtn = h('button', { class: 'icon-btn', 'aria-label': 'Add friend', title: 'Add friend', 'aria-pressed': String(friend) }, icon(friend ? 'userCheck' : 'userPlus', 22));
    const paint = () => { friendBtn.replaceChildren(icon(friend ? 'userCheck' : 'userPlus', 22)); friendBtn.setAttribute('aria-pressed', String(friend)); friendBtn.setAttribute('aria-label', friend ? 'Friend added' : 'Add friend'); friendBtn.title = friendBtn.getAttribute('aria-label'); };
    friendBtn.addEventListener('click', async () => {
      if (friend) return toast('Already in your friend list. Use Unfriend in the friends panel to remove them.');
      try { await api('/api/friends/' + p.id, { method: 'POST' }); friend = true; paint(); toast(`${p.display_name} was notified that you added them.`); }
      catch (err) { toast(errText(err)); }
    });

    const box = h('textarea', { rows: '3', maxlength: '2000', 'aria-label': `Message ${p.display_name}`, placeholder: `Message ${p.display_name}` });
    const form = h('form', { onsubmit: async (e) => {
      e.preventDefault();
      if (!box.value.trim()) return;
      try { await api('/api/messages', { method: 'POST', body: { toId: p.id, body: box.value } }); box.value = ''; toast('Message sent'); }
      catch (err) { toast(errText(err)); }
    } }, box, h('p', { class: 'hint' }, 'If they haven’t added you as a friend, your message lands in their Spam tab.'), h('button', { class: 'btn primary' }, 'Send message'));

    view.replaceChildren(
      h('div', { class: 'profile-head' }, h('span', { class: 'tile avatar', 'aria-hidden': 'true' }, [...p.display_name][0] || '?'),
        h('div', {}, h('h1', { style: 'font-size:2.4rem' }, p.display_name), h('p', { class: 'sub' }, '@' + p.handle)), h('span', { class: 'grow' }), isSelf ? null : friendBtn),
      isSelf ? h('p', { class: 'lede' }, 'This is how other people see you.') : form);
    document.title = `${p.display_name} · Knock`;
  } catch {
    view.replaceChildren(h('h1', { style: 'font-size:2.2rem' }, 'We can’t find that person'), h('p', { class: 'lede' }, 'Check the @handle, or use search at the top of the page.'));
  }
}
