/**
 * Re-running the capital-loss carryover worksheet must REPLACE the previous
 * run, not add to it.
 *
 * A carryover is singular: Schedule D line 6 and line 14 each take one figure
 * from the Carryover Worksheet. Every run used to mint a fresh source with a
 * fresh UUID, so a second run left TWO confirmed facts per concept — and the
 * kernel sums every confirmed fact. On a real return that subtracted $42,410
 * of carryover as $84,820, moving Schedule D from $89,824 to $48,517 and
 * turning $11,362 owed into a $2,509 refund. Nothing on any screen said so:
 * the Add Data card read the value with `.find()` and displayed one entry.
 *
 * "Run the worksheet again" has always meant "replace what I entered" to the
 * operator. These pin that, including the self-heal: a return that ALREADY
 * carries a doubled carryover is corrected by re-running the worksheet once.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

interface Src { source_id: string; taxpayer_id: string; type: string; tax_year: number; raw_ref: string; fields: Record<string, string>; ocr_confidence: number; review_status: string }

const spine = {
  sources: [] as Src[],
  deleted: [] as string[],
  cascades: [] as (boolean | undefined)[],
  landed: [] as { fact_id: string; concept: string; value: string }[],
};

vi.mock('../src/server/db', () => ({
  withSpine: async (_ctx: unknown, fn: (s: unknown) => unknown) =>
    fn({
      getSources: async () => spine.sources,
      deleteSource: async (id: string, opts?: { cascade?: boolean }) => {
        spine.deleted.push(id);
        spine.cascades.push(opts?.cascade);
        spine.sources = spine.sources.filter((s) => s.source_id !== id);
        return { deleted_fact_ids: [] };
      },
      registerSource: async (doc: Record<string, unknown>) => {
        spine.sources.push(doc as unknown as Src);
        return doc;
      },
      confirmSource: async () => {},
      putSourceFact: async (f: { fact_id: string; concept: string; value: { toString(): string } }) => {
        spine.landed.push({ fact_id: f.fact_id, concept: f.concept, value: f.value.toString() });
      },
    }),
  withUserClient: async (_u: unknown, fn: (c: unknown) => unknown) => fn({ query: async () => ({ rows: [] }) }),
}));

const priorRun = (id: string): Src => ({
  source_id: id, taxpayer_id: 'ws', type: 'USER_ENTRY', tax_year: 2025,
  raw_ref: `worksheet://${id}`, fields: {}, ocr_confidence: 1, review_status: 'confirmed',
});

/** The 2024 figures behind a real carryover. */
const form = () => {
  const fd = new FormData();
  fd.set('wk_taxable_income', '-2000');
  fd.set('wk_line7', '-4000');
  fd.set('wk_line15', '500');
  fd.set('wk_line21', '-3000');
  return fd;
};

async function run() {
  const { computeCarryoversFrom2024 } = await import('../src/server/structured');
  return computeCarryoversFrom2024('u', 'ws', form());
}

beforeEach(() => {
  spine.sources = [];
  spine.deleted = [];
  spine.cascades = [];
  spine.landed = [];
});

describe('the carryover worksheet replaces its previous run', () => {
  it('NEGATIVE: a second run must NOT leave two carryover entries standing', () => {
    // The forbidden outcome is the old behaviour — the first run's source
    // surviving alongside the second, so the kernel sums both.
    spine.sources = [priorRun('worksheet-caploss-first')];
    return run().then((msg) => {
      expect(spine.deleted).toEqual(['worksheet-caploss-first']);
      // Exactly one worksheet source remains, and it is not the old one.
      const remaining = spine.sources.filter((s) => s.source_id.startsWith('worksheet-caploss-'));
      expect(remaining).toHaveLength(1);
      expect(remaining[0]!.source_id).not.toBe('worksheet-caploss-first');
      // And the operator is told, so "did it replace or add?" is not a guess.
      expect(msg).toContain('REPLACED 1 earlier worksheet entry');
      expect(msg).toContain('counted once');
    });
  });

  it('SELF-HEAL: a return already carrying two runs is corrected by one re-run', async () => {
    spine.sources = [priorRun('worksheet-caploss-a'), priorRun('worksheet-caploss-b')];
    const msg = await run();
    expect(spine.deleted.sort()).toEqual(['worksheet-caploss-a', 'worksheet-caploss-b']);
    expect(spine.sources.filter((s) => s.source_id.startsWith('worksheet-caploss-'))).toHaveLength(1);
    expect(msg).toContain('REPLACED 2 earlier worksheet entries');
  });

  it('deletes with cascade, so the derived layer cannot be left dangling', async () => {
    spine.sources = [priorRun('worksheet-caploss-first')];
    await run();
    expect(spine.cascades).toEqual([true]);
  });

  it('a FIRST run deletes nothing and says nothing about replacing', async () => {
    const msg = await run();
    expect(spine.deleted).toEqual([]);
    expect(msg).not.toContain('REPLACED');
    expect(msg).toContain('SAVED');
  });

  it('leaves other sources alone — only worksheet runs are superseded', async () => {
    const w2: Src = {
      source_id: 'doc-w2', taxpayer_id: 'ws', type: 'W-2', tax_year: 2025,
      raw_ref: 'localfs://w2.pdf', fields: {}, ocr_confidence: 1, review_status: 'confirmed',
    };
    const manual: Src = { ...w2, source_id: 'manual-abc', type: 'USER_ENTRY', raw_ref: 'manual://abc' };
    spine.sources = [w2, manual, priorRun('worksheet-caploss-old')];
    await run();
    expect(spine.deleted).toEqual(['worksheet-caploss-old']);
    expect(spine.sources.map((s) => s.source_id)).toContain('doc-w2');
    expect(spine.sources.map((s) => s.source_id)).toContain('manual-abc');
  });

  it('still saves BOTH carryover concepts, once each', async () => {
    spine.sources = [priorRun('worksheet-caploss-first')];
    await run();
    const concepts = spine.landed.map((f) => f.concept);
    expect(concepts).toContain('carryover.capital_loss.st');
    expect(concepts).toContain('carryover.capital_loss.lt');
    expect(new Set(concepts).size).toBe(concepts.length); // no concept saved twice
  });
});
