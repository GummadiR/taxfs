/**
 * PART A contracts.
 *
 * `SpineContracts` is exactly the A.5 surface — C and F touch data only
 * through these six methods:
 *   getFacts · putSourceFact · confirmFact · markStale · appendGateRun · getLineage
 *
 * Two deliberately separate, documented additions (see README "Spec
 * resolutions"): `SourceStore` (Sources are documents that exist *before*
 * facts; A.1 defines them but A.5 lists no way to register one) and
 * `ComputationSink` (compute() returns { computedFacts, calculations } per
 * C.6, and *something* must persist them for getLineage to walk; A.5 lists
 * no write path for derived facts). Both are used only by the Orchestrator.
 */
import type {
  AuditLogEntry,
  Calculation,
  Finding,
  GateId,
  GateRun,
  GateResult,
  Jurisdiction,
  Money,
  Provenance,
  SourceDoc,
  TaxFact,
  TaxpayerScope,
} from '@taxfs/shared';

export interface FactQuery {
  taxpayer_id: string;
  tax_year: number;
  concepts?: string[];
  jurisdiction?: Jurisdiction;
  scope?: TaxpayerScope;
}

export interface PutSourceFactInput {
  fact_id: string;
  taxpayer_id: string;
  concept: string;
  tax_year: number;
  jurisdiction: Jurisdiction[];
  taxpayer_scope: TaxpayerScope;
  value: Money;
  confidence: number;
  provenance: Provenance[];
  /** true when the value was entered/edited by the user (already confirmed). */
  confirmed?: boolean;
}

/** Result of a staleness cascade (A.2): dependency-scoped, not a full reset. */
export interface StalenessImpact {
  /** The mutated/marked fact plus all transitive derived dependents. */
  stale_fact_ids: string[];
  /** Distinct (gate, jurisdiction) pairs whose latest run consumed an affected fact. */
  reopened_gates: { gate: GateId; jurisdiction: Jurisdiction }[];
}

export interface GateRunInput {
  taxpayer_id: string;
  gate: GateId;
  jurisdiction: Jurisdiction;
  rule_version: string;
  result: GateResult;
  findings: Finding[];
  consumed_fact_ids: string[];
}

export interface LineageNode {
  fact: TaxFact;
  /** Present when the fact is derived: the Calculation plus its input lineage. */
  calculation?: Calculation;
  inputs?: LineageNode[];
  /** Present when the fact is sourced. */
  sources?: SourceDoc[];
}

/**
 * Exactly the A.5 contract surface.
 * Session 2: methods are async (Promise-returning) so the same contract is
 * implementable by both the in-memory reference and the Postgres adapter.
 */
export interface SpineContracts {
  getFacts(query: FactQuery): Promise<TaxFact[]>;
  putSourceFact(input: PutSourceFactInput): Promise<TaxFact>;
  confirmFact(fact_id: string): Promise<void>;
  markStale(fact_id: string): Promise<StalenessImpact>;
  appendGateRun(input: GateRunInput): Promise<GateRun>;
  getLineage(fact_id: string): Promise<LineageNode>;
}

/** Documented addition — sources registry (pre-fact documents, Gate 1 confirms). */
export interface SourceStore {
  registerSource(doc: Omit<SourceDoc, 'review_status'>): Promise<SourceDoc>;
  confirmSource(source_id: string): Promise<void>;
  getSources(taxpayer_id: string, tax_year: number): Promise<SourceDoc[]>;
  /**
   * Correct a mis-captured field on a Source (E.6: "a corrected extraction
   * mutates the Source"). The document artifact (raw_ref) stays immutable;
   * the CAPTURE is what gets fixed, with an audit row. Without this, a
   * user correction leaves the fact contradicting its own document and
   * doc-reconciliation critics (rightly) block the return.
   */
  amendSourceField(source_id: string, field: string, value: string): Promise<void>;
  /**
   * Remove an uploaded document and its directly-sourced facts (personal-use
   * "I picked the wrong doc" path). Deletes the source row and every
   * non-derived fact whose provenance is this source, plus their provenance
   * rows; the deletion itself is audited (append-only audit trigger fires on
   * DELETE). Returns the fact_ids that were removed.
   *
   * Default (no cascade): REFUSES if any of those sourced facts have already
   * been consumed into a computed result (derived dependents exist) — a plain
   * delete must never leave the derived graph dangling.
   *
   * `cascade: true`: also drops the ENTIRE derived layer (all calculations +
   * derived facts + dependency edges) for the taxpayer/year, so nothing is
   * orphaned. Derived facts are pure functions of sourced facts, so the
   * caller MUST re-run the compute afterward to rebuild them from the
   * remaining sources. Used for draft-return document removal.
   */
  deleteSource(
    source_id: string,
    opts?: { cascade?: boolean },
  ): Promise<{ deleted_fact_ids: string[] }>;
}


// ===========================================================================
// Registers (P0 foundation — ARCHITECTURE §3.2): ALL multi-year state.
// Year close computes `closing` and rolls it into next year's `opening`;
// Gate 3 continuity is the literal assertion opening == prior locked closing.
// ===========================================================================

export type RegisterKind =
  | 'capital_loss'
  | 'nol'
  | 'passive_loss'
  | 'qbi_loss'
  | 'basis_stock'
  | 'basis_debt'
  | 'basis_outside'
  | 'depreciation_asset'
  | 'home_office_carryover';

export const REGISTER_KINDS: readonly RegisterKind[] = [
  'capital_loss', 'nol', 'passive_loss', 'qbi_loss', 'basis_stock',
  'basis_debt', 'basis_outside', 'depreciation_asset', 'home_office_carryover',
];

export interface RegisterSnapshot {
  register_id: string;
  taxpayer_id: string;
  /** What this register tracks: an entity_id, activity id, or asset id. */
  scope_ref: string;
  kind: RegisterKind;
  tax_year: number;
  /** Balances are decimal strings keyed by balance name (e.g. { amount }). */
  opening: Record<string, string>;
  activity: Record<string, string>;
  /** null while the year is open; set exactly once at year close. */
  closing: Record<string, string> | null;
  status: 'open' | 'closed';
  closed_by_package_id: string | null;
  /** First-year manual opening balances need attached support (Gate 3). */
  opening_source_ref: string | null;
}

export interface RegisterStore {
  /** Create or update an OPEN register's opening/activity. Closed registers are immutable. */
  upsertRegister(reg: Omit<RegisterSnapshot, 'status' | 'closing' | 'closed_by_package_id'>): Promise<RegisterSnapshot>;
  getRegisters(taxpayer_id: string, tax_year: number, kind?: RegisterKind): Promise<RegisterSnapshot[]>;
  /**
   * Close a register for the year: records `closing`, marks it immutable,
   * and creates next year's register with opening = closing (the roll).
   * Refuses if already closed.
   */
  closeRegister(register_id: string, closing: Record<string, string>, closed_by_package_id: string): Promise<RegisterSnapshot>;
}

export interface ComputationResult {
  computedFacts: TaxFact[];
  calculations: Calculation[];
}

/** Documented addition — persistence for kernel output (used by the Orchestrator only). */
export interface ComputationSink {
  /**
   * Persist derived facts + calculations. Idempotent: identical recompute of
   * a clean graph is a no-op (no mutations, no audit rows, no staleness).
   * Returns fact_ids whose values actually changed.
   */
  commitComputation(result: ComputationResult): Promise<string[]>;
}

/**
 * Documented addition — read-only debug/demo dump (gates board, risk-profile
 * assembly in apps/web). Not part of A.5; deliberately excluded from the
 * strict getFacts/appendGateRun path so it can never become a write side
 * channel. P36: RLS identity is the OPERATOR, and one operator owns many
 * client workspaces (P35) — so reads must ALSO scope by taxpayer_id or one
 * client's gate runs bleed into another's boards. Pass the tenant; omitting
 * it returns all rows the identity can see (single-tenant tests only).
 */
export interface Inspectable {
  inspect(taxpayer_id?: string): Promise<{
    auditLog: readonly AuditLogEntry[];
    gateRuns: readonly GateRun[];
    calculations: readonly Calculation[];
  }>;
}

/** Convenience: what the orchestrator and review store need from a spine backend. */
export type SpineBackend = SpineContracts & SourceStore & ComputationSink & Inspectable & RegisterStore;
