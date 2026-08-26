/**
 * D.2 mapping engine: rule-driven form-set resolution, population with
 * lineage + sign conventions, and the cross-form artifact check (including
 * the seeded wrong-line mapping the spec requires it to catch).
 */
import { describe, expect, it } from 'vitest';
import { crossFormCheck, populateInstances, resolveFormSet, type FormDefRelease } from '@taxfs/forms';
import { factsFor, fedRelease, ilRelease } from './helpers.js';

function formIds(release: FormDefRelease, goldenName: string): string[] {
  return resolveFormSet(release, factsFor(goldenName)).map((d) => d.form_id);
}

describe('form-set resolution (required_when is rule-data)', () => {
  it('minimal return: 1040 + IL-1040 + Sch IL-WIT only', () => {
    expect(formIds(fedRelease, 'return1-single-w2')).toEqual(['1040']);
    expect(formIds(ilRelease, 'return1-single-w2')).toEqual(['IL1040', 'SCHILWIT']);
  });

  it('interest 1200 stays under the Sch B threshold (1500 PLACEHOLDER)', () => {
    expect(formIds(fedRelease, 'return2-w2-1099int')).toEqual(['1040']);
  });

  it('multi-doc MFJ return attaches Sch B, Sch D, 8949, and Sch M', () => {
    expect(formIds(fedRelease, 'return3-mfj-multidoc')).toEqual(['1040', 'SCHB', 'SCHD', 'F8949']);
    expect(formIds(ilRelease, 'return3-mfj-multidoc')).toEqual(['IL1040', 'SCHM', 'SCHILWIT']);
  });
});

describe('population: filing-ready values, lineage, sign conventions', () => {
  it('populates 1040 lines from kernel totals with full lineage (return2)', () => {
    const facts = factsFor('return2-w2-1099int');
    const defs = resolveFormSet(fedRelease, facts);
    const { instances, defects } = populateInstances(defs, facts, 'tp-golden', 2025);
    expect(defects).toEqual([]);
    const f1040 = instances.find((i) => i.form_id === '1040')!;
    const v = (line: string): string => f1040.values[line]?.toString() ?? '<omitted>';
    expect(v('1040.1a')).toBe('50000');
    expect(v('1040.2b')).toBe('1200');
    expect(v('1040.9')).toBe('51200');
    expect(v('1040.11')).toBe('51200');
    expect(v('1040.15')).toBe('36200');
    expect(v('1040.16')).toBe('4144');
    expect(v('1040.33')).toBe('4000');
    // balance due 144 → owed line carries abs, refund line omitted
    expect(v('1040.37')).toBe('144');
    expect(v('1040.34')).toBe('<omitted>');
    // zero lines omitted (sparse), e.g. dividends and credits
    expect(v('1040.3b')).toBe('<omitted>');
    expect(v('1040.20')).toBe('<omitted>');
    // lineage on every populated line
    for (const lineId of Object.keys(f1040.values)) {
      expect(f1040.lineage[lineId]?.fact_id, lineId).toBeTruthy();
      expect(f1040.lineage[lineId]?.calc_id, lineId).toBeTruthy(); // all 1040 lines map derived facts
    }
  });

  it('refund side: positive refund populates 1040.34 and omits 1040.37 (return1)', () => {
    const facts = factsFor('return1-single-w2');
    const { instances } = populateInstances(resolveFormSet(fedRelease, facts), facts, 'tp-golden', 2025);
    const f1040 = instances.find((i) => i.form_id === '1040')!;
    expect(f1040.values['1040.34']?.toString()).toBe('300');
    expect(f1040.values['1040.37']).toBeUndefined();
  });

  it('IL pass: Sch M and IL-WIT totals flow with lineage (return3)', () => {
    const facts = factsFor('return3-mfj-multidoc');
    const { instances, defects } = populateInstances(resolveFormSet(ilRelease, facts), facts, 'tp-golden', 2025);
    expect(defects).toEqual([]);
    const il1040 = instances.find((i) => i.form_id === 'IL1040')!;
    expect(il1040.values['IL1040.1']?.toString()).toBe('142800');
    expect(il1040.values['IL1040.7']?.toString()).toBe('10000');
    expect(il1040.values['IL1040.12']?.toString()).toBe('6299');
    expect(instances.find((i) => i.form_id === 'SCHM')!.values['SCHM.42']?.toString()).toBe('10000');
    expect(instances.find((i) => i.form_id === 'SCHILWIT')!.values['SCHILWIT.5']?.toString()).toBe('6100');
  });
});

describe('cross-form artifact check (defense-in-depth beyond Gate 4)', () => {
  function allInstances(goldenName: string) {
    const facts = factsFor(goldenName);
    const fed = populateInstances(resolveFormSet(fedRelease, facts), facts, 'tp-golden', 2025);
    const il = populateInstances(resolveFormSet(ilRelease, facts), facts, 'tp-golden', 2025);
    return { instances: [...fed.instances, ...il.instances], facts };
  }

  it('clean return: every transferred total matches, across jurisdictions too', () => {
    const { instances } = allInstances('return3-mfj-multidoc');
    expect(crossFormCheck([...fedRelease.forms, ...ilRelease.forms], instances)).toEqual([]);
  });

  it('SEEDED WRONG-LINE MAPPING: Sch B interest wired to the dividends concept is caught', () => {
    // Corrupt the form-def (rule-data) so SCHB.4 pulls ordinary dividends —
    // the right number lands on the wrong line; Gate 4 math checks cannot
    // see this, the artifact check must.
    const corrupted: FormDefRelease = {
      ...fedRelease,
      forms: fedRelease.forms.map((f) =>
        f.form_id === 'SCHB'
          ? {
              ...f,
              lines: f.lines.map((l) =>
                l.line_id === 'SCHB.4' ? { ...l, from_concept: 'fed.dividends.ordinary.total' } : l,
              ),
            }
          : f,
      ),
    };
    const facts = factsFor('return3-mfj-multidoc');
    const fed = populateInstances(resolveFormSet(corrupted, facts), facts, 'tp-golden', 2025);
    const defects = crossFormCheck(corrupted.forms, fed.instances);
    expect(defects.length).toBeGreaterThan(0);
    expect(defects[0]?.kind).toBe('cross_form_mismatch');
    expect(defects[0]?.message).toMatch(/SCHB\.4/);
    expect(defects[0]?.message).toMatch(/wrong line/);
  });

  it('a transferred total pointing at an absent form is a defect', () => {
    const { instances } = allInstances('return3-mfj-multidoc');
    const without1040 = instances.filter((i) => i.form_id !== '1040');
    const defects = crossFormCheck([...fedRelease.forms, ...ilRelease.forms], without1040);
    expect(defects.some((d) => d.message.includes('absent'))).toBe(true);
  });
});
