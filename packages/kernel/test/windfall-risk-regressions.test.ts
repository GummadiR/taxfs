/**
 * P56 — the three remaining critic findings, each a WINDFALL risk (they all
 * erred in the taxpayer's favour, which is the direction that gets a preparer
 * penalized):
 *  1. the IL exempt-obligation subtraction had no leash to its add-back;
 *  2. the IL PTE credit was taken with no companion Schedule M add-back;
 *  3. §21(d) treated a missing earned-income limit as "no limit".
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { computeHeadlines } from '@taxfs/kernel2';
import { loadFedRules, loadIlRules } from './helpers.js';

const fed = loadFedRules();
const il = loadIlRules();
const TP = 'tp-p56';
const f = (id: string, concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED', 'IL']): TaxFact => ({
  fact_id: id, taxpayer_id: TP, concept, tax_year: 2025, jurisdiction: jur, taxpayer_scope: 'primary',
  value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: `s:${id}`, source_field: 'v' }],
});

function run(extra: TaxFact[], wages = '100000') {
  const ctx: FilingContext = {
    taxpayer_id: TP, tax_year: 2025, filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
  const facts = [f('w2', C.WAGES, wages), ...extra];
  const r = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fed, il_rules: il });
  const m = new Map(r.computedFacts.map((x) => [x.concept, x.value.toString()]));
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString() })),
    filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { m, k2, calcs: r.calculations };
}

describe('P56 #1 — the exempt-obligation subtraction is leashed to the add-back', () => {
  it('THE WINDFALL: claiming the subtraction with NO add-back changes nothing', () => {
    const { m } = run([f('ob', C.IL_EXEMPT_OBLIGATIONS, '2312', ['IL'])]);
    expect(m.get(C.IL_BASE_INCOME)).toBe('100000'); // not 97,688
  });

  it('a subtraction LARGER than the add-back is capped at it', () => {
    const { m } = run([
      f('te', C.TAX_EXEMPT_INTEREST, '2312'),
      f('ob', C.IL_EXEMPT_OBLIGATIONS, '99999', ['IL']),
    ]);
    expect(m.get(C.IL_BASE_INCOME)).toBe('100000'); // net addition floored at 0
  });

  it('a genuine partial exemption nets correctly', () => {
    const { m } = run([
      f('te', C.TAX_EXEMPT_INTEREST, '2312'),
      f('ob', C.IL_EXEMPT_OBLIGATIONS, '800', ['IL']),
    ]);
    expect(m.get(C.IL_BASE_INCOME)).toBe('101512'); // 100,000 + (2,312 − 800)
  });

  it('the full add-back still applies with no exempt slice (the real return)', () => {
    const { m } = run([f('te', C.TAX_EXEMPT_INTEREST, '2312')]);
    expect(m.get(C.IL_BASE_INCOME)).toBe('102312');
  });

  it('the trail says the cap was applied', () => {
    const { calcs } = run([
      f('te', C.TAX_EXEMPT_INTEREST, '2312'),
      f('ob', C.IL_EXEMPT_OBLIGATIONS, '99999', ['IL']),
    ]);
    const steps = (calcs.find((c) => c.concept === C.IL_TAX_EXEMPT_ADDBACK)?.steps ?? []).join('\n');
    expect(steps).toContain('CAPPED at the add-back');
  });

  it('kernel2 agrees on every case (divergence)', () => {
    for (const extra of [
      [f('ob', C.IL_EXEMPT_OBLIGATIONS, '2312', ['IL'])],
      [f('te', C.TAX_EXEMPT_INTEREST, '2312'), f('ob', C.IL_EXEMPT_OBLIGATIONS, '99999', ['IL'])],
      [f('te', C.TAX_EXEMPT_INTEREST, '2312'), f('ob', C.IL_EXEMPT_OBLIGATIONS, '800', ['IL'])],
    ]) {
      const { m, k2 } = run(extra);
      expect(k2.il_tax).toBe(m.get(C.IL_TAX));
    }
  });
});

describe('P56 #3 — §21(d) is no longer assumed away', () => {
  const dc = [
    f('dc', C.DEPCARE_EXPENSES, '3000', ['FED']),
    f('dcn', C.DEPCARE_PERSONS, '1', ['FED']),
  ];

  it('THE SILENT GUESS: neither the limit nor an attestation raises a flag fact', () => {
    const { m } = run(dc, '259529');
    expect(m.get(C.FED_DEPCARE_EI_UNVERIFIED)).toBe('1');
  });

  it('an explicit attestation clears it', () => {
    const { m } = run([...dc, f('ok', C.DEPCARE_EARNED_INCOME_NOT_LIMITING, '1', ['FED'])], '259529');
    expect(m.get(C.FED_DEPCARE_EI_UNVERIFIED)).toBeUndefined();
  });

  it('supplying the actual limit also clears it — and still caps the credit', () => {
    const { m } = run([...dc, f('ei', C.DEPCARE_EARNED_INCOME_LIMIT, '1500', ['FED'])], '259529');
    expect(m.get(C.FED_DEPCARE_EI_UNVERIFIED)).toBeUndefined();
    expect(m.get(C.FED_DEPCARE_CREDIT)).toBe('300'); // 20% × 1,500
  });

  it('the trail no longer claims the limit was "assumed not binding" without saying so', () => {
    const { calcs } = run(dc, '259529');
    const steps = (calcs.find((c) => c.concept === C.FED_DEPCARE_CREDIT)?.steps ?? []).join('\n');
    expect(steps).toContain('NOT supplied and NOT attested');
    expect(steps).toContain('may overstate');
  });
});
