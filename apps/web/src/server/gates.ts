/** Orchestrator assembly + the gate board read model. */
import {
  CriticRegistry,
  Orchestrator,
  createDuplicateSingularCritics,
  createEstTaxPenaltyCritics,
  createF7RemainingCritics,
  createP98RetirementCritics,
  createStep1Critics,
} from '@taxfs/gates';
import { EventBus, type Clock, type FilingContext, type GateRun } from '@taxfs/shared';
import type { SpineBackend } from '@taxfs/spine';
import { releases } from './rules';
import { estTaxRules } from './yearround';

class RealClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export function buildOrchestrator(spine: SpineBackend, filing: FilingContext): Orchestrator {
  const registry = new CriticRegistry();
  for (const critic of [...createStep1Critics(), ...createF7RemainingCritics(), ...createP98RetirementCritics(), ...createEstTaxPenaltyCritics(), ...createDuplicateSingularCritics()]) {
    registry.register(critic);
  }
  return new Orchestrator(
    spine,
    registry,
    new EventBus(),
    filing,
    { fed: releases().fedRules, il: releases().ilRules },
    new RealClock(),
    // §6654 de-minimis floor, so the est-tax critic can tell "a penalty is
    // possible" from "it cannot be". Without it the critic stays silent.
    estTaxRules(),
  );
}

export interface BoardFinding {
  critic_id: string;
  message: string;
}

export interface BoardCell {
  gate: number;
  jurisdiction: string;
  result: string;
  ts: string;
  errors: BoardFinding[];
  warnings: BoardFinding[];
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
      errors: run.findings.filter((f) => f.severity === 'Error').map((f) => ({ critic_id: f.critic_id, message: f.message })),
      warnings: run.findings.filter((f) => f.severity !== 'Error').map((f) => ({ critic_id: f.critic_id, message: f.message })),
    }));
}
