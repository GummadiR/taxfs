import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine, withUserClient } from '@/server/db';
import { filingContext } from '@/server/filing';
import { TAX_YEAR } from '@/server/env';
import { buildLockedPackage, listPackages } from '@/server/packages';
import { takeBudget } from '@/server/limits';
import { IdentityPanel } from './identity-panel';

async function buildAndLock() {
  'use server';
  const { userId, ws } = await requireContext();
  const { withUserClient } = await import('@/server/db');
  await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'build_package'));
  await buildLockedPackage(userId, ws.workspace_id);
  redirect('/file-it');
}

export default async function FileIt() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const filing = await withUserClient(userId, (client) => filingContext(client, ws.workspace_id));
  const { gateRuns } = await withSpine({ userId, workspaceId: ws.workspace_id }, (spine) => spine.inspect(ws.workspace_id));
  const latest = new Map<string, string>();
  for (const run of gateRuns) latest.set(`${run.gate}:${run.jurisdiction}`, run.result);
  const hardGates = [0, 1, 2, 3, 4, 6].flatMap((g) => ['FED', 'IL'].map((j) => `${g}:${j}`));
  const gatesRan = latest.size > 0;
  const hardPass = gatesRan && hardGates.every((k) => latest.get(k) === 'pass' || latest.get(k) === 'ack');
  const rows = await listPackages(userId, ws.workspace_id);
  return (
    <main>
      <h1 className="text-xl font-black">File It — tax year {TAX_YEAR}</h1>
      <p className="mt-1 text-sm text-slate-600">
        Drafts are never stored; a package exists only once it is LOCKED — an immutable row with its manifest,
        validation report and artifact hashes. TaxFS never transmits: you file the printed package yourself.
      </p>
      {!filing ? (
        <p className="mt-4 text-sm">Complete <a className="underline" href="/get-started">Get Started</a> first.</p>
      ) : !hardPass ? (
        <p className="mt-4 text-sm" data-testid="fileit-blocked">
          {gatesRan ? 'Hard gates are not green — fix the findings on the Gates Board first.'
                    : 'Run the gates first — packaging never bypasses them.'}
        </p>
      ) : (
        <form action={buildAndLock} className="mt-4">
          <button className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white" data-testid="build-package">
            Build &amp; lock package
          </button>
        </form>
      )}
      <section className="mt-6">
        <h2 className="font-bold">Locked packages</h2>
        <table className="mt-2 w-full text-sm" data-testid="package-list">
          <thead><tr className="text-left text-xs text-slate-500"><th>Version</th><th>Status</th><th>Forms</th><th>Created</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.package_id} className="border-t border-slate-100">
                <td className="py-1">v{p.version}</td>
                <td>{p.status}</td>
                <td className="text-xs">{p.forms.join(', ')}</td>
                <td className="text-xs">{p.created_at}</td>
              </tr>
            ))}
            {rows.length === 0 ? <tr><td colSpan={4} className="py-2 text-slate-500">No locked packages yet.</td></tr> : null}
          </tbody>
        </table>
      </section>
      <IdentityPanel
        workspaceId={ws.workspace_id}
        pdfs={(rows[0]?.pdfs ?? []).map((p) => ({ ...p, package_id: rows[0]!.package_id }))}
      />
    </main>
  );
}
