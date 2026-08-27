-- Supabase-compatible shims for a PLAIN Postgres (local operator mode and
-- the test rigs). Production Supabase provides all of this; a bare Postgres
-- does not, and the migrations bind to it.
--
-- Used by scripts/bootstrap-db.mjs (local operator setup). The two test
-- rigs (supabase/test/rig.ts, apps/web/e2e/setup-db.mjs) still carry their
-- own inline copies; folding them onto this file is a recorded follow-up —
-- three copies of one shim is exactly the drift risk this project keeps
-- learning about, and the note stays here until it is actually done.

create schema if not exists auth;

-- Reads the same request.jwt claims Supabase's own auth.uid() reads, so
-- policies behave identically whether the caller is Supabase Auth or the
-- local operator pinning the claim directly.
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(coalesce(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    current_setting('request.jwt.claim.sub', true)
  ), '')::uuid
$$;

create schema if not exists storage;

create table if not exists storage.buckets (
  id text primary key,
  name text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text not null references storage.buckets,
  name text not null,
  owner uuid,
  created_at timestamptz not null default now()
);

create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$
    select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
  $$;

alter table storage.objects enable row level security;
alter table storage.objects force  row level security;

-- Supabase's application role. The app connects AS a login role that
-- inherits this one and can never bypass RLS.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

grant usage on schema auth to authenticated;
grant execute on function auth.uid() to authenticated;
grant usage on schema storage to authenticated;
grant select on storage.buckets to authenticated;
grant select, insert, update, delete on storage.objects to authenticated;
