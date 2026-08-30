/** Per-request context resolution shared by every app page. */
import { redirect } from 'next/navigation';
import { authUserId } from './identity';
import { activeWorkspace, type ActiveWorkspace } from './workspace';
import { dbConfigured, localOperatorMode, supabaseConfigured } from './env';

export interface AppContext {
  userId: string;
  ws: ActiveWorkspace;
}

/** Whether the app can serve workspace pages at all in this deployment. */
export function appConfigured(): boolean {
  return dbConfigured() && (localOperatorMode() || supabaseConfigured());
}

/** Resolve user + active workspace or redirect to where the gap is fixed. */
export async function requireContext(): Promise<AppContext> {
  const userId = await authUserId();
  if (!userId) redirect('/login');
  const ws = await activeWorkspace(userId);
  if (!ws) redirect('/workspaces');
  return { userId, ws };
}

/** Best-effort context for chrome (nav): NEVER redirects or throws — the
 *  layout must render on /login, /workspaces and unconfigured deployments. */
export async function maybeContext(): Promise<AppContext | null> {
  if (!appConfigured()) return null;
  try {
    const userId = await authUserId();
    if (!userId) return null;
    const ws = await activeWorkspace(userId);
    return ws ? { userId, ws } : null;
  } catch {
    return null;
  }
}
