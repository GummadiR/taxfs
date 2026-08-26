/**
 * P73 — an ordinary document upload must never black out the whole return.
 *
 * Found by an audit prompted by a live report. Every test in the suite builds
 * TaxFacts by hand, so no test ever crossed the extraction→kernel boundary:
 * a concept mapping could be stale relative to a kernel guard and every suite
 * stayed green. Two combinations were blanking federal AND Illinois:
 *
 *   - a brokerage 1099 carrying box 7 foreign tax (which P71 taught the reader
 *     to read) — the §904 limitation needs foreign-source income the 1099
 *     never states, and the kernel REFUSED;
 *   - a 15CA/15CB uploaded before an exchange rate is entered.
 *
 * The rule this file pins: omitting a CREDIT raises tax and can never be a
 * windfall, so the return computes and the omission is flagged. Omitting
 * INCOME lowers tax, so that still refuses.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p73';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED', 'IL']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[]) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, '150000'), f('fwh', C.FED_WITHHOLDING, '20000', ['FED']), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P73 — a credit that cannot be computed is FLAGGED, not fatal', () => {
  // Exactly the live shape: JP Morgan box 7 = 61.87, no foreign-source income.
  const box7 = [f('div', C.DIV_ORDINARY, '5408'), f('ftax', C.FOREIGN_TAX_PAID, '61.87', ['FED'])];

  it('a brokerage 1099 with box 7 foreign tax still computes the whole return', () => {
    const { m } = run(box7);
    expect(m.get(C.FED_AGI)).toBe('155408');
    expect(m.get(C.IL_TAX)).toBeDefined(); // Illinois was going dark too
  });

  it('the uncredited tax is recorded, not silently dropped', () => {
    const { m, calcs } = run(box7);
    expect(m.get(C.FED_FTC_NOT_CLAIMED)).toBe('62');
    expect(m.has(C.FED_FTC)).toBe(false);
    const c = calcs.find((x) => x.formula_ref === 'FED.F1116.NOT_CLAIMED');
    expect(c?.steps.join(' ')).toContain('HIGHER than it should be');
  });

  it('omitting the credit is CONSERVATIVE — tax is not understated', () => {
    const withTax = run(box7).m.get(C.FED_TOTAL_TAX_LIABILITY)!;
    const withCredit = run([...box7, f('fi', C.FOREIGN_INCOME, '5000', ['FED'])]).m.get(C.FED_TOTAL_TAX_LIABILITY)!;
    expect(Money.fromString(withTax).gt(Money.fromString(withCredit))).toBe(true);
  });

  it('the §904(j) election still takes it in full', () => {
    const { m } = run([...box7, f('el', C.FTC_DEMINIMIS_ELECTION, '1', ['FED'])]);
    expect(m.get(C.FED_FTC)).toBe('62');
    expect(m.has(C.FED_FTC_NOT_CLAIMED)).toBe(false);
  });

  it('kernel2 agrees — it takes no credit rather than refusing', () => {
    const { m, k2 } = run(box7);
    expect(k2.fed_refund_or_due).toBe(m.get(C.FED_REFUND_OR_DUE));
  });
});

describe('P73 — omitting INCOME still refuses (a windfall, not a conservatism)', () => {
  it('foreign-currency amounts with no exchange rate remain a hard stop', () => {
    // Skipping this income would LOWER tax. That asymmetry is the whole rule.
    expect(() => run([
      f('fi', C.FOREIGN_INCOME_FCY, '9390000', ['FED']),
      f('ft', C.FOREIGN_TAX_FCY, '1358500', ['FED']),
    ])).toThrow(/exchange rate/);
  });
});
