/**
 * P67 — Schedule A built by the kernel from facts it already holds.
 *
 * The live 2025 return: the CPA itemized 32,961 (taxes 28,337 + mortgage
 * interest 3,664 + charity 960) and beat the 31,500 standard deduction for the
 * first time, because the OBBBA raised the SALT cap to 40,000. TaxOS took the
 * standard deduction because it only had the 960 — even though it ALREADY held
 * the property tax (17,144) and the IL withholding (11,193) as facts.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p67';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED', 'IL']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[], fs: FilingContext['filing_status'] = 'mfj', wages = '228946') {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: fs, il_exemption_count: 2, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, wages), f('fwh', C.FED_WITHHOLDING, '32282', ['FED']), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: fs, il_exemption_count: 2, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

// The live return's Schedule A inputs. Property tax and IL withholding are
// NOT Schedule A entries — the kernel already has them and must pick them up.
const live = [
  f('ptax', C.IL_PROPERTY_TAX, '17144', ['IL']),
  f('ilwh', C.IL_WITHHOLDING, '11193', ['IL']),
  f('mort', C.SCHA_MORTGAGE_INTEREST, '3664', ['FED']),
  f('char', C.SCHA_CHARITABLE, '960', ['FED']),
];

describe('P67 — Schedule A from facts the kernel already holds', () => {
  it("reproduces the CPA's 32,961 without re-entering property or state tax", () => {
    const { m } = run(live);
    // SALT = 11,193 state income tax + 17,144 real estate — both already facts.
    expect(m.get(C.FED_SCHA_SALT_BEFORE_CAP)).toBe('28337');
    expect(m.get(C.FED_SCHA_SALT_ALLOWED)).toBe('28337'); // under the 40k cap
    expect(m.get(C.FED_SCHA_INTEREST)).toBe('3664');
    expect(m.get(C.FED_SCHA_TOTAL)).toBe('32961');
  });

  it('itemizing beats the standard deduction, and the kernel takes the greater', () => {
    const { m } = run(live);
    expect(m.get(C.FED_STD_DEDUCTION)).toBe('30000'); // placeholder fixture
    expect(m.get(C.FED_DEDUCTION)).toBe('32961');
  });

  it('falls back to the standard deduction when Schedule A is smaller', () => {
    const { m } = run([f('char', C.SCHA_CHARITABLE, '960', ['FED'])]);
    expect(m.get(C.FED_SCHA_TOTAL)).toBe('960');
    expect(m.get(C.FED_DEDUCTION)).toBe('30000');
  });

  it('kernel2 mirrors the deduction and the bottom line', () => {
    const { m, k2 } = run(live);
    expect(k2.fed_refund_or_due).toBe(m.get(C.FED_REFUND_OR_DUE));
  });
});

describe('P67 — §164(b)(6) SALT cap is applied IN THE MATH', () => {
  it('caps at 40,000 and says so in the trail', () => {
    const { m, calcs } = run([
      f('ptax', C.IL_PROPERTY_TAX, '35000', ['IL']),
      f('ilwh', C.IL_WITHHOLDING, '20000', ['IL']),
    ]);
    expect(m.get(C.FED_SCHA_SALT_BEFORE_CAP)).toBe('55000');
    expect(m.get(C.FED_SCHA_SALT_ALLOWED)).toBe('40000');
    const c = calcs.find((x) => x.formula_ref === 'FED.SCHA.LINE5E');
    expect(c?.steps.join(' ')).toContain('THE CAP BIT');
  });

  it('phases the cap down 30% above 500,000 of AGI, never below 10,000', () => {
    // AGI 600,000 → over by 100,000 → cap 40,000 − 30,000 = 10,000.
    const { m } = run([
      f('ptax', C.IL_PROPERTY_TAX, '35000', ['IL']),
      f('ilwh', C.IL_WITHHOLDING, '20000', ['IL']),
      f('mort', C.SCHA_MORTGAGE_INTEREST, '5000', ['FED']),
    ], 'mfj', '600000');
    expect(m.get(C.FED_SCHA_SALT_ALLOWED)).toBe('10000');
  });

  it('uses the MFS half of the cap', () => {
    const { m } = run([
      f('ptax', C.IL_PROPERTY_TAX, '35000', ['IL']),
      f('ilwh', C.IL_WITHHOLDING, '20000', ['IL']),
    ], 'mfs');
    expect(m.get(C.FED_SCHA_SALT_ALLOWED)).toBe('20000');
  });
});

describe('P67 — §213(a) medical floor', () => {
  it('allows only the excess over 7.5% of AGI', () => {
    // AGI 228,946 → floor 17,171. 25,000 paid → 7,829 allowed.
    const { m } = run([f('med', C.SCHA_MEDICAL, '25000', ['FED'])]);
    expect(m.get(C.FED_SCHA_MEDICAL_ALLOWED)).toBe('7829');
  });

  it('allows nothing when the spend is under the floor', () => {
    const { m } = run([f('med', C.SCHA_MEDICAL, '5000', ['FED'])]);
    expect(m.get(C.FED_SCHA_MEDICAL_ALLOWED)).toBe('0');
  });
});

describe('P72 — a donation receipt COMPOSES with a Form 1098', () => {
  it('the exact combination that refused to compute: charity + mortgage + auto SALT', () => {
    // Live report: uploading Temple_Donations.pdf (which proposed the
    // hand-computed TOTAL) and then Home_Mortgage.pdf (a component) tripped
    // the mutually-exclusive guard and blocked the WHOLE return — federal and
    // Illinois — with no way to see which entry was the duplicate.
    const { m } = run([
      f('ptax', C.IL_PROPERTY_TAX, '17144', ['IL']),
      f('ilwh', C.IL_WITHHOLDING, '11193', ['IL']),
      f('mort', C.SCHA_MORTGAGE_INTEREST, '3664', ['FED']),   // from Form 1098
      f('char', C.SCHA_CHARITABLE, '960', ['FED']),           // from the receipt
    ]);
    expect(m.get(C.FED_SCHA_TOTAL)).toBe('32961');
    expect(m.get(C.FED_DEDUCTION)).toBe('32961');
  });

  it('the guard still fires on a real conflict, and NAMES the components', () => {
    let msg = '';
    try {
      run([
        f('mort', C.SCHA_MORTGAGE_INTEREST, '3664', ['FED']),
        f('it', C.ITEMIZED, '32961', ['FED']),
      ]);
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    expect(msg).toContain('mutually exclusive');
    // It must say WHICH component conflicts and WHERE to fix it.
    expect(msg).toContain('deduction.sch_a.mortgage_interest');
    expect(msg).toContain('Documents page');
  });
});

describe('P67 — the two Schedule A inputs are mutually exclusive', () => {
  it('refuses a hand-computed total alongside components (silent double-count)', () => {
    expect(() => run([...live, f('it', C.ITEMIZED, '32961', ['FED'])]))
      .toThrow(/mutually exclusive/);
  });

  it('still honours a hand-computed total on its own', () => {
    const { m } = run([f('it', C.ITEMIZED, '40000', ['FED'])]);
    expect(m.get(C.FED_DEDUCTION)).toBe('40000');
    expect(m.has(C.FED_SCHA_TOTAL)).toBe(false);
  });
});
