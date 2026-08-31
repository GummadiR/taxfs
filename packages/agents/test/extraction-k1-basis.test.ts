/**
 * A 1065 K-1 PRINTS the basis; stop asking for it.
 *
 * §704(d) caps a partner's deductible loss at outside basis, and with no
 * basis on file the kernel assumes zero and suspends the whole loss. On a
 * real return that hid $27,777 behind a $0. The operator's objection was
 * exactly right: "I uploaded all K1... it should read from K1 all data."
 *
 * And for a partnership it can. Item L carries the tax-basis capital
 * account and Item K the share of liabilities; outside basis is the two
 * together (§722, §752). Item G settles passivity as a matter of law for a
 * limited partner (§469(h)(2)).
 *
 * What it must NOT do is invent basis where the form states none — an
 * 1120-S K-1 reports no basis at all, which is why Form 7203 exists.
 */
import { describe, expect, it } from 'vitest';
import { runExtraction, type DocImageStub, type ExtractionOutput } from '@taxfs/agents';
import { makeRig } from './helpers.js';

const region = { page: 1, x: 10, y: 10, w: 50, h: 10 };
const output = (o: ExtractionOutput): string => JSON.stringify(o);
const doc = (id: string): DocImageStub => ({
  doc_id: id, image_ref: `blob://${id}.pdf`, ocr_text: `document ${id}`, expected_tax_year: 2025,
});
const num = (name: string, value: string, confidence = 0.96) =>
  ({ name, raw_text: value, normalized: { kind: 'decimal' as const, value }, region, confidence });

const k1 = (fields: ReturnType<typeof num>[]): ExtractionOutput => ({
  doc_type: 'K-1', tax_year: 2025,
  payer: { name: 'Example Investments LLC', ein_token: 'tok_ein_example1' },
  fields,
});

/** concept suffix → proposed value, for the K-1 instance in the run. */
async function proposalsFor(id: string, out: ExtractionOutput) {
  const run = await runExtraction(makeRig({ extraction: () => output(out) }).deps, doc(id), 'tp-x');
  if (run.status !== 'ok') throw new Error(`expected ok, got ${run.status}`);
  return new Map(run.proposals.map((p) => [p.concept.replace(/^k1\.[^.]+\./, ''), p.value]));
}

describe('a partnership K-1 supplies its own basis', () => {
  it('adds Item L capital to the Item K liability share (§722, §752)', async () => {
    const got = await proposalsFor('s-k1-p', k1([
      num('box1_ordinary', '-2430'),
      num('entity_is_scorp', '0'),
      num('item_l_beginning_capital', '18000'),
      num('item_k_liabilities_beginning', '7000'),
      num('item_k_liabilities_ending', '9500'),
    ]));
    // Item L capital 18,000 + Item K beginning liabilities 7,000.
    expect(got.get('basis_opening')).toBe('25000');
    // §752 change during the year: 9,500 − 7,000.
    expect(got.get('liab_change')).toBe('2500');
  });

  it('falls back to capital alone when Item K is absent — understating basis is the safe direction', async () => {
    const got = await proposalsFor('s-k1-nok', k1([
      num('box1_ordinary', '-2430'),
      num('entity_is_scorp', '0'),
      num('item_l_beginning_capital', '18000'),
    ]));
    expect(got.get('basis_opening')).toBe('18000');
    expect(got.has('liab_change')).toBe(false);
  });

  it('takes withdrawals as a magnitude whichever sign the form printed', async () => {
    // Item L prints distributions in parentheses; the kernel SUBTRACTS them.
    const neg = await proposalsFor('s-k1-neg', k1([
      num('box1_ordinary', '-2430'), num('entity_is_scorp', '0'), num('item_l_withdrawals', '-4000'),
    ]));
    expect(neg.get('distributions')).toBe('4000');
    const pos = await proposalsFor('s-k1-pos', k1([
      num('box1_ordinary', '-2430'), num('entity_is_scorp', '0'), num('item_l_withdrawals', '4000'),
    ]));
    expect(pos.get('distributions')).toBe('4000');
  });

  it('reads a limited partner as passive — §469(h)(2) is law, not a guess', async () => {
    const got = await proposalsFor('s-k1-ltd', k1([
      num('box1_ordinary', '-2430'), num('entity_is_scorp', '0'), num('item_g_limited_partner', '1'),
    ]));
    expect(got.get('material_participation')).toBe('0');
  });

  it('NEGATIVE: never infers participation for a GENERAL partner — that is an hours test', async () => {
    const got = await proposalsFor('s-k1-gen', k1([
      num('box1_ordinary', '-2430'), num('entity_is_scorp', '0'), num('item_g_limited_partner', '0'),
    ]));
    expect(got.has('material_participation')).toBe(false);
  });

  it('NEGATIVE: derives NOTHING for an 1120-S K-1, which states no basis at all', async () => {
    // Even if a reader hallucinated partner-level fields onto an S-corp K-1,
    // they must not become a basis proposal — Form 7203 territory.
    const got = await proposalsFor('s-k1-s', k1([
      num('box1_ordinary', '-16997'),
      num('entity_is_scorp', '1'),
      num('item_l_beginning_capital', '95981'),
      num('item_k_liabilities_beginning', '7000'),
    ]));
    expect(got.has('basis_opening')).toBe(false);
    expect(got.has('liab_change')).toBe(false);
    expect(got.get('box1')).toBe('-16997');
  });

  it('carries box 2 rental as its own Schedule E stream', async () => {
    const got = await proposalsFor('s-k1-r', k1([
      num('box1_ordinary', '-2430'), num('entity_is_scorp', '0'), num('box2_rental', '-1166'),
    ]));
    expect(got.get('box2')).toBe('-1166');
  });
});
