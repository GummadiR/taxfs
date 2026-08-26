/**
 * P54 — fixes for real defects the CPA-auditor and CPA-architect critics found
 * in P49–P53. Each test pins the LAW, not the previous implementation.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type FilingStatus, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p54';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED', 'IL']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(fs: FilingStatus, wages: string, extra: TaxFact[] = []) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: fs, il_exemption_count: fs === 'mfj' ? 2 : 1,
    addl_std_boxes: 0, rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, wages), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: fs, il_exemption_count: ctx.il_exemption_count, addl_std_boxes: 0,
    fed_rules: fed, il_rules: il,
  });
  return { m, k2 };
}

describe('P54 — 35 ILCS 5/204(g): the $500k threshold is for JOINT returns only', () => {
  it('MFS at AGI 300,000 LOSES the exemption (250k threshold), like single', () => {
    expect(run('mfs', '300000').m.get(C.IL_EXEMPTION)).toBe('0');
    expect(run('single', '300000').m.get(C.IL_EXEMPTION)).toBe('0');
  });

  it('QSS is not a joint return — it uses the 250k threshold too', () => {
    expect(run('qss', '300000').m.get(C.IL_EXEMPTION)).toBe('0');
  });

  it('MFJ at the same AGI KEEPS it — 300,000 is under the joint 500k threshold', () => {
    expect(run('mfj', '300000').m.get(C.IL_EXEMPTION)).toBe('5550');
  });

  it('kernel2 agrees on the MFS case (independent mirror)', () => {
    const { m, k2 } = run('mfs', '300000');
    expect(k2.il_tax).toBe(m.get(C.IL_TAX));
  });
});

describe('P54 — the QBI override is refused when a limitation is in play', () => {
  const k1 = (extra: TaxFact[]) => [
    f('b1', 'k1.e1.box1', '-40000'),
    f('sc', 'k1.e1.is_scorp', '1'),
    f('mp', 'k1.e1.material_participation', '1'),
    f('bo', 'k1.e1.basis_opening', '5000'), // basis limits the loss
    ...extra,
  ];

  it('refuses an entity-level §199A figure on a basis-suspended activity', () => {
    expect(() => run('mfj', '200000', k1([f('qa', 'k1.e1.qbi_amount', '50000')])))
      .toThrow(/qbi_amount/);
  });

  it('without the override the same return computes normally', () => {
    expect(() => run('mfj', '200000', k1([]))).not.toThrow();
  });
});

describe('P54 — §36B household income includes tax-exempt interest', () => {
  it('tax-exempt interest raises the PTC household income (MAGI), not just IL', () => {
    const withExempt = run('mfj', '60000', [
      f('pp', C.PTC_PREMIUM, '12000', ['FED']),
      f('sl', C.PTC_SLCSP, '14000', ['FED']),
      f('ap', C.PTC_APTC, '9000', ['FED']),
      f('hs', C.PTC_HOUSEHOLD_SIZE, '2', ['FED']),
      f('te', C.TAX_EXEMPT_INTEREST, '30000'),
    ]);
    const without = run('mfj', '60000', [
      f('pp', C.PTC_PREMIUM, '12000', ['FED']),
      f('sl', C.PTC_SLCSP, '14000', ['FED']),
      f('ap', C.PTC_APTC, '9000', ['FED']),
      f('hs', C.PTC_HOUSEHOLD_SIZE, '2', ['FED']),
    ]);
    // Higher MAGI ⇒ higher expected contribution ⇒ a SMALLER net credit (or a
    // larger repayment). Either way the two must differ.
    expect(withExempt.m.get(C.FED_PTC_NET) ?? withExempt.m.get(C.FED_PTC_REPAYMENT))
      .not.toBe(without.m.get(C.FED_PTC_NET) ?? without.m.get(C.FED_PTC_REPAYMENT));
  });
});

describe('P54 — negative entered amounts can never pay the taxpayer', () => {
  it('a negative Form 2210 penalty does NOT increase the refund', () => {
    const clean = run('mfj', '150000', [f('wh', C.FED_WITHHOLDING, '30000', ['FED'])]);
    const bogus = run('mfj', '150000', [
      f('wh', C.FED_WITHHOLDING, '30000', ['FED']),
      f('p', C.FED_EST_TAX_PENALTY, '-5000', ['FED']),
    ]);
    expect(bogus.m.get(C.FED_NET_AMOUNT_DUE)).toBe(clean.m.get(C.FED_NET_AMOUNT_DUE));
  });

  it('a negative IL use tax does NOT reduce Illinois tax', () => {
    const clean = run('mfj', '150000');
    const bogus = run('mfj', '150000', [f('ut', C.IL_USE_TAX, '-900', ['IL'])]);
    expect(bogus.m.get(C.IL_TOTAL_TAX)).toBe(clean.m.get(C.IL_TOTAL_TAX));
  });

  it('a negative other-state credit does NOT increase Illinois tax', () => {
    const clean = run('mfj', '150000');
    const bogus = run('mfj', '150000', [f('cr', C.IL_OTHER_STATE_CREDIT, '-900', ['IL'])]);
    expect(bogus.m.get(C.IL_TAX_AFTER_CREDITS)).toBe(clean.m.get(C.IL_TAX_AFTER_CREDITS));
  });
});
