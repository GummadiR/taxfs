/**
 * Engagement lifecycle gates 0–13 (P0 skeleton — REQUIREMENTS §3,
 * ARCHITECTURE §6).
 *
 * The existing orchestrator gates (GateId 0–6) are COMPUTATIONAL critics;
 * this board is the ENGAGEMENT lifecycle around them. Each engagement gate
 * either (a) derives its state from mapped computational gate runs,
 * (b) runs its own P0-implemented check (Gate 1 = capability registry,
 * Gate 3 registers-continuity input), or (c) reports `not_implemented` —
 * honestly visible, never silently green.
 */
import type { EngagementGateId, GateId, GateRun } from '@taxfs/shared';
import { ALL_ENGAGEMENT_GATES, type ScopeQualification } from '@taxfs/shared';
import type { ContinuityBreak } from '@taxfs/spine';
import type { TranscriptMatchReport } from './transcript';

export type EngagementTiming = 'continuous' | 'on_demand' | 'at_lock' | 'post_lock';

export type EngagementState =
  | 'pass'
  | 'blocked'
  | 'warned'
  | 'pending' // implemented but its inputs have not run yet
  | 'not_implemented';

export interface EngagementGateDef {
  id: EngagementGateId;
  title: string;
  timing: EngagementTiming;
  /** Computational gates whose runs this engagement gate derives from. */
  computational: readonly GateId[];
  /** P0 implementation status; flips as phases land (ARCHITECTURE §10). */
  implemented: boolean;
}

/**
 * Provisional re-homing of computational gates (ARCHITECTURE §6):
 *   comp 0 context            → eng 2  taxpayer profile
 *   comp 1 input validation   → eng 4  income reconciliation
 *   comp 2 business validation→ eng 4  income reconciliation
 *   comp 3 rule validation    → eng 6  tax-law, limits & elections
 *   comp 4 calculation        → eng 8  cross-form reconciliation
 *   comp 5 audit readiness    → eng 9  analytical review & diagnostics
 *   comp 6 filing readiness   → eng 10 filing artifact validation
 */
export const ENGAGEMENT_GATES: readonly EngagementGateDef[] = [
  { id: 0, title: 'Engagement Setup & Calendar', timing: 'continuous', computational: [], implemented: false },
  { id: 1, title: 'Scope Qualification', timing: 'continuous', computational: [], implemented: true },
  { id: 2, title: 'Taxpayer Profile', timing: 'continuous', computational: [0], implemented: true },
  { id: 3, title: 'Document Completeness, Carryforward & Method Continuity', timing: 'continuous', computational: [], implemented: true },
  { id: 4, title: 'Income Reconciliation', timing: 'continuous', computational: [1, 2], implemented: true },
  { id: 5, title: 'Evidence & Substantiation', timing: 'continuous', computational: [], implemented: false },
  { id: 6, title: 'Tax-Law, Limits & Elections', timing: 'on_demand', computational: [3], implemented: true },
  { id: 7, title: 'Independent Calculation', timing: 'on_demand', computational: [], implemented: false },
  { id: 8, title: 'Cross-Form Reconciliation', timing: 'on_demand', computational: [4], implemented: true },
  { id: 9, title: 'Analytical Review & Diagnostics', timing: 'on_demand', computational: [5], implemented: true },
  { id: 10, title: 'Filing Artifact Validation', timing: 'on_demand', computational: [6], implemented: true },
  { id: 11, title: 'Dual Sign-off', timing: 'at_lock', computational: [], implemented: false },
  { id: 12, title: 'Final Freeze & Audit', timing: 'at_lock', computational: [], implemented: false },
  { id: 13, title: 'Post-Filing Verification', timing: 'post_lock', computational: [], implemented: true },
];

export interface EngagementCell {
  id: EngagementGateId;
  title: string;
  timing: EngagementTiming;
  state: EngagementState;
  /** Human-readable reasons behind a blocked/warned state. */
  blocking: string[];
  warnings: string[];
}

export interface EngagementInput {
  /** Latest computational gate runs (all jurisdictions). */
  computationalRuns: readonly GateRun[];
  /** Gate 1 input: capability check over the return's confirmed concepts. */
  scope: ScopeQualification | null;
  /** Gate 3 input: register continuity breaks (empty array = checked & clean;
   *  null = registers not evaluated yet). */
  continuity: readonly ContinuityBreak[] | null;
  /** Gate 13 input: transcript match over the LOCKED package (null = no
   *  transcript entered yet — pending, which is normal until IRS processing). */
  transcript: TranscriptMatchReport | null;
}

function latestByGateJurisdiction(runs: readonly GateRun[]): GateRun[] {
  const latest = new Map<string, GateRun>();
  for (const run of runs) latest.set(`${run.gate}:${run.jurisdiction}`, run);
  return [...latest.values()];
}

function deriveFromComputational(def: EngagementGateDef, runs: readonly GateRun[]): EngagementCell {
  const relevant = latestByGateJurisdiction(runs).filter((r) => (def.computational as readonly number[]).includes(r.gate));
  if (relevant.length === 0) {
    return { id: def.id, title: def.title, timing: def.timing, state: 'pending', blocking: [], warnings: [] };
  }
  const blocking = relevant
    .filter((r) => r.result === 'fail')
    .flatMap((r) => r.findings.filter((f) => f.severity === 'Error').map((f) => `[${r.jurisdiction}] ${f.message}`));
  const warnings = relevant.flatMap((r) =>
    r.findings.filter((f) => f.severity !== 'Error').map((f) => `[${r.jurisdiction}] ${f.message}`),
  );
  const state: EngagementState = blocking.length > 0 ? 'blocked' : warnings.length > 0 ? 'warned' : 'pass';
  return { id: def.id, title: def.title, timing: def.timing, state, blocking, warnings };
}

/** Assemble the engagement board from the current inputs. Pure. */
export function assessEngagement(input: EngagementInput): EngagementCell[] {
  return ENGAGEMENT_GATES.map((def) => {
    if (!def.implemented) {
      return { id: def.id, title: def.title, timing: def.timing, state: 'not_implemented' as const, blocking: [], warnings: [] };
    }
    if (def.id === 1) {
      if (input.scope === null) {
        return { id: def.id, title: def.title, timing: def.timing, state: 'pending' as const, blocking: [], warnings: [] };
      }
      // Graded honesty: `verified` = computations hand-checked against
      // goldens/back-tests, only the rules dual-verification sign-off is
      // outstanding — that WARNS (yellow, named reason), it does not block
      // a personal draft. `in_development`/`absent` are genuinely unbuilt
      // — those still block, naming the family.
      const blocking = input.scope.blocked
        .filter((b) => b.status !== 'verified')
        .map((b) => `your documents need the "${b.family}" forms, and that part of this tool is ${b.status === 'in_development' ? 'still being built' : 'not built'} — this return cannot be completed here yet`);
      // One combined note, not one line per family: the reason is identical
      // for all of them, and a wall of near-duplicate jargon reads as four
      // problems when it is zero problems.
      const verifiedFams = input.scope.blocked
        .filter((b) => b.status === 'verified')
        .map((b) => `"${b.family}"`);
      const warnings = verifiedFams.length === 0 ? [] : [
        `${verifiedFams.join(', ')}: the tax math for ${verifiedFams.length === 1 ? 'this form family' : 'these form families'} is fully built and hand-checked against real returns. ` +
          'This yellow note only means the 2025 IRS numbers they use (brackets, limits, rates) still await the rules dual-verification sign-off — a second independent check that is a built-in caution of this tool, not a gap in your return. ' +
          'Nothing is needed from you, and this never blocks your filing.',
      ];
      return {
        id: def.id, title: def.title, timing: def.timing,
        state: blocking.length > 0 ? ('blocked' as const) : warnings.length > 0 ? ('warned' as const) : ('pass' as const),
        blocking, warnings,
      };
    }
    if (def.id === 3) {
      if (input.continuity === null) {
        return { id: def.id, title: def.title, timing: def.timing, state: 'pending' as const, blocking: [], warnings: [] };
      }
      const blocking = input.continuity.map(
        (b) => `register ${b.register_id} (${b.kind}) ${b.reason}${b.balance !== '*' ? ` on "${b.balance}": opening ${b.opening ?? '∅'} != prior closing ${b.prior_closing ?? '∅'}` : ''}`,
      );
      return {
        id: def.id, title: def.title, timing: def.timing,
        state: blocking.length > 0 ? ('blocked' as const) : ('pass' as const),
        blocking, warnings: [],
      };
    }
    if (def.id === 13) {
      if (input.transcript === null) {
        // Normal until IRS processing completes — pending, never silently green.
        return { id: def.id, title: def.title, timing: def.timing, state: 'pending' as const, blocking: [], warnings: [] };
      }
      const blocking = input.transcript.rows
        .filter((r) => !r.match)
        .map((r) => `transcript mismatch on ${r.concept} (${r.label}): filed ${r.package_value} vs IRS ${r.transcript_value} (Δ ${r.delta})`);
      if (input.transcript.rows.length === 0) {
        return {
          id: def.id, title: def.title, timing: def.timing, state: 'pending' as const,
          blocking: [], warnings: ['transcript entered with zero lines — nothing compared'],
        };
      }
      return {
        id: def.id, title: def.title, timing: def.timing,
        state: blocking.length > 0 ? ('blocked' as const) : ('pass' as const),
        blocking, warnings: [],
      };
    }
    return deriveFromComputational(def, input.computationalRuns);
  });
}

/** Package lock requires: no gate blocked, and no unimplemented HARD gate
 *  quietly skipped — 11 and 12 must be implemented before any lock. */
export function lockPreconditions(cells: readonly EngagementCell[]): string[] {
  const problems: string[] = [];
  for (const cell of cells) {
    if (cell.state === 'blocked') problems.push(`gate ${cell.id} (${cell.title}) is blocked`);
  }
  for (const id of [11, 12] as const) {
    const cell = cells.find((c) => c.id === id);
    if (cell && cell.state === 'not_implemented') {
      problems.push(`gate ${id} (${cell.title}) is not implemented — locking is impossible until it exists`);
    }
  }
  return problems;
}

export const ENGAGEMENT_GATE_IDS = ALL_ENGAGEMENT_GATES;
