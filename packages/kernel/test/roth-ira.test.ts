/**
 * P96 — Roth IRA MAGI eligibility (§408A(c)(3)) and the §408A(c)(2) room
 * rule: the Roth limit is the MAGI-phased §219 limit MINUS all Traditional
 * contributions. Ineligible amounts are excess and carry the §4973 excise —
 * even when the combined dollar limit was respected.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type FilingStatus, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p96';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(fs: FilingStatus, wages: string, extra: TaxFact[]) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: fs, il_exemption_count: 1, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, wages, ['FED', 'IL']), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: fs, il_exemption_count: 1, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P96 — §408A(c)(3) MAGI phase-out', () => {
  it('below the range → the full limit is Roth room, no excess', () => {
    const { m } = run('single', '100000', [f('r', C.CONTRIB_IRA_ROTH_TP, '7000')]);
    expect(m.get(C.FED_IRA_EXCESS)).toBeUndefined();
  });

  it('above the range → EVERY Roth dollar is excess, even under the dollar limit', () => {
    const { m, k2 } = run('single', '200000', [f('r', C.CONTRIB_IRA_ROTH_TP, '7000')]);
    expect(m.get(C.FED_IRA_EXCESS)).toBe('7000');
    expect(m.get(C.FED_IRA_EXCISE)).toBe('420');
    expect(m.get(C.FED_TOTAL_TAX_LIABILITY)).toBe(k2.total_liability);
  });

  it('mid-range: single at 157,500 → phased limit 3,500, contributed 7,000 → excess 3,500', () => {
    const { m, k2 } = run('single', '157500', [f('r', C.CONTRIB_IRA_ROTH_TP, '7000')]);
    expect(m.get(C.FED_IRA_EXCESS)).toBe('3500');
    expect(m.get(C.FED_TOTAL_TAX_LIABILITY)).toBe(k2.total_liability);
  });

  it('near the top: 164,900 → worksheet 46.67 → round up $50 → floor $200 of room', () => {
    const { m } = run('single', '164900', [f('r', C.CONTRIB_IRA_ROTH_TP, '7000')]);
    expect(m.get(C.FED_IRA_EXCESS)).toBe('6800'); // 7,000 − 200
  });

  it('MFS at any real income is effectively shut out (0–10k range)', () => {
    const { m } = run('mfs', '50000', [f('r', C.CONTRIB_IRA_ROTH_TP, '5000')]);
    expect(m.get(C.FED_IRA_EXCESS)).toBe('5000');
  });

  it('§408A(c)(2): traditional contributions consume the phased room first', () => {
    // mid-range phased limit 3,500; traditional 4,000 leaves NO Roth room.
    const { m } = run('single', '157500', [
      f('t', C.CONTRIB_IRA_TRAD_TP, '4000'),
      f('r', C.CONTRIB_IRA_ROTH_TP, '4000'),
    ]);
    expect(m.get(C.FED_IRA_EXCESS)).toBe('4000');
    // and the trail explains the room computation
  });

  it('the lineage names the range, the phased limit, and the room', () => {
    const { calcs } = run('single', '157500', [f('r', C.CONTRIB_IRA_ROTH_TP, '7000')]);
    const steps = (calcs.find((c) => c.concept === C.FED_IRA_EXCESS)?.steps ?? []).join('\n');
    expect(steps).toContain('§408A');
    expect(steps).toContain('150000–165000');
    expect(steps).toContain('phased limit 3500');
  });
});
