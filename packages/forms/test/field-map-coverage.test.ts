/**
 * P80 — the guard that was missing. Three whole forms and eight 1040 boxes
 * were absent from a real filed package and NOTHING failed:
 *
 *  - F8949 had an official template but no field map, so the packet builder
 *    silently dropped the form Schedule D's own header says to attach.
 *  - 1040.2a had a form-def line and (after P79) a kernel fact, but no field
 *    map entry, so tax-exempt interest never printed.
 *  - 1040.12 / 1040.13 pointed one widget too low after the 2025 renumbering
 *    (deduction → 12e, old line 13 → 13a/13b), printing the deduction on the
 *    QBI line.
 *
 * These tests fail the build for the whole CLASS, not the instances: every
 * mapped line must exist in its template, every form-def line that a return
 * can populate must have a field map entry, and every map must point at a
 * template that is actually on disk.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { loadFieldMaps, loadFormDefRelease, type FieldMapRelease, type FormDefRelease } from '@taxfs/forms';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const readJson = (p: string): unknown => JSON.parse(readFileSync(root(p), 'utf8'));

const maps: FieldMapRelease = loadFieldMaps(readJson('rules/fixtures/pdf/2025.PDF-FIELDMAP.json'));
const releases: Record<string, FormDefRelease> = {
  FED: loadFormDefRelease(readJson('rules/fixtures/forms/2025.FORMS.FED.json')),
  IL: loadFormDefRelease(readJson('rules/fixtures/forms/2025.FORMS.IL.json')),
};

/** Forms with no official template on disk yet. Each MUST be listed here with
 *  a reason — the point is that dropping a form is a deliberate, visible
 *  decision, never a silent omission. */
const NO_TEMPLATE_YET: Record<string, string> = {
  F5695: 'Form 5695: f5695.pdf not in templates/pdf/2025/FED',
};

/** Lines that genuinely have NO box on the official form. Each must be listed
 *  with the reason — the point is that an unmapped line is a deliberate,
 *  documented decision, never an oversight. */
const NO_BOX_ON_FORM: Record<string, string> = {
  'F1116.CARRY': 'unused foreign tax carries on Schedule B (Form 1116), a separate form; the 1116 face has no box for it (line 10 is the carryover IN, not out)',
};

describe('every field map points at a template that exists', () => {
  for (const [formId, map] of Object.entries(maps.forms)) {
    it(`${formId} template is on disk`, () => {
      expect(existsSync(root(map.template_path)), `${formId} → ${map.template_path}`).toBe(true);
    });
  }
});

describe('every mapped field name exists in its official template', () => {
  for (const [formId, map] of Object.entries(maps.forms)) {
    it(`${formId}: all ${Object.keys(map.fields).length} field names resolve`, async () => {
      const doc = await PDFDocument.load(readFileSync(root(map.template_path)), { ignoreEncryption: true, updateMetadata: false });
      const names = new Set(doc.getForm().getFields().map((f) => f.getName()));
      const missing = Object.entries(map.fields)
        .filter(([, field]) => !names.has(field))
        .map(([lineId, field]) => `${lineId} → ${field}`);
      expect(missing).toEqual([]);
      // filing_status values are either "fieldName" (federal: one checkbox per
      // status) or "fieldName|exportValue" (Illinois: one field, five states).
      const missingChecks = Object.entries({ ...(map.check_on_present ?? {}), ...(map.filing_status_boxes ?? {}) })
        .filter(([, field]) => !names.has(field.split('|')[0]!))
        .map(([k, field]) => `${k} → ${field}`);
      expect(missingChecks).toEqual([]);
    });
  }
});

describe('no form can vanish from a package silently', () => {
  for (const [jur, release] of Object.entries(releases)) {
    for (const def of release.forms) {
      it(`${jur} ${def.form_id} is either mapped or explicitly deferred`, () => {
        const mapped = maps.forms[def.form_id] !== undefined;
        const deferred = NO_TEMPLATE_YET[def.form_id];
        expect(
          mapped || deferred !== undefined,
          `${def.form_id} has a form definition but no field map. Either map it, or add it to NO_TEMPLATE_YET with the reason — a form that computes but never prints is a wrong filing.`,
        ).toBe(true);
      });
    }
  }
});

describe('every form-def line has somewhere to print', () => {
  for (const [jur, release] of Object.entries(releases)) {
    for (const def of release.forms) {
      const map = maps.forms[def.form_id];
      if (!map) continue;
      it(`${jur} ${def.form_id}: every line_id is in the field map`, () => {
        const unmapped = def.lines
          .map((l) => l.line_id)
          .filter((id) => map.fields[id] === undefined && NO_BOX_ON_FORM[id] === undefined);
        expect(unmapped).toEqual([]);
      });
    }
  }
});

describe('both jurisdictions tick a filing-status control for every status', () => {
  // P81 — Illinois shipped with its status box blank too, and IL builds the
  // control differently (ONE field with five named states, vs the federal
  // form's five separate checkboxes). Both must be complete.
  for (const formId of ['1040', 'IL1040']) {
    it(`${formId} maps all five statuses`, () => {
      const boxes = maps.forms[formId]?.filing_status_boxes ?? {};
      for (const status of ['single', 'mfj', 'mfs', 'hoh', 'qss']) {
        expect(boxes[status], `no ${formId} control mapped for filing status "${status}"`).toBeTruthy();
      }
    });
  }
});
