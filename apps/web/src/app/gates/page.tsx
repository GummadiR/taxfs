import { SubmitButton } from '@/components/submit-button';
import { redirect } from 'next/navigation';
import { PageHelp } from '@/components/pagehelp';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine, withUserClient } from '@/server/db';
import { TAX_YEAR } from '@/server/env';
import { filingContext } from '@/server/filing';
import { boardFromRuns, buildOrchestrator, type BoardCell, type BoardFinding } from '@/server/gates';
import { CRITIC_GUIDE, ENGAGEMENT_GUIDE, GATE_GUIDE } from '@/server/guides';
import { humanizeDocRefs } from '@/server/labels';
import { takeBudget } from '@/server/limits';
import { assessEngagement } from '@taxfs/gates';
import type { SourceDoc } from '@taxfs/shared';

const GATE_TITLES: Record<number, string> = {
  0: 'Intake integrity', 1: 'Source confirmation', 2: 'Profile consistency',
  3: 'Rule-data validity', 4: 'Computation & tie-outs', 5: 'Advisory review', 6: 'Package readiness',
};

const ENGAGEMENT_STYLES: Record<string, string> = {
  pass: 'bg-green-100 text-green-800',
  blocked: 'bg-red-100 text-red-800',
  warned: 'bg-amber-100 text-amber-900',
  pending: 'bg-slate-100 text-slate-600',
  not_implemented: 'bg-slate-50 text-slate-400',
};

async function runGates() {
  'use server';
  const { userId, ws } = await requireContext();
  const filing = await withUserClient(userId, async (client) => {
    await takeBudget(client, ws.workspace_id, userId, 'run_gates');
    return filingContext(client, ws.workspace_id);
  });
  if (!filing) redirect('/get-started');
  // The kernel REFUSES rather than assumes when a required figure is
  // missing (non-negotiable #2), and those refusals name exactly what to
  // enter. Without this catch the refusal became an unhandled server-action
  // error and the operator saw a blank framework error page instead of the
  // sentence telling them what to do — a real message replaced by no
  // message at the moment it mattered most.
  let refusal: string | null = null;
  try {
    await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => {
      await buildOrchestrator(spine, filing).runAll();
    });
  } catch (err) {
    if (!(err instanceof Error)) throw err;
    // `redirect()` throws by design; never swallow it.
    if ((err as { digest?: string }).digest?.startsWith('NEXT_REDIRECT')) throw err;
    refusal = err.message;
  }
  redirect(refusal === null ? '/gates' : `/gates?refused=${encodeURIComponent(refusal)}`);
}

/** One finding line, with doc ids resolved to real document names, plus the
 *  critic's why/fix/where story rendered ONCE per critic per cell. */
function Findings({ items, sources, tone }: { items: BoardFinding[]; sources: SourceDoc[]; tone: 'error' | 'warn' }) {
  const color = tone === 'error' ? 'text-red-800' : 'text-amber-900';
  const seen = new Set<string>();
  const guides = items
    .map((f) => f.critic_id)
    .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
    .map((id) => ({ id, guide: CRITIC_GUIDE[id] }))
    .filter((x): x is { id: string; guide: NonNullable<(typeof CRITIC_GUIDE)[string]> } => Boolean(x.guide));
  return (
    <div>
      {items.length > 3 ? (
        <details className={`text-xs ${color}`}>
          <summary className="cursor-pointer font-semibold">{items.length} item(s) — click to list them</summary>
          {items.map((f, i) => <p key={i} className="mt-0.5">{humanizeDocRefs(f.message, sources)}</p>)}
        </details>
      ) : (
        items.map((f, i) => <p key={i} className={`text-xs ${color}`}>{humanizeDocRefs(f.message, sources)}</p>)
      )}
      {guides.map(({ id, guide }) => (
        <div key={id} className="mt-1.5 rounded border border-slate-200 bg-slate-50 p-2 text-xs text-slate-700" data-testid={`critic-guide-${id}`}>
          <p><span className="font-semibold">Why it matters: </span>{guide.why}</p>
          <p className="mt-1"><span className="font-semibold">How to fix it: </span>{guide.fix}</p>
          <a className="mt-1 inline-block underline" href={guide.link.href}>{guide.link.label} →</a>
        </div>
      ))}
    </div>
  );
}

export default async function GatesBoard({ searchParams }: { searchParams: Promise<{ refused?: string }> }) {
  if (!appConfigured()) redirect('/');
  const refused = (await searchParams).refused;
  const { userId, ws } = await requireContext();
  const { gateRuns, sources } = await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => ({
    gateRuns: (await spine.inspect(ws.workspace_id)).gateRuns,
    sources: await spine.getSources(ws.workspace_id, TAX_YEAR),
  }));
  const board = boardFromRuns(gateRuns);
  const byGate = new Map<number, BoardCell[]>();
  for (const c of board) byGate.set(c.gate, [...(byGate.get(c.gate) ?? []), c]);
  const engagement = assessEngagement({ computationalRuns: gateRuns, scope: null, continuity: null, transcript: null });
  return (
    <main>
      <div className="flex items-baseline justify-between">
        <h1 className="text-xl font-black">Gates Board</h1>
        <form action={runGates}>
          <SubmitButton className="rounded bg-slate-900 px-4 py-2 text-sm font-semibold text-white" data-testid="run-gates"
            pendingText="Running gates — computing both jurisdictions…">
            {board.length > 0 ? 'Re-run gates' : 'Run gates 0–6'}
          </SubmitButton>
        </form>
      </div>
      <p className="mt-1 text-sm text-slate-600">
        Seven gates (0–6), run separately for Federal and Illinois. Gates 0–4 and 6 block on any error; gate 5
        warns and never blocks a lawful return. Open “What does this gate check?” under any gate for the story.
      </p>
      {refused ? (
        <section className="mt-3 rounded border border-red-300 bg-red-50 p-3" data-testid="gates-refused">
          <h2 className="text-sm font-bold text-red-900">The gates could not run — a required figure is missing</h2>
          <p className="mt-1 text-sm text-red-900">{refused}</p>
          <p className="mt-1 text-xs text-red-800">
            Nothing was computed and nothing was saved. TaxFS refuses to assume a figure it was not given, because
            an assumed number would print on the return as though it had been verified. Enter what is named above,
            then run the gates again.
          </p>
        </section>
      ) : null}
      <div className="mt-3">
        <PageHelp
          what={'Two checklists: the computational gates 0–6 in the table below (run separately for Federal and Illinois; 0–4 and 6 must be green to file) and, further down, the broader engagement lifecycle 0–13 that wraps around them.'}
          doThis={[
            'Click Run gates after adding or changing data.',
            'Green = passed. Yellow = review the named items. Red names exactly what is missing — with why it matters and how to fix it under each finding.',
            'Gates 0–4 and 6 must be green in both columns before File It will build a package.',
          ]}
        />
      </div>
      {board.length === 0 ? (
        <p className="mt-4 text-sm text-slate-500" data-testid="gates-empty">Gates have not run yet.</p>
      ) : (
        <table className="mt-4 w-full text-sm" data-testid="gates-board">
          <thead>
            <tr className="text-left text-xs uppercase text-slate-500">
              <th className="p-2">Gate</th><th className="p-2">Federal</th><th className="p-2">Illinois</th>
            </tr>
          </thead>
          <tbody>
            {[0, 1, 2, 3, 4, 5, 6].map((g) => {
              const row = byGate.get(g) ?? [];
              const fed = row.find((c) => c.jurisdiction === 'FED');
              const il = row.find((c) => c.jurisdiction === 'IL');
              return (
                <tr key={g} className="border-t border-slate-100 align-top">
                  <td className="p-2">
                    <span className="font-bold">Gate {g}</span> — {GATE_TITLES[g]}
                    <details className="mt-1 text-xs font-normal text-slate-600" data-testid={`gate-guide-${g}`}>
                      <summary className="cursor-pointer text-slate-400">What does this gate check?</summary>
                      <p className="mt-1">{GATE_GUIDE[g]?.what}</p>
                      <p className="mt-1"><span className="font-semibold text-green-700">Pass: </span>{GATE_GUIDE[g]?.pass}</p>
                      <p className="mt-1"><span className="font-semibold text-red-700">Fail: </span>{GATE_GUIDE[g]?.fail}</p>
                    </details>
                  </td>
                  {[fed, il].map((cell, i) => (
                    <td key={i} className="p-2" data-testid={cell ? `gate-${cell.gate}-${cell.jurisdiction}` : undefined}>
                      {cell ? (
                        <>
                          <span className={`rounded px-1.5 py-0.5 text-xs ${
                            cell.result === 'pass' ? 'bg-green-100 text-green-800'
                            : cell.result === 'warn' ? 'bg-amber-100 text-amber-900'
                            : 'bg-red-100 text-red-800'}`}>
                            {cell.result}
                          </span>
                          {cell.errors.length > 0 ? <div className="mt-1"><Findings items={cell.errors} sources={sources} tone="error" /></div> : null}
                          {cell.warnings.length > 0 ? <div className="mt-1"><Findings items={cell.warnings} sources={sources} tone="warn" /></div> : null}
                        </>
                      ) : null}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <section className="mt-6 rounded border border-slate-200 bg-white p-4 text-sm" data-testid="engagement-board">
        <h2 className="font-bold">Engagement lifecycle (gates 0–13)</h2>
        <p className="mt-1 text-xs text-slate-500">
          The CPA-surrogate lifecycle around the computational gates. Unbuilt gates say so — nothing is
          silently green. Items show pending until their inputs exist.
        </p>
        <table className="mt-2 w-full text-left text-xs">
          <thead>
            <tr className="text-slate-500">
              <th className="py-1 pr-2">#</th><th className="py-1 pr-2">Gate</th><th className="py-1 pr-2">Timing</th><th className="py-1">State</th>
            </tr>
          </thead>
          <tbody>
            {engagement.map((g) => (
              <tr key={g.id} className="border-t border-slate-100 align-top" data-testid={`eng-gate-${g.id}`}>
                <td className="py-1 pr-2">{g.id}</td>
                <td className="py-1 pr-2">
                  {g.title}
                  <details className="mt-0.5 font-normal text-slate-500">
                    <summary className="cursor-pointer text-slate-400">what is this?</summary>
                    <p className="mt-0.5">{ENGAGEMENT_GUIDE[g.id]}</p>
                  </details>
                </td>
                <td className="py-1 pr-2">{g.timing.replaceAll('_', ' ')}</td>
                <td className="py-1">
                  <span className={`rounded px-1.5 py-0.5 font-semibold ${ENGAGEMENT_STYLES[g.state] ?? ''}`}>
                    {g.state.replaceAll('_', ' ')}
                  </span>
                  {g.blocking.map((b, i) => <p key={i} className="mt-0.5 text-red-700">{humanizeDocRefs(b, sources)}</p>)}
                  {g.warnings.map((w, i) => <p key={i} className="mt-0.5 text-amber-700">{humanizeDocRefs(w, sources)}</p>)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
