/**
 * $27,777 must not go missing behind a $0.
 *
 * Found on a real return. Four K-1s were uploaded and CONFIRMED, and
 * Schedule E page 2 read $0. The arithmetic was right: a scanned K-1 carries
 * the entity's box 1 and nothing else, while opening basis (§704(d) /
 * §1366(d)) and material participation (§469) are the recipient's own facts.
 * Absent them the kernel assumes zero basis and a passive activity, zero
 * basis absorbs nothing, and the whole loss suspends.
 *
 * The Gates Board already said so once per K-1 (ACC-K1-COMPLETE). The
 * operator was reading Review, where the same fact appeared as a bare zero.
 * A figure that is arithmetically correct and still misleading is exactly
 * the kind this note exists for.
 */
import { describe, expect, it } from 'vitest';
import { Money, type TaxFact } from '@taxfs/shared';
import { lineNote } from '../src/server/labels';

const derivedFact = (concept: string, v: string): TaxFact => ({
  fact_id: `d:${concept}`, taxpayer_id: 'ws', concept, tax_year: 2025,
  jurisdiction: ['FED'], taxpayer_scope: 'primary', value: Money.fromString(v),
  unit: 'USD', status: 'confirmed', confidence: 1,
  derivation: `calc:${concept}`,
});

const K1_LINE = 'fed.sche.k1_total';

describe('the Schedule E page 2 line explains a suspended loss', () => {
  it('names the total kept out of the figure, not just the zero', () => {
    // The real shape: four entities, no basis entered for any of them.
    const note = lineNote(K1_LINE, [
      derivedFact('fed.sche.k1_total', '0'),
      derivedFact('k1.e1.basis_suspended.out', '16997'),
      derivedFact('k1.e2.basis_suspended.out', '5537'),
      derivedFact('k1.e3.basis_suspended.out', '2430'),
      derivedFact('k1.e4.basis_suspended.out', '2813'),
    ]);
    expect(note).not.toBeNull();
    expect(note).toContain('$27,777');
    // The fix has to be nameable: basis is entered on Add Data.
    expect(note).toContain('opening basis');
    expect(note).toContain('Add Data');
    // And it must not read as money destroyed.
    expect(note).toContain('carry forward');
  });

  it('separates the §469 passive limit from the basis limit — different fixes', () => {
    const note = lineNote(K1_LINE, [
      derivedFact('k1.e1.basis_suspended.out', '1000'),
      derivedFact('k1.e2.passive_suspended.out', '4000'),
    ]);
    expect(note).toContain('$5,000');
    expect(note).toContain('opening basis');
    expect(note).toContain('§469');
    expect(note).toContain('materially participate');
  });

  it('says nothing when no loss is suspended — the zero is then the whole truth', () => {
    expect(lineNote(K1_LINE, [
      derivedFact('fed.sche.k1_total', '0'),
      derivedFact('k1.e1.basis_suspended.out', '0'),
    ])).toBeNull();
  });

  it('says nothing when there are no K-1s at all', () => {
    expect(lineNote(K1_LINE, [derivedFact('fed.total_income', '191778')])).toBeNull();
  });

  it('never annotates a line it knows nothing about', () => {
    expect(lineNote('fed.agi', [derivedFact('k1.e1.basis_suspended.out', '16997')])).toBeNull();
  });
});
