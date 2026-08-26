/**
 * P11.3 — full pipeline proof: buildPackage(), given the real templates +
 * verified field map, emits genuine filled application/pdf artifacts for
 * the forms that have them and keeps the loud placeholder for forms that
 * don't (e.g. 1040 itself has no template yet). This is what the app's
 * File It page actually calls.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { loadFieldMaps } from '../src/pdffill';
import { buildFor } from './helpers';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const path = (rel: string) => `${root}${rel}`;

const maps = loadFieldMaps(JSON.parse(readFileSync(path('rules/fixtures/pdf/2025.PDF-FIELDMAP.json'), 'utf8')));
const templates: Record<string, Uint8Array> = {};
for (const [formId, map] of Object.entries(maps.forms)) {
  const p = path(map.template_path);
  if (existsSync(p)) templates[formId] = new Uint8Array(readFileSync(p));
}

describe.runIf(Object.keys(templates).length > 0)('buildPackage with real official-PDF templates (P11.3)', () => {
  it('1040 + SCH1 + SCHSE render as real filled PDFs for a Schedule C return; an unmapped form stays placeholder', async () => {
    const built = await buildFor('return4-schc-se', { pdf_fill: { maps, templates } });
    const sch1 = built.artifacts.find((a) => a.artifact_id === 'pdf:SCH1');
    const schse = built.artifacts.find((a) => a.artifact_id === 'pdf:SCHSE');
    const f1040 = built.artifacts.find((a) => a.artifact_id === 'pdf:1040');
    const f8949 = built.artifacts.find((a) => a.artifact_id === 'pdf:F8949');
    expect(sch1?.content_type).toBe('application/pdf');
    expect(schse?.content_type).toBe('application/pdf');
    expect(f1040?.content_type).toBe('application/pdf');
    // F8949 has a template but is deliberately NOT field-mapped (per-box Totals
    // rows, no single aggregate cell) — it stays the loud placeholder, not silent.
    if (f8949) expect(f8949.content_type).toBe('text/x-pdf-placeholder');

    const doc = await PDFDocument.load(Buffer.from(sch1!.content, 'base64'));
    const field = maps.forms['SCH1']!.fields['SCH1.3']!;
    // return4-schc-se: Sch C net profit 51,000 (fed.schc.net_profit.total in the golden).
    expect(doc.getForm().getTextField(field).getText()).toBe('51000');
    // 1040 line 9 (total income) fills its real box.
    const doc40 = await PDFDocument.load(Buffer.from(f1040!.content, 'base64'));
    expect(doc40.getForm().getTextField(maps.forms['1040']!.fields['1040.9']!).getText()).not.toBe('');
    expect(built.report.mapping_defects.filter((d) => d.kind === 'unmapped_pdf_line')).toEqual([]);
  });

  it('F8959 and F8960 render as real filled PDFs for the surtax golden', async () => {
    const built = await buildFor('return25-addl-medicare-niit', { pdf_fill: { maps, templates } });
    const f8959 = built.artifacts.find((a) => a.artifact_id === 'pdf:F8959');
    const f8960 = built.artifacts.find((a) => a.artifact_id === 'pdf:F8960');
    expect(f8959?.content_type).toBe('application/pdf');
    expect(f8960?.content_type).toBe('application/pdf');

    const doc59 = await PDFDocument.load(Buffer.from(f8959!.content, 'base64'));
    expect(doc59.getForm().getTextField(maps.forms['F8959']!.fields['F8959.18']!).getText()).toBe('198');
    expect(doc59.getForm().getTextField(maps.forms['F8959']!.fields['F8959.24']!).getText()).toBe('420');

    const doc60 = await PDFDocument.load(Buffer.from(f8960!.content, 'base64'));
    expect(doc60.getForm().getTextField(maps.forms['F8960']!.fields['F8960.17']!).getText()).toBe('304');
  });
});
