/**
 * §36B — the tax family size is not a figure that may be assumed.
 *
 * Both kernels used to fall back to a household of ONE whenever
 * `ptc.household_size` was absent. Add Data prompts for it once a 1095-A
 * premium is detected, but that is a prompt and not a gate — nothing requires
 * an answer, and the prompt itself only appears after extraction has produced
 * a premium. The federal poverty line is computed FROM that size, and the
 * credit is measured as a percentage of FPL, so a family of four scored as a
 * household of one lands far higher up the scale.
 * Near the 400% cliff in §36B(c)(1)(A) that flips a full credit into full
 * repayment of the advance — thousands of dollars, silently, from a default
 * nobody typed.
 *
 * Both kernels defaulted the same way, so they AGREED and the divergence
 * check could not see it. That is why this test exercises both directly.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { compute } from '../src/index.js';
import { computeHeadlines } from '@taxfs/kernel2';
import { TP, ctxOf, factsOf, loadFedRules, loadGolden, loadIlRules } from './helpers.js';

const fedRules = loadFedRules();
const ilRules = loadIlRules();

const f = (id: string, concept: string, v: string): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: ['FED'],
  taxpayer_scope: 'primary', value: Money.fromString(v), unit: 'USD',
  status: 'confirmed', confidence: 1, provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

/** A 1095-A on the return: premiums, SLCSP and advance credit. */
const MARKETPLACE = [
  f('pp', C.PTC_PREMIUM, '12000'),
  f('sl', C.PTC_SLCSP, '14000'),
  f('ap', C.PTC_APTC, '9000'),
];

function inputFor(extra: TaxFact[]) {
  const g = loadGolden('return1-single-w2');
  return {
    taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules),
    facts: [...factsOf(g), ...extra], fed_rules: fedRules, il_rules: ilRules,
  };
}

/** The same facts in kernel2's flat shape. */
function input2For(extra: TaxFact[]) {
  const g = loadGolden('return1-single-w2');
  const ctx = ctxOf(g, fedRules, ilRules);
  return {
    facts: [
      ...g.facts.map((x) => ({ concept: x.concept, value: x.value, taxpayer_scope: x.scope })),
      ...extra.map((x) => ({ concept: x.concept, value: x.value.toString(), taxpayer_scope: x.taxpayer_scope })),
    ],
    filing_status: ctx.filing_status,
    il_exemption_count: ctx.il_exemption_count,
    addl_std_boxes: ctx.addl_std_boxes ?? 0,
    fed_rules: fedRules,
    il_rules: ilRules,
  };
}

describe('a 1095-A without a tax family size is refused, not guessed', () => {
  it('NEGATIVE: kernel REFUSES to compute a premium credit without the family size', () => {
    expect(() => compute(inputFor(MARKETPLACE))).toThrow(/household_size/);
  });

  it('NEGATIVE: kernel2 refuses it too — they used to agree on the wrong default', () => {
    expect(() => computeHeadlines(input2For(MARKETPLACE))).toThrow(/household_size/);
  });

  it('with the size supplied, both compute', () => {
    const extra = [...MARKETPLACE, f('hs', C.PTC_HOUSEHOLD_SIZE, '4')];
    expect(() => compute(inputFor(extra))).not.toThrow();
    expect(() => computeHeadlines(input2For(extra))).not.toThrow();
  });

  it('the size CHANGES the answer — proving the old default of 1 was a real error', () => {
    const at = (size: string) => {
      const r = compute(inputFor([...MARKETPLACE, f('hs', C.PTC_HOUSEHOLD_SIZE, size)]));
      const net = r.computedFacts.find((x) => x.concept === C.FED_PTC_NET);
      const rep = r.computedFacts.find((x) => x.concept === C.FED_PTC_REPAYMENT);
      return `${net?.value.toString() ?? '-'}|${rep?.value.toString() ?? '-'}`;
    };
    // A household of one and a household of four are measured against
    // different poverty lines, so they cannot produce the same credit.
    expect(at('1')).not.toBe(at('4'));
  });

  it('a return with no 1095-A at all is unaffected — the family size is not demanded', () => {
    expect(() => compute(inputFor([]))).not.toThrow();
  });
});
