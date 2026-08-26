import { redirect } from 'next/navigation';
import { authConfigured, supabaseServer } from '@/lib/supabase/server';

async function createWorkspace(formData: FormData) {
  'use server';
  const supabase = await supabaseServer();
  if (!supabase) return;
  const name = String(formData.get('display_name') ?? '').trim();
  if (!name) return;
  const { data: ws, error } = await supabase
    .from('workspaces')
    .insert({ display_name: name })
    .select('workspace_id')
    .single();
  if (error || !ws) redirect(`/workspaces?error=${encodeURIComponent(error?.message ?? 'create failed')}`);
  const { data: userData } = await supabase.auth.getUser();
  const { error: memberError } = await supabase
    .from('workspace_members')
    .insert({ workspace_id: ws.workspace_id, user_id: userData.user!.id, role: 'owner' });
  redirect(memberError ? `/workspaces?error=${encodeURIComponent(memberError.message)}` : '/workspaces');
}

async function signOut() {
  'use server';
  const supabase = await supabaseServer();
  if (supabase) await supabase.auth.signOut();
  redirect('/login');
}

export default async function WorkspacesPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  if (!authConfigured()) {
    return (
      <main>
        <h1 className="text-xl font-black">Workspaces</h1>
        <p className="mt-2 text-sm text-slate-600" data-testid="auth-unconfigured">
          Auth is not configured in this environment. Local skeleton mode.
        </p>
      </main>
    );
  }
  const supabase = (await supabaseServer())!;
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect('/login');
  // RLS scopes this to the caller's memberships — no workspace_id filter in
  // app code, and none possible to get wrong (G2).
  const { data: memberships } = await supabase
    .from('workspace_members')
    .select('workspace_id, role, workspaces(display_name)')
    .eq('user_id', userData.user!.id);
  return (
    <main>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-black">Workspaces</h1>
        <form action={signOut}><button className="text-sm underline">Sign out</button></form>
      </div>
      {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
      <ul className="mt-4 space-y-2" data-testid="workspace-list">
        {(memberships ?? []).map((m) => (
          <li key={m.workspace_id} className="rounded border border-slate-200 p-3 text-sm">
            <span className="font-semibold">{(m.workspaces as unknown as { display_name: string })?.display_name}</span>
            <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{m.role}</span>
          </li>
        ))}
        {(memberships ?? []).length === 0 ? <li className="text-sm text-slate-500">No workspaces yet.</li> : null}
      </ul>
      <form action={createWorkspace} className="mt-6 flex gap-2">
        <input name="display_name" required placeholder="New workspace name"
          className="rounded border border-slate-300 p-2 text-sm" />
        <button type="submit" className="rounded bg-slate-900 px-3 py-2 text-sm font-semibold text-white">
          Create workspace
        </button>
      </form>
    </main>
  );
}
