import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine, withUserClient } from '@/server/db';
import { filingContext } from '@/server/filing';
import { TAX_YEAR } from '@/server/env';
import { buildLockedPackage, listPackages } from '@/server/packages';
import { withPostFiling } from '@/server/postfiling';
import { takeBudget } from '@/server/limits';
import { IdentityPanel } from './identity-panel';

async function markFiled(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const channel = formData.get('channel') === 'mef_xml' ? ('mef_xml' as const) : ('paper' as const);
  const rows = await listPackages(userId, ws.workspace_id);
  const head = rows[0]; // listPackages orders version DESC — the head is first
  if (!head || head.status !== 'locked') {
    redirect(`/file-it?msg=${encodeURIComponent('Only a locked package version can be marked Filed.')}`);
  }
  const facts = await withSpine({ userId, workspaceId: ws.workspace_id }, (spine) =>
    spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR }));
  try {
    await withPostFiling(userId, ws.workspace_id, (store) =>
      store.markFiled({
        // §4: manifests are TABLE ROWS — the row's status/id/version are the
        // lock, and the archived manifest inside it still says 'draft' from
        // build time. Project the row's authority onto the manifest so
        // markFiled's own locked-only guard checks the real state.
        manifest: { ...head!.manifest, status: 'locked', package_id: head!.package_id, version: head!.version },
        channel,
        filed_date: new Date().toISOString().slice(0, 10),
        baseline_lines: Object.fromEntries(
          facts.filter((f) => f.derivation !== undefined).map((f) => [f.concept, f.value.toString()])),
      }));
  } catch (e) {
    redirect(`/file-it?msg=${encodeURIComponent(e instanceof Error ? e.message : String(e))}`);
  }
  redirect(`/file-it?msg=${encodeURIComponent('Marked Filed — the filed record is frozen.')}`);
}

async function buildAndLock() {
  'use server';
  const { userId, ws } = await requireContext();
  const { withUserClient } = await import('@/server/db');
  await withUserClient(userId, (client) => takeBudget(client, ws.workspace_id, userId, 'build_package'));
  await buildLockedPackage(userId, ws.workspace_id);
  redirect('/file-it');
}

export default async function FileIt({ searchParams }: { searchParams: Promise<{ msg?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { msg } = await searchParams;
  const filing = await withUserClient(userId, (client) => filingContext(client, ws.workspace_id));
  const filedRecord = await withPostFiling(userId, ws.workspace_id, (store) =>
    store.latestFiling(ws.workspace_id, TAX_YEAR));
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
      {msg ? <p className="mt-2 rounded border border-sky-300 bg-sky-50 p-2 text-sm" role="status" data-testid="fileit-msg">{msg}</p> : null}
      {filedRecord ? (
        <p className="mt-2 rounded border border-emerald-300 bg-emerald-50 p-2 text-sm" data-testid="filed-banner">
          Marked FILED on {filedRecord.filed_date} ({filedRecord.filing_id}, package v{filedRecord.package_version},{' '}
          {filedRecord.channel === 'paper' ? 'paper' : 'e-file'}). The filed record never changes — corrections open a
          case on <a className="underline" href="/amend">Amend</a>; the year-close roll on{' '}
          <a className="underline" href="/year-round">Year-Round</a> is now available.
        </p>
      ) : null}
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
      {rows[0]?.status === 'locked' && !filedRecord ? (
        <form action={markFiled} className="mt-4 flex items-center gap-2 text-sm" data-testid="markfiled-form">
          <select name="channel" className="rounded border border-slate-300 p-2" data-testid="markfiled-channel">
            <option value="paper">filed on paper</option>
            <option value="mef_xml">e-filed (FFFF / MyTax)</option>
          </select>
          <button className="rounded border border-emerald-700 bg-emerald-700 px-3 py-2 font-semibold text-white" data-testid="markfiled">
            Mark as Filed
          </button>
          <span className="text-xs text-slate-500">Freezes the filed record and its column-A baseline for any later 1040-X.</span>
        </form>
      ) : null}
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
