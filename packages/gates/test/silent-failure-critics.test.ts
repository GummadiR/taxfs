/**
 * P66 — the three silences that let a real 2025 return be wrong by thousands
 * with nothing on the gates board. Each test pins the SHAPE that fires and,
 * just as importantly, the shape that must NOT (a critic that cries wolf on a
 * correct return is worse than no critic).
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { createStep1Critics } from '../src/index.js';
import { buildCtx, fedRules, ilRules } from './helpers.js';
import { TP, ctxOf, factsOf, loadGolden } from '../../kernel/test/helpers.js';

const ex = (id: string, concept: string, v: string): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: ['FED'], taxpayer_scope: 'primary',
  value: Money.fromString(v), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function findings(criticId: string, extra: TaxFact[]) {
  const g = loadGolden('return3-mfj-multidoc');
  const sourced = [...factsOf(g), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fedRules, ilRules), facts: sourced, fed_rules: fedRules, il_rules: ilRules });
  const base = buildCtx('return3-mfj-multidoc');
  const ctx = { ...base, facts: [...sourced, ...r.computedFacts] };
  const critic = createStep1Critics().find((c) => c.id === criticId)!;
  if (!critic.applies_when(ctx as never)) return [];
  return critic.evaluate(ctx as never);
}

describe('ACC-FOREIGN-LTCG-UNDECLARED (A1)', () => {
  // ₹ amounts + one rate, the 15CA/15CB shape.
  const foreign = [
    ex('fi', C.FOREIGN_INCOME_FCY, '9390000'),
    ex('ft', C.FOREIGN_TAX_FCY, '1358500'),
    ex('fx', C.FOREIGN_FX_RATE, '87.05'),
  ];

  it('flags foreign income entered with no long-term portion', () => {
    const f = findings('ACC-FOREIGN-LTCG-UNDECLARED', foreign);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('Flag');
    expect(f[0]!.message).toContain('ORDINARY rates');
    // It must also warn that the foreign certificate's figure is not the US gain.
    expect(f[0]!.message).toContain('chargeable to tax');
  });

  it('goes quiet once the long-term portion is declared', () => {
    expect(findings('ACC-FOREIGN-LTCG-UNDECLARED', [...foreign, ex('lt', C.FOREIGN_LTCG_FCY, '9390000')])).toEqual([]);
  });

  it('never fires on a return with no foreign income at all', () => {
    expect(findings('ACC-FOREIGN-LTCG-UNDECLARED', [])).toEqual([]);
  });
});

describe('ACC-CAPLOSS-CARRYOVER-MISSING (A2)', () => {
  const gain = [ex('cg', C.CAPITAL_GAIN_NET, '90000')];

  it('flags a net capital gain with no prior-year carryover entered', () => {
    const f = findings('ACC-CAPLOSS-CARRYOVER-MISSING', gain);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('Flag');
    expect(f[0]!.message).toContain('do not arrive on any document');
  });

  it('goes quiet when either carryover is present', () => {
    expect(findings('ACC-CAPLOSS-CARRYOVER-MISSING', [...gain, ex('st', C.CAPLOSS_CO_ST_PRIOR, '4586')])).toEqual([]);
    expect(findings('ACC-CAPLOSS-CARRYOVER-MISSING', [...gain, ex('lt', C.CAPLOSS_CO_LT_PRIOR, '37824')])).toEqual([]);
  });
});

describe('ACC-NO-PREFERENTIAL-RATE (A3)', () => {
  it('flags a large net gain where nothing qualifies for the LTCG rate', () => {
    // Foreign income with no LT split lands entirely in Part I (ordinary), and
    // a long-term carryover cancels the only long-term gains — exactly the real
    // return's shape: big Schedule D total, zero preferential income.
    const f = findings('ACC-NO-PREFERENTIAL-RATE', [
      ex('fi', C.FOREIGN_INCOME_FCY, '9390000'),
      ex('ft', C.FOREIGN_TAX_FCY, '1358500'),
      ex('fx', C.FOREIGN_FX_RATE, '87.05'),
      ex('cg', C.CAPITAL_GAIN_NET, '25468'),
      ex('lt', C.CAPLOSS_CO_LT_PRIOR, '37824'),
    ]);
    expect(f).toHaveLength(1);
    expect(f[0]!.severity).toBe('Flag');
    expect(f[0]!.message).toContain('NOTHING qualifies');
  });

  it('stays silent on an ordinary long-term gain that IS taxed preferentially', () => {
    expect(findings('ACC-NO-PREFERENTIAL-RATE', [ex('cg', C.CAPITAL_GAIN_NET, '90000')])).toEqual([]);
  });
});
