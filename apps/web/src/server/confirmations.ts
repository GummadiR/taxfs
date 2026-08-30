/**
 * "What am I confirming?" — the review door, ported in substance from TaxOS's
 * Extraction review panel.
 *
 * The operator's complaint, and it was fair: TaxFS showed a bare row with a
 * Confirm button, so you were asked to vouch for a number without being told
 * which document it came from, which box on that document, or how sure the
 * reader was. TaxOS showed all of it before you clicked.
 *
 * TaxFS's architecture differs — extracted values land as UNCONFIRMED FACTS
 * in the spine (G8) rather than an in-memory proposal queue — so this
 * assembles the same story from facts + their provenance.
 */
import type { SourceDoc, TaxFact } from '@taxfs/shared';
import { conceptLabel, docTitle, SOURCE_LABELS } from './labels';

/** Below this, TaxOS made the operator TYPE the value rather than click. */
export const TYPE_TO_VERIFY_BELOW = 0.95;

export interface PendingConfirmation {
  fact_id: string;
  /** Human name of the line, e.g. "Wages (W-2 box 1)". */
  label: string;
  concept: string;
  value: string;
  confidence: number;
  /** The box/field on the document the reader took it from. */
  source_field: string | null;
  source_id: string | null;
  /** The document's display name, never a raw id. */
  doc_title: string | null;
  /** True when this value was read by the extractor rather than typed. */
  machine_read: boolean;
  /** True when the operator must retype the value to confirm it. */
  type_to_verify: boolean;
}

export function pendingConfirmations(
  facts: readonly TaxFact[],
  sources: readonly SourceDoc[],
): PendingConfirmation[] {
  const byId = new Map(sources.map((s) => [s.source_id, s]));
  return facts
    .filter((f) => f.derivation === undefined && f.status !== 'confirmed')
    .map((f) => {
      const prov = f.provenance?.[0];
      const src = prov ? byId.get(prov.source_id) : undefined;
      // A value typed by the operator, or a wizard attestation, was never
      // "read" by anything — it does not need the machine-read framing.
      const machineRead = Boolean(src) && !src!.raw_ref.startsWith('manual://') && prov?.source_field !== 'attestation';
      return {
        fact_id: f.fact_id,
        label: SOURCE_LABELS[f.concept] ?? conceptLabel(f.concept),
        concept: f.concept,
        value: f.value.toString(),
        confidence: f.confidence,
        source_field: prov?.source_field ?? null,
        source_id: prov?.source_id ?? null,
        doc_title: src ? docTitle(src) : null,
        machine_read: machineRead,
        type_to_verify: machineRead && f.confidence < TYPE_TO_VERIFY_BELOW,
      };
    })
    .sort((a, b) => (a.doc_title ?? '').localeCompare(b.doc_title ?? '') || a.label.localeCompare(b.label));
}
