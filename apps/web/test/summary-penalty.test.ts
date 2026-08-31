/**
 * "You owe $X with the return" is a statement to the IRS's arithmetic, and it
 * is only true if X is everything. A Form 2210 underpayment penalty is a pure
 * input in TaxFS — both kernels subtract one when it is entered, and nothing
 * ever asked for it — so a return with a real underpayment printed a
 * confident total that was short by the penalty, with no hint anything was
 * missing. These pin the sentence that closes that gap, and the silences
 * around it so it does not become noise on every return.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { buildSummary } from '../src/server/labels';

/** The floor as published in rules/fixtures/2025.ESTTAX.json. */
const FLOOR = '1000';

const derivedFact = (concept: string, v: string): TaxFact => ({
  fact_id: `d:${concept}`, taxpayer_id: 'tp', concept, tax_year: 2025,
  jurisdiction: ['FED'], taxpayer_scope: 'primary', value: Money.fromString(v),
  unit: 'USD', status: 'confirmed', confidence: 1, derivation: `calc:${concept}`,
});

const sourcedPenalty = (v: string): TaxFact => ({
  fact_id: 'f:2210', taxpayer_id: 'tp', concept: C.FED_EST_TAX_PENALTY, tax_year: 2025,
  jurisdiction: ['FED'], taxpayer_scope: 'primary', value: Money.fromString(v),
  unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: 's:2210', source_field: 'v' }],
});

/** `refundOrDue` is negative when money is owed, matching the kernel. */
function fed(refundOrDue: string, opts: { extra?: TaxFact[]; floor?: string | null } = {}) {
  const extra = opts.extra ?? [];
  // `floor: null` means "the caller had no rule data", distinct from omitting
  // the option, which uses the published floor.
  const floor = opts.floor === null ? undefined : (opts.floor ?? FLOOR);
  const facts = [
    derivedFact('fed.total_income', '200000'),
    derivedFact('fed.payments.total', '10000'),
    derivedFact('fed.refund_or_due', refundOrDue),
    ...extra,
  ];
  return buildSummary(facts, 'single', floor)!.fed.join(' ');
}

describe('the plain-English total tells the whole truth about a §6654 penalty', () => {
  it('NEGATIVE: owing past the floor with no penalty entered cannot read as a settled total', () => {
    // The forbidden outcome is the old behaviour: "you owe $4,700" full stop,
    // which an operator reasonably reads as "and nothing else".
    const out = fed('-4700');
    expect(out).toContain('you owe $4,700 with the return');
    expect(out).toContain('does NOT include a Form 2210 underpayment penalty');
    // It must not imply TaxFS did the sum and got nothing.
    expect(out).toContain('is not claiming it is zero');
    expect(out).toContain('safe harbour');
  });

  it('an entered penalty is reported as already counted, not asked for twice', () => {
    const out = fed('-4970', { extra: [sourcedPenalty('270')] });
    expect(out).toContain('includes the $270 Form 2210 underpayment penalty you entered');
    expect(out).not.toContain('does NOT include');
  });

  it('below the §6654(e)(1) floor there is nothing to warn about', () => {
    expect(fed('-700')).not.toContain('Form 2210');
  });

  it('at the floor exactly, the warning is written — the statute excuses UNDER $1,000', () => {
    expect(fed('-1000')).toContain('Form 2210');
  });

  it('a refund gets no penalty sentence', () => {
    expect(fed('3000')).not.toContain('Form 2210');
  });

  it('without the floor from rule data the sentence is not written — no invented threshold', () => {
    expect(fed('-4700', { floor: null })).not.toContain('Form 2210');
  });
});
