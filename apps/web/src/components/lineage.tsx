'use client';

/**
 * The universal lineage drawer. ANY displayed number renders through
 * <TraceableAmount> and opens its source→calc→rule chain via getLineage.
 *
 * P77 — rewritten as a ONE-SCREEN expandable tree. The old design replaced
 * the panel on every drill, so by three levels deep the reader had lost the
 * number they started from. Now the whole derivation stays on screen as an
 * indented outline: every calculated part carries a ▸ that unfolds its own
 * parts IN PLACE, so the path from a W-2 box to the refund line is visible
 * as one picture. Three further reading rules, learned from live use:
 *  - runs of same-kind document rows (a 1099's many sale lots) collapse into
 *    one line with a count and their sum, unfolding on demand;
 *  - a foreign-currency amount or an exchange rate must NEVER wear a $ — the
 *    server tags those nodes with a unit and the client formats accordingly;
 *  - the machine-level proof (concept ids, formula refs, kernel steps) stays
 *    collapsed under "For your CPA", per node.
 */
import { createContext, useContext, useState, type ReactNode } from 'react';
import { fetchLineage } from '@/server/lineage-action';
import type { LineageDto } from '@/server/lineage';

interface DrawerState {
  open(factId: string, label: string): void;
}

const LineageContext = createContext<DrawerState | null>(null);

export function TraceableAmount({
  factId,
  value,
  label,
  stale,
}: {
  factId: string;
  value: string;
  label: string;
  stale?: boolean;
}) {
  const drawer = useContext(LineageContext);
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        data-testid={`amount-${factId}`}
        className="font-mono text-sm underline decoration-dotted underline-offset-4 hover:bg-sky-50 focus:outline-2 focus:outline-sky-600"
        aria-label={`${label}: ${usd(value)}. Open calculation trail.`}
        onClick={() => drawer?.open(factId, label)}
      >
        {usd(value)}
      </button>
      {stale ? (
        <span className="rounded bg-slate-300 px-1 text-[10px] font-semibold uppercase" data-testid="stale-badge">
          stale — recompute pending
        </span>
      ) : null}
    </span>
  );
}

/** $1,234.56 / ($3,000) for negatives — cents shown only when present. */
function usd(v: string): string {
  const n = Number(v);
  if (Number.isNaN(n)) return `$${v}`;
  const cents = !Number.isInteger(n);
  const body = Math.abs(n).toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: 2,
  });
  return n < 0 ? `($${body})` : `$${body}`;
}

/** Unit-aware display: foreign-currency amounts and rates never wear a $. */
function amount(node: Pick<LineageDto, 'value' | 'unit'>): string {
  const n = Number(node.value);
  if (node.unit === 'rate') return `${node.value} per US $1`;
  if (node.unit === 'foreign') {
    if (Number.isNaN(n)) return node.value;
    const body = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
    return n < 0 ? `(${body})` : body;
  }
  return usd(node.value);
}

/** How a number arrived, in plain words — origin wins over child count so a
 *  $0 computed subtotal never reads as "from your records". */
function originWord(node: LineageDto): string {
  if (node.origin === 'calculated') return 'calculated';
  if (node.sources && node.sources.length > 0) return 'from your document';
  if (node.origin === 'manual') return 'you entered this';
  if (node.origin === 'wizard') return 'you answered this';
  return 'from your records';
}

function SourceLine({ node }: { node: LineageDto }) {
  if (!node.sources || node.sources.length === 0) return null;
  return (
    <span className="text-slate-500">
      {' '}from{' '}
      {node.sources.map((sc, i) => (
        <span key={sc.source_id}>
          {i > 0 ? ', ' : ''}
          <a className="underline decoration-dotted" href={`/documents#src-${sc.source_id}`} title={`Open this document (${sc.type})`}>
            {sc.title}
          </a>
        </span>
      ))}
    </span>
  );
}

function UnitChip({ node }: { node: Pick<LineageDto, 'unit'> }) {
  if (node.unit === 'foreign') {
    return <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] uppercase text-amber-800">foreign currency</span>;
  }
  if (node.unit === 'rate') {
    return <span className="ml-1 rounded bg-amber-100 px-1 text-[10px] uppercase text-amber-800">exchange rate</span>;
  }
  return null;
}

/** The technical proof for one node, collapsed by default. */
function CpaDetails({ node, testid }: { node: LineageDto; testid?: string }) {
  if (!node.formula_ref && (!node.steps || node.steps.length === 0)) return null;
  return (
    <details className="rounded border border-slate-200 p-2 text-xs text-slate-500" data-testid={testid}>
      <summary className="cursor-pointer font-semibold text-slate-600">For your CPA — technical details</summary>
      <p className="mt-1">
        Line id: <span className="font-mono">{node.concept}</span>
        {node.formula_ref ? (
          <>
            {' · '}Rule: <span className="font-mono">{node.formula_ref}</span>
          </>
        ) : null}
      </p>
      {node.steps && node.steps.length > 0 ? (
        <ul className="mt-1 list-disc pl-5">
          {node.steps.map((st, i) => (
            <li key={i} className="font-mono">{st}</li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}

/** Children prepared for reading: runs of ≥3 leaf rows of the SAME kind (a
 *  consolidated 1099's sale lots) fold into one group row with a count. */
type RowItem = { kind: 'node'; node: LineageDto } | { kind: 'group'; label: string; nodes: LineageDto[] };

function groupChildren(children: LineageDto[]): RowItem[] {
  const byConcept = new Map<string, LineageDto[]>();
  for (const c of children) {
    if (c.children.length === 0) {
      const bucket = byConcept.get(c.concept) ?? [];
      bucket.push(c);
      byConcept.set(c.concept, bucket);
    }
  }
  const grouped = new Set<string>();
  for (const [concept, nodes] of byConcept) if (nodes.length >= 3) grouped.add(concept);
  const out: RowItem[] = [];
  const emitted = new Set<string>();
  for (const c of children) {
    if (c.children.length === 0 && grouped.has(c.concept)) {
      if (!emitted.has(c.concept)) {
        emitted.add(c.concept);
        out.push({ kind: 'group', label: c.label, nodes: byConcept.get(c.concept)! });
      }
    } else {
      out.push({ kind: 'node', node: c });
    }
  }
  return out;
}

const INDENT_PX = 18;

/** One row of the tree. Calculated rows unfold their parts in place; leaf
 *  rows unfold a one-line "where this came from" note. */
function TreeRow({ node, depth }: { node: LineageDto; depth: number }) {
  const [open, setOpen] = useState(false);
  const hasParts = node.children.length > 0;
  return (
    <>
      <tr className="border-b border-slate-100 align-top">
        <td className="py-1.5 pr-2" style={{ paddingLeft: depth * INDENT_PX }}>
          <button
            type="button"
            className="text-left underline decoration-dotted underline-offset-2 hover:bg-sky-50"
            data-testid={`lineage-drill-${node.concept}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            title={hasParts ? 'Unfold the parts this number is built from' : 'Show where this number came from'}
          >
            <span className="mr-1 inline-block w-3 text-slate-400" aria-hidden>
              {open ? '▾' : '▸'}
            </span>
            {node.label}
          </button>
          <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] uppercase text-slate-500">{originWord(node)}</span>
          <UnitChip node={node} />
          <SourceLine node={node} />
        </td>
        <td className="whitespace-nowrap py-1.5 text-right font-mono">{amount(node)}</td>
      </tr>
      {open ? (
        hasParts ? (
          <>
            {!node.adds_up ? (
              <tr>
                <td colSpan={2} className="pb-1 text-xs italic text-slate-500" style={{ paddingLeft: depth * INDENT_PX + INDENT_PX }}>
                  A tax rule combines these parts (a rate, limit, or threshold) — they don&apos;t simply add up.
                  {node.explain ? ` ${node.explain}` : ' The exact arithmetic is under this row\u2019s "For your CPA".'}
                </td>
              </tr>
            ) : null}
            <TreeRows nodes={node.children} depth={depth + 1} />
            {node.steps && node.steps.length > 0 ? (
              <tr>
                <td colSpan={2} className="py-1" style={{ paddingLeft: depth * INDENT_PX + INDENT_PX }}>
                  <CpaDetails node={node} />
                </td>
              </tr>
            ) : null}
          </>
        ) : (
          <tr>
            <td colSpan={2} className="pb-2 text-xs text-slate-600" style={{ paddingLeft: depth * INDENT_PX + INDENT_PX }} data-testid="lineage-leaf">
              This number was <span className="font-semibold">not calculated</span> — it comes straight
              {node.sources && node.sources.length > 0 ? <SourceLine node={node} /> : ' from your entry'}
              {node.explain ? <>. {node.explain}</> : null}. TaxFS used it exactly as given.
            </td>
          </tr>
        )
      ) : null}
    </>
  );
}

/** A folded run of same-kind document rows (e.g. every sale lot on a 1099). */
function GroupRow({ label, nodes, depth }: { label: string; nodes: LineageDto[]; depth: number }) {
  const [open, setOpen] = useState(false);
  const sum = nodes.reduce((acc, n) => acc + Number(n.value), 0);
  const docTitles = [...new Set(nodes.flatMap((n) => (n.sources ?? []).map((sc) => sc.title)))];
  return (
    <>
      <tr className="border-b border-slate-100 align-top">
        <td className="py-1.5 pr-2" style={{ paddingLeft: depth * INDENT_PX }}>
          <button
            type="button"
            className="text-left underline decoration-dotted underline-offset-2 hover:bg-sky-50"
            data-testid={`lineage-group-${nodes[0]!.concept}`}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
            title="Unfold the individual amounts"
          >
            <span className="mr-1 inline-block w-3 text-slate-400" aria-hidden>
              {open ? '▾' : '▸'}
            </span>
            {label} — {nodes.length} amounts
          </button>
          <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] uppercase text-slate-500">from your document</span>
          {docTitles.length > 0 ? <span className="text-slate-500"> — {docTitles.join(', ')}</span> : null}
        </td>
        <td className="whitespace-nowrap py-1.5 text-right font-mono">{usd(String(sum))}</td>
      </tr>
      {open
        ? nodes.map((n, i) => (
            <tr key={`${n.concept}-${i}`} className="border-b border-slate-50 align-top text-xs">
              <td className="py-1" style={{ paddingLeft: depth * INDENT_PX + INDENT_PX }}>
                {n.label}
                <SourceLine node={n} />
              </td>
              <td className="whitespace-nowrap py-1 text-right font-mono">{amount(n)}</td>
            </tr>
          ))
        : null}
    </>
  );
}

function TreeRows({ nodes, depth }: { nodes: LineageDto[]; depth: number }) {
  const items = groupChildren(nodes);
  return (
    <>
      {items.map((item, i) =>
        item.kind === 'group' ? (
          <GroupRow key={`g-${item.nodes[0]!.concept}-${i}`} label={item.label} nodes={item.nodes} depth={depth} />
        ) : (
          <TreeRow key={`${item.node.concept}-${i}`} node={item.node} depth={depth} />
        ),
      )}
    </>
  );
}

function RootHeader({ node }: { node: LineageDto }) {
  return (
    <div className="rounded bg-sky-50 p-3">
      <p className="text-xs uppercase tracking-wide text-slate-500">{node.label}</p>
      <p className="font-mono text-2xl font-black">{amount(node)}</p>
      {node.explain ? <p className="mt-1 text-sm text-slate-700">{node.explain}</p> : null}
    </div>
  );
}

function Panel({ node }: { node: LineageDto }) {
  // Root with no parts: a straight-from-document number.
  if (node.children.length === 0) {
    return (
      <div className="space-y-3">
        <RootHeader node={node} />
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm" data-testid="lineage-leaf">
          <p>
            This number was <span className="font-semibold">not calculated</span> — it comes straight
            {node.sources && node.sources.length > 0 ? <SourceLine node={node} /> : <span> from your entry</span>}. TaxFS
            used it exactly as given.
          </p>
        </div>
        <CpaDetails node={node} testid="lineage-technical" />
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <RootHeader node={node} />
      <div className="text-sm" data-testid="lineage-ledger">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          {node.adds_up ? 'These parts add up to it — ▸ unfolds any part in place:' : 'Built from these parts — ▸ unfolds any part in place:'}
        </p>
        <table className="w-full">
          <tbody>
            <TreeRows nodes={node.children} depth={0} />
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-slate-400">
              <td className="py-1.5 pr-2 font-semibold">
                {node.adds_up ? '= ' : '→ '}
                {node.label}
              </td>
              <td className="whitespace-nowrap py-1.5 text-right font-mono font-bold">{amount(node)}</td>
            </tr>
          </tfoot>
        </table>
        {!node.adds_up ? (
          <p className="mt-2 text-xs text-slate-500">
            These parts don&apos;t simply add up — a tax rule combines them (rates, limits, or a threshold).
            {node.explain ? ' The one-line explanation above says how; the' : ' The'} exact formula is in
            &quot;For your CPA&quot; below.
          </p>
        ) : null}
      </div>
      <CpaDetails node={node} testid="lineage-technical" />
    </div>
  );
}

export function LineageProvider({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<LineageDto | null>(null);
  const [loading, setLoading] = useState(false);

  const open = (factId: string, _label: string): void => {
    setLoading(true);
    void fetchLineage(factId)
      .then((node) => setRoot(node))
      .finally(() => setLoading(false));
  };
  const close = (): void => setRoot(null);

  return (
    <LineageContext.Provider value={{ open }}>
      {children}
      {(root || loading) && (
        <aside
          role="dialog"
          aria-label="Where this number comes from"
          data-testid="lineage-drawer"
          className="fixed inset-y-0 right-0 z-50 w-full max-w-2xl overflow-y-auto border-l border-slate-300 bg-white p-4 shadow-xl"
        >
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-bold">Where this number comes from</h2>
            <button type="button" className="rounded border px-2 py-1 text-xs" onClick={close} aria-label="Close lineage drawer">
              Close
            </button>
          </div>

          {loading ? <p className="text-sm">Loading…</p> : root ? <Panel node={root} /> : null}

          <p className="mt-4 text-[10px] text-slate-400">
            Every part above traces to your documents or a calculation step — nothing is re-computed for display.
            A folded &quot;N amounts&quot; row shows the sum of the rows inside it, for reading convenience.
          </p>
        </aside>
      )}
    </LineageContext.Provider>
  );
}
