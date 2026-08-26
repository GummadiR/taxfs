/**
 * P11.1 — official-PDF fill engine, proven against a synthetic AcroForm
 * built in-test (the real IRS/IL templates are drop-in procurement
 * artifacts; scripts/dump-pdf-fields.ts --check validates the release
 * against them when they land).
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { Money, PLACEHOLDER } from '@taxfs/shared';
import { fillPdfForm, formatAmountForPaper, listPdfFields, loadFieldMaps } from '../src/pdffill';
import type { FormDefinition, FormInstance } from '../src/types';

async function syntheticTemplate(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 400]);
  const form = doc.getForm();
  const a = form.createTextField('topmost.f1_01');
  a.addToPage(page, { x: 50, y: 300, width: 120, height: 16 });
  const b = form.createTextField('topmost.f1_02');
  b.addToPage(page, { x: 50, y: 270, width: 120, height: 16 });
  const box = form.createCheckBox('topmost.c1_01');
  box.addToPage(page, { x: 50, y: 240, width: 12, height: 12 });
  return doc.save();
}

const DEF: FormDefinition = {
  form_id: 'TESTFORM',
  jurisdiction: 'FED',
  tax_year: 2025,
  revision: 'TESTFORM-2025.0',
  source_schema_ref: 'test://schema',
  pdf_template_ref: 'test://template',
  required_when: { kind: 'always' },
  attachment_order: 0,
  lines: [
    { line_id: 'TESTFORM.1', label: 'Amount A', datatype: 'money', from_concept: 'x.a', sign_convention: 'as_is' },
    { line_id: 'TESTFORM.2', label: 'Amount B (loss)', datatype: 'money', from_concept: 'x.b', sign_convention: 'as_is' },
    { line_id: 'TESTFORM.3', label: 'Unmapped', datatype: 'money', from_concept: 'x.c', sign_convention: 'as_is' },
  ],
};

function instanceWith(values: Record<string, string>): FormInstance {
  return {
    instance_id: 'i-test',
    form_id: 'TESTFORM',
    revision: DEF.revision,
    jurisdiction: 'FED',
    tax_year: 2025,
    taxpayer_id: 'tp-x',
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Money.fromString(v)])),
    lineage: {},
    status: 'draft',
  };
}

const MAP = {
  template_path: 'templates/pdf/2025/FED/test.pdf',
  fields: { 'TESTFORM.1': 'topmost.f1_01', 'TESTFORM.2': 'topmost.f1_02' },
  check_on_present: { applies: 'topmost.c1_01' },
};

describe('official-PDF fill engine (P11.1)', () => {
  it('fills mapped text fields from instance values; negatives print in parentheses', async () => {
    const template = await syntheticTemplate();
    const result = await fillPdfForm(template, DEF, instanceWith({ 'TESTFORM.1': '246192', 'TESTFORM.2': '-3000' }), MAP);
    expect(result.unmapped_line_ids).toEqual([]);
    const reloaded = await PDFDocument.load(result.bytes);
    expect(reloaded.getForm().getTextField('topmost.f1_01').getText()).toBe('246192');
    expect(reloaded.getForm().getTextField('topmost.f1_02').getText()).toBe('(3000)');
    expect(reloaded.getForm().getCheckBox('topmost.c1_01').isChecked()).toBe(true);
  });

  it('a populated line with NO field mapping surfaces as unmapped — never silently dropped', async () => {
    const template = await syntheticTemplate();
    const result = await fillPdfForm(template, DEF, instanceWith({ 'TESTFORM.1': '10', 'TESTFORM.3': '55' }), MAP);
    expect(result.unmapped_line_ids).toEqual(['TESTFORM.3']);
  });

  it('a mapped field missing from the PDF is a hard error naming the field', async () => {
    const template = await syntheticTemplate();
    const badMap = { ...MAP, fields: { 'TESTFORM.1': 'no_such_field' } };
    await expect(fillPdfForm(template, DEF, instanceWith({ 'TESTFORM.1': '10' }), badMap)).rejects.toThrow(/no_such_field/);
  });

  it('the output stays an editable AcroForm (identity fields are typed by the filer, never held by TaxOS)', async () => {
    const template = await syntheticTemplate();
    const result = await fillPdfForm(template, DEF, instanceWith({ 'TESTFORM.1': '10' }), MAP);
    const fields = await listPdfFields(result.bytes);
    expect(fields.map((f) => f.name)).toContain('topmost.f1_02'); // still present, still a field
  });

  it('paper amount format: whole dollars as-is, negatives parenthesized', () => {
    expect(formatAmountForPaper('1234')).toBe('1234');
    expect(formatAmountForPaper('-1234')).toBe('(1234)');
    expect(formatAmountForPaper('0')).toBe('0');
  });
});

describe('field-map release loader', () => {
  it('loads an empty PLACEHOLDER release (pre-procurement state)', () => {
    const release = loadFieldMaps({ release: 'r', status: PLACEHOLDER, forms: {} });
    expect(Object.keys(release.forms)).toHaveLength(0);
  });

  it('refuses a release without the PLACEHOLDER marker', () => {
    expect(() => loadFieldMaps({ release: 'r', forms: {} })).toThrow(/marker/);
  });

  it('refuses a form entry without template_path or with empty field names', () => {
    expect(() => loadFieldMaps({ release: 'r', status: PLACEHOLDER, forms: { X: { fields: {} } } })).toThrow(/template_path/);
    expect(() =>
      loadFieldMaps({ release: 'r', status: PLACEHOLDER, forms: { X: { template_path: 'p', fields: { 'X.1': '' } } } }),
    ).toThrow(/non-empty/);
  });

  it('the shipped 2025 release parses (empty until official PDFs land)', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const json = JSON.parse(
      readFileSync(fileURLToPath(new URL('../../../rules/fixtures/pdf/2025.PDF-FIELDMAP.json', import.meta.url)), 'utf8'),
    ) as unknown;
    const release = loadFieldMaps(json);
    expect(release.release).toContain('PDF-FIELDMAP');
  });
});
