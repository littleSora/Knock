import { createClient } from '@supabase/supabase-js';
import { db } from './db.js';

// Supabase does two jobs for Knock:
//  1. Supabase Auth is the only place passwords and email confirmation live (see server/auth.js).
//  2. The `accounts` table keeps each person's profile and Knock id, so accounts survive a redeploy or a wiped disk.
//     Everything else (chats, friends, calls) stays in SQLite. See supabase/schema.sql.
const key = process.env.SUPABASE_SERVICE_ROLE_KEY; // server-side only: it bypasses Row Level Security, never send it to a browser
// Accept the bare project URL, and forgive a pasted "/rest/v1/" or "/auth/v1/" on the end.
const url = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '').replace(/\/(rest|auth)\/v1$/, '');
export const supabaseEnabled = !!(url && key);

// Always say at startup whether Supabase is set up, and which variable is missing. Only names are printed, never values.
if (supabaseEnabled) {
  console.log(`[supabase] configured, project ${url}`);
} else {
  const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'].filter((k) => !process.env[k]?.trim());
  const similar = Object.keys(process.env).filter((k) => /supa/i.test(k));
  console.error(`[supabase] PROBLEM: not configured. Missing: ${missing.join(', ')}. Login and sign-up will say "Login isn't available".`);
  console.error(`[supabase] Variables whose name contains "supa": ${similar.length ? similar.join(', ') : '(none)'}. The names must be EXACTLY SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.`);
}

const options = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: (u, o) => fetch(u, { ...o, signal: AbortSignal.timeout(10_000) }) }, // never hang a request on a slow network
};
const client = supabaseEnabled ? createClient(url, key, options) : null;

// A throwaway client for one login/sign-up/code check. Supabase keeps the signed-in person on the client object, so the
// shared one must never be used for that, or two people's requests could mix.
export const authClient = () => createClient(url, key, options).auth;
// Admin calls (set a password, create a user). They never touch a session, so the shared client is fine.
export const adminAuth = () => client.auth.admin;

// Looks an account up by email in Supabase Auth (it has no direct lookup, so this pages through the list).
export async function findAuthUserByEmail(email) {
  for (let page = 1; ; page++) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(error.message);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit;
    if (data.users.length < 1000) return null;
  }
}

const COLS = ['id', 'auth_uid', 'handle', 'display_name', 'signup_name', 'email', 'created_at', 'first_name', 'last_name', 'middle_initial', 'birthday', 'workplace', 'country', 'theme', 'chat_activity'];
const readLocal = db.prepare(`SELECT ${COLS.join(', ')} FROM users WHERE id = ?`);
const readAllLocal = db.prepare(`SELECT ${COLS.join(', ')} FROM users ORDER BY id`);
const restoreOne = db.prepare(`INSERT INTO users(${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`);

const plain = (row) => Object.fromEntries(COLS.map((c) => [c, row[c] ?? null]));
const sameAccount = (a, b) => COLS.every((c) => (a[c] ?? null) === (b[c] ?? null));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- sign-up: the account must be saved before the person is logged in ---------- */
// Throws when it could not be saved. error.emailTaken is true when the table already has an account with that email.
export async function saveNewAccount(userId) {
  if (!client) throw new Error('Supabase is not configured');
  const { error } = await client.from('accounts').insert({ ...plain(readLocal.get(userId)), updated_at: new Date().toISOString() });
  if (error) {
    const err = new Error(error.message);
    err.emailTaken = error.code === '23505' && /accounts_email_key/.test(`${error.message} ${error.details ?? ''}`);
    throw err;
  }
}

/* ---------- later changes (email, name, theme...): copy the current row up, in the background ---------- */
export function syncAccount(userId) {
  if (!client) return;
  (async () => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const row = readLocal.get(userId);
        if (!row) return;
        const { error } = await client.from('accounts').upsert({ ...plain(row), updated_at: new Date().toISOString() }, { onConflict: 'id' });
        if (!error) return;
        console.error(`[supabase] saving account ${userId} failed (try ${attempt}/3): ${error.message}`);
      } catch (e) {
        console.error(`[supabase] saving account ${userId} failed (try ${attempt}/3): ${e.message}`);
      }
      await sleep(2000 * attempt);
    }
  })();
}

/* ---------- startup: bring SQLite and Supabase level with each other ---------- */
// 1. accounts only in Supabase (the disk was wiped) are put back in SQLite, with their old ids
// 2. accounts only in SQLite (made while Supabase was down) are saved to Supabase
// 3. accounts in both that differ are updated in Supabase (SQLite is the live copy)
async function reconcile() {
  const remote = new Map();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await client.from('accounts').select(COLS.join(', ')).order('id').range(from, from + 999);
    if (error) throw new Error(error.message);
    for (const r of data) remote.set(r.id, r);
    if (data.length < 1000) break;
  }
  const local = new Map(readAllLocal.all().map((r) => [r.id, plain(r)]));

  let restored = 0, saved = 0, updated = 0;
  for (const [id, r] of remote) {
    if (local.has(id)) continue;
    try {
      restoreOne.run(...COLS.map((c) => (c === 'chat_activity' ? r[c] ?? 1 : r[c] ?? null)));
      restored++;
    } catch (e) {
      console.error(`[supabase] could not restore account ${id}: ${e.message}`);
    }
  }
  for (const [id, row] of local) {
    const r = remote.get(id);
    if (r && sameAccount(row, r)) continue;
    const { error } = await client.from('accounts').upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: 'id' });
    if (error) console.error(`[supabase] could not save account ${id}: ${error.message}`);
    else if (r) updated++;
    else saved++;
  }
  console.log(`[supabase] accounts in sync (restored ${restored}, uploaded ${saved}, updated ${updated}, total ${remote.size + saved})`);
}

// Says in plain words what is wrong with the Supabase settings, so a "Login isn't available" page can be fixed from the logs.
async function selfCheck() {
  try {
    const role = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString()).role;
    if (role && role !== 'service_role') console.error(`[supabase] PROBLEM: SUPABASE_SERVICE_ROLE_KEY is a "${role}" key. Copy the "service_role" key (Project Settings -> API) instead.`);
  } catch {
    console.error('[supabase] PROBLEM: SUPABASE_SERVICE_ROLE_KEY does not look like a Supabase key. It should be one long text starting with "eyJ". Check that it was pasted whole.');
  }
  const { error } = await client.auth.admin.listUsers({ page: 1, perPage: 1 });
  if (!error) { console.log('[supabase] Auth reachable, key accepted.'); return; }
  const m = `${error.status ?? ''} ${error.code ?? ''} ${error.message}`;
  if (/401|403|invalid.*(api key|jwt)|bad_jwt/i.test(m)) console.error(`[supabase] PROBLEM: Supabase refused the key (${m.trim()}). SUPABASE_SERVICE_ROLE_KEY is wrong or cut off: copy the whole "service_role" key again.`);
  else if (/404|ENOTFOUND|fetch failed|abort|timeout/i.test(m)) console.error(`[supabase] PROBLEM: could not reach Supabase at ${url} (${m.trim()}). SUPABASE_URL should be exactly https://<project-ref>.supabase.co`);
  else console.error(`[supabase] PROBLEM: Supabase Auth answered with an error: ${m.trim()}`);
}

// Never stops the server from starting: if Supabase can't be reached, it keeps trying in the background.
export async function syncOnStartup() {
  if (!client) return;
  await selfCheck().catch((e) => console.error('[supabase] self-check failed:', e.message));
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await reconcile();
      return;
    } catch (e) {
      const hint = /accounts|PGRST205|schema cache|does not exist/i.test(e.message) ? ' -> the "accounts" table is missing: run supabase/schema.sql in the Supabase SQL Editor.' : '';
      console.error(`[supabase] startup sync failed (try ${attempt}/3): ${e.message}${hint}`);
      if (attempt < 3) await sleep(2000 * attempt);
    }
  }
  console.error('[supabase] still unreachable. Trying again in a minute. Sign-ups are refused until Supabase answers, so no account can be lost.');
  setTimeout(syncOnStartup, 60_000).unref();
}
