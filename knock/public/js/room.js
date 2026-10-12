import { api, h, icon, renderCode, toast, errText } from './common.js';

const $ = (id) => document.getElementById(id);
const sessionId = location.pathname.split('/').pop().toLowerCase();
const { user } = await api('/api/auth/me');
const show = (name) => ['missing', 'lobby', 'live'].forEach((k) => ($(k).hidden = k !== name));

try { await api('/api/sessions/' + sessionId); } catch { show('missing'); throw new Error('session_not_found'); }

/* ---------- lobby: guests pick a nickname; signed-in people join under their display name ---------- */
renderCode($('lobbyCode'), sessionId);
renderCode($('miniCode'), sessionId);
show('lobby');
if (user) {
  $('nickForm').hidden = true;
  $('memberForm').hidden = false;
  $('lobbyTitle').textContent = 'Ready to join?';
  $('memberName').textContent = user.display_name;
  const joinBtn = $('memberForm').querySelector('button');
  const joinAsMember = () => {
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';
    join(user.display_name).catch((err) => { show('lobby'); $('lobbyMsg').textContent = errText(err); }).finally(() => { joinBtn.disabled = false; joinBtn.textContent = 'Join call'; });
  };
  $('memberForm').addEventListener('submit', (e) => { e.preventDefault(); joinAsMember(); });
  setTimeout(joinAsMember, 0); // no nickname to type, so go straight in (after this module finishes setting up)
} else {
  $('nick').value = localStorage.getItem('knock.nick') || '';
  $('nickForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = $('nick').value.trim();
    if (nickname) join(nickname).catch((err) => { show('lobby'); $('lobbyMsg').textContent = errText(err); });
  });
}

let local = null;
let selfId = null;
const people = new Map(); // socket id -> name, for everyone in the call (including me)
const recap = new Map(); // item id -> recap item
let socket;
let iceServers = [];
const peers = new Map();

async function getMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return null; }
  }
}

function addTile(id, name, mine, handle = null) {
  const video = h('video', { autoplay: true, playsinline: true });
  if (mine) video.muted = true;
  const avatar = h('button', { class: 'tile-avatar', type: 'button', 'aria-label': `View ${name}’s profile`, title: 'View profile', onclick: () => openProfile({ name, handle, mine }) }, [...name][0]?.toUpperCase() || '?');
  const tile = h('figure', { class: 'vtile', 'data-id': id }, video, avatar, h('figcaption', {}, mine ? `${name} (you)` : name));
  $('grid').append(tile);
  return { tile, video };
}

/* ---------- WebRTC: the newcomer sends an offer to everyone already in the room ---------- */
function makePeer(id, nickname, initiator, handle = null) {
  const pc = new RTCPeerConnection({ iceServers });
  const { tile, video } = addTile(id, nickname, false, handle);
  const peer = { pc, tile, nickname, chain: Promise.resolve() };
  peers.set(id, peer);
  if (local) local.getTracks().forEach((t) => pc.addTrack(t, local));
  else { pc.addTransceiver('audio', { direction: 'recvonly' }); pc.addTransceiver('video', { direction: 'recvonly' }); }
  pc.onicecandidate = (e) => e.candidate && socket.emit('room:signal', { to: id, data: { candidate: e.candidate } });
  pc.ontrack = (e) => { video.srcObject = e.streams[0]; };
  if (initiator) {
    peer.chain = peer.chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('room:signal', { to: id, data: { description: pc.localDescription } });
    });
  }
  return peer;
}
function dropPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  p.tile.remove();
  peers.delete(id);
}
function onSignal({ from, nickname, handle, data }) {
  const peer = peers.get(from) ?? makePeer(from, nickname, false, handle);
  peer.chain = peer.chain.then(async () => {
    const { pc } = peer;
    if (data.description) {
      await pc.setRemoteDescription(data.description);
      if (data.description.type === 'offer') {
        await pc.setLocalDescription(await pc.createAnswer());
        socket.emit('room:signal', { to: from, data: { description: pc.localDescription } });
      }
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate);
    }
  }).catch((err) => console.warn('signal error', err));
}

/* ---------- join ---------- */
async function join(nickname) {
  if (!user) localStorage.setItem('knock.nick', nickname);
  local = await getMedia();
  if (!local) toast('Camera and mic aren’t available. You can still chat and watch.');
  iceServers = (await api('/api/ice')).iceServers;
  socket = window.io();
  socket.on('connect_error', (e) => { if (e.message === 'captcha_required') location.href = '/verify?next=' + encodeURIComponent(location.pathname); });
  socket.on('room:signal', onSignal);
  socket.on('room:peer-joined', ({ id, nickname: n }) => { people.set(id, n); refreshOwners(); note(`${n} joined`); });
  socket.on('room:peer-left', ({ id }) => { note(`${people.get(id) ?? 'Someone'} left`); people.delete(id); refreshOwners(); dropPeer(id); });
  socket.on('recap:item', (item) => { recap.set(item.id, item); renderRecap(); if ($('side').hidden || $('paneRecap').hidden) $('recapBtn').classList.add('on'); });
  socket.on('recap:removed', ({ id }) => { recap.delete(id); renderRecap(); });
  socket.on('room:chat', ({ from, nickname: n, body }) => addChat(from === socket.id ? null : n, body, from === socket.id));
  socket.on('disconnect', () => toast('Connection lost. Reload the page to rejoin.'));

  const res = await new Promise((resolve) => socket.emit('room:join', { sessionId, nickname }, resolve));
  if (res.error) { local?.getTracks().forEach((t) => t.stop()); socket.close(); throw Object.assign(new Error(res.error), { code: res.error === 'room_full' ? 'room_full' : res.error }); }

  show('live');
  selfId = res.selfId;
  const myName = res.nickname || nickname; // the server decides: display name for members, nickname for guests
  people.set(selfId, myName);
  res.peers.forEach((p) => people.set(p.id, p.nickname));
  (res.recap ?? []).forEach((i) => recap.set(i.id, i));
  const mine = addTile('local', myName, true, user?.handle ?? null);
  if (local) mine.video.srcObject = local;
  res.peers.forEach((p) => makePeer(p.id, p.nickname, true, p.handle));
  wireControls();
  renderRecap();
  refreshOwners();
}

/* ---------- controls + chat ---------- */
function wireControls() {
  const toggle = (btn, tracksOf, on, off, labelOn, labelOff) => {
    btn.replaceChildren(icon(on, 22));
    btn.addEventListener('click', () => {
      const tracks = tracksOf();
      if (!tracks.length) return toast('That device isn’t available.');
      const enabled = !tracks[0].enabled;
      tracks.forEach((t) => (t.enabled = enabled));
      btn.replaceChildren(icon(enabled ? on : off, 22));
      btn.setAttribute('aria-label', enabled ? labelOn : labelOff);
      btn.classList.toggle('on', !enabled);
    });
  };
  toggle($('mic'), () => local?.getAudioTracks() ?? [], 'mic', 'micOff', 'Mute microphone', 'Unmute microphone');
  toggle($('cam'), () => local?.getVideoTracks() ?? [], 'video', 'videoOff', 'Turn camera off', 'Turn camera on');
  $('chatBtn').replaceChildren(icon('chat', 22));
  $('recapBtn').replaceChildren(icon('recap', 22));
  $('chatBtn').addEventListener('click', () => toggleSide('chat'));
  $('recapBtn').addEventListener('click', () => toggleSide('recap'));
  $('tabChat').addEventListener('click', () => toggleSide('chat', true));
  $('tabRecap').addEventListener('click', () => toggleSide('recap', true));
  $('recapForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const kind = $('recapForm').elements.kind.value;
    const body = $('recapText').value.trim();
    if (body) socket.emit('recap:add', { kind, body, ownerId: kind === 'action' ? $('recapOwner').value : null });
    $('recapText').value = '';
  });
  $('recapForm').addEventListener('change', () => syncRecapForm());
  syncRecapForm();
  $('leave').replaceChildren(icon('leave', 22));
  $('leave').addEventListener('click', () => {
    socket.emit('room:leave');
    local?.getTracks().forEach((t) => t.stop());
    [...peers.keys()].forEach(dropPeer);
    location.href = user ? '/dashboard' : '/';
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Invite link copied'); } catch { toast('Copy failed. Copy the address bar instead.'); }
  });
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (text) socket.emit('room:chat', text);
    $('chatInput').value = '';
  });
}
function addChat(name, body, mine) {
  const log = $('chatLog');
  log.append(h('div', { class: 'msg' + (mine ? ' mine' : '') }, name ? h('span', { class: 'who' }, name) : null, body));
  log.scrollTop = log.scrollHeight;
  if ($('side').hidden || $('paneChat').hidden) $('chatBtn').classList.add('on');
}
function note(text) {
  $('chatLog').append(h('div', { class: 'msg note' }, text));
}

/* ---------- side panel: Chat and Recap ---------- */
let pane = 'chat';
function toggleSide(name, keepOpen = false) {
  const side = $('side');
  if (!side.hidden && pane === name && !keepOpen) side.hidden = true;
  else { side.hidden = false; pane = name; }
  const recapOn = pane === 'recap';
  $('paneChat').hidden = recapOn;
  $('paneRecap').hidden = !recapOn;
  for (const [btn, key] of [[$('tabChat'), 'chat'], [$('tabRecap'), 'recap']]) { btn.classList.toggle('on', pane === key); btn.setAttribute('aria-selected', String(pane === key)); }
  $('chatBtn').classList.toggle('on', !side.hidden && pane === 'chat');
  $('recapBtn').classList.toggle('on', !side.hidden && pane === 'recap');
}

/* ---------- smart recap ---------- */
function syncRecapForm() {
  const action = $('recapForm').elements.kind.value === 'action';
  $('recapOwner').hidden = !action;
  $('recapText').placeholder = action ? 'What needs to happen?' : 'We decided to…';
}
function refreshOwners() {
  const sel = $('recapOwner');
  const keep = sel.value;
  sel.replaceChildren(h('option', { value: '' }, 'Owner: not assigned'), ...[...people].map(([id, name]) => h('option', { value: id }, id === selfId ? `Owner: ${name} (you)` : `Owner: ${name}`)));
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
}
function renderRecap() {
  const items = [...recap.values()];
  const row = (i) => h('div', { class: 'recap-row' + (i.done ? ' done' : '') },
    i.kind === 'action' ? h('input', { type: 'checkbox', checked: i.done, 'aria-label': `Mark done: ${i.body}`, onchange: (e) => socket.emit('recap:done', { id: i.id, done: e.target.checked }) }) : null,
    h('span', { class: 'recap-body' }, i.body, i.kind === 'action' ? h('span', { class: 'owner' }, i.owner_name ? `Owner: ${i.owner_name}` : 'No owner yet') : null),
    h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Remove', onclick: () => socket.emit('recap:remove', { id: i.id }) }, icon('x', 14)));
  const decisions = items.filter((i) => i.kind === 'decision');
  const actions = items.filter((i) => i.kind === 'action');
  $('recapList').replaceChildren(...(items.length
    ? [decisions.length ? h('h3', {}, 'Decided') : null, ...decisions.map(row), actions.length ? h('h3', {}, 'Follow-ups') : null, ...actions.map(row)]
    : [h('p', { class: 'empty' }, 'Nothing yet. Add what you decide and who owns each follow-up.')]));
}

/* ---------- profile card (tap someone's avatar) ---------- */
let closeProfile = () => {};
async function openProfile({ name, handle, mine }) {
  closeProfile();
  const opener = document.activeElement;
  const body = h('div', { class: 'pop-body' });
  const closeBtn = h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': 'Close profile', onclick: () => closeProfile() }, icon('x', 16));
  const card = h('div', { class: 'profile-pop', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Profile of ${name}` }, h('div', { class: 'pop-head' }, h('span', { class: 'grow' }), closeBtn), body);
  const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) closeProfile(); } }, card);
  const onKey = (e) => { if (e.key === 'Escape') closeProfile(); };
  closeProfile = () => { overlay.remove(); document.removeEventListener('keydown', onKey); closeProfile = () => {}; opener?.focus?.(); };
  document.addEventListener('keydown', onKey);
  document.body.append(overlay);
  closeBtn.focus();

  const head = (title, sub) => h('div', { class: 'profile-head' }, h('span', { class: 'tile avatar', 'aria-hidden': 'true' }, [...title][0]?.toUpperCase() || '?'), h('div', {}, h('h2', { style: 'font-size:1.6rem' }, title), sub ? h('p', { class: 'sub' }, sub) : null));
  if (!handle) { body.replaceChildren(head(name, 'Guest'), h('p', { class: 'hint' }, 'Joined with a nickname, so there’s no account profile to show.')); return; }
  if (!user) { body.replaceChildren(head(name), h('p', { class: 'hint' }, 'Log in to see profiles and send friend requests.'), h('a', { class: 'btn primary', href: '/login?next=' + encodeURIComponent(location.pathname) }, 'Log in')); return; }
  body.replaceChildren(head(name), h('p', { class: 'hint' }, 'Loading…'));
  try {
    const { user: p, isSelf, isFriend } = await api('/api/users/' + encodeURIComponent(handle));
    const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    let sent = isFriend;
    const req = h('button', { class: 'btn primary', type: 'button', disabled: sent }, sent ? 'Friend request sent' : 'Send friend request');
    req.addEventListener('click', async () => {
      try { await api('/api/friends/' + p.id, { method: 'POST' }); sent = true; req.disabled = true; req.textContent = 'Friend request sent'; toast(`Friend request sent to ${p.display_name}.`); }
      catch (err) { toast(errText(err)); }
    });
    body.replaceChildren(
      head(p.display_name, '@' + p.handle),
      h('dl', { class: 'facts-list' },
        h('dt', {}, 'Display name'), h('dd', {}, p.display_name),
        h('dt', {}, 'Name at signup'), h('dd', {}, p.signup_name),
        h('dt', {}, 'Account created'), h('dd', {}, fmtDate(p.created_at))),
      isSelf || mine ? h('p', { class: 'hint' }, 'This is how other people see you.') : req);
  } catch { body.replaceChildren(head(name), h('p', { class: 'error' }, 'Couldn’t load this profile. Try again.')); }
}
