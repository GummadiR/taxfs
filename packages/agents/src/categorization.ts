/**
 * E.3 — Categorization agent. STEP-2 SCOPE (built with Sch C): specced and
 * fixture-tested now, no UI wiring. Suggests a tax category from the CLOSED
 * rule-store taxonomy; deduction-eligibility is NOT decided here — critics
 * decide; the agent only bins. Override of a personal-spending flag to a
 * business deduction requires a business-purpose note (see review.ts).
 */
import {
  runAgent,
  type AgentDefinition,
  type AgentRunDeps,
  type AgentRunResult,
  type SemanticIssue,
} from '@taxfs/shared';

export const CATEGORIZATION_AGENT_ID = 'categorization';

/** Below this, the suggestion lands in the "uncategorized" queue `(tuned)`. */
export const CATEGORIZATION_CONFIDENCE_FLOOR = 0.7;

export interface TxnRow {
  txn_id: string;
  date: string;
  payee: string;
  amount: string; // decimal string
  memo: string;
}

export interface CategorizationInput {
  txns: TxnRow[];
  /** Closed taxonomy from the rule store — the agent cannot invent a category. */
  taxonomy: string[];
}

export interface CategorySuggestion {
  txn_id: string;
  suggested_concept: string;
  rationale: string;
  confidence: number;
  alternates: string[];
}

export interface CategorizationOutput {
  suggestions: CategorySuggestion[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const categorizationAgent: AgentDefinition<CategorizationInput, CategorizationOutput> = {
  id: CATEGORIZATION_AGENT_ID,
  buildMessages: (input) => [
    {
      role: 'system',
      content:
        'Suggest a category for each transaction as JSON {suggestions:[{txn_id,suggested_concept,rationale,confidence,alternates}]}. ' +
        'suggested_concept MUST come from the provided taxonomy (or "uncategorized"). You bin; you never decide deductibility.',
    },
    { role: 'user', content: JSON.stringify(input) },
  ],
  validateSchema: (candidate) => {
    if (!isRecord(candidate) || !Array.isArray(candidate['suggestions'])) {
      return { ok: false, issues: [{ message: 'expected { suggestions: [...] }' }] };
    }
    const issues: SemanticIssue[] = [];
    for (const [i, s] of candidate['suggestions'].entries()) {
      if (
        !isRecord(s) ||
        typeof s['txn_id'] !== 'string' ||
        typeof s['suggested_concept'] !== 'string' ||
        typeof s['rationale'] !== 'string' ||
        typeof s['confidence'] !== 'number' ||
        !Array.isArray(s['alternates'])
      ) {
        issues.push({ field: `suggestions[${i}]`, message: 'suggestion shape invalid' });
      }
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: candidate as unknown as CategorizationOutput };
  },
  validateSemantic: (out, input) => {
    const issues: SemanticIssue[] = [];
    const closed = new Set([...input.taxonomy, 'uncategorized']);
    const inputIds = input.txns.map((t) => t.txn_id);
    const outIds = out.suggestions.map((s) => s.txn_id);
    if (JSON.stringify([...inputIds].sort()) !== JSON.stringify([...outIds].sort())) {
      issues.push({ message: 'suggestions must cover exactly the input transactions (1:1)' });
    }
    for (const s of out.suggestions) {
      if (!closed.has(s.suggested_concept)) {
        issues.push({ field: s.txn_id, message: `"${s.suggested_concept}" is outside the closed taxonomy — categories cannot be invented` });
      }
      for (const alt of s.alternates) {
        if (!closed.has(alt)) issues.push({ field: s.txn_id, message: `alternate "${alt}" outside the closed taxonomy` });
      }
    }
    return issues;
  },
};

/** Post-pass: below-floor suggestions land in the uncategorized queue. */
export function applyConfidenceFloor(output: CategorizationOutput): CategorizationOutput {
  return {
    suggestions: output.suggestions.map((s) =>
      s.confidence < CATEGORIZATION_CONFIDENCE_FLOOR
        ? { ...s, suggested_concept: 'uncategorized', alternates: [s.suggested_concept, ...s.alternates] }
        : s,
    ),
  };
}

export async function runCategorization(
  deps: AgentRunDeps,
  input: CategorizationInput,
): Promise<AgentRunResult<CategorizationOutput>> {
  const result = await runAgent(categorizationAgent, input, deps);
  if (result.status === 'ok') {
    return { ...result, output: applyConfidenceFloor(result.output) };
  }
  return result;
}
