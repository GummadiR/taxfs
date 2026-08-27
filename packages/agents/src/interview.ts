/**
 * E.2 — Interview/Organizer agent. Consumes the DETERMINISTIC fact-gap
 * report; the agent phrases and orders only — it never decides what is
 * needed. Every question carries why_asked.
 *
 * Personal-use pivot: the anti-coaching verbatim-template constraint is
 * removed — dynamic phrasing of attestation questions is allowed (the fixed
 * templates remain available as suggested wording). Attestation answers
 * still MUST route to the Attested Determinations store (flag enforced).
 */
import {
  runAgent,
  type AgentDefinition,
  type AgentRunDeps,
  type AgentRunResult,
  type SemanticIssue,
} from '@taxfs/shared';
import type { FactGap } from './gaps';
import type { QuestionTemplate } from './rulestore';

export const INTERVIEW_AGENT_ID = 'interview';

export interface InterviewInput {
  gaps: FactGap[];
  templates: QuestionTemplate[];
  /** Concepts already confirmed — the never-re-ask fence. */
  confirmed_concepts: string[];
}

export interface InterviewQuestion {
  question_id: string;
  text: string;
  answer_type: 'bool' | 'choice' | 'amount' | 'date' | 'text';
  maps_to_concept: string;
  why_asked: string; // gap_id
  attestation: boolean;
}

export interface InterviewOutput {
  questions: InterviewQuestion[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const interviewAgent: AgentDefinition<InterviewInput, InterviewOutput> = {
  id: INTERVIEW_AGENT_ID,
  buildMessages: (input) => [
    {
      role: 'system',
      content:
        'Order and phrase the next-best questions for the gap report as JSON {questions:[{question_id,text,answer_type,maps_to_concept,why_asked,attestation}]}. ' +
        'why_asked must be a gap_id from the report. Questions for attestation gaps MUST set attestation=true; the fixed templates are suggested wording you may adapt.',
    },
    {
      role: 'user',
      content: JSON.stringify({
        gaps: input.gaps,
        templates: input.templates.map((t) => ({
          template_id: t.template_id,
          text: t.text,
          answer_type: t.answer_type,
          attestation: t.attestation,
          maps_to: t.maps_to,
        })),
      }),
    },
  ],
  validateSchema: (candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate['questions'])) {
      return { ok: false, issues: [{ message: 'expected { questions: [...] }' }] };
    }
    const issues: SemanticIssue[] = [];
    const answerTypes = ['bool', 'choice', 'amount', 'date', 'text'];
    for (const [i, q] of candidate['questions'].entries()) {
      if (
        !isRecord(q) ||
        typeof q['question_id'] !== 'string' ||
        typeof q['text'] !== 'string' ||
        typeof q['maps_to_concept'] !== 'string' ||
        typeof q['why_asked'] !== 'string' ||
        typeof q['attestation'] !== 'boolean' ||
        !answerTypes.includes(String(q['answer_type']))
      ) {
        issues.push({ field: `questions[${i}]`, message: 'question shape invalid' });
      }
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: candidate as unknown as InterviewOutput };
  },
  validateSemantic: (out, input) => {
    const issues: SemanticIssue[] = [];
    const gapById = new Map(input.gaps.map((g) => [g.gap_id, g]));
    const covered = new Set<string>();
    for (const q of out.questions) {
      const gap = gapById.get(q.why_asked);
      if (!gap) {
        issues.push({ field: q.question_id, message: `why_asked "${q.why_asked}" is not a gap_id — questions cannot be invented` });
        continue;
      }
      if (covered.has(gap.gap_id)) {
        issues.push({ field: q.question_id, message: `gap ${gap.gap_id} asked twice` });
      }
      covered.add(gap.gap_id);
      if (input.confirmed_concepts.includes(q.maps_to_concept)) {
        issues.push({ field: q.question_id, message: `re-asks confirmed concept ${q.maps_to_concept}` });
      }
      if (gap.attestation_template_id !== undefined) {
        const template = input.templates.find((t) => t.template_id === gap.attestation_template_id);
        if (!template) {
          issues.push({ field: q.question_id, message: `unknown template ${gap.attestation_template_id}` });
        } else if (template.attestation && !q.attestation) {
          // Phrasing is free (personal-use pivot removed the verbatim
          // constraint), but the routing flag is load-bearing evidence flow.
          issues.push({ field: q.question_id, message: 'attestation flag dropped — answer must route to the Attested Determinations store' });
        }
      }
    }
    for (const gap of input.gaps) {
      if (!covered.has(gap.gap_id)) {
        issues.push({ message: `gap ${gap.gap_id} not covered by any question (gap-coverage)` });
      }
    }
    return issues;
  },
};

export async function runInterview(
  deps: AgentRunDeps,
  input: InterviewInput,
): Promise<AgentRunResult<InterviewOutput>> {
  return runAgent(interviewAgent, input, deps);
}
