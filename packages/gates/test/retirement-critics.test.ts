/**
 * P98 — the retirement/HSA critic layer: every kernel-detected excess surfaces
 * as a Gates-Board finding with its cure; assumptions and filing duties
 * (coverage type, Form 8606) are said where the operator looks; identical
 * duplicate HSA employer entries are challenged.
 */
import { expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { createP98RetirementCritics } from '../src/index.js';
import { buildCtx, fedRules, ilRules } from './helpers.js';
import { TP, ctxOf, factsOf, loadGolden } from '../../kernel/test/helpers.js';

const ex = (id: string, concept: string, v: string): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: ['FED'], taxpayer_scope: 'primary',
  value: Money.fromString(v), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function findingsFor(extra: TaxFact[], criticId: string) {
  const g = loadGolden('return1-single-w2');
  const sourced = [...factsOf(g), ...extra];
  const r = compute({
    taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules),
    facts: sourced, fed_rules: fedRules, il_rules: ilRules,
  });
  const base = buildCtx('return1-single-w2');
  const ctx = { ...base, jurisdiction: 'FED' as const, facts: [...sourced, ...r.computedFacts] };
  return createP98RetirementCritics().find((c) => c.id === criticId)!.evaluate(ctx as never);
}

it('an IRA excess becomes an Error finding that names the amount and the cure', () => {
  const out = findingsFor([ex('t', C.CONTRIB_IRA_TRAD_TP, '9000')], 'ACC-CONTRIB-EXCESS');
  expect(out).toHaveLength(1);
  expect(out[0]!.severity).toBe('Error');
  expect(out[0]!.message).toContain('2000');
  expect(out[0]!.message).toContain('withdraw the excess');
});

it('an excess deferral finding tells the operator about the April 15 deadline', () => {
  const out = findingsFor([ex('d', C.CONTRIB_DEFERRAL_TP, '25000')], 'ACC-CONTRIB-EXCESS');
  expect(out).toHaveLength(1);
  expect(out[0]!.message).toContain('April 15');
});

it('HSA without a coverage type → a Flag naming the assumption; with it → silence', () => {
  const noCover = findingsFor([ex('h', C.CONTRIB_HSA_DIRECT, '2000')], 'ACC-HSA-COVERAGE');
  expect(noCover).toHaveLength(1);
  expect(noCover[0]!.severity).toBe('Flag');
  expect(noCover[0]!.message).toContain('SELF-ONLY');
  const withCover = findingsFor([ex('h', C.CONTRIB_HSA_DIRECT, '2000'), ex('c', C.HSA_FAMILY_COVERAGE, '1')], 'ACC-HSA-COVERAGE');
  expect(withCover).toEqual([]);
});

it('nondeductible IRA basis → a Form 8606 duty finding', () => {
  // covered + MAGI above the single range end → all 7,000 is basis
  const out = findingsFor([
    ex('t', C.CONTRIB_IRA_TRAD_TP, '7000'),
    ex('cv', C.W2_RETIREMENT_PLAN_TP, '1'),
    ex('wag', C.WAGES, '95000'),
  ], 'ACC-IRA-8606');
  expect(out).toHaveLength(1);
  expect(out[0]!.message).toContain('Form 8606');
  expect(out[0]!.message).toContain('taxed twice');
});

it('two identical HSA employer amounts → a possible double count', () => {
  const out = findingsFor([
    ex('h1', C.CONTRIB_HSA_EMPLOYER, '3000'),
    ex('h2', C.CONTRIB_HSA_EMPLOYER, '3000'),
  ], 'ACC-HSA-DUP-SOURCE');
  expect(out).toHaveLength(1);
  expect(out[0]!.message).toContain('counted twice');
});

it('a clean return raises nothing from any P98 critic', () => {
  for (const id of ['ACC-CONTRIB-EXCESS', 'ACC-HSA-COVERAGE', 'ACC-IRA-8606', 'ACC-HSA-DUP-SOURCE']) {
    expect(findingsFor([], id)).toEqual([]);
  }
});
