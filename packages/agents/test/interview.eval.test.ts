/**
 * E.7 eval — Interview: gap coverage, no re-ask, why_asked on every
 * question. Personal-use pivot: dynamic phrasing of attestation questions
 * is allowed (verbatim-template constraint removed); the attestation
 * ROUTING flag remains mandatory.
 */
import { describe, expect, it } from 'vitest';
import { runInterview, type FactGap, type InterviewInput, type InterviewOutput } from '@taxfs/agents';
import { loadTemplates, makeRig, userContent } from './helpers.js';

const templates = loadTemplates();
const residencyTemplate = templates.find((t) => t.determination === 'il_full_year_residency')!;

const GAPS: FactGap[] = [
  {
    gap_id: 'gap-doc-0',
    kind: 'missing_doc',
    concept: 'income.interest',
    detail: '1099-INT from First Bank (1000) on transcript but not among confirmed facts',
  },
  {
    gap_id: 'gap-att-residency',
    kind: 'attestation_required',
    concept: residencyTemplate.maps_to,
    detail: 'Full-year IL residency not captured',
    attestation_template_id: residencyTemplate.template_id,
  },
];

const INPUT: InterviewInput = {
  gaps: GAPS,
  templates,
  confirmed_concepts: ['income.wages', 'payments.fed.withholding'],
};

function goodOutput(): InterviewOutput {
  return {
    questions: [
      {
        question_id: 'q1',
        text: 'We found a 1099-INT from First Bank on your IRS transcript. Can you add it?',
        answer_type: 'bool',
        maps_to_concept: 'income.interest',
        why_asked: 'gap-doc-0',
        attestation: false,
      },
      {
        question_id: 'q2',
        text: residencyTemplate.text, // template used as suggested wording
        answer_type: residencyTemplate.answer_type,
        maps_to_concept: residencyTemplate.maps_to,
        why_asked: 'gap-att-residency',
        attestation: true,
      },
    ],
  };
}

describe('interview eval (E.2 / E.7)', () => {
  it('golden: covers every gap, why_asked everywhere', async () => {
    const rig = makeRig({ interview: () => JSON.stringify(goodOutput()) });
    const run = await runInterview(rig.deps, INPUT);
    expect(run.status).toBe('ok');
    if (run.status !== 'ok') return;
    // gap coverage: every gap covered exactly once
    expect(run.output.questions.map((q) => q.why_asked).sort()).toEqual(['gap-att-residency', 'gap-doc-0']);
    // no re-ask: no question maps to a confirmed concept
    for (const q of run.output.questions) {
      expect(INPUT.confirmed_concepts).not.toContain(q.maps_to_concept);
    }
  });

  it('accepts a dynamically phrased determination question (personal-use: anti-coaching removed)', async () => {
    const rephrased = goodOutput();
    rephrased.questions[1]!.text =
      'Did you live in Illinois for more than 183 days? (If yes, you qualify as a resident.)';
    const rig = makeRig({ interview: () => JSON.stringify(rephrased) });
    const run = await runInterview(rig.deps, INPUT);
    expect(run.status).toBe('ok');
  });

  it('still rejects a dropped attestation flag (routing to Attested Determinations is load-bearing)', async () => {
    const unrouted = goodOutput();
    unrouted.questions[1]!.attestation = false;
    const rig = makeRig({ interview: () => JSON.stringify(unrouted) });
    const run = await runInterview(rig.deps, INPUT);
    expect(run.status).toBe('rejected');
    if (run.status === 'rejected') {
      expect(run.issues.some((i) => i.message.includes('attestation flag dropped'))).toBe(true);
    }
  });

  it('rejects invented questions (why_asked must be a gap_id)', async () => {
    const invented = goodOutput();
    invented.questions.push({
      question_id: 'q3',
      text: 'Do you have any crypto income?',
      answer_type: 'bool',
      maps_to_concept: 'income.crypto',
      why_asked: 'gap-imagined',
      attestation: false,
    });
    const rig = makeRig({ interview: () => JSON.stringify(invented) });
    const run = await runInterview(rig.deps, INPUT);
    expect(run.status).toBe('rejected');
  });

  it('rejects re-asking a confirmed fact', async () => {
    const reask = goodOutput();
    reask.questions[0]!.maps_to_concept = 'income.wages'; // already confirmed
    const rig = makeRig({ interview: () => JSON.stringify(reask) });
    const run = await runInterview(rig.deps, INPUT);
    expect(run.status).toBe('rejected');
    if (run.status === 'rejected') {
      expect(run.issues.some((i) => i.message.includes('re-asks'))).toBe(true);
    }
  });

  it('rejects dropped gaps (coverage is mandatory)', async () => {
    const dropped = goodOutput();
    dropped.questions.pop();
    const rig = makeRig({ interview: () => JSON.stringify(dropped) });
    const run = await runInterview(rig.deps, INPUT);
    expect(run.status).toBe('rejected');
    if (run.status === 'rejected') {
      expect(run.issues.some((i) => i.message.includes('gap-coverage'))).toBe(true);
    }
  });

  it('the agent sees gaps + templates only — phrasing input, not decision input', async () => {
    const rig = makeRig({ interview: (req) => {
      const payload = JSON.parse(userContent(req)) as { gaps: unknown[]; templates: unknown[] };
      expect(Object.keys(payload).sort()).toEqual(['gaps', 'templates']);
      return JSON.stringify(goodOutput());
    } });
    const run = await runInterview(rig.deps, INPUT);
    expect(run.status).toBe('ok');
  });
});
