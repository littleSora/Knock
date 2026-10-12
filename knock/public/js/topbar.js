import { api, h, icon, errText, toast } from './common.js';

const S = { friends: [], notif: { inbox: [], spam: [], friendAdds: [], badge: 0, spamUnread: 0 }, tab: 'inbox', chat: null };
let bar, badgeEl, panels;

export function mountTopbar(user) {
  bar = document.getElementById('topbar');
  const brand = h('a', { class: 'brand', href: user ? '/dashboard' : '/' }, h('span', { class: 'brand-mark' }, 'K'), 'Knock');
  if (!user) {
    bar.replaceChildren(brand, h('nav', { class: 'bar-right' }, h('a', { class: 'btn ghost sm', href: '/login' }, 'Log in'), h('a', { class: 'btn sm', href: '/login' }, 'Sign up')));
    return;
  }

  // Search -> opens a profile (that's where the add-friend icon lives)
  const results = h('ul', { class: 'search-results rows', hidden: true });
  const input = h('input', { type: 'search', placeholder: 'Find people', 'aria-label': 'Find people', autocomplete: 'off' });
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.hidden = true; return; }
      const { users } = await api('/api/users/search?q=' + encodeURIComponent(q)).catch(() => ({ users: [] }));
      results.replaceChildren(...(users.length
        ? users.map((u) => h('li', { class: 'row' }, h('a', { class: 'row-main', href: '/u/' + u.handle }, h('span', { class: 'name' }, u.display_name), h('span', { class: 'sub' }, '@' + u.handle))))
        : [h('li', { class: 'empty' }, 'No one found. Try their @handle.')]));
      results.hidden = false;
    }, 250);
  });

  badgeEl = h('span', { class: 'badge', hidden: true });
  panels = { friends: h('div', { class: 'panel', hidden: true }), notif: h('div', { class: 'panel', hidden: true }) };
  const friendsBtn = h('button', { class: 'icon-btn', 'aria-label': 'Friends', onclick: () => togglePanel('friends') }, icon('users'));
  const bellBtn = h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onclick: () => togglePanel('notif') }, icon('bell'), badgeEl);
  const logout = h('button', { class: 'btn ghost sm', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; } }, 'Log out');

  bar.replaceChildren(brand, h('nav', { class: 'bar-right' }, h('div', { class: 'search' }, input, results), friendsBtn, bellBtn, logout, panels.friends, panels.notif));
  // Switching Inbox/Spam re-renders the panel, which detaches the clicked tab before this handler runs.
  // composedPath() is captured when the click starts, so a click inside the bar still counts as inside.
  document.addEventListener('click', (e) => { if (!e.composedPath().includes(bar)) closePanels(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanels(); });
  connect();
}

function closePanels() { Object.values(panels).forEach((p) => (p.hidden = true)); bar.querySelector('.search-results').hidden = true; }
function togglePanel(name) {
  const opening = panels[name].hidden;
  closePanels();
  if (!opening) return;
  panels[name].hidden = false;
  if (name === 'friends') renderFriends();
  else { renderNotif(); api('/api/notifications/read', { method: 'POST' }).then(refreshNotif); }
}

/* ---------- friends panel: Unfriend on the left, presence dot on the right, online first ---------- */
const sortFriends = () => S.friends.sort((a, b) => b.online - a.online || a.display_name.localeCompare(b.display_name));
async function refreshFriends() { S.friends = (await api('/api/friends')).friends; renderFriends(); }

function friendRow(f) {
  return h('li', { class: 'row' },
    h('button', { class: 'link-btn danger', 'aria-label': `Unfriend ${f.display_name}`, onclick: () => unfriend(f) }, 'Unfriend'),
    h('button', { class: 'row-main', onclick: () => openChat(f) }, h('span', { class: 'name' }, f.display_name), h('span', { class: 'sub' }, '@' + f.handle)),
    h('span', { class: 'dot ' + (f.online ? 'on' : 'off'), role: 'img', 'aria-label': f.online ? 'Online' : 'Offline' }));
}
function renderFriends() {
  if (!panels) return;
  const group = (label, list) => list.length ? [h('h3', {}, `${label} (${list.length})`), h('ul', { class: 'rows' }, list.map(friendRow))] : [];
  panels.friends.replaceChildren(
    h('h2', {}, 'Friends'),
    S.friends.length ? null : h('p', { class: 'empty' }, 'No friends yet. Open someone’s profile and tap the add-friend icon.'),
    ...group('Online', S.friends.filter((f) => f.online)), ...group('Offline', S.friends.filter((f) => !f.online)));
}
async function unfriend(f) {
  if (!confirm(`Remove ${f.display_name} from your friends?`)) return;
  await api('/api/friends/' + f.id, { method: 'DELETE' }).catch((e) => toast(errText(e)));
  S.friends = S.friends.filter((x) => x.id !== f.id);
  renderFriends();
}

/* ---------- notifications: Inbox (friends) and Spam (everyone else) ---------- */
async function refreshNotif() {
  S.notif = await api('/api/notifications');
  badgeEl.textContent = S.notif.badge > 9 ? '9+' : S.notif.badge;
  badgeEl.hidden = !S.notif.badge;
  if (!panels.notif.hidden) renderNotif();
}
const threadRow = (t) => h('li', { class: 'row' },
  h('button', { class: 'row-main', onclick: () => openChat(t) }, h('span', { class: 'name' }, t.display_name), h('span', { class: 'sub' }, t.body)),
  t.unread ? h('span', { class: 'dot new', role: 'img', 'aria-label': `${t.unread} unread` }) : null);
function renderNotif() {
  const n = S.notif;
  const tab = (id, label, count) => h('button', { class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'aria-selected': String(S.tab === id), onclick: () => { S.tab = id; renderNotif(); } }, label, count ? h('span', { class: 'count' }, count) : null);
  let body;
  if (S.tab === 'inbox') {
    const adds = n.friendAdds.map((a) => h('li', { class: 'row' },
      h('a', { class: 'row-main', href: '/u/' + a.handle }, h('span', { class: 'name' }, `${a.display_name} added you as a friend`), h('span', { class: 'sub' }, 'View profile')),
      a.read_at ? null : h('span', { class: 'dot new', role: 'img', 'aria-label': 'New' })));
    const rows = [...adds, ...n.inbox.map(threadRow)];
    body = rows.length ? h('ul', { class: 'rows' }, rows) : h('p', { class: 'empty' }, 'Nothing new. Messages from your friends show up here.');
  } else {
    body = n.spam.length ? [h('p', { class: 'hint' }, 'Messages from people who aren’t on your friend list.'), h('ul', { class: 'rows' }, n.spam.map(threadRow))] : h('p', { class: 'empty' }, 'No spam. Messages from people you haven’t added land here.');
  }
  panels.notif.replaceChildren(h('div', { class: 'tabs', role: 'tablist' }, tab('inbox', 'Inbox', n.badge), tab('spam', 'Spam', n.spamUnread)), body);
}

/* ---------- direct-message dock ---------- */
function msgEl(m, other) {
  const link = m.body.startsWith(location.origin + '/s/') && !/\s/.test(m.body); // same-origin call invite
  return h('div', { class: 'msg' + (m.from_id === other.id ? '' : ' mine') }, link ? h('a', { href: m.body, rel: 'noopener' }, 'Join my call') : m.body);
}
function appendMsg(m) {
  if (!S.chat || S.chat.messages.some((x) => x.id === m.id)) return;
  S.chat.messages.push(m);
  const list = document.getElementById('chat-list');
  list.append(msgEl(m, S.chat.user));
  list.scrollTop = list.scrollHeight;
}
async function openChat(u) {
  closePanels();
  const { messages } = await api('/api/messages/with/' + u.id);
  S.chat = { user: { id: u.id, display_name: u.display_name }, messages };
  document.getElementById('chat-dock')?.remove();
  const input = h('input', { type: 'text', maxlength: '2000', placeholder: `Message ${u.display_name}`, 'aria-label': 'Message', autocomplete: 'off' });
  const list = h('div', { class: 'chat-list', id: 'chat-list' }, messages.map((m) => msgEl(m, u)));
  const form = h('form', { class: 'chat-form', onsubmit: async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try { appendMsg((await api('/api/messages', { method: 'POST', body: { toId: u.id, body } })).message); }
    catch (err) { toast(errText(err)); input.value = body; }
  } }, input, h('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Send' }, icon('send', 18)));
  document.body.append(h('aside', { class: 'chat-dock', id: 'chat-dock', 'aria-label': `Chat with ${u.display_name}` },
    h('header', {}, h('strong', {}, u.display_name), h('span', { class: 'grow' }),
      h('button', { class: 'link-btn', onclick: () => inviteToCall(u) }, 'Invite to call'),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Close chat', onclick: () => { S.chat = null; document.getElementById('chat-dock').remove(); } }, icon('x', 16))),
    list, form));
  list.scrollTop = list.scrollHeight;
  input.focus();
  refreshNotif();
}
async function inviteToCall(u) {
  try {
    const { id } = await api('/api/sessions', { method: 'POST' });
    await api('/api/messages', { method: 'POST', body: { toId: u.id, body: `${location.origin}/s/${id}` } });
    location.href = '/s/' + id;
  } catch (e) { toast(errText(e)); }
}

/* ---------- realtime ---------- */
function connect() {
  const socket = window.io();
  socket.on('connect', () => { refreshFriends(); refreshNotif(); });
  socket.on('presence', ({ id, online }) => {
    const f = S.friends.find((x) => x.id === id);
    if (f) { f.online = online; sortFriends(); renderFriends(); }
  });
  socket.on('dm:new', (m) => {
    if (S.chat?.user.id === m.from_id) { appendMsg(m); api('/api/messages/with/' + m.from_id).finally(refreshNotif); }
    else refreshNotif();
  });
  socket.on('dm:echo', (m) => { if (S.chat?.user.id === m.to_id) appendMsg(m); });
  socket.on('notif:new', () => refreshNotif());
  socket.on('connect_error', (e) => { if (e.message === 'captcha_required') location.href = '/verify?next=' + encodeURIComponent(location.pathname); });
}
