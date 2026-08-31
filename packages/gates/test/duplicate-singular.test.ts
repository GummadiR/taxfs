/**
 * A capital-loss carryover entered twice is subtracted twice.
 *
 * This is the defect that made a real return miss a professionally prepared
 * one by roughly $8,850 of balance due. The kernel sums every confirmed fact
 * for a concept — correct for wages, silently wrong for a Schedule D
 * carryover, which is one figure from one worksheet. The Add Data card reads
 * it with `.find()`, so it showed ONE entry while the kernel summed two, and
 * no screen or gate said anything.
 *
 * The §9.1 negative test is the first case: a doubled carryover must not get
 * through the gates.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, SINGULAR_CONCEPTS, type TaxFact } from '@taxfs/shared';
import { createDuplicateSingularCritics } from '../src/index.js';
import { buildCtx } from './helpers.js';
import { TP } from '../../kernel/test/helpers.js';

const critic = createDuplicateSingularCritics()
  .find((c) => c.id === 'ACC-SINGULAR-CONCEPT-DOUBLED')!;

const fact = (id: string, concept: string, v: string): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: ['FED'],
  taxpayer_scope: 'primary', value: Money.fromString(v), unit: 'USD',
  status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[]) {
  const base = buildCtx('return1-single-w2');
  const ctx = { ...base, gate: 0 as const, jurisdiction: 'FED' as const, facts: [...base.facts, ...extra] };
  if (!critic.applies_when(ctx as never)) return null;
  return critic.evaluate(ctx as never);
}

describe('a singular figure entered twice is caught before it can be filed', () => {
  it('NEGATIVE (§9.1): a carryover entered on BOTH screens cannot pass the gates', () => {
    // Exactly the real case: the worksheet saved it, then it was typed again.
    const out = run([
      fact('ws', C.CAPLOSS_CO_LT_PRIOR, '37824'),
      fact('typed', C.CAPLOSS_CO_LT_PRIOR, '37824'),
    ]);
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    // Error, not Flag — gates 0–4 block, and this one silently moves money.
    expect(out![0]!.severity).toBe('Error');
    // It must name the total actually in use, so the size is obvious.
    expect(out![0]!.message).toContain('75648');
    // And point at both facts, so neither has to be hunted for.
    expect(out![0]!.affected).toEqual(['ws', 'typed']);
    // The message must name the SOURCE of each entry: two entries of the
    // same amount are indistinguishable by value, and Documents shows them
    // as rows headed only "USER_ENTRY".
    expect(out![0]!.message).toContain('from s:ws');
    expect(out![0]!.message).toContain('from s:typed');
  });

  it('catches the short-term carryover the same way', () => {
    const out = run([
      fact('a', C.CAPLOSS_CO_ST_PRIOR, '4586'),
      fact('b', C.CAPLOSS_CO_ST_PRIOR, '4586'),
    ]);
    expect(out).toHaveLength(1);
    expect(out![0]!.message).toContain('9172');
  });

  it('reports BOTH terms when both were doubled — the real return had both', () => {
    const out = run([
      fact('s1', C.CAPLOSS_CO_ST_PRIOR, '4586'), fact('s2', C.CAPLOSS_CO_ST_PRIOR, '4586'),
      fact('l1', C.CAPLOSS_CO_LT_PRIOR, '37824'), fact('l2', C.CAPLOSS_CO_LT_PRIOR, '37824'),
    ]);
    expect(out).toHaveLength(2);
  });

  it('fires even when the two entries DIFFER — it is not a same-amount check', () => {
    // A typo on the second entry is still a double count, and looks less
    // like a duplicate, so it is likelier to survive a human read.
    const out = run([
      fact('a', C.CAPLOSS_CO_LT_PRIOR, '37824'),
      fact('b', C.CAPLOSS_CO_LT_PRIOR, '3782'),
    ]);
    expect(out).toHaveLength(1);
    expect(out![0]!.message).toContain('41606');
  });

  it('a household size entered twice is caught — two 4s are not a family of eight', () => {
    const out = run([
      fact('h1', C.PTC_HOUSEHOLD_SIZE, '4'),
      fact('h2', C.PTC_HOUSEHOLD_SIZE, '4'),
    ]);
    expect(out).toHaveLength(1);
    expect(out![0]!.message).toContain('8');
  });

  it('ONE carryover is silent — the ordinary case must not be nagged', () => {
    expect(run([fact('only', C.CAPLOSS_CO_LT_PRIOR, '37824')])).toBeNull();
  });

  it('a return with no carryover at all is silent', () => {
    expect(run([])).toBeNull();
  });

  it('an UNCONFIRMED second entry is silent — the kernel does not sum it either', () => {
    const pending = { ...fact('b', C.CAPLOSS_CO_LT_PRIOR, '37824'), status: 'unconfirmed' as const };
    expect(run([fact('a', C.CAPLOSS_CO_LT_PRIOR, '37824'), pending])).toBeNull();
  });

  it('concepts with genuinely many sources are NOT on the singular list', () => {
    // Wages, interest, dividends and HSA employer contributions legitimately
    // arrive several times. Listing one would block a correct return.
    for (const c of [C.WAGES, C.INTEREST, C.DIV_ORDINARY, C.CONTRIB_HSA_EMPLOYER]) {
      expect(SINGULAR_CONCEPTS).not.toContain(c);
    }
  });
});
