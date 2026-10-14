// Review reports from the terminal (there is deliberately no admin web page to protect).
//
//   npm run reports                      open reports, oldest first
//   npm run reports -- all               every report
//   npm run reports -- show 12           one report in full, with the saved messages
//   npm run reports -- resolve 12 "note" mark as actioned (you dealt with it)
//   npm run reports -- dismiss 12 "note" mark as dismissed (nothing to act on)
import '../server/env.js';
import { db } from '../server/db.js';
import { findCategory } from '../public/js/report-categories.js';

const [cmd = 'open', arg, ...rest] = process.argv.slice(2);
const when = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
const label = (r) => {
  const c = findCategory(r.category);
  return `${c?.label ?? r.category}${r.reason ? ` > ${c?.reasons?.find((x) => x.id === r.reason)?.label ?? r.reason}` : ''}`;
};
const BASE = `SELECT r.*, a.handle AS reporter, b.handle AS reported,
  (SELECT COUNT(*) FROM reports x WHERE x.reported_id = r.reported_id) AS times_reported
  FROM reports r LEFT JOIN users a ON a.id = r.reporter_id JOIN users b ON b.id = r.reported_id`;

if (cmd === 'open' || cmd === 'all') {
  const rows = db.prepare(`${BASE} ${cmd === 'open' ? "WHERE r.status = 'open'" : ''} ORDER BY r.created_at`).all();
  if (!rows.length) console.log(cmd === 'open' ? 'No open reports.' : 'No reports yet.');
  for (const r of rows) {
    console.log(`#${r.id}  ${when(r.created_at)}  [${r.status}]  @${r.reported} (reported ${r.times_reported}x) by @${r.reporter ?? 'deleted'}`);
    console.log(`     ${label(r)}${r.details ? `\n     "${r.details.slice(0, 120)}"` : ''}`);
  }
} else if (cmd === 'show') {
  const r = db.prepare(`${BASE} WHERE r.id = ?`).get(Number(arg));
  if (!r) { console.error('No such report.'); process.exit(1); }
  console.log(`Report #${r.id} [${r.status}] ${when(r.created_at)}\nReported: @${r.reported} (${r.times_reported} report(s) in total)\nReporter: @${r.reporter ?? 'deleted'}\nReason:   ${label(r)}\nFrom:     ${r.context_type}${r.context_ref ? ` ${r.context_ref}` : ''}\nDetails:  ${r.details ?? '(none)'}`);
  if (r.review_note) console.log(`Review:   ${r.review_note} (${when(r.reviewed_at)})`);
  if (r.evidence) {
    console.log('\nSaved messages:');
    for (const m of JSON.parse(r.evidence)) console.log(`  ${when(m.at)}  ${m.from.padEnd(8)} ${m.body.replace(/\s+/g, ' ')}${m.deleted ? '  [deleted by sender later]' : ''}`);
  }
} else if (cmd === 'resolve' || cmd === 'dismiss') {
  const info = db.prepare("UPDATE reports SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = 'open'")
    .run(cmd === 'resolve' ? 'actioned' : 'dismissed', Date.now(), rest.join(' ') || null, Number(arg));
  console.log(info.changes ? `Report #${arg} marked ${cmd === 'resolve' ? 'actioned' : 'dismissed'}.` : 'No open report with that number.');
} else {
  console.error('Usage: npm run reports -- [open | all | show <id> | resolve <id> [note] | dismiss <id> [note]]');
  process.exit(1);
}
