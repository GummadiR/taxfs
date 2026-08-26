/**
 * P76 — the ACC-TIEOUT-FORM critic must subtract the §199A deduction from the
 * taxable-income tie-out, because the kernel does (1040 line 15 = AGI − line
 * 12 − line 13).
 *
 * How this shipped broken: the critic re-states the kernel's formula by hand,
 * and no test ever ran the FED lens of that tie-out over a return carrying a
 * QBI deduction — the P54 guards all evaluate the IL lens. So the omission sat
 * dormant until P71 taught extraction to read 1099-DIV box 5, at which point
 * an ordinary brokerage return grew a $29 §199A deduction and Gate 4 failed at
 * severity Error, blocking a return whose arithmetic was correct.
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

function fedRun(extra: TaxFact[]) {
  const g = loadGolden('return3-mfj-multidoc');
  const sourced = [...factsOf(g), ...extra];
  const r = compute({
    taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules),
    facts: sourced, fed_rules: fedRules, il_rules: ilRules,
  });
  const base = buildCtx('return3-mfj-multidoc');
  const ctx = { ...base, jurisdiction: 'FED' as const, facts: [...sourced, ...r.computedFacts], calculations: r.calculations };
  const findings = createStep1Critics().find((c) => c.id === 'ACC-TIEOUT-FORM')!.evaluate(ctx as never);
  return { findings, computed: r.computedFacts };
}

it('the FED tie-out holds when a REIT/PTP dividend creates a §199A deduction', () => {
  // 1099-DIV box 5 — the shape P71 started reading. 146 × 20% = 29.
  const { findings, computed } = fedRun([ex('reit', C.REIT_PTP_INCOME, '146', ['FED'])]);
  const qbi = computed.find((f) => f.concept === C.FED_QBI_DEDUCTION);
  expect(qbi?.value.toString()).toBe('29');   // the deduction really is in play
  expect(findings.map((x) => x.message)).toEqual([]);
});

it('the FED taxable line is AGI − deduction − QBI, not AGI − deduction', () => {
  const { computed } = fedRun([ex('reit', C.REIT_PTP_INCOME, '146', ['FED'])]);
  const v = (c: string) => computed.find((f) => f.concept === c)!.value;
  expect(v(C.FED_TAXABLE).toString())
    .toBe(Money.max(Money.zero(), v(C.FED_AGI).sub(v(C.FED_DEDUCTION)).sub(v(C.FED_QBI_DEDUCTION))).toString());
});

it('the FED tie-out still holds with no QBI at all (the term is optional)', () => {
  const { findings, computed } = fedRun([]);
  expect(computed.find((f) => f.concept === C.FED_QBI_DEDUCTION)).toBeUndefined();
  expect(findings.map((x) => x.message)).toEqual([]);
});

it('a tie-out failure message names every feeding number and the difference', () => {
  // Reproduce the P76 shape with the fix reverted in spirit: tamper the
  // taxable line by $29 and read what the operator would be shown.
  const g = loadGolden('return3-mfj-multidoc');
  // QBI in play (the P76 shape): the message must name the QBI feed too.
  const sourced = [...factsOf(g), ex('reit', C.REIT_PTP_INCOME, '146', ['FED'])];
  const r = compute({
    taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules),
    facts: sourced, fed_rules: fedRules, il_rules: ilRules,
  });
  const tampered = r.computedFacts.map((f) =>
    f.concept === C.FED_TAXABLE ? { ...f, value: f.value.add(Money.fromString('29')) } : f);
  const base = buildCtx('return3-mfj-multidoc');
  const ctx = { ...base, jurisdiction: 'FED' as const, facts: [...sourced, ...tampered], calculations: r.calculations };
  const findings = createStep1Critics().find((c) => c.id === 'ACC-TIEOUT-FORM')!.evaluate(ctx as never);
  const msg = findings.find((f) => f.message.includes('fed.taxable_income'))?.message ?? '';
  // Every feeding number is named — now straight from the kernel's own
  // recorded terms, so the list cannot drift from the formula (§3.2).
  expect(msg).toContain('+ fed.agi =');
  expect(msg).toContain('\u2212 fed.deduction.applied =');
  expect(msg).toContain('\u2212 fed.qbi.deduction =');
  expect(msg).toContain('a difference of 29');           // the gap itself is stated
  expect(msg).toContain('You did not cause this');       // and blame is placed correctly
});
