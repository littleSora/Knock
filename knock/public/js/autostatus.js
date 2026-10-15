// Automatic "Away": once no Knock tab has been in front for 10 minutes, your status becomes Away. It goes back as soon as you
// are looking at Knock again. ("In a meeting" while you're in a call is set by the server, see syncCallStatus.)
// A status you picked yourself is never touched: the server only ever changes one it set itself (status.auto).
import { api } from './common.js';

const AWAY_AFTER = 10 * 60_000;
const KEY = 'knock.lastHere'; // shared by every open Knock tab: the last time any of them was in front
const read = () => { try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; } };
const write = (v) => { try { localStorage.setItem(KEY, String(v)); } catch { /* storage blocked: this tab keeps its own count */ } };
let memory = Date.now(); // fallback when storage is blocked
const lastHere = () => Math.max(read(), memory);
const here = () => document.visibilityState === 'visible' && document.hasFocus();

let mine = null; // my status as the server last told us
export const setMyStatus = (s) => { mine = s && (s.until == null || s.until > Date.now()) ? s : null; };

let busy = false;
async function send(method) {
  if (busy) return;
  busy = true;
  try { setMyStatus((await api('/api/me/status/away', { method })).status); } catch { /* try again on the next tick */ } finally { busy = false; }
}

function tick() {
  if (here()) {
    memory = Date.now();
    write(memory);
    if (mine?.auto && mine.kind === 'away') send('DELETE'); // back: take the automatic Away off
  } else if (!mine && Date.now() - lastHere() >= AWAY_AFTER) {
    send('PUT'); // nothing set yet (not a status I picked, not "In a meeting"): go Away
  }
}

let started = false;
export function startAutoStatus() {
  if (started) return;
  started = true;
  setInterval(tick, 5000);
  for (const ev of ['focus', 'visibilitychange']) (ev === 'focus' ? window : document).addEventListener(ev, tick);
  tick();
}
