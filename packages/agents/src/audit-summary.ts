/**
 * E.5 — Audit-Summary agent. Renders Gate-5 findings as a readable risk
 * narrative with 1:1 finding fidelity: it cannot add, drop, or re-rank
 * items (ordering comes from the deterministic profile).
 *
 * Personal-use pivot: the neutral-statistical-framing constraint is
 * removed — explicit positional recommendations ("claim X", "disclose on
 * 8275") are allowed. Still enforced via banned-vocab.ts: no immunity
 * promises, no numeric risk scores, no outcome promises — those protect
 * the owner, not consumers.
 */
import {
  runAgent,
  type AgentDefinition,
  type AgentRunDeps,
  type AgentRunResult,
  type AuthorityGrade,
  type SemanticIssue,
} from '@taxfs/shared';
import { checkBannedVocabulary } from './banned-vocab';

export const AUDIT_SUMMARY_AGENT_ID = 'audit_summary';

export interface AuditSummaryFinding {
  finding_id: string;
  severity: string;
  authority_grade?: AuthorityGrade;
  message: string;
  fix_ref?: string;
  defense_artifact_ref?: string;
}

export interface AuditSummaryInput {
  findings: AuditSummaryFinding[];
}

export interface AuditSummaryItem {
  finding_id: string;
  plain_risk: string;
  plain_fix: string;
  authority_note: string;
}

export interface AuditSummaryOutput {
  overview_text: string;
  items: AuditSummaryItem[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const auditSummaryAgent: AgentDefinition<AuditSummaryInput, AuditSummaryOutput> = {
  id: AUDIT_SUMMARY_AGENT_ID,
  buildMessages: (input) => [
    {
      role: 'system',
      content:
        'Render the finding set as JSON {overview_text, items:[{finding_id, plain_risk, plain_fix, authority_note}]}. ' +
        'Exactly one item per finding, in the given order. Direct positional recommendations are welcome; never promise audit immunity, never use numeric risk scores.',
    },
    { role: 'user', content: JSON.stringify(input) },
  ],
  validateSchema: (candidate) => {
    if (!isRecord(candidate) || typeof candidate['overview_text'] !== 'string' || !Array.isArray(candidate['items'])) {
      return { ok: false, issues: [{ message: 'expected { overview_text, items: [...] }' }] };
    }
    const issues: SemanticIssue[] = [];
    for (const [i, item] of candidate['items'].entries()) {
      if (
        !isRecord(item) ||
        typeof item['finding_id'] !== 'string' ||
        typeof item['plain_risk'] !== 'string' ||
        typeof item['plain_fix'] !== 'string' ||
        typeof item['authority_note'] !== 'string'
      ) {
        issues.push({ field: `items[${i}]`, message: 'item shape invalid' });
      }
    }
    if (issues.length > 0) return { ok: false, issues };
    return { ok: true, value: candidate as unknown as AuditSummaryOutput };
  },
  validateSemantic: (out, input) => {
    const issues: SemanticIssue[] = [];
    const expected = input.findings.map((f) => f.finding_id);
    const got = out.items.map((i) => i.finding_id);
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      issues.push({
        message: `fidelity violation: items must match findings 1:1 IN ORDER (expected [${expected.join(', ')}], got [${got.join(', ')}]) — no add/drop/re-rank`,
      });
    }
    const allText = [out.overview_text, ...out.items.flatMap((i) => [i.plain_risk, i.plain_fix, i.authority_note])].join('\n');
    for (const v of checkBannedVocabulary(allText)) {
      issues.push({ message: `banned vocabulary: "${v.excerpt.trim()}" — ${v.reason}` });
    }
    return issues;
  },
};

export async function runAuditSummary(
  deps: AgentRunDeps,
  input: AuditSummaryInput,
): Promise<AgentRunResult<AuditSummaryOutput>> {
  return runAgent(auditSummaryAgent, input, deps);
}
