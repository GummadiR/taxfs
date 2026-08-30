/**
 * P26 rescan — IN PLACE and NON-DESTRUCTIVE (§9.1 negative tests).
 *
 * Found the hard way on a real workspace: the ported rescan deleted the
 * source and its stored file FIRST, then re-ran the whole upload pipeline.
 * With extraction off the rebuild always succeeded, so the flaw was
 * invisible; with extraction live, a REJECTED document was simply
 * destroyed. Four of an operator's documents were lost that way.
 *
 * TaxOS never had this bug because its rescan re-runs extraction against
 * the SAME source row and never deletes (aantic-taxos
 * rescanStoredDocument). TaxFS now matches that shape, and these tests pin
 * every property that makes it safe.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

interface Src {
  source_id: string; taxpayer_id: string; type: string; tax_year: number;
  raw_ref: string; fields: Record<string, string>; ocr_confidence: number; review_status: string;
}

const spine = {
  sources: [] as Src[],
  facts: [] as { fact_id: string; status: string; derivation?: unknown; provenance: { source_id: string }[] }[],
  deleted: [] as string[],
  registered: [] as string[],
  landed: [] as string[],
};
const storeDeletes: string[] = [];
let extraction: () => Promise<unknown> = async () => ({ status: 'rejected', issues: [{ message: 'unreadable scan' }] });

vi.mock('../src/server/db', () => ({
  withSpine: async (_ctx: unknown, fn: (s: unknown) => unknown) =>
    fn({
      getSources: async () => spine.sources,
      getFacts: async () => spine.facts,
      deleteSource: async (id: string) => {
        spine.deleted.push(id);
        spine.sources = spine.sources.filter((s) => s.source_id !== id);
      },
      registerSource: async (doc: Record<string, unknown>) => {
        spine.registered.push(String(doc['source_id']));
        spine.sources.push(doc as unknown as Src);
        return doc;
      },
      confirmSource: async () => {},
      putSourceFact: async (f: { fact_id: string }) => {
        spine.landed.push(f.fact_id);
      },
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

vi.mock('../src/server/scrub-isolated', () => ({
  scrubDocumentSafely: async (bytes: Uint8Array) => ({ bytes, media_type: 'application/pdf', masked: 0, notes: [] }),
}));

let apiKey: string | null = 'sk-ant-test';
vi.mock('../src/server/agent-deps', () => ({
  anthropicApiKey: () => apiKey,
  makeAgentDeps: () => ({}),
}));
vi.mock('@taxfs/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@taxfs/agents')>()),
  runExtraction: async () => extraction(),
}));

const EXISTING: Src = {
  source_id: 'doc-existing',
  taxpayer_id: 'ws_test',
  type: 'USER_ENTRY',
  tax_year: 2025,
  raw_ref: 'localfs://ws_test/2025/doc-existing-Temple_Donations.pdf',
  fields: { __filename: 'Temple Donations.pdf', __sha256: 'deadbeef' },
  ocr_confidence: 0,
  review_status: 'confirmed',
};

/** Every property that must hold no matter what extraction did. */
function expectDocumentIntact(): void {
  expect(spine.sources).toHaveLength(1);
  expect(spine.sources[0]!.source_id).toBe('doc-existing');
  expect(spine.sources[0]!.raw_ref).toBe(EXISTING.raw_ref);
  expect(spine.sources[0]!.fields['__filename']).toBe('Temple Donations.pdf');
  expect(spine.deleted).toEqual([]);
  expect(storeDeletes).toEqual([]);
}

describe('rescan is in-place and non-destructive (P26)', () => {
  beforeEach(() => {
    spine.sources = [{ ...EXISTING }];
    spine.facts = [];
    spine.deleted = [];
    spine.registered = [];
    spine.landed = [];
    storeDeletes.length = 0;
    apiKey = 'sk-ant-test';
    extraction = async () => ({ status: 'rejected', issues: [{ message: 'unreadable scan' }] });
  });

  it('KEEPS the document when live extraction REJECTS it (the documents-lost bug)', async () => {
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-existing');
    expectDocumentIntact();
    expect(report.messages.join(' ')).toContain('untouched');
  });

  it('KEEPS the document when the extraction API THROWS', async () => {
    extraction = async () => {
      throw new Error('502 upstream');
    };
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-existing');
    expectDocumentIntact();
    expect(report.messages.join(' ')).toContain('untouched');
  });

  it('KEEPS the document when it cannot be read as a supported form', async () => {
    extraction = async () => ({ status: 'manual_entry' });
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-existing');
    expectDocumentIntact();
    expect(report.messages.join(' ')).toContain('untouched');
  });

  it('on SUCCESS keeps the SAME document id and file — values land, nothing is recreated', async () => {
    extraction = async () => ({
      status: 'ok',
      output: { doc_type: 'W2', fields: [{ name: 'box1_wages', normalized: { value: '60000' }, confidence: 0.99 }], payer: { name: 'Acme' } },
      proposals: [{
        source_id: 'doc-existing', source_field: 'box1_wages', concept: 'income.wages',
        jurisdiction: ['FED'], taxpayer_scope: 'primary', value: '60000', confidence: 0.99,
      }],
      flags: { wrong_year: false },
    });
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-existing');
    // The row is the SAME row: no delete, no re-register, no id churn — so a
    // page open in another tab never goes stale.
    expectDocumentIntact();
    expect(spine.registered).toEqual([]);
    // The re-read value landed against that same document.
    expect(spine.landed).toEqual(['f:doc-existing:box1_wages']);
    expect(report.messages.join(' ')).toContain('await your confirmation');
  });

  it('re-running the SAME successful rescan cannot double-count (same fact ids)', async () => {
    extraction = async () => ({
      status: 'ok',
      output: { doc_type: 'W2', fields: [{ name: 'box1_wages', normalized: { value: '60000' }, confidence: 0.99 }], payer: { name: 'Acme' } },
      proposals: [{
        source_id: 'doc-existing', source_field: 'box1_wages', concept: 'income.wages',
        jurisdiction: ['FED'], taxpayer_scope: 'primary', value: '60000', confidence: 0.99,
      }],
      flags: { wrong_year: false },
    });
    const { rescanDocument } = await import('../src/server/upload');
    await rescanDocument('user', 'ws_test', 'doc-existing');
    await rescanDocument('user', 'ws_test', 'doc-existing');
    // Same fact id both times — an upsert, never a second copy of the income.
    expect(new Set(spine.landed).size).toBe(1);
  });

  it('REFUSES to re-propose over values already confirmed (double-counting guard)', async () => {
    spine.facts = [{ fact_id: 'f:doc-existing:box1_wages', status: 'confirmed', provenance: [{ source_id: 'doc-existing' }] }];
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-existing');
    expectDocumentIntact();
    expect(spine.landed).toEqual([]);
    expect(report.messages.join(' ')).toContain('already has confirmed values');
  });

  it('says extraction is off rather than touching anything when no API key is set', async () => {
    apiKey = null;
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-existing');
    expectDocumentIntact();
    expect(report.messages.join(' ')).toContain('Live extraction is off');
  });

  it('tells the operator their page is stale when the id no longer exists, changing nothing', async () => {
    const { rescanDocument } = await import('../src/server/upload');
    const report = await rescanDocument('user', 'ws_test', 'doc-missing');
    expect(report.messages.join(' ')).toContain('out of date');
    expect(spine.sources).toHaveLength(1);
    expect(spine.deleted).toEqual([]);
  });
});
