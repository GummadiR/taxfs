/**
 * P68 — what a foreign certificate can and cannot settle.
 *
 * The 15CB states "Nature of remittance: Long Term Capital Gains" in plain
 * text, but the reader had no field for it — so the long-term portion could
 * never be populated from the document and the kernel taxed the whole gain at
 * ordinary rates. Two things the certificate still cannot settle, now said on
 * the record: the US GAIN (India indexes cost, the US does not) and the US
 * HOLDING PERIOD (§1222(3)), which governs the term regardless of the label.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p68';
const f = (id: string, concept: string, value: string): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: ['FED'], taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[]) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [
    { ...f('w2', C.WAGES, '228946'), jurisdiction: ['FED', 'IL'] as ('FED' | 'IL')[] },
    f('fwh', C.FED_WITHHOLDING, '32282'),
    ...extra,
  ];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  return { m, calcs: r.calculations };
}

// The live 15CA/15CB shape: ₹9,390,000 chargeable, ₹1,358,500 TDS, 87.05/USD.
const base = [
  f('fi', C.FOREIGN_INCOME_FCY, '9390000'),
  f('ft', C.FOREIGN_TAX_FCY, '1358500'),
  f('fx', C.FOREIGN_FX_RATE, '87.05'),
];

const fxTrail = (calcs: { steps: string[] }[]): string =>
  calcs.flatMap((c) => c.steps).join(' | ');

describe('P68 — the certificate figure is not the US gain', () => {
  it('warns on the record that foreign chargeable income is computed under foreign law', () => {
    const t = fxTrail(run(base).calcs);
    expect(t).toContain('THE US GAIN IS NOT THE CERTIFICATE FIGURE');
    expect(t).toContain('no indexation');
  });

  it('records the single-exchange-rate simplification', () => {
    expect(fxTrail(run(base).calcs)).toContain('SALE-date spot rate');
  });
});

describe('P68 — the long-term split changes the rate, and the trail says so', () => {
  it('with NO long-term portion, everything lands in Part I at ordinary rates', () => {
    const { m, calcs } = run(base);
    // 9,390,000 / 87.05 = 107,869, all short-term.
    expect(m.get(C.FED_SCHD_ST_NET)).toBe('107869');
    expect(m.get(C.FED_SCHD_NCG)).toBe('0'); // nothing preferential
    expect(fxTrail(calcs)).toContain('ALL of this is taxed at ordinary rates');
  });

  it('with the long-term portion declared, it lands in Part II and is taxed preferentially', () => {
    const { m, calcs } = run([...base, f('lt', C.FOREIGN_LTCG_FCY, '9390000')]);
    expect(m.get(C.FED_SCHD_LT_NET)).toBe('107869');
    expect(m.get(C.FED_SCHD_NCG)).toBe('107869');
    expect(fxTrail(calcs)).toContain('§1222(3)');
  });

  it('the same facts produce a LOWER tax once the term is right', () => {
    const ordinary = run(base).m.get(C.FED_TAX)!;
    const preferential = run([...base, f('lt', C.FOREIGN_LTCG_FCY, '9390000')]).m.get(C.FED_TAX)!;
    expect(Money.fromString(preferential).lt(Money.fromString(ordinary))).toBe(true);
  });
});
