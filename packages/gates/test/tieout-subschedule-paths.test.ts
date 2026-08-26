/**
 * P54 — regression guard for the ACC-TIEOUT-FORM critic against the paths
 * added in P49–P53. The tie-out re-states the kernel's formulas by hand, so
 * every new component the kernel folds into a derived line MUST be added here
 * too — otherwise the critic false-fails at severity Error and blocks a
 * perfectly correct return. That is exactly what happened when the IL-1040
 * line-2 tax-exempt add-back and the line-28 PTE credit landed.
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

function tieFindings(extra: TaxFact[]) {
  const g = loadGolden('return3-mfj-multidoc');
  const sourced = [...factsOf(g), ...extra];
  const r = compute({
    taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules),
    facts: sourced, fed_rules: fedRules, il_rules: ilRules,
  });
  const base = buildCtx('return3-mfj-multidoc');
  const ctx = { ...base, jurisdiction: 'IL' as const, facts: [...sourced, ...r.computedFacts], calculations: r.calculations };
  return createStep1Critics().find((c) => c.id === 'ACC-TIEOUT-FORM')!.evaluate(ctx as never);
}

it('the IL tie-out holds with a tax-exempt-interest add-back (P49)', () => {
  const f = tieFindings([ex('te', C.TAX_EXEMPT_INTEREST, '2312', ['FED', 'IL'])]);
  expect(f.map((x) => x.message)).toEqual([]);
});

it('the IL tie-out holds with a pass-through entity tax credit (P53)', () => {
  const f = tieFindings([ex('pte', C.IL_PTE_CREDIT, '3200', ['IL'])]);
  expect(f.map((x) => x.message)).toEqual([]);
});

it('the IL tie-out holds with the whole P49–P53 set at once', () => {
  const f = tieFindings([
    ex('te', C.TAX_EXEMPT_INTEREST, '2312', ['FED', 'IL']),
    ex('ob', C.IL_EXEMPT_OBLIGATIONS, '800', ['IL']),
    ex('pte', C.IL_PTE_CREDIT, '3200', ['IL']),
    ex('cr', C.IL_OTHER_STATE_CREDIT, '400', ['IL']),
    ex('ut', C.IL_USE_TAX, '75', ['IL']),
  ]);
  expect(f.map((x) => x.message)).toEqual([]);
});
