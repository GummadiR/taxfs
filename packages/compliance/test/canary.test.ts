/**
 * J.3 acceptance: the daily canary HALTS THE PIPELINE on deviation — the
 * intake gate refuses work, it does not merely log. Re-enabling is a
 * deliberate human action.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CANARY_DOCS,
  IntakeGate,
  canaryExtractionHandler,
  canarySchedule,
  makeCanaryDeps,
  runCanary,
  type CanaryBaseline,
} from '@taxfs/compliance';

const baseline: CanaryBaseline = JSON.parse(
  readFileSync(fileURLToPath(new URL('../golden/canary-baseline.json', import.meta.url)), 'utf8'),
);

describe('daily canary (J.3)', () => {
  it('clean run: baseline matches, intake stays open', async () => {
    const gate = new IntakeGate();
    const result = await runCanary({ deps: makeCanaryDeps(), docs: CANARY_DOCS, baseline, gate, now: '2026-07-02T06:00:00Z' });
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(2);
    expect(gate.isEnabled()).toBe(true);
    expect(() => gate.assertOpen()).not.toThrow();
  });

  it('SEEDED DEVIATION: a drifted agent output HALTS intake — the pipeline refuses work', async () => {
    const gate = new IntakeGate();
    // The "model" silently starts reading box 1 as 42001 instead of 42000.
    const driftedDeps = makeCanaryDeps((req) => canaryExtractionHandler(req).replace('"value":"42000"', '"value":"42001"'));
    const result = await runCanary({ deps: driftedDeps, docs: CANARY_DOCS, baseline, gate, now: '2026-07-03T06:00:00Z' });
    expect(result.ok).toBe(false);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0]?.doc_id).toBe('canary-w2');
    // Halted, not logged: the gate now throws for any intake entry point.
    expect(gate.isEnabled()).toBe(false);
    expect(() => gate.assertOpen()).toThrow(/intake halted by canary/);
    // Recovery is deliberate and human
    gate.reenable('oncall-operator');
    expect(() => gate.assertOpen()).not.toThrow();
  });

  it('a canary doc with no recorded baseline also halts (fail closed)', async () => {
    const gate = new IntakeGate();
    const partial: CanaryBaseline = { baseline_id: 'partial', expected: { 'canary-w2': baseline.expected['canary-w2']! } };
    const result = await runCanary({ deps: makeCanaryDeps(), docs: CANARY_DOCS, baseline: partial, gate, now: '2026-07-03T06:00:00Z' });
    expect(result.ok).toBe(false);
    expect(gate.isEnabled()).toBe(false);
  });

  it('the schedule is declared (cron stub — wiring is deployment concern)', () => {
    expect(canarySchedule().cron).toBe('0 6 * * *');
  });
});
