// Recurring calls and calendar export.
//
// Recurrence is worked out in the person's own timezone, so "every Monday at 9:00" stays at 9:00 on the wall clock
// when the clocks change, instead of drifting by an hour. The browser sends its IANA timezone name with the request.

export const REPEATS = ['daily', 'weekdays', 'weekly', 'biweekly', 'monthly'];
export const MAX_OCCURRENCES = 52;
export const CALL_MINUTES = 60; // calls have no set length; calendar entries last an hour (the dashboard also treats a call as "upcoming" for an hour)

export function safeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: String(tz) });
    return String(tz);
  } catch {
    return 'UTC';
  }
}

const formatters = new Map();
function zoneParts(ms, tz) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}
// How far the zone is ahead of UTC at that instant, in ms.
function offsetAt(ms, tz) {
  const p = zoneParts(ms, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}
// Wall-clock time in a zone -> the real instant. A time that doesn't exist (clocks springing forward) is read with the
// offset from before the gap, so 02:30 becomes 03:30, like calendar apps do.
function wallToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = offsetAt(guess, tz);
  const t1 = guess - off1;
  const off2 = offsetAt(t1, tz);
  if (off2 === off1) return t1;
  const t2 = guess - off2;
  return offsetAt(t2, tz) === off2 ? t2 : t1;
}

const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
const isWeekend = (y, mo, d) => [0, 6].includes(new Date(Date.UTC(y, mo - 1, d)).getUTCDay());

export function startsOnWeekend(startMs, tz) {
  const p = zoneParts(startMs, tz);
  return isWeekend(p.y, p.mo, p.d);
}

// Start times of a series: the first one plus (count - 1) more.
export function occurrences(startMs, repeat, count, tzName) {
  const tz = safeZone(tzName);
  const first = zoneParts(startMs, tz);
  const out = [startMs];
  const at = (y, mo, d) => wallToUtc(y, mo, d, first.h, first.mi, tz);
  let day = Date.UTC(first.y, first.mo - 1, first.d); // walks the calendar date only; the time of day is added back each time
  for (let k = 1; out.length < count; k++) {
    if (repeat === 'monthly') {
      const m0 = first.mo - 1 + k;
      const y = first.y + Math.floor(m0 / 12);
      const mo = (m0 % 12) + 1;
      out.push(at(y, mo, Math.min(first.d, daysInMonth(y, mo)))); // the 31st becomes the last day of a shorter month
      continue;
    }
    if (repeat === 'weekly') day += 7 * 86_400_000;
    else if (repeat === 'biweekly') day += 14 * 86_400_000;
    else {
      day += 86_400_000;
      if (repeat === 'weekdays') while ([0, 6].includes(new Date(day).getUTCDay())) day += 86_400_000;
    }
    const dt = new Date(day);
    out.push(at(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()));
  }
  return out;
}

/* ---------- .ics (RFC 5545) ---------- */
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20261014T093000Z
// Lines are limited to 75 octets; longer ones continue on the next line, which starts with a space. Never split a UTF-8 character.
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

// calls: [{ id, title, scheduled_at, session_id, repeat }]. origin: e.g. https://knock.example.com
export function buildIcs(calls, origin, calName = 'Knock calls') {
  const now = Date.now();
  const host = new URL(origin).hostname;
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Knock//Scheduled calls//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', `X-WR-CALNAME:${esc(calName)}`];
  for (const c of calls) {
    const link = `${origin}/s/${c.session_id}`;
    lines.push(
      'BEGIN:VEVENT',
      `UID:call-${c.id}-${c.session_id}@${host}`, // stable, so importing the same call twice updates it instead of duplicating it
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(c.scheduled_at)}`,
      `DTEND:${stamp(c.scheduled_at + CALL_MINUTES * 60_000)}`,
      `SUMMARY:${esc(c.title)}`,
      `DESCRIPTION:${esc(`Join the call: ${link}\nSession code: ${c.session_id}`)}`,
      `URL:${link}`,
      `LOCATION:${esc(link)}`,
      'TRANSP:OPAQUE',
      'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(c.title)}`, 'TRIGGER:-PT10M', 'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
