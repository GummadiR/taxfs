/**
 * E.7 eval — Categorization (STEP-2 scope: fixture-tested only, no UI).
 * Closed taxonomy, confidence floor → uncategorized queue, override-note
 * requirement.
 */
import { describe, expect, it } from 'vitest';
import {
  recordCategoryOverride,
  runCategorization,
  type CategorizationInput,
  type CategorizationOutput,
  type CategoryOverride,
} from '@taxfs/agents';
import { makeRig } from './helpers.js';

const INPUT: CategorizationInput = {
  txns: [
    { txn_id: 't1', date: '2025-03-04', payee: 'Staples', amount: '84.12', memo: 'toner' },
    { txn_id: 't2', date: '2025-03-09', payee: 'Blue Bottle', amount: '6.50', memo: '' },
  ],
  taxonomy: ['expense.office_supplies', 'expense.meals', 'personal.spending'],
};

function goodOutput(): CategorizationOutput {
  return {
    suggestions: [
      { txn_id: 't1', suggested_concept: 'expense.office_supplies', rationale: 'office retailer + toner memo', confidence: 0.93, alternates: [] },
      { txn_id: 't2', suggested_concept: 'personal.spending', rationale: 'coffee purchase, no business memo', confidence: 0.55, alternates: ['expense.meals'] },
    ],
  };
}

describe('categorization eval (E.3 / E.7)', () => {
  it('golden: suggests from the closed taxonomy; low-confidence lands in the uncategorized queue', async () => {
    const rig = makeRig({ categorization: () => JSON.stringify(goodOutput()) });
    const run = await runCategorization(rig.deps, INPUT);
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    const byId = new Map(run.output.suggestions.map((s) => [s.txn_id, s]));
    expect(byId.get('t1')?.suggested_concept).toBe('expense.office_supplies');
    // 0.55 < floor 0.7 ⇒ uncategorized, original suggestion demoted to alternate
    expect(byId.get('t2')?.suggested_concept).toBe('uncategorized');
    expect(byId.get('t2')?.alternates).toContain('personal.spending');
  });

  it('rejects invented categories (closed taxonomy)', async () => {
    const invented = goodOutput();
    invented.suggestions[0]!.suggested_concept = 'expense.definitely_deductible_stuff';
    const rig = makeRig({ categorization: () => JSON.stringify(invented) });
    const run = await runCategorization(rig.deps, INPUT);
    expect(run.status).toBe('rejected');
    if (run.status === 'rejected') {
      expect(run.issues.some((i) => i.message.includes('closed taxonomy'))).toBe(true);
    }
  });

  it('rejects a suggestion set that is not 1:1 with the input transactions', async () => {
    const dropped = goodOutput();
    dropped.suggestions.pop();
    const rig = makeRig({ categorization: () => JSON.stringify(dropped) });
    const run = await runCategorization(rig.deps, INPUT);
    expect(run.status).toBe('rejected');
  });

  it('override of a personal flag to a business deduction requires a business-purpose note', () => {
    const log: CategoryOverride[] = [];
    expect(() =>
      recordCategoryOverride(log, { txn_id: 't2', from_concept: 'personal.spending', to_concept: 'expense.meals' }),
    ).toThrow(/business-purpose note/);
    recordCategoryOverride(log, {
      txn_id: 't2',
      from_concept: 'personal.spending',
      to_concept: 'expense.meals',
      business_purpose_note: 'coffee meeting with client re: Q2 statement of work',
    });
    expect(log).toHaveLength(1);
    // non-personal→business overrides do not demand a note
    recordCategoryOverride(log, { txn_id: 't1', from_concept: 'expense.office_supplies', to_concept: 'personal.spending' });
    expect(log).toHaveLength(2);
  });
});
