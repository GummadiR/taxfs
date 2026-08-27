/** P14.9 — CONSOLIDATED-1099: a combined brokerage statement (1099-DIV +
 *  1099-INT + 1099-B sections in one PDF) extracts its SUMMARY totals into
 *  the same concepts the standalone forms feed — the exact document shape
 *  that previously produced zero facts and failed Gate 2 as a completeness
 *  gap. */
import { describe, expect, it } from 'vitest';
import { runExtraction, type DocImageStub, type ExtractionOutput } from '@taxfs/agents';
import { makeRig } from './helpers.js';

const DOC: DocImageStub = {
  doc_id: 's-consolidated',
  image_ref: 'blob://s-consolidated.pdf',
  ocr_text: 'Consolidated Form 1099 Broker Example Clearing tok_ein_broker1 2025 INT 412.55 DIV 1a 2129 1b 1080 B LT 5210 ST -300 WH 605',
  expected_tax_year: 2025,
};

const region = { page: 1, x: 10, y: 10, w: 50, h: 10 };

function output(o: ExtractionOutput): string {
  return JSON.stringify(o);
}

describe('CONSOLIDATED-1099 extraction → summary-total proposals', () => {
  it('maps every section total to its concept (ST and LT both feed the net capital-gain concept)', async () => {
    const rig = makeRig({ extraction: () => output({
      doc_type: 'CONSOLIDATED-1099',
      tax_year: 2025,
      payer: { name: 'Example Clearing', ein_token: 'tok_ein_broker1' },
      fields: [
        { name: 'total_interest', raw_text: '412.55', normalized: { kind: 'decimal', value: '412.55' }, region, confidence: 0.97 },
        { name: 'total_ordinary_dividends', raw_text: '2,129.00', normalized: { kind: 'decimal', value: '2129.00' }, region, confidence: 0.97 },
        { name: 'total_qualified_dividends', raw_text: '1,080.00', normalized: { kind: 'decimal', value: '1080.00' }, region, confidence: 0.96 },
        { name: 'total_lt_gain', raw_text: '5,210.00', normalized: { kind: 'decimal', value: '5210.00' }, region, confidence: 0.95 },
        { name: 'total_st_gain', raw_text: '(300.00)', normalized: { kind: 'decimal', value: '-300.00' }, region, confidence: 0.95 },
        // P31 — 1099-DIV box 2a: capital gain DISTRIBUTIONS (fund payouts),
        // long-term by statute, separate from the 1099-B trading totals.
        { name: 'total_capgain_distributions', raw_text: '723.00', normalized: { kind: 'decimal', value: '723.00' }, region, confidence: 0.95 },
        { name: 'total_fed_withholding', raw_text: '605.00', normalized: { kind: 'decimal', value: '605.00' }, region, confidence: 0.98 },
      ],
    }) });
    const run = await runExtraction(rig.deps, DOC, 'tp-x');
    if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
    const pairs = run.proposals.map((p) => [p.concept, p.value] as const).sort();
    expect(pairs).toEqual([
      ['income.capital_gain.net', '-300.00'],
      ['income.capital_gain.net', '5210.00'],
      ['income.capital_gain.net', '723.00'],
      ['income.dividends.ordinary', '2129.00'],
      ['income.dividends.qualified', '1080.00'],
      ['income.interest', '412.55'],
      ['payments.fed.withholding', '605.00'],
    ].sort());
    expect(run.proposals.every((p) => p.critical)).toBe(true);
    expect(run.flags.wrong_year).toBe(false);
  });

  it('P71 — reads 1099-DIV boxes 12, 7 and 5, which had to be hand-entered before', async () => {
    // The live statement that exposed this: box 12 exempt-interest dividends
    // 2,923.63 (federally exempt but ILLINOIS TAXES IT — missing the box
    // understates the state return), box 7 foreign tax 61.87, box 5 §199A
    // dividends 138.49. All three are printed on a document TaxOS already had
    // open, so asking the filer to retype them was the wrong answer.
    const rig = makeRig({ extraction: () => output({
      doc_type: 'CONSOLIDATED-1099',
      tax_year: 2025,
      payer: { name: 'Example Clearing', ein_token: 'tok_ein_broker1' },
      fields: [
        { name: 'total_ordinary_dividends', raw_text: '3,278.97', normalized: { kind: 'decimal', value: '3278.97' }, region, confidence: 0.97 },
        { name: 'total_exempt_interest_dividends', raw_text: '2,923.63', normalized: { kind: 'decimal', value: '2923.63' }, region, confidence: 0.96 },
        { name: 'total_foreign_tax_paid', raw_text: '61.87', normalized: { kind: 'decimal', value: '61.87' }, region, confidence: 0.96 },
        { name: 'total_sec199a_dividends', raw_text: '138.49', normalized: { kind: 'decimal', value: '138.49' }, region, confidence: 0.96 },
      ],
    }) });
    const run = await runExtraction(rig.deps, DOC, 'tp-x');
    if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
    const byConcept = new Map(run.proposals.map((p) => [p.concept, p]));
    expect(byConcept.get('income.tax_exempt_interest')?.value).toBe('2923.63');
    expect(byConcept.get('foreign.tax_paid')?.value).toBe('61.87');
    expect(byConcept.get('income.reit_ptp.qualified')?.value).toBe('138.49');
    // Exempt-interest dividends must carry IL, or the add-back never happens.
    expect(byConcept.get('income.tax_exempt_interest')?.jurisdiction).toContain('IL');
    // Box 7 is a USD amount on a US form — never the foreign-currency concept.
    expect(byConcept.has('foreign.tax_paid.foreign_currency')).toBe(false);
  });

  it('a wrong-year consolidated statement flags, never silently accepts', async () => {
    const rig = makeRig({ extraction: () => output({
      doc_type: 'CONSOLIDATED-1099',
      tax_year: 2024,
      payer: { name: 'Example Clearing', ein_token: null },
      fields: [
        { name: 'total_interest', raw_text: '412.55', normalized: { kind: 'decimal', value: '412.55' }, region, confidence: 0.97 },
      ],
    }) });
    const run = await runExtraction(rig.deps, DOC, 'tp-x');
    if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
    expect(run.flags.wrong_year).toBe(true);
  });
});
