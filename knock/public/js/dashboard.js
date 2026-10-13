import { api, h, errText, fmtTime, toast } from './common.js';
import { mountTopbar } from './topbar.js';

const $ = (id) => document.getElementById(id);
const DAY = 86_400_000;
const { user } = await api('/api/auth/me');
if (!user) location.replace('/login?next=/dashboard');
mountTopbar(user);

const midnight = new Date();
midnight.setHours(0, 0, 0, 0);
const dayStart = midnight.getTime();

const hour = new Date().getHours();
const paintName = () => {
  $('hello').textContent = `${hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening'}, ${user.display_name}`;
};
paintName();
window.addEventListener('profile-updated', paintName); // the profile picture menu (top right) can change the name too

async function load() {
  const d = await api('/api/dashboard?dayStart=' + dayStart);
  $('yCount').textContent = d.yesterday;
  const max = Math.max(1, ...d.week);
  $('bars').replaceChildren(...d.week.map((n, i) => {
    const day = new Date(dayStart - (7 - i) * DAY).toLocaleDateString([], { weekday: 'short' });
    return h('div', { class: 'bar' + (i === 6 ? ' y' : ''), title: `${day}: ${n} call${n === 1 ? '' : 's'}` }, h('i', { style: `height:${Math.round((n / max) * 100)}%` }), h('span', {}, day.slice(0, 2)));
  }));
  $('bars').setAttribute('role', 'img');
  $('bars').setAttribute('aria-label', `Calls in the last 7 days. Yesterday: ${d.yesterday}.`);

  renderSchedule(d.schedule);
}
await load();
loadRecaps();

$('sched').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/appointments', { method: 'POST', body: { title: $('schedTitle').value, scheduledAt: new Date($('schedWhen').value).getTime() } });
    $('sched').reset();
    toast('Call scheduled. Share its link from the list.');
    load();
  } catch (err) { toast(err.code === 'invalid_appointment' ? 'Pick a title and a time that hasn’t passed.' : errText(err)); }
});
$('join').addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = $('joinCode').value.trim().split('/').filter(Boolean).pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  $('joinMsg').textContent = '';
  if (id.length !== 10) { $('joinMsg').textContent = 'Codes have 10 letters and numbers.'; return; }
  try { await api('/api/sessions/' + id); location.href = '/s/' + id; }
  catch (err) { $('joinMsg').textContent = errText(err); }
});
$('instant').addEventListener('click', async () => { location.href = '/s/' + (await api('/api/sessions', { method: 'POST' })).id; });

/* ---------- the whole schedule: upcoming grouped by day, earlier calls tucked away ---------- */
function dayLabel(ms) {
  const diff = Math.round((new Date(ms).setHours(0, 0, 0, 0) - dayStart) / DAY);
  const date = new Date(ms).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  return diff === 0 ? `Today · ${date}` : diff === 1 ? `Tomorrow · ${date}` : date;
}
function scheduleRow(a, past) {
  return h('li', { class: 'row' },
    h('span', { class: 'time' }, past ? new Date(a.scheduled_at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + fmtTime(a.scheduled_at) : fmtTime(a.scheduled_at)),
    h('span', { class: 'row-main' }, h('span', { class: 'name' }, a.title), h('span', { class: 'sub' }, `Code ${a.session_id}`)),
    h('a', { class: 'btn sm', href: '/s/' + a.session_id }, 'Join'),
    h('button', { class: 'link-btn', onclick: async () => { await navigator.clipboard.writeText(`${location.origin}/s/${a.session_id}`).catch(() => {}); toast('Invite link copied'); } }, 'Copy link'),
    h('button', { class: 'link-btn danger', 'aria-label': `Cancel ${a.title}`, onclick: async () => { await api('/api/appointments/' + a.id, { method: 'DELETE' }); load(); } }, past ? 'Remove' : 'Cancel'));
}
function renderSchedule(all) {
  const cutoff = Date.now() - 3_600_000; // a call stays "upcoming" for an hour after its start time
  const upcoming = all.filter((a) => a.scheduled_at >= cutoff);
  const earlier = all.filter((a) => a.scheduled_at < cutoff).reverse();
  $('schedEmpty').hidden = upcoming.length > 0;
  const groups = [];
  for (const a of upcoming) {
    const label = dayLabel(a.scheduled_at);
    if (groups.at(-1)?.label !== label) groups.push({ label, rows: [] });
    groups.at(-1).rows.push(a);
  }
  $('schedule').replaceChildren(...groups.flatMap((g) => [h('h3', { class: 'day-head' }, g.label), h('ul', { class: 'rows' }, g.rows.map((a) => scheduleRow(a, false)))]));
  $('pastWrap').hidden = !earlier.length;
  $('pastSummary').textContent = `Earlier calls (${earlier.length})`;
  $('past').replaceChildren(...earlier.map((a) => scheduleRow(a, true)));
}

/* ---------- smart recaps ---------- */
let allRecaps = [];
let showAll = false;
async function loadRecaps() {
  allRecaps = (await api('/api/recaps').catch(() => ({ recaps: [] }))).recaps;
  renderRecaps();
}
function renderRecaps() {
  const shown = showAll ? allRecaps : allRecaps.slice(0, 3);
  $('recapsEmpty').hidden = allRecaps.length > 0;
  $('recapMore').hidden = allRecaps.length <= 3;
  $('recapMore').textContent = showAll ? 'Show fewer' : `Show all ${allRecaps.length} recaps`;
  $('recaps').replaceChildren(...shown.map((r) => h('article', { class: 'recap' },
    h('div', { class: 'recap-head' },
      h('span', { class: 'name' }, r.title || 'Call'),
      h('span', { class: 'sub' }, new Date(r.at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' · ' + fmtTime(r.at))),
    r.decisions.length ? [h('h3', {}, 'Decided'), h('ul', {}, r.decisions.map((i) => h('li', {}, i.body)))] : null,
    r.actions.length ? [h('h3', {}, 'Follow-ups'), h('ul', { class: 'follow' }, r.actions.map((i) => h('li', { class: i.done ? 'done' : '' },
      h('input', { type: 'checkbox', checked: i.done, 'aria-label': `Mark done: ${i.body}`, onchange: async (e) => {
        try { await api('/api/recaps/items/' + i.id, { method: 'PATCH', body: { done: e.target.checked } }); i.done = e.target.checked; renderRecaps(); }
        catch (err) { e.target.checked = !e.target.checked; toast(errText(err)); }
      } }),
      h('span', { class: 'what' }, i.body, h('span', { class: 'owner' + (i.mine ? ' mine' : '') }, i.mine ? 'Owner: you' : i.owner_name ? `Owner: ${i.owner_name}` : 'No owner yet')))))] : null)));
}
$('recapMore').addEventListener('click', () => { showAll = !showAll; renderRecaps(); });
