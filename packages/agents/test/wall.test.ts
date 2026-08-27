/**
 * THE WALL (E.0/E.6): agent outputs never become TaxFacts without human
 * confirmation. The review-pending store is the only door in; tiered
 * confirm keeps critical fields on individual confirmation.
 */
import { describe, expect, it } from 'vitest';
import { type Clock } from '@taxfs/shared';
import { InMemorySpine } from '@taxfs/spine';
import { ReviewPendingStore, runExtraction } from '@taxfs/agents';
import { makeRig } from './helpers.js';

const clock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };
const TP = 'tp-wall';

const W2_OUTPUT = JSON.stringify({
  doc_type: 'W-2',
  tax_year: 2025,
  payer: { name: 'Acme', ein_token: 'tok_ein_acme1' },
  fields: [
    { name: 'box1_wages', raw_text: '60000', normalized: { kind: 'decimal', value: '60000' }, region: { page: 1, x: 1, y: 1, w: 1, h: 1 }, confidence: 0.98 },
    { name: 'box2_fed_withholding', raw_text: '6000', normalized: { kind: 'decimal', value: '6000' }, region: { page: 1, x: 1, y: 2, w: 1, h: 1 }, confidence: 0.6 },
  ],
});

async function setup() {
  const spine = new InMemorySpine(clock, 'wall-test');
  await spine.registerSource({
    source_id: 's-w2',
    taxpayer_id: TP,
    type: 'W-2',
    tax_year: 2025,
    fields: { box1_wages: '60000', box2_fed_withholding: '6000' },
    ocr_confidence: 0.98,
    raw_ref: 'blob://s-w2',
  });
  const store = new ReviewPendingStore(spine);
  const rig = makeRig({ extraction: () => W2_OUTPUT });
  const run = await runExtraction(
    rig.deps,
    { doc_id: 's-w2', image_ref: 'blob://s-w2', ocr_text: 'W-2 ...', expected_tax_year: 2025 },
    TP,
  );
  if (run.status !== 'ok') throw new Error('extraction should succeed');
  const proposals = store.submit(run.proposals);
  return { spine, store, proposals };
}

describe('the wall: zero TaxFact writes without confirm', () => {
  it('validated agent output sits in review-pending; the spine has NO facts and NO fact audit rows', async () => {
    const { spine, store } = await setup();
    expect(await spine.getFacts({ taxpayer_id: TP, tax_year: 2025 })).toEqual([]);
    const factAudit = (await spine.inspect()).auditLog.filter((e) => e.entity_type === 'tax_fact');
    expect(factAudit).toEqual([]);
    expect(store.pending()).toHaveLength(2);
  });

  it('confirm is the only path in: fact appears confirmed with provenance after confirm', async () => {
    const { spine, store, proposals } = await setup();
    const wages = proposals.find((p) => p.concept === 'income.wages')!;
    await store.confirm(wages.proposal_id);
    const facts = await spine.getFacts({ taxpayer_id: TP, tax_year: 2025 });
    expect(facts).toHaveLength(1);
    expect(facts[0]?.status).toBe('confirmed');
    expect(facts[0]?.provenance).toEqual([{ source_id: 's-w2', source_field: 'box1_wages' }]);
  });

  it('critical fields refuse batch confirm (individual confirm only)', async () => {
    const { store, proposals } = await setup();
    await expect(store.batchConfirm(proposals.map((p) => p.proposal_id))).rejects.toThrow(/critical field/);
  });

  it('empty-with-suggestion items require the user to type the value', async () => {
    const { spine, store, proposals } = await setup();
    const lowConf = proposals.find((p) => p.concept === 'payments.fed.withholding')!;
    expect(lowConf.value).toBeNull(); // confidence 0.6 < threshold
    await expect(store.confirm(lowConf.proposal_id)).rejects.toThrow(/user must type/);
    await store.confirm(lowConf.proposal_id, '6000');
    const facts = await spine.getFacts({ taxpayer_id: TP, tax_year: 2025 });
    expect(facts.find((f) => f.concept === 'payments.fed.withholding')?.value.toString()).toBe('6000');
  });

  it('rejected proposals never touch the spine', async () => {
    const { spine, store, proposals } = await setup();
    for (const p of proposals) store.reject(p.proposal_id);
    await expect(store.confirm(proposals[0]!.proposal_id)).rejects.toThrow(/rejected/);
    expect(await spine.getFacts({ taxpayer_id: TP, tax_year: 2025 })).toEqual([]);
  });

  it('discardBySource removes every pending proposal from a deleted document', async () => {
    const { store, proposals } = await setup();
    expect(store.pending()).toHaveLength(2);
    const removed = store.discardBySource('s-w2');
    expect(removed).toBe(2);
    expect(store.pending()).toHaveLength(0);
    // The proposals are gone entirely — confirm can no longer resurrect them.
    await expect(store.confirm(proposals[0]!.proposal_id)).rejects.toThrow(/not found/);
    expect(store.discardBySource('s-w2')).toBe(0); // idempotent
  });
});
