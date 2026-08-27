/** P8.2 — extraction of K-1 (namespaced instance concepts) and 1095-A. */
import { describe, expect, it } from 'vitest';
import {
  k1InstanceId,
  runExtraction,
  type DocImageStub,
  type ExtractionOutput,
} from '@taxfs/agents';
import { makeRig } from './helpers.js';

const K1_DOC: DocImageStub = {
  doc_id: 's-k1',
  image_ref: 'blob://s-k1.png',
  ocr_text: 'Schedule K-1 1120-S Widget Holdings Inc tok_ein_widget1 Box1 -5222 Box8a 18118 Year 2025',
  expected_tax_year: 2025,
};

function output(o: ExtractionOutput): string {
  return JSON.stringify(o);
}

const region = { page: 1, x: 10, y: 10, w: 50, h: 10 };

describe('K-1 extraction → namespaced proposals', () => {
  it('derives a deterministic instance id from the issuing entity and maps every field', async () => {
    const rig = makeRig({ extraction: () => output({
      doc_type: 'K-1',
      tax_year: 2025,
      payer: { name: 'Widget Holdings Inc', ein_token: 'tok_ein_widget1' },
      fields: [
        { name: 'box1_ordinary', raw_text: '(5,222)', normalized: { kind: 'decimal', value: '-5222' }, region, confidence: 0.97 },
        { name: 'entity_is_scorp', raw_text: '1120-S', normalized: { kind: 'decimal', value: '1' }, region, confidence: 0.99 },
        { name: 'net_lt_capital_gain', raw_text: '18,118', normalized: { kind: 'decimal', value: '18118' }, region, confidence: 0.95 },
      ],
    }) });
    const run = await runExtraction(rig.deps, K1_DOC, 'tp-x');
    if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
    const byConcept = Object.fromEntries(run.proposals.map((p) => [p.concept, p.value]));
    expect(byConcept).toEqual({
      'k1.widget-holdings-inc.box1': '-5222',
      'k1.widget-holdings-inc.is_scorp': '1',
      'k1.widget-holdings-inc.capital_gain': '18118',
    });
  });

  it('instance id falls back to the EIN token when the name yields no valid slug', () => {
    expect(k1InstanceId({ name: '***', ein_token: 'tok_ein_abc123' }, 's-k1')).toBe('tok_ein_abc123');
    expect(k1InstanceId({ name: '***', ein_token: null }, 'S-K1#2')).toBe('s-k1-2');
  });
});

describe('1095-A extraction → PTC concepts', () => {
  it('maps the annual totals to ptc.* concepts', async () => {
    const rig = makeRig({ extraction: () => output({
      doc_type: '1095-A',
      tax_year: 2025,
      payer: { name: 'Health Marketplace', ein_token: null },
      fields: [
        { name: 'annual_premiums', raw_text: '6,000.00', normalized: { kind: 'decimal', value: '6000.00' }, region, confidence: 0.98 },
        { name: 'annual_slcsp', raw_text: '5,500.00', normalized: { kind: 'decimal', value: '5500.00' }, region, confidence: 0.98 },
        { name: 'annual_aptc', raw_text: '3,000.00', normalized: { kind: 'decimal', value: '3000.00' }, region, confidence: 0.98 },
      ],
    }) });
    const run = await runExtraction(rig.deps, { ...K1_DOC, doc_id: 's-1095a' }, 'tp-x');
    if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
    expect(run.proposals.map((p) => p.concept).sort()).toEqual([
      'ptc.annual_aptc', 'ptc.annual_premium', 'ptc.annual_slcsp',
    ]);
    expect(run.proposals.every((p) => p.critical)).toBe(true);
  });
});
