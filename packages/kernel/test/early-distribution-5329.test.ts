/**
 * P53 — the remaining reconciliation gaps:
 *  - Form 5329 Part I: §72(t) additional tax on early retirement
 *    distributions (part of one return's $634 of "other taxes").
 *  - IL-1040 line 15 (Sch CR) credit for tax paid to another state,
 *    line 21 use tax, and line 28 pass-through entity tax credit —
 *    all present on the real IL-1040s and all previously unmodelled.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p53';
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
  const facts = [
    f('w2', C.WAGES, '150000'),
    f('fwh', C.FED_WITHHOLDING, '20000', ['FED']),
    f('iwh', C.IL_WITHHOLDING, '7000', ['IL']),
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

describe('P53 — Form 5329 §72(t) additional tax', () => {
  it('applies the 10% rate to the amount subject to it', () => {
    const { m } = run([f('ed', C.EARLY_DIST_SUBJECT, '2720', ['FED'])]);
    expect(m.get(C.FED_EARLY_DIST_TAX)).toBe('272');
  });

  it('raises total tax by exactly the additional tax', () => {
    const before = Money.fromString(run([]).m.get(C.FED_TOTAL_TAX_LIABILITY)!);
    const after = Money.fromString(run([f('ed', C.EARLY_DIST_SUBJECT, '2720', ['FED'])]).m.get(C.FED_TOTAL_TAX_LIABILITY)!);
    expect(after.sub(before).toString()).toBe('272');
  });

  it('the trail credits the exceptions to the filer, not the kernel', () => {
    const { calcs } = run([f('ed', C.EARLY_DIST_SUBJECT, '2720', ['FED'])]);
    const steps = (calcs.find((c) => c.concept === C.FED_EARLY_DIST_TAX)?.steps ?? []).join('\n');
    expect(steps).toContain('§72(t)(1)');
    expect(steps).toContain('§72(t)(2) exception');
  });

  it('no early-distribution facts → no additional tax', () => {
    expect(run([]).m.get(C.FED_EARLY_DIST_TAX)).toBeUndefined();
  });
});

describe('P53 — Illinois Sch CR, use tax, PTE credit', () => {
  it('the other-state credit reduces IL tax like the ICR credit does', () => {
    const before = Money.fromString(run([]).m.get(C.IL_TAX_AFTER_CREDITS)!);
    const after = Money.fromString(run([f('cr', C.IL_OTHER_STATE_CREDIT, '500', ['IL'])]).m.get(C.IL_TAX_AFTER_CREDITS)!);
    expect(before.sub(after).toString()).toBe('500');
  });

  it('nonrefundable credits are capped at the tax — they never create a refund', () => {
    const { m } = run([f('cr', C.IL_OTHER_STATE_CREDIT, '9999999', ['IL'])]);
    expect(m.get(C.IL_TAX_AFTER_CREDITS)).toBe('0');
  });

  it('use tax rides on line 21 into TOTAL tax (line 23), not into line 19', () => {
    const base = run([]);
    const withUse = run([f('ut', C.IL_USE_TAX, '150', ['IL'])]);
    // Line 19 (tax after nonrefundable credits) must be UNCHANGED — use tax is
    // an "other tax", not a reduction of the credit computation.
    expect(withUse.m.get(C.IL_TAX_AFTER_CREDITS)).toBe(base.m.get(C.IL_TAX_AFTER_CREDITS));
    // Line 23 (total tax) carries it.
    const before = Money.fromString(base.m.get(C.IL_TOTAL_TAX)!);
    const after = Money.fromString(withUse.m.get(C.IL_TOTAL_TAX)!);
    expect(after.sub(before).toString()).toBe('150');
    // And it reduces the refund by the same amount.
    const rBefore = Money.fromString(base.m.get(C.IL_REFUND_OR_DUE)!);
    const rAfter = Money.fromString(withUse.m.get(C.IL_REFUND_OR_DUE)!);
    expect(rBefore.sub(rAfter).toString()).toBe('150');
  });

  it('the pass-through entity tax credit counts as an IL payment', () => {
    const before = Money.fromString(run([]).m.get(C.IL_PAYMENTS)!);
    const after = Money.fromString(run([f('pte', C.IL_PTE_CREDIT, '3200', ['IL'])]).m.get(C.IL_PAYMENTS)!);
    expect(after.sub(before).toString()).toBe('3200');
  });

  it('kernel2 agrees across all the new IL paths (divergence)', () => {
    const { m, k2 } = run([
      f('cr', C.IL_OTHER_STATE_CREDIT, '500', ['IL']),
      f('ut', C.IL_USE_TAX, '150', ['IL']),
      f('pte', C.IL_PTE_CREDIT, '3200', ['IL']),
      f('ed', C.EARLY_DIST_SUBJECT, '2720', ['FED']),
    ]);
    expect(k2.il_refund_or_due).toBe(m.get(C.IL_REFUND_OR_DUE));
    expect(k2.total_liability).toBe(m.get(C.FED_TOTAL_TAX_LIABILITY));
    expect(k2.fed_net_amount_due).toBe(m.get(C.FED_NET_AMOUNT_DUE));
  });
});
