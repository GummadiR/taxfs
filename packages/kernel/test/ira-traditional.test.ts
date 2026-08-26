/**
 * P95 — Traditional IRA validation (§219 / Form 8606 / §4973).
 * Per-person limits and catch-ups; the §219(g) deduction phase-out with the
 * Pub 590-A worksheet mechanics (round UP to $10, $200 floor, spouse-covered
 * range); compensation cap; nondeductible split → 8606 basis; excess → 6%
 * excise reaching the bottom line in BOTH kernels.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type FilingStatus, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p95';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(fs: FilingStatus, wages: string, extra: TaxFact[]) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: fs, il_exemption_count: fs === 'mfj' ? 2 : 1, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, wages, ['FED', 'IL']), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: fs, il_exemption_count: fs === 'mfj' ? 2 : 1, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P95 — §219(g) deductibility', () => {
  it('not covered, no covered spouse → fully deductible at any income', () => {
    const { m, k2 } = run('single', '300000', [f('t', C.CONTRIB_IRA_TRAD_TP, '7000')]);
    expect(m.get(C.FED_IRA_DEDUCTION)).toBe('7000');
    expect(m.get(C.FED_IRA_NONDEDUCTIBLE_TP)).toBeUndefined();
    expect(m.get(C.FED_AGI)).toBe(k2.agi);
  });

  it('covered, MAGI mid-range: single at 84,000 → 7000 × 5000/10000 = 3,500 deductible, 3,500 basis', () => {
    const { m, k2 } = run('single', '84000', [
      f('t', C.CONTRIB_IRA_TRAD_TP, '7000'),
      f('cv', C.W2_RETIREMENT_PLAN_TP, '1'),
    ]);
    expect(m.get(C.FED_IRA_DEDUCTION)).toBe('3500');
    expect(m.get(C.FED_IRA_NONDEDUCTIBLE_TP)).toBe('3500');
    expect(m.get(C.FED_AGI)).toBe(k2.agi);
  });

  it('covered, MAGI above the range → nothing deducts, ALL becomes 8606 basis', () => {
    const { m, calcs } = run('single', '95000', [
      f('t', C.CONTRIB_IRA_TRAD_TP, '7000'),
      f('cv', C.W2_RETIREMENT_PLAN_TP, '1'),
    ]);
    expect(m.get(C.FED_IRA_DEDUCTION)).toBeUndefined();
    expect(m.get(C.FED_IRA_NONDEDUCTIBLE_TP)).toBe('7000');
    const steps = (calcs.find((c) => c.concept === C.FED_IRA_NONDEDUCTIBLE_TP)?.steps ?? []).join('\n');
    expect(steps).toContain('8606');
    expect(steps).toContain('taxed twice');
  });

  it('the $200 floor: covered single at 88,900 → worksheet gives 70, the floor pays 200', () => {
    const { m } = run('single', '88900', [
      f('t', C.CONTRIB_IRA_TRAD_TP, '7000'),
      f('cv', C.W2_RETIREMENT_PLAN_TP, '1'),
    ]);
    expect(m.get(C.FED_IRA_DEDUCTION)).toBe('200');
  });

  it('spouse-covered on a joint return uses the §219(g)(7) range: MAGI 240,000 → 4,200', () => {
    const { m, k2 } = run('mfj', '240000', [
      f('t', C.CONTRIB_IRA_TRAD_TP, '7000'),   // taxpayer NOT covered
      f('cvs', C.W2_RETIREMENT_PLAN_SP, '1'),  // spouse IS covered
    ]);
    // 7000 × (246000−240000)/10000 = 4,200 (already a $10 multiple)
    expect(m.get(C.FED_IRA_DEDUCTION)).toBe('4200');
    expect(m.get(C.FED_AGI)).toBe(k2.agi);
  });

  it('age-50 catch-up raises the person limit to 8,000', () => {
    const { m } = run('single', '60000', [
      f('t', C.CONTRIB_IRA_TRAD_TP, '8000'),
      f('ck', C.IRA_CATCHUP_TP, '1'),
    ]);
    expect(m.get(C.FED_IRA_DEDUCTION)).toBe('8000');
    expect(m.get(C.FED_IRA_EXCESS)).toBeUndefined();
  });
});

describe('P95 — excess contributions', () => {
  it('over the per-person limit → excess + 6% excise into total tax, both kernels', () => {
    const base = run('single', '60000', []);
    const over = run('single', '60000', [f('t', C.CONTRIB_IRA_TRAD_TP, '9000')]); // limit 7000 → 2000 excess
    expect(over.m.get(C.FED_IRA_EXCESS)).toBe('2000');
    expect(over.m.get(C.FED_IRA_EXCISE)).toBe('120');
    const delta = Money.fromString(over.m.get(C.FED_TOTAL_TAX_LIABILITY)!)
      .sub(Money.fromString(base.m.get(C.FED_TOTAL_TAX_LIABILITY)!));
    // deduction (7000) lowers bracket tax; the excise adds 120 — compare k2 for parity instead of a fixed delta
    expect(over.m.get(C.FED_TOTAL_TAX_LIABILITY)).toBe(over.k2.total_liability);
    expect(delta.toString()).toBe(Money.fromString(over.k2.total_liability).sub(Money.fromString(base.k2.total_liability)).toString());
  });

  it('contributions beyond compensation are excess even under the dollar limit', () => {
    const { m } = run('single', '3000', [f('t', C.CONTRIB_IRA_TRAD_TP, '7000')]);
    expect(m.get(C.FED_IRA_EXCESS)).toBe('4000');
    expect(m.get(C.FED_IRA_EXCISE)).toBe('240');
  });

  it('the combined Traditional+Roth limit is per person', () => {
    const { m } = run('single', '60000', [
      f('t', C.CONTRIB_IRA_TRAD_TP, '4000'),
      f('r', C.CONTRIB_IRA_ROTH_TP, '4000'), // combined 8000 vs limit 7000
    ]);
    expect(m.get(C.FED_IRA_EXCESS)).toBe('1000');
  });

  it('two spouses each within their own limit → no excess (limits never pool)', () => {
    const { m } = run('mfj', '120000', [
      f('t1', C.CONTRIB_IRA_TRAD_TP, '7000'),
      f('t2', C.CONTRIB_IRA_TRAD_SP, '7000'),
    ]);
    expect(m.get(C.FED_IRA_EXCESS)).toBeUndefined();
    expect(m.get(C.FED_IRA_DEDUCTION)).toBe('14000');
  });

  it('no IRA facts → no IRA concepts', () => {
    const { m } = run('single', '60000', []);
    expect(m.get(C.FED_IRA_DEDUCTION)).toBeUndefined();
    expect(m.get(C.FED_IRA_EXCESS)).toBeUndefined();
  });
});
