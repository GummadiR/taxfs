/**
 * E.4 — Explanation agent. Paraphrases a lineage or finding in plain
 * English. HARD RULE: the law comes only from the rule store's verified
 * text — cited rule_ids are machine-checked to exist; a nonexistent
 * citation rejects the output. The verbatim rule text + citation is
 * returned alongside every paraphrase ("show the actual rule",
 * OPR 2026-19 posture).
 */
import {
  runAgent,
  type AgentDefinition,
  type AgentRunDeps,
  type SemanticIssue,
} from '@taxfs/shared';
import type { AuthorityStore } from './rulestore';

export const EXPLANATION_AGENT_ID = 'explanation';

export interface ExplanationInput {
  subject_ref: string; // fact_id or finding_id
  /** Deterministic context: lineage steps or the finding text. */
  context_lines: string[];
  /** Candidate rules (from the AuthorityStore) the paraphrase may cite. */
  candidate_rules: { rule_id: string; citation: string }[];
}

export interface ExplanationOutput {
  subject_ref: string;
  explanation_text: string;
  cited_rule_ids: string[];
  reading_level: 'plain' | 'standard';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function explanationAgentFor(store: AuthorityStore): AgentDefinition<ExplanationInput, ExplanationOutput> {
  return {
    id: EXPLANATION_AGENT_ID,
    buildMessages: (input) => [
      {
        role: 'system',
        content:
          'Explain the subject in plain English for a non-expert as JSON {subject_ref, explanation_text, cited_rule_ids, reading_level}. ' +
          'Numbers must be traced to their source lines. cited_rule_ids may ONLY reference the provided candidate rules — the law never comes from your weights.',
      },
      { role: 'user', content: JSON.stringify(input) },
    ],
    validateSchema: (candidate) => {
      if (
        !isRecord(candidate) ||
        typeof candidate['subject_ref'] !== 'string' ||
        typeof candidate['explanation_text'] !== 'string' ||
        !Array.isArray(candidate['cited_rule_ids']) ||
        !candidate['cited_rule_ids'].every((x) => typeof x === 'string') ||
        !['plain', 'standard'].includes(String(candidate['reading_level']))
      ) {
        return { ok: false, issues: [{ message: 'expected {subject_ref, explanation_text, cited_rule_ids[], reading_level}' }] };
      }
      return { ok: true, value: candidate as unknown as ExplanationOutput };
    },
    validateSemantic: (out, input) => {
      const issues: SemanticIssue[] = [];
      if (out.subject_ref !== input.subject_ref) {
        issues.push({ message: 'subject_ref drifted from the request' });
      }
      if (out.cited_rule_ids.length === 0) {
        issues.push({ message: 'no-invention: an explanation must cite at least one rule_id from the store' });
      }
      for (const id of out.cited_rule_ids) {
        if (!store.has(id)) {
          issues.push({ message: `cited rule_id "${id}" does not exist in the rule store — rejected (hallucinated law)` });
        }
      }
      return issues;
    },
  };
}

export interface ExplanationResult {
  explanation: ExplanationOutput;
  /** Verbatim rule text + citations, displayed alongside the paraphrase. */
  verbatim: { rule_id: string; citation: string; verbatim_text: string }[];
}

export async function runExplanation(
  deps: AgentRunDeps,
  store: AuthorityStore,
  input: ExplanationInput,
): Promise<{ status: 'ok'; result: ExplanationResult } | { status: 'rejected'; issues: SemanticIssue[] }> {
  const run = await runAgent(explanationAgentFor(store), input, deps);
  if (run.status === 'rejected') return { status: 'rejected', issues: run.issues };
  return {
    status: 'ok',
    result: { explanation: run.output, verbatim: store.verbatim(run.output.cited_rule_ids) },
  };
}
