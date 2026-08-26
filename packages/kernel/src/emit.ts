/**
 * Shared emitter + fact-summing helpers for the kernel's sub-DAG files
 * (compute.ts personal run; entity.ts entity runs — P4 split, behavior
 * unchanged). Same rounding law as always: every derived line is rounded
 * to whole dollars (HALF_UP) as it is emitted.
 */
import { Money, type Calculation, type Jurisdiction, type TaxFact } from '@taxfs/shared';

export type EmitTerm = { fact: TaxFact; sign: 1 | -1 };

/** The slice of KernelInput the helpers need. */
export interface EmitterHost {
  taxpayer_id: string;
  tax_year: number;
  facts: TaxFact[];
}

/** P38 — the id carries the TAXPAYER. fact_id is a global primary key in
 *  the Postgres spine, and one operator owns many client workspaces (P35):
 *  an id of d:<year>:<concept> made every client's compute upsert onto the
 *  SAME row — client B's run overwrote client A's computed lines while
 *  client B's own workspace showed them as missing. Caught live. */
export function derivedFactId(taxpayer_id: string, tax_year: number, concept: string): string {
  return `d:${taxpayer_id}:${tax_year}:${concept}`;
}

export interface Emitter {
  facts: TaxFact[];
  calculations: Calculation[];
  emit(args: {
    concept: string;
    jurisdiction: Jurisdiction[];
    inputs: TaxFact[];
    formula_ref: string;
    rule_version: string;
    steps: string[];
    value: Money;
    taxpayer_scope?: TaxFact['taxpayer_scope'];
    /** Signed linear decomposition for the Gate-4 graph-derived tie-out. */
    terms?: readonly { fact: TaxFact; sign: 1 | -1 }[];
    clamp_zero?: boolean;
  }): TaxFact;
}

export function makeEmitter(input: EmitterHost): Emitter {
  const facts: TaxFact[] = [];
  const calculations: Calculation[] = [];
  return {
    facts,
    calculations,
    emit({ concept, jurisdiction, inputs, formula_ref, rule_version, steps, value, taxpayer_scope, terms, clamp_zero }) {
      const rounded = value.roundToDollar();
      const fact_id = derivedFactId(input.taxpayer_id, input.tax_year, concept);
      // calc_id equally carries the taxpayer — calculations.calc_id is a
      // global primary key with the same cross-client collision otherwise.
      const calc_id = `calc:${input.taxpayer_id}:${rule_version}:${concept}`;
      const fact: TaxFact = {
        fact_id,
        taxpayer_id: input.taxpayer_id,
        concept,
        tax_year: input.tax_year,
        jurisdiction,
        taxpayer_scope: taxpayer_scope ?? 'primary',
        value: rounded,
        unit: 'USD',
        status: 'confirmed',
        confidence: 1,
        derivation: calc_id,
      };
      const calc: Calculation = {
        calc_id,
        taxpayer_id: input.taxpayer_id,
        concept,
        output_fact_id: fact_id,
        rule_version,
        inputs: inputs.map((f) => f.fact_id),
        formula_ref,
        steps: [...steps, `round_half_up(${value.toString()}) = ${rounded.toString()}`],
        value: rounded,
        ...(terms ? { terms: terms.map((t) => ({ fact_id: t.fact.fact_id, concept: t.fact.concept, sign: t.sign })) } : {}),
        ...(clamp_zero ? { clamp_zero: true } : {}),
      };
      facts.push(fact);
      calculations.push(calc);
      return fact;
    },
  };
}

/** Sourced facts for a concept (confirmed only), deterministic order. */
export function sourcedFacts(input: EmitterHost, concept: string): TaxFact[] {
  return input.facts
    .filter((f) => f.concept === concept && f.derivation === undefined && f.status === 'confirmed')
    .sort((a, b) => a.fact_id.localeCompare(b.fact_id));
}

/** Sum of sourced facts for a concept; each component rounded first (kernel owns rounding). */
export function sumOfConcept(
  input: EmitterHost,
  concept: string,
): { total: Money; inputs: TaxFact[]; steps: string[] } {
  const inputs = sourcedFacts(input, concept);
  const rounded = inputs.map((f) => f.value.roundToDollar());
  const total = Money.sum(rounded);
  const steps =
    inputs.length === 0
      ? [`${concept}: no confirmed facts → 0`]
      : inputs.map((f, i) => `${concept} += ${rounded[i]?.toString() ?? '0'} (${f.fact_id})`);
  return { total, inputs, steps };
}
