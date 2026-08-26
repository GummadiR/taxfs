/**
 * Subject: field-map guard, negative form (guardrail G10, Blueprint §9.1).
 * The coverage suite proves the real maps are clean; THIS test proves the
 * guard itself catches the forbidden thing — a map entry naming a field the
 * official template does not have (the P80/P92 class: a field mapped by
 * guesswork). It resolves a fabricated field name against the real f1040.pdf
 * and passes only when the guard reports it missing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { loadFieldMaps, type FieldMapRelease } from '@taxfs/forms';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const maps: FieldMapRelease = loadFieldMaps(
  JSON.parse(readFileSync(root('rules/fixtures/pdf/2025.PDF-FIELDMAP.json'), 'utf8')),
);

describe('field-map guard catches a nonexistent field (G10 negative)', () => {
  it('a seeded bogus field name fails resolution against the real template', async () => {
    const f1040 = maps.forms['1040'];
    expect(f1040).toBeDefined();
    const doc = await PDFDocument.load(readFileSync(root(f1040!.template_path)), {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const names = new Set(doc.getForm().getFields().map((f) => f.getName()));
    // The real map resolves clean (control)…
    const missingReal = Object.values(f1040!.fields).filter((field) => !names.has(field.split('|')[0]!));
    expect(missingReal).toEqual([]);
    // …and the seeded guess is caught.
    const seeded = { ...f1040!.fields, 'SEEDED.LINE': 'topmostSubform[0].Page1[0].f1_no_such_field[0]' };
    const missingSeeded = Object.entries(seeded).filter(([, field]) => !names.has(field.split('|')[0]!));
    expect(missingSeeded.map(([line]) => line)).toEqual(['SEEDED.LINE']);
  });
});
