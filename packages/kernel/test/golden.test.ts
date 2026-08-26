import { describe, expect, it } from 'vitest';
import { C } from '@taxfs/shared';
import { compute, type KernelInput } from '@taxfs/kernel';
import { GOLDEN_NAMES, TP, ctxOf, factsOf, loadFedRules, loadGolden, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();

function inputOf(name: string): { input: KernelInput; expected: Record<string, string> } {
  const golden = loadGolden(name);
  return {
    input: {
      taxpayer_id: TP,
      tax_year: 2025,
      ctx: ctxOf(golden, fed, il),
      facts: factsOf(golden),
      fed_rules: fed,
      il_rules: il,
    },
    expected: golden.expected,
  };
}

describe.each(GOLDEN_NAMES)('golden return: %s', (name) => {
  const { input, expected } = inputOf(name);
  const result = compute(input);
  const byConcept = new Map(result.computedFacts.map((f) => [f.concept, f]));

  it('matches every expected line (from PLACEHOLDER fixture rule-data)', () => {
    const actual: Record<string, string> = {};
    for (const concept of Object.keys(expected)) {
      actual[concept] = byConcept.get(concept)?.value.toString() ?? '<missing>';
    }
    expect(actual).toEqual(expected);
  });

  it('emits whole-dollar lines only (kernel owns rounding)', () => {
    for (const f of result.computedFacts) {
      expect(f.value.isWholeDollars(), `${f.concept} = ${f.value.toString()}`).toBe(true);
    }
  });

  it('component-sum consistency: rounded totals = sum of rounded lines', () => {
    const ord = byConcept.get(C.FED_TAX_ORDINARY);
    const cg = byConcept.get(C.FED_TAX_CAPGAIN);
    const total = byConcept.get(C.FED_TAX);
    expect(total?.value.eq(ord!.value.add(cg!.value))).toBe(true);
  });

  it('every derived fact has a Calculation record with lineage fields', () => {
    const calcsByOutput = new Map(result.calculations.map((c) => [c.output_fact_id, c]));
    for (const f of result.computedFacts) {
      const calc = calcsByOutput.get(f.fact_id);
      expect(calc, `missing Calculation for ${f.concept}`).toBeDefined();
      expect(f.derivation).toBe(calc?.calc_id);
      expect(calc?.rule_version).toMatch(/PLACEHOLDER/);
      expect(calc?.formula_ref.length).toBeGreaterThan(0);
      expect(calc?.steps.length).toBeGreaterThan(0);
      expect(calc?.value.eq(f.value)).toBe(true);
    }
  });

  it('is deterministic: same input ⇒ identical output', () => {
    const again = compute(input);
    expect(JSON.stringify(again)).toBe(JSON.stringify(result));
  });
});
