/** Universal badges, ported from TaxOS (H.3): one provenance vocabulary everywhere. */

export type OriginBadge = 'scanned' | 'imported' | 'wizard' | 'manual' | 'calculated';

const ORIGIN_STYLES: Record<OriginBadge, string> = {
  scanned: 'bg-sky-100 text-sky-800',
  imported: 'bg-violet-100 text-violet-800',
  wizard: 'bg-teal-100 text-teal-800',
  manual: 'bg-amber-100 text-amber-800',
  calculated: 'bg-slate-200 text-slate-700',
};

export function Origin({ origin }: { origin: OriginBadge }) {
  return (
    <span
      data-testid="origin-badge"
      className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${ORIGIN_STYLES[origin]}`}
    >
      {origin}
    </span>
  );
}

const SEVERITY_STYLES: Record<string, string> = {
  Error: 'bg-red-100 text-red-800',
  Flag: 'bg-amber-100 text-amber-800',
  Optimization: 'bg-emerald-100 text-emerald-800',
  'Audit-Risk': 'bg-orange-100 text-orange-800',
};

export function Severity({ severity }: { severity: string }) {
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-semibold ${SEVERITY_STYLES[severity] ?? 'bg-slate-200'}`}>
      {severity}
    </span>
  );
}
