/**
 * A 1098 that escrows and a county bill are usually the same money.
 *
 * Found on a real return: the operator uploaded a JPMorgan Form 1098 whose
 * lender block read "REAL ESTATE TAXES PAID $11,682.34". Extraction had no
 * field for it, so the figure was dropped and the Illinois Schedule ICR
 * credit — 5% of principal-residence property tax — never appeared. Giving
 * the 1098 that field opens the opposite hole: the county bill maps to the
 * same concept, and `sumOfConcept` ADDS every confirmed fact, so uploading
 * both would claim the tax twice and inflate the ICR credit computed on it.
 *
 * The §9.1 negative test is the first case. The rest guard the false alarm
 * this critic must NOT raise: two installment receipts from the same county
 * are ordinary and legitimate, which is why the trigger is a mix of document
 * KINDS and never a count.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type SourceDoc, type TaxFact } from '@taxfs/shared';
import { createPropertyTaxSourceCritics } from '../src/index.js';
import { buildCtx } from './helpers.js';
import { TP } from '../../kernel/test/helpers.js';

const critic = createPropertyTaxSourceCritics()
  .find((c) => c.id === 'ACC-PROPERTY-TAX-TWO-SOURCES')!;

const fact = (id: string, v: string, status: TaxFact['status'] = 'confirmed'): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept: C.IL_PROPERTY_TAX, tax_year: 2025,
  jurisdiction: ['IL'], taxpayer_scope: 'primary', value: Money.fromString(v), unit: 'USD',
  status, confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

const source = (id: string, type: SourceDoc['type']): SourceDoc => ({
  source_id: `s:${id}`, taxpayer_id: TP, type, tax_year: 2025,
  fields: {}, ocr_confidence: 1, raw_ref: `stored://${id}`, review_status: 'confirmed',
});

function run(facts: TaxFact[], sources: SourceDoc[]) {
  const base = buildCtx('return1-single-w2', { extraFacts: facts, extraSources: sources });
  const ctx = { ...base, gate: 0 as const, jurisdiction: 'FED' as const };
  if (!critic.applies_when(ctx as never)) return null;
  return critic.evaluate(ctx as never);
}

describe('property tax claimed from two kinds of document', () => {
  it('NEGATIVE (§9.1): an escrowed 1098 beside the county bill cannot pass unremarked', () => {
    const out = run(
      [fact('escrow', '11682.34'), fact('bill', '11682.34')],
      [source('escrow', '1098'), source('bill', 'PROPERTY-TAX-BILL')],
    );
    expect(out).not.toBeNull();
    expect(out).toHaveLength(1);
    // The doubled total must be stated: the size is the whole point.
    expect(out![0]!.message).toContain('23364.68');
    // And each row named by the KIND of document it came from, since the two
    // amounts are identical and indistinguishable by value alone.
    expect(out![0]!.message).toContain('1098 s:escrow');
    expect(out![0]!.message).toContain('PROPERTY-TAX-BILL s:bill');
    expect(out![0]!.affected).toEqual(['escrow', 'bill']);
  });

  it('is a Flag, not an Error: two documents CAN hold different money', () => {
    // A part-year escrow, or a second property. Blocking would be wrong.
    const out = run(
      [fact('escrow', '4000'), fact('bill', '7682.34')],
      [source('escrow', '1098'), source('bill', 'PROPERTY-TAX-BILL')],
    );
    expect(out![0]!.severity).toBe('Flag');
  });

  it('stays silent for two installment receipts from the same county', () => {
    // DuPage bills in two installments; two receipts are the normal case and
    // genuinely sum. One document KIND, so no finding.
    expect(run(
      [fact('inst1', '5841.17'), fact('inst2', '5841.17')],
      [source('inst1', 'PROPERTY-TAX-BILL'), source('inst2', 'PROPERTY-TAX-BILL')],
    )).toBeNull();
  });

  it('stays silent for a 1098 on its own', () => {
    expect(run([fact('escrow', '11682.34')], [source('escrow', '1098')])).toBeNull();
  });

  it('stays silent while a row is still unconfirmed — the kernel is not summing it yet', () => {
    expect(run(
      [fact('escrow', '11682.34'), fact('bill', '11682.34', 'unconfirmed')],
      [source('escrow', '1098'), source('bill', 'PROPERTY-TAX-BILL')],
    )).toBeNull();
  });
});
