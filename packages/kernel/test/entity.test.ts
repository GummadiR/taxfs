/**
 * P4 — entity kernel (1120-S) against the 2022 CPA-prepared entity oracle
 * (docs/reviews/BACKTEST-2022.md addendum). The allocation law, the
 * IL-1120-ST leg, and the outbound→personal K-1 handoff are all pinned here.
 */
import { describe, expect, it } from 'vitest';
import { Money, type TaxFact } from '@taxfs/shared';
import { compute, computeEntities, type KernelInput } from '@taxfs/kernel';
import { TP, ctxOf, factsOf, loadFedRules, loadGolden, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();

function entityInput(facts: TaxFact[]): KernelInput {
  const golden = loadGolden('entity1-backtest-2022-scorp');
  return {
    taxpayer_id: TP,
    tax_year: 2025,
    ctx: ctxOf(golden, fed, il),
    facts,
    fed_rules: fed,
    il_rules: il,
  };
}

const golden = loadGolden('entity1-backtest-2022-scorp');
const result = computeEntities(entityInput(factsOf(golden)));
const byConcept = new Map(result.computedFacts.map((f) => [f.concept, f]));

describe('entity kernel — 2022 1120-S back-test oracle', () => {
  it('matches every oracle-pinned line', () => {
    const actual: Record<string, string> = {};
    for (const concept of Object.keys(golden.expected)) {
      actual[concept] = byConcept.get(concept)?.value.toString() ?? '<missing>';
    }
    expect(actual).toEqual(golden.expected);
  });

  it('emits whole-dollar lines only', () => {
    for (const f of result.computedFacts) {
      expect(f.value.isWholeDollars(), `${f.concept} = ${f.value.toString()}`).toBe(true);
    }
  });

  it('per-member allocations sum exactly to the entity lines', () => {
    const box1Sum = Money.sum([
      byConcept.get('k1.sco-ma.box1')!.value,
      byConcept.get('k1.sco-mb.box1')!.value,
    ]);
    expect(box1Sum.toString()).toBe(byConcept.get('entity.sco.ordinary_income')!.value.toString());
    const cgSum = Money.sum([
      byConcept.get('k1.sco-ma.capital_gain')!.value,
      byConcept.get('k1.sco-mb.capital_gain')!.value,
    ]);
    expect(cgSum.toString()).toBe('36237');
  });

  it('every derived fact carries a calculation trail', () => {
    const calcIds = new Set(result.calculations.map((c) => c.calc_id));
    for (const f of result.computedFacts) {
      expect(f.derivation !== undefined && calcIds.has(f.derivation), f.concept).toBe(true);
    }
  });
});

describe('entity kernel — 1065 partnership (P4.4)', () => {
  const pGolden = loadGolden('entity2-partnership-1065');
  const pResult = computeEntities(entityInput(factsOf(pGolden)));
  const pBy = new Map(pResult.computedFacts.map((f) => [f.concept, f]));

  it('matches every hand-verified line', () => {
    const actual: Record<string, string> = {};
    for (const concept of Object.keys(pGolden.expected)) {
      actual[concept] = pBy.get(concept)?.value.toString() ?? '<missing>';
    }
    expect(actual).toEqual(pGolden.expected);
  });

  it('GP is deducted on page 1 AND separately stated (never double-counted)', () => {
    // ordinary 38,000 already nets the 30,000 GP; k_total adds it back once.
    expect(pBy.get('entity.pt.k_total')!.value.toString()).toBe('78001');
    // m2 has no GP → no fact emitted for it.
    expect(pBy.get('k1.pt-m2.guaranteed_payment')).toBeUndefined();
  });

  it('the m1 partner K-1 flows through the personal run: GP outside limits, excluded from QBI', () => {
    const outbound = pResult.computedFacts
      .filter((f) => f.concept.startsWith('k1.pt-m1.'))
      .map((f) => ({ ...f, derivation: undefined }));
    const supplemental: TaxFact[] = [
      { concept: 'k1.pt-m1.material_participation', value: '1' },
      { concept: 'k1.pt-m1.basis_opening', value: '0' },
    ].map((row, i) => ({
      fact_id: `f:pgp:${i}`,
      taxpayer_id: TP,
      concept: row.concept,
      tax_year: 2025,
      jurisdiction: ['FED'] as const,
      taxpayer_scope: 'primary' as const,
      value: Money.fromString(row.value),
      unit: 'USD' as const,
      status: 'confirmed' as const,
      confidence: 0.99,
      provenance: [{ source_id: `s:pgp:${i}`, source_field: 'value' }],
    }));
    const personal = compute(entityInput([...outbound, ...supplemental]));
    const personalBy = new Map(personal.computedFacts.map((f) => [f.concept, f]));
    // allowed_net = box1 22,800 + GP 30,000 (no losses to limit)
    expect(personalBy.get('k1.pt-m1.allowed_net')?.value.toString()).toBe('52800');
    expect(personalBy.get('fed.sche.k1_total')?.value.toString()).toBe('52800');
    // capital gain share lands on Sch D
    expect(personalBy.get('fed.schd.lt_net')?.value.toString()).toBe('6001');
    // QBI excludes the GP (§199A(c)(4)(B)): 20% × 22,800 = 4,560
    // (income limit: taxable-before-QBI 28,801 − NCG 6,001 = 22,800 → same)
    expect(personalBy.get('fed.qbi.deduction')?.value.toString()).toBe('4560');
  });
});

describe('entity kernel — guards', () => {
  const baseRows = factsOf(golden);

  it('rejects member shares that do not sum to exactly 1', () => {
    const facts = baseRows.map((f) =>
      f.concept === 'entity.sco.member.ma.share' ? { ...f, value: Money.fromString('0.4') } : f,
    );
    expect(() => computeEntities(entityInput(facts))).toThrow(/shares sum to 0.9/);
  });

  it('rejects an entity with no member shares', () => {
    const facts = baseRows.filter((f) => !f.concept.includes('.member.'));
    expect(() => computeEntities(entityInput(facts))).toThrow(/no member/);
  });

  it('rejects guaranteed_payment facts on an S-corp (1065-only concept)', () => {
    const extra = { ...baseRows[0]!, fact_id: 'f:bad:gp', concept: 'entity.sco.member.mb.guaranteed_payment', value: Money.fromString('1000') };
    expect(() => computeEntities(entityInput([...baseRows, extra]))).toThrow(/1065-only/);
  });

  it('rejects entity-level liabilities on an S-corp (§752 is partnership-only)', () => {
    const extra = { ...baseRows[0]!, fact_id: 'f:bad:liab', concept: 'entity.sco.liabilities_ending', value: Money.fromString('5000') };
    expect(() => computeEntities(entityInput([...baseRows, extra]))).toThrow(/752/);
  });
});

describe('outbound → personal handoff (one mechanism, two directions)', () => {
  // The orchestrator re-sources the entity run's outbound k1.* facts into
  // the personal run. Feeding the taxpayer-member K-1 plus the personal
  // limitation facts reproduces the 2022 personal-side oracle exactly:
  // basis absorbs the 5,222 loss, the 18,118 gain is passive income on
  // 8582, prior unallowed 14,039 joins the pool, suspended 1,143.
  it('the taxpayer member K-1 flows through the personal loss limits to the oracle numbers', () => {
    const outbound = result.computedFacts
      .filter((f) => f.concept.startsWith('k1.sco-mb.'))
      .map((f) => ({ ...f, derivation: undefined }));
    const supplemental: TaxFact[] = [
      { concept: 'k1.sco-mb.material_participation', value: '0' },
      { concept: 'k1.sco-mb.basis_opening', value: '94350' },
      { concept: 'k1.sco-mb.passive_carryover', value: '14039' },
      { concept: 'k1.sco-mb.qbi_eligible', value: '0' },
    ].map((row, i) => ({
      fact_id: `f:pers:${i}`,
      taxpayer_id: TP,
      concept: row.concept,
      tax_year: 2025,
      jurisdiction: ['FED'] as const,
      taxpayer_scope: 'primary' as const,
      value: Money.fromString(row.value),
      unit: 'USD' as const,
      status: 'confirmed' as const,
      confidence: 0.99,
      provenance: [{ source_id: `s:pers:${i}`, source_field: 'value' }],
    }));
    const personal = compute(entityInput([...outbound, ...supplemental]));
    const personalBy = new Map(personal.computedFacts.map((f) => [f.concept, f]));
    expect(personalBy.get('fed.schd.lt_net')?.value.toString()).toBe('18118');
    expect(personalBy.get('k1.sco-mb.allowed_net')?.value.toString()).toBe('-18118');
    expect(personalBy.get('k1.sco-mb.passive_suspended.out')?.value.toString()).toBe('1143');
    expect(personalBy.get('fed.sche.k1_total')?.value.toString()).toBe('-18118');
  });
});
