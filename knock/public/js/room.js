import { api, h, icon, renderCode, toast, errText, avatarEl, confirmDialog, flash, friendActions, statusChip } from './common.js';
import { safetyActions } from './safety.js';
import { profileButton } from './account.js';
import { mountRoomTools } from './topbar.js';

const $ = (id) => document.getElementById(id);
const sessionId = location.pathname.split('/').pop().toLowerCase();
const { user } = await api('/api/auth/me');
const show = (name) => ['missing', 'ended', 'lobby', 'live'].forEach((k) => ($(k).hidden = k !== name));
const home = user ? '/dashboard' : '/';
$('endedHome').href = home;
$('brandLive').href = home;

let info;
try { info = await api('/api/sessions/' + sessionId); } catch { show('missing'); throw new Error('session_not_found'); }
if (info.ended) { show('ended'); throw new Error('session_ended'); }
const loginUrl = '/login?next=' + encodeURIComponent(location.pathname);
const joinFailed = (err) => { if (err.code === 'session_ended') return show('ended'); show('lobby'); $('lobbyMsg').textContent = errText(err); };

/* ---------- lobby: guests pick a nickname; signed-in people join under their display name ---------- */
renderCode($('lobbyCode'), sessionId);
renderCode($('miniCode'), sessionId, { masked: true }); // the code in the call's top bar starts hidden
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
    join(user.display_name).catch(joinFailed).finally(() => { joinBtn.disabled = false; joinBtn.textContent = 'Join call'; });
  };
  $('memberForm').addEventListener('submit', (e) => { e.preventDefault(); joinAsMember(); });
  setTimeout(joinAsMember, 0); // no nickname to type, so go straight in (after this module finishes setting up)
} else {
  $('lobbyLogin').href = loginUrl;
  $('nick').value = localStorage.getItem('knock.nick') || '';
  $('nickForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const nickname = $('nick').value.trim();
    if (nickname) join(nickname).catch(joinFailed);
  });
}

let local = null;
let selfId = null;
let isHost = false;
let leaving = false;
const people = new Map(); // socket id -> name, for everyone in the call (including me)
const recap = new Map(); // item id -> recap item
let socket;
let deafened = false;
let micBeforeDeafen = true; // was my mic on when I deafened? (undeafening gives it back only if so)
let screen = null; // { stream, track } while I'm sharing my screen
let iceServers = [];
const peers = new Map();

async function getMedia() {
  try {
    return await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    try { return await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return null; }
  }
}

function addTile(id, name, mine, handle = null, avatarAt = null) {
  const video = h('video', { autoplay: true, playsinline: true });
  if (mine || deafened) video.muted = true; // I can't hear anyone while deafened
  const avatar = h('button', { class: 'tile-avatar', type: 'button', 'aria-label': `View ${name}’s profile`, title: 'View profile', onclick: () => openProfile({ name, handle, mine, avatarAt }) }, avatarEl({ handle, display_name: name, avatar_at: avatarAt }, 38));
  const tile = h('figure', { class: 'vtile', 'data-id': id }, video, avatar, h('span', { class: 'tile-badges' }), h('figcaption', {}, mine ? `${name} (you)` : name));
  $('grid').append(tile);
  return { tile, video };
}

/* ---------- WebRTC: the newcomer sends an offer to everyone already in the room ---------- */
function makePeer(id, nickname, initiator, handle = null, avatarAt = null) {
  const pc = new RTCPeerConnection({ iceServers });
  const { tile, video } = addTile(id, nickname, false, handle, avatarAt);
  const peer = { pc, tile, nickname, chain: Promise.resolve(), media: new MediaStream() };
  peers.set(id, peer);
  // Audio: send mine if I have it. Video: send my screen if I'm sharing, else my camera. With neither, the video slot is still
  // negotiated as send+receive (empty), so a screen share can start later with replaceTrack and no renegotiation.
  const camera = local?.getVideoTracks()[0] ?? null;
  const outVideo = screen ? screen.track : camera;
  if (local?.getAudioTracks().length) local.getAudioTracks().forEach((t) => pc.addTrack(t, local));
  else pc.addTransceiver('audio', { direction: 'recvonly' });
  if (outVideo) pc.addTrack(outVideo, screen ? screen.stream : local);
  else pc.addTransceiver('video', { direction: 'sendrecv' });
  pc.onicecandidate = (e) => e.candidate && socket.emit('room:signal', { to: id, data: { candidate: e.candidate } });
  pc.ontrack = (e) => { // one stream per person, whether or not the sender attached its tracks to a stream
    if (!peer.media.getTracks().includes(e.track)) peer.media.addTrack(e.track);
    video.srcObject = peer.media;
  };
  if (screen) socket.emit('room:signal', { to: id, data: { screen: true } }); // tell people who join mid-share
  const st = myState();
  if (st.muted || st.deafened) socket.emit('room:signal', { to: id, data: { state: st } }); // ...and who join while I'm muted or deafened
  if (initiator) {
    peer.chain = peer.chain.then(async () => {
      await pc.setLocalDescription(await pc.createOffer());
      socket.emit('room:signal', { to: id, data: { description: pc.localDescription } });
    });
  }
  return peer;
}
// The little mic / headphone icons beside someone's picture while they're muted or deafened.
function setBadges(tile, { muted, deafened: deaf }) {
  const box = tile.querySelector('.tile-badges');
  const badge = (name, label) => h('span', { class: 'badge', title: label, role: 'img', 'aria-label': label }, icon(name, 14));
  box.replaceChildren(...[muted && badge('micOff', 'Muted'), deaf && badge('headphonesOff', 'Deafened')].filter(Boolean));
}
const myState = () => ({ muted: !(local?.getAudioTracks()[0]?.enabled ?? false) && !!local?.getAudioTracks().length, deafened });
function dropPeer(id) {
  const p = peers.get(id);
  if (!p) return;
  p.pc.close();
  p.tile.remove();
  peers.delete(id);
}
function onSignal({ from, nickname, handle, avatarAt, data }) {
  if (typeof data?.screen === 'boolean') { // someone started or stopped sharing their screen
    const p = peers.get(from);
    if (p) { setPresenting(p.tile, data.screen); p.tile.classList.toggle('blank', !data.screen && data.camera === false); }
    return;
  }
  const peer = peers.get(from) ?? makePeer(from, nickname, false, handle, avatarAt);
  if (data.state) { setBadges(peer.tile, data.state); return; } // someone muted, unmuted, deafened or undeafened
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
// A person can be in a call only once. This browser-side lock stops a second tab (guests included); the server also
// refuses a second connection from the same account (other browsers and devices).
let releaseTabLock = () => {};
function claimTab() {
  if (!navigator.locks) return Promise.resolve(true);
  return new Promise((resolve) => navigator.locks.request('knock-call-' + sessionId, { ifAvailable: true }, (lock) => {
    if (!lock) { resolve(false); return undefined; }
    resolve(true);
    return new Promise((release) => { releaseTabLock = release; }); // held until we leave (or the tab closes)
  }));
}
async function join(nickname) {
  if (!(await claimTab())) throw Object.assign(new Error('already_in_call'), { code: 'already_in_call' });
  try {
    await joinInner(nickname);
  } catch (err) { releaseTabLock(); throw err; }
}
async function joinInner(nickname) {
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
  socket.on('room:chat', ({ from, nickname: n, body }) => { dropTyper(from); addChat(from === socket.id ? null : n, body, from === socket.id); });
  socket.on('room:typing', ({ from, nickname: n, on }) => {
    if (!share) return;
    dropTyper(from, false);
    if (on) typers.set(from, { name: n, timer: setTimeout(() => dropTyper(from), 5000) });
    paintTypers();
  });
  socket.on('disconnect', () => { if (!leaving) toast('Connection lost. Reload the page to rejoin.'); });
  socket.on('room:ended', ({ standing } = {}) => { // the host ended the session for everyone
    teardown();
    socket.close();
    $('endedMsg').textContent = standing ? 'The host ended this call. It repeats on a schedule, so the same link works again next time.' : 'The host ended this call, so the code no longer works. Start a new call any time.';
    show('ended');
  });

  const res = await new Promise((resolve) => socket.emit('room:join', { sessionId, nickname }, resolve));
  if (res.error) { local?.getTracks().forEach((t) => t.stop()); socket.close(); throw Object.assign(new Error(res.error), { code: res.error === 'room_full' ? 'room_full' : res.error }); }

  show('live');
  selfId = res.selfId;
  isHost = !!res.host;
  const myName = res.nickname || nickname; // the server decides: display name for members, nickname for guests
  people.set(selfId, myName);
  res.peers.forEach((p) => people.set(p.id, p.nickname));
  (res.recap ?? []).forEach((i) => recap.set(i.id, i));
  const mine = addTile('local', myName, true, user?.handle ?? null, user?.avatar_at ?? null);
  if (local) mine.video.srcObject = local;
  res.peers.forEach((p) => makePeer(p.id, p.nickname, true, p.handle, p.avatarAt));
  wireControls();
  wireTopbar();
  renderRecap();
  refreshOwners();
}

/* ---------- top bar: show/hide the code, profile picture (members), log-in nudge (guests) ---------- */
function wireTopbar() {
  let codeShown = false; // starts hidden
  const paintCode = () => {
    renderCode($('miniCode'), sessionId, { masked: !codeShown });
    const b = $('codeToggle');
    b.replaceChildren(icon(codeShown ? 'eyeOff' : 'eye', 18));
    b.setAttribute('aria-label', codeShown ? 'Hide session code' : 'Show session code');
    b.setAttribute('aria-pressed', String(codeShown));
    b.title = b.getAttribute('aria-label');
  };
  $('codeToggle').addEventListener('click', () => { codeShown = !codeShown; paintCode(); });
  paintCode();

  $('copy').replaceChildren(icon('copy', 16), h('span', { class: 'lbl' }, 'Copy invite link'));
  if (user) { mountRoomTools($('roomRight'), user, sessionId); return; }
  // Guests: offer to log in / sign up. Signing in sends them to /login and straight back to this call as a member.
  $('guestBar').hidden = false;
  $('guestClose').replaceChildren(icon('x', 16));
  $('guestClose').addEventListener('click', () => ($('guestBar').hidden = true));
  for (const id of ['guestLogin', 'guestSignup']) {
    $(id).href = loginUrl;
    $(id).addEventListener('click', async (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      const ok = await confirmDialog({ title: 'Leave the call to sign in?', body: 'You’ll step out of this call while you log in or create your account, then rejoin automatically with this same link.', confirmText: 'Continue', cancelText: 'Stay in call' });
      if (ok) location.href = loginUrl;
    });
  }
}

/* ---------- screen sharing: my screen takes the place of my camera in every connection ---------- */
const videoSender = (peer) => peer.pc.getTransceivers().find((t) => t.receiver.track.kind === 'video')?.sender;
function setPresenting(tile, on) {
  tile.classList.toggle('presenting', on);
  tile.querySelector('.pres')?.remove();
  if (on) tile.querySelector('figcaption').append(h('span', { class: 'pres' }, ' · presenting'));
}
function paintShareBtn() {
  const b = $('shareBtn');
  b.replaceChildren(icon(screen ? 'screenOff' : 'screen', 22));
  b.setAttribute('aria-pressed', String(!!screen));
  b.setAttribute('aria-label', screen ? 'Stop sharing your screen' : 'Share your screen');
  b.title = b.getAttribute('aria-label');
}
const tellPeers = (data) => peers.forEach((_, id) => socket.emit('room:signal', { to: id, data }));
async function startShare() {
  if (screen) return;
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false, selfBrowserSurface: 'exclude' });
  } catch (err) {
    if (err.name !== 'NotAllowedError' && err.name !== 'AbortError') toast('Couldn’t start screen sharing.'); // closing the picker isn't an error
    return;
  }
  const track = stream.getVideoTracks()[0];
  track.contentHint = 'detail'; // keep text sharp rather than smooth
  screen = { stream, track };
  track.addEventListener('ended', stopShare); // the browser's own "Stop sharing" button
  await Promise.all([...peers.values()].map((p) => videoSender(p)?.replaceTrack(track).catch(() => {})));
  tellPeers({ screen: true });
  const mine = $('grid').querySelector('[data-id="local"]');
  mine.querySelector('video').srcObject = stream;
  mine.classList.remove('blank');
  setPresenting(mine, true);
  paintShareBtn();
}
async function stopShare() {
  if (!screen) return;
  const { stream, track } = screen;
  screen = null;
  track.removeEventListener('ended', stopShare);
  stream.getTracks().forEach((t) => t.stop());
  const camera = local?.getVideoTracks()[0] ?? null;
  await Promise.all([...peers.values()].map((p) => videoSender(p)?.replaceTrack(camera).catch(() => {})));
  if (socket?.connected) tellPeers({ screen: false, camera: !!camera });
  const mine = $('grid').querySelector('[data-id="local"]');
  if (mine) {
    mine.querySelector('video').srcObject = local;
    setPresenting(mine, false);
  }
  paintShareBtn();
}

/* ---------- leaving: the host ends the session for everyone, everyone else just leaves ---------- */
function teardown() {
  leaving = true;
  releaseTabLock();
  screen?.stream.getTracks().forEach((t) => t.stop());
  screen = null;
  local?.getTracks().forEach((t) => t.stop());
  [...peers.keys()].forEach(dropPeer);
}
const endForEveryone = () => new Promise((resolve) => socket.timeout(4000).emit('room:end', (err, r) => resolve(!err && !!r?.ok)));
async function requestExit(fromLogo = false) {
  if (isHost) {
    const ok = await confirmDialog({ title: 'End this session?', body: 'You started this call. Ending it closes the session for everyone in it, and the code stops working.', confirmText: 'End session', cancelText: 'Stay in call' });
    if (!ok) return;
    if (!(await endForEveryone())) return toast('Couldn’t end the session. Check your connection and try again.');
    teardown();
    socket.close();
    flash('Session ended for everyone.');
  } else {
    if (fromLogo) {
      const ok = await confirmDialog({ title: 'Leave this call?', body: 'You’ll go back to the homepage. You can rejoin with the same link while the call is still running.', confirmText: 'Leave call', cancelText: 'Stay in call' });
      if (!ok) return;
    }
    socket.emit('room:leave');
    teardown();
  }
  location.href = home;
}

/* ---------- controls + chat ---------- */
function wireControls() {
  const paintBtn = (btn, enabled, on, off, labelOn, labelOff) => {
    btn.replaceChildren(icon(enabled ? on : off, 22));
    btn.setAttribute('aria-label', enabled ? labelOn : labelOff);
    btn.title = btn.getAttribute('aria-label');
    btn.classList.toggle('on', !enabled);
  };
  const toggle = (btn, tracksOf, on, off, labelOn, labelOff, onChange) => {
    btn.replaceChildren(icon(on, 22));
    btn.addEventListener('click', () => {
      const tracks = tracksOf();
      if (!tracks.length) return toast('That device isn’t available.');
      const enabled = !tracks[0].enabled;
      tracks.forEach((t) => (t.enabled = enabled));
      paintBtn(btn, enabled, on, off, labelOn, labelOff);
      onChange?.(enabled);
    });
  };
  // Tell everyone my mute / deafen state, and show it on my own tile too.
  const shareState = () => {
    const st = myState();
    setBadges($('grid').querySelector('[data-id="local"]'), st);
    tellPeers({ state: st });
  };
  toggle($('mic'), () => local?.getAudioTracks() ?? [], 'mic', 'micOff', 'Mute microphone', 'Unmute microphone', (enabled) => {
    if (enabled && deafened) setDeafened(false); // unmuting while deafened also lets you hear again
    else shareState();
  });
  // Deafen: stop hearing everyone (and mute my mic, like most call apps). Undeafen brings back what I had before.
  const setDeafened = (on) => {
    if (on === deafened) return;
    deafened = on;
    peers.forEach((p) => (p.tile.querySelector('video').muted = on));
    const tracks = local?.getAudioTracks() ?? [];
    if (on) { micBeforeDeafen = tracks[0]?.enabled ?? false; tracks.forEach((t) => (t.enabled = false)); }
    else tracks.forEach((t) => (t.enabled = micBeforeDeafen));
    paintBtn($('deafen'), !deafened, 'headphones', 'headphonesOff', 'Deafen (stop hearing everyone)', 'Undeafen');
    paintBtn($('mic'), tracks[0]?.enabled ?? true, 'mic', 'micOff', 'Mute microphone', 'Unmute microphone');
    shareState();
  };
  $('deafen').replaceChildren(icon('headphones', 22));
  $('deafen').addEventListener('click', () => setDeafened(!deafened));
  toggle($('cam'), () => local?.getVideoTracks() ?? [], 'video', 'videoOff', 'Turn camera off', 'Turn camera on');
  if (navigator.mediaDevices?.getDisplayMedia) { // most phone browsers can't share a screen, so the button stays hidden there
    $('shareBtn').hidden = false;
    paintShareBtn();
    $('shareBtn').addEventListener('click', () => (screen ? stopShare() : startShare()));
  }
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
  $('leave').addEventListener('click', () => requestExit(false));
  $('brandLive').addEventListener('click', (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // let "open in new tab" work normally
    e.preventDefault();
    requestExit(true);
  });
  $('copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(location.href); toast('Invite link copied'); } catch { toast('Copy failed. Copy the address bar instead.'); }
  });
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('chatInput').value.trim();
    if (text) socket.emit('room:chat', text);
    $('chatInput').value = '';
    stopTyping();
  });
  // "Ana is typing…": sent at most every 2.5 s while typing, hidden by the others after 5 s of silence.
  $('chatInput').addEventListener('input', () => {
    if (!share) return;
    if (!$('chatInput').value.trim()) return stopTyping();
    if (Date.now() - typingSentAt > 2500) { typingSentAt = Date.now(); socket.emit('room:typing', true); }
  });
  $('chatInput').addEventListener('blur', stopTyping);
}
// People who keep typing indicators off in Settings neither send nor see them (guests have no setting, so they do both).
let share = true;
if (user) api('/api/me').then((r) => { share = r.user.share_activity; }).catch(() => {});
window.addEventListener('activity-updated', (e) => { share = e.detail; if (!share) { stopTyping(); typers.forEach((t) => clearTimeout(t.timer)); typers.clear(); paintTypers(); } });
let typingSentAt = 0;
const typers = new Map(); // socket id -> { name, timer }
function stopTyping() { if (typingSentAt) socket?.emit('room:typing', false); typingSentAt = 0; }
function dropTyper(id, repaint = true) { const t = typers.get(id); if (t) clearTimeout(t.timer); typers.delete(id); if (repaint) paintTypers(); }
function paintTypers() {
  const names = [...typers.values()].map((t) => t.name);
  const text = !share || !names.length ? '' : names.length === 1 ? `${names[0]} is typing` : names.length === 2 ? `${names[0]} and ${names[1]} are typing` : 'Several people are typing';
  $('roomTyping').replaceChildren(...(text ? [h('span', { class: 'typing-dots', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), text + '…'] : []));
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
async function openProfile({ name, handle, mine, avatarAt = null }) {
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

  const head = (title, sub, at = avatarAt) => h('div', { class: 'profile-head' }, avatarEl({ handle, display_name: title, avatar_at: at }, 64), h('div', {}, h('h2', { style: 'font-size:1.6rem' }, title), sub ? h('p', { class: 'sub' }, sub) : null));
  if (!handle) { body.replaceChildren(head(name, 'Guest'), h('p', { class: 'hint' }, 'Joined with a nickname, so there’s no account profile to show.')); return; }
  if (!user) { body.replaceChildren(head(name), h('p', { class: 'hint' }, 'Log in to see profiles and send friend requests.'), h('a', { class: 'btn primary', href: '/login?next=' + encodeURIComponent(location.pathname) }, 'Log in')); return; }
  body.replaceChildren(head(name), h('p', { class: 'hint' }, 'Loading…'));
  try {
    const { user: p, relation: first } = await api('/api/users/' + encodeURIComponent(handle));
    const fmtDate = (ms) => new Date(ms).toLocaleDateString([], { year: 'numeric', month: 'long', day: 'numeric' });
    // Opens in a new tab so you don't leave the call.
    const fullProfile = () => h('div', { class: 'pic-actions' }, h('a', { class: 'btn primary sm', href: '/u/' + encodeURIComponent(p.handle), target: '_blank', rel: 'noopener' }, h('span', { class: 'btn-ic' }, icon('users', 16)), 'Full profile'));
    const paint = (relation) => body.replaceChildren(
      head(p.display_name, '@' + p.handle, p.avatar_at),
      h('dl', { class: 'facts-list' },
        h('dt', {}, 'Display name'), h('dd', {}, p.display_name),
        h('dt', {}, 'Name at signup'), h('dd', {}, p.signup_name),
        h('dt', {}, 'Account created'), h('dd', {}, fmtDate(p.created_at)),
        ...(statusChip(p.status) ? [h('dt', {}, 'Status'), h('dd', {}, statusChip(p.status))] : [])),
      ...(relation === 'self' || mine
        ? [h('p', { class: 'hint' }, 'This is how other people see you.'), fullProfile()]
        : [friendActions(p, relation, paint), fullProfile(), safetyActions(p, relation, { context: { type: 'call', id: sessionId }, onChange: paint })]));
    paint(first);
  } catch { body.replaceChildren(head(name), h('p', { class: 'error' }, 'Couldn’t load this profile. Try again.')); }
}
