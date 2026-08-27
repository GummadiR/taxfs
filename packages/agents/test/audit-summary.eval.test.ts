/**
 * E.7 eval — Audit-Summary: 1:1 finding fidelity (no add/drop/re-rank) +
 * banned-vocabulary rejection. Personal-use pivot: explicit positional
 * recommendations are allowed; immunity promises and numeric scores are
 * still rejected.
 */
import { describe, expect, it } from 'vitest';
import { runAuditSummary, type AuditSummaryInput, type AuditSummaryOutput } from '@taxfs/agents';
import { makeRig } from './helpers.js';

const INPUT: AuditSummaryInput = {
  findings: [
    {
      finding_id: 'fnd-0101',
      severity: 'Audit-Risk',
      message: '3 source amounts are exact multiples of 1000',
      fix_ref: 'fix://evidence/attach-exact-substantiation',
      defense_artifact_ref: 'defense://substantiation-index',
    },
    {
      finding_id: 'fnd-0102',
      severity: 'Audit-Risk',
      authority_grade: 'reasonable_basis',
      message: 'Position credits.sch3.total is graded reasonable-basis',
      fix_ref: 'fix://authority/review-position',
    },
  ],
};

function goodOutput(): AuditSummaryOutput {
  return {
    overview_text:
      'Two informational review items. Neither blocks filing; both describe patterns that draw attention per public IRS statistics, with the records that support each.',
    items: [
      {
        finding_id: 'fnd-0101',
        plain_risk: 'Several amounts are exact round numbers, a pattern that appears more often in estimated figures than documented ones.',
        plain_fix: 'Attaching the exact amounts from the underlying documents resolves this.',
        authority_note: 'Informational pattern check; no position of law involved.',
      },
      {
        finding_id: 'fnd-0102',
        plain_risk: 'One claimed credit rests on a reasonable-basis position, which is supportable but below the substantial-authority standard.',
        plain_fix: 'A Form 8275 disclosure is available for positions at this level.',
        authority_note: 'Authority grade: reasonable basis.',
      },
    ],
  };
}

describe('audit-summary eval (E.5 / E.7)', () => {
  it('golden: 1:1 fidelity in order, neutral informational language', async () => {
    const rig = makeRig({ audit_summary: () => JSON.stringify(goodOutput()) });
    const run = await runAuditSummary(rig.deps, INPUT);
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    expect(run.output.items.map((i) => i.finding_id)).toEqual(['fnd-0101', 'fnd-0102']);
  });

  it('rejects dropped findings', async () => {
    const dropped = goodOutput();
    dropped.items.pop();
    const rig = makeRig({ audit_summary: () => JSON.stringify(dropped) });
    const run = await runAuditSummary(rig.deps, INPUT);
    expect(run.status).toBe('rejected');
    if (run.status === 'rejected') expect(run.issues[0]?.message).toMatch(/fidelity/);
  });

  it('rejects added findings', async () => {
    const added = goodOutput();
    added.items.push({ finding_id: 'fnd-9999', plain_risk: 'x', plain_fix: 'y', authority_note: 'z' });
    const rig = makeRig({ audit_summary: () => JSON.stringify(added) });
    expect((await runAuditSummary(rig.deps, INPUT)).status).toBe('rejected');
  });

  it('rejects re-ranked findings (ordering comes from the deterministic profile)', async () => {
    const reranked = goodOutput();
    reranked.items.reverse();
    const rig = makeRig({ audit_summary: () => JSON.stringify(reranked) });
    expect((await runAuditSummary(rig.deps, INPUT)).status).toBe('rejected');
  });

  it.each([
    ['immunity promise', 'Fixing these makes your return audit-proof.'],
    ['numeric score', 'Your audit score is 87 out of 100.'],
  ])('rejects banned vocabulary: %s', async (_label, sentence) => {
    const banned = goodOutput();
    banned.overview_text = sentence;
    const rig = makeRig({ audit_summary: () => JSON.stringify(banned) });
    const run = await runAuditSummary(rig.deps, INPUT);
    expect(run.status).toBe('rejected');
    if (run.status === 'rejected') {
      expect(run.issues.some((i) => i.message.includes('banned vocabulary'))).toBe(true);
    }
  });

  it('accepts an explicit positional recommendation (personal-use: neutral-framing constraint removed)', async () => {
    const direct = goodOutput();
    direct.items[1]!.plain_fix =
      'You should claim this credit and disclose it on Form 8275 — the reasonable-basis position is worth taking with disclosure.';
    const rig = makeRig({ audit_summary: () => JSON.stringify(direct) });
    const run = await runAuditSummary(rig.deps, INPUT);
    expect(run.status).toBe('ok');
  });
});
