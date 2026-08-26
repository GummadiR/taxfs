/**
 * P94 — the ACC-TIEOUT-FORM AGI tie must subtract EVERY adjustment the kernel
 * takes: the derived ½SE deduction and the new derived HSA deduction. Same
 * failure mode as P76's QBI omission — the critic restates the kernel's
 * formula by hand, so each new kernel deduction needs a tie-out mirror and a
 * test that runs the FED lens over a return actually carrying it.
 */
import { expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { createStep1Critics } from '../src/index.js';
import { buildCtx, fedRules, ilRules } from './helpers.js';
import { TP, ctxOf, factsOf, loadGolden } from '../../kernel/test/helpers.js';

const ex = (id: string, concept: string, v: string, jur: ('FED' | 'IL')[]): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(v), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function fedRun(golden: string, extra: TaxFact[]) {
  const g = loadGolden(golden);
  const sourced = [...factsOf(g), ...extra];
  const r = compute({
    taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules),
    facts: sourced, fed_rules: fedRules, il_rules: ilRules,
  });
  const base = buildCtx(golden);
  const ctx = { ...base, jurisdiction: 'FED' as const, facts: [...sourced, ...r.computedFacts], calculations: r.calculations };
  const findings = createStep1Critics().find((c) => c.id === 'ACC-TIEOUT-FORM')!.evaluate(ctx as never);
  return { findings, computed: r.computedFacts };
}

it('the FED tie-out holds when a direct HSA contribution creates the deduction', () => {
  const { findings, computed } = fedRun('return3-mfj-multidoc', [
    ex('hd', C.CONTRIB_HSA_DIRECT, '3000', ['FED']),
    ex('hc', C.HSA_FAMILY_COVERAGE, '1', ['FED']),
  ]);
  const ded = computed.find((f) => f.concept === C.FED_HSA_DEDUCTION);
  expect(ded?.value.toString()).toBe('3000'); // the deduction really is in play
  expect(findings.map((x) => x.message)).toEqual([]);
});

it('the FED tie-out holds on a self-employment return (½SE deduction mirrored)', () => {
  const { findings, computed } = fedRun('return4-schc-se', []);
  expect(computed.find((f) => f.concept === C.FED_SE_DEDUCTION)).toBeDefined();
  expect(findings.map((x) => x.message)).toEqual([]);
});

it('AGI really moved: kernel AGI = total income − adjustments − HSA deduction', () => {
  const { computed } = fedRun('return3-mfj-multidoc', [
    ex('hd', C.CONTRIB_HSA_DIRECT, '3000', ['FED']),
    ex('hc', C.HSA_FAMILY_COVERAGE, '1', ['FED']),
  ]);
  const v = (c: string) => computed.find((f) => f.concept === c)!.value;
  expect(v(C.FED_AGI).toString())
    .toBe(v(C.FED_TOTAL_INCOME).sub(Money.fromString('0')).sub(v(C.FED_HSA_DEDUCTION)).sub(v(C.FED_ADJUSTMENTS_TOTAL)).toString());
});
