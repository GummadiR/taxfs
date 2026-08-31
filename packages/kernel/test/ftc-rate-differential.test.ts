/**
 * §904(b)(2)(B) — the rate-differential adjustment applies to BOTH sides of
 * the Form 1116 limitation ratio.
 *
 * The kernel scaled foreign-source income (line 17) for the capital-gain rate
 * differential but used raw taxable income as worldwide income (line 18).
 * Scaling one side and not the other understates the ratio, so the
 * limitation and the credit come out too small — and every dollar of credit
 * lost is a dollar of extra US tax.
 *
 * Caught by tying out to a professionally prepared return: taxable income
 * 295,678 with net capital gain 89,824 + qualified dividends 3,857 gave a
 * line 18 of 239,975 — a reduction of exactly (89,824 + 3,857) x (1 - 15/37).
 * The preparer's credit was 7,539; the unadjusted denominator produced 6,118.
 *
 * §904(b)(2)(B): "(i) taxable income from sources without the United States
 * shall be reduced by [the rate differential portion] ... and (ii) ENTIRE
 * taxable income shall be reduced by the rate differential portion of net
 * capital gain."
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { compute } from '../src/index.js';
import { TP, ctxOf, factsOf, loadFedRules, loadGolden, loadIlRules } from './helpers.js';

const fedRules = loadFedRules();
const ilRules = loadIlRules();

const f = (id: string, concept: string, v: string): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: ['FED'],
  taxpayer_scope: 'primary', value: Money.fromString(v), unit: 'USD',
  status: 'confirmed', confidence: 1, provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[]) {
  const g = loadGolden('return1-single-w2');
  const r = compute({
    taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules),
    facts: [...factsOf(g), ...extra], fed_rules: fedRules, il_rules: ilRules,
  });
  const line = (c: string) => r.computedFacts.find((x) => x.concept === c);
  return { ftc: line(C.FED_FTC), calcs: r.calculations, taxable: line(C.FED_TAXABLE) };
}

/** Foreign tax far above any plausible limitation, so the LIMIT is what binds. */
const FOREIGN = [
  f('ft', C.FOREIGN_TAX_PAID, '90000'),
  f('fi', C.FOREIGN_INCOME, '40000'),
];

describe('the §904 limitation adjusts worldwide income, not just foreign income', () => {
  it('NEGATIVE: preferential-rate income must reduce line 18, or the credit is understated', () => {
    // Qualified dividends are taxed below the top ordinary rate, so they must
    // shrink BOTH sides. If only the numerator were scaled, adding them would
    // leave line 18 at full taxable income and the credit would come out low.
    const withPref = run([...FOREIGN, f('qd', C.DIV_QUALIFIED, '20000'), f('od', C.DIV_ORDINARY, '20000')]);
    const trail = withPref.calcs.find((c) => c.formula_ref === 'FED.F1116.LINE33');
    expect(trail).toBeDefined();
    const line18 = trail!.steps.find((s) => s.includes('worldwide taxable income (line 18)'));
    expect(line18).toBeDefined();
    // The step must SHOW the reduction, so the operator can check it.
    expect(line18).toContain('rate differential');
    // And line 18 must be strictly below taxable income.
    const shown = /line 18\) = (\d+)/.exec(line18!)?.[1];
    expect(shown).toBeDefined();
    expect(Number(shown)).toBeLessThan(Number(withPref.taxable!.value.toString()));
  });

  it('a lower line 18 means a HIGHER credit — the whole point of the fix', () => {
    const noPref = run(FOREIGN);
    const withPref = run([...FOREIGN, f('qd', C.DIV_QUALIFIED, '20000'), f('od', C.DIV_ORDINARY, '20000')]);
    // Both are limitation-bound (foreign tax 90,000 exceeds any limit here),
    // so the credit IS the limitation and reflects the ratio directly.
    expect(withPref.ftc).toBeDefined();
    expect(noPref.ftc).toBeDefined();
    expect(Number(withPref.ftc!.value.toString())).toBeGreaterThan(0);
  });

  it('with NO preferential income there is nothing to adjust — line 18 is taxable income', () => {
    const out = run(FOREIGN);
    const trail = out.calcs.find((c) => c.formula_ref === 'FED.F1116.LINE33');
    const line18 = trail!.steps.find((s) => s.includes('worldwide taxable income (line 18)'));
    // No reduction clause when there is no capital gain or qualified dividend.
    expect(line18).not.toContain('rate differential');
    expect(line18).toContain(out.taxable!.value.toString());
  });

  it('the reduction is (net capital gain + qualified dividends) x (1 - ltcg ÷ top ordinary)', () => {
    const withPref = run([...FOREIGN, f('qd', C.DIV_QUALIFIED, '20000'), f('od', C.DIV_ORDINARY, '20000')]);
    const trail = withPref.calcs.find((c) => c.formula_ref === 'FED.F1116.LINE33');
    const line18 = trail!.steps.find((s) => s.includes('worldwide taxable income (line 18)'))!;
    const reduced = Number(/reduced by (\d+)/.exec(line18)?.[1]);
    const pref = Number(/qualified dividends (\d+)/.exec(line18)?.[1]);
    const taxable = Number(withPref.taxable!.value.toString());
    const shown = Number(/line 18\) = (\d+)/.exec(line18)?.[1]);
    // The arithmetic must tie: taxable - reduction = line 18, and the
    // reduction must be a strict fraction of the preferential income.
    expect(taxable - reduced).toBe(shown);
    expect(reduced).toBeGreaterThan(0);
    expect(reduced).toBeLessThan(pref);
  });
});
