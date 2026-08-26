import type { Money } from './money';

/**
 * State modules (ARCHITECTURE §5): adding a state means adding its code
 * HERE and implementing the StateModule contract in packages/states/<code>.
 * Nothing else in kernel/spine/gates may branch on a specific state code.
 * TX is intentionally absent: no personal income tax return exists — its
 * franchise-tax compliance tracking never enters jurisdiction-typed flows.
 */
export type StateCode = 'IL';
export const STATE_CODES: readonly StateCode[] = ['IL'];
export type Jurisdiction = 'FED' | StateCode;
/** QSS is taxed at MFJ rates (IRC §2(a)); rule loaders fall back accordingly
 *  when a fixture predates the explicit qualifying_surviving_spouse key. */
export type FilingStatus = 'single' | 'mfj' | 'mfs' | 'hoh' | 'qss';
export type TaxpayerScope = 'primary' | 'spouse' | `entity:${string}`;
export type GateId = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const HARD_GATES: readonly GateId[] = [0, 1, 2, 3, 4, 6];
export const ALL_GATES: readonly GateId[] = [0, 1, 2, 3, 4, 5, 6];

/**
 * Engagement lifecycle gates 0–13 (REQUIREMENTS §3). The computational
 * gates above (GateId 0–6) are re-homed as internals of engagement gates —
 * see packages/gates/src/engagement.ts for the mapping.
 */
export type EngagementGateId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;
export const ALL_ENGAGEMENT_GATES: readonly EngagementGateId[] = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
];

export type Severity = 'Error' | 'Flag' | 'Optimization' | 'Audit-Risk';
export type Lens = 'IRS' | 'ACCOUNTANT';
export type AuthorityGrade =
  | 'substantial_authority'
  | 'reasonable_basis'
  | 'more_likely_than_not'
  | 'weak_or_none';

export type SourceType =
  | 'W-2'
  | '1099-INT'
  | '1099-DIV'
  | '1099-B'
  | '1099-R'
  | 'SSA-1099'
  | 'CONSOLIDATED-1099'
  | 'PROPERTY-TAX-BILL'
  | 'DONATION-RECEIPT'
  | 'FOREIGN-REMITTANCE'
  | 'K-1'
  | '1095-A'
  | '1098'
  | 'IRS_WI_TRANSCRIPT'
  | 'USER_ENTRY';

export type ReviewStatus = 'pending' | 'confirmed';

/** Immutable capture of what a document literally says. Money fields are decimal strings. */
export interface SourceDoc {
  source_id: string;
  taxpayer_id: string;
  type: SourceType;
  tax_year: number;
  /** Raw extracted fields; values are strings (decimal strings for money). */
  fields: Record<string, string>;
  ocr_confidence: number;
  raw_ref: string;
  review_status: ReviewStatus;
}

export type FactStatus = 'unconfirmed' | 'confirmed' | 'stale';

export interface Provenance {
  source_id: string;
  source_field: string;
}

/**
 * A TaxFact is either sourced (provenance[] → Source field) or derived
 * (derivation → the calc_id that produced it). Never both (enforced by the spine).
 */
export interface TaxFact {
  fact_id: string;
  taxpayer_id: string;
  concept: string;
  tax_year: number;
  jurisdiction: Jurisdiction[];
  taxpayer_scope: TaxpayerScope;
  value: Money;
  unit: 'USD';
  status: FactStatus;
  confidence: number;
  provenance?: Provenance[];
  derivation?: string; // calc_id
}

export interface Calculation {
  calc_id: string;
  taxpayer_id: string;
  concept: string;
  output_fact_id: string;
  rule_version: string;
  inputs: string[]; // fact_ids
  formula_ref: string;
  steps: string[];
  value: Money;
}

export interface Finding {
  finding_id: string;
  critic_id: string;
  lens: Lens;
  severity: Severity;
  authority_grade?: AuthorityGrade;
  irc_substantiation_met?: boolean;
  form_8275_required?: boolean;
  affected: string[]; // fact_ids or form-line refs
  message: string;
  fix_ref?: string;
  defense_artifact_ref?: string;
  gate: GateId;
}

export type GateResult = 'pass' | 'fail' | 'warn' | 'ack';

export interface GateRun {
  run_id: string;
  taxpayer_id: string;
  gate: GateId;
  jurisdiction: Jurisdiction;
  rule_version: string;
  started: string; // ISO timestamp (from injected clock)
  result: GateResult;
  findings: Finding[];
  /**
   * Fact ids whose values this gate run consumed. Not in the spec's GateRun
   * shape verbatim, but required to implement A.2's "re-opens every GateRun
   * that consumed them" dependency-scoped re-entrancy. Documented in README.
   */
  consumed_fact_ids: string[];
  timestamp: string;
}

export interface AuditLogEntry {
  seq: number;
  at: string;
  actor: string;
  action:
    | 'source.registered'
    | 'source.confirmed'
    | 'source.amended'
    | 'source.deleted'
    | 'fact.created'
    | 'fact.confirmed'
    | 'fact.mutated'
    | 'fact.marked_stale'
    | 'fact.deleted'
    | 'calculation.recorded'
    | 'gate_run.appended'
    | 'register.upserted'
    | 'register.closed';
  entity_type: 'source' | 'tax_fact' | 'calculation' | 'gate_run' | 'register';
  entity_id: string;
  details: Record<string, unknown>;
  rule_version?: string;
}

/** Deterministic clock injected into the spine/orchestrator (never the kernel). */
export interface Clock {
  nowIso(): string;
}

export interface FilingContext {
  taxpayer_id: string;
  tax_year: number;
  filing_status: FilingStatus;
  /** Number of exemptions claimed for IL (taxpayer + spouse for step 1). */
  il_exemption_count: number;
  /** IRC §63(f) additional standard-deduction boxes checked: taxpayer 65+,
   *  taxpayer blind, spouse 65+, spouse blind. 0–4. Each box adds one per-box
   *  amount to the standard deduction (never itemized). A non-identifying
   *  count — the per-person age/blind flags themselves stay in the local
   *  encrypted identity file; only this integer reaches the kernel. */
  addl_std_boxes: number;
  /** Pinned at Gate 0. */
  rule_versions: Record<Jurisdiction, string>;
}
