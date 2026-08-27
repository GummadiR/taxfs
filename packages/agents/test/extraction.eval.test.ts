/**
 * E.7 eval — Extraction: golden input→expected output field accuracy,
 * checksum rejection, wrong-year flag, unreadable→manual-entry, confidence
 * gating, and the vision-path guardrails (attachment prompts, response-side
 * PII tokenization, private logging). Deterministic stub provider here; the
 * REAL-document leg (sample W-2 PDF through the live Anthropic vision API)
 * lives in extraction.live.test.ts, gated on ANTHROPIC_API_KEY.
 */
import { describe, expect, it } from 'vitest';
import { C } from '@taxfs/shared';
import {
  extractionAgent,
  piiToken,
  runExtraction,
  sanitizeExtractionPii,
  type DocImageStub,
  type ExtractionOutput,
} from '@taxfs/agents';
import { makeRig } from './helpers.js';

const W2_DOC: DocImageStub = {
  doc_id: 's-w2',
  image_ref: 'blob://s-w2.png',
  ocr_text: 'W-2 Acme Corp EIN tok_ein_acme1 Box1 60000 Box2 6000 Box3 60000 Box5 60000 Box17 3000 Year 2025',
  expected_tax_year: 2025,
};

function w2Output(overrides: Partial<ExtractionOutput> = {}): string {
  const base: ExtractionOutput = {
    doc_type: 'W-2',
    tax_year: 2025,
    payer: { name: 'Acme Corp', ein_token: 'tok_ein_acme1' },
    fields: [
      { name: 'box1_wages', raw_text: '60,000.00', normalized: { kind: 'decimal', value: '60000' }, region: { page: 1, x: 10, y: 20, w: 30, h: 5 }, confidence: 0.98 },
      { name: 'box2_fed_withholding', raw_text: '6,000.00', normalized: { kind: 'decimal', value: '6000' }, region: { page: 1, x: 10, y: 30, w: 30, h: 5 }, confidence: 0.97 },
      { name: 'box5_medicare_wages', raw_text: '60,000.00', normalized: { kind: 'decimal', value: '60000' }, region: { page: 1, x: 10, y: 40, w: 30, h: 5 }, confidence: 0.96 },
      { name: 'box17_il_withholding', raw_text: '3,000.00', normalized: { kind: 'decimal', value: '3000' }, region: { page: 1, x: 10, y: 50, w: 30, h: 5 }, confidence: 0.95 },
    ],
    ...overrides,
  };
  return JSON.stringify(base);
}

describe('extraction eval (E.1 / E.7)', () => {
  it('golden W-2: 100% field accuracy into typed proposals with regions + AI markers', async () => {
    const rig = makeRig({ extraction: () => w2Output() });
    const run = await runExtraction(rig.deps, W2_DOC, 'tp-x');
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    expect(run.flags.wrong_year).toBe(false);
    // box5 feeds Form 8959 (P10) as a non-critical proposal alongside the
    // three critical wage/withholding boxes; it still drives the checksum.
    const expected: Record<string, string> = {
      [C.WAGES]: '60000',
      [C.FED_WITHHOLDING]: '6000',
      [C.IL_WITHHOLDING]: '3000',
      [C.WAGES_MEDICARE]: '60000',
    };
    expect(run.proposals).toHaveLength(4);
    for (const p of run.proposals) {
      expect(p.value).toBe(expected[p.concept]);
      expect(p.critical).toBe(p.concept !== C.WAGES_MEDICARE); // wage/withholding boxes: individual confirm
      expect(p.region).toBeDefined();
      expect(p.source_id).toBe('s-w2');
    }
    expect(rig.log.entries.at(-1)?.validation_result).toBe('ok');
  });

  it('rejects a checksum-suspect extraction (box 1 > box 5)', async () => {
    const bad = w2Output();
    const rig = makeRig({
      extraction: () => bad.replace('"value":"60000"', '"value":"75000"'), // box1 becomes 75000 > box5 60000
    });
    const run = await runExtraction(rig.deps, W2_DOC, 'tp-x');
    expect(run.status).toBe('rejected');
    if (run.status === 'rejected') {
      expect(run.issues.some((i) => i.message.includes('checksum'))).toBe(true);
    }
  });

  it('flags a wrong-year document instead of silently accepting it', async () => {
    const rig = makeRig({ extraction: () => w2Output({ tax_year: 2024 }) });
    const run = await runExtraction(rig.deps, W2_DOC, 'tp-x');
    expect(run.status).toBe('ok');
    if (run.status === 'ok') expect(run.flags.wrong_year).toBe(true);
  });

  it('routes unreadable documents to manual entry — never guesses a doc type', async () => {
    const rig = makeRig({
      extraction: () => JSON.stringify({ doc_type: 'UNREADABLE', tax_year: null, payer: { name: '', ein_token: null }, fields: [] }),
    });
    const run = await runExtraction(rig.deps, { ...W2_DOC, ocr_text: '~~~smudge~~~' }, 'tp-x');
    expect(run.status).toBe('manual_entry');
  });

  it('confidence gating: below-threshold field becomes empty-with-suggestion', async () => {
    const low = JSON.parse(w2Output()) as ExtractionOutput;
    low.fields = low.fields.map((f) => (f.name === 'box17_il_withholding' ? { ...f, confidence: 0.6 } : f));
    const rig = makeRig({ extraction: () => JSON.stringify(low) });
    const run = await runExtraction(rig.deps, W2_DOC, 'tp-x');
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    const il = run.proposals.find((p) => p.concept === C.IL_WITHHOLDING);
    expect(il?.value).toBeNull();
    expect(il?.suggestion).toBe('3000');
  });

  it('rejects unparseable decimals and untokenized EINs', async () => {
    const badDecimal = w2Output().replace('"value":"6000"', '"value":"6,000.00"');
    const rig1 = makeRig({ extraction: () => badDecimal });
    const run1 = await runExtraction(rig1.deps, W2_DOC, 'tp-x');
    expect(run1.status).toBe('rejected');

    const rig2 = makeRig({
      extraction: () => w2Output({ payer: { name: 'Acme', ein_token: 'not-a-token' } }),
    });
    const run2 = await runExtraction(rig2.deps, W2_DOC, 'tp-x');
    expect(run2.status).toBe('rejected');
    if (run2.status === 'rejected') {
      expect(run2.issues.some((i) => i.message.includes('tokenized'))).toBe(true);
    }
  });

  it('vision path: the document travels as an attachment; prompt text carries no document content or PII', () => {
    const media = { kind: 'pdf' as const, media_type: 'application/pdf', data_base64: 'JVBERg==' };
    const messages = extractionAgent.buildMessages({
      doc_id: 'doc-001',
      image_ref: 'supabase://taxos-docs/2025/doc-001.pdf',
      media,
      expected_tax_year: 2025,
    });
    expect(messages).toHaveLength(2);
    expect(messages[1]?.attachments).toEqual([media]);
    const promptText = messages.map((m) => m.content).join('\n');
    // No SSN/EIN patterns and no OCR text in the outbound prompt text.
    expect(promptText).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(promptText).not.toMatch(/\b\d{2}-\d{7}\b/);
    expect(promptText).toContain('never output a Social Security Number');
  });

  it('response-side PII wall: a raw EIN/SSN echoed by the model is tokenized before validation, proposals, or logs', async () => {
    const dirty = JSON.parse(w2Output()) as ExtractionOutput;
    dirty.payer = { name: 'Acme Corp', ein_token: '12-3456789' }; // raw EIN from the scan
    dirty.fields = dirty.fields.map((f) =>
      f.name === 'box1_wages' ? { ...f, raw_text: '60,000.00 (employee 123-45-6789)' } : f,
    );
    const rig = makeRig({ extraction: () => JSON.stringify(dirty) });
    const run = await runExtraction(rig.deps, W2_DOC, 'tp-x');
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    expect(run.output.payer.ein_token).toMatch(/^tok_ein_[a-z0-9]+$/);
    const serialized = JSON.stringify(run.output) + JSON.stringify(run.proposals);
    expect(serialized).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(serialized).not.toMatch(/\b\d{2}-\d{7}\b/);
    // Private log: hashes + verdicts only — no raw identifiers, no output text.
    const logDump = JSON.stringify(rig.log.entries);
    expect(logDump).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(logDump).not.toMatch(/\b\d{2}-\d{7}\b/);
    expect(rig.log.entries.every((e) => !('output_text' in e))).toBe(true);
  });

  it('sanitizer helpers are deterministic and non-reversible in shape', () => {
    expect(piiToken('ein', '12-3456789')).toBe(piiToken('ein', '12-3456789'));
    expect(piiToken('ein', '12-3456789')).toMatch(/^tok_ein_[0-9a-f]{8}$/);
    expect(sanitizeExtractionPii({ note: 'ssn 123-45-6789' })).toEqual({
      note: `ssn ${piiToken('ssn', '123-45-6789')}`,
    });
  });

  it('accepts fence-wrapped JSON (models sometimes add ```json) but rejects malformed output', async () => {
    const fenced = makeRig({ extraction: () => '```json\n' + w2Output() + '\n```' });
    const okRun = await runExtraction(fenced.deps, W2_DOC, 'tp-x');
    expect(okRun.status).toBe('ok');

    const garbage = makeRig({ extraction: () => 'The document appears to be a W-2 with wages of...' });
    const badRun = await runExtraction(garbage.deps, W2_DOC, 'tp-x');
    expect(badRun.status).toBe('rejected');
    expect(garbage.log.entries.every((e) => e.validation_result === 'parse_rejected')).toBe(true);
  });

  it('rejects fields outside the per-type schema', async () => {
    const extra = JSON.parse(w2Output()) as ExtractionOutput;
    extra.fields.push({
      name: 'box99_invented',
      raw_text: '1',
      normalized: { kind: 'decimal', value: '1' },
      region: { page: 1, x: 0, y: 0, w: 1, h: 1 },
      confidence: 0.99,
    });
    const rig = makeRig({ extraction: () => JSON.stringify(extra) });
    const run = await runExtraction(rig.deps, W2_DOC, 'tp-x');
    expect(run.status).toBe('rejected');
  });
});
