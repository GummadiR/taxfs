/**
 * Server environment. Two modes, mutually exclusive by construction:
 *
 * - HOSTED: Supabase auth configured (NEXT_PUBLIC_SUPABASE_URL/ANON_KEY);
 *   the acting user comes from the session JWT.
 * - LOCAL OPERATOR: TAXFS_LOCAL_OPERATOR=1 with a direct restricted-role
 *   DATABASE URL — the operator's own machine and the e2e suite. The SAME
 *   spine, the SAME restricted role, the SAME RLS walls; only the identity
 *   source differs. Setting both is REFUSED loudly: local mode must never
 *   become an auth bypass on a hosted deployment (G2).
 *
 * TAXFS_DATABASE_URL must be a RESTRICTED role (PgSpine refuses roles that
 * could bypass RLS at connect). The active season is TAXFS_TAX_YEAR
 * (default 2025); a junk value refuses to boot (the P99 rule).
 */
import { loadRootEnv } from './load-env';

// Operators put .env files at the REPO ROOT (the TaxOS habit) — honor them.
loadRootEnv();

export function supabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}

export function localOperatorMode(): boolean {
  const on = process.env.TAXFS_LOCAL_OPERATOR === '1';
  if (on && supabaseConfigured()) {
    throw new Error('TAXFS_LOCAL_OPERATOR=1 with Supabase auth configured — refusing: local mode must never bypass hosted auth');
  }
  return on;
}

/** Fixed identity for local-operator mode (synthetic; never a real person). */
export const LOCAL_OPERATOR_UUID = '77777777-7777-4777-8777-777777777777';

export function databaseUrl(): string | null {
  return process.env.TAXFS_DATABASE_URL ?? null;
}

export function dbConfigured(): boolean {
  return databaseUrl() !== null;
}

function activeTaxYear(): number {
  const raw = process.env.TAXFS_TAX_YEAR;
  if (raw === undefined || raw === '') return 2025;
  const year = Number(raw);
  if (!Number.isInteger(year) || year < 2020 || year > 2100) {
    throw new Error(`TAXFS_TAX_YEAR="${raw}" is not a usable tax year (expected e.g. 2026)`);
  }
  return year;
}

export const TAX_YEAR = activeTaxYear();
