/**
 * J.3: the existing traces (audit log, gate runs, agent calls, calc
 * lineage) unify into one queryable log — "what happened to this return"
 * is a single question.
 */
import { describe, expect, it } from 'vitest';
import { runGates } from './observability-helpers';
import { UnifiedLog } from '@taxfs/compliance';

describe('unified trace log (J.3)', () => {
  it('ingests all four trace kinds and answers cross-cutting queries', async () => {
    const { s, agentLog } = await runGates();
    const log = new UnifiedLog();
    log.ingestAudit((await s.spine.inspect()).auditLog);
    log.ingestGateRuns((await s.spine.inspect()).gateRuns);
    log.ingestCalculations((await s.spine.inspect()).calculations, '2026-07-02T00:00:00.000Z');
    log.ingestAgentCalls(agentLog.entries, '2026-07-02T00:00:00.000Z');

    expect(log.size()).toBeGreaterThan(40);
    expect(log.query({ kind: 'gate_run' }).length).toBeGreaterThanOrEqual(14);
    expect(log.query({ kind: 'calculation' }).length).toBeGreaterThan(15);
    expect(log.query({ kind: 'fact_mutation' }).length).toBeGreaterThan(5);
    expect(log.query({ kind: 'agent_call' })).toHaveLength(1);

    // Cross-cutting: everything touching the interest fact, one query.
    const interestTrail = log.query({ ref_contains: 'f:int-1:interest' });
    expect(interestTrail.some((e) => e.kind === 'fact_mutation')).toBe(true);
    // And the gate-5 story:
    const gate5 = log.query({ kind: 'gate_run', ref_contains: 'gate 5' });
    expect(gate5.every((e) => e.summary.includes('warn'))).toBe(true);
  });
});
