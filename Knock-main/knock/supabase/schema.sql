-- Run this once in the Supabase dashboard: SQL Editor -> New query -> paste -> Run. It is safe to run again.
--
-- Passwords and email confirmation live in Supabase Auth (the built-in auth.users table). Knock keeps running on its own SQLite
-- file for chats, calls, friends and so on. This `accounts` table is the permanent copy of every person's PROFILE and Knock id,
-- so accounts survive a redeploy or a wiped disk (Render's free tier resets its disk). On startup, Knock copies any account that
-- is missing from SQLite back from here.

create table if not exists public.accounts (
  id             bigint primary key,        -- same id as users.id in SQLite, so restored accounts keep their identity
  handle         text   not null unique,
  display_name   text   not null,
  signup_name    text,
  email          text,
  created_at     bigint not null,           -- milliseconds since 1970, same as SQLite
  first_name     text,
  last_name      text,
  middle_initial text,
  birthday       text,
  workplace      text,
  country        text,
  theme          text,
  chat_activity  integer not null default 1,
  updated_at     timestamptz not null default now()
);

-- Link to the person's Supabase Auth user. NULL only for accounts made before Supabase Auth was added; they get linked when
-- they use "Forgot password". (If you ran an earlier version of this file, these two lines update the table for you.)
alter table public.accounts add column if not exists auth_uid uuid unique references auth.users (id) on delete set null;
alter table public.accounts drop column if exists password_hash;

-- One account per email, ignoring upper/lower case. (Several rows may have no email.)
create unique index if not exists accounts_email_key on public.accounts (lower(email));

-- Lock the table. Row Level Security with NO policies means the public "anon" and "authenticated" keys can read and write
-- nothing. Only the server, using the service_role key, can touch it (the service role bypasses RLS).
alter table public.accounts enable row level security;
revoke all on public.accounts from anon, authenticated;
