// Builds iCalendar (.ics, RFC 5545) files for scheduled calls so they can be added to Google, Apple or Outlook calendars.
// Times are written in UTC. A repeating call is one event with an RRULE; calendars expand it themselves.
const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const CALL_MS = 3_600_000; // calls have no end time of their own, so each calendar entry lasts an hour

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines are at most 75 bytes; longer ones continue on the next line after one space. Never splits a multi-byte character.
function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > 75) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.join('\r\n');
}

// "Every weekday" means Monday to Friday where the person lives. The file is in UTC, so a 7:00 call in Manila falls on the
// previous UTC day: shift the weekday list by the same amount (tz_offset is the browser's getTimezoneOffset(), minutes behind UTC).
function weekdayList(a) {
  const local = new Date(a.scheduled_at - (a.tz_offset || 0) * 60_000).getUTCDay();
  const shift = (new Date(a.scheduled_at).getUTCDay() - local + 7) % 7;
  return [1, 2, 3, 4, 5].map((d) => DAY_CODES[(d + shift) % 7]).join(',');
}
function rrule(a) {
  const base = {
    daily: 'FREQ=DAILY',
    weekdays: `FREQ=WEEKLY;BYDAY=${weekdayList(a)}`,
    weekly: 'FREQ=WEEKLY',
    biweekly: 'FREQ=WEEKLY;INTERVAL=2',
    monthly: 'FREQ=MONTHLY',
  }[a.recurrence];
  if (!base) return null;
  return 'RRULE:' + base + (a.repeat_until ? `;UNTIL=${stamp(a.repeat_until)}` : '');
}

function event(a, origin, now) {
  const link = `${origin}/s/${a.session_id}`;
  const lines = [
    'BEGIN:VEVENT',
    `UID:knock-call-${a.id}@${new URL(origin).hostname}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(a.scheduled_at)}`,
    `DTEND:${stamp(a.scheduled_at + CALL_MS)}`,
    `SUMMARY:${esc(a.title)}`,
    `DESCRIPTION:${esc(`Join the call: ${link}\nCode: ${a.session_id}`)}`,
    `LOCATION:${esc(link)}`,
    `URL:${link}`,
  ];
  const rule = rrule(a);
  if (rule) lines.push(rule);
  lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(a.title)}`, 'TRIGGER:-PT10M', 'END:VALARM', 'END:VEVENT');
  return lines;
}

export function buildCalendar(appointments, origin) {
  const now = Date.now();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Knock//Scheduled calls//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Knock calls'];
  for (const a of appointments) lines.push(...event(a, origin, now));
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export const fileSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'call';
