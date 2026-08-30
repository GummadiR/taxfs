/**
 * Per-section status for the sidebar — ported from TaxOS's getNavStatus.
 *
 * The sidebar is the operator's map of the return: without it, fifteen
 * numbered links all look equally done, and the only way to find the one
 * thing actually blocking you is to open each section in turn. Each entry
 * answers one question — is this step done, and if not, what is waiting?
 *
 * Cost matters: this runs in the root layout, on EVERY page render. TaxOS
 * read it from a cached in-memory session; TaxFS is serverless and has no
 * such cache (Blueprint §1.3.1), so it is one connection running one
 * aggregate query — counts only, no facts materialized — and it is
 * best-effort: any failure returns an empty map and the nav renders as
 * plain links rather than taking the page down with it.
 */
import { withUserClient } from './db';
import { TAX_YEAR } from './env';

export type NavTone = 'blocked' | 'attention' | 'ok' | 'idle';

export interface NavStatus {
  badge: string;
  tone: NavTone;
  hint: string;
}

interface Counts {
  filing_set: boolean;
  sources: number;
  to_confirm: number;
  derived: number;
  stale: number;
  gates_cells: number;
  gates_failed: number;
  gates_warned: number;
  package_status: string | null;
  package_id: string | null;
}

const COUNTS_SQL = `
with latest_gates as (
  -- NO tax_year filter: the spine's GateRunInput carries no tax year, so
  -- every gate_runs row persists with tax_year 0 (verified against the
  -- schema, not assumed from the column's presence). Filtering on it would
  -- have reported "not run" forever, and the layout swallows query errors
  -- by design — so the mistake would have been an absent badge, never an
  -- error. The e2e assertion on these badges is what keeps it honest.
  select distinct on (gate, jurisdiction) gate, jurisdiction, result
    from gate_runs
   where workspace_id = $1
   order by gate, jurisdiction, ts desc
),
latest_package as (
  select package_id, status from packages
   where workspace_id = $1 and tax_year = $2
   order by version desc limit 1
)
select
  (select count(*) > 0 from filing_contexts where workspace_id = $1 and tax_year = $2) as filing_set,
  (select count(*) from sources where workspace_id = $1 and tax_year = $2) as sources,
  (select count(*) from tax_facts f where f.workspace_id = $1 and f.tax_year = $2
     and f.status = 'unconfirmed' and f.derivation_calc_id is null) as to_confirm,
  (select count(*) from tax_facts where workspace_id = $1 and tax_year = $2
     and derivation_calc_id is not null) as derived,
  (select count(*) from tax_facts where workspace_id = $1 and tax_year = $2
     and status = 'stale') as stale,
  (select count(*) from latest_gates) as gates_cells,
  (select count(*) from latest_gates where result = 'fail') as gates_failed,
  (select count(*) from latest_gates where result = 'warn') as gates_warned,
  (select status from latest_package) as package_status,
  (select package_id from latest_package) as package_id
`;

/** The 14 computational gate cells: gates 0–6 x {FED, IL}. */
const TOTAL_GATE_CELLS = 14;

function statusFrom(c: Counts): Record<string, NavStatus> {
  const out: Record<string, NavStatus> = {};

  // 1 · Get Started — the filing context gate for everything downstream.
  out['/get-started'] = c.filing_set
    ? { badge: 'done', tone: 'ok', hint: 'Filing status and residency are set.' }
    : { badge: 'start here', tone: 'attention',
        hint: 'Set filing status and residency before anything else computes.' };

  // 2 · Documents — an extracted value counts for nothing until you confirm
  // it, so waiting confirmations beat the upload count for the badge.
  out['/documents'] = c.to_confirm > 0
    ? { badge: `${c.to_confirm} to confirm`, tone: 'attention',
        hint: `${c.to_confirm} value(s) are waiting for your confirmation — nothing counts until you confirm it.` }
    : c.sources > 0
      ? { badge: `${c.sources} uploaded`, tone: 'ok',
          hint: `${c.sources} document(s) recorded, nothing awaiting confirmation.` }
      : { badge: 'empty', tone: 'idle', hint: 'No documents uploaded yet.' };

  // 5 · Review — the computed return. A staleness impact matters more than
  // the numbers themselves, because the numbers on screen are then wrong.
  out['/review'] = c.stale > 0
    ? { badge: 'stale', tone: 'attention',
        hint: `${c.stale} value(s) went stale when something changed — re-run the gates to refresh these figures.` }
    : c.derived > 0
      ? { badge: 'computed', tone: 'ok', hint: 'Figures reflect the latest confirmed values.' }
      : { badge: 'not computed', tone: 'idle', hint: 'Nothing computed yet — run the gates.' };

  // 6 · Gates Board — 7 gates x 2 jurisdictions. A single FAILURE is what
  // stops packaging, so failures lead. A gate-5 warning is NOT a failure:
  // gate 5 is advisory and never blocks a lawful return (the rule the board
  // itself states), so a clean return with an advisory note must not wear an
  // amber "13/14" — a false alarm on the one screen that has to be trusted.
  // It is still reported, just in its own words and its own colour.
  out['/gates'] = c.gates_cells === 0
    ? { badge: 'not run', tone: 'idle', hint: 'The gates have not run for this return yet.' }
    : c.gates_failed > 0
      ? { badge: `${c.gates_failed} failing`, tone: 'blocked',
          hint: `${c.gates_failed} gate cell(s) are failing — packaging is blocked until they pass.` }
      : c.gates_cells < TOTAL_GATE_CELLS
        ? { badge: `${c.gates_cells}/${TOTAL_GATE_CELLS} run`, tone: 'attention',
            hint: `${c.gates_cells} of ${TOTAL_GATE_CELLS} gate cells have run — re-run the gates to complete the board.` }
        : c.gates_warned > 0
          ? { badge: `passed · ${c.gates_warned} advisory`, tone: 'ok',
              hint: `Every blocking gate passed. ${c.gates_warned} advisory warning(s) on gate 5, which never blocks a lawful return — worth reading, not fixing.` }
          : { badge: 'all passed', tone: 'ok', hint: `All ${TOTAL_GATE_CELLS} gate cells passed.` };

  // 8 · File It — the filing artifact of record.
  out['/file-it'] = c.package_status === null
    ? { badge: 'no package', tone: 'idle', hint: 'No filing package has been built yet.' }
    : c.package_status === 'locked' || c.package_status === 'filed'
      ? { badge: c.package_status, tone: 'ok',
          hint: `Package ${c.package_id} is ${c.package_status} — this is the filing artifact of record.` }
      : { badge: 'draft', tone: 'attention',
          hint: `Package ${c.package_id} is a draft; it locks only when the validation report is clean.` };

  return out;
}

/**
 * Best-effort. The nav is chrome: it must render on /login, on an
 * unconfigured deployment, and when the database is unreachable. Any
 * failure means no badges, never a failed page.
 */
export async function navStatus(userId: string, workspaceId: string): Promise<Record<string, NavStatus>> {
  try {
    const row = await withUserClient(userId, async (client) => {
      const res = await client.query(COUNTS_SQL, [workspaceId, TAX_YEAR]);
      return res.rows[0] as Record<string, unknown> | undefined;
    });
    if (!row) return {};
    return statusFrom({
      filing_set: Boolean(row['filing_set']),
      sources: Number(row['sources'] ?? 0),
      to_confirm: Number(row['to_confirm'] ?? 0),
      derived: Number(row['derived'] ?? 0),
      stale: Number(row['stale'] ?? 0),
      gates_cells: Number(row['gates_cells'] ?? 0),
      gates_failed: Number(row['gates_failed'] ?? 0),
      gates_warned: Number(row['gates_warned'] ?? 0),
      package_status: (row['package_status'] as string | null) ?? null,
      package_id: (row['package_id'] as string | null) ?? null,
    });
  } catch {
    return {};
  }
}

/** The pure mapping, exported for tests (no database needed). */
export const __navStatusFrom = statusFrom;
