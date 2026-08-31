/**
 * Every source row must say what it is.
 *
 * Uploaded documents always had a name. Everything the operator TYPED did
 * not: Documents rendered rows headed "USER_ENTRY" followed by
 * `manual-c9aaa07f-cc1e-4410-a2fb-d996f8b01580`, and the operator was left
 * to work out what was inside. That is not cosmetic. The way to fix a figure
 * counted twice is to find the row holding the duplicate and Remove it — and
 * a doubled capital-loss carryover shows up as two rows that look identical.
 */
import { describe, expect, it } from 'vitest';
import type { SourceDoc } from '@taxfs/shared';
import { sourceTitle, type SourceValue } from '../src/server/confirmations';

const src = (source_id: string, raw_ref = `manual://${source_id}`): SourceDoc => ({
  source_id, taxpayer_id: 'ws', type: 'USER_ENTRY', tax_year: 2025,
  fields: {}, ocr_confidence: 1, raw_ref, review_status: 'confirmed',
});

const val = (label: string): SourceValue => ({
  fact_id: `f:${label}`, label, concept: `c.${label}`, value: '1',
  confirmed: true, stale: false, field: null,
});

describe('a typed entry says what it holds', () => {
  it('NEGATIVE: a manual entry is never shown as a bare uuid', () => {
    const title = sourceTitle(src('manual-c9aaa07f-cc1e-4410-a2fb-d996f8b01580'), [
      val('Prior-year long-term capital loss carryover'),
    ]);
    expect(title).not.toBeNull();
    expect(title).not.toContain('c9aaa07f');
    // It names the kind AND the figure, so two rows can be told apart.
    expect(title).toBe('Typed entry — Prior-year long-term capital loss carryover');
  });

  it('names the carryover worksheet by what it is', () => {
    expect(sourceTitle(src('worksheet-caploss-61ca9ece-a6fb-4fa0-940f-a733b6dacc9b'), []))
      .toBe('Capital-loss carryover worksheet');
  });

  it('names an exchange-rate lookup', () => {
    expect(sourceTitle(src('fxlookup-c0e4a0f8-a2cc-4f63-ad75-3f0ed491af7b'), []))
      .toBe('Exchange-rate lookup');
  });

  it('turns an attestation id into words', () => {
    expect(sourceTitle(src('wizard-attestation.il_residency'), []))
      .toBe('Attestation — il residency');
  });

  it('lists two figures, then counts the rest — the row stays scannable', () => {
    const title = sourceTitle(src('manual-x'), [val('Wages'), val('Interest income'), val('Dividends'), val('Foreign tax paid')]);
    expect(title).toBe('Typed entry — Wages, Interest income +2 more');
  });

  it('does not repeat a label that appears twice on the same source', () => {
    expect(sourceTitle(src('manual-x'), [val('Wages'), val('Wages')])).toBe('Typed entry — Wages');
  });

  it('an entry holding nothing still names its kind', () => {
    expect(sourceTitle(src('manual-x'), [])).toBe('Typed entry');
  });

  it('returns null for an uploaded document — its filename already names it', () => {
    expect(sourceTitle(src('doc-abc', 'localfs://ws_1/w2.pdf'), [val('Wages')])).toBeNull();
  });
});
