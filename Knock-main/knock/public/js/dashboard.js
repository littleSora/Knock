import { api, h, errText, fmtTime, toast, confirmDialog } from './common.js';
import { mountTopbar } from './topbar.js';
import { REPEATS, repeatLabel, nextOccurrence } from './recurrence.js';

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

$('schedRepeat').replaceChildren(...REPEATS.map((r) => h('option', { value: r.id }, r.label)));
$('schedRepeat').addEventListener('change', () => { $('schedUntilWrap').hidden = $('schedRepeat').value === 'none'; });
$('sched').addEventListener('submit', async (e) => {
  e.preventDefault();
  const recurrence = $('schedRepeat').value;
  const start = new Date($('schedWhen').value);
  if (recurrence === 'weekdays') { // a Mon–Fri series can't start on a weekend: begin on the Monday after
    while (start.getDay() === 0 || start.getDay() === 6) start.setDate(start.getDate() + 1);
  }
  let repeatUntil = null;
  if (recurrence !== 'none' && $('schedUntil').value) {
    const [y, m, d] = $('schedUntil').value.split('-').map(Number);
    repeatUntil = new Date(y, m - 1, d, 23, 59, 59, 999).getTime(); // the whole last day counts
  }
  try {
    await api('/api/appointments', { method: 'POST', body: { title: $('schedTitle').value, scheduledAt: start.getTime(), recurrence, repeatUntil, tzOffset: start.getTimezoneOffset() } });
    $('sched').reset();
    $('schedUntilWrap').hidden = true;
    toast(recurrence === 'none' ? 'Call scheduled. Share its link from the list.' : 'Repeating call scheduled. The same link works every time.');
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
function scheduleRow(a, at, past) {
  const repeats = a.recurrence && a.recurrence !== 'none';
  const sub = [`Code ${a.session_id}`, repeats ? repeatLabel(a.recurrence) + (a.repeat_until ? ` until ${new Date(a.repeat_until).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '') : ''].filter(Boolean).join(' · ');
  const cancel = async () => {
    if (repeats && !past && !(await confirmDialog({ title: 'Cancel this repeating call?', body: `“${a.title}” and all of its future calls will be removed. The link will stop being listed here.`, confirmText: 'Cancel series', cancelText: 'Keep it' }))) return;
    await api('/api/appointments/' + a.id, { method: 'DELETE' });
    load();
  };
  return h('li', { class: 'row' },
    h('span', { class: 'time' }, past ? new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' }) + (repeats ? '' : ' ' + fmtTime(at)) : fmtTime(at)),
    h('span', { class: 'row-main' }, h('span', { class: 'name' }, a.title), h('span', { class: 'sub' }, sub)),
    past ? null : h('a', { class: 'btn sm', href: '/s/' + a.session_id }, 'Join'),
    h('button', { class: 'link-btn', onclick: async () => { await navigator.clipboard.writeText(`${location.origin}/s/${a.session_id}`).catch(() => {}); toast('Invite link copied'); } }, 'Copy link'),
    past ? null : h('a', { class: 'link-btn', href: `/api/appointments/${a.id}/ics`, download: '', 'aria-label': `Add ${a.title} to your calendar` }, 'Calendar'),
    h('button', { class: 'link-btn danger', 'aria-label': `${repeats && !past ? 'Cancel series' : 'Cancel'} ${a.title}`, onclick: cancel }, past ? 'Remove' : repeats ? 'Cancel series' : 'Cancel'));
}
function renderSchedule(all) {
  const cutoff = Date.now() - 3_600_000; // a call stays "upcoming" for an hour after its start time
  // A repeating call shows once, at its next time. A series whose last day has passed moves to "Earlier calls".
  const upcoming = [];
  const earlier = [];
  for (const a of all) {
    const next = nextOccurrence(a, cutoff);
    if (next != null) upcoming.push({ a, at: next });
    else earlier.push({ a, at: a.repeat_until ?? a.scheduled_at });
  }
  upcoming.sort((x, y) => x.at - y.at);
  earlier.sort((x, y) => y.at - x.at);
  $('schedEmpty').hidden = upcoming.length > 0;
  $('calExport').hidden = upcoming.length === 0;
  const groups = [];
  for (const u of upcoming) {
    const label = dayLabel(u.at);
    if (groups.at(-1)?.label !== label) groups.push({ label, rows: [] });
    groups.at(-1).rows.push(u);
  }
  $('schedule').replaceChildren(...groups.flatMap((g) => [h('h3', { class: 'day-head' }, g.label), h('ul', { class: 'rows' }, g.rows.map((u) => scheduleRow(u.a, u.at, false)))]));
  $('pastWrap').hidden = !earlier.length;
  $('pastSummary').textContent = `Earlier calls (${earlier.length})`;
  $('past').replaceChildren(...earlier.map((u) => scheduleRow(u.a, u.at, true)));
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
