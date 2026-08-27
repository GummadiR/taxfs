import { redirect } from 'next/navigation';
import { appConfigured } from '@/server/context';
import { authUserId } from '@/server/identity';
import { ensureWorkspace, listWorkspaces, requireDbUrl } from '@/server/db';
import { setActiveWorkspace } from '@/server/workspace';
import { localOperatorMode } from '@/server/env';
import { supabaseServer } from '@/lib/supabase/server';

async function createWorkspace(formData: FormData) {
  'use server';
  const userId = await authUserId();
  if (!userId) redirect('/login');
  const name = String(formData.get('display_name') ?? '').trim();
  if (!name) return;
  const id = 'ws_' + crypto.randomUUID().replaceAll('-', '').slice(0, 20);
  await ensureWorkspace({ connectionString: requireDbUrl() }, {
    workspace_id: id,
    auth_user_id: userId,
    display_name: name,
  });
  await setActiveWorkspace(id);
  redirect('/');
}

async function openWorkspace(formData: FormData) {
  'use server';
  const userId = await authUserId();
  if (!userId) redirect('/login');
  const id = String(formData.get('workspace_id') ?? '');
  const memberships = await listWorkspaces({ connectionString: requireDbUrl() }, userId);
  if (!memberships.some((m) => m.workspace_id === id)) throw new Error('not a member of that workspace');
  await setActiveWorkspace(id);
  redirect('/');
}

async function signOut() {
  'use server';
  const supabase = await supabaseServer();
  if (supabase) await supabase.auth.signOut();
  redirect('/login');
}

export default async function WorkspacesPage() {
  if (!appConfigured()) {
    return (
      <main>
        <h1 className="text-xl font-black">Workspaces</h1>
        <p className="mt-2 text-sm text-slate-600" data-testid="auth-unconfigured">
          Not configured in this environment (needs a database, plus Supabase auth or local-operator mode).
        </p>
      </main>
    );
  }
  const userId = await authUserId();
  if (!userId) redirect('/login');
  const memberships = await listWorkspaces({ connectionString: requireDbUrl() }, userId);
  return (
    <main>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-black">Workspaces</h1>
        {localOperatorMode() ? (
          <span className="text-xs text-slate-500">local operator mode</span>
        ) : (
          <form action={signOut}><button className="text-sm underline">Sign out</button></form>
        )}
      </div>
      <ul className="mt-4 space-y-2" data-testid="workspace-list">
        {memberships.map((m) => (
          <li key={m.workspace_id} className="flex items-center justify-between rounded border border-slate-200 p-3 text-sm">
            <span>
              <span className="font-semibold">{m.display_name}</span>
              <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{m.role}</span>
            </span>
            <form action={openWorkspace}>
              <input type="hidden" name="workspace_id" value={m.workspace_id} />
              <button className="rounded border border-slate-300 px-2 py-1 text-xs">Open</button>
            </form>
          </li>
        ))}
        {memberships.length === 0 ? <li className="text-sm text-slate-500">No workspaces yet — create one below.</li> : null}
      </ul>
      <form action={createWorkspace} className="mt-6 flex gap-2">
        <input name="display_name" required placeholder="New workspace name"
          className="rounded border border-slate-300 p-2 text-sm" data-testid="new-workspace-name" />
        <button type="submit" className="rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white">
          Create workspace
        </button>
      </form>
    </main>
  );
}
