/**
 * J.3 — Unified queryable trace log.
 * The traces already exist (spine audit log, gate runs, agent call logs,
 * calculation lineage); this consolidates them into one queryable stream
 * so "what happened to this return" is a single question.
 */
import type { AgentCallLog, AuditLogEntry, Calculation, GateRun } from '@taxfs/shared';

export type TraceKind = 'fact_mutation' | 'gate_run' | 'agent_call' | 'calculation';

export interface TraceEntry {
  ts: string;
  kind: TraceKind;
  ref: string;
  summary: string;
  detail: Record<string, unknown>;
}

export class UnifiedLog {
  private readonly entries: TraceEntry[] = [];

  ingestAudit(rows: readonly AuditLogEntry[]): void {
    for (const row of rows) {
      this.entries.push({
        ts: row.at,
        kind: row.action === 'gate_run.appended' ? 'gate_run' : 'fact_mutation',
        ref: row.entity_id,
        summary: `${row.action} ${row.entity_type} ${row.entity_id}`,
        detail: { actor: row.actor, ...row.details },
      });
    }
  }

  ingestGateRuns(runs: readonly GateRun[]): void {
    for (const run of runs) {
      this.entries.push({
        ts: run.timestamp,
        kind: 'gate_run',
        ref: run.run_id,
        summary: `gate ${run.gate} ${run.jurisdiction} → ${run.result}`,
        detail: { rule_version: run.rule_version, findings: run.findings.length },
      });
    }
  }

  ingestAgentCalls(calls: readonly AgentCallLog[], ts: string): void {
    for (const call of calls) {
      this.entries.push({
        ts,
        kind: 'agent_call',
        ref: `${call.agent_id}#${call.input_hash}`,
        summary: `${call.agent_id} attempt ${call.attempt} → ${call.validation_result}`,
        detail: { model: call.model, provider: call.provider_id },
      });
    }
  }

  ingestCalculations(calcs: readonly Calculation[], ts: string): void {
    for (const calc of calcs) {
      this.entries.push({
        ts,
        kind: 'calculation',
        ref: calc.calc_id,
        summary: `${calc.concept} = ${calc.value.toString()} (${calc.formula_ref})`,
        detail: { rule_version: calc.rule_version, inputs: calc.inputs.length },
      });
    }
  }

  query(filter: { kind?: TraceKind; ref_contains?: string }): TraceEntry[] {
    return this.entries.filter(
      (e) =>
        (filter.kind === undefined || e.kind === filter.kind) &&
        (filter.ref_contains === undefined || e.ref.includes(filter.ref_contains) || e.summary.includes(filter.ref_contains)),
    );
  }

  size(): number {
    return this.entries.length;
  }
}
