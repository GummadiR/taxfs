/**
 * Subject: the Discovery agent (§6) — questions only, deterministic
 * detectors, and the wall: this agent structurally cannot write.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Money, type SourceDoc, type TaxFact } from '@taxfs/shared';
import { detectSignals, runDiscovery } from '../src/discovery';
import { makeRig, userContent } from './helpers';

const src = (source_id: string, fields: Record<string, string>): SourceDoc => ({
  source_id, taxpayer_id: 'tp', type: 'W-2', tax_year: 2025, fields,
  ocr_confidence: 0.99, raw_ref: `blob://${source_id}`, review_status: 'confirmed',
});
const fact = (concept: string, value: string): TaxFact => ({
  fact_id: `f:${concept}`, taxpayer_id: 'tp', concept, tax_year: 2025, jurisdiction: ['FED'],
  taxpayer_scope: 'primary', value: Money.fromString(value), unit: 'USD', status: 'confirmed', confidence: 1,
  provenance: [{ source_id: 's-w2', source_field: 'x' }],
});

describe('discovery detectors (deterministic)', () => {
  it('box 12 W with no coverage type asks the coverage question', () => {
    const signals = detectSignals({
      tax_year: 2025,
      sources: [src('s-w2', { box1_wages: '50000', box12w_hsa: '1000' })],
      facts: [fact('income.wages', '50000')],
      history: [],
    });
    expect(signals.map((s) => s.id)).toEqual(['hsa-coverage-missing']);
  });

  it('prior-year AGI far above captured income raises the swing signal', () => {
    const signals = detectSignals({
      tax_year: 2025,
      sources: [],
      facts: [fact('fed.total_income', '20000'), fact('income.interest', '100')],
      history: [{ tax_year: 2024, line: 'agi', value: '90000' }],
    });
    expect(signals.map((s) => s.id)).toContain('income-swing');
  });

  it('nothing missing → no signals → runDiscovery spends NO agent call', async () => {
    const rig = makeRig({ discovery: () => { throw new Error('must not be called'); } });
    const out = await runDiscovery(rig.deps, { tax_year: 2025, sources: [], facts: [], history: [] });
    expect(out.questions).toEqual([]);
    expect(rig.stub.calls.length).toBe(0);
  });
});

describe('discovery output walls', () => {
  const INPUT = {
    tax_year: 2025,
    sources: [src('s-w2', { box12w_hsa: '1000' })],
    facts: [] as TaxFact[],
    history: [] as { tax_year: number; line: string; value: string }[],
  };

  it('a phrased answer must be a QUESTION about a real signal', async () => {
    const rig = makeRig({
      discovery: (req) => {
        const { signals } = JSON.parse(userContent(req)) as { signals: { id: string; about_concepts: string[] }[] };
        return JSON.stringify({
          questions: signals.map((s) => ({ id: s.id, text: 'Was your HSA coverage self-only or family?', about_concepts: s.about_concepts })),
        });
      },
    });
    const out = await runDiscovery(rig.deps, INPUT);
    expect(out.phrased_by).toBe('agent');
    expect(out.questions[0]!.text.endsWith('?')).toBe(true);
  });

  it('an output asserting a dollar amount is REJECTED; the deterministic fallback still asks', async () => {
    const rig = makeRig({
      discovery: () => JSON.stringify({
        questions: [{ id: 'hsa-coverage-missing', text: 'Your HSA contribution is $1,000, correct?', about_concepts: [] }],
      }),
    });
    const out = await runDiscovery(rig.deps, INPUT);
    expect(out.phrased_by).toBe('none'); // rejected — fallback phrasing used
    expect(out.questions).toHaveLength(1);
    expect(out.questions[0]!.text.endsWith('?')).toBe(true);
  });

  it('an invented topic (unknown signal id) is rejected', async () => {
    const rig = makeRig({
      discovery: () => JSON.stringify({
        questions: [{ id: 'made-up-topic', text: 'Do you have crypto?', about_concepts: [] }],
      }),
    });
    const out = await runDiscovery(rig.deps, INPUT);
    expect(out.phrased_by).toBe('none');
  });

  it('THE WALL: discovery has no write path — its source touches no spine mutation', () => {
    const source = readFileSync(fileURLToPath(new URL('../src/discovery.ts', import.meta.url)), 'utf8');
    expect(source).not.toMatch(/putSourceFact|confirmFact|commitComputation|registerSource|upsert/);
  });
});
