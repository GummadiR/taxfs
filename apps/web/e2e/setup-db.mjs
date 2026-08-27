/**
 * E2E database preparation. Boots a FIXED database (taxfs_e2e) on
 * TAXFS_TEST_DATABASE_URL with the real migrations + the same auth/storage
 * shims and restricted role as the unit rig — the app under e2e runs with
 * the identical RLS walls production has. Recreated from scratch every run
 * (cold state; e2e never reuses anything, the P86 lesson).
 */
// Plain .mjs: this runs as the FIRST half of the Playwright webServer
// command (Playwright boots the web server BEFORE globalSetup runs — found
// empirically; a 3D000 from the app was the tell), so it must run under
// bare node with no TS loader.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));

export const E2E_DB = 'taxfs_e2e';
export const E2E_APP_ROLE = 'taxfs_app';
export const E2E_APP_PASSWORD = 'taxfs_app_test_pw';

export function e2eAppUrl(adminUrl) {
  const url = new URL(adminUrl);
  url.pathname = '/' + E2E_DB;
  url.username = E2E_APP_ROLE;
  url.password = E2E_APP_PASSWORD;
  return url.href;
}

async function prepare() {
  const adminUrl = process.env.TAXFS_TEST_DATABASE_URL;
  if (!adminUrl) return; // app specs skip themselves without a database
  const bootstrap = new pg.Client({ connectionString: adminUrl });
  await bootstrap.connect();
  await bootstrap.query(`drop database if exists ${E2E_DB} (force)`).catch(async () => {
    await bootstrap.query(`drop database if exists ${E2E_DB}`);
  });
  await bootstrap.query(`create database ${E2E_DB}`);
  await bootstrap.end();

  const url = new URL(adminUrl);
  url.pathname = '/' + E2E_DB;
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  await admin.query(`
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(coalesce(
        current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
        current_setting('request.jwt.claim.sub', true)
      ), '')::uuid
    $$;
    create schema storage;
    create table storage.buckets (id text primary key, name text not null, public boolean not null default false);
    create table storage.objects (
      id uuid primary key default gen_random_uuid(),
      bucket_id text not null references storage.buckets,
      name text not null, owner uuid, created_at timestamptz not null default now()
    );
    create function storage.foldername(name text) returns text[]
      language sql immutable as $$ select (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1] $$;
    alter table storage.objects enable row level security;
    alter table storage.objects force  row level security;
  `);
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then
        create role authenticated nologin;
      end if;
      if not exists (select 1 from pg_roles where rolname = '${E2E_APP_ROLE}') then
        create role ${E2E_APP_ROLE} login password '${E2E_APP_PASSWORD}';
      end if;
    end $$;
    grant authenticated to ${E2E_APP_ROLE};
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant usage on schema storage to authenticated;
    grant select on storage.buckets to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
  `);
  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith('.sql')) continue;
    await admin.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }
  await admin.end();
  console.log(`[e2e] database ${E2E_DB} ready (migrations applied, restricted role bound)`);
}

await prepare();
