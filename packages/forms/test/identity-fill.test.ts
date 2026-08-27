/**
 * Subject: identity fill readback (the P92/P81 classes, §5 client-side path).
 * Fills the OFFICIAL templates with REALISTIC operator input — the SSN typed
 * with dashes, exactly as a person types it — saves, reloads from bytes, and
 * reads every value back from its exact named AcroForm field. All synthetic
 * identities; no real person's data (CLAUDE.md standing rule).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import {
  ageBlindFieldName,
  fillIdentity,
  identityFieldName,
  ilIdentityFieldName,
  ssnDigits,
  usDate,
  type FilingIdentity,
} from '../src/identity';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const f1040 = new Uint8Array(readFileSync(root('templates/pdf/2025/FED/f1040.pdf')));
const il1040 = new Uint8Array(readFileSync(root('templates/pdf/2025/IL/il1040.pdf')));

const IDENTITY: FilingIdentity = {
  taxpayer: {
    first_name: 'Testfirst',
    last_name: 'Testcase',
    ssn: '123-45-6789', // dashed — the P92 shape that once printed EMPTY
    dob: '1959-03-07',
    born_before_1961: true,
  },
  spouse: { first_name: 'Spousefirst', last_name: 'Testcase', ssn: '987-65-4321', dob: '1961-11-30' },
  address_line: '1 Synthetic Way',
  city: 'Springfield',
  state: 'IL',
  zip: '62701',
};

describe('identity fill — byte-level readback on the official templates', () => {
  it('1040: a DASHED SSN lands in the comb field as digits, never empty (P92)', async () => {
    const filled = await fillIdentity(f1040, '1040', IDENTITY);
    const doc = await PDFDocument.load(filled, { ignoreEncryption: true, updateMetadata: false });
    const form = doc.getForm();
    const read = (slot: string) => form.getTextField(identityFieldName(slot)).getText();
    expect(read('tp_ssn')).toBe('123456789'); // digits in the comb boxes
    expect(read('tp_ssn')).not.toBe('');      // the P92 regression pin
    expect(read('sp_ssn')).toBe('987654321');
    expect(read('tp_first')).toBe('Testfirst');
    expect(read('tp_last')).toBe('Testcase');
    expect(read('address')).toBe('1 Synthetic Way');
    expect(read('zip')).toBe('62701');
    expect(form.getCheckBox(ageBlindFieldName('tp_65')).isChecked()).toBe(true);
    expect(form.getCheckBox(ageBlindFieldName('sp_65')).isChecked()).toBe(false);
  });

  it('IL-1040: Step 1 carries the FULL dashed SSN and mm/dd/yyyy DOB (P81)', async () => {
    const filled = await fillIdentity(il1040, 'IL1040', IDENTITY);
    const doc = await PDFDocument.load(filled, { ignoreEncryption: true, updateMetadata: false });
    const form = doc.getForm();
    const read = (slot: string) => form.getTextField(ilIdentityFieldName(slot)).getText();
    expect(read('tp_ssn')).toBe('123-45-6789'); // IL shows the dashed form verbatim
    expect(read('tp_dob')).toBe('03/07/1959');
    expect(read('sp_dob')).toBe('11/30/1961');
    expect(read('tp_first')).toBe('Testfirst');
    expect(read('city')).toBe('Springfield');
  });

  it('a non-identity form passes through byte-identical', async () => {
    const schb = new Uint8Array(readFileSync(root('templates/pdf/2025/FED/f1040sb.pdf')));
    const out = await fillIdentity(schb, 'SCHB', IDENTITY);
    expect(out).toBe(schb); // untouched, not even re-saved
  });

  it('helpers: ssnDigits and usDate handle the realistic shapes', () => {
    expect(ssnDigits('123-45-6789')).toBe('123456789');
    expect(ssnDigits('123 45 6789')).toBe('123456789');
    expect(ssnDigits('')).toBeUndefined();
    expect(usDate('1959-03-07')).toBe('03/07/1959');
    expect(usDate('7 March 1959')).toBe('7 March 1959'); // never mangled
  });

  it('the server-built artifact really is identity-BLANK (the split holds)', async () => {
    const doc = await PDFDocument.load(f1040, { ignoreEncryption: true, updateMetadata: false });
    const form = doc.getForm();
    expect(form.getTextField(identityFieldName('tp_ssn')).getText() ?? '').toBe('');
    expect(form.getTextField(identityFieldName('tp_first')).getText() ?? '').toBe('');
  });
});
