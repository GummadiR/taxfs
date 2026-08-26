/**
 * P52 — the underpayment-of-estimated-tax penalty (Form 2210 / IL-2210) must
 * reach the bottom line. On a real 2024 return the preparer showed $570
 * federal and $275 Illinois; TaxOS had no place for either, so it understated
 * what the taxpayer actually owed in BOTH jurisdictions.
 *
 * Both agencies invite you to let them figure the penalty and bill you, so
 * TaxOS carries the entered figure rather than inventing an interest-rate
 * computation — but it is real money owed, so it nets the bottom line.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p52';
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
    f('w2', C.WAGES, '197042'),
    f('fwh', C.FED_WITHHOLDING, '27234', ['FED']),
    f('iwh', C.IL_WITHHOLDING, '9193', ['IL']),
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

describe('P52 — the penalty reaches the bottom line', () => {
  it('with no penalty entered, the net equals the plain refund/due', () => {
    const { m } = run([]);
    expect(m.get(C.FED_NET_AMOUNT_DUE)).toBe(m.get(C.FED_REFUND_OR_DUE));
    expect(m.get(C.IL_NET_AMOUNT_DUE)).toBe(m.get(C.IL_REFUND_OR_DUE));
  });

  it('a federal Form 2210 penalty increases what you owe by exactly that much', () => {
    const base = run([]);
    const withPen = run([f('p', C.FED_EST_TAX_PENALTY, '570', ['FED'])]);
    const before = Money.fromString(base.m.get(C.FED_NET_AMOUNT_DUE)!);
    const after = Money.fromString(withPen.m.get(C.FED_NET_AMOUNT_DUE)!);
    expect(before.sub(after).toString()).toBe('570');
    // The pre-penalty line itself is untouched (1040 line 34/37 semantics).
    expect(withPen.m.get(C.FED_REFUND_OR_DUE)).toBe(base.m.get(C.FED_REFUND_OR_DUE));
  });

  it('an Illinois IL-2210 penalty does the same on the IL side', () => {
    const base = run([]);
    const withPen = run([f('ip', C.IL_EST_TAX_PENALTY, '275', ['IL'])]);
    const before = Money.fromString(base.m.get(C.IL_NET_AMOUNT_DUE)!);
    const after = Money.fromString(withPen.m.get(C.IL_NET_AMOUNT_DUE)!);
    expect(before.sub(after).toString()).toBe('275');
    expect(withPen.m.get(C.IL_REFUND_OR_DUE)).toBe(base.m.get(C.IL_REFUND_OR_DUE));
  });

  it('both penalties apply to their own jurisdiction only', () => {
    const { m } = run([
      f('p', C.FED_EST_TAX_PENALTY, '570', ['FED']),
      f('ip', C.IL_EST_TAX_PENALTY, '275', ['IL']),
    ]);
    const fedGap = Money.fromString(m.get(C.FED_REFUND_OR_DUE)!).sub(Money.fromString(m.get(C.FED_NET_AMOUNT_DUE)!));
    const ilGap = Money.fromString(m.get(C.IL_REFUND_OR_DUE)!).sub(Money.fromString(m.get(C.IL_NET_AMOUNT_DUE)!));
    expect(fedGap.toString()).toBe('570');
    expect(ilGap.toString()).toBe('275');
  });

  it('the trail states the penalty and the sign convention', () => {
    const { calcs } = run([f('p', C.FED_EST_TAX_PENALTY, '570', ['FED'])]);
    const steps = (calcs.find((c) => c.concept === C.FED_NET_AMOUNT_DUE)?.steps ?? []).join('\n');
    expect(steps).toContain('Form 2210 penalty 570');
    expect(steps).toContain('negative = you owe');
  });

  it('kernel2 agrees on both net lines (divergence)', () => {
    const { m, k2 } = run([
      f('p', C.FED_EST_TAX_PENALTY, '570', ['FED']),
      f('ip', C.IL_EST_TAX_PENALTY, '275', ['IL']),
    ]);
    expect(k2.fed_net_amount_due).toBe(m.get(C.FED_NET_AMOUNT_DUE));
    expect(k2.il_net_amount_due).toBe(m.get(C.IL_NET_AMOUNT_DUE));
  });
});
