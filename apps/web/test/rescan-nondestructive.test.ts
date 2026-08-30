/**
 * P26 rescan — NON-DESTRUCTIVE by construction (§9.1 negative test).
 *
 * Found the hard way on a real workspace: the ported rescan deleted the
 * source and its stored file FIRST, then re-ran the pipeline. When live
 * extraction rejected the document (or the API failed), the re-registration
 * never happened — and the operator's document was simply gone. Six of
 * thirteen documents disappeared in one session, with no way back.
 *
 * The rule this pins: a rescan that does not successfully produce a
 * replacement leaves the existing source and file EXACTLY as they were.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const spine = {
  sources: [] as { source_id: string; type: string; tax_year: number; raw_ref: string; fields: Record<string, string>; taxpayer_id: string; ocr_confidence: number; review_status: string }[],
  deleted: [] as string[],
};
const storeDeletes: string[] = [];

vi.mock('../src/server/db', () => ({
  withSpine: async (_ctx: unknown, fn: (s: unknown) => unknown) =>
    fn({
      getSources: async () => spine.sources,
      deleteSource: async (id: string) => {
        spine.deleted.push(id);
        spine.sources = spine.sources.filter((s) => s.source_id !== id);
      },
      registerSource: async (doc: Record<string, unknown>) => {
        spine.sources.push(doc as never);
        return doc;
      },
      confirmSource: async () => {},
      putSourceFact: async () => {},
    }),
  withUserClient: async (_u: unknown, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [] }) }),
}));

vi.mock('../src/server/docstore', () => ({
  fetchDocument: async () => new Uint8Array([1, 2, 3]),
  storeDocument: async (_ws: string, name: string) => `localfs://${name}`,
  deleteDocument: async (ref: string) => {
    storeDeletes.push(ref);
  },
  isStoredDocumentRef: () => true,
  documentDisplayName: () => null,
}));

// The scrub is proven elsewhere; here it must not run real OCR.
vi.mock('../src/server/scrub-isolated', () => ({
  scrubDocumentSafely: async (bytes: Uint8Array) => ({
    bytes,
    media_type: 'application/pdf',
    masked: 0,
    notes: [],
  }),
}));

// Live extraction configured, and REJECTING — the exact shape that used to
// destroy the document.
vi.mock('../src/server/agent-deps', () => ({
  anthropicApiKey: () => 'sk-ant-test',
  makeAgentDeps: () => ({}),
}));
vi.mock('@taxfs/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxfs/agents')>()),
  runExtraction: async () => ({ status: 'rejected', issues: [{ message: 'unreadable scan' }] }),
}));

const EXISTING = {
  source_id: 'doc-existing',
  taxpayer_id: 'ws_test',
  type: 'USER_ENTRY',
  tax_year: 2025,
  raw_ref: 'localfs://ws_test/2025/doc-existing-Temple_Donations.pdf',
  fields: { __filename: 'Temple Donations.pdf', __sha256: 'deadbeef' },
  ocr_confidence: 0,
  review_status: 'confirmed',
};

describe('rescan is non-destructive (P26)', () => {
  beforeEach(() => {
    spine.sources = [{ ...EXISTING }];
    spine.deleted = [];
    storeDeletes.length = 0;
  });

  it('KEEPS the document when live extraction REJECTS it (the six-documents-lost bug)', async () => {
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-existing');

    // The document survives, with its name and stored file intact.
    expect(spine.sources).toHaveLength(1);
    expect(spine.sources[0]!.source_id).toBe('doc-existing');
    expect(spine.sources[0]!.fields['__filename']).toBe('Temple Donations.pdf');
    expect(spine.deleted).toEqual([]);
    expect(storeDeletes).not.toContain(EXISTING.raw_ref);
    // And the operator is TOLD the copy was kept, not left guessing.
    expect(report.messages.join(' ')).toContain('KEPT unchanged');
  });

  it('reports honestly when the source id does not exist, changing nothing', async () => {
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-missing');
    expect(report.messages.join(' ')).toContain('not found');
    expect(spine.sources).toHaveLength(1);
    expect(spine.deleted).toEqual([]);
  });
});
