/**
 * P94 — Form 8889 HSA contribution validation (§223 / §4973).
 *  - the limit follows COVERAGE (self-only vs family) + per-person catch-ups,
 *  - employer money (W-2 box 12 W) is pre-tax and never deducts again,
 *  - direct contributions deduct only up to the remaining room,
 *  - anything over the limit is excess and carries the 6% excise to Sch 2,
 *  - kernel2 independently mirrors both the AGI effect and the excise.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p94';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED']): TaxFact => ({
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
    f('w2', C.WAGES, '150000', ['FED', 'IL']),
    f('fwh', C.FED_WITHHOLDING, '20000'),
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

describe('P94 — §223 limit by coverage', () => {
  it('family coverage: employer 5,000 + direct 2,000 → 2,000 deducts, no excess', () => {
    const { m, k2 } = run([
      f('he', C.CONTRIB_HSA_EMPLOYER, '5000'),
      f('hd', C.CONTRIB_HSA_DIRECT, '2000'),
      f('hc', C.HSA_FAMILY_COVERAGE, '1'),
    ]);
    expect(m.get(C.FED_HSA_LIMIT)).toBe('8550');
    expect(m.get(C.FED_HSA_DEDUCTION)).toBe('2000');
    expect(m.get(C.FED_HSA_EXCESS)).toBeUndefined();
    // AGI dropped by exactly the deduction, in BOTH kernels.
    const base = run([]);
    expect(Money.fromString(base.m.get(C.FED_AGI)!).sub(Money.fromString(m.get(C.FED_AGI)!)).toString()).toBe('2000');
    expect(m.get(C.FED_AGI)).toBe(k2.agi);
  });

  it('no coverage fact → conservative self-only limit, and the trail says so', () => {
    const { m, calcs } = run([f('he', C.CONTRIB_HSA_EMPLOYER, '5000')]);
    expect(m.get(C.FED_HSA_LIMIT)).toBe('4300');
    const steps = (calcs.find((c) => c.concept === C.FED_HSA_LIMIT)?.steps ?? []).join('\n');
    expect(steps).toContain('assumed SELF-ONLY');
    // 5,000 employer against a 4,300 limit → 700 excess, 42 excise.
    expect(m.get(C.FED_HSA_EXCESS)).toBe('700');
    expect(m.get(C.FED_HSA_EXCISE)).toBe('42');
  });

  it('each 55+ account holder adds one catch-up to the limit', () => {
    const { m } = run([
      f('hd', C.CONTRIB_HSA_DIRECT, '1000'),
      f('hc', C.HSA_FAMILY_COVERAGE, '1'),
      f('hk', C.HSA_CATCHUP_COUNT, '2'),
    ]);
    expect(m.get(C.FED_HSA_LIMIT)).toBe('10550'); // 8,550 + 2 × 1,000
  });
});

describe('P94 — employer money never deducts, excess reaches the bottom line', () => {
  it('employer-only contributions deduct nothing', () => {
    const { m } = run([
      f('he', C.CONTRIB_HSA_EMPLOYER, '4300'),
    ]);
    expect(m.get(C.FED_HSA_DEDUCTION)).toBeUndefined();
    expect(m.get(C.FED_HSA_EXCESS)).toBeUndefined(); // exactly at the limit
  });

  it('direct money deducts only up to the room employer money left', () => {
    const { m } = run([
      f('he', C.CONTRIB_HSA_EMPLOYER, '4000'),
      f('hd', C.CONTRIB_HSA_DIRECT, '2000'),
    ]);
    // self-only 4,300: room = 300 → deduction 300; total 6,000 → excess 1,700.
    expect(m.get(C.FED_HSA_DEDUCTION)).toBe('300');
    expect(m.get(C.FED_HSA_EXCESS)).toBe('1700');
    expect(m.get(C.FED_HSA_EXCISE)).toBe('102');
  });

  it('the excise raises total tax by exactly 6% of the excess — both kernels', () => {
    const before = run([]);
    const after = run([f('he', C.CONTRIB_HSA_EMPLOYER, '5300')]); // self-only → 1,000 excess
    const delta = Money.fromString(after.m.get(C.FED_TOTAL_TAX_LIABILITY)!)
      .sub(Money.fromString(before.m.get(C.FED_TOTAL_TAX_LIABILITY)!));
    expect(delta.toString()).toBe('60');
    expect(after.m.get(C.FED_TOTAL_TAX_LIABILITY)).toBe(after.k2.total_liability);
  });

  it('no HSA facts → no HSA concepts at all', () => {
    const { m } = run([]);
    expect(m.get(C.FED_HSA_LIMIT)).toBeUndefined();
    expect(m.get(C.FED_HSA_DEDUCTION)).toBeUndefined();
    expect(m.get(C.FED_HSA_EXCISE)).toBeUndefined();
  });
});
