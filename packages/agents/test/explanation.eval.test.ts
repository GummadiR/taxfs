/**
 * E.7 eval — Explanation: citation validity must be 100%; nonexistent
 * citation ⇒ reject; verbatim rule text returned alongside every paraphrase.
 */
import { describe, expect, it } from 'vitest';
import { runExplanation, type ExplanationInput, type ExplanationOutput } from '@taxfs/agents';
import { loadAuthority, makeRig } from './helpers.js';

const store = loadAuthority();

const INPUT: ExplanationInput = {
  subject_ref: 'd:tp-demo:2025:fed.refund_or_due',
  context_lines: [
    'fed.refund_or_due = 80 ← FED.1040.REFUND_OR_DUE',
    'fed.payments.total = 6000 ← FED.1040.PAYMENTS (W-2 box 2)',
    'fed.tax_after_credits = 5920 ← FED.1040.TAX_AFTER_CREDITS',
  ],
  candidate_rules: store
    .candidatesFor(['FED.1040.REFUND_OR_DUE', 'FED.1040.PAYMENTS', 'FED.1040.TAX_AFTER_CREDITS'])
    .map((r) => ({ rule_id: r.rule_id, citation: r.citation })),
};

function goodOutput(): ExplanationOutput {
  return {
    subject_ref: INPUT.subject_ref,
    explanation_text:
      'Your federal refund of $80 is the difference between what was already paid in ($6,000 — this came from Box 2 of your W-2) and the tax computed on your income ($5,920).',
    cited_rule_ids: ['IRC-31-PLACEHOLDER'],
    reading_level: 'plain',
  };
}

describe('explanation eval (E.4 / E.7)', () => {
  it('golden: paraphrase with valid citations + verbatim rule text alongside', async () => {
    const rig = makeRig({ explanation: () => JSON.stringify(goodOutput()) });
    const run = await runExplanation(rig.deps, store, INPUT);
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    expect(run.result.explanation.cited_rule_ids).toEqual(['IRC-31-PLACEHOLDER']);
    expect(run.result.verbatim).toHaveLength(1);
    expect(run.result.verbatim[0]?.citation).toMatch(/IRC §31/);
    expect(run.result.verbatim[0]?.verbatim_text.length).toBeGreaterThan(0);
  });

  it('citation validity is 100%: every cited id exists in the store', async () => {
    const rig = makeRig({ explanation: () => JSON.stringify(goodOutput()) });
    const run = await runExplanation(rig.deps, store, INPUT);
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    for (const id of run.result.explanation.cited_rule_ids) {
      expect(store.has(id)).toBe(true);
    }
  });

  it('rejects a hallucinated citation', async () => {
    const fake = goodOutput();
    fake.cited_rule_ids = ['IRC-9999-IMAGINED'];
    const rig = makeRig({ explanation: () => JSON.stringify(fake) });
    const run = await runExplanation(rig.deps, store, INPUT);
    expect(run.status).toBe('rejected');
    if (run.status === 'rejected') {
      expect(run.issues.some((i) => i.message.includes('does not exist'))).toBe(true);
    }
  });

  it('rejects an uncited explanation (no-invention)', async () => {
    const uncited = goodOutput();
    uncited.cited_rule_ids = [];
    const rig = makeRig({ explanation: () => JSON.stringify(uncited) });
    const run = await runExplanation(rig.deps, store, INPUT);
    expect(run.status).toBe('rejected');
  });

  it('rejects subject drift', async () => {
    const drifted = goodOutput();
    drifted.subject_ref = 'something-else';
    const rig = makeRig({ explanation: () => JSON.stringify(drifted) });
    const run = await runExplanation(rig.deps, store, INPUT);
    expect(run.status).toBe('rejected');
  });
});
