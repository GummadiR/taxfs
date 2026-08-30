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

/**
 * The empty-identity trap (found on the operator's own printed forms).
 *
 * setIfPresent SKIPS an absent value — right for an optional field, wrong for
 * a required one, and the two look identical at the point of filling. So an
 * EMPTY identity filled nothing, threw nothing, and produced a PDF whose
 * Step 1 was blank while the UI reported "downloaded with identity filled in
 * this browser". The panel starts empty on every page load (a saved identity
 * lives encrypted in the browser until you press Load), so this was the
 * ordinary outcome, not an edge case.
 *
 * Every test here attempts the forbidden thing and passes only on refusal
 * (§9.1).
 */
describe('an incomplete identity is REFUSED, never printed blank', () => {
  const EMPTY: FilingIdentity = { taxpayer: {} };

  it('REFUSES an entirely empty identity instead of returning a blank Step 1', async () => {
    await expect(fillIdentity(f1040, '1040', EMPTY)).rejects.toThrow(/nothing was filled in/);
    await expect(fillIdentity(il1040, 'IL1040', EMPTY)).rejects.toThrow(/nothing was filled in/);
  });

  it('names what is missing, and how to get it back', async () => {
    await expect(fillIdentity(f1040, '1040', EMPTY)).rejects.toThrow(/Your first name/);
    await expect(fillIdentity(f1040, '1040', EMPTY)).rejects.toThrow(/SSN/);
    // The recovery step, because "saved earlier but not loaded" is the
    // overwhelmingly likely cause.
    await expect(fillIdentity(f1040, '1040', EMPTY)).rejects.toThrow(/press Load/);
  });

  it('REFUSES a PARTIAL identity — a name with no SSN is not filable', async () => {
    const partial: FilingIdentity = {
      taxpayer: { first_name: 'Testfirst', last_name: 'Testcase' },
      address_line: '1 Synthetic Way', city: 'Springfield', state: 'IL', zip: '62701',
    };
    await expect(fillIdentity(f1040, '1040', partial)).rejects.toThrow(/SSN/);
  });

  it('REFUSES a truncated SSN rather than printing a short comb', async () => {
    const short: FilingIdentity = { ...IDENTITY, taxpayer: { ...IDENTITY.taxpayer, ssn: '123-45' } };
    await expect(fillIdentity(f1040, '1040', short)).rejects.toThrow(/SSN \(9 digits\)/);
  });

  it('REFUSES a missing address — the Step 1 block needs it', async () => {
    const noAddr: FilingIdentity = { ...IDENTITY };
    delete (noAddr as { address_line?: string }).address_line;
    await expect(fillIdentity(f1040, '1040', noAddr)).rejects.toThrow(/Street address/);
  });

  it('on a JOINT return, an unnamed spouse is refused too', async () => {
    const soloOnJoint: FilingIdentity = { ...IDENTITY };
    delete (soloOnJoint as { spouse?: unknown }).spouse;
    // Not joint: fine — a single filer has no spouse to name.
    await expect(fillIdentity(f1040, '1040', soloOnJoint)).resolves.toBeInstanceOf(Uint8Array);
    // Joint: refused.
    await expect(fillIdentity(f1040, '1040', soloOnJoint, { joint: true }))
      .rejects.toThrow(/Spouse's first name/);
  });

  it('the IL-1040 additionally requires a date of birth (P81)', async () => {
    const noDob: FilingIdentity = { ...IDENTITY, taxpayer: { ...IDENTITY.taxpayer, dob: undefined } };
    // The federal face has no DOB box, so the federal fill is unaffected.
    await expect(fillIdentity(f1040, '1040', noDob)).resolves.toBeInstanceOf(Uint8Array);
    await expect(fillIdentity(il1040, 'IL1040', noDob)).rejects.toThrow(/date of birth/);
  });

  it('the DELIBERATE identity-blank download still works — empty boxes are its point', async () => {
    const blank = await fillIdentity(f1040, '1040', EMPTY, { allowIncomplete: true });
    expect(blank).toBeInstanceOf(Uint8Array);
    const form = (await PDFDocument.load(blank, { ignoreEncryption: true, updateMetadata: false })).getForm();
    expect(form.getTextField(identityFieldName('tp_ssn')).getText() ?? '').toBe('');
  });

  it('a COMPLETE identity is unaffected — the guard blocks nothing valid', async () => {
    await expect(fillIdentity(f1040, '1040', IDENTITY, { joint: true })).resolves.toBeInstanceOf(Uint8Array);
    await expect(fillIdentity(il1040, 'IL1040', IDENTITY, { joint: true })).resolves.toBeInstanceOf(Uint8Array);
  });
});
