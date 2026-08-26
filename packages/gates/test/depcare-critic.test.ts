/** P56 — the §21(d) assumption must surface as a visible finding, not a trail string. */
import { expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { createStep1Critics } from '../src/index.js';
import { buildCtx, fedRules, ilRules } from './helpers.js';
import { TP, ctxOf, factsOf, loadGolden } from '../../kernel/test/helpers.js';

const ex = (id: string, concept: string, v: string): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: ['FED'], taxpayer_scope: 'primary',
  value: Money.fromString(v), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function findings(extra: TaxFact[]) {
  const g = loadGolden('return3-mfj-multidoc');
  const sourced = [...factsOf(g), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules), facts: sourced, fed_rules: fedRules, il_rules: ilRules });
  const base = buildCtx('return3-mfj-multidoc');
  const ctx = { ...base, facts: [...sourced, ...r.computedFacts] };
  return createStep1Critics().find((c) => c.id === 'ACC-DEPCARE-EARNED-INCOME')!.evaluate(ctx as never);
}

const dc = [ex('dc', C.DEPCARE_EXPENSES, '3000'), ex('n', C.DEPCARE_PERSONS, '1')];

it('flags a dependent-care credit whose §21(d) limit was never established', () => {
  const f = findings(dc);
  expect(f).toHaveLength(1);
  expect(f[0]!.severity).toBe('Flag');
  expect(f[0]!.message).toContain('LOWER of the two spouses');
});

it('stays silent once the filer attests the limit does not bind', () => {
  expect(findings([...dc, ex('ok', C.DEPCARE_EARNED_INCOME_NOT_LIMITING, '1')])).toEqual([]);
});

it('stays silent when the actual limit is supplied', () => {
  expect(findings([...dc, ex('ei', C.DEPCARE_EARNED_INCOME_LIMIT, '1500')])).toEqual([]);
});

it('does not fire on a return with no dependent-care credit at all', () => {
  expect(findings([])).toEqual([]);
});
