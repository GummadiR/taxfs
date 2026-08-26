import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compute } from '../src/index.js';
import { computeHeadlines } from '@taxfs/kernel2';
import { Money, loadVerifiedRuleSet, type TaxFact } from '@taxfs/shared';

const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, '..', '..', '..', p), 'utf8'));
const fed = loadVerifiedRuleSet(fx('rules/fixtures/2025.FED.1.0.json'), fx('rules/fixtures/2025.SYSTEM.FED.json'));
const il = loadVerifiedRuleSet(fx('rules/fixtures/2025.IL.1.0.json'), fx('rules/fixtures/2025.SYSTEM.IL.json'));

let n = 0;
const f = (concept: string, value: string, jur: ('FED' | 'IL')[] = ['FED']): TaxFact => ({
  fact_id: `f:s${++n}:${concept}`, taxpayer_id: 't', concept, tax_year: 2025,
  jurisdiction: jur, taxpayer_scope: 'primary', value: Money.fromString(value),
  unit: 'USD', status: 'confirmed', confidence: 1, provenance: [{ source_id: `s${n}`, source_field: 'x' }],
});

function run(facts: TaxFact[]) {
  const result = compute({
    taxpayer_id: 't', tax_year: 2025,
    ctx: { taxpayer_id: 't', tax_year: 2025, filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0, rule_versions: { FED: fed.rule_version, IL: il.rule_version } },
    facts, fed_rules: fed, il_rules: il,
  });
  const line = (concept: string) => result.calculations.find((c) => c.concept === concept)?.value.toString();
  const k2 = computeHeadlines({
    facts: facts.map((x) => ({ concept: x.concept, value: x.value.toString(), jurisdiction: x.jurisdiction })),
    filing_status: 'mfj', il_exemption_count: 2, addl_std_boxes: 0, fed_rules: fed, il_rules: il,
  });
  return { line, k2 };
}

/** P41 — §469(i): rental real estate with active participation frees up to
 *  $25,000 of suspended passive loss, phased out 50% over $100k MAGI.
 *  Hand math: MAGI = wages 120,000 + nonpassive K-1 net 10,000 = 130,000;
 *  allowance = 25,000 − 0.5×30,000 = 10,000; rental loss 20,000 (basis OK)
 *  suspended 20,000 → 10,000 freed. Sch E = 10,000 − 10,000 = 0. */
describe('P41 — §469(i) rental special allowance', () => {
  it('frees the phased allowance and both kernels agree', () => {
    const { line, k2 } = run([
      f('income.wages', '120000', ['FED', 'IL']),
      f('k1.rr.box1', '-20000', ['FED', 'IL']), f('k1.rr.is_scorp', '0'),
      f('k1.rr.material_participation', '0'), f('k1.rr.rental_active', '1'),
      f('k1.rr.basis_opening', '50000'),
      f('k1.biz.box1', '10000', ['FED', 'IL']), f('k1.biz.is_scorp', '1'),
      f('k1.biz.material_participation', '1'), f('k1.biz.basis_opening', '0'),
    ]);
    expect(line('fed.f8582.special_allowance')).toBe('10000');
    expect(line('fed.sche.k1_total')).toBe('0');
    expect(line('fed.total_income')).toBe('120000');
    expect(k2.total_income).toBe('120000');
  });

  it('MAGI at or above the phase-out ceiling gets nothing', () => {
    const { line, k2 } = run([
      f('income.wages', '160000', ['FED', 'IL']),
      f('k1.rr.box1', '-8000', ['FED', 'IL']), f('k1.rr.is_scorp', '0'),
      f('k1.rr.material_participation', '0'), f('k1.rr.rental_active', '1'),
      f('k1.rr.basis_opening', '50000'),
    ]);
    expect(line('fed.f8582.special_allowance')).toBe('0');
    expect(line('fed.sche.k1_total')).toBe('0');
    expect(line('fed.total_income')).toBe('160000');
    expect(k2.total_income).toBe('160000');
  });
});

/** P41 — Form 4797 stream: shares the basis/§469 limits, reports on Sch 1
 *  line 4. Nonpassive, basis ample: box1 −6,000 → Sch E; f4797 −2,000 →
 *  4797 line; total income = 90,000 − 8,000 = 82,000. */
describe('P41 — K-1 Form 4797 passthrough', () => {
  it('splits the allowed loss between Sch E and the 4797 line', () => {
    const { line, k2 } = run([
      f('income.wages', '90000', ['FED', 'IL']),
      f('k1.biz.box1', '-6000', ['FED', 'IL']), f('k1.biz.is_scorp', '0'),
      f('k1.biz.material_participation', '1'), f('k1.biz.basis_opening', '20000'),
      f('k1.biz.f4797', '-2000', ['FED', 'IL']),
    ]);
    expect(line('fed.f4797.total')).toBe('-2000');
    expect(line('fed.sche.k1_total')).toBe('-6000');
    expect(line('fed.total_income')).toBe('82000');
    expect(k2.total_income).toBe('82000');
  });
});
