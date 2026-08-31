/**
 * fillIdentity must never hand back an unfilled PDF while the caller reports
 * success.
 *
 * It used to `return pdfBytes` for any form id that was not '1040' or
 * 'IL1040'. The File It panel then said "downloaded with identity filled in
 * this browser" over a PDF with an empty Step 1 — the P92 swallowed-failure
 * shape for the third time, in the function whose own header warns about it.
 *
 * Today the panel only ever passes '1040' or 'IL1040', so nothing triggers
 * it; that is exactly why it needed a test rather than a comment. A third
 * mapped form, or a caller passing a Forms-screen draft id, would have
 * printed a nameless return.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { fillIdentity, hasIdentityLayout } from '../src/identity.js';

const IDENTITY = {
  taxpayer: { first_name: 'Pat', last_name: 'Roe', ssn: '123-45-6789', dob: '1970-01-01' },
  address_line: '1 Main St', city: 'Springfield', state: 'IL', zip: '62701',
};

async function blankPdf(): Promise<Uint8Array> {
  const d = await PDFDocument.create();
  d.addPage();
  return d.save();
}

describe('a caller can tell whether a form has an identity block at all', () => {
  it('NEGATIVE: a Forms-screen draft id has no layout, so no caller may claim it was filled', () => {
    expect(hasIdentityLayout('draft-1040')).toBe(false);
    expect(hasIdentityLayout('SCHB')).toBe(false);
    expect(hasIdentityLayout('schedule-d')).toBe(false);
  });

  it('the two forms that DO carry Step 1 are recognised', () => {
    expect(hasIdentityLayout('1040')).toBe(true);
    expect(hasIdentityLayout('IL1040')).toBe(true);
  });

  it('fillIdentity still passes a non-identity form through untouched — that is correct', async () => {
    const bytes = await blankPdf();
    const out = await fillIdentity(bytes, 'SCHB', IDENTITY);
    expect(out).toBe(bytes);
  });
});
