/**
 * Isolation-proof rig (guardrails G1/G2, Blueprint §9.1).
 *
 * Boots the REAL schema on a real Postgres served at TAXFS_TEST_DATABASE_URL
 * (CI: a postgres service container; locally: any throwaway server), then
 * connects AS A NON-OWNER ROLE exactly the way the app does — RLS forced,
 * auth.uid() resolved from JWT-claim GUCs. Nothing here mocks the database:
 * the walls under test are the ones production runs.
 *
 * Supabase-owned surfaces are shimmed minimally and verbatim-compatibly:
 * auth.uid() reads the same request.jwt claims Supabase's does, and the
 * storage schema carries the same buckets/objects/foldername() shape the
 * storage policies bind to. Migrations apply UNMODIFIED.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const migrationsDir = fileURLToPath(new URL('../migrations/', import.meta.url));

export const TEST_DB_URL = process.env.TAXFS_TEST_DATABASE_URL;

const APP_ROLE = 'taxfs_app';
const APP_PASSWORD = 'taxfs_app_test_pw';

export interface Rig {
  /** Connect as the restricted app role, acting as the given auth user. */
  actAs(userId: string): Promise<pg.Client>;
  admin: pg.Client;
  /** Connection config for the restricted app role (PgSpine.create input). */
  appConfig: pg.ClientConfig;
  close(): Promise<void>;
}

export async function bootRig(): Promise<Rig> {
  if (!TEST_DB_URL) throw new Error('TAXFS_TEST_DATABASE_URL is not set');
  const bootstrap = new pg.Client({ connectionString: TEST_DB_URL });
  await bootstrap.connect();
  const dbName = 'taxfs_test_' + Math.random().toString(36).slice(2, 10);
  await bootstrap.query(`create database ${dbName}`);

  const adminUrl = new URL(TEST_DB_URL);
  adminUrl.pathname = '/' + dbName;
  const admin = new pg.Client({ connectionString: adminUrl.href });
  await admin.connect();

  // --- Supabase-compatible shims (production Supabase provides these) ---
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
      name text not null,
      owner uuid,
      created_at timestamptz not null default now()
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
    end $$;
  `);

  // --- the real migrations, applied verbatim, in order ---
  for (const file of readdirSync(migrationsDir).sort()) {
    if (!file.endsWith('.sql')) continue;
    await admin.query(readFileSync(join(migrationsDir, file), 'utf8'));
  }

  // --- the restricted app role (Supabase's `authenticated` analogue) ---
  await admin.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login password '${APP_PASSWORD}';
      end if;
    end $$;
    grant authenticated to ${APP_ROLE};
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    grant usage on schema storage to authenticated;
    grant select on storage.buckets to authenticated;
    grant select, insert, update, delete on storage.objects to authenticated;
  `);

  const appUrl = new URL(TEST_DB_URL);
  appUrl.pathname = '/' + dbName;
  appUrl.username = APP_ROLE;
  appUrl.password = APP_PASSWORD;

  const appClients: pg.Client[] = [];
  const rig: Rig = {
    admin,
    appConfig: { connectionString: appUrl.href },
    async actAs(userId: string) {
      const url = new URL(TEST_DB_URL!);
      url.pathname = '/' + dbName;
      url.username = APP_ROLE;
      url.password = APP_PASSWORD;
      const client = new pg.Client({ connectionString: url.href });
      await client.connect();
      // Hard wall check (TaxOS live lesson: a table-owner connection
      // silently bypasses RLS and only the isolation test can notice).
      const who = await client.query('select current_user');
      if (who.rows[0].current_user !== APP_ROLE) {
        throw new Error(`rig error: connected as ${who.rows[0].current_user}, not ${APP_ROLE} — RLS would not apply`);
      }
      await client.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify({ sub: userId, role: 'authenticated' })]);
      await client.query(`select set_config('request.jwt.claim.sub', $1, false)`, [userId]);
      appClients.push(client);
      return client;
    },
    async close() {
      for (const c of appClients) await c.end().catch(() => {});
      await admin.end().catch(() => {});
      await bootstrap.query(`drop database ${dbName} (force)`).catch(async () => {
        await bootstrap.query(`drop database if exists ${dbName}`).catch(() => {});
      });
      await bootstrap.end().catch(() => {});
    },
  };
  return rig;
}
