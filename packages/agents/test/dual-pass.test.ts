/**
 * Subject: dual-pass extraction (§6). Two independent passes must agree on
 * every CRITICAL field or it arrives FLAGGED — no value, no suggestion,
 * both readings recorded. Non-critical fields keep pass 1.
 */
import { describe, expect, it } from 'vitest';
import { runExtractionDualPass } from '../src/dual-pass';
import { makeRig } from './helpers';

const DOC = { doc_id: 's-w2', image_ref: 'blob://s-w2', ocr_text: 'document image stub W-2', expected_tax_year: 2025 };

const w2Json = (wages: string) =>
  JSON.stringify({
    doc_type: 'W-2',
    tax_year: 2025,
    payer: { name: 'Synthetic Employer', ein_token: 'tok_ein_1' },
    fields: [
      { name: 'box1_wages', raw_text: wages, normalized: { kind: 'decimal', value: wages },
        region: { page: 1, x: 10, y: 20, w: 80, h: 12 }, confidence: 0.99 },
      { name: 'box2_fed_withholding', raw_text: '4000', normalized: { kind: 'decimal', value: '4000' },
        region: { page: 1, x: 10, y: 40, w: 80, h: 12 }, confidence: 0.99 },
      { name: 'box12w_hsa', raw_text: '1000', normalized: { kind: 'decimal', value: '1000' },
        region: { page: 1, x: 10, y: 60, w: 80, h: 12 }, confidence: 0.99 },
    ],
  });

describe('dual-pass extraction', () => {
  it('agreeing passes arrive exactly like a single pass, regions intact', async () => {
    const rig = makeRig({ extraction: () => w2Json('50000') });
    const { run, disagreements } = await runExtractionDualPass(rig.deps, DOC, 'tp');
    expect(disagreements).toEqual([]);
    if (run.status !== 'ok') throw new Error('expected ok');
    const wages = run.proposals.find((p) => p.source_field === 'box1_wages')!;
    expect(wages.value).toBe('50000');
    expect(wages.region).toEqual({ page: 1, x: 10, y: 20, w: 80, h: 12 }); // §6 region plumbing
    expect(rig.stub.calls.length).toBe(2); // genuinely two passes
  });

  it('a critical-field disagreement arrives flagged — no value, no suggestion, both readings', async () => {
    const rig = makeRig({ extraction: (_req, n) => w2Json(n === 0 ? '50000' : '5000') });
    const { run, disagreements } = await runExtractionDualPass(rig.deps, DOC, 'tp');
    if (run.status !== 'ok') throw new Error('expected ok');
    expect(disagreements).toEqual([
      { source_field: 'box1_wages', concept: 'income.wages', pass1: '50000', pass2: '5000' },
    ]);
    const wages = run.proposals.find((p) => p.source_field === 'box1_wages')!;
    expect(wages.value).toBeNull();
    expect(wages.suggestion).toBeNull();
    expect(wages.disagreement).toEqual({ pass1: '50000', pass2: '5000' });
    // The agreeing critical field is untouched…
    const wh = run.proposals.find((p) => p.source_field === 'box2_fed_withholding')!;
    expect(wh.value).toBe('4000');
    // …and a non-critical field never triggers the dual-pass wall.
    const hsa = run.proposals.find((p) => p.source_field === 'box12w_hsa')!;
    expect(hsa.critical).toBe(false);
  });

  it('a non-critical disagreement keeps pass 1 (dual-pass targets the critical tier)', async () => {
    const rig = makeRig({
      extraction: (_req, n) => {
        const j = JSON.parse(w2Json('50000')) as { fields: { name: string; raw_text: string; normalized: { value: string } }[] };
        if (n === 1) {
          const hsa = j.fields.find((f) => f.name === 'box12w_hsa')!;
          hsa.raw_text = '999';
          hsa.normalized.value = '999';
        }
        return JSON.stringify(j);
      },
    });
    const { run, disagreements } = await runExtractionDualPass(rig.deps, DOC, 'tp');
    if (run.status !== 'ok') throw new Error('expected ok');
    expect(disagreements).toEqual([]);
    expect(run.proposals.find((p) => p.source_field === 'box12w_hsa')!.value).toBe('1000');
  });
});
