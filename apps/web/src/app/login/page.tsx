import { redirect } from 'next/navigation';
import { authConfigured, supabaseServer } from '@/lib/supabase/server';

async function signIn(formData: FormData) {
  'use server';
  const supabase = await supabaseServer();
  if (!supabase) return;
  const email = String(formData.get('email') ?? '');
  const password = String(formData.get('password') ?? '');
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  redirect(error ? `/login?error=${encodeURIComponent(error.message)}` : '/workspaces');
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  if (!authConfigured()) {
    return (
      <main>
        <h1 className="text-xl font-black">Sign in</h1>
        <p className="mt-2 text-sm text-slate-600" data-testid="auth-unconfigured">
          Auth is not configured in this environment (no Supabase URL/key). Local skeleton mode.
        </p>
      </main>
    );
  }
  return (
    <main className="max-w-sm">
      <h1 className="text-xl font-black">Sign in</h1>
      <p className="mt-1 text-sm text-slate-600">Invited testers only. Synthetic identities — no real SSNs.</p>
      {error ? <p className="mt-2 text-sm text-red-700" role="alert">{error}</p> : null}
      <form action={signIn} className="mt-4 space-y-3">
        <label className="block text-sm">
          Email
          <input name="email" type="email" required autoComplete="email"
            className="mt-1 w-full rounded border border-slate-300 p-2" />
        </label>
        <label className="block text-sm">
          Password
          <input name="password" type="password" required autoComplete="current-password"
            className="mt-1 w-full rounded border border-slate-300 p-2" />
        </label>
        <button type="submit" className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white">
          Sign in
        </button>
      </form>
    </main>
  );
}
