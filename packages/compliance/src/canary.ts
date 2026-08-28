/**
 * J.3 — Daily canary.
 * Fixed fixture documents run through the agent pipeline on a schedule
 * (cron stub — no real scheduler in the skeleton). ANY deviation from the
 * stored baseline HALTS INTAKE via the feature flag — the pipeline stops,
 * it does not merely log. Intake stays halted until a human re-enables it
 * after investigating.
 */
import { runExtraction, type DocImageStub } from '@taxfs/agents';
import type { AgentRunDeps } from '@taxfs/shared';

export interface CanaryBaseline {
  baseline_id: string;
  /** Canonical JSON of the expected extraction output per fixture doc. */
  expected: Record<string, string>;
}

export interface CanaryAlert {
  fired_at: string;
  doc_id: string;
  detail: string;
}

/** The intake feature flag — the canary's halt target. */
export class IntakeGate {
  private enabled = true;
  private halt_reason: string | null = null;

  isEnabled(): boolean {
    return this.enabled;
  }

  halt(reason: string): void {
    this.enabled = false;
    this.halt_reason = reason;
  }

  /** Re-enabling is a deliberate human action after investigation. */
  reenable(operator: string): void {
    if (this.enabled) return;
    this.enabled = true;
    this.halt_reason = null;
    void operator;
  }

  /** Every intake entry point checks the gate; a halted gate throws. */
  assertOpen(): void {
    if (!this.enabled) {
      throw new Error(`intake halted by canary: ${this.halt_reason ?? 'deviation detected'}`);
    }
  }
}

export interface CanaryResult {
  ok: boolean;
  checked: number;
  alerts: CanaryAlert[];
}

// Plain stringify: agent outputs are constructed with deterministic key
// order, and a replacer array would (wrongly) whitelist keys at every
// nesting depth.
function canonical(value: unknown): string {
  return JSON.stringify(value);
}

export async function runCanary(input: {
  deps: AgentRunDeps;
  docs: DocImageStub[];
  baseline: CanaryBaseline;
  gate: IntakeGate;
  now: string;
}): Promise<CanaryResult> {
  const alerts: CanaryAlert[] = [];
  for (const doc of input.docs) {
    const run = await runExtraction(input.deps, doc, 'canary');
    const expected = input.baseline.expected[doc.doc_id];
    if (expected === undefined) {
      alerts.push({ fired_at: input.now, doc_id: doc.doc_id, detail: 'no baseline recorded for canary doc' });
      continue;
    }
    const actual =
      run.status === 'ok'
        ? canonical(run.output)
        : run.status === 'manual_entry'
          ? '"MANUAL_ENTRY"'
          : '"REJECTED"';
    if (actual !== expected) {
      alerts.push({
        fired_at: input.now,
        doc_id: doc.doc_id,
        detail: `extraction deviates from baseline (agent output changed without a model/config release)`,
      });
    }
  }
  if (alerts.length > 0) {
    // HALT the pipeline — not a log line. Intake refuses until re-enabled.
    input.gate.halt(`canary deviation on ${alerts.map((a) => a.doc_id).join(', ')} at ${input.now}`);
  }
  return { ok: alerts.length === 0, checked: input.docs.length, alerts };
}

/** Cron stub: the schedule is declared; real scheduling is deployment wiring. */
export function canarySchedule(): { cron: string; description: string } {
  return { cron: '0 6 * * *', description: 'daily canary: fixed fixture docs through every agent before intake opens' };
}

export { canonical as canaryCanonical };
