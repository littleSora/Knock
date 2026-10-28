// Supabase holds the accounts (email + password). Only this server talks to it, with the service-role key,
// so the key never reaches the browser. EmailJS still sends every code; Supabase never emails anyone here.
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY || serviceKey;

export const supabaseEnabled = Boolean(url && serviceKey);

const opts = { auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false } };
const admin = supabaseEnabled ? createClient(url, serviceKey, opts).auth.admin : null;

const need = () => {
  if (!supabaseEnabled) throw new Error('Supabase is not configured (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)');
};

/** Create a confirmed account. Called only after the emailed code was entered correctly. email_confirm:true means Supabase sends nothing. */
export async function createAccount(email, password) {
  need();
  const { data, error } = await admin.createUser({ email, password, email_confirm: true });
  if (error) {
    if (/already|registered|exists/i.test(error.message) || error.code === 'email_exists') return { error: 'email_taken' };
    throw error;
  }
  return { id: data.user.id };
}

/** Check an email + password. Returns { id } on success, { invalid:true } for wrong credentials; throws on outages. */
export async function checkPassword(email, password) {
  need();
  const client = createClient(url, anonKey, opts); // fresh client per attempt so no session is kept in memory
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error) {
    if (error.status === 400 || error.status === 401 || error.code === 'invalid_credentials') return { invalid: true };
    throw error;
  }
  return { id: data.user.id };
}

export async function setPassword(supabaseId, password) {
  need();
  const { error } = await admin.updateUserById(supabaseId, { password });
  if (error) throw error;
}

/** Change the login email. Only call after the new address was proven with a code. */
export async function setEmail(supabaseId, email) {
  need();
  const { error } = await admin.updateUserById(supabaseId, { email, email_confirm: true });
  if (error) {
    if (/already|registered|exists/i.test(error.message) || error.code === 'email_exists') return { error: 'already_in_use' };
    throw error;
  }
  return {};
}

export async function findByEmail(email) {
  need();
  // listUsers has no email filter; this walks pages until it finds the address. Only used for the one-time migration of older accounts.
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const hit = data.users.find((u) => u.email?.toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) break;
  }
  return null;
}

/** Remove an account (only used to undo a half-finished sign-up). */
export async function deleteAccount(supabaseId) {
  need();
  const { error } = await admin.deleteUser(supabaseId);
  if (error) console.error('Could not remove Supabase user:', error.message);
}
