/**
 * D.2 — Mapping engine.
 * Filing Context → form-set resolution (rule-driven required_when) →
 * FormInstance population with lineage + sign conventions → cross-form
 * artifact check.
 *
 * NO MATH HERE: every line and every attachment condition reads a single
 * kernel-emitted, filing-ready fact. Sign conventions (positive part /
 * abs-of-negative for refund vs amount-owed) are the only transformation,
 * and they are declared per LineDef in rule-data (D.2). A fractional value
 * arriving here is a kernel defect and is *surfaced*, never rounded.
 */
import { Money, type TaxFact } from '@taxfs/shared';
import type { FormDefRelease } from './defs';
import type { FormDefinition, FormInstance, LineDef, MappingDefect, RequiredWhen } from './types';

function confirmedFactsByConcept(facts: TaxFact[], concept: string): TaxFact[] {
  return facts.filter((f) => f.concept === concept && f.status === 'confirmed');
}

/** Exactly-one lookup: form lines and conditions reference kernel totals. */
function singleFact(facts: TaxFact[], concept: string): { fact?: TaxFact; ambiguous: boolean } {
  const matches = confirmedFactsByConcept(facts, concept);
  if (matches.length === 1) return { fact: matches[0]!, ambiguous: false };
  return { ambiguous: matches.length > 1 };
}

function conditionHolds(cond: RequiredWhen, facts: TaxFact[]): boolean {
  switch (cond.kind) {
    case 'always':
      return true;
    case 'concept_present':
      return confirmedFactsByConcept(facts, cond.concept).length > 0;
    case 'concept_nonzero': {
      const { fact } = singleFact(facts, cond.concept);
      return fact !== undefined && !fact.value.isZero();
    }
    case 'any_concept_present':
      return cond.concepts.some((concept) => singleFact(facts, concept).fact !== undefined);
    case 'any_concept_sum_exceeds': {
      const threshold = Money.fromString(cond.threshold);
      return cond.concepts.some((concept) => {
        const { fact } = singleFact(facts, concept);
        return fact !== undefined && fact.value.gt(threshold);
      });
    }
  }
}

export function resolveFormSet(release: FormDefRelease, facts: TaxFact[]): FormDefinition[] {
  return release.forms
    .filter((def) => conditionHolds(def.required_when, facts))
    .sort((a, b) => a.attachment_order - b.attachment_order);
}

/** Apply the declarative sign convention; null ⇒ line omitted. */
function applySign(line: LineDef, value: Money): Money | null {
  switch (line.sign_convention) {
    case 'as_is':
      return value;
    case 'positive_only':
      return value.gt(Money.zero()) ? value : null;
    case 'abs_of_negative':
      return value.isNegative() ? value.neg() : null;
  }
}

export interface MappingResult {
  instances: FormInstance[];
  defects: MappingDefect[];
}

export function populateInstances(
  defs: FormDefinition[],
  facts: TaxFact[],
  taxpayer_id: string,
  tax_year: number,
): MappingResult {
  const defects: MappingDefect[] = [];
  const instances = defs.map((def) => {
    const values: Record<string, Money> = {};
    const lineage: Record<string, { fact_id: string; calc_id?: string }> = {};
    for (const line of def.lines) {
      const { fact, ambiguous } = singleFact(facts, line.from_concept);
      if (ambiguous) {
        defects.push({
          form_id: def.form_id,
          line_id: line.line_id,
          kind: 'ambiguous_fact',
          message: `${line.from_concept} matches multiple facts — form lines must reference kernel-emitted totals`,
        });
        continue;
      }
      if (!fact) {
        if (line.optional === true) continue; // sub-DAG didn't run — line lawfully absent
        defects.push({
          form_id: def.form_id,
          line_id: line.line_id,
          kind: 'missing_fact',
          message: `no confirmed fact for ${line.from_concept} — kernel did not produce this line (defect in C, never patched in D)`,
        });
        continue;
      }
      if (!fact.value.isWholeDollars()) {
        defects.push({
          form_id: def.form_id,
          line_id: line.line_id,
          kind: 'not_whole_dollar',
          message: `${line.from_concept} = ${fact.value.toString()} is not filing-ready (kernel owns rounding; D never rounds)`,
        });
        continue;
      }
      const signed = applySign(line, fact.value);
      if (signed === null) continue;
      if (line.omit_when_zero === true && signed.isZero()) continue;
      values[line.line_id] = signed;
      const entry: { fact_id: string; calc_id?: string } = { fact_id: fact.fact_id };
      if (fact.derivation !== undefined) entry.calc_id = fact.derivation;
      lineage[line.line_id] = entry;
    }
    return {
      instance_id: `fi:${tax_year}:${def.form_id}`,
      form_id: def.form_id,
      revision: def.revision,
      jurisdiction: def.jurisdiction,
      tax_year,
      taxpayer_id,
      values,
      lineage,
      status: 'draft',
    } satisfies FormInstance;
  });
  return { instances, defects };
}

/**
 * D.2 cross-form artifact check (defense-in-depth, kept over external
 * objection): Gate 4 validates MATH upstream in C; this catches MAPPING
 * defects — the right number on the wrong line/element — which no upstream
 * check can see. Spans jurisdictions (IL-1040 line 1 ↔ 1040 line 11).
 */
export function crossFormCheck(
  allDefs: FormDefinition[],
  allInstances: FormInstance[],
): MappingDefect[] {
  const defects: MappingDefect[] = [];
  const instanceByForm = new Map(allInstances.map((i) => [i.form_id, i]));
  for (const def of allDefs) {
    const source = instanceByForm.get(def.form_id);
    if (!source) continue; // form not in this return's set
    for (const line of def.lines) {
      if (!line.must_equal) continue;
      const sourceValue = source.values[line.line_id];
      if (sourceValue === undefined) continue; // omitted line (e.g. zero) — nothing transferred
      const target = instanceByForm.get(line.must_equal.form_id);
      const targetValue = target?.values[line.must_equal.line_id];
      if (!target || targetValue === undefined) {
        defects.push({
          form_id: def.form_id,
          line_id: line.line_id,
          kind: 'cross_form_mismatch',
          message: `${def.form_id}.${line.line_id} = ${sourceValue.toString()} transfers to ${line.must_equal.form_id}.${line.must_equal.line_id}, which is absent`,
        });
        continue;
      }
      if (!sourceValue.eq(targetValue)) {
        defects.push({
          form_id: def.form_id,
          line_id: line.line_id,
          kind: 'cross_form_mismatch',
          message: `transferred total mismatch: ${def.form_id}.${line.line_id} = ${sourceValue.toString()} but ${line.must_equal.form_id}.${line.must_equal.line_id} = ${targetValue.toString()} (right number, wrong line?)`,
        });
      }
    }
  }
  return defects;
}
