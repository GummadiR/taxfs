import { redirect } from 'next/navigation';
import { appConfigured } from '@/server/context';
import { authUserId } from '@/server/identity';
import { ensureWorkspace, listWorkspaces, requireDbUrl } from '@/server/db';
import { setActiveWorkspace } from '@/server/workspace';
import { localOperatorMode } from '@/server/env';
import { supabaseServer } from '@/lib/supabase/server';
import { assertNoIdentityLike } from '@/server/guard';
import { withUserClient } from '@/server/db';
import { MembersList } from './members-list';
import { DangerZone, type LifecycleReport } from './danger-zone';
import { runLifecycle } from '@/server/lifecycle';

async function createWorkspace(formData: FormData) {
  'use server';
  const userId = await authUserId();
  if (!userId) redirect('/login');
  let name = '';
  try {
    name = assertNoIdentityLike(String(formData.get('display_name') ?? '').trim(), 'Workspace name');
  } catch (e) {
    redirect(`/workspaces?error=${encodeURIComponent((e as Error).message)}`);
  }
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

async function addMember(formData: FormData) {
  'use server';
  const userId = await authUserId();
  if (!userId) redirect('/login');
  const workspace_id = String(formData.get('workspace_id'));
  const member = String(formData.get('user_id') ?? '').trim();
  const role = String(formData.get('role'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(member)) {
    redirect(`/workspaces?error=${encodeURIComponent('Member id must be the invitee\u2019s auth user id (a UUID from their Supabase account).')}`);
  }
  if (!['reviewer', 'editor'].includes(role)) throw new Error('role must be reviewer or editor');
  try {
    await withUserClient(userId, (client) =>
      client.query(
        `insert into workspace_members (workspace_id, user_id, role) values ($1, $2, $3)
         on conflict (workspace_id, user_id) do update set role = excluded.role`,
        [workspace_id, member, role],
      ));
  } catch {
    redirect(`/workspaces?error=${encodeURIComponent('Only a workspace owner can manage members (the database refused the write).')}`);
  }
  redirect('/workspaces');
}

async function removeMember(formData: FormData) {
  'use server';
  const userId = await authUserId();
  if (!userId) redirect('/login');
  await withUserClient(userId, (client) =>
    client.query(`delete from workspace_members where workspace_id = $1 and user_id = $2 and user_id <> $3`, [
      String(formData.get('workspace_id')), String(formData.get('user_id')), userId,
    ]));
  redirect('/workspaces');
}

/**
 * Reset/Delete, called from the client component. It returns a report rather
 * than redirecting: the caller has browser-only work to finish afterwards
 * (clearing the identity vault), and a redirect would unmount it first.
 * Errors come back as data — including the database's own refusal, which is
 * the message the operator most needs to see verbatim.
 */
async function runLifecycleAction(
  workspaceId: string,
  action: 'reset' | 'delete',
  confirmName: string,
): Promise<LifecycleReport> {
  'use server';
  const userId = await authUserId();
  if (!userId) redirect('/login');
  const empty = { action, display_name: '', rows: 0, by_table: [], documents: 0, orphaned_documents: [] };
  try {
    return await runLifecycle(userId, workspaceId, action, confirmName);
  } catch (e) {
    return { ...empty, error: (e as Error).message };
  }
}

async function signOut() {
  'use server';
  const supabase = await supabaseServer();
  if (supabase) await supabase.auth.signOut();
  redirect('/login');
}

export default async function WorkspacesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
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
      {error ? <p className="mt-2 text-sm text-red-700" role="alert" data-testid="workspace-error">{error}</p> : null}
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
      <section className="mt-8 rounded border border-slate-200 p-4">
        <h2 className="font-bold">Members (invite the CPA as a reviewer)</h2>
        <p className="mt-1 text-xs text-slate-600">
          A <span className="font-semibold">reviewer</span> can read everything in a workspace and change nothing —
          enforced by the database, not by the UI. Add them by their auth user id; they sign in with their own
          account. Owner-only: the database refuses anyone else.
        </p>
        <MembersList openAction={removeMember} memberships={memberships} userId={userId} />
        <form action={addMember} className="mt-3 flex flex-wrap gap-2 text-sm">
          <select name="workspace_id" className="rounded border border-slate-300 p-2" data-testid="member-workspace">
            {memberships.filter((m) => m.role === 'owner').map((m) => (
              <option key={m.workspace_id} value={m.workspace_id}>{m.display_name}</option>
            ))}
          </select>
          <input name="user_id" required placeholder="Invitee auth user id (UUID)"
            className="w-80 rounded border border-slate-300 p-2 font-mono text-xs" data-testid="member-uuid" />
          <select name="role" className="rounded border border-slate-300 p-2" data-testid="member-role">
            <option value="reviewer">reviewer (read-only)</option>
            <option value="editor">editor</option>
          </select>
          <button className="rounded bg-slate-900 px-3 py-2 font-semibold text-white" data-testid="member-add">Add member</button>
        </form>
      </section>
      <DangerZone
        owned={memberships.filter((m) => m.role === 'owner').map((m) => ({
          workspace_id: m.workspace_id,
          display_name: m.display_name,
        }))}
        run={runLifecycleAction}
      />
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
