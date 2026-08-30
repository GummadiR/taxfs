/**
 * Document upload pipeline (TaxOS P15/P26, ported to stateless TaxFS).
 * Shared by the /api/upload Route Handler (no Server-Action body cap) and
 * the documents page.
 *
 * Order is load-bearing: SCRUB runs first and unconditionally — before
 * storage, before the vision API. TaxFS never needs an SSN (identity is
 * browser-only, G9), so no code path may see one; a document that cannot
 * be safely scrubbed is REFUSED, never stored as-is.
 *
 * Review adaptation: TaxOS queued proposals in an in-memory review store;
 * TaxFS's confirm door (G8) is the spine itself — every extracted value
 * lands as an UNCONFIRMED fact and nothing counts until the operator
 * confirms it on Review. A below-threshold field (value withheld by the
 * confidence gate) is never prefilled anywhere: it stays a source field
 * plus a message routing the operator to manual entry.
 */
import { runExtraction } from '@taxfs/agents';
import { createHash } from 'node:crypto';
import { Money, type SourceDoc } from '@taxfs/shared';
import { withSpine } from './db';
import { makeAgentDeps, anthropicApiKey } from './agent-deps';
import { PgAgentLog } from './agent-log';
import { scrubDocumentSafely } from './scrub-isolated';
import { deleteDocument, fetchDocument, storeDocument } from './docstore';
import { resolveFxRateFromCertificate } from './fx-rate';
import { withUserClient } from './db';
import { TAX_YEAR } from './env';

const UPLOAD_TYPES: Record<string, 'image' | 'pdf'> = {
  'image/png': 'image',
  'image/jpeg': 'image',
  'image/webp': 'image',
  'image/gif': 'image',
  'application/pdf': 'pdf',
};

/** Keep base64 payloads comfortably under the vision API request cap. */
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

export interface BlockedUpload {
  name: string;
  reason: string;
  instructions: string;
}

export interface UploadReport {
  messages: string[];
  blocked: BlockedUpload[];
}

/** Land an extraction run's readable values as UNCONFIRMED facts (G8). */
async function landProposals(
  userId: string,
  ws: string,
  proposals: { source_id: string; source_field: string; concept: string; jurisdiction: import('@taxfs/shared').Jurisdiction[]; taxpayer_scope: string; value: string | null; confidence: number }[],
): Promise<{ landed: number; withheld: number }> {
  let landed = 0;
  let withheld = 0;
  await withSpine({ userId, workspaceId: ws }, async (spine) => {
    for (const p of proposals) {
      if (p.value === null) {
        withheld += 1; // confidence-gated: never prefilled, never guessed
        continue;
      }
      await spine.putSourceFact({
        fact_id: `f:${p.source_id}:${p.source_field}`,
        taxpayer_id: ws,
        concept: p.concept,
        tax_year: TAX_YEAR,
        jurisdiction: p.jurisdiction,
        taxpayer_scope: p.taxpayer_scope as 'primary',
        value: Money.fromString(p.value),
        confidence: p.confidence,
        provenance: [{ source_id: p.source_id, source_field: p.source_field }],
      });
      landed += 1;
    }
  });
  return { landed, withheld };
}

async function runDocPipeline(
  userId: string,
  ws: string,
  name: string,
  mediaType: string,
  original: Uint8Array,
  report: UploadReport,
  /** Rescan (P26): the existing source this run REPLACES. It is retired only
   *  at the moment a successful replacement registers — a rejected or failed
   *  extraction must never cost the operator their stored document. */
  replace?: SourceDoc,
): Promise<void> {
  const kind = UPLOAD_TYPES[mediaType];
  if (!kind) {
    report.messages.push(`"${name}": unsupported file type "${mediaType || 'unknown'}" — upload a PNG, JPEG, WebP, GIF, or PDF.`);
    return;
  }
  if (original.byteLength > MAX_UPLOAD_BYTES) {
    report.messages.push(`"${name}" is ${(original.byteLength / 1024 / 1024).toFixed(1)} MB — the limit is 15 MB. Scan at a lower resolution.`);
    return;
  }

  // DUPLICATE check by content fingerprint: the SHA-256 of the incoming
  // bytes is stored with every upload, so re-uploading the same file — even
  // renamed — is refused BEFORE the (expensive) scrub, naming the existing
  // document. A hash reveals nothing about the content. Only exact-byte
  // duplicates match; a re-scan of the same paper document is a different
  // file and legitimately lands as its own evidence.
  const sha256 = createHash('sha256').update(original).digest('hex');
  const twin = (await withSpine({ userId, workspaceId: ws }, (spine) => spine.getSources(ws, TAX_YEAR)))
    .find((s) => s.fields['__sha256'] === sha256 && s.source_id !== replace?.source_id);
  if (twin) {
    const twinName = twin.fields['__filename'] ?? twin.source_id;
    report.blocked.push({
      name,
      reason: `"${name}" is byte-for-byte identical to "${twinName}", which is already in this workspace — it was skipped, nothing was stored twice.`,
      instructions: 'If you meant to replace the existing copy, Remove it on the Documents page first, then upload again.',
    });
    return;
  }

  // P15 — LOCAL SSN SCRUB, first and unconditionally.
  // Isolated child process with a hard kill: a document that freezes a PDF
  // library can cost only ITSELF, never the server or the rest of the batch.
  const scrub = await scrubDocumentSafely(original, mediaType);
  if (scrub.blocked) {
    report.blocked.push({ name, reason: scrub.blocked.reason, instructions: scrub.blocked.instructions });
    return;
  }
  for (const note of scrub.notes) report.messages.push(note);

  const bytes = scrub.bytes;
  const outType = scrub.media_type;
  const docId = `doc-${crypto.randomUUID()}`;
  const ext = outType === 'application/pdf' ? '.pdf' : '.png';
  const safeName = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80).replace(/\.[A-Za-z0-9]+$/, '') + ext;
  // The stored artifact is the SCRUBBED copy; extraction reads the same bytes.
  const rawRef = await storeDocument(ws, `${TAX_YEAR}/${docId}-${safeName}`, bytes, outType);

  // On a rescan, the OLD record and file go away only here — immediately
  // before a successful replacement registers. Every failure path above and
  // below leaves the operator's existing document untouched.
  const retireReplaced = async (): Promise<void> => {
    if (!replace) return;
    await withSpine({ userId, workspaceId: ws }, (spine) => spine.deleteSource(replace.source_id, { cascade: true }));
    if (replace.raw_ref !== rawRef) {
      try {
        await deleteDocument(replace.raw_ref);
      } catch {
        // an orphaned old file is a cleanup nit, never worth failing the rescan
      }
    }
  };

  if (!anthropicApiKey()) {
    await retireReplaced();
    await withSpine({ userId, workspaceId: ws }, async (spine) => {
      await spine.registerSource({
        source_id: docId,
        taxpayer_id: ws,
        type: 'USER_ENTRY',
        tax_year: TAX_YEAR,
        fields: { __filename: name, __sha256: sha256 },
        ocr_confidence: 0,
        raw_ref: rawRef,
      });
      await spine.confirmSource(docId);
    });
    report.messages.push(
      `"${name}" was scanned for SSNs locally and stored, but live extraction is off on this TaxFS setup ` +
        '(no ANTHROPIC_API_KEY — a machine configuration, not a problem with your document). ' +
        'Enter its values with Manual entry below; the stored file stays alongside as the evidence.',
    );
    return;
  }

  const run = await withUserClient(userId, (client) =>
    runExtraction(
      makeAgentDeps(new PgAgentLog(client, ws)),
      {
        doc_id: docId,
        image_ref: rawRef,
        media: { kind: UPLOAD_TYPES[outType] ?? kind, media_type: outType, data_base64: Buffer.from(bytes).toString('base64') },
        expected_tax_year: TAX_YEAR,
      },
      ws,
    ));

  if (run.status === 'rejected') {
    await deleteDocument(rawRef);
    report.messages.push(
      `Extraction of "${name}" was rejected by validation and produced nothing to review` +
        (run.issues[0] ? ` (${run.issues[0].message})` : '') +
        (replace
          ? '. Your existing stored copy was KEPT unchanged — nothing was deleted.'
          : '. Nothing was guessed — try a clearer scan or enter the document manually below.'),
    );
    return;
  }
  if (run.status === 'manual_entry') {
    await retireReplaced();
    await withSpine({ userId, workspaceId: ws }, async (spine) => {
      await spine.registerSource({
        source_id: docId,
        taxpayer_id: ws,
        type: 'USER_ENTRY',
        tax_year: TAX_YEAR,
        fields: { __filename: name, __sha256: sha256 },
        ocr_confidence: 0,
        raw_ref: rawRef,
      });
      await spine.confirmSource(docId);
    });
    report.messages.push(`"${name}" could not be read as a supported form. Nothing was guessed — enter it manually below (the file is stored alongside).`);
    return;
  }

  const out = run.output;
  await retireReplaced();
  await withSpine({ userId, workspaceId: ws }, async (spine) => {
    await spine.registerSource({
      source_id: docId,
      taxpayer_id: ws,
      type: (out.doc_type === 'UNREADABLE' ? 'USER_ENTRY' : out.doc_type) as never,
      tax_year: TAX_YEAR,
      fields: {
        ...Object.fromEntries(out.fields.map((f) => [f.name, f.normalized.value])),
        // P14.2 — persist the payer for smart titles; never for a 15CA/CB,
        // where the "payer" would be the taxpayer (identity stays out, P14.1).
        ...(out.payer.name && out.doc_type !== 'FOREIGN-REMITTANCE' ? { __payer: out.payer.name } : {}),
        // The operator's own file name, for display on Documents — the same
        // name already carried in the storage path (raw_ref).
        __filename: name,
        __sha256: sha256,
      },
      ocr_confidence: out.fields.length > 0 ? Math.min(...out.fields.map((f) => f.confidence)) : 0.5,
      raw_ref: rawRef,
    });
    await spine.confirmSource(docId);
  });
  const { landed, withheld } = await landProposals(userId, ws, run.proposals);
  if (run.flags.wrong_year) {
    report.messages.push(`Heads up: "${name}" is for a different tax year than this return (${TAX_YEAR}). It was flagged, not silently accepted.`);
  }
  report.messages.push(
    `Read ${out.fields.length} field(s) from "${name}" — ${landed} value(s) await your confirmation on Review; nothing counts until you confirm it.` +
      (withheld > 0 ? ` ${withheld} low-confidence field(s) were withheld, never guessed — enter those manually.` : ''),
  );
  // P75 — a foreign certificate states its own date; the rate is a
  // published fact. Never fatal: an outage must not fail the upload.
  if (out.doc_type === 'FOREIGN-REMITTANCE') {
    const fx = await withSpine({ userId, workspaceId: ws }, async (spine) =>
      resolveFxRateFromCertificate(spine, ws, TAX_YEAR, await spine.getSources(ws, TAX_YEAR)));
    report.messages.push(fx.message);
  }
}

/** Process a (possibly multi-file) upload; one bad file never costs the batch. */
export async function uploadDocuments(userId: string, ws: string, files: File[]): Promise<UploadReport> {
  const report: UploadReport = { messages: [], blocked: [] };
  if (files.length === 0) {
    report.messages.push('Choose at least one file.');
    return report;
  }
  for (const file of files) {
    try {
      await runDocPipeline(userId, ws, file.name, file.type, new Uint8Array(await file.arrayBuffer()), report);
    } catch (e) {
      report.messages.push(
        `"${file.name}" could not be processed and was NOT saved — try again; if it keeps failing, scan to a smaller PDF. Technical detail: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return report;
}

/**
 * P26 — re-read a stored document. NON-DESTRUCTIVE by construction (found
 * the hard way: the ported shape deleted first and re-registered after, so
 * a live-extraction rejection or API failure DESTROYED the document — six
 * of an operator's thirteen documents, in one session). The existing source
 * and file are replaced only when the fresh pipeline run successfully
 * registers; every failure leaves them untouched.
 */
export async function rescanDocument(userId: string, ws: string, sourceId: string): Promise<UploadReport> {
  const report: UploadReport = { messages: [], blocked: [] };
  const src = await withSpine({ userId, workspaceId: ws }, async (spine) =>
    (await spine.getSources(ws, TAX_YEAR)).find((x) => x.source_id === sourceId));
  if (!src) {
    report.messages.push('Document not found.');
    return report;
  }
  const bytes = await fetchDocument(src.raw_ref);
  if (!bytes) {
    report.messages.push('The stored file could not be read back — delete the document and upload it again.');
    return report;
  }
  const mediaType = src.raw_ref.endsWith('.pdf') ? 'application/pdf' : 'image/png';
  const name = src.fields['__filename'] ?? src.raw_ref.split('/').pop() ?? 'document';
  try {
    await runDocPipeline(userId, ws, name, mediaType, bytes, report, src);
  } catch (e) {
    report.messages.push(
      `Rescan of "${name}" failed (${e instanceof Error ? e.message : String(e)}). ` +
        'Your existing stored copy was KEPT unchanged — nothing was deleted.',
    );
  }
  return report;
}

/** Delete an uploaded document: the stored file, the source, its facts. */
export async function deleteUploadedDocument(userId: string, ws: string, sourceId: string): Promise<string> {
  const src = await withSpine({ userId, workspaceId: ws }, async (spine) =>
    (await spine.getSources(ws, TAX_YEAR)).find((x) => x.source_id === sourceId));
  if (!src) return 'Document not found.';
  try {
    await withSpine({ userId, workspaceId: ws }, (spine) => spine.deleteSource(sourceId, { cascade: true }));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  await deleteDocument(src.raw_ref);
  return 'Document deleted — its values and any results computed from them were removed.';
}
