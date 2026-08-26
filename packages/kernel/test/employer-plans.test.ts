/**
 * P97 — employer-plan validation:
 *  - §402(g) per-person elective-deferral limit across ALL employers, with
 *    the age-50 catch-up and the 60-63 enhanced catch-up that REPLACES it;
 *  - §408(p) SIMPLE limits, checked alone AND inside the aggregate;
 *  - excess deferrals are INCOME (1040 line 1h), not an excise;
 *  - SEP/Solo-401(k): Pub 560 reduced-rate worksheet (25% plan → 20% of net
 *    SE earnings after ½SE), §415(c) cap, §4972 10% excise on the rest.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules, loadGolden, factsOf, ctxOf, TP as GTP } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p97';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[]) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: 'single', il_exemption_count: 1, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, '150000', ['FED', 'IL']), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: 'single', il_exemption_count: 1, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P97 — §402(g) deferrals', () => {
  it('within the base limit → nothing emitted', () => {
    const { m } = run([f('d', C.CONTRIB_DEFERRAL_TP, '23500')]);
    expect(m.get(C.FED_DEFERRAL_EXCESS_INCOME)).toBeUndefined();
  });

  it('over the limit → the excess is INCOME on line 1h, in both kernels', () => {
    const { m, k2 } = run([f('d', C.CONTRIB_DEFERRAL_TP, '25000')]);
    expect(m.get(C.FED_DEFERRAL_EXCESS_INCOME)).toBe('1500');
    expect(m.get(C.FED_TOTAL_INCOME)).toBe(k2.total_income);
    expect(m.get(C.FED_AGI)).toBe(k2.agi);
  });

  it('age-50 catch-up lifts the limit to 31,000', () => {
    const { m } = run([f('d', C.CONTRIB_DEFERRAL_TP, '31000'), f('c', C.IRA_CATCHUP_TP, '1')]);
    expect(m.get(C.FED_DEFERRAL_EXCESS_INCOME)).toBeUndefined();
  });

  it('the 60-63 catch-up REPLACES the age-50 one: limit 34,750', () => {
    const ok = run([f('d', C.CONTRIB_DEFERRAL_TP, '34750'), f('c', C.IRA_CATCHUP_TP, '1'), f('s', C.DEFERRAL_SUPER_CATCHUP_TP, '1')]);
    expect(ok.m.get(C.FED_DEFERRAL_EXCESS_INCOME)).toBeUndefined();
    const over = run([f('d', C.CONTRIB_DEFERRAL_TP, '35000'), f('s', C.DEFERRAL_SUPER_CATCHUP_TP, '1')]);
    expect(over.m.get(C.FED_DEFERRAL_EXCESS_INCOME)).toBe('250');
  });

  it('SIMPLE checks its own §408(p) limit even under the §402(g) aggregate', () => {
    const { m, calcs } = run([f('sd', C.CONTRIB_SIMPLE_TP, '17000')]); // > 16,500
    expect(m.get(C.FED_DEFERRAL_EXCESS_INCOME)).toBe('500');
    const steps = (calcs.find((c) => c.concept === C.FED_DEFERRAL_EXCESS_INCOME)?.steps ?? []).join('\n');
    expect(steps).toContain('§408(p)');
    expect(steps).toContain('April 15');
  });

  it('two W-2 deferral entries for the SAME person aggregate before the check', () => {
    const { m } = run([f('d1', C.CONTRIB_DEFERRAL_TP, '15000'), f('d2', C.CONTRIB_DEFERRAL_TP, '15000')]);
    expect(m.get(C.FED_DEFERRAL_EXCESS_INCOME)).toBe('6500'); // 30,000 − 23,500
  });
});

describe('P97 — SEP / Solo-401(k) for the Sch C business', () => {
  function runSe(extra: TaxFact[]) {
    const g = loadGolden('return4-schc-se');
    const facts = [...factsOf(g), ...extra.map((x) => ({ ...x, taxpayer_id: GTP }))];
    const r = compute({ taxpayer_id: GTP, tax_year: 2025, ctx: ctxOf(g, fed, il), facts, fed_rules: fed, il_rules: il });
    const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
    const k2 = computeHeadlines({
      facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
      filing_status: g.filing_status, il_exemption_count: g.il_exemption_count, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
    });
    return { m, k2, calcs: r.calculations };
  }

  /** The kernel does not emit net SE earnings as a fact; restate it the way
   *  Sch SE does: Sch C net × the §1402(a)(12) factor. */
  function allowedSep(base: ReturnType<typeof runSe>): Money {
    const schcNet = Money.fromString(base.m.get(C.FED_SCHC_NET_PROFIT_TOTAL)!);
    const seNet = schcNet.mulRate(fed.fed!.se!.net_earnings_factor).roundToDollar();
    const seDed = Money.fromString(base.m.get(C.FED_SE_DEDUCTION)!);
    return seNet.sub(seDed).mulFraction('25', '125').roundToDollar();
  }

  it('the worksheet allows 25/125 of (net SE earnings − ½SE), and deducts up to it', () => {
    const base = runSe([]);
    const allowed = allowedSep(base);
    expect(allowed.gt(Money.fromString('1000'))).toBe(true); // a REAL room, not a vacuous zero
    const contrib = allowed.sub(Money.fromString('100')); // safely inside
    const { m, k2 } = runSe([f('sep', C.CONTRIB_SEP, contrib.toString())]);
    expect(m.get(C.FED_SEP_DEDUCTION)).toBe(contrib.toString());
    expect(m.get(C.FED_SEP_EXCESS)).toBeUndefined();
    expect(m.get(C.FED_AGI)).toBe(k2.agi);
  });

  it('over the worksheet cap → nondeductible excess + §4972 10% excise, both kernels', () => {
    const base = runSe([]);
    const allowed = allowedSep(base);
    const contrib = allowed.add(Money.fromString('1000'));
    const { m, k2 } = runSe([f('sep', C.CONTRIB_SEP, contrib.toString())]);
    expect(m.get(C.FED_SEP_EXCESS)).toBe('1000');
    expect(m.get(C.FED_SEP_EXCISE)).toBe('100');
    expect(m.get(C.FED_TOTAL_TAX_LIABILITY)).toBe(k2.total_liability);
  });

  it('a SEP contribution with NO self-employment earnings is entirely excess', () => {
    const { m } = run([f('sep', C.CONTRIB_SEP, '5000')]);
    expect(m.get(C.FED_SEP_DEDUCTION)).toBeUndefined();
    expect(m.get(C.FED_SEP_EXCESS)).toBe('5000');
    expect(m.get(C.FED_SEP_EXCISE)).toBe('500');
  });
});
