import { api, h, icon, errText, toast, avatarEl, openModal } from './common.js';
import { profileButton } from './account.js';

const S = { meId: null, groups: [], friends: [], notif: { inbox: [], spam: [], friendAdds: [], badge: 0, spamUnread: 0 }, tab: 'inbox', chat: null, inCall: false, sessionId: null };
const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
const fmtStamp = (ms) => `${fmtDate(ms)} at ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
let bar, badgeEl, panels;

// Search + friends + notifications, shared by the normal top bar and the in-call bar.
function buildTools() {
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
        ? users.map((u) => h('li', { class: 'row' }, h('a', { class: 'row-main', href: '/u/' + u.handle, ...newTab() }, h('span', { class: 'name' }, u.display_name), h('span', { class: 'sub' }, '@' + u.handle))))
        : [h('li', { class: 'empty' }, 'No one found. Try their @handle.')]));
      results.hidden = false;
    }, 250);
  });

  badgeEl = h('span', { class: 'badge', hidden: true });
  panels = { friends: h('div', { class: 'panel', hidden: true }), notif: h('div', { class: 'panel', hidden: true }) };
  const friendsBtn = h('button', { class: 'icon-btn', 'aria-label': 'Friends', onclick: () => togglePanel('friends') }, icon('users'));
  const bellBtn = h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onclick: () => togglePanel('notif') }, icon('bell'), badgeEl);
  return { search: h('div', { class: 'search' }, input, results), friendsBtn, bellBtn };
}
function wirePanels() {
  // Switching Inbox/Spam re-renders the panel, which detaches the clicked tab before this handler runs.
  // composedPath() is captured when the click starts, so a click inside the bar still counts as inside.
  document.addEventListener('click', (e) => { if (!e.composedPath().includes(bar)) closePanels(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanels(); });
  connect();
}
// In a call, anything that would navigate (profiles, call invites) opens in a new tab so you never drop out of the call.
const newTab = () => (S.inCall ? { target: '_blank', rel: 'noopener' } : {});

export function mountTopbar(user) {
  bar = document.getElementById('topbar');
  S.meId = user?.id ?? null;
  const brand = h('a', { class: 'brand', href: user ? '/dashboard' : '/' }, h('span', { class: 'brand-mark' }, 'K'), 'Knock');
  if (!user) {
    bar.replaceChildren(brand, h('nav', { class: 'bar-right' }, h('a', { class: 'btn ghost sm', href: '/login' }, 'Log in'), h('a', { class: 'btn sm', href: '/login' }, 'Sign up')));
    return;
  }
  const { search, friendsBtn, bellBtn } = buildTools();
  const logout = h('button', { class: 'btn ghost sm', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; } }, 'Log out');
  bar.replaceChildren(brand, h('nav', { class: 'bar-right' }, search, friendsBtn, bellBtn, logout, profileButton(user), panels.friends, panels.notif));
  wirePanels();
}

/**
 * The top-right tools inside a call: find people, friends, notifications and direct messages, with the
 * "Copy invite link" button right next to them. `nav` already holds that button; `sessionId` is this call, so
 * "Invite to call" in a chat sends this call's link instead of starting a different one.
 */
export function mountRoomTools(nav, user, sessionId) {
  bar = nav;
  S.meId = user?.id ?? null;
  S.inCall = true;
  S.sessionId = sessionId;
  document.body.classList.add('in-call');
  const { search, friendsBtn, bellBtn } = buildTools();
  const copy = nav.querySelector('#copy');
  nav.replaceChildren(search, friendsBtn, bellBtn, copy, profileButton(user), panels.friends, panels.notif);
  wirePanels();
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
async function refreshGroups() { S.groups = (await api('/api/groups').catch(() => ({ groups: [] }))).groups; renderFriends(); }

function friendRow(f) {
  return h('li', { class: 'row' },
    h('button', { class: 'link-btn danger', 'aria-label': `Unfriend ${f.display_name}`, onclick: () => unfriend(f) }, 'Unfriend'),
    h('button', { class: 'row-main', onclick: () => openChat(f) }, h('span', { class: 'name' }, f.display_name), h('span', { class: 'sub' }, '@' + f.handle)),
    h('span', { class: 'dot ' + (f.online ? 'on' : 'off'), role: 'img', 'aria-label': f.online ? 'Online' : 'Offline' }));
}
const groupRow = (g) => h('li', { class: 'row' },
  h('button', { class: 'row-main', onclick: () => openGroupChat(g) }, h('span', { class: 'name' }, g.name), h('span', { class: 'sub' }, `${g.member_count} members`)));
function renderFriends() {
  if (!panels) return;
  const group = (label, list) => list.length ? [h('h3', {}, `${label} (${list.length})`), h('ul', { class: 'rows' }, list.map(friendRow))] : [];
  panels.friends.replaceChildren(
    h('h2', {}, 'Friends'),
    S.friends.length ? null : h('p', { class: 'empty' }, 'No friends yet. Open someone’s profile and tap the add-friend icon.'),
    S.groups.length ? [h('h3', {}, `Groups (${S.groups.length})`), h('ul', { class: 'rows' }, S.groups.map(groupRow))] : null,
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
      h('a', { class: 'row-main', href: '/u/' + a.handle, ...newTab() }, h('span', { class: 'name' }, `${a.display_name} added you as a friend`), h('span', { class: 'sub' }, 'View profile')),
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
  const isLink = m.body.startsWith(location.origin + '/s/') && !/\s/.test(m.body); // same-origin call invite
  const here = S.inCall && isLink && m.body === `${location.origin}/s/${S.sessionId}`; // an invite to the call you're already in
  const mine = m.from_id !== other.id;
  let content = m.body;
  if (here) content = mine ? 'You invited them to this call' : 'Invited you to this call (you’re already in it)';
  else if (isLink) content = h('a', { href: m.body, rel: 'noopener', ...(S.inCall ? { target: '_blank' } : {}) }, mine ? 'Your call invite' : 'Join my call');
  return h('div', { class: 'msg' + (mine ? ' mine' : '') }, content);
}
function appendMsg(m) {
  if (!S.chat || S.chat.messages.some((x) => x.id === m.id)) return;
  S.chat.messages.push(m);
  const list = document.getElementById('chat-list');
  list.append(S.chat.group ? groupMsgEl(m) : msgEl(m, S.chat.user));
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
    h('header', {}, h('button', { class: 'name-btn', type: 'button', 'aria-haspopup': 'dialog', title: 'View profile', onclick: () => openProfileCard(u) }, u.display_name), h('span', { class: 'grow' }),
      h('button', { class: 'link-btn', onclick: () => inviteToCall(u) }, 'Invite to call'),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Close chat', onclick: () => { S.chat = null; document.getElementById('chat-dock').remove(); } }, icon('x', 16))),
    list, form));
  list.scrollTop = list.scrollHeight;
  input.focus();
  refreshNotif();
}
async function inviteToCall(u) {
  try {
    if (S.inCall) { // already in a call: send this call's link and stay here
      await api('/api/messages', { method: 'POST', body: { toId: u.id, body: `${location.origin}/s/${S.sessionId}` } });
      toast(`Invite sent to ${u.display_name}`);
      return;
    }
    const { id } = await api('/api/sessions', { method: 'POST' });
    await api('/api/messages', { method: 'POST', body: { toId: u.id, body: `${location.origin}/s/${id}` } });
    location.href = '/s/' + id;
  } catch (e) { toast(errText(e)); }
}

/* ---------- friend profile card (tap their name in a chat) ---------- */
async function openProfileCard(u) {
  if (!u.handle) return;
  const body = h('div', {}, h('p', { class: 'hint' }, 'Loading…'));
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close profile', onclick: () => m.close() }, icon('x', 16));
  const m = openModal({ label: `${u.display_name}’s profile`, wide: true }, h('div', { class: 'pop-head' }, h('span', { class: 'grow' }), closeBtn), body);
  try {
    const { user: p, isFriend } = await api('/api/users/' + encodeURIComponent(u.handle));
    const groupBtn = h('button', { class: 'btn primary sm', type: 'button', 'data-autofocus': '', onclick: () => { m.close(); openGroupCreate({ id: p.id, handle: p.handle, display_name: p.display_name, avatar_at: p.avatar_at }); } },
      h('span', { class: 'btn-ic' }, icon('users', 16)), `Create a group with ${p.display_name}`);
    body.replaceChildren(
      h('div', { class: 'profile-head', style: 'margin-top:0' }, avatarEl(p, 88), h('div', {}, h('h2', { style: 'font-size:1.6rem' }, p.display_name), h('p', { class: 'sub' }, '@' + p.handle))),
      h('dl', { class: 'facts-list' },
        h('dt', {}, 'Username'), h('dd', {}, '@' + p.handle),
        h('dt', {}, 'Name at signup'), h('dd', {}, p.signup_name),
        h('dt', {}, 'Joined'), h('dd', {}, fmtDate(p.created_at)),
        h('dt', {}, 'Friend'), h('dd', {}, isFriend ? 'Yes, in your friend list' : 'Not in your friend list')),
      h('div', { class: 'pic-actions' }, groupBtn,
        h('a', { class: 'link-btn', href: '/u/' + p.handle, ...newTab() }, 'Full profile')));
  } catch (err) { body.replaceChildren(h('p', { class: 'error' }, errText(err))); }
}

/* ---------- create a group: name it, then optionally add more friends ---------- */
function openGroupCreate(first) {
  let members = [first];
  let groupName = '';
  let view = 'main'; // 'main' | 'pick'
  const body = h('div', {});
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close', onclick: () => m.close() }, icon('x', 16));
  const m = openModal({ label: 'Create a group', wide: true }, h('div', { class: 'pop-head' }, h('strong', {}, 'New group'), h('span', { class: 'grow' }), closeBtn), body);
  refreshFriends().then(() => view === 'pick' && render()); // make sure the picker has a fresh friend list
  render();

  function render() { (view === 'pick' ? renderPick : renderMain)(); }

  function renderMain() {
    const msg = h('p', { class: 'error', role: 'alert' });
    const nameInput = h('input', { id: 'grpName', maxlength: '40', placeholder: 'Group name', autocomplete: 'off', value: groupName, 'data-autofocus': '' });
    nameInput.addEventListener('input', () => { groupName = nameInput.value; });
    const chips = h('ul', { class: 'chips', 'aria-label': 'Group members' }, members.map((f) => h('li', { class: 'chip' }, f.display_name,
      members.length > 1 ? h('button', { class: 'chip-x', type: 'button', 'aria-label': `Remove ${f.display_name}`, onclick: () => { members = members.filter((x) => x.id !== f.id); render(); } }, icon('x', 12)) : null)));
    const form = h('form', {},
      h('label', { for: 'grpName' }, 'Group name'), nameInput,
      h('h3', {}, `Members (${members.length + 1} with you)`), chips,
      h('button', { class: 'btn sm', type: 'button', onclick: () => { view = 'pick'; render(); } }, h('span', { class: 'btn-ic' }, icon('userPlus', 16)), 'Add another friend'),
      msg,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', onclick: () => m.close() }, 'Cancel'), h('button', { class: 'btn primary', type: 'submit' }, 'Create group')));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      if (!groupName.trim()) { msg.textContent = 'Give your group a name.'; nameInput.focus(); return; }
      try {
        const { group } = await api('/api/groups', { method: 'POST', body: { name: groupName.trim(), memberIds: members.map((x) => x.id) } });
        S.groups.unshift(group);
        renderFriends();
        m.close();
        toast(`Group “${group.name}” created`);
        openGroupChat(group);
      } catch (err) { msg.textContent = errText(err); }
    });
    body.replaceChildren(form);
    nameInput.focus();
  }

  function renderPick() {
    const chosen = new Set(members.map((x) => x.id));
    const available = S.friends.filter((f) => !chosen.has(f.id));
    let list;
    if (!S.friends.length) list = h('p', { class: 'empty' }, 'You don’t have any friends yet. Make a friend first: search for someone at the top of the page, open their profile and tap the add-friend icon.');
    else if (!available.length) list = h('p', { class: 'empty' }, 'Everyone on your friend list is already in this group. Make more friends to add them here.');
    else list = h('ul', { class: 'rows' }, available.map((f) => h('li', { class: 'row' },
      h('button', { class: 'row-main pick-row', type: 'button', onclick: () => { members.push(f); view = 'main'; render(); } },
        avatarEl(f, 34), h('span', { class: 'pick-text' }, h('span', { class: 'name' }, f.display_name), h('span', { class: 'sub' }, '@' + f.handle))),
      h('span', { class: 'dot ' + (f.online ? 'on' : 'off'), role: 'img', 'aria-label': f.online ? 'Online' : 'Offline' }))));
    body.replaceChildren(
      h('h3', { style: 'margin-top:0' }, 'Add a friend to the group'),
      h('p', { class: 'hint' }, 'Tap a friend to add them.'),
      list,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => { view = 'main'; render(); } }, 'Back')));
  }
}

/* ---------- group chat dock ---------- */
function groupMsgEl(m) {
  const mine = m.from_id === S.meId;
  return h('div', { class: 'msg' + (mine ? ' mine' : '') }, mine ? null : h('span', { class: 'who' }, m.from_name), m.body);
}
async function openGroupChat(g) {
  closePanels();
  let messages;
  try { ({ messages } = await api(`/api/groups/${g.id}/messages`)); } catch (e) { toast(errText(e)); return; }
  S.chat = { group: { id: g.id, name: g.name }, messages };
  document.getElementById('chat-dock')?.remove();
  const input = h('input', { type: 'text', maxlength: '2000', placeholder: `Message ${g.name}`, 'aria-label': 'Message the group', autocomplete: 'off', id: 'group-input' });
  const list = h('div', { class: 'chat-list', id: 'chat-list' }, messages.map(groupMsgEl));
  const form = h('form', { class: 'chat-form', onsubmit: async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try { appendMsg((await api(`/api/groups/${g.id}/messages`, { method: 'POST', body: { body } })).message); }
    catch (err) { toast(errText(err)); input.value = body; }
  } }, input, h('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Send' }, icon('send', 18)));
  document.body.append(h('aside', { class: 'chat-dock', id: 'chat-dock', 'aria-label': `Group chat ${g.name}` },
    h('header', {}, h('button', { class: 'name-btn', id: 'group-title', type: 'button', 'aria-haspopup': 'dialog', title: 'Group info', onclick: () => openGroupInfo(S.chat.group) }, g.name), h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Close chat', onclick: () => { S.chat = null; document.getElementById('chat-dock').remove(); } }, icon('x', 16))),
    list, form));
  list.scrollTop = list.scrollHeight;
  input.focus();
}

// Group info card: name, when it was created, who is in it, and a way to rename it.
async function openGroupInfo(g) {
  const body = h('div', {}, h('p', { class: 'hint' }, 'Loading…'));
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close group info', onclick: () => m.close() }, icon('x', 16));
  const m = openModal({ label: 'Group info', wide: true }, h('div', { class: 'pop-head' }, h('strong', {}, 'Group info'), h('span', { class: 'grow' }), closeBtn), body);
  let data;
  try { data = await api('/api/groups/' + g.id); } catch (err) { body.replaceChildren(h('p', { class: 'error' }, errText(err))); return; }
  render();

  function render() {
    const { group, members } = data;
    const msg = h('p', { class: 'error', role: 'alert' });
    const nameInput = h('input', { id: 'grpRename', maxlength: '40', required: true, autocomplete: 'off', value: group.name });
    const form = h('form', {}, h('label', { for: 'grpRename' }, 'Group name'), nameInput, h('button', { class: 'btn sm', type: 'submit' }, 'Save name'));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      msg.textContent = '';
      if (nameInput.value.trim() === group.name) return;
      try {
        const r = await api('/api/groups/' + group.id, { method: 'PATCH', body: { name: nameInput.value } });
        group.name = r.name;
        applyGroupName(group.id, r.name);
        toast('Group name changed');
        render();
      } catch (err) { msg.textContent = errText(err); }
    });
    body.replaceChildren(
      h('h2', { style: 'font-size:1.6rem;margin-top:.2rem' }, group.name),
      h('p', { class: 'sub' }, `Created ${fmtStamp(group.created_at)}`),
      h('h3', {}, `Members (${members.length})`),
      h('ul', { class: 'rows' }, members.map((u) => h('li', { class: 'row' },
        avatarEl(u, 34),
        h('div', { class: 'row-main pick-text' }, h('span', { class: 'name' }, u.id === S.meId ? `${u.display_name} (you)` : u.display_name), h('span', { class: 'sub' }, '@' + u.handle)),
        u.is_creator ? h('span', { class: 'member-tag' }, 'Creator') : null))),
      h('h3', {}, 'Change group name'), form, msg);
  }
}
function applyGroupName(id, name) {
  const g = S.groups.find((x) => x.id === id);
  if (g) g.name = name;
  if (S.chat?.group?.id === id) {
    S.chat.group.name = name;
    const t = document.getElementById('group-title');
    if (t) t.textContent = name;
    document.getElementById('group-input')?.setAttribute('placeholder', `Message ${name}`);
  }
  renderFriends();
}

/* ---------- realtime ---------- */
function connect() {
  const socket = window.io();
  socket.on('connect', () => { refreshFriends(); refreshGroups(); refreshNotif(); });
  socket.on('presence', ({ id, online }) => {
    const f = S.friends.find((x) => x.id === id);
    if (f) { f.online = online; sortFriends(); renderFriends(); }
  });
  socket.on('dm:new', (m) => {
    if (S.chat?.user?.id === m.from_id) { appendMsg(m); api('/api/messages/with/' + m.from_id).finally(refreshNotif); }
    else refreshNotif();
  });
  socket.on('dm:echo', (m) => { if (S.chat?.user?.id === m.to_id) appendMsg(m); });
  socket.on('group:new', ({ group, by }) => { if (!S.groups.some((g) => g.id === group.id)) S.groups.unshift(group); renderFriends(); toast(`${by} added you to the group “${group.name}”`); });
  socket.on('group:msg', ({ group_id: gid, group_name: gname, message }) => {
    if (S.chat?.group?.id === gid) appendMsg(message);
    else if (message.from_id !== S.meId) toast(`${message.from_name} in ${gname}: ${message.body.slice(0, 60)}`);
  });
  socket.on('group:renamed', ({ group_id: gid, name }) => applyGroupName(gid, name));
  socket.on('notif:new', () => refreshNotif());
  socket.on('connect_error', (e) => { if (e.message === 'captcha_required') location.href = '/verify?next=' + encodeURIComponent(location.pathname); });
}
