/**
 * P50 — Form 2441 child and dependent care credit (§21), found missing by
 * reconciling a real 2024 return that claimed $600 of it. Nonrefundable
 * (ARPA's 2021 expansion expired): expenses capped by the number of
 * qualifying persons and the §21(d) earned-income limit, times a rate that
 * steps down from 35% to a 20% floor as AGI rises.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p50';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED', 'IL']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(wages: string, extra: TaxFact[]) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, wages), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P50 — Form 2441', () => {
  it('a high-AGI filer gets the 20% floor rate on the one-person cap', () => {
    // The real case: AGI far above the phase-down, 1 qualifying person,
    // expenses at/over the $3,000 cap → 20% × 3,000 = $600.
    const { m } = run('259529', [
      f('dc', C.DEPCARE_EXPENSES, '5000', ['FED']),
      f('dcn', C.DEPCARE_PERSONS, '1', ['FED']),
    ]);
    expect(m.get(C.FED_DEPCARE_CREDIT)).toBe('600');
  });

  it('two or more qualifying persons use the larger expense cap', () => {
    const { m } = run('259529', [
      f('dc', C.DEPCARE_EXPENSES, '9000', ['FED']),
      f('dcn', C.DEPCARE_PERSONS, '2', ['FED']),
    ]);
    expect(m.get(C.FED_DEPCARE_CREDIT)).toBe('1200'); // 20% × 6,000
  });

  it('the rate table is exact at every §21(a)(2) boundary', () => {
    // Read the RATE out of the trail rather than the credit, so the assertion
    // is not silently satisfied by a zero-tax return (the credit is
    // nonrefundable and would be capped to 0 at these AGIs).
    const rateAt = (agi: string): string => {
      const { calcs } = run(agi, [
        f('dc', C.DEPCARE_EXPENSES, '3000', ['FED']),
        f('dcn', C.DEPCARE_PERSONS, '1', ['FED']),
      ]);
      const line = (calcs.find((c) => c.concept === C.FED_DEPCARE_CREDIT)?.steps ?? [])
        .find((x) => x.includes('line 8 rate'))!;
      return line.split('= ').pop()!;
    };
    expect(rateAt('15000')).toBe('0.35'); // at the start — no step
    expect(rateAt('15001')).toBe('0.34'); // "or FRACTION thereof" → one step
    expect(rateAt('17000')).toBe('0.34'); // exactly one whole step
    expect(rateAt('17001')).toBe('0.33');
    expect(rateAt('43000')).toBe('0.21'); // Form 2441 table: over 41k–43k = 21%
    expect(rateAt('43001')).toBe('0.2');  // floor
    expect(rateAt('999999')).toBe('0.2'); // never below the floor
  });

  it('employer dependent care benefits (W-2 box 10) cut the dollar cap — §129', () => {
    // A $5,000 FSA against the $3,000 one-person cap leaves nothing to claim.
    const { m } = run('259529', [
      f('dc', C.DEPCARE_EXPENSES, '6000', ['FED']),
      f('dcn', C.DEPCARE_PERSONS, '1', ['FED']),
      f('dcb', C.DEPCARE_EMPLOYER_BENEFITS, '5000', ['FED']),
    ]);
    expect(m.get(C.FED_DEPCARE_CREDIT)).toBe('0');
  });

  it('a partial FSA reduces the cap proportionally', () => {
    const { m } = run('259529', [
      f('dc', C.DEPCARE_EXPENSES, '6000', ['FED']),
      f('dcn', C.DEPCARE_PERSONS, '2', ['FED']),
      f('dcb', C.DEPCARE_EMPLOYER_BENEFITS, '5000', ['FED']),
    ]);
    expect(m.get(C.FED_DEPCARE_CREDIT)).toBe('200'); // 20% × (6,000 − 5,000)
  });

  it('§21(b)(1): expenses with no qualifying person is refused, not granted', () => {
    expect(() => run('259529', [f('dc', C.DEPCARE_EXPENSES, '3000', ['FED'])]))
      .toThrow(/qualifying_persons/);
  });

  it('the §21(d) earned-income limit caps the expenses when supplied', () => {
    const { m } = run('259529', [
      f('dc', C.DEPCARE_EXPENSES, '5000', ['FED']),
      f('dcn', C.DEPCARE_PERSONS, '1', ['FED']),
      f('ei', C.DEPCARE_EARNED_INCOME_LIMIT, '1500', ['FED']),
    ]);
    expect(m.get(C.FED_DEPCARE_CREDIT)).toBe('300'); // 20% × 1,500
  });

  it('the credit is NONREFUNDABLE — never more than the tax owed', () => {
    // Tiny income: tax is ~0, so the credit cannot create a refund.
    const { m } = run('5000', [
      f('dc', C.DEPCARE_EXPENSES, '3000', ['FED']),
      f('dcn', C.DEPCARE_PERSONS, '1', ['FED']),
    ]);
    expect(m.get(C.FED_DEPCARE_CREDIT)).toBe('0');
  });

  it('no dependent-care facts → no credit and no behaviour change', () => {
    const { m } = run('259529', []);
    expect(m.get(C.FED_DEPCARE_CREDIT)).toBeUndefined();
  });

  it('the trail names the cap, the rate step-down and the nonrefundable limit', () => {
    const { calcs } = run('259529', [
      f('dc', C.DEPCARE_EXPENSES, '5000', ['FED']),
      f('dcn', C.DEPCARE_PERSONS, '1', ['FED']),
    ]);
    const steps = (calcs.find((c) => c.concept === C.FED_DEPCARE_CREDIT)?.steps ?? []).join('\n');
    expect(steps).toContain('2441 line 3');
    expect(steps).toContain('line 8 rate');
    expect(steps).toContain('nonrefundable');
  });

  it('kernel2 agrees on the resulting liability (divergence)', () => {
    const { m, k2 } = run('259529', [
      f('dc', C.DEPCARE_EXPENSES, '5000', ['FED']),
      f('dcn', C.DEPCARE_PERSONS, '1', ['FED']),
    ]);
    expect(k2.total_liability).toBe(m.get(C.FED_TOTAL_TAX_LIABILITY));
    expect(k2.fed_refund_or_due).toBe(m.get(C.FED_REFUND_OR_DUE));
  });
});
