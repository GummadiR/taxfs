/**
 * Active-workspace selection. The cookie has an EXPLICIT one-year lifetime
 * (the P89 class: a session-lifetime cookie silently dropped the operator
 * into an empty-looking workspace after a browser restart) and is always
 * verified against live membership — a stale or forged cookie value never
 * becomes an identity.
 */
import { cookies } from 'next/headers';
import { listWorkspaces, requireDbUrl } from './db';

const COOKIE = 'taxfs_ws';
const ONE_YEAR = 60 * 60 * 24 * 365;

export async function setActiveWorkspace(workspaceId: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE, workspaceId, { maxAge: ONE_YEAR, httpOnly: true, sameSite: 'lax', path: '/' });
}

export interface ActiveWorkspace {
  workspace_id: string;
  display_name: string;
  role: string;
  all: { workspace_id: string; display_name: string; role: string }[];
}

/** The caller's memberships plus the cookie-selected active one (membership-
 *  verified; falls back to the first membership when the cookie is stale). */
export async function activeWorkspace(userId: string): Promise<ActiveWorkspace | null> {
  const all = await listWorkspaces({ connectionString: requireDbUrl() }, userId);
  if (all.length === 0) return null;
  const store = await cookies();
  const wanted = store.get(COOKIE)?.value;
  const active = all.find((w) => w.workspace_id === wanted) ?? all[0]!;
  return { ...active, all };
}
