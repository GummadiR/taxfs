/**
 * Discovery agent (Blueprint §6, new): cross-document and cross-year
 * prompts — "box 12 W present, no coverage type entered", "interest income
 * last year, none this year". It emits QUESTIONS ONLY and cannot write:
 * this module imports no spine, no store, no confirm path — a question's
 * only exit is the operator reading it and going to intake themselves. The
 * wall is asserted by a source-scan test, the same way the money-lint
 * proves its scope.
 *
 * The DETECTORS are deterministic code over facts/sources/history; the
 * agent's language pass phrases them. Semantic validation rejects any
 * output that asserts a dollar value ("$1,234", "= 500") or answers its own
 * question — findings may cite counts and years, never return amounts.
 */
import { C, type AgentRunDeps, type SourceDoc, type TaxFact } from '@taxfs/shared';
import { runAgent, type AgentDefinition, type SchemaResult, type SemanticIssue } from '@taxfs/shared';

export const DISCOVERY_AGENT_ID = 'discovery';

export interface DiscoverySignal {
  id: string;
  kind: 'missing_companion_doc' | 'prior_year_gap' | 'large_swing';
  about_concepts: string[];
  /** Deterministic facts of the signal (counts/years — never dollar values). */
  detail: string;
}

export interface HistoryRow {
  tax_year: number;
  line: string;
  value: string;
}

export interface DiscoveryInput {
  tax_year: number;
  sources: readonly SourceDoc[];
  facts: readonly TaxFact[];
  history: readonly HistoryRow[];
}

/** Deterministic detectors. Pure; no I/O. */
export function detectSignals(input: DiscoveryInput): DiscoverySignal[] {
  const signals: DiscoverySignal[] = [];
  const hasConcept = (concept: string) => input.facts.some((f) => f.concept === concept);

  // (a) W-2 box 12 W (employer HSA) captured, but no coverage type entered —
  // the §223 limit cannot be picked without it.
  const hasBox12w = input.sources.some((s) => s.fields && 'box12w_hsa' in s.fields);
  // A missing coverage fact means the kernel assumed self-only (the
  // ACC-HSA-COVERAGE critic flags it too — this asks BEFORE gates run).
  if (hasBox12w && !hasConcept(C.HSA_FAMILY_COVERAGE)) {
    signals.push({
      id: 'hsa-coverage-missing',
      kind: 'missing_companion_doc',
      about_concepts: [C.CONTRIB_HSA_EMPLOYER],
      detail: 'a W-2 shows a box 12 code W HSA contribution, and no HSA coverage type has been entered',
    });
  }

  // (b) prior-year interest income, none captured this year.
  const priorInterest = input.history.some((h) => h.line === 'total_income');
  const hadInterestLastYear = input.history.some((h) => h.tax_year === input.tax_year - 1);
  if (priorInterest && hadInterestLastYear && !hasConcept(C.INTEREST)) {
    signals.push({
      id: 'interest-docs-missing',
      kind: 'prior_year_gap',
      about_concepts: [C.INTEREST],
      detail: `the ${input.tax_year - 1} return is on file and this year has no interest income captured yet`,
    });
  }

  // (c) prior-year AGI far above this year's captured total income so far.
  const priorAgi = input.history.find((h) => h.tax_year === input.tax_year - 1 && h.line === 'agi');
  const currentTotal = input.facts.find((f) => f.concept === C.FED_TOTAL_INCOME);
  if (priorAgi && currentTotal && Number(currentTotal.value.toString()) < Number(priorAgi.value) / 2) {
    signals.push({
      id: 'income-swing',
      kind: 'large_swing',
      about_concepts: [C.FED_TOTAL_INCOME],
      detail: `this year's captured income is far below the ${input.tax_year - 1} return's — documents may still be missing`,
    });
  }
  return signals;
}

export interface DiscoveryQuestion {
  id: string;
  text: string;
  about_concepts: string[];
}

export interface DiscoveryOutput {
  questions: DiscoveryQuestion[];
}

const VALUE_ASSERTION = /\$\s?\d|=\s?\d|\b\d{4,}\b(?!\s*(return|tax year|form|1040|1099))/i;

export const discoveryAgent: AgentDefinition<DiscoveryInput & { signals: DiscoverySignal[] }, DiscoveryOutput> = {
  id: DISCOVERY_AGENT_ID,
  buildMessages(input) {
    return [
      {
        role: 'system',
        content:
          'You phrase deterministic findings as short, plain questions for a tax-return operator. ' +
          'Emit ONLY questions. Never assert or suggest a dollar amount, never answer a question, never invent a topic ' +
          'beyond the given signals. Output JSON {"questions":[{"id":"<signal id>","text":"...?","about_concepts":[...]}]} ' +
          'with exactly one question per signal, same ids.',
      },
      { role: 'user', content: JSON.stringify({ tax_year: input.tax_year, signals: input.signals }) },
    ];
  },
  validateSchema(candidate): SchemaResult<DiscoveryOutput> {
    if (typeof candidate !== 'object' || candidate === null || !Array.isArray((candidate as { questions?: unknown }).questions)) {
      return { ok: false, issues: [{ field: 'questions', message: 'questions[] required' }] };
    }
    const questions = (candidate as { questions: unknown[] }).questions;
    for (const [i, q] of questions.entries()) {
      const qq = q as Partial<DiscoveryQuestion>;
      if (typeof qq.id !== 'string' || typeof qq.text !== 'string' || !Array.isArray(qq.about_concepts)) {
        return { ok: false, issues: [{ field: `questions[${i}]`, message: 'id, text, about_concepts required' }] };
      }
    }
    return { ok: true, value: candidate as DiscoveryOutput };
  },
  validateSemantic(value, input): SemanticIssue[] {
    const issues: SemanticIssue[] = [];
    const allowed = new Set(input.signals.map((s) => s.id));
    for (const q of value.questions) {
      if (!allowed.has(q.id)) {
        issues.push({ field: q.id, message: 'question invents a topic beyond the deterministic signals' });
      }
      if (!q.text.trim().endsWith('?')) {
        issues.push({ field: q.id, message: 'Discovery emits questions only' });
      }
      if (VALUE_ASSERTION.test(q.text)) {
        issues.push({ field: q.id, message: 'Discovery never asserts amounts — a question may cite years and counts only' });
      }
    }
    return issues;
  },
};

export interface DiscoveryRun {
  signals: DiscoverySignal[];
  questions: DiscoveryQuestion[];
  /** 'deterministic' when there was nothing to phrase (no agent call spent). */
  phrased_by: 'agent' | 'none';
}

export async function runDiscovery(deps: AgentRunDeps, input: DiscoveryInput): Promise<DiscoveryRun> {
  const signals = detectSignals(input);
  if (signals.length === 0) return { signals, questions: [], phrased_by: 'none' };
  const result = await runAgent(discoveryAgent, { ...input, signals }, deps);
  if (result.status === 'rejected') {
    // Refusal-safe fallback: the deterministic detail, phrased as a question
    // by template — never a silent drop of a real signal.
    return {
      signals,
      questions: signals.map((s) => ({
        id: s.id,
        text: `Heads up: ${s.detail} — is there a document or answer to add?`,
        about_concepts: s.about_concepts,
      })),
      phrased_by: 'none',
    };
  }
  return { signals, questions: result.output.questions, phrased_by: 'agent' };
}
