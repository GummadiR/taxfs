import { redirect } from 'next/navigation';
import { appConfigured, requireContext } from '@/server/context';
import { withSpine } from '@/server/db';
import { TAX_YEAR } from '@/server/env';
import type { LineageNode } from '@taxfs/spine';
import { detectSignals } from '@taxfs/agents';
import { withUserClient } from '@/server/db';

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

function LineageView({ node, depth = 0 }: { node: LineageNode; depth?: number }) {
  return (
    <div className={depth > 0 ? 'ml-4 border-l border-slate-200 pl-3' : ''}>
      <div className="text-xs">
        <span className="font-mono">{node.fact.concept}</span> = {node.fact.value.toString()}
      </div>
      {node.calculation ? (
        <div className="mt-1 text-xs text-slate-600">
          <div className="font-mono text-[10px] text-slate-400">{node.calculation.formula_ref} · {node.calculation.rule_version}</div>
          <ul className="list-disc pl-4">
            {node.calculation.steps.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
          {(node.inputs ?? []).map((n) => <LineageView key={n.fact.fact_id} node={n} depth={depth + 1} />)}
        </div>
      ) : (
        <div className="text-[10px] text-slate-400">
          from {(node.sources ?? []).map((s) => `${s.type} (${s.source_id})`).join(', ') || 'source document'}
        </div>
      )}
    </div>
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
  const history = await withUserClient(userId, async (client) => {
    const r = await client.query(
      `select tax_year, line, value::text as value from history_lines where workspace_id = $1`,
      [ws.workspace_id],
    );
    return r.rows as { tax_year: number; line: string; value: string }[];
  });
  // Deterministic Discovery signals (§6), template-phrased; the harnessed
  // agent phrasing takes over when a live provider is configured.
  const discoveryQuestions = detectSignals({ tax_year: TAX_YEAR, sources, facts, history }).map((s2) => ({
    id: s2.id,
    text: `Heads up: ${s2.detail} — is there a document or answer to add?`,
  }));
  const sourced = facts.filter((f) => f.derivation === undefined);
  const derived = facts.filter((f) => f.derivation !== undefined);
  return (
    <main>
      <h1 className="text-xl font-black">Review</h1>
      <p className="mt-1 text-sm text-slate-600">
        Nothing counts until you confirm it. Derived lines open a full drilldown — inputs, formula, every step.
      </p>
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
        <table className="mt-2 w-full text-sm">
          <thead><tr className="text-left text-xs text-slate-500"><th>Concept</th><th>Value</th><th>Status</th><th /></tr></thead>
          <tbody data-testid="sourced-facts">
            {sourced.map((f) => (
              <tr key={f.fact_id} className="border-t border-slate-100">
                <td className="py-1 font-mono text-xs">{f.concept}</td>
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
                      <button className="rounded border border-slate-300 px-2 py-0.5 text-xs" data-testid={`confirm-${f.fact_id}`}>
                        Confirm
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
            {sourced.length === 0 ? <tr><td colSpan={4} className="py-2 text-slate-500">Nothing entered yet.</td></tr> : null}
          </tbody>
        </table>
      </section>
      <section className="mt-6">
        <h2 className="font-bold">Computed lines</h2>
        <table className="mt-2 w-full text-sm">
          <tbody data-testid="derived-facts">
            {derived.map((f) => (
              <tr key={f.fact_id} className="border-t border-slate-100">
                <td className="py-1 font-mono text-xs">{f.concept}</td>
                <td>{f.value.toString()}</td>
                <td className="text-right">
                  <a className="text-xs underline" href={`/review?lineage=${encodeURIComponent(f.fact_id)}`}>drilldown</a>
                </td>
              </tr>
            ))}
            {derived.length === 0 ? <tr><td colSpan={3} className="py-2 text-slate-500">Run the gates to compute.</td></tr> : null}
          </tbody>
        </table>
      </section>
      {lineageNode ? (
        <section className="mt-6 rounded border border-slate-200 bg-slate-50 p-3" data-testid="lineage-drawer">
          <h2 className="font-bold">Lineage</h2>
          <LineageView node={lineageNode} />
        </section>
      ) : null}
    </main>
  );
}
