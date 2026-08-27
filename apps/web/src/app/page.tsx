import Link from 'next/link';
import { appConfigured } from '@/server/context';
import { authUserId } from '@/server/identity';
import { activeWorkspace } from '@/server/workspace';
import { withUserClient } from '@/server/db';
import { TAX_YEAR } from '@/server/env';

export default async function Home() {
  if (!appConfigured()) {
    return (
      <main>
        <h1 className="text-2xl font-black tracking-tight">TaxFS</h1>
        <p className="mt-2 text-sm text-slate-600">
          Phase 4 build. The gate chain — lint (incl. money-lint), typecheck, production build, unit, e2e against
          that build — is enforced before any feature lands.
        </p>
        <p className="mt-2 text-xs text-slate-400" data-testid="workspace-marker">
          not configured: set TAXFS_DATABASE_URL plus Supabase auth or TAXFS_LOCAL_OPERATOR=1
        </p>
      </main>
    );
  }
  const userId = await authUserId();
  const ws = userId ? await activeWorkspace(userId) : null;
  const nav = ws && userId
    ? await withUserClient(userId, async (client) => {
        const r = await client.query(`select * from nav_status where workspace_id = $1`, [ws.workspace_id]);
        return r.rows[0] as { started: boolean; docs_pending: number; last_gates: Date | null; package_version: number | null } | undefined;
      })
    : undefined;
  return (
    <main>
      <h1 className="text-2xl font-black tracking-tight">TaxFS — tax year {TAX_YEAR}</h1>
      {!userId ? (
        <p className="mt-2 text-sm"><Link className="underline" href="/login">Sign in</Link> to begin.</p>
      ) : !ws ? (
        <p className="mt-2 text-sm">Create or open a <Link className="underline" href="/workspaces">workspace</Link> to begin.</p>
      ) : (
        <section className="mt-4 max-w-md rounded border border-slate-200 p-4 text-sm" data-testid="whats-left">
          <h2 className="font-bold">{ws.display_name}</h2>
          <ul className="mt-2 list-disc pl-5">
            <li>{nav?.started ? 'Filing choices saved.' : <>Start with <Link className="underline" href="/get-started">Get Started</Link>.</>}</li>
            <li>{Number(nav?.docs_pending ?? 0) > 0
              ? <>{String(nav?.docs_pending)} document(s) awaiting <Link className="underline" href="/review">review</Link>.</>
              : 'No documents pending review.'}</li>
            <li>{nav?.last_gates ? `Gates last ran ${new Date(nav.last_gates).toISOString()}.` : <>Gates have not run — <Link className="underline" href="/gates">Gates Board</Link>.</>}</li>
            <li>{nav?.package_version ? `Locked package v${nav.package_version}.` : <>No locked package yet — <Link className="underline" href="/file-it">File It</Link>.</>}</li>
          </ul>
        </section>
      )}
    </main>
  );
}
