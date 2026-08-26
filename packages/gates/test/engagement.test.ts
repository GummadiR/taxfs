/** P0: EngagementBoard skeleton — gates 0–13 assembly and lock preconditions. */
import { describe, expect, it } from 'vitest';
import type { GateRun } from '@taxfs/shared';
import { assessEngagement, lockPreconditions, ENGAGEMENT_GATES } from '../src/engagement';

function run(gate: GateRun['gate'], result: GateRun['result'], findings: GateRun['findings'] = []): GateRun {
  return {
    run_id: `r-${gate}-${result}`,
    taxpayer_id: 'tp-test',
    gate,
    jurisdiction: 'FED',
    rule_version: 'v1',
    started: '2026-01-01T00:00:00Z',
    result,
    findings,
    consumed_fact_ids: [],
    timestamp: '2026-01-01T00:00:00Z',
  };
}

describe('engagement board (gates 0–13)', () => {
  it('covers exactly gates 0..13 with honest implementation flags', () => {
    expect(ENGAGEMENT_GATES.map((g) => g.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    // Unimplemented gates are visible, never silently green:
    const cells = assessEngagement({ computationalRuns: [], scope: null, continuity: null, transcript: null });
    for (const id of [0, 5, 7, 11, 12]) {
      expect(cells.find((c) => c.id === id)!.state).toBe('not_implemented');
    }
    // Gate 13 is implemented as of P5.3 — pending until a transcript is entered.
    expect(cells.find((c) => c.id === 13)!.state).toBe('pending');
  });

  it('gate 1 blocks when a required family is not production_ready', () => {
    const cells = assessEngagement({
      computationalRuns: [],
      scope: { admitted: false, required: ['schedule_c'], blocked: [{ family: 'schedule_c', status: 'absent' }] },
      continuity: [],
      transcript: null,
    });
    const g1 = cells.find((c) => c.id === 1)!;
    expect(g1.state).toBe('blocked');
    expect(g1.blocking[0]).toMatch(/schedule_c.*not built.*cannot be completed/);
  });

  it('gate 1 WARNS (never blocks) when the only gap is verified-pending-rules-signoff', () => {
    const cells = assessEngagement({
      computationalRuns: [],
      scope: { admitted: false, required: ['1040_core'], blocked: [{ family: '1040_core', status: 'verified' }] },
      continuity: [],
      transcript: null,
    });
    const g1 = cells.find((c) => c.id === 1)!;
    expect(g1.state).toBe('warned');
    expect(g1.blocking).toEqual([]);
    expect(g1.warnings[0]).toMatch(/1040_core.*rules dual-verification/);
  });

  it('gate 3 blocks on continuity breaks and passes when clean', () => {
    const withBreak = assessEngagement({
      computationalRuns: [],
      scope: { admitted: true, required: [], blocked: [] },
      continuity: [{ register_id: 'reg:x', kind: 'capital_loss', balance: 'carryover', opening: '-1500', prior_closing: '-2000', reason: 'opening_mismatch' }],
      transcript: null,
    });
    expect(withBreak.find((c) => c.id === 3)!.state).toBe('blocked');
    const clean = assessEngagement({ computationalRuns: [], scope: null, continuity: [], transcript: null });
    expect(clean.find((c) => c.id === 3)!.state).toBe('pass');
  });

  it('derives mapped gates from computational runs (latest run wins)', () => {
    const cells = assessEngagement({
      computationalRuns: [
        run(3, 'fail', [{ finding_id: 'f1', critic_id: 'X', lens: 'IRS', severity: 'Error', affected: [], message: 'stale parameter', gate: 3 }]),
        run(4, 'pass'),
        run(5, 'warn', [{ finding_id: 'f2', critic_id: 'Y', lens: 'IRS', severity: 'Audit-Risk', affected: [], message: 'round numbers', gate: 5 }]),
      ],
      scope: null,
      continuity: null,
      transcript: null,
    });
    expect(cells.find((c) => c.id === 6)!.state).toBe('blocked'); // comp 3 → eng 6
    expect(cells.find((c) => c.id === 8)!.state).toBe('pass'); // comp 4 → eng 8
    expect(cells.find((c) => c.id === 9)!.state).toBe('warned'); // comp 5 → eng 9
    expect(cells.find((c) => c.id === 10)!.state).toBe('pending'); // comp 6 never ran
  });

  it('lock is impossible while gates block or 11/12 are unimplemented', () => {
    const cells = assessEngagement({
      computationalRuns: [run(3, 'fail', [{ finding_id: 'f1', critic_id: 'X', lens: 'IRS', severity: 'Error', affected: [], message: 'boom', gate: 3 }])],
      scope: null,
      continuity: null,
      transcript: null,
    });
    const problems = lockPreconditions(cells);
    expect(problems.some((p) => p.includes('gate 6'))).toBe(true);
    expect(problems.some((p) => p.includes('gate 11') && p.includes('not implemented'))).toBe(true);
    expect(problems.some((p) => p.includes('gate 12') && p.includes('not implemented'))).toBe(true);
  });
});
