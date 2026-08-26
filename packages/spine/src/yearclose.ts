/**
 * P8.1 — YEAR CLOSE: the roll that turns this year's kernel-emitted
 * carryforward facts (`*.out` / carryforward concepts) into closed
 * registers, which the store rolls into next year's openings (Gate 3
 * continuity then holds openings to these closings, literally).
 *
 * Mapping is data-driven and total: every recognized carryforward concept
 * lands in exactly one register; an UNRECOGNIZED `.out` fact is a hard
 * error — a new carryforward concept must be wired here before year-close
 * can run (never silently dropped).
 *
 * Recorded gaps: basis ENDINGS (7203 line 15 / outside basis) are not yet
 * kernel-emitted facts — only suspended losses roll; per-asset MACRS state
 * rolls when multi-year depreciation lands.
 */
import type { TaxFact } from '@taxfs/shared';
import type { RegisterKind, RegisterSnapshot, SpineBackend } from './contracts';

export interface YearCloseRow {
  register_id: string;
  kind: RegisterKind;
  scope_ref: string;
  balance: string; // balance key inside the register
  amount: string;
  from_fact: string;
}

/** Pure planning: which registers close with which balances. */
export function planYearClose(facts: readonly TaxFact[], tax_year: number): YearCloseRow[] {
  const rows: YearCloseRow[] = [];
  const derived = facts.filter((f) => f.derivation !== undefined && f.status === 'confirmed');
  const scorpById = new Map<string, boolean>();
  for (const f of facts) {
    const m = /^k1\.([a-z0-9][a-z0-9_-]*)\.is_scorp$/.exec(f.concept);
    if (m && f.derivation === undefined) scorpById.set(m[1]!, !f.value.isZero());
  }
  const reg = (kind: RegisterKind, scope: string): string => `reg:${kind}:${scope}:y${tax_year}`;
  for (const f of derived) {
    const c = f.concept;
    const push = (kind: RegisterKind, scope: string, balance: string): void => {
      rows.push({
        register_id: reg(kind, scope), kind, scope_ref: scope, balance,
        amount: f.value.toString(), from_fact: f.fact_id,
      });
    };
    if (c === 'carryover.capital_loss.st.out') push('capital_loss', 'primary', 'st');
    else if (c === 'carryover.capital_loss.lt.out') push('capital_loss', 'primary', 'lt');
    else if (c === 'fed.qbi.loss_carryforward.out') push('qbi_loss', 'primary', 'carryforward');
    else if (c === 'fed.sec179.carryforward') push('depreciation_asset', 'sec179', 'carryforward');
    else if (/^k1\.[a-z0-9][a-z0-9_-]*\.passive_suspended\.out$/.test(c)) {
      const id = c.split('.')[1]!;
      push('passive_loss', `k1:${id}`, 'suspended');
    } else if (/^k1\.[a-z0-9][a-z0-9_-]*\.basis_suspended\.out$/.test(c)) {
      const id = c.split('.')[1]!;
      push(scorpById.get(id) === false ? 'basis_outside' : 'basis_stock', `k1:${id}`, 'suspended_loss');
    } else if (/^schc\.[a-z0-9][a-z0-9_-]*\.homeoffice\.carryover_out$/.test(c)) {
      const id = c.split('.')[1]!;
      push('home_office_carryover', `schc:${id}`, 'carryover');
    } else if (c.endsWith('.out') || c.endsWith('.carryforward')) {
      throw new Error(
        `year-close: unrecognized carryforward concept ${c} — wire it into planYearClose before closing the year (never silently dropped)`,
      );
    }
  }
  return rows;
}

/** Execute the plan: upsert + close each register (the store rolls the
 *  closing into next year's opening). Returns the closed snapshots. */
export async function executeYearClose(
  spine: SpineBackend,
  taxpayer_id: string,
  tax_year: number,
  closed_by_package_id: string,
  facts: readonly TaxFact[],
): Promise<RegisterSnapshot[]> {
  const rows = planYearClose(facts, tax_year);
  const byRegister = new Map<string, YearCloseRow[]>();
  for (const r of rows) byRegister.set(r.register_id, [...(byRegister.get(r.register_id) ?? []), r]);
  const closed: RegisterSnapshot[] = [];
  for (const [register_id, group] of byRegister) {
    const first = group[0]!;
    await spine.upsertRegister({
      register_id,
      taxpayer_id,
      scope_ref: first.scope_ref,
      kind: first.kind,
      tax_year,
      opening: {},
      activity: Object.fromEntries(group.map((g) => [g.balance, g.from_fact])),
      opening_source_ref: null,
    });
    const closing = Object.fromEntries(group.map((g) => [g.balance, g.amount]));
    closed.push(await spine.closeRegister(register_id, closing, closed_by_package_id));
  }
  return closed;
}
