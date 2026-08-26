/**
 * P79 — the two Forms-page mapping defects a real return surfaced:
 *
 * 1. 1040.7 / SCHD.16 / F8949.2h all map from fed.capital_gain.net.total,
 *    which the Schedule D sub-DAG deliberately did not emit (the legacy
 *    component is a double-count guard) — so EVERY Schedule D return
 *    rendered its forms with 1040 line 7 silently missing and SCHD.16 /
 *    F8949.2h flagged as defects. The kernel now emits the line as an alias
 *    of the Sch D total on that path.
 *
 * 2. 1040.2a mapped straight from the SOURCED income.tax_exempt_interest,
 *    so an entry with cents (2923.63 from a bank statement) failed the
 *    filing-ready check — the mapping layer never rounds, and nothing
 *    upstream rounded either. The kernel now emits a rounded
 *    fed.tax_exempt_interest.total and the form def maps that.
 */
import { describe, expect, it } from 'vitest';
import { C, Money, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { populateInstances, resolveFormSet } from '@taxfs/forms';
import { factsFor, fedRelease } from './helpers.js';
import { TP, ctxOf, factsOf, loadFedRules, loadIlRules, loadGolden } from '../../kernel/test/helpers.js';

const fed = loadFedRules();
const il = loadIlRules();

describe('P79.1 — Schedule D returns populate 1040.7, SCHD.16 and F8949.2h', () => {
  const facts = factsFor('return14-schd-gains'); // sourced + derived via the gates helper
  const defs = resolveFormSet(fedRelease, facts);
  const { instances, defects } = populateInstances(defs, facts, 'tp-golden', 2025);

  it('no mapping defects on the Schedule D chain', () => {
    expect(defects.filter((d) => /SCHD\.16|F8949\.2h|1040\.7/.test(JSON.stringify(d)))).toEqual([]);
  });

  it('all three lines carry the Sch D line-16 figure', () => {
    const schdTotal = facts.find((f) => f.concept === C.FED_SCHD_TOTAL)!.value.toString();
    const line = (form: string, id: string): string =>
      instances.find((i) => i.form_id === form)!.values[id]?.toString() ?? '<omitted>';
    expect(line('1040', '1040.7')).toBe(schdTotal);
    expect(line('SCHD', 'SCHD.16')).toBe(schdTotal);
    expect(line('F8949', 'F8949.2h')).toBe(schdTotal);
  });

  it('the alias is derived FROM the Sch D total, never summed into income', () => {
    const g = loadGolden('return14-schd-gains');
    const r = compute({
      taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fed, il),
      facts: factsOf(g), fed_rules: fed, il_rules: il,
    });
    const alias = r.computedFacts.find((f) => f.concept === C.FED_CAPGAIN_TOTAL)!;
    const schd = r.computedFacts.find((f) => f.concept === C.FED_SCHD_TOTAL)!;
    expect(alias.value.eq(schd.value)).toBe(true);
    // total income still ties: expected golden line unchanged
    expect(r.computedFacts.find((f) => f.concept === C.FED_TOTAL_INCOME)!.value.toString())
      .toBe(g.expected[C.FED_TOTAL_INCOME]);
  });
});

describe('P79.2 — tax-exempt interest with cents renders 1040.2a filing-ready', () => {
  const cents: TaxFact = {
    fact_id: 'ex:te-cents', taxpayer_id: TP, concept: C.TAX_EXEMPT_INTEREST, tax_year: 2025,
    jurisdiction: ['FED', 'IL'], taxpayer_scope: 'primary', value: Money.fromString('2923.63'),
    unit: 'USD', status: 'confirmed', confidence: 1,
    provenance: [{ source_id: 's:te', source_field: 'v' }],
  };

  it('the kernel emits the rounded whole-dollar total', () => {
    const g = loadGolden('return1-single-w2');
    const r = compute({
      taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fed, il),
      facts: [...factsOf(g), cents], fed_rules: fed, il_rules: il,
    });
    const total = r.computedFacts.find((f) => f.concept === C.FED_TAX_EXEMPT_TOTAL)!;
    expect(total.value.toString()).toBe('2924');
  });

  it('1040.2a populates from it with no filing-ready defect', () => {
    const g = loadGolden('return1-single-w2');
    const r = compute({
      taxpayer_id: TP, tax_year: 2025, ctx: ctxOf(g, fed, il),
      facts: [...factsOf(g), cents], fed_rules: fed, il_rules: il,
    });
    const all = [...factsOf(g), cents, ...r.computedFacts];
    const defs = resolveFormSet(fedRelease, all);
    const { instances, defects } = populateInstances(defs, all, TP, 2025);
    expect(defects.filter((d) => /2a|tax_exempt/.test(JSON.stringify(d)))).toEqual([]);
    expect(instances.find((i) => i.form_id === '1040')!.values['1040.2a']?.toString()).toBe('2924');
  });

  it('absent tax-exempt interest, the line is simply omitted (no defect)', () => {
    const facts = factsFor('return1-single-w2');
    const { instances, defects } = populateInstances(resolveFormSet(fedRelease, facts), facts, 'tp-golden', 2025);
    expect(defects.filter((d) => /2a|tax_exempt/.test(JSON.stringify(d)))).toEqual([]);
    expect(instances.find((i) => i.form_id === '1040')!.values['1040.2a']).toBeUndefined();
  });
});
