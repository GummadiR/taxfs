/**
 * P45 — IRC §63(f) additional standard deduction for age 65+ / blindness.
 * Each checked box adds one per-box amount ($2,000 unmarried / $1,600 married
 * on 2025 placeholder rule-data) to the base standard deduction, before the
 * greater-of-itemized test. kernel2 mirrors the same math (divergence check).
 */
import { describe, expect, it } from 'vitest';
import { C, type FilingContext, type FilingStatus } from '@taxfs/shared';
import { compute, type KernelInput } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { TP, factsOf, loadFedRules, loadGolden, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
// A bare wages-only return (single, std 15,000; mfj base 30,000) so the moving
// part is purely the age/blind add-on.
const golden = loadGolden('return1-single-w2');
const facts = factsOf(golden);

function run(filing_status: FilingStatus, addl_std_boxes: number) {
  const ctx: FilingContext = {
    taxpayer_id: TP,
    tax_year: 2025,
    filing_status,
    il_exemption_count: filing_status === 'mfj' ? 2 : 1,
    addl_std_boxes,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const input: KernelInput = { taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il };
  const lines = new Map(compute(input).computedFacts.map((f) => [f.concept, f.value.toString()]));
  const k2 = computeHeadlines({
    facts: golden.facts.map((f) => ({ concept: f.concept, value: f.value, taxpayer_scope: f.scope })),
    filing_status,
    il_exemption_count: ctx.il_exemption_count,
    addl_std_boxes,
    fed_rules: fed,
    il_rules: il,
  });
  return { lines, k2 };
}

describe('P45 — §63(f) age/blind standard-deduction add-on', () => {
  it('no boxes checked leaves the base standard deduction untouched', () => {
    const { lines } = run('single', 0);
    expect(lines.get(C.FED_STD_DEDUCTION)).toBe('15000');
    expect(lines.get(C.FED_TAXABLE)).toBe('45000'); // 60,000 − 15,000
  });

  it('unmarried filer: +$2,000 per box', () => {
    expect(run('single', 1).lines.get(C.FED_STD_DEDUCTION)).toBe('17000');
    expect(run('single', 2).lines.get(C.FED_STD_DEDUCTION)).toBe('19000'); // both self boxes
    // Taxable income drops by the same add-on.
    expect(run('single', 2).lines.get(C.FED_TAXABLE)).toBe('41000'); // 60,000 − 19,000
  });

  it('married filer: +$1,600 per box, up to four boxes', () => {
    expect(run('mfj', 0).lines.get(C.FED_STD_DEDUCTION)).toBe('30000');
    expect(run('mfj', 2).lines.get(C.FED_STD_DEDUCTION)).toBe('33200'); // 30,000 + 2×1,600
    expect(run('mfj', 4).lines.get(C.FED_STD_DEDUCTION)).toBe('36400'); // 30,000 + 4×1,600
  });

  it('the calculation trail spells out the §63(f) add-on for the reader', () => {
    const input: KernelInput = {
      taxpayer_id: TP,
      tax_year: 2025,
      ctx: {
        taxpayer_id: TP,
        tax_year: 2025,
        filing_status: 'mfj',
        il_exemption_count: 2,
        addl_std_boxes: 3,
        rule_versions: { FED: fed.rule_version, IL: il.rule_version },
      },
      facts,
      fed_rules: fed,
      il_rules: il,
    };
    const std = compute(input).calculations.find((c) => c.concept === C.FED_STD_DEDUCTION);
    const steps = (std?.steps ?? []).join('\n');
    expect(steps).toContain('§63(f)');
    expect(steps).toContain('3 box(es) × 1600');
    expect(steps).toContain('30000 + 4800 = 34800');
  });

  it('kernel2 agrees with the kernel on the bumped deduction (divergence)', () => {
    for (const [fs, boxes] of [['single', 2], ['mfj', 4], ['mfj', 1]] as const) {
      const { lines, k2 } = run(fs, boxes);
      expect(k2.taxable_income).toBe(lines.get(C.FED_TAXABLE));
      expect(k2.fed_tax_total).toBe(lines.get(C.FED_TAX));
      expect(k2.fed_refund_or_due).toBe(lines.get(C.FED_REFUND_OR_DUE));
    }
  });

  it('claiming boxes with no §63(f) rule-data figures is a hard error, not a silent zero', () => {
    const stripped = { ...fed, fed: { ...fed.fed!, additional_std_deduction: undefined } };
    const ctx: FilingContext = {
      taxpayer_id: TP,
      tax_year: 2025,
      filing_status: 'single',
      il_exemption_count: 1,
      addl_std_boxes: 1,
      rule_versions: { FED: fed.rule_version, IL: il.rule_version },
    };
    expect(() =>
      compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: stripped, il_rules: il }),
    ).toThrow(/additional_std_deduction/);
  });
});
