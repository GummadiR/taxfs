/** Orchestrator assembly + the gate board read model. */
import {
  CriticRegistry,
  Orchestrator,
  createF7RemainingCritics,
  createP98RetirementCritics,
  createStep1Critics,
} from '@taxfs/gates';
import { EventBus, type Clock, type FilingContext, type GateRun } from '@taxfs/shared';
import type { SpineBackend } from '@taxfs/spine';
import { releases } from './rules';

class RealClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export function buildOrchestrator(spine: SpineBackend, filing: FilingContext): Orchestrator {
  const registry = new CriticRegistry();
  for (const critic of [...createStep1Critics(), ...createF7RemainingCritics(), ...createP98RetirementCritics()]) {
    registry.register(critic);
  }
  return new Orchestrator(
    spine,
    registry,
    new EventBus(),
    filing,
    { fed: releases().fedRules, il: releases().ilRules },
    new RealClock(),
  );
}

export interface BoardCell {
  gate: number;
  jurisdiction: string;
  result: string;
  ts: string;
  errors: string[];
  warnings: string[];
}

/** Latest run per (gate, jurisdiction) from the persisted gate runs. */
export function boardFromRuns(runs: readonly GateRun[]): BoardCell[] {
  const latest = new Map<string, GateRun>();
  for (const run of runs) latest.set(`${run.gate}:${run.jurisdiction}`, run);
  return [...latest.values()]
    .sort((a, b) => a.gate - b.gate || a.jurisdiction.localeCompare(b.jurisdiction))
    .map((run) => ({
      gate: run.gate,
      jurisdiction: run.jurisdiction,
      result: run.result,
      ts: run.timestamp,
      errors: run.findings.filter((f) => f.severity === 'Error').map((f) => f.message),
      warnings: run.findings.filter((f) => f.severity !== 'Error').map((f) => f.message),
    }));
}
