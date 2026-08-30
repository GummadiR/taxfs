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
import { isStoredDocumentRef } from './doc-ref';

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

/**
 * Whether a document can usefully be re-scanned, and if not, why not.
 *
 * The Rescan control used to appear on EVERY stored document. On a confirmed
 * one it could not do anything — re-proposing on top of a confirmed value is
 * how a document gets counted twice, so the action refuses — and the refusal
 * printed in a banner at the top of a long page, far from the button. The
 * honest read was "I clicked it and nothing happened", so people clicked
 * again, and with no per-row status there was no way to tell which document
 * you had just re-scanned or whether it had worked.
 *
 * TaxOS showed its equivalent on almost no row: only where a document had
 * NOTHING attached, because unconfirmed proposals lived in an in-memory
 * session and died on restart. TaxFS persists facts, so that reason is gone —
 * which is why most documents here never need re-scanning at all.
 *
 * What remains genuinely re-scannable: a stored file whose values are not yet
 * confirmed. That covers extraction being off at upload, extraction failing
 * or being refused, and a reading you have not yet accepted.
 */
export interface RescanState {
  canRescan: boolean;
  /** Stored file, but no values were ever read from it. */
  nothingRead: boolean;
  /** Full explanation, for a tooltip. */
  why: string;
  /** Two or three words, for the row itself. */
  shortWhy: string;
}

export function rescanState(source: SourceDoc, facts: readonly TaxFact[]): RescanState {
  const mine = facts.filter(
    (f) => f.derivation === undefined && f.provenance?.some((p) => p.source_id === source.source_id),
  );
  const confirmed = mine.filter((f) => f.status === 'confirmed').length;
  const stored = isStoredDocumentRef(source.raw_ref);

  if (!stored) {
    return {
      canRescan: false, nothingRead: false,
      why: 'This entry has no stored file behind it — it was typed in, or came from a demo document. There is nothing to read again.',
      shortWhy: 'typed entry',
    };
  }
  if (confirmed > 0) {
    return {
      canRescan: false, nothingRead: false,
      why: `${confirmed} value(s) from this document are confirmed and counting toward your return. A re-scan would propose them a second time, so it is refused. To start over, Remove the document and upload it again.`,
      shortWhy: 'confirmed — nothing to re-scan',
    };
  }
  return {
    canRescan: true,
    nothingRead: mine.length === 0,
    why: mine.length === 0
      ? 'The file is stored but no values were read from it. Re-scan reads the same stored bytes again.'
      : 'This document has values waiting for your confirmation. Re-scan reads the stored file again and rebuilds them.',
    shortWhy: '',
  };
}

/** One value a document supplied, for display on that document's own row. */
export interface SourceValue {
  fact_id: string;
  label: string;
  concept: string;
  value: string;
  confirmed: boolean;
  stale: boolean;
  /** Which box on the document it was read from, when known. */
  field: string | null;
}

/**
 * The values each source supplied, keyed by source_id.
 *
 * These lived only on Review, in one long table divorced from the documents
 * that produced them — so "what did this W-2 actually give me?" could not be
 * answered anywhere. They belong beside the document, which is also where
 * their confirmation lives.
 */
export function valuesBySource(facts: readonly TaxFact[]): Map<string, SourceValue[]> {
  const out = new Map<string, SourceValue[]>();
  for (const f of facts) {
    if (f.derivation !== undefined) continue; // computed lines belong on Review
    for (const p of f.provenance ?? []) {
      const row: SourceValue = {
        fact_id: f.fact_id,
        label: SOURCE_LABELS[f.concept] ?? conceptLabel(f.concept),
        concept: f.concept,
        value: f.value.toString(),
        confirmed: f.status === 'confirmed',
        stale: f.status === 'stale',
        field: p.source_field ?? null,
      };
      out.set(p.source_id, [...(out.get(p.source_id) ?? []), row]);
    }
  }
  for (const [k, v] of out) out.set(k, v.sort((a, b) => a.label.localeCompare(b.label)));
  return out;
}
