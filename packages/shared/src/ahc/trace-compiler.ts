/**
 * ORIGIN: AHC (SCP repo) §14 — trace compiler.
 * Clean-room TS implementation per spec E.0 (see provider.ts header for the
 * shared-import caveat). Deterministic: no clock, no randomness — ordering
 * is the trace.
 */

export interface TraceStep {
  kind: 'input' | 'prompt' | 'response' | 'validation' | 'outcome';
  label: string;
  detail: string;
}

export interface AgentTrace {
  agent_id: string;
  steps: TraceStep[];
  rendered: string;
}

export class TraceRecorder {
  readonly steps: TraceStep[] = [];

  add(kind: TraceStep['kind'], label: string, detail: string): void {
    this.steps.push({ kind, label, detail });
  }
}

/** Compile an ordered step list into a stable, human-readable trace. */
export function compileTrace(agent_id: string, steps: TraceStep[]): AgentTrace {
  const lines = steps.map((s, i) => `${String(i + 1).padStart(2, '0')} [${s.kind}] ${s.label}: ${s.detail}`);
  return {
    agent_id,
    steps,
    rendered: [`trace(${agent_id})`, ...lines].join('\n'),
  };
}
