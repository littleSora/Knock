// Repeat rules for scheduled calls. Shared by the browser (dashboard) and the server (validation), like theme-core.js.
// Occurrences are worked out in the viewer's local time zone, so "every Monday at 9:00" stays at 9:00 across daylight saving.
export const REPEATS = [
  { id: 'none', label: 'Does not repeat', short: '' },
  { id: 'daily', label: 'Every day', short: 'Repeats daily' },
  { id: 'weekdays', label: 'Every weekday (Mon–Fri)', short: 'Repeats on weekdays' },
  { id: 'weekly', label: 'Every week', short: 'Repeats weekly' },
  { id: 'biweekly', label: 'Every 2 weeks', short: 'Repeats every 2 weeks' },
  { id: 'monthly', label: 'Every month', short: 'Repeats monthly' },
];
export const isRepeat = (id) => REPEATS.some((r) => r.id === id);
export const repeatLabel = (id) => REPEATS.find((r) => r.id === id)?.short ?? '';

const DAY = 86_400_000;
const STEP_DAYS = { daily: 1, weekdays: 1, weekly: 7, biweekly: 14 };

// The first start time at or after `from` (ms), or null when the series has ended. `a` needs scheduled_at, recurrence, repeat_until.
export function nextOccurrence(a, from) {
  const first = a.scheduled_at;
  const rule = a.recurrence || 'none';
  const until = a.repeat_until ?? null;
  const fits = (t) => (until == null || t <= until ? t : null);
  if (rule === 'none') return first >= from ? first : null;
  const start = new Date(first);
  if (rule === 'monthly') {
    // Like calendar apps: a month without that day (the 31st in April) is skipped, not moved.
    const f = new Date(from);
    let k = Math.max(0, (f.getFullYear() - start.getFullYear()) * 12 + f.getMonth() - start.getMonth() - 1);
    for (let i = 0; i < 600; i++, k++) {
      const d = new Date(start.getFullYear(), start.getMonth() + k, start.getDate(), start.getHours(), start.getMinutes(), start.getSeconds());
      if (d.getDate() !== start.getDate()) continue;
      if (d.getTime() >= from) return fits(d.getTime());
      if (until != null && d.getTime() > until) return null;
    }
    return null;
  }
  const step = STEP_DAYS[rule];
  if (!step) return null;
  let k = Math.max(0, Math.floor((from - first) / (step * DAY)) - 1);
  for (let i = 0; i < 1000; i++, k++) {
    const d = new Date(start);
    d.setDate(start.getDate() + k * step); // setDate keeps the wall-clock time across daylight saving changes
    const t = d.getTime();
    if (until != null && t > until) return null;
    if (t < from) continue;
    if (rule === 'weekdays' && (d.getDay() === 0 || d.getDay() === 6)) continue;
    return t;
  }
  return null;
}
