/**
 * P57 — §904(j) de minimis foreign tax credit election.
 *
 * Found reconciling a real 2023 return: Schedule 3 line 1 carried a $50
 * foreign tax credit "claimed without filing Form 1116". TaxOS had only the
 * Form 1116 path, and that path THROWS when foreign tax arrives with no
 * separately-stated foreign-source income — which is exactly the shape of
 * foreign tax withheld inside a 1099-DIV. The credit was unreachable.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p57';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED', 'IL']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[], fs: FilingContext['filing_status'] = 'mfj') {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: fs, il_exemption_count: 2, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [
    f('w2', C.WAGES, '150000'),
    f('fwh', C.FED_WITHHOLDING, '20000', ['FED']),
    f('iwh', C.IL_WITHHOLDING, '7000', ['IL']),
    ...extra,
  ];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: fs, il_exemption_count: 2, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P57 — §904(j) election', () => {
  it('credits the full foreign tax with no foreign-source income supplied', () => {
    const { m, calcs } = run([
      f('ftax', C.FOREIGN_TAX_PAID, '50', ['FED']),
      f('elect', C.FTC_DEMINIMIS_ELECTION, '1', ['FED']),
    ]);
    expect(m.get(C.FED_FTC)).toBe('50');
    // No §904 limitation was applied, so no excess exists to carry.
    expect(m.has(C.FED_FTC_UNUSED)).toBe(false);
    const c = calcs.find((x) => x.formula_ref === 'FED.SEC904J.ELECTION');
    expect(c).toBeDefined();
    expect(c?.steps.join(' ')).toContain('no Form 1116 is filed');
  });

  it('kernel2 mirrors the elected credit', () => {
    const { m, k2 } = run([
      f('ftax', C.FOREIGN_TAX_PAID, '50', ['FED']),
      f('elect', C.FTC_DEMINIMIS_ELECTION, '1', ['FED']),
    ]);
    expect(k2.fed_refund_or_due).toBe(m.get(C.FED_REFUND_OR_DUE));
  });

  it('allows exactly the $600 joint ceiling', () => {
    const { m } = run([
      f('ftax', C.FOREIGN_TAX_PAID, '600', ['FED']),
      f('elect', C.FTC_DEMINIMIS_ELECTION, '1', ['FED']),
    ]);
    expect(m.get(C.FED_FTC)).toBe('600');
  });

  it('refuses over the ceiling rather than capping or silently filing 1116', () => {
    expect(() => run([
      f('ftax', C.FOREIGN_TAX_PAID, '601', ['FED']),
      f('elect', C.FTC_DEMINIMIS_ELECTION, '1', ['FED']),
    ])).toThrow(/exceeds the 600 ceiling/);
  });

  it('uses the $300 ceiling off a joint return', () => {
    const { m } = run([
      f('ftax', C.FOREIGN_TAX_PAID, '300', ['FED']),
      f('elect', C.FTC_DEMINIMIS_ELECTION, '1', ['FED']),
    ], 'single');
    expect(m.get(C.FED_FTC)).toBe('300');
    expect(() => run([
      f('ftax', C.FOREIGN_TAX_PAID, '301', ['FED']),
      f('elect', C.FTC_DEMINIMIS_ELECTION, '1', ['FED']),
    ], 'single')).toThrow(/exceeds the 300 ceiling/);
  });

  it('without the election, bare foreign tax is FLAGGED not fatal (revised by P73)', () => {
    // P57 made this a refusal. P73 revised that: a brokerage 1099 box 7 lands
    // exactly this shape, and refusing blacked out the entire return. Omitting
    // a CREDIT raises tax, so it can never be a windfall — compute, and record
    // the uncredited tax loudly. The guidance toward the election lives on the
    // emitted fact now instead of in an exception message.
    const { m, calcs } = run([f('ftax', C.FOREIGN_TAX_PAID, '50', ['FED'])]);
    expect(m.get(C.FED_FTC_NOT_CLAIMED)).toBe('50');
    expect(m.has(C.FED_FTC)).toBe(false);
    const c = calcs.find((x) => x.formula_ref === 'FED.F1116.NOT_CLAIMED');
    expect(c?.steps.join(' ')).toContain('foreign.de_minimis_election');
  });

  it('leaves the Form 1116 limitation path untouched when not elected', () => {
    const { m, calcs } = run([
      f('ftax', C.FOREIGN_TAX_PAID, '5000', ['FED']),
      f('finc', C.FOREIGN_INCOME, '1000', ['FED']),
    ]);
    // 1,000 of foreign-source income cannot support 5,000 of credit: the §904
    // limitation still bites and the excess still carries.
    expect(calcs.some((x) => x.formula_ref === 'FED.F1116.LINE33')).toBe(true);
    const ftc = Money.fromString(m.get(C.FED_FTC) ?? '0');
    expect(ftc.lt(Money.fromString('5000'))).toBe(true);
    expect(m.get(C.FED_FTC_UNUSED)).toBeDefined();
  });
});
