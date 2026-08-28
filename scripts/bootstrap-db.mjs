/**
 * One-time (idempotent) database setup for LOCAL OPERATOR mode.
 *
 * Creates the taxfs database, the restricted app role the app connects as
 * (never a superuser — PgSpine refuses any role that could bypass RLS), the
 * Supabase-compatible auth/storage shims, and applies every migration in
 * supabase/migrations exactly once. Safe to re-run: applied migrations are
 * recorded in schema_migrations and skipped.
 *
 * Usage (start.bat calls this for you):
 *   node scripts/bootstrap-db.mjs
 * Env:
 *   TAXFS_ADMIN_DATABASE_URL  admin connection (default: local postgres)
 *   TAXFS_DB_NAME             database to create   (default: taxfs)
 *   TAXFS_APP_PASSWORD        app-role password    (default: dev-only value)
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(root, 'supabase/migrations');
const shimPath = join(root, 'supabase/local/auth-shim.sql');

const DB_NAME = process.env.TAXFS_DB_NAME ?? 'taxfs';
// Distinct from the test rigs' `taxfs_app`: Postgres roles are CLUSTER-wide,
// so sharing the name meant whichever ran last reset the other's password
// and broke it. Found by running the gate chain after adding this script.
const APP_ROLE = 'taxfs_local';
const APP_PASSWORD = process.env.TAXFS_APP_PASSWORD ?? 'taxfs_local_dev';
const ADMIN_URL =
  process.env.TAXFS_ADMIN_DATABASE_URL ??
  `postgresql://postgres:${process.env.PGPASSWORD ?? 'postgres'}@127.0.0.1:5432/postgres`;

function appUrl() {
  const url = new URL(ADMIN_URL);
  url.pathname = '/' + DB_NAME;
  url.username = APP_ROLE;
  url.password = APP_PASSWORD;
  return url.href;
}

/** Exit codes the launchers act on: 1 = generic failure (show the error),
 *  2 = the admin password was REJECTED (re-prompting is the fix — nothing
 *  else is; a stopped service or broken migration must not be answered
 *  with a password prompt). */
function fail(message, hint, exitCode = 1) {
  console.error(`\n  TaxFS database setup failed: ${message}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(exitCode);
}

/** Postgres invalid_password / invalid_authorization_specification. */
function isAuthRejection(e) {
  return e?.code === '28P01' || e?.code === '28000';
}

async function main() {
  if (!existsSync(shimPath)) fail(`missing ${shimPath}`);

  // ---- 1. the database itself ----
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  try {
    await admin.connect();
  } catch (e) {
    if (isAuthRejection(e)) {
      fail(
        `PostgreSQL rejected the password for its "postgres" user`,
        'Set PGPASSWORD to the password chosen during PostgreSQL installation (the launcher prompts for it).',
        2,
      );
    }
    fail(
      `cannot reach PostgreSQL at ${new URL(ADMIN_URL).host} (${e.code ?? e.message})`,
      'Is PostgreSQL installed and running? If its password is not "postgres", set PGPASSWORD or TAXFS_ADMIN_DATABASE_URL.',
    );
  }
  const exists = await admin.query(`select 1 from pg_database where datname = $1`, [DB_NAME]);
  if (exists.rowCount === 0) {
    await admin.query(`create database ${DB_NAME}`);
    console.log(`  created database ${DB_NAME}`);
  } else {
    console.log(`  database ${DB_NAME} already exists`);
  }
  await admin.end();

  // ---- 2. shims, app role, migrations ----
  const dbUrl = new URL(ADMIN_URL);
  dbUrl.pathname = '/' + DB_NAME;
  const db = new pg.Client({ connectionString: dbUrl.href });
  await db.connect();

  await db.query(readFileSync(shimPath, 'utf8'));

  // Create the role if absent, and ALWAYS (re)set its password. A role left
  // over from an earlier run or from the test rig carries a DIFFERENT
  // password; only creating-if-absent would report success and hand back a
  // connection string that cannot authenticate. Found by running this twice.
  await db.query(`
    do $$ begin
      if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
        create role ${APP_ROLE} login password '${APP_PASSWORD}';
      else
        alter role ${APP_ROLE} login password '${APP_PASSWORD}';
      end if;
    end $$;
    grant authenticated to ${APP_ROLE};
  `);
  // The wall the adapter also checks at connect: this role must never be
  // able to skip RLS. Assert it here so a mis-created role fails LOUDLY at
  // setup instead of silently disabling every policy at runtime.
  const guard = await db.query(
    `select rolsuper or rolbypassrls as bypass from pg_roles where rolname = $1`,
    [APP_ROLE],
  );
  if (guard.rows[0]?.bypass === true) {
    fail(`role ${APP_ROLE} can bypass row-level security`, 'Drop it and re-run: RLS is the tenant wall.');
  }

  await db.query(`
    create table if not exists schema_migrations (
      filename   text primary key,
      applied_at timestamptz not null default now()
    )
  `);
  const applied = new Set(
    (await db.query(`select filename from schema_migrations`)).rows.map((r) => r.filename),
  );
  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  let ran = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    try {
      await db.query('begin');
      await db.query(readFileSync(join(migrationsDir, file), 'utf8'));
      await db.query(`insert into schema_migrations (filename) values ($1)`, [file]);
      await db.query('commit');
    } catch (e) {
      await db.query('rollback').catch(() => {});
      fail(`migration ${file} failed: ${e.message}`);
    }
    console.log(`  applied ${file}`);
    ran = ran + 1;
  }
  if (ran === 0) console.log(`  migrations already up to date (${files.length} on file)`);
  await db.end();

  console.log('\n  Database ready.\n');
  // start.bat reads this line to build the app's environment.
  console.log(`TAXFS_DATABASE_URL=${appUrl()}`);
}

await main();
