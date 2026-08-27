/**
 * Per-request database access. No global session cache (Blueprint §1.3.1 —
 * serverless lambdas each have their own memory, so globalThis state is a
 * silent bug, the TaxOS class): a spine/connection is opened for the work at
 * hand and closed in finally. Static release data is the only module-scope
 * cache (rules.ts).
 */
import pg from 'pg';
import { PgSpine, ensureWorkspace, listWorkspaces, type SpineBackend } from '@taxfs/spine';
import { databaseUrl } from './env';

export function requireDbUrl(): string {
  const url = databaseUrl();
  if (!url) throw new Error('TAXFS_DATABASE_URL is not configured');
  return url;
}

export async function withSpine<T>(
  identity: { userId: string; workspaceId: string },
  fn: (spine: SpineBackend & { close(): Promise<void> }) => Promise<T>,
): Promise<T> {
  const spine = await PgSpine.create(
    { connectionString: requireDbUrl() },
    { authUserId: identity.userId, workspaceId: identity.workspaceId },
  );
  try {
    return await fn(spine);
  } finally {
    await spine.close();
  }
}

/** Raw statement access AS the authenticated user (settings, nav, packages —
 *  tables outside the spine contract). Claims are pinned exactly like the
 *  spine's own connections; RLS applies identically. */
export async function withUserClient<T>(userId: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: requireDbUrl() });
  await client.connect();
  try {
    await client.query(`select set_config('request.jwt.claims', $1, false)`, [
      JSON.stringify({ sub: userId, role: 'authenticated' }),
    ]);
    return await fn(client);
  } finally {
    await client.end();
  }
}

export { ensureWorkspace, listWorkspaces };
