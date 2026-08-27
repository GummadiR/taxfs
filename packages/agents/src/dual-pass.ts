/**
 * Dual-pass extraction (Blueprint §6): CRITICAL fields (wages, withholding,
 * proceeds — the same tier that refuses batch confirm) are extracted TWICE,
 * independently, and must AGREE to arrive with a value. A disagreement
 * arrives flagged — no value, no suggestion, both readings shown — so the
 * operator types the number from the document instead of rubber-stamping
 * either pass. The mirror of the dual-kernel idea, applied to intake.
 *
 * Non-critical fields keep pass 1 (they already arrive below-threshold as
 * empty-with-suggestion when confidence is low).
 */
import type { AgentRunDeps } from '@taxfs/shared';
import { runExtraction, type DocImageStub, type ExtractionRun } from './extraction';
import type { ProposalInput } from './review';

export interface DualPassDisagreement {
  source_field: string;
  concept: string;
  pass1: string | null;
  pass2: string | null;
}

export interface DualPassRun {
  run: ExtractionRun;
  /** Critical fields where the two passes disagreed (also reflected in the
   *  proposals: value AND suggestion cleared, disagreement attached). */
  disagreements: DualPassDisagreement[];
}

function proposalValue(p: ProposalInput): string | null {
  return p.value ?? p.suggestion ?? null;
}

export async function runExtractionDualPass(
  deps: AgentRunDeps,
  doc: DocImageStub,
  taxpayer_id: string,
): Promise<DualPassRun> {
  const pass1 = await runExtraction(deps, doc, taxpayer_id);
  if (pass1.status !== 'ok') return { run: pass1, disagreements: [] };
  const pass2 = await runExtraction(deps, doc, taxpayer_id);
  if (pass2.status !== 'ok') {
    // A second pass that cannot even parse the document is itself a
    // disagreement about everything critical: flag every critical field.
    const disagreements = pass1.proposals
      .filter((p) => p.critical)
      .map((p) => ({ source_field: p.source_field, concept: p.concept, pass1: proposalValue(p), pass2: null }));
    return {
      run: {
        ...pass1,
        proposals: pass1.proposals.map((p) =>
          p.critical ? { ...p, value: null, suggestion: null, disagreement: { pass1: proposalValue(p), pass2: null } } : p,
        ),
      },
      disagreements,
    };
  }
  const secondByField = new Map(pass2.proposals.map((p) => [`${p.source_field}|${p.concept}`, p]));
  const disagreements: DualPassDisagreement[] = [];
  const proposals = pass1.proposals.map((p) => {
    if (!p.critical) return p;
    const twin = secondByField.get(`${p.source_field}|${p.concept}`);
    const v1 = proposalValue(p);
    const v2 = twin ? proposalValue(twin) : null;
    if (v1 === v2) return p;
    disagreements.push({ source_field: p.source_field, concept: p.concept, pass1: v1, pass2: v2 });
    return { ...p, value: null, suggestion: null, disagreement: { pass1: v1, pass2: v2 } };
  });
  return { run: { ...pass1, proposals }, disagreements };
}
