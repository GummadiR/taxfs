/**
 * Regression guard: every form_id in either FORMS release must have a
 * placeholder-layout entry in 2025.PDF-TEMPLATES.json, or buildPackage()
 * throws for any return that populates it (found 2026-07: SCH1/SCH2/SCH3/
 * SCHC/SCHSE/SCHE/F8995/F8962/F8959/F8960 were all missing — anything
 * beyond a bare W-2 return crashed the print channel). New form families
 * must add their entry here in the same PR, not discover the gap later.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadFormDefRelease } from '@taxfs/forms';
import { loadPdfTemplates } from '../src/pdf';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const readJson = (p: string): unknown => JSON.parse(readFileSync(root(p), 'utf8'));

describe('placeholder PDF layout covers every registered form (regression)', () => {
  it('every FED and IL form_id has a 2025.PDF-TEMPLATES.json entry', () => {
    const fed = loadFormDefRelease(readJson('rules/fixtures/forms/2025.FORMS.FED.json'));
    const il = loadFormDefRelease(readJson('rules/fixtures/forms/2025.FORMS.IL.json'));
    const config = loadPdfTemplates(readJson('rules/fixtures/pdf/2025.PDF-TEMPLATES.json'));
    const missing = [...fed.forms, ...il.forms]
      .map((f) => f.form_id)
      .filter((id) => !config.templates[id]);
    expect(missing).toEqual([]);
  });
});
