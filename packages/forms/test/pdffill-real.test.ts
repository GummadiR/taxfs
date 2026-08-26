/**
 * P11.3 — the real-template proof. Field names in
 * rules/fixtures/pdf/2025.PDF-FIELDMAP.json were matched to their printed
 * IRS/IL line by the right-margin line-number the form reprints next to each
 * box (pdftotext -bbox), not guessed. This test fills the ACTUAL 2025 PDFs
 * with a DISTINCT value per line and asserts each value lands in its own
 * field while every OTHER text field on the form stays blank — which catches
 * an off-by-one-row mapping that a same-value test would miss.
 *
 * Each form's block skips itself (never fails CI) when its template file is
 * absent — the PDFs are a drop-in procurement artifact, not committed
 * fixtures every clone is guaranteed to have.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFTextField } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { Money } from '@taxfs/shared';
import { fillPdfForm, loadFieldMaps, type FormFieldMap } from '../src/pdffill';
import type { FormDefinition, FormInstance } from '../src/types';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const path = (rel: string) => `${root}${rel}`;
const maps = loadFieldMaps(JSON.parse(readFileSync(path('rules/fixtures/pdf/2025.PDF-FIELDMAP.json'), 'utf8')));

function defFor(formId: string, lineIds: string[]): FormDefinition {
  return {
    form_id: formId,
    jurisdiction: formId.startsWith('IL') || formId.startsWith('SCHM') || formId.startsWith('SCHIL') ? 'IL' : 'FED',
    tax_year: 2025,
    revision: `${formId}-2025.0`,
    source_schema_ref: 'test',
    pdf_template_ref: 'test',
    required_when: { kind: 'always' },
    attachment_order: 0,
    lines: lineIds.map((id) => ({ line_id: id, label: id, datatype: 'money', from_concept: id, sign_convention: 'as_is' })),
  };
}

function instanceFor(formId: string, values: Record<string, string>): FormInstance {
  return {
    instance_id: 'i',
    form_id: formId,
    revision: `${formId}-2025.0`,
    jurisdiction: defFor(formId, []).jurisdiction,
    tax_year: 2025,
    taxpayer_id: 'tp-x',
    values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, Money.fromString(v)])),
    lineage: {},
    status: 'draft',
  };
}

/** Text-field values keyed by name (for a blank vs filled comparison). */
async function textFieldValues(bytes: Uint8Array): Promise<Map<string, string>> {
  const doc = await PDFDocument.load(bytes);
  const out = new Map<string, string>();
  for (const field of doc.getForm().getFields()) {
    if (field instanceof PDFTextField) out.set(field.getName(), field.getText() ?? '');
  }
  return out;
}

/** Fields we did NOT map but whose value CHANGED vs the blank template.
 *  Ignores fields the official PDF ships pre-filled (help/instruction text),
 *  which are not something the fill wrote. */
async function strayWrites(
  baseline: Map<string, string>,
  filled: Uint8Array,
  written: string[],
): Promise<string[]> {
  const after = await textFieldValues(filled);
  const stray: string[] = [];
  for (const [name, value] of after) {
    if (written.includes(name)) continue;
    if (value !== (baseline.get(name) ?? '')) stray.push(`${name}=${value}`);
  }
  return stray;
}

/** Distinct value per line so a swapped mapping can't pass. Skips paired
 *  line_ids that intentionally share one physical box (1040 line 7). */
/** P81 — some official boxes are genuinely narrow (IL-1040 line 10a holds four
 *  characters), so the synthetic value has to FIT or the test asserts behaviour
 *  the real form cannot support. Values stay distinct per field either way,
 *  which is what the stray-write check depends on. */
function distinctValues(
  map: FormFieldMap,
  skip: string[] = [],
  maxLens: Map<string, number> = new Map(),
): Record<string, string> {
  const out: Record<string, string> = {};
  let n = 1;
  for (const lineId of Object.keys(map.fields)) {
    if (skip.includes(lineId)) continue;
    const wide = String(n * 1111);
    const max = maxLens.get(map.fields[lineId]!);
    out[lineId] = max !== undefined && wide.length > max
      ? String(10 ** (max - 1) + (n % 10 ** (max - 1)))
      : wide;
    n += 1;
  }
  return out;
}

async function maxLengthsOf(bytes: Uint8Array): Promise<Map<string, number>> {
  const doc = await PDFDocument.load(bytes);
  const out = new Map<string, number>();
  for (const f of doc.getForm().getFields()) {
    const max = f instanceof PDFTextField ? f.getMaxLength() : undefined;
    if (max !== undefined) out.set(f.getName(), max);
  }
  return out;
}

const CASES: { formId: string; template: string; skip?: string[] }[] = [
  { formId: '1040', template: 'templates/pdf/2025/FED/f1040.pdf' },
  { formId: 'SCHB', template: 'templates/pdf/2025/FED/f1040sb.pdf' },
  { formId: 'SCH1', template: 'templates/pdf/2025/FED/f1040s1.pdf' },
  { formId: 'SCH2', template: 'templates/pdf/2025/FED/f1040s2.pdf' },
  { formId: 'SCH3', template: 'templates/pdf/2025/FED/f1040s3.pdf' },
  { formId: 'SCHC', template: 'templates/pdf/2025/FED/f1040sc.pdf' },
  { formId: 'SCHD', template: 'templates/pdf/2025/FED/f1040sd.pdf' },
  { formId: 'SCHE', template: 'templates/pdf/2025/FED/f1040se.pdf' },
  { formId: 'SCHSE', template: 'templates/pdf/2025/FED/f1040sse.pdf' },
  { formId: 'F8995', template: 'templates/pdf/2025/FED/f8995.pdf' },
  { formId: 'F8962', template: 'templates/pdf/2025/FED/f8962.pdf' },
  { formId: 'F8959', template: 'templates/pdf/2025/FED/f8959.pdf' },
  { formId: 'F8960', template: 'templates/pdf/2025/FED/f8960.pdf' },
  { formId: 'IL1040', template: 'templates/pdf/2025/IL/il1040.pdf' },
  { formId: 'SCHILWIT', template: 'templates/pdf/2025/IL/schilwit.pdf' },
  { formId: 'SCHM', template: 'templates/pdf/2025/IL/schm.pdf' },
  { formId: 'SCHICR', template: 'templates/pdf/2025/IL/schicr.pdf' },
];

for (const { formId, template, skip } of CASES) {
  describe.runIf(existsSync(path(template)))(`${formId} — real 2025 template`, () => {
    it('each mapped line fills its own field; every other text field stays blank', async () => {
      const map = maps.forms[formId]!;
      const templateBytes = new Uint8Array(readFileSync(path(template)));
      const baseline = await textFieldValues(templateBytes);
      const values = distinctValues(map, skip, await maxLengthsOf(templateBytes));
      const def = defFor(formId, Object.keys(values));
      const result = await fillPdfForm(templateBytes, def, instanceFor(formId, values), map);
      expect(result.unmapped_line_ids).toEqual([]);
      const reloaded = await PDFDocument.load(result.bytes);
      for (const [lineId, v] of Object.entries(values)) {
        expect(reloaded.getForm().getTextField(map.fields[lineId]!).getText(), `${formId} ${lineId}`).toBe(v);
      }
      const written = Object.keys(values).map((id) => map.fields[id]!);
      expect(await strayWrites(baseline, result.bytes, written), `${formId} stray writes`).toEqual([]);
    });
  });
}
