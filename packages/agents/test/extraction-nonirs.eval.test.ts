/** P18 — non-IRS documents that still carry a return amount: county
 *  property-tax bills (Schedule ICR), donation receipts (Schedule A), and
 *  India Form 15CA/15CB foreign-remittance certificates (Form 1116). The
 *  15CA/CB path pins the currency rule: the TDS lands in the FOREIGN
 *  currency concept and is NEVER converted at extraction time. */
import { describe, expect, it } from 'vitest';
import { runExtraction, type DocImageStub, type ExtractionOutput } from '@taxfs/agents';
import { makeRig } from './helpers.js';

const region = { page: 1, x: 10, y: 10, w: 50, h: 10 };
const output = (o: ExtractionOutput): string => JSON.stringify(o);
const doc = (id: string): DocImageStub => ({
  doc_id: id,
  image_ref: `blob://${id}.pdf`,
  ocr_text: `document ${id}`,
  expected_tax_year: 2025,
});

describe('PROPERTY-TAX-BILL → Schedule ICR concept', () => {
  it('maps the paid total to il.property_tax.residence', async () => {
    const rig = makeRig({ extraction: () => output({
      doc_type: 'PROPERTY-TAX-BILL',
      tax_year: 2025,
      payer: { name: 'DuPage County Collector', ein_token: null },
      fields: [
        { name: 'property_tax_paid', raw_text: '$17,143.00', normalized: { kind: 'decimal', value: '17143.00' }, region, confidence: 0.97 },
      ],
    }) });
    const run = await runExtraction(rig.deps, doc('s-proptax'), 'tp-x');
    if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
    expect(run.proposals.map((p) => [p.concept, p.value])).toEqual([
      ['il.property_tax.residence', '17143.00'],
    ]);
  });
});

describe('DONATION-RECEIPT → Schedule A charitable COMPONENT (P72)', () => {
  it('maps the deductible total to the charitable component, not the hand-computed total', async () => {
    const rig = makeRig({ extraction: () => output({
      doc_type: 'DONATION-RECEIPT',
      tax_year: 2025,
      payer: { name: 'Sri Venkateswara Swami Temple', ein_token: 'tok_ein_temple1' },
      fields: [
        { name: 'charitable_contribution', raw_text: '5,116.00', normalized: { kind: 'decimal', value: '5116.00' }, region, confidence: 0.96 },
      ],
    }) });
    const run = await runExtraction(rig.deps, doc('s-donation'), 'tp-x');
    if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
    // P72 — this used to propose deduction.itemized.total, the HAND-COMPUTED
    // Schedule A total. Harmless while a donation receipt was the only
    // Schedule A input; after P67 added real components it meant uploading a
    // donation receipt AND a Form 1098 hit the mutually-exclusive guard and
    // refused to compute the entire return. A receipt is a COMPONENT.
    expect(run.proposals.map((p) => [p.concept, p.value])).toEqual([
      ['deduction.sch_a.charitable', '5116.00'],
    ]);
  });
});

describe('FOREIGN-REMITTANCE (15CA/15CB) → foreign-currency TDS concept', () => {
  it('proposes the TDS and the CA-computed taxable gain (both FCY); the remittance amount and the date propose NOTHING', async () => {
    const rig = makeRig({ extraction: () => output({
      doc_type: 'FOREIGN-REMITTANCE',
      tax_year: 2025,
      payer: { name: 'Chartered Accountant — Form 15CB', ein_token: null },
      fields: [
        { name: 'remittance_amount_foreign', raw_text: '₹ 1,00,00,000', normalized: { kind: 'decimal', value: '10000000' }, region, confidence: 0.95 },
        { name: 'foreign_tax_withheld_foreign', raw_text: '₹ 8,35,000 TDS', normalized: { kind: 'decimal', value: '835000' }, region, confidence: 0.95 },
        // P32 — the 15CB's 'amount of income chargeable to tax' (the CA's
        // taxable-gain computation) proposes into the FCY income concept.
        { name: 'taxable_income_foreign', raw_text: '₹ 41,75,000', normalized: { kind: 'decimal', value: '4175000' }, region, confidence: 0.94 },
        // The certificate's date persists as a source FIELD (it drives the
        // exchange-rate lookup) — dates never become Money facts.
        { name: 'remittance_date', raw_text: '03/03/2025', normalized: { kind: 'date', value: '2025-03-03' }, region, confidence: 0.97 },
        { name: 'currency_code', raw_text: 'INR', normalized: { kind: 'string', value: 'INR' }, region, confidence: 0.99 },
      ],
    }) });
    const run = await runExtraction(rig.deps, doc('s-15cb'), 'tp-x');
    if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
    // TDS + CA-computed gain propose (unconverted; the user confirms each);
    // the remittance amount (proceeds, not gain) and the date do not.
    expect(run.proposals.map((p) => [p.concept, p.value])).toEqual([
      ['foreign.tax_paid.foreign_currency', '835000'],
      ['foreign.income.passive.foreign_currency', '4175000'],
    ]);
  });
});
