/**
 * P49 — Illinois gaps found by reconciling two real 2024 IL-1040s:
 *  (a) IL-1040 line 2: federally tax-exempt interest is ADDED BACK to Illinois
 *      income; the IL/US-obligation portion comes back as a Sch M subtraction.
 *  (b) IL-1040 Step 4 lines 10b/10c: $1,000 per age-65/blind box, and the
 *      whole exemption allowance is disallowed over the 204(g) AGI threshold.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p49';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED', 'IL']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(facts: TaxFact[], boxes = 0, wages = '100000') {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: 'mfj', il_exemption_count: 2,
    addl_std_boxes: boxes, rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const all = [f('w2', C.WAGES, wages), ...facts];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts: all, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: all.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: boxes, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P49 (a) — IL adds back federally tax-exempt interest', () => {
  it('tax-exempt interest raises IL base income but NOT federal total income', () => {
    const { m } = run([f('te', C.TAX_EXEMPT_INTEREST, '2312')]);
    // Federal: untouched (tax-exempt is not federally taxable).
    expect(m.get(C.FED_TOTAL_INCOME)).toBe('100000');
    // Illinois: base income = fed AGI + 2,312.
    expect(m.get(C.IL_BASE_INCOME)).toBe('102312');
  });

  it('the IL/US-obligation portion is subtracted back out (net effect zero)', () => {
    const { m } = run([
      f('te', C.TAX_EXEMPT_INTEREST, '2312'),
      f('ilob', C.IL_EXEMPT_OBLIGATIONS, '2312', ['IL']),
    ]);
    expect(m.get(C.IL_BASE_INCOME)).toBe('100000');
  });

  it('with no tax-exempt interest nothing changes (regression guard)', () => {
    const { m } = run([]);
    expect(m.get(C.IL_BASE_INCOME)).toBe('100000');
  });
});

describe('P49 (b) — IL age-65/blind exemption and the AGI disallowance', () => {
  it('adds $1,000 per checked box on top of the per-person allowance', () => {
    // Placeholder IL rule-data: 2,775/person × 2 = 5,550 base.
    expect(run([], 0).m.get(C.IL_EXEMPTION)).toBe('5550');
    expect(run([], 1).m.get(C.IL_EXEMPTION)).toBe('6550');
    expect(run([], 4).m.get(C.IL_EXEMPTION)).toBe('9550');
  });

  it('the whole allowance is disallowed above the 204(g) AGI threshold', () => {
    // MFJ threshold 500,000 — wages above it kill the exemption entirely.
    const { m } = run([], 2, '600000');
    expect(m.get(C.IL_EXEMPTION)).toBe('0');
    expect(m.get(C.IL_NET_INCOME)).toBe('600000');
  });

  it('the trail explains the add-on in plain English', () => {
    const steps = (run([], 3).calcs.find((c) => c.concept === C.IL_EXEMPTION)?.steps ?? []).join('\n');
    expect(steps).toContain('3 box(es) × 1000');
    expect(steps).toContain('Step 4 lines 10b/10c');
  });
});

describe('P49 — kernel2 agrees (divergence)', () => {
  it('both engines land on the same IL tax for every new path', () => {
    for (const [facts, boxes, wages] of [
      [[f('te', C.TAX_EXEMPT_INTEREST, '2312')], 0, '100000'],
      [[f('te', C.TAX_EXEMPT_INTEREST, '2312'), f('ilob', C.IL_EXEMPT_OBLIGATIONS, '900', ['IL'])], 2, '100000'],
      [[], 4, '600000'],
    ] as const) {
      const { m, k2 } = run([...facts], boxes, wages);
      expect(k2.il_tax).toBe(m.get(C.IL_TAX));
      expect(k2.il_refund_or_due).toBe(m.get(C.IL_REFUND_OR_DUE));
    }
  });
});
