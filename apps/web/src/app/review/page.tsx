import { LineageProvider, TraceableAmount } from '@/components/lineage';
import { redirect } from 'next/navigation';
import { PageHelp } from '@/components/pagehelp';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine } from '@/server/db';
import { TAX_YEAR } from '@/server/env';
import { detectSignals } from '@taxfs/agents';
import { withUserClient } from '@/server/db';
import { filingContext } from '@/server/filing';
import { buildSummary, conceptLabel, IL_LINE_LABELS, LINE_EXPLAIN, LINE_LABELS } from '@/server/labels';
import { estTaxRules } from '@/server/yearround';
import type { TaxFact } from '@taxfs/shared';

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
                <TraceableAmount factId={fact.fact_id} value={fact.value.toString()} label={label}
                  stale={fact.status === 'stale'} />
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

export default async function Review() {
  if (!appConfigured()) redirect('/');
  const { userId, ws } = await requireContext();
  const { facts, sources } = await withSpine({ userId, workspaceId: ws.workspace_id }, async (spine) => ({
    facts: await spine.getFacts({ taxpayer_id: ws.workspace_id, tax_year: TAX_YEAR }),
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
  const unconfirmed = sourced.filter((f) => f.status !== 'confirmed').length;
  const derived = facts.filter((f) => f.derivation !== undefined);
  const summary = buildSummary(facts, filing?.filing_status ?? 'single', estTaxRules().de_minimis_balance_due);

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
    <LineageProvider>
    <main>
      <h1 className="text-xl font-black">Review</h1>
      <p className="mt-1 text-sm text-slate-600">
        Every computed line of your return. Click any amount to open its full calculation trail — inputs,
        formula, every step, and the documents behind it. Hover any ⓘ for what a line means and the rule
        behind it. Values are confirmed on Documents, beside the evidence.
      </p>
      <div className="mt-3">
        <PageHelp
          what={'Every computed line of your federal and Illinois return, each with a full calculation trail — click any amount to see exactly how it was computed and from which documents.'}
          doThis={[
            'Numbers appear here after the first gates run — Review and the Gates Board are a loop: run gates, review, fix, re-run.',
            'Check the headline numbers (AGI, total tax, refund) against your expectation.',
            'Click any amount to open its lineage — document → value → calculation → line.',
            'Confirm extracted values on Documents — nothing counts until you do (G8).',
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
      {/* Source values live on Documents now, beside the document that
          produced each one — which is also where they are confirmed. Review
          is what came OUT; Documents is what went in. */}
      <section className="mt-4 rounded border border-slate-200 bg-slate-50 p-3 text-sm"
        data-testid="inputs-elsewhere">
        <h2 className="font-bold">What these numbers were built from</h2>
        <p className="mt-1 text-xs text-slate-600">
          {sourced.length} value{sourced.length === 1 ? '' : 's'} from your documents and typed entries.
          Each one is shown on <a className="font-semibold underline" href="/documents">Documents</a>, under
          the document it came from — with the box it was read from and whether it is counting yet.
          {unconfirmed > 0 ? (
            <span className="ml-1 font-semibold text-amber-800" data-testid="confirm-elsewhere">
              {unconfirmed} still need{unconfirmed === 1 ? 's' : ''} your confirmation and {unconfirmed === 1 ? 'is' : 'are'} not
              counting toward your return yet — confirm {unconfirmed === 1 ? 'it' : 'them'} there.
            </span>
          ) : null}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          Or click any amount below to open its full trail back to the document.
        </p>
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
                    <TraceableAmount factId={fact.fact_id} value={fact.value.toString()} label={label}
                      stale={fact.status === 'stale'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ) : null}
    </main>
    </LineageProvider>
  );
}
