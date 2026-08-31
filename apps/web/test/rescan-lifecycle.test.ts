/**
 * WHEN a document can be re-scanned, and when the control must not be offered.
 *
 * Reported from real use: "I am not sure what rescan did, it is not showing me
 * the status, and if I do multiple rescans I don't know which one I am doing."
 * All nine of the operator's documents were CONFIRMED, so every Rescan click
 * was refused — and the refusal printed in a banner at the top of a long page,
 * ten rows above the button that was pressed.
 *
 * TaxOS offered its equivalent on almost no row: only where a document had
 * nothing attached, because unconfirmed proposals lived in an in-memory
 * session and died on restart. TaxFS persists facts, so that reason is gone.
 */
import { describe, expect, it } from 'vitest';
import { Money, type SourceDoc, type TaxFact } from '@taxfs/shared';
import { rescanState } from '../src/server/confirmations';

const doc = (id: string, rawRef: string): SourceDoc => ({
  source_id: id, taxpayer_id: 'ws1', type: 'W-2' as never, tax_year: 2025,
  fields: {}, ocr_confidence: 0.99, raw_ref: rawRef, review_status: 'pending',
}) as SourceDoc;

const fact = (id: string, sourceId: string, status: TaxFact['status']): TaxFact => ({
  fact_id: id, taxpayer_id: 'ws1', concept: 'income.wages', tax_year: 2025,
  jurisdiction: ['FED'], taxpayer_scope: 'primary', value: Money.fromString('100'),
  unit: 'USD', status, confidence: 0.99,
  provenance: [{ source_id: sourceId, source_field: 'box1_wages' }],
}) as TaxFact;

const STORED = 'localfs://ws1/2025/doc-abc.pdf';

describe('when a document can be re-scanned', () => {
  it('a stored file with NOTHING read is re-scannable, and says so', () => {
    const st = rescanState(doc('s1', STORED), []);
    expect(st.canRescan).toBe(true);
    expect(st.nothingRead).toBe(true);
    expect(st.why).toContain('no values were read');
  });

  it('a stored file with UNCONFIRMED values is re-scannable', () => {
    const st = rescanState(doc('s1', STORED), [fact('f1', 's1', 'unconfirmed')]);
    expect(st.canRescan).toBe(true);
    expect(st.nothingRead).toBe(false);
  });

  it('REFUSES once any value is confirmed — re-proposing is how a document counts twice', () => {
    const st = rescanState(doc('s1', STORED), [fact('f1', 's1', 'confirmed')]);
    expect(st.canRescan).toBe(false);
    expect(st.why).toContain('counting toward your return');
    expect(st.why).toContain('Remove');
    expect(st.shortWhy).toContain('confirmed');
  });

  it('a mix still refuses — one confirmed value is enough', () => {
    const st = rescanState(doc('s1', STORED), [
      fact('f1', 's1', 'confirmed'),
      fact('f2', 's1', 'unconfirmed'),
    ]);
    expect(st.canRescan).toBe(false);
  });

  it('a typed entry has no file to re-read, and is not offered one', () => {
    const st = rescanState(doc('m1', 'manual://income.interest'), []);
    expect(st.canRescan).toBe(false);
    expect(st.shortWhy).toBe('typed entry');
  });

  it('a demo document is not re-scannable either', () => {
    expect(rescanState(doc('d1', 'demo://w2'), []).canRescan).toBe(false);
  });

  it("another document's facts never affect this one's state", () => {
    // The bug this prevents: one confirmed document suppressing Rescan on all
    // the others, or vice versa.
    const st = rescanState(doc('s1', STORED), [fact('f1', 'OTHER', 'confirmed')]);
    expect(st.canRescan).toBe(true);
    expect(st.nothingRead).toBe(true);
  });

  it('derived facts are ignored — only what the document itself supplied counts', () => {
    const derived: TaxFact = { ...fact('f9', 's1', 'confirmed'), derivation: 'calc-1' };
    expect(rescanState(doc('s1', STORED), [derived]).canRescan).toBe(true);
  });
});
