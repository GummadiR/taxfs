/**
 * P58 — §469(g) disposition release and §469(f)(1)(A) former-passive release.
 *
 * Found reconciling a real 2023 return. Two S-corp/LLC activities:
 *  - the passive LLC (current loss 4,200 + prior unallowed 5,802) is fully
 *    suspended and carries 10,002 forward — TaxOS already matched this exactly;
 *  - the nonpassive S corp deducted 3,203 of current loss PLUS 905 of
 *    prior-year suspended passive loss. TaxOS held the 905, deducting 3,203
 *    against the CPA's 4,108, because neither §469(f) nor §469(g) existed.
 *
 * §469(g) in particular was absent entirely — a fully taxable disposition of
 * an entire interest is the single most common way suspended losses are freed,
 * and there was no way to express one.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p58';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED', 'IL']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[]) {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, '249660'), f('fwh', C.FED_WITHHOLDING, '38475', ['FED']), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

const gdc = (extra: TaxFact[] = []): TaxFact[] => [
  f('a', 'k1.gdc.box1', '-3203', ['FED']),
  f('b', 'k1.gdc.is_scorp', '1', ['FED']),
  f('c', 'k1.gdc.material_participation', '1', ['FED']),
  f('d', 'k1.gdc.basis_opening', '100000', ['FED']),
  ...extra,
];

describe('P58 — §469(f)(1)(A) former-passive release', () => {
  it('holds the carryover when the nonpassive activity runs a LOSS', () => {
    const { m } = run(gdc([f('e', 'k1.gdc.passive_carryover', '905', ['FED'])]));
    expect(m.get('k1.gdc.allowed_net')).toBe('-3203');
    expect(m.get('k1.gdc.passive_suspended.out')).toBe('905');
  });

  it('releases the carryover only up to the activity\'s own income', () => {
    const { m } = run([
      f('a', 'k1.gdc.box1', '400', ['FED']),
      f('b', 'k1.gdc.is_scorp', '1', ['FED']),
      f('c', 'k1.gdc.material_participation', '1', ['FED']),
      f('d', 'k1.gdc.basis_opening', '100000', ['FED']),
      f('e', 'k1.gdc.passive_carryover', '905', ['FED']),
    ]);
    // 400 of income absorbs 400 of the 905; the remaining 505 stays suspended.
    expect(m.get('k1.gdc.allowed_net')).toBe('0');
    expect(m.get('k1.gdc.passive_suspended.out')).toBe('505');
  });
});

describe('P58 — §469(g) disposition release', () => {
  it('frees a held carryover in full on a nonpassive activity', () => {
    const { m, calcs } = run(gdc([
      f('e', 'k1.gdc.passive_carryover', '905', ['FED']),
      f('g', 'k1.gdc.disposed_entire_interest', '1', ['FED']),
    ]));
    // The CPA's Schedule E figure: 3,203 current + 905 released.
    expect(m.get('k1.gdc.allowed_net')).toBe('-4108');
    expect(m.has('k1.gdc.passive_suspended.out')).toBe(false);
    const c = calcs.find((x) => x.concept === 'k1.gdc.allowed_net');
    expect(c?.steps.join(' ')).toContain('§469(g)(1)');
  });

  it('frees a fully suspended PASSIVE activity, carrying nothing forward', () => {
    const { m } = run([
      f('a', 'k1.gsap.box1', '-4200', ['FED']),
      f('b', 'k1.gsap.material_participation', '0', ['FED']),
      f('c', 'k1.gsap.passive_carryover', '5802', ['FED']),
      f('d', 'k1.gsap.basis_opening', '100000', ['FED']),
      f('e', 'k1.gsap.disposed_entire_interest', '1', ['FED']),
    ]);
    expect(m.get('k1.gsap.allowed_net')).toBe('-10002');
    expect(m.has('k1.gsap.passive_suspended.out')).toBe(false);
  });

  it('without the flag the same passive activity still suspends all 10,002', () => {
    const { m } = run([
      f('a', 'k1.gsap.box1', '-4200', ['FED']),
      f('b', 'k1.gsap.material_participation', '0', ['FED']),
      f('c', 'k1.gsap.passive_carryover', '5802', ['FED']),
      f('d', 'k1.gsap.basis_opening', '100000', ['FED']),
    ]);
    expect(m.get('k1.gsap.allowed_net')).toBe('0');
    expect(m.get('k1.gsap.passive_suspended.out')).toBe('10002');
  });

  it('disposing one activity leaves another activity\'s suspension untouched', () => {
    const { m } = run([
      f('a', 'k1.gsap.box1', '-4200', ['FED']),
      f('b', 'k1.gsap.material_participation', '0', ['FED']),
      f('c', 'k1.gsap.passive_carryover', '5802', ['FED']),
      f('d', 'k1.gsap.basis_opening', '100000', ['FED']),
      f('e', 'k1.gsap.disposed_entire_interest', '1', ['FED']),
      f('h', 'k1.other.box1', '-1000', ['FED']),
      f('i', 'k1.other.material_participation', '0', ['FED']),
      f('j', 'k1.other.basis_opening', '100000', ['FED']),
    ]);
    expect(m.get('k1.gsap.allowed_net')).toBe('-10002');
    expect(m.get('k1.other.allowed_net')).toBe('0');
    expect(m.get('k1.other.passive_suspended.out')).toBe('1000');
  });

  it('kernel2 mirrors the released bottom line', () => {
    const { m, k2 } = run(gdc([
      f('e', 'k1.gdc.passive_carryover', '905', ['FED']),
      f('g', 'k1.gdc.disposed_entire_interest', '1', ['FED']),
    ]));
    expect(k2.fed_refund_or_due).toBe(m.get(C.FED_REFUND_OR_DUE));
    expect(k2.il_refund_or_due).toBe(m.get(C.IL_REFUND_OR_DUE));
  });
});
