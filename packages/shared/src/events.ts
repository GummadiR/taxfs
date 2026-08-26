/**
 * Canonical Business Events (A.3): the skeleton's spine.
 * FactCreated → FactConfirmed → CalculationCompleted → GateEntered →
 * FindingRaised → GateResult → PackageReady.
 * Synchronous in-process bus; the Orchestrator subscribes — nothing calls
 * the kernel directly except through an event/command.
 */
import type { Finding, GateId, GateResult, Jurisdiction } from './types';

export type TaxosEvent =
  | { kind: 'FactCreated'; fact_id: string; concept: string }
  | { kind: 'FactConfirmed'; fact_id: string }
  | { kind: 'FactMutated'; fact_id: string; stale_fact_ids: string[] }
  | { kind: 'CalculationCompleted'; calc_id: string; concept: string }
  | { kind: 'GateEntered'; gate: GateId; jurisdiction: Jurisdiction }
  | { kind: 'FindingRaised'; finding: Finding }
  | { kind: 'GateResult'; gate: GateId; jurisdiction: Jurisdiction; result: GateResult }
  | { kind: 'PackageReady'; tax_year: number };

export type EventListener = (e: TaxosEvent) => void;

export class EventBus {
  private readonly listeners: EventListener[] = [];
  private readonly log: TaxosEvent[] = [];

  subscribe(l: EventListener): void {
    this.listeners.push(l);
  }

  publish(e: TaxosEvent): void {
    this.log.push(e);
    for (const l of this.listeners) l(e);
  }

  /** Read-only event history (test/inspection use). */
  history(): readonly TaxosEvent[] {
    return this.log;
  }
}
