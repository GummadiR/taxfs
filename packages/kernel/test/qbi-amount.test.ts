/**
 * P51 — the §199A amount a K-1 actually reports (1120-S box 17 code V /
 * 1065 box 20 code Z) can legitimately differ from box 1: health insurance,
 * §179, W-2 wage adjustments. TaxOS previously DERIVED QBI from box 1 with
 * only a yes/no `qbi_eligible` switch, so it could not express the real case
 * found on a professionally-prepared return (Form 8995 QBI 94,441 vs
 * Schedule E net 89,166 — a $5,275 spread).
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p51';
const f = (id: string, concept: string, value: string): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: ['FED', 'IL'], taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[]) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [
    f('w2', C.WAGES, '197042'),
    f('k1b1', 'k1.crm.box1', '91899'),
    f('k1sc', 'k1.crm.is_scorp', '1'),
    f('k1mp', 'k1.crm.material_participation', '1'),
    ...extra,
  ];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P51 — reported §199A amount overrides the box-1 derivation', () => {
  it('without an override, QBI still derives from box 1 (unchanged behaviour)', () => {
    const { m } = run([]);
    // 20% of 91,899 = 18,379.80 → 18,380 (income-limit not binding here).
    expect(m.get(C.FED_QBI_DEDUCTION)).toBe('18380');
  });

  it('a reported §199A amount is used instead of box 1', () => {
    // The real spread: box 1 is 91,899 but the K-1 statement reports 94,441.
    const { m } = run([f('qa', 'k1.crm.qbi_amount', '94441')]);
    expect(m.get(C.FED_QBI_DEDUCTION)).toBe('18888'); // 20% × 94,441
  });

  it('a reported amount BELOW box 1 is honoured too', () => {
    const { m } = run([f('qa', 'k1.crm.qbi_amount', '80000')]);
    expect(m.get(C.FED_QBI_DEDUCTION)).toBe('16000');
  });

  it('qbi_eligible = 0 still wins — an ineligible entity contributes nothing', () => {
    const { m } = run([
      f('qa', 'k1.crm.qbi_amount', '94441'),
      f('qe', 'k1.crm.qbi_eligible', '0'),
    ]);
    expect(m.get(C.FED_QBI_DEDUCTION) ?? '0').toBe('0');
  });

  it('the trail says the reported amount was used and why it can differ', () => {
    const { calcs } = run([f('qa', 'k1.crm.qbi_amount', '94441')]);
    const steps = calcs.flatMap((c) => c.steps).join('\n');
    expect(steps).toContain('§199A amount as reported on the K-1 statement = 94441');
    expect(steps).toContain('health insurance');
  });

  it('kernel2 agrees (divergence)', () => {
    const { m, k2 } = run([f('qa', 'k1.crm.qbi_amount', '94441')]);
    expect(k2.taxable_income).toBe(m.get(C.FED_TAXABLE));
    expect(k2.fed_refund_or_due).toBe(m.get(C.FED_REFUND_OR_DUE));
  });
});
