/**
 * §6654 — the return must not go out silently claiming a $0 Form 2210 penalty.
 *
 * The guardrail this file defends (§9.1 negative test, the first case below):
 * a return whose tax after credits exceeds withholding by the §6654(e)(1)
 * de-minimis floor MAY owe an underpayment penalty, and TaxFS may not ship it
 * without saying so. `penalty.fed.estimated_tax` is a pure input that nothing
 * ever asked for, so "no penalty" and "nobody looked" were indistinguishable
 * on the Review screen. The critic must REFUSE to stay silent there.
 *
 * The other cases pin the silences that are correct, so the critic cannot be
 * turned into noise on every return: a penalty the operator already entered,
 * a balance below the floor, and a caller that has no §6654 rule data (in
 * which case the honest answer is nothing, not a guess).
 */
import { expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { createEstTaxPenaltyCritics } from '../src/index.js';
import { buildCtx } from './helpers.js';
import { TP } from '../../kernel/test/helpers.js';

/** The floor as it is published in rules/2025.ESTTAX.json. */
const RULES = { de_minimis_balance_due: '1000' };

const critic = createEstTaxPenaltyCritics().find((c) => c.id === 'ACC-EST-PENALTY-UNDETERMINED')!;

/**
 * Golden return1 computes fed.tax_after_credits = 5700. Lowering the single
 * withholding fact is how we set the balance due: 5700 - withholding.
 */
function run(withholding: string, opts: { rules?: { de_minimis_balance_due: string }; extraFacts?: TaxFact[] } = {}) {
  const base = buildCtx('return1-single-w2', { factOverrides: { 'f:w2-1:fedwh': withholding } });
  const ctx = {
    ...base,
    gate: 5 as const,
    jurisdiction: 'FED' as const,
    facts: [...base.facts, ...(opts.extraFacts ?? [])],
    ...('rules' in opts ? (opts.rules ? { esttax_rules: opts.rules } : {}) : { esttax_rules: RULES }),
  };
  if (!critic.applies_when(ctx as never)) return null;
  return critic.evaluate(ctx as never);
}

const penaltyFact = (v: string): TaxFact => ({
  fact_id: 'f:2210', taxpayer_id: TP, concept: C.FED_EST_TAX_PENALTY, tax_year: 2025,
  jurisdiction: ['FED'], taxpayer_scope: 'primary', value: Money.fromString(v), unit: 'USD',
  status: 'confirmed', confidence: 1, provenance: [{ source_id: 's:2210', source_field: 'v' }],
});

it('NEGATIVE (§9.1): a return that may owe a §6654 penalty cannot go out silent', () => {
  // Tax 5700, withholding 1000 → 4700 due, far past the floor. The forbidden
  // outcome is an empty findings list: that is a return telling the operator
  // it owes nothing more when the IRS may disagree.
  const out = run('1000');
  expect(out).not.toBeNull();
  expect(out).toHaveLength(1);
  expect(out![0]!.severity).toBe('Flag');
  expect(out![0]!.critic_id).toBe('ACC-EST-PENALTY-UNDETERMINED');
  // It must name the number it saw, not gesture at "a possible penalty".
  expect(out![0]!.message).toContain('4700');
  // And it must say why it stops there rather than printing an amount, so
  // nobody reads the silence as "TaxFS computed zero".
  expect(out![0]!.message).toContain('6621');
  expect(out![0]!.message).toContain('assume it is zero');
});

it('fires exactly AT the floor — §6654(e)(1) excuses under $1,000, not $1,000', () => {
  expect(run('4700')).toHaveLength(1); // 5700 - 4700 = 1000
});

it('stays silent below the floor: no penalty is possible, so there is nothing to say', () => {
  expect(run('5000')).toEqual([]); // 700 due
});

it('stays silent when withholding covers the tax', () => {
  expect(run('6000')).toEqual([]); // the unmodified golden: nothing due
});

it('stays silent once the operator has entered the penalty — it is answered', () => {
  expect(run('1000', { extraFacts: [penaltyFact('270')] })).toEqual([]);
});

it('an entered penalty of zero also answers it — that is the operator saying so, not a gap', () => {
  expect(run('1000', { extraFacts: [penaltyFact('0')] })).toEqual([]);
});

it('does not apply at all without §6654 rule data — it never guesses a floor', () => {
  expect(run('1000', { rules: undefined })).toBeNull();
});
