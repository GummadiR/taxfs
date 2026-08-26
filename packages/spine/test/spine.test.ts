/**
 * In-memory–specific spine tests (exact audit action sequences, app-level
 * log shape). The backend-agnostic behavior lives in contract.suite.ts and
 * runs against BOTH backends.
 */
import { describe, expect, it } from 'vitest';
import { Money, type Calculation, type Clock, type TaxFact } from '@taxfs/shared';
import { InMemorySpine } from '@taxfs/spine';

const clock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };
const TP = 'tp-1';
const YEAR = 2025;

function newSpine(): InMemorySpine {
  return new InMemorySpine(clock, 'test');
}

async function seedSourcedFact(spine: InMemorySpine, factId = 'f-wages', value = '60000'): Promise<void> {
  await spine.registerSource({
    source_id: 's-w2',
    taxpayer_id: TP,
    type: 'W-2',
    tax_year: YEAR,
    fields: { box1: value },
    ocr_confidence: 0.99,
    raw_ref: 'blob://s-w2',
  });
  await spine.putSourceFact({
    fact_id: factId,
    taxpayer_id: TP,
    concept: 'income.wages',
    tax_year: YEAR,
    jurisdiction: ['FED', 'IL'],
    taxpayer_scope: 'primary',
    value: Money.fromString(value),
    confidence: 0.99,
    provenance: [{ source_id: 's-w2', source_field: 'box1' }],
  });
}

function derived(factId: string, concept: string, value: string): TaxFact {
  return {
    fact_id: factId,
    taxpayer_id: TP,
    concept,
    tax_year: YEAR,
    jurisdiction: ['FED'],
    taxpayer_scope: 'primary',
    value: Money.fromString(value),
    unit: 'USD',
    status: 'confirmed',
    confidence: 1,
  };
}

function calc(calcId: string, concept: string, out: string, inputs: string[], value: string): Calculation {
  return {
    calc_id: calcId,
    taxpayer_id: TP,
    concept,
    output_fact_id: out,
    rule_version: '2025.FED.0.0.1-PLACEHOLDER',
    inputs,
    formula_ref: `test.${concept}`,
    steps: [`${concept} = f(${inputs.join(', ')})`],
    value: Money.fromString(value),
  };
}

/** f-wages → d-total → d-tax */
async function seedTwoLevelGraph(spine: InMemorySpine): Promise<void> {
  await seedSourcedFact(spine);
  await spine.confirmFact('f-wages');
  await spine.commitComputation({
    computedFacts: [derived('d-total', 'fed.total_income', '60000'), derived('d-tax', 'fed.tax.total', '5700')],
    calculations: [
      calc('c-total', 'fed.total_income', 'd-total', ['f-wages'], '60000'),
      calc('c-tax', 'fed.tax.total', 'd-tax', ['d-total'], '5700'),
    ],
  });
}

describe('audit log (append-only, every mutation, app-level actions)', () => {
  it('writes an audit row for every mutation and gate run, in order', async () => {
    const spine = newSpine();
    await seedTwoLevelGraph(spine);
    await spine.appendGateRun({
      taxpayer_id: TP,
      gate: 2,
      jurisdiction: 'FED',
      rule_version: 'rv',
      result: 'pass',
      findings: [],
      consumed_fact_ids: ['f-wages'],
    });
    const actions = (await spine.inspect()).auditLog.map((e) => e.action);
    expect(actions).toEqual([
      'source.registered',
      'fact.created',
      'fact.confirmed',
      'fact.created',
      'calculation.recorded',
      'fact.created',
      'calculation.recorded',
      'gate_run.appended',
    ]);
    const seqs = (await spine.inspect()).auditLog.map((e) => e.seq);
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('records old and new values on mutation', async () => {
    const spine = newSpine();
    await seedSourcedFact(spine);
    await spine.putSourceFact({
      fact_id: 'f-wages',
      taxpayer_id: TP,
      concept: 'income.wages',
      tax_year: YEAR,
      jurisdiction: ['FED', 'IL'],
      taxpayer_scope: 'primary',
      value: Money.fromString('65000'),
      confidence: 1,
      provenance: [{ source_id: 's-w2', source_field: 'box1' }],
      confirmed: true,
    });
    const mutation = (await spine.inspect()).auditLog.find((e) => e.action === 'fact.mutated');
    expect(mutation?.details['old_value']).toBe('60000');
    expect(mutation?.details['new_value']).toBe('65000');
  });
});

describe('staleness gate-reopen scoping (F2 regression)', () => {
  it('never reopens another taxpayer’s gates, even if their runs reference the same fact ids', async () => {
    const spine = newSpine();
    await seedTwoLevelGraph(spine);
    await spine.appendGateRun({
      taxpayer_id: TP, gate: 2, jurisdiction: 'FED', rule_version: 'rv',
      result: 'pass', findings: [], consumed_fact_ids: ['f-wages'],
    });
    // A different tenant's run that (pathologically) lists the same fact id.
    await spine.appendGateRun({
      taxpayer_id: 'tp-other', gate: 4, jurisdiction: 'FED', rule_version: 'rv',
      result: 'pass', findings: [], consumed_fact_ids: ['f-wages'],
    });
    const impact = await spine.markStale('f-wages');
    expect(impact.reopened_gates).toEqual([{ gate: 2, jurisdiction: 'FED' }]);
  });
});

describe('error messages (in-memory reference)', () => {
  it('names the violated invariant', async () => {
    const spine = newSpine();
    await seedSourcedFact(spine);
    await expect(
      spine.commitComputation({
        computedFacts: [derived('f-wages', 'income.wages', '1')],
        calculations: [calc('c-bad', 'income.wages', 'f-wages', [], '1')],
      }),
    ).rejects.toThrow(/sourced/);
    await expect(spine.confirmFact('nope')).rejects.toThrow(/not found/);
    await expect(spine.markStale('nope')).rejects.toThrow(/not found/);
  });
});
