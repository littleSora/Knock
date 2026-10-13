import { api, h, icon, errText, toast, avatarEl, openModal, confirmDialog, friendActions } from './common.js';
import { safetyActions, openReport } from './safety.js';
import { profileButton } from './account.js';

const S = { meId: null, groups: [], friends: [], notif: { inbox: [], spam: [], requests: [], accepted: [], groups: [], badge: 0, spamUnread: 0 }, tab: 'inbox', chat: null, groupInfo: null, chats: [], inCall: false, sessionId: null, share: true, typing: new Map(), typingTarget: null, typingSentAt: 0 };
const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
const fmtStamp = (ms) => `${fmtDate(ms)} at ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
let bar, badgeEl, chatBadgeEl, panels, sock;

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
  chatBadgeEl = h('span', { class: 'badge', hidden: true });
  panels = { friends: h('div', { class: 'panel', hidden: true }), chats: h('div', { class: 'panel', hidden: true }), notif: h('div', { class: 'panel', hidden: true }) };
  const friendsBtn = h('button', { class: 'icon-btn', 'aria-label': 'Friends', onclick: () => togglePanel('friends') }, icon('users'));
  const chatsBtn = h('button', { class: 'icon-btn', 'aria-label': 'Chats', title: 'Chats', onclick: () => togglePanel('chats') }, icon('messages'), chatBadgeEl);
  const bellBtn = h('button', { class: 'icon-btn', 'aria-label': 'Notifications', onclick: () => togglePanel('notif') }, icon('bell'), badgeEl);
  return { search: h('div', { class: 'search' }, input, results), friendsBtn, chatsBtn, bellBtn };
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
  const { search, friendsBtn, chatsBtn, bellBtn } = buildTools();
  const logout = h('button', { class: 'btn ghost sm', onclick: async () => { await api('/api/auth/logout', { method: 'POST' }); location.href = '/'; } }, 'Log out');
  bar.replaceChildren(brand, h('nav', { class: 'bar-right' }, search, friendsBtn, chatsBtn, bellBtn, logout, profileButton(user), panels.friends, panels.chats, panels.notif));
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
  const { search, friendsBtn, chatsBtn, bellBtn } = buildTools();
  const copy = nav.querySelector('#copy');
  nav.replaceChildren(search, friendsBtn, chatsBtn, bellBtn, copy, profileButton(user), panels.friends, panels.chats, panels.notif);
  wirePanels();
}

function closePanels() { Object.values(panels).forEach((p) => (p.hidden = true)); bar.querySelector('.search-results').hidden = true; }
function togglePanel(name) {
  const opening = panels[name].hidden;
  closePanels();
  if (!opening) return;
  panels[name].hidden = false;
  if (name === 'chats') { renderChats(); refreshChats(); }
  else if (name === 'friends') { renderFriends(); refreshFriends(); refreshGroups(); } // always show the server's current online/offline status
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
const groupUnread = (id) => S.notif.groups.find((x) => x.id === id)?.unread || 0;
const countText = (n) => (n > 9 ? '9+' : String(n));
const groupRow = (g) => {
  const n = groupUnread(g.id);
  return h('li', { class: 'row' },
    h('button', { class: 'row-main', onclick: () => openGroupChat(g) }, h('span', { class: 'name' }, g.name), h('span', { class: 'sub' }, `${g.member_count} members`)),
    n ? h('span', { class: 'count-pill', role: 'img', 'aria-label': `${n} unread` }, countText(n)) : null);
};
function renderFriends() {
  if (!panels) return;
  const section = (label, list, row) => (list.length ? [h('h3', {}, `${label} (${list.length})`), h('ul', { class: 'rows' }, list.map(row))] : []);
  panels.friends.replaceChildren(...[
    // Groups sit above Friends and are hidden entirely until you're in one.
    ...(S.groups.length ? [h('h2', {}, 'Groups'), h('ul', { class: 'rows' }, S.groups.map(groupRow))] : []),
    h('h2', {}, 'Friends'),
    ...(S.friends.length ? [] : [h('p', { class: 'empty' }, 'No friends yet. Open someone’s profile and tap Add friend.')]),
    ...section('Online', S.friends.filter((f) => f.online), friendRow),
    ...section('Offline', S.friends.filter((f) => !f.online), friendRow),
  ]);
}
async function unfriend(f) {
  if (!confirm(`Remove ${f.display_name} from your friends?`)) return;
  await api('/api/friends/' + f.id, { method: 'DELETE' }).catch((e) => toast(errText(e)));
  S.friends = S.friends.filter((x) => x.id !== f.id);
  renderFriends();
}

/* ---------- notifications: Inbox (friends) and Spam (everyone else) ---------- */
const sumUnread = (list) => list.reduce((n, t) => n + t.unread, 0);
// Recomputed locally too, so pressing an unread item clears it instantly instead of after a round trip.
function paintBadge() {
  const n = S.notif;
  n.badge = sumUnread(n.inbox) + sumUnread(n.groups) + n.requests.filter((r) => !r.seen_at).length + n.accepted.filter((a) => !a.read_at).length;
  n.spamUnread = sumUnread(n.spam);
  badgeEl.textContent = n.badge > 9 ? '9+' : n.badge;
  badgeEl.hidden = !n.badge;
}
async function markAllRead() {
  try { await api('/api/notifications/read-all', { method: 'POST' }); } catch (e) { toast(errText(e)); }
  refreshNotif();
}
async function refreshNotif() {
  S.notif = await api('/api/notifications');
  paintBadge();
  refreshChats();
  if (!panels.notif.hidden) renderNotif();
  if (!panels.friends.hidden) renderFriends();
}
const threadRow = (t) => h('li', { class: 'row' },
  h('button', { class: 'row-main', onclick: () => { t.unread = 0; paintBadge(); openChat(t); } }, h('span', { class: 'name' }, t.display_name), h('span', { class: 'sub' }, t.body)),
  t.unread ? h('span', { class: 'dot new', role: 'img', 'aria-label': `${t.unread} unread` }) : null);
// A friend request with Accept / Decline right in the bell.
function requestRow(r) {
  const act = async (verb, message) => {
    try {
      await api(`/api/friends/requests/${r.id}/${verb}`, { method: 'POST' });
      if (message) toast(message);
    } catch (e) { toast(errText(e)); }
    refreshNotif();
    refreshFriends();
  };
  return h('li', { class: 'row request-row' },
    avatarEl(r, 34),
    h('div', { class: 'row-main pick-text' },
      h('a', { class: 'name', href: '/u/' + r.handle, ...newTab() }, r.display_name),
      h('span', { class: 'sub' }, 'wants to be your friend'),
      h('span', { class: 'request-btns' },
        h('button', { class: 'btn primary sm', type: 'button', onclick: () => act('accept', `You and ${r.display_name} are now friends.`) }, 'Accept'),
        h('button', { class: 'btn sm', type: 'button', onclick: () => act('decline') }, 'Decline'))),
    r.seen_at ? null : h('span', { class: 'dot new', role: 'img', 'aria-label': 'New' }));
}
function renderNotif() {
  const n = S.notif;
  const tab = (id, label, count) => h('button', { class: 'tab' + (S.tab === id ? ' on' : ''), role: 'tab', 'aria-selected': String(S.tab === id), onclick: () => { S.tab = id; renderNotif(); } }, label, count ? h('span', { class: 'count' }, count) : null);
  let body;
  if (S.tab === 'inbox') {
    const requests = n.requests.map(requestRow);
    const accepted = n.accepted.map((a) => h('li', { class: 'row' },
      h('a', { class: 'row-main', href: '/u/' + a.handle, ...newTab() }, h('span', { class: 'name' }, `${a.display_name} accepted your friend request`), h('span', { class: 'sub' }, 'View profile')),
      a.read_at ? null : h('span', { class: 'dot new', role: 'img', 'aria-label': 'New' })));
    const groups = n.groups.map((g) => h('li', { class: 'row' },
      h('button', { class: 'row-main', onclick: () => { g.unread = 0; S.notif.groups = S.notif.groups.filter((x) => x !== g); paintBadge(); openGroupChat(g); } }, h('span', { class: 'name' }, g.name), h('span', { class: 'sub' }, `${g.from_name}: ${g.body}`)),
      h('span', { class: 'count-pill', role: 'img', 'aria-label': `${g.unread} unread` }, countText(g.unread))));
    const rows = [...requests, ...accepted, ...groups, ...n.inbox.filter((t) => t.unread > 0).map(threadRow)]; // read conversations live in Chats
    body = rows.length ? h('ul', { class: 'rows' }, rows) : h('p', { class: 'empty' }, 'Nothing new. Unread messages and friend requests show up here; read conversations are under Chats.');
  } else {
    body = n.spam.length ? [h('p', { class: 'hint' }, 'Messages from people who aren’t on your friend list.'), h('ul', { class: 'rows' }, n.spam.map(threadRow))] : h('p', { class: 'empty' }, 'No spam. Messages from people you haven’t added land here.');
  }
  panels.notif.replaceChildren(...[
    h('div', { class: 'tabs', role: 'tablist' }, tab('inbox', 'Inbox', n.badge), tab('spam', 'Spam', n.spamUnread)),
    n.badge || n.spamUnread ? h('div', { class: 'panel-tools' }, h('button', { class: 'link-btn', type: 'button', onclick: markAllRead }, 'Mark all as read')) : null,
    body,
  ].flat().filter(Boolean)); // (replaceChildren would print null/arrays as text)
}

/* ---------- chats panel: all your conversations, newest first, plus a way to start a new one ---------- */
async function refreshChats() {
  try { S.chats = (await api('/api/chats')).chats; } catch { return; }
  const unread = S.chats.reduce((n, c) => n + c.unread, 0);
  chatBadgeEl.textContent = countText(unread);
  chatBadgeEl.hidden = !unread;
  if (!panels.chats.hidden) renderChats();
}
const shortWhen = (ms) => {
  const d = new Date(ms);
  return d.toDateString() === new Date().toDateString() ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};
const previewOf = (c) => {
  if (c.preview == null) return 'No messages yet';
  const text = c.preview.startsWith(location.origin + '/s/') && !/\s/.test(c.preview) ? 'Call invite' : c.preview;
  const who = c.type === 'group' ? (c.mine ? 'You: ' : `${c.from_name}: `) : c.mine ? 'You: ' : '';
  return who + text;
};
function chatRow(c) {
  const open = () => (c.type === 'group' ? openGroupChat({ id: c.id, name: c.name }) : openChat({ id: c.id, handle: c.handle, display_name: c.display_name, avatar_at: c.avatar_at }));
  const title = c.type === 'group' ? c.name : c.display_name;
  return h('li', { class: 'row' },
    c.type === 'group' ? h('span', { class: 'pic', style: '--s:34px', 'aria-hidden': 'true' }, icon('users', 18)) : avatarEl(c, 34),
    h('button', { class: 'row-main chat-row', onclick: open },
      h('span', { class: 'name' }, title, c.type === 'group' ? h('span', { class: 'sub', style: 'margin-left:.4rem' }, `${c.member_count} members`) : null),
      h('span', { class: 'sub' + (c.unread ? ' strong' : '') }, previewOf(c))),
    h('span', { class: 'chat-meta' }, h('span', { class: 'sub' }, shortWhen(c.at)),
      c.unread ? h('span', { class: 'count-pill', role: 'img', 'aria-label': `${c.unread} unread` }, countText(c.unread)) : null));
}
function renderChats() {
  const withChat = new Set(S.chats.filter((c) => c.type === 'dm').map((c) => c.id));
  const fresh = S.friends.filter((f) => !withChat.has(f.id)); // friends you haven't talked to yet
  panels.chats.replaceChildren(...[
    h('h2', {}, 'Chats'),
    S.chats.length ? h('ul', { class: 'rows' }, S.chats.map(chatRow)) : h('p', { class: 'empty' }, 'No chats yet. Pick a friend below to say hi.'),
    ...(fresh.length ? [h('h3', {}, 'Start a new chat'), h('ul', { class: 'rows' }, fresh.map((f) => h('li', { class: 'row' },
      avatarEl(f, 34),
      h('button', { class: 'row-main', onclick: () => openChat(f) }, h('span', { class: 'name' }, f.display_name), h('span', { class: 'sub' }, '@' + f.handle)),
      h('span', { class: 'dot ' + (f.online ? 'on' : 'off'), role: 'img', 'aria-label': f.online ? 'Online' : 'Offline' }))))]
      : S.friends.length ? [] : [h('p', { class: 'hint' }, 'Add a friend to start a conversation.')]),
  ]);
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
  const t = S.typing.get(m.from_id); // their message arrived, so "typing…" is over
  if (t) { clearTimeout(t.timer); S.typing.delete(m.from_id); paintTyping(); }
  renderChatList(true);
}

/* ---------- "Seen" receipts and typing indicators ---------- */
// Redraws the open chat. The "Sent / Seen" line sits under the last message you sent.
function renderChatList(stick) {
  const list = document.getElementById('chat-list');
  if (!list || !S.chat) return;
  const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  const g = S.chat.group;
  const msgs = S.chat.messages;
  const mine = (m) => (g ? m.from_id === S.meId && m.kind !== 'system' : m.from_id !== S.chat.user.id);
  const els = msgs.map((m) => (g ? groupMsgEl(m) : msgEl(m, S.chat.user)));
  const last = msgs.findLastIndex(mine);
  const r = last >= 0 ? receiptEl(msgs[last]) : null;
  if (r) els.splice(last + 1, 0, r);
  list.replaceChildren(...els);
  if (stick || atBottom) list.scrollTop = list.scrollHeight;
}
function receiptEl(m) {
  if (!S.share) return null; // if you keep yours private you don't see anyone's either
  const c = S.chat;
  let text;
  if (c.group) {
    const reads = c.reads || [];
    const seen = reads.filter((r) => r.last_read_id != null && r.last_read_id >= m.id);
    text = !seen.length ? 'Sent' : seen.length === reads.length ? 'Seen by everyone'
      : 'Seen by ' + (seen.length > 2 ? `${seen[0].name}, ${seen[1].name} +${seen.length - 2}` : seen.map((r) => r.name).join(', '));
  } else text = m.read_at ? `Seen ${shortWhen(m.read_at)}` : 'Sent';
  return h('div', { class: 'receipt' }, text);
}
function typingText() {
  const names = [...S.typing.values()].map((t) => t.name);
  if (!names.length) return '';
  if (names.length === 1) return `${names[0]} is typing`;
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`;
  return 'Several people are typing';
}
function paintTyping() {
  const el = document.getElementById('chat-status');
  if (!el) return;
  const text = S.share ? typingText() : '';
  el.replaceChildren(...(text ? [h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), text + '…'] : []));
}
function clearTyping() { S.typing.forEach((t) => clearTimeout(t.timer)); S.typing.clear(); paintTyping(); }
// Tell the other side we're typing (at most every 2.5 s while keys are pressed; they hide it after 5 s of silence).
function wireTyping(input, target) {
  stopTyping();
  clearTyping();
  S.typingTarget = target;
  input.addEventListener('input', () => {
    if (!S.share || !sock?.connected) return;
    if (!input.value.trim()) return stopTyping();
    const now = Date.now();
    if (now - S.typingSentAt > 2500) { S.typingSentAt = now; sock.emit('typing', { ...target, on: true }); }
  });
  input.addEventListener('blur', stopTyping);
}
function stopTyping() {
  if (S.typingSentAt && S.typingTarget && sock?.connected) sock.emit('typing', { ...S.typingTarget, on: false });
  S.typingSentAt = 0;
}
function closeChat() { stopTyping(); clearTyping(); S.chat = null; document.getElementById('chat-dock')?.remove(); }

async function openChat(u, { focus = true } = {}) {
  if (focus) closePanels();
  const { messages } = await api('/api/messages/with/' + u.id);
  stopTyping();
  S.chat = { user: { id: u.id, display_name: u.display_name }, messages };
  document.getElementById('chat-dock')?.remove();
  const input = h('input', { type: 'text', maxlength: '2000', placeholder: `Message ${u.display_name}`, 'aria-label': 'Message', autocomplete: 'off' });
  const list = h('div', { class: 'chat-list', id: 'chat-list' });
  const form = h('form', { class: 'chat-form', onsubmit: async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    stopTyping();
    try { appendMsg((await api('/api/messages', { method: 'POST', body: { toId: u.id, body } })).message); }
    catch (err) { toast(errText(err)); input.value = body; }
  } }, input, h('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Send' }, icon('send', 18)));
  document.body.append(h('aside', { class: 'chat-dock', id: 'chat-dock', 'aria-label': `Chat with ${u.display_name}` },
    h('header', {}, h('button', { class: 'name-btn', type: 'button', 'aria-haspopup': 'dialog', title: 'View profile', onclick: () => openProfileCard(u) }, u.display_name), h('span', { class: 'grow' }),
      h('button', { class: 'link-btn', onclick: () => inviteToCall(u) }, 'Invite to call'),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Close chat', onclick: closeChat }, icon('x', 16))),
    list, h('div', { class: 'chat-status', id: 'chat-status', role: 'status' }), form));
  wireTyping(input, { to: u.id });
  renderChatList(true);
  if (focus) input.focus();
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
    const { user: p, relation: first } = await api('/api/users/' + encodeURIComponent(u.handle));
    const paint = (relation) => {
      const groupBtn = h('button', { class: 'btn primary sm', type: 'button', onclick: () => { m.close(); openGroupCreate({ id: p.id, handle: p.handle, display_name: p.display_name, avatar_at: p.avatar_at }); } },
        h('span', { class: 'btn-ic' }, icon('users', 16)), `Create a group with ${p.display_name}`);
      body.replaceChildren(
        h('div', { class: 'profile-head', style: 'margin-top:0' }, avatarEl(p, 88), h('div', {}, h('h2', { style: 'font-size:1.6rem' }, p.display_name), h('p', { class: 'sub' }, '@' + p.handle))),
        h('dl', { class: 'facts-list' },
          h('dt', {}, 'Username'), h('dd', {}, '@' + p.handle),
          h('dt', {}, 'Name at signup'), h('dd', {}, p.signup_name),
          h('dt', {}, 'Joined'), h('dd', {}, fmtDate(p.created_at)),
          h('dt', {}, 'Friend'), h('dd', {}, { friend: 'Yes, you’re friends', outgoing: 'Friend request sent', incoming: 'Wants to be your friend', blocked: 'Blocked' }[relation] || 'Not friends yet')),
        // Add friend / Request sent / Accept + Decline live here, so a chat with someone you're not friends with can fix that.
        relation === 'self' ? null : friendActions(p, relation, (next) => { paint(next); refreshFriends(); refreshNotif(); }),
        h('div', { class: 'pic-actions' },
          relation === 'friend' ? groupBtn : null, // groups can only include friends
          h('a', { class: 'btn primary sm', href: '/u/' + p.handle, ...newTab() }, h('span', { class: 'btn-ic' }, icon('users', 16)), 'Full profile')),
        relation === 'self' ? null : safetyActions(p, relation, { context: { type: 'dm' }, onChange: (next) => {
          if (next === 'blocked' && S.chat?.user.id === p.id) closeChat(); // a blocked person's chat closes
          paint(next); refreshFriends(); refreshNotif();
        } }));
      (body.querySelector('.friend-actions button, .pic-actions button') || closeBtn).setAttribute('data-autofocus', '');
    };
    paint(first);
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
  if (m.kind === 'system') return h('div', { class: 'msg note' }, m.body);
  const mine = m.from_id === S.meId;
  return h('div', { class: 'msg' + (mine ? ' mine' : '') }, mine ? null : h('span', { class: 'who' }, m.from_name), m.body);
}
async function openGroupChat(g, { focus = true } = {}) {
  if (focus) closePanels();
  let messages, reads;
  try { ({ messages, reads } = await api(`/api/groups/${g.id}/messages`)); } catch (e) { toast(errText(e)); return; }
  stopTyping();
  S.chat = { group: { id: g.id, name: g.name }, messages, reads: reads || [] };
  document.getElementById('chat-dock')?.remove();
  const input = h('input', { type: 'text', maxlength: '2000', placeholder: `Message ${g.name}`, 'aria-label': 'Message the group', autocomplete: 'off', id: 'group-input' });
  const list = h('div', { class: 'chat-list', id: 'chat-list' });
  const form = h('form', { class: 'chat-form', onsubmit: async (e) => {
    e.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    stopTyping();
    try { appendMsg((await api(`/api/groups/${g.id}/messages`, { method: 'POST', body: { body } })).message); }
    catch (err) { toast(errText(err)); input.value = body; }
  } }, input, h('button', { class: 'btn primary', type: 'submit', 'aria-label': 'Send' }, icon('send', 18)));
  document.body.append(h('aside', { class: 'chat-dock', id: 'chat-dock', 'aria-label': `Group chat ${g.name}` },
    h('header', {}, h('button', { class: 'name-btn', id: 'group-title', type: 'button', 'aria-haspopup': 'dialog', title: 'Group info', onclick: () => openGroupInfo(S.chat.group) }, g.name), h('span', { class: 'grow' }),
      h('button', { class: 'icon-btn sm', 'aria-label': 'Close chat', onclick: closeChat }, icon('x', 16))),
    list, h('div', { class: 'chat-status', id: 'chat-status', role: 'status' }), form));
  wireTyping(input, { group_id: g.id });
  renderChatList(true);
  if (focus) input.focus();
  refreshNotif(); // opening the chat marked it read, so its badge clears
}

// Group info card: name, when it was created, who is in it, rename, add people, remove people (creator) and leave.
async function openGroupInfo(g) {
  const body = h('div', {}, h('p', { class: 'hint' }, 'Loading…'));
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close group info', onclick: () => m.close() }, icon('x', 16));
  const m = openModal({ label: 'Group info', wide: true, onClose: () => { if (S.groupInfo?.modal === m) S.groupInfo = null; } },
    h('div', { class: 'pop-head' }, h('strong', {}, 'Group info'), h('span', { class: 'grow' }), closeBtn), body);
  let data;
  let view = 'info'; // 'info' | 'add'
  const load = async () => {
    try { data = await api('/api/groups/' + g.id); } catch (err) { body.replaceChildren(h('p', { class: 'error' }, errText(err))); return false; }
    return true;
  };
  S.groupInfo = { id: g.id, modal: m, reload: async () => { if (await load()) render(); } }; // live refresh when someone joins or leaves
  if (!(await load())) return;
  render();

  function render() { (view === 'add' ? renderAdd : renderInfo)(); }

  function renderInfo() {
    const { group, members } = data;
    const iAmCreator = group.created_by === S.meId;
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
    const removeMember = async (u) => {
      const ok = await confirmDialog({ title: `Remove ${u.display_name}?`, body: 'They will no longer see this group or its new messages.', confirmText: 'Remove' });
      if (!ok) return;
      try { await api(`/api/groups/${group.id}/members/${u.id}`, { method: 'DELETE' }); await load(); refreshGroups(); render(); toast(`${u.display_name} was removed`); }
      catch (err) { msg.textContent = errText(err); }
    };
    const leave = async () => {
      const ok = await confirmDialog({ title: `Leave “${group.name}”?`, body: 'You’ll stop getting its messages. Someone in the group will have to add you back to rejoin.', confirmText: 'Leave group' });
      if (!ok) return;
      try { await api(`/api/groups/${group.id}/members/${S.meId}`, { method: 'DELETE' }); m.close(); dropGroup(group.id); toast(`You left “${group.name}”`); }
      catch (err) { msg.textContent = errText(err); }
    };
    body.replaceChildren(
      h('h2', { style: 'font-size:1.6rem;margin-top:.2rem' }, group.name),
      h('p', { class: 'sub' }, `Created ${fmtStamp(group.created_at)}`),
      h('h3', {}, `Members (${members.length})`),
      h('ul', { class: 'rows' }, members.map((u) => h('li', { class: 'row' },
        avatarEl(u, 34),
        h('div', { class: 'row-main pick-text' }, h('span', { class: 'name' }, u.id === S.meId ? `${u.display_name} (you)` : u.display_name), h('span', { class: 'sub' }, '@' + u.handle)),
        u.is_creator ? h('span', { class: 'member-tag' }, 'Creator') : null,
        u.id !== S.meId ? h('button', { class: 'link-btn danger', type: 'button', 'aria-label': `Report ${u.display_name}`, onclick: () => openReport(u, { context: { type: 'group', id: group.id } }) }, 'Report') : null,
        iAmCreator && u.id !== S.meId ? h('button', { class: 'link-btn danger', type: 'button', 'aria-label': `Remove ${u.display_name}`, onclick: () => removeMember(u) }, 'Remove') : null))),
      h('button', { class: 'btn sm', type: 'button', onclick: () => { view = 'add'; refreshFriends().then(() => view === 'add' && render()); render(); } }, h('span', { class: 'btn-ic' }, icon('userPlus', 16)), 'Add people'),
      h('h3', {}, 'Change group name'), form, msg,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn danger', type: 'button', onclick: leave }, 'Leave group')));
  }

  function renderAdd() {
    const inGroup = new Set(data.members.map((u) => u.id));
    const available = S.friends.filter((f) => !inGroup.has(f.id));
    const msg = h('p', { class: 'error', role: 'alert' });
    const add = async (f) => {
      msg.textContent = '';
      try { await api(`/api/groups/${g.id}/members`, { method: 'POST', body: { memberIds: [f.id] } }); await load(); refreshGroups(); toast(`${f.display_name} was added`); render(); }
      catch (err) { msg.textContent = errText(err); }
    };
    let list;
    if (!S.friends.length) list = h('p', { class: 'empty' }, 'You don’t have any friends yet. Friends can be added once they accept your request.');
    else if (!available.length) list = h('p', { class: 'empty' }, 'Everyone on your friend list is already in this group.');
    else list = h('ul', { class: 'rows' }, available.map((f) => h('li', { class: 'row' },
      h('div', { class: 'row-main pick-row' }, avatarEl(f, 34), h('span', { class: 'pick-text' }, h('span', { class: 'name' }, f.display_name), h('span', { class: 'sub' }, '@' + f.handle))),
      h('button', { class: 'btn primary sm', type: 'button', onclick: () => add(f) }, 'Add'))));
    body.replaceChildren(
      h('h3', { style: 'margin-top:0' }, 'Add people to the group'),
      h('p', { class: 'hint' }, 'You can add your friends. They won’t see messages from before they joined.'),
      list, msg,
      h('div', { class: 'dialog-actions' }, h('button', { class: 'btn', type: 'button', 'data-autofocus': '', onclick: () => { view = 'info'; render(); } }, 'Back')));
  }
}
// You're no longer in this group (you left, were removed, or it was deleted): tidy up everywhere it showed.
function dropGroup(id) {
  S.groups = S.groups.filter((x) => x.id !== id);
  if (S.chat?.group?.id === id) closeChat();
  if (S.groupInfo?.id === id) S.groupInfo.modal.close();
  renderFriends();
  refreshNotif();
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
  sock = socket;
  api('/api/me').then((r) => { S.share = r.user.share_activity; }).catch(() => {});
  window.addEventListener('activity-updated', (e) => { // the switch in Settings
    S.share = e.detail;
    if (!S.share) { stopTyping(); clearTyping(); }
    renderChatList(false);
  });
  socket.on('connect', () => { refreshFriends(); refreshGroups(); refreshNotif(); });
  // The other person opened the chat: show "Seen" under everything of mine they hadn't read.
  socket.on('dm:read', ({ by, at }) => {
    if (S.chat?.user?.id !== by) return;
    S.chat.messages.forEach((m) => { if (m.from_id !== by && !m.read_at) m.read_at = at; });
    renderChatList(false);
  });
  socket.on('group:read', ({ group_id: gid, user_id: uid, name, last_read_id: last }) => {
    if (S.chat?.group?.id !== gid) return;
    const r = S.chat.reads.find((x) => x.id === uid);
    if (r) { r.last_read_id = last; r.name = name; } else S.chat.reads.push({ id: uid, name, last_read_id: last });
    renderChatList(false);
  });
  socket.on('typing', ({ from, name, group_id: gid, on }) => {
    if (!S.share || !S.chat) return;
    const here = gid != null ? S.chat.group?.id === gid : !S.chat.group && S.chat.user.id === from;
    if (!here) return;
    const old = S.typing.get(from);
    if (old) clearTimeout(old.timer);
    if (on) S.typing.set(from, { name, timer: setTimeout(() => { S.typing.delete(from); paintTyping(); }, 5000) });
    else S.typing.delete(from);
    paintTyping();
  });
  socket.on('dm:echo', () => refreshChats());
  socket.on('presence', ({ id, online }) => {
    const f = S.friends.find((x) => x.id === id);
    if (f) { f.online = online; sortFriends(); renderFriends(); }
  });
  // A new message opens its chat box by itself, unless you're already in another chat (we never swap it out
  // from under you while you type) or it's from someone who isn't your friend (that goes to Spam).
  socket.on('dm:new', (m) => {
    if (S.chat?.user?.id === m.from_id) { appendMsg(m); api('/api/messages/with/' + m.from_id).finally(refreshNotif); }
    else if (!S.chat && !m.spam) openChat({ ...m.from, id: m.from_id }, { focus: false });
    else refreshNotif();
  });
  socket.on('dm:echo', (m) => { if (S.chat?.user?.id === m.to_id) appendMsg(m); });
  // Friend requests: someone asked, answered, cancelled, or you unfriended. Refresh the lists and the bell.
  socket.on('friends:changed', () => { refreshFriends(); refreshNotif(); });
  socket.on('group:new', ({ group, by }) => { if (!S.groups.some((g) => g.id === group.id)) S.groups.unshift(group); renderFriends(); refreshNotif(); toast(`${by} added you to the group “${group.name}”`); });
  socket.on('group:msg', ({ group_id: gid, group_name: gname, message }) => {
    const open = S.chat?.group?.id === gid;
    refreshChats(); // the Chats list shows the newest message and order
    if (open) appendMsg(message);
    if (message.kind === 'system') return; // "Sam left" notes never alert
    if (open) { if (message.from_id !== S.meId) api(`/api/groups/${gid}/read`, { method: 'POST' }).finally(refreshNotif); }
    else if (message.from_id !== S.meId) {
      if (!S.chat) openGroupChat(S.groups.find((x) => x.id === gid) || { id: gid, name: gname }, { focus: false });
      else { refreshNotif(); toast(`${message.from_name} in ${gname}: ${message.body.slice(0, 60)}`); }
    }
  });
  socket.on('group:renamed', ({ group_id: gid, name }) => applyGroupName(gid, name));
  socket.on('group:members', ({ group_id: gid }) => { refreshGroups(); if (S.groupInfo?.id === gid) S.groupInfo.reload(); });
  socket.on('group:removed', ({ group_id: gid, group_name: gname, left }) => {
    if (!S.groups.some((g) => g.id === gid)) return; // already handled in this tab
    dropGroup(gid);
    if (!left) toast(`You were removed from “${gname}”`);
  });
  socket.on('notif:new', () => refreshNotif());
  socket.on('connect_error', (e) => { if (e.message === 'captcha_required') location.href = '/verify?next=' + encodeURIComponent(location.pathname); });
}
