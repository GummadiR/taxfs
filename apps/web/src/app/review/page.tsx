import { SubmitButton } from '@/components/submit-button';
import { redirect } from 'next/navigation';
import { PageHelp } from '@/components/pagehelp';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine } from '@/server/db';
import { TAX_YEAR } from '@/server/env';
import type { LineageNode } from '@taxfs/spine';
import { detectSignals } from '@taxfs/agents';
import { withUserClient } from '@/server/db';
import { filingContext } from '@/server/filing';
import {
  buildSummary,
  conceptLabel,
  docTitle,
  IL_LINE_LABELS,
  LINE_EXPLAIN,
  LINE_LABELS,
} from '@/server/labels';
import type { SourceDoc, TaxFact } from '@taxfs/shared';

async function confirmFactAction(formData: FormData) {
  'use server';
  const { userId, ws } = await requireContext();
  const fact_id = String(formData.get('fact_id'));
  const source_id = String(formData.get('source_id') ?? '');
  await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => {
    await spine.confirmFact(fact_id);
    if (source_id) {
      // Confirm the source once every one of its facts is confirmed.
      const facts = await spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR });
      const remaining = facts.filter(
        (f) => f.provenance?.some((p) => p.source_id === source_id) && f.status !== 'confirmed' && f.fact_id !== fact_id,
      );
      if (remaining.length === 0) await spine.confirmSource(source_id);
    }
  });
  redirect('/review');
}

function LineageView({ node, sources, depth = 0 }: { node: LineageNode; sources: SourceDoc[]; depth?: number }) {
  const explain = LINE_EXPLAIN[node.fact.concept];
  return (
    <div className={depth > 0 ? 'ml-4 border-l border-slate-200 pl-3' : ''}>
      <div className="text-xs">
        <span className="font-semibold" title={node.fact.concept}>{conceptLabel(node.fact.concept)}</span>{' '}
        = {node.fact.value.toString()}
        {explain ? (
          <span className="ml-1 cursor-help text-slate-400" title={explain} aria-label={explain}>ⓘ</span>
        ) : null}
      </div>
      {node.calculation ? (
        <div className="mt-1 text-xs text-slate-600">
          <div className="font-mono text-[10px] text-slate-400">{node.calculation.formula_ref} · {node.calculation.rule_version}</div>
          <ul className="list-disc pl-4">
            {node.calculation.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
          {(node.inputs ?? []).map((n) => <LineageView key={n.fact.fact_id} node={n} sources={sources} depth={depth + 1} />)}
        </div>
      ) : (
        <div className="text-[10px] text-slate-400">
          from {(node.sources ?? [])
            .map((x) => docTitle(sources.find((s) => s.source_id === x.source_id) ?? ({ source_id: x.source_id, type: x.type, raw_ref: '', fields: {} } as unknown as SourceDoc)))
            .join(', ') || 'source document'}
        </div>
      )}
    </div>
  );
}

function LineTable({ title, rows, testid }: { title: string; rows: { fact: TaxFact; label: string; explain?: string }[]; testid: string }) {
  return (
    <section className="rounded border border-slate-200 bg-white p-4 text-sm" data-testid={testid}>
      <h2 className="font-bold">{title}</h2>
      <table className="mt-2 w-full">
        <tbody>
          {rows.map(({ fact, label, explain }) => (
            <tr key={fact.fact_id} className="border-t border-slate-100">
              <td className="py-1.5 pr-2">
                <span title={fact.concept}>{label}</span>
                {explain ? (
                  <span className="ml-0.5 cursor-help text-slate-400" title={explain} aria-label={explain}>ⓘ</span>
                ) : null}
              </td>
              <td className="py-1.5 text-right">
                <a className="underline decoration-dotted underline-offset-2" title="Open the full calculation trail"
                  href={`/review?lineage=${encodeURIComponent(fact.fact_id)}`}>
                  {fact.value.toString()}
                </a>
              </td>
            </tr>
          ))}
          {rows.length === 0 ? (
            <tr><td className="py-2 text-slate-500">Nothing computed yet — run the gates from the Gates Board.</td></tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

export default async function Review({ searchParams }: { searchParams: Promise<{ lineage?: string }> }) {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { lineage } = await searchParams;
  const { facts, lineageNode, sources } = await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => ({
    facts: await spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR }),
    lineageNode: lineage ? await spine.getLineage(lineage).catch(() => null) : null,
    sources: await spine.getSources(ws.workspace_id, TAX_YEAR),
  }));
  const { history, filing } = await withUserClient(userId, async (client) => ({
    history: (await client.query(
      `select tax_year, line, value::text as value from history_lines where workspace_id = $1`,
      [ws.workspace_id],
    )).rows as { tax_year: number; line: string; value: string }[],
    filing: await filingContext(client, ws.workspace_id),
  }));
  const discoveryQuestions = detectSignals({ tax_year: TAX_YEAR, sources, facts, history }).map((s2) => ({
    id: s2.id,
    text: `Heads up: ${s2.detail} — is there a document or answer to add?`,
  }));
  const sourced = facts.filter((f) => f.derivation === undefined);
  const derived = facts.filter((f) => f.derivation !== undefined);
  const summary = buildSummary(facts, filing?.filing_status ?? 'single');

  // Headline lines in reading order (curated), then anything else computed.
  const pick = (labels: [string, string][]) =>
    labels
      .map(([concept, label]) => {
        const fact = derived.find((f) => f.concept === concept);
        return fact ? { fact, label, ...(LINE_EXPLAIN[concept] ? { explain: LINE_EXPLAIN[concept] } : {}) } : null;
      })
      .filter((x): x is { fact: TaxFact; label: string; explain?: string } => x !== null);
  const fedRows = pick(LINE_LABELS);
  const ilRows = pick(IL_LINE_LABELS);
  const headline = new Set([...fedRows, ...ilRows].map((r) => r.fact.fact_id));
  const otherRows = derived
    .filter((f) => !headline.has(f.fact_id))
    .sort((a, b) => a.concept.localeCompare(b.concept))
    .map((fact) => ({ fact, label: conceptLabel(fact.concept), ...(LINE_EXPLAIN[fact.concept] ? { explain: LINE_EXPLAIN[fact.concept] } : {}) }));

  return (
    <main>
      <h1 className="text-xl font-black">Review</h1>
      <p className="mt-1 text-sm text-slate-600">
        Nothing counts until you confirm it. Click any computed amount to open its full calculation trail —
        inputs, formula, every step, and the documents behind it. Hover any ⓘ for what a line means and the
        rule behind it.
      </p>
      <div className="mt-3">
        <PageHelp
          what={'Every computed line of your federal and Illinois return, each with a full calculation trail — click any amount to see exactly how it was computed and from which documents.'}
          doThis={[
            'Numbers appear here after the first gates run — Review and the Gates Board are a loop: run gates, review, fix, re-run.',
            'Check the headline numbers (AGI, total tax, refund) against your expectation.',
            'Click any amount to open its lineage — document → value → calculation → line.',
            'Confirm every entered value: nothing counts until you do (G8).',
          ]}
        />
      </div>
      {summary ? (
        <section className="mt-4 rounded border border-indigo-200 bg-indigo-50 p-4 text-sm" data-testid="review-summary">
          <h2 className="font-bold">Your return in plain English</h2>
          <div className="mt-2 grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-xs font-bold uppercase text-indigo-800">Federal</h3>
              {summary.fed.map((s, i) => <p key={i} className="mt-1 text-xs">{s}</p>)}
            </div>
            <div>
              <h3 className="text-xs font-bold uppercase text-indigo-800">Illinois</h3>
              {summary.il.map((s, i) => <p key={i} className="mt-1 text-xs">{s}</p>)}
            </div>
          </div>
          <p className="mt-2 text-[11px] text-indigo-700">
            Every number is clickable in the tables below — the click opens the exact calculation and the
            documents behind it.
          </p>
        </section>
      ) : null}
      {discoveryQuestions.length > 0 ? (
        <section className="mt-4 rounded border border-amber-200 bg-amber-50 p-3" data-testid="discovery-card">
          <h2 className="text-sm font-bold text-amber-900">Anything missing?</h2>
          <ul className="mt-1 list-disc pl-5 text-sm text-amber-900">
            {discoveryQuestions.map((q) => <li key={q.id}>{q.text}</li>)}
          </ul>
        </section>
      ) : null}
      <section className="mt-4">
        <h2 className="font-bold">Entered values</h2>
        <p className="mt-0.5 text-xs text-slate-500">
          What you entered or documents supplied — the G8 door: each value counts only after you confirm it.
        </p>
        <table className="mt-2 w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th>Line</th><th>Value</th><th>Status</th><th /></tr></thead>
          <tbody data-testid="sourced-facts">
            {sourced.map((f) => (
              <tr key={f.fact_id} className="border-t border-slate-100">
                <td className="py-1 pr-2">
                  <span title={f.concept}>{conceptLabel(f.concept)}</span>
                </td>
                <td>{f.value.toString()}</td>
                <td>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${f.status === 'confirmed' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-900'}`}>
                    {f.status}
                  </span>
                </td>
                <td className="text-right">
                  {f.status !== 'confirmed' ? (
                    <form action={confirmFactAction}>
                      <input type="hidden" name="fact_id" value={f.fact_id} />
                      <input type="hidden" name="source_id" value={f.provenance?.[0]?.source_id ?? ''} />
                      <SubmitButton className="rounded border border-slate-300 px-2 py-0.5 text-xs" data-testid={`confirm-${f.fact_id}`}
                        pendingText="Confirming…">
                        Confirm
                      </SubmitButton>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
            {sourced.length === 0 ? <tr><td colSpan={4} className="py-2 text-slate-500">Nothing entered yet.</td></tr> : null}
          </tbody>
        </table>
      </section>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <LineTable title="Federal" rows={fedRows} testid="fed-lines" />
        <LineTable title="Illinois" rows={ilRows} testid="il-lines" />
      </div>
      {otherRows.length > 0 ? (
        <details className="mt-4 rounded border border-slate-200 bg-white p-4 text-sm" data-testid="derived-facts">
          <summary className="cursor-pointer font-bold">
            All supporting lines ({otherRows.length}) — every intermediate the headline numbers are built from
          </summary>
          <table className="mt-2 w-full">
            <tbody>
              {otherRows.map(({ fact, label, explain }) => (
                <tr key={fact.fact_id} className="border-t border-slate-100">
                  <td className="py-1.5 pr-2">
                    <span title={fact.concept}>{label}</span>
                    {explain ? <span className="ml-0.5 cursor-help text-slate-400" title={explain}>ⓘ</span> : null}
                  </td>
                  <td className="py-1.5 text-right">
                    <a className="underline decoration-dotted underline-offset-2" href={`/review?lineage=${encodeURIComponent(fact.fact_id)}`}>
                      {fact.value.toString()}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
      {lineageNode ? (
        <section className="mt-6 rounded border border-slate-200 bg-slate-50 p-3" data-testid="lineage-drawer">
          <h2 className="font-bold">
            How {conceptLabel(lineageNode.fact.concept)} was computed
          </h2>
          <LineageView node={lineageNode} sources={sources} />
        </section>
      ) : null}
    </main>
  );
}
