/**
 * Review-pending store — THE ONLY DOOR INTO THE SPINE (E.6).
 *
 *   agent output → schema validation → semantic validation →
 *   review-pending store → user confirm → putSourceFact + confirmFact
 *
 * Agents never hold a spine reference; validated proposals wait here until
 * a human confirms. Tiered confirm (E.0 anti-click-fatigue): critical
 * fields (wage/withholding boxes) and low-confidence items ALWAYS route to
 * individual confirm — batchConfirm refuses them.
 */
import { Money, type EventBus, type Jurisdiction, type TaxpayerScope } from '@taxfs/shared';
import type { SpineBackend } from '@taxfs/spine';

export interface PendingFactProposal {
  proposal_id: string;
  taxpayer_id: string;
  tax_year: number;
  source_id: string;
  source_field: string;
  concept: string;
  jurisdiction: Jurisdiction[];
  taxpayer_scope: TaxpayerScope;
  /**
   * Confidence gating (E.0): below-threshold fields carry value=null and a
   * suggestion — presented empty-with-suggestion, never prefilled.
   */
  value: string | null;
  suggestion: string | null;
  confidence: number;
  /** Wage/withholding boxes and their kin: individual confirm only (E.1). */
  critical: boolean;
  /** High-visibility AI-extracted marker + source region for the review UI. */
  ai_marker: true;
  region?: { page: number; x: number; y: number; w: number; h: number };
  status: 'pending' | 'confirmed' | 'rejected';
}

export type ProposalInput = Omit<PendingFactProposal, 'proposal_id' | 'status' | 'ai_marker'>;

export class ReviewPendingStore {
  private readonly proposals = new Map<string, PendingFactProposal>();
  private seq = 0;

  constructor(
    private readonly spine: SpineBackend,
    private readonly bus?: EventBus,
  ) {}

  submit(inputs: ProposalInput[]): PendingFactProposal[] {
    return inputs.map((input) => {
      if (input.value !== null) Money.fromString(input.value); // must be a decimal string
      if (input.suggestion !== null) Money.fromString(input.suggestion);
      this.seq = this.seq + 1;
      const proposal: PendingFactProposal = {
        ...input,
        proposal_id: `prop-${String(this.seq).padStart(4, '0')}`,
        ai_marker: true,
        status: 'pending',
      };
      this.proposals.set(proposal.proposal_id, proposal);
      return proposal;
    });
  }

  pending(): PendingFactProposal[] {
    return [...this.proposals.values()].filter((p) => p.status === 'pending');
  }

  /**
   * Individual confirm — the FactConfirmed handoff (Gate 1). For
   * empty-with-suggestion items the user must supply the value.
   */
  async confirm(proposal_id: string, userValue?: string): Promise<void> {
    const p = this.proposals.get(proposal_id);
    if (!p) throw new Error(`proposal ${proposal_id} not found`);
    if (p.status !== 'pending') throw new Error(`proposal ${proposal_id} is ${p.status}`);
    const value = userValue ?? p.value;
    if (value === null) {
      throw new Error(
        `proposal ${proposal_id} is empty-with-suggestion (confidence ${p.confidence}); the user must type the value`,
      );
    }
    await this.spine.putSourceFact({
      fact_id: `f:${p.source_id}:${p.source_field}`,
      taxpayer_id: p.taxpayer_id,
      concept: p.concept,
      tax_year: p.tax_year,
      jurisdiction: p.jurisdiction,
      taxpayer_scope: p.taxpayer_scope,
      value: Money.fromString(value),
      confidence: p.confidence,
      provenance: [{ source_id: p.source_id, source_field: p.source_field }],
      confirmed: true,
    });
    this.proposals.set(proposal_id, { ...p, status: 'confirmed' });
    this.bus?.publish({ kind: 'FactConfirmed', fact_id: `f:${p.source_id}:${p.source_field}` });
  }

  /**
   * Batch confirm for very-high-confidence ROUTINE items only. Critical
   * fields and low-confidence items are refused — individual confirm keeps
   * the human-in-the-loop real, not theater (E.0).
   */
  async batchConfirm(proposal_ids: string[], routineConfidenceFloor = 0.97): Promise<void> {
    for (const id of proposal_ids) {
      const p = this.proposals.get(id);
      if (!p) throw new Error(`proposal ${id} not found`);
      if (p.critical) {
        throw new Error(`proposal ${id} is a critical field — individual confirm required (E.1)`);
      }
      if (p.confidence < routineConfidenceFloor || p.value === null) {
        throw new Error(`proposal ${id} is below the batch-confirm tier — individual confirm required`);
      }
    }
    for (const id of proposal_ids) await this.confirm(id);
  }

  reject(proposal_id: string): void {
    const p = this.proposals.get(proposal_id);
    if (!p) throw new Error(`proposal ${proposal_id} not found`);
    this.proposals.set(proposal_id, { ...p, status: 'rejected' });
  }

  /**
   * Drop every proposal (pending or otherwise) from a source — used when the
   * user deletes an uploaded document. Returns how many were removed.
   */
  discardBySource(source_id: string): number {
    let removed = 0;
    for (const [id, p] of this.proposals) {
      if (p.source_id === source_id) {
        this.proposals.delete(id);
        removed = removed + 1;
      }
    }
    return removed;
  }
}

/**
 * Categorization override rule (E.3): when a user overrides an AI
 * personal-spending flag to claim a business deduction, a contemporaneous
 * business-purpose note is REQUIRED — "private" logs are summonable; an
 * unexplained override trail reads as §6663 intent evidence, a documented
 * one is business intent.
 */
export interface CategoryOverride {
  txn_id: string;
  from_concept: string;
  to_concept: string;
  business_purpose_note: string;
}

export function recordCategoryOverride(
  log: CategoryOverride[],
  override: Omit<CategoryOverride, 'business_purpose_note'> & { business_purpose_note?: string },
): void {
  const personalToBusiness =
    override.from_concept.startsWith('personal.') && override.to_concept.startsWith('expense.');
  const note = override.business_purpose_note?.trim() ?? '';
  if (personalToBusiness && note.length === 0) {
    throw new Error(
      `override of AI personal-spending flag on ${override.txn_id} requires a contemporaneous business-purpose note (E.3)`,
    );
  }
  log.push({ ...override, business_purpose_note: note });
}
