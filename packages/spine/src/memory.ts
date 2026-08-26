/**
 * In-memory reference implementation of the Part-A spine.
 *
 * The SQL shape (tables, RLS, audit triggers) lives in /supabase/migrations;
 * this implementation enforces the same invariants in code so the whole
 * A→C→F flow is testable without a running Postgres:
 *  - append-only audit log on every mutation and gate run
 *  - sourced XOR derived facts
 *  - dependency-scoped staleness cascade (A.2)
 *  - idempotent recompute (clean graph → no-op)
 *  - tenant scoping on every query (RLS analogue)
 */
import type {
  AuditLogEntry,
  Calculation,
  Clock,
  GateRun,
  SourceDoc,
  TaxFact,
} from '@taxfs/shared';
import type {
  ComputationResult,
  ComputationSink,
  FactQuery,
  GateRunInput,
  Inspectable,
  LineageNode,
  PutSourceFactInput,
  RegisterKind,
  RegisterSnapshot,
  RegisterStore,
  SpineContracts,
  SourceStore,
  StalenessImpact,
} from './contracts';

export class InMemorySpine implements SpineContracts, SourceStore, ComputationSink, Inspectable, RegisterStore {
  private readonly sources = new Map<string, SourceDoc>();
  private readonly facts = new Map<string, TaxFact>();
  private readonly calculations = new Map<string, Calculation>();
  /** calc-derived dependency edges: input fact_id → set of output fact_ids */
  private readonly dependents = new Map<string, Set<string>>();
  private readonly gateRuns: GateRun[] = [];
  private readonly registers = new Map<string, RegisterSnapshot>();
  private readonly audit: AuditLogEntry[] = [];
  private seq = 0;
  private runSeq = 0;

  constructor(
    private readonly clock: Clock,
    private readonly actor: string = 'system',
  ) {}

  // ---------- audit (append-only) ----------

  private appendAudit(
    action: AuditLogEntry['action'],
    entity_type: AuditLogEntry['entity_type'],
    entity_id: string,
    details: Record<string, unknown>,
    rule_version?: string,
  ): void {
    this.seq = this.seq + 1;
    const entry: AuditLogEntry = {
      seq: this.seq,
      at: this.clock.nowIso(),
      actor: this.actor,
      action,
      entity_type,
      entity_id,
      details,
      ...(rule_version !== undefined ? { rule_version } : {}),
    };
    this.audit.push(entry);
  }

  // ---------- SourceStore ----------

  async registerSource(doc: Omit<SourceDoc, 'review_status'>): Promise<SourceDoc> {
    if (this.sources.has(doc.source_id)) {
      throw new Error(`source ${doc.source_id} already registered (sources are immutable)`);
    }
    const stored: SourceDoc = { ...doc, review_status: 'pending' };
    this.sources.set(stored.source_id, stored);
    this.appendAudit('source.registered', 'source', stored.source_id, { type: stored.type });
    return stored;
  }

  async confirmSource(source_id: string): Promise<void> {
    const s = this.sources.get(source_id);
    if (!s) throw new Error(`source ${source_id} not found`);
    if (s.review_status === 'confirmed') return;
    this.sources.set(source_id, { ...s, review_status: 'confirmed' });
    this.appendAudit('source.confirmed', 'source', source_id, {});
  }

  async amendSourceField(source_id: string, field: string, value: string): Promise<void> {
    const s = this.sources.get(source_id);
    if (!s) throw new Error(`source ${source_id} not found`);
    const old = s.fields[field];
    if (old === value) return;
    this.sources.set(source_id, { ...s, fields: { ...s.fields, [field]: value } });
    this.appendAudit('source.amended', 'source', source_id, {
      field,
      old_value: old ?? null,
      new_value: value,
    });
  }

  async getSources(taxpayer_id: string, tax_year: number): Promise<SourceDoc[]> {
    return [...this.sources.values()].filter(
      (s) => s.taxpayer_id === taxpayer_id && s.tax_year === tax_year,
    );
  }

  async deleteSource(
    source_id: string,
    opts?: { cascade?: boolean },
  ): Promise<{ deleted_fact_ids: string[] }> {
    const s = this.sources.get(source_id);
    if (!s) throw new Error(`source ${source_id} not found`);
    // Directly-sourced (non-derived) facts whose provenance is this source.
    const factIds = [...this.facts.values()]
      .filter(
        (f) => f.derivation === undefined && (f.provenance ?? []).some((p) => p.source_id === source_id),
      )
      .map((f) => f.fact_id);

    if (opts?.cascade) {
      // Draft-return removal: drop this source's sourced facts AND the whole
      // derived layer (pure functions of sourced facts). The caller re-runs
      // the compute to rebuild the derived graph from the remaining sources —
      // so nothing is ever left orphaned.
      const derivedIds = [...this.facts.values()]
        .filter((f) => f.derivation !== undefined)
        .map((f) => f.fact_id);
      const removed = [...new Set([...factIds, ...derivedIds])];
      for (const id of removed) {
        this.facts.delete(id);
        this.appendAudit('fact.deleted', 'tax_fact', id, { reason: 'source_deleted_cascade', source_id });
      }
      this.dependents.clear(); // rebuilt on the next commitComputation
      this.calculations.clear();
      this.sources.delete(source_id);
      this.appendAudit('source.deleted', 'source', source_id, { type: s.type, cascade: true, deleted_fact_ids: removed });
      return { deleted_fact_ids: removed };
    }

    // Refuse if any of those facts has already been consumed into a computed
    // result — a plain delete would orphan the derived graph.
    for (const id of factIds) {
      if ((this.dependents.get(id)?.size ?? 0) > 0) {
        throw new Error(
          `document ${source_id} has values already used in computed results — re-open and re-run before removing it`,
        );
      }
    }
    for (const id of factIds) {
      this.facts.delete(id);
      this.dependents.delete(id);
      this.appendAudit('fact.deleted', 'tax_fact', id, { reason: 'source_deleted', source_id });
    }
    this.sources.delete(source_id);
    this.appendAudit('source.deleted', 'source', source_id, { type: s.type, deleted_fact_ids: factIds });
    return { deleted_fact_ids: factIds };
  }

  // ---------- SpineContracts ----------


  // ---------- RegisterStore ----------

  async upsertRegister(
    reg: Omit<RegisterSnapshot, 'status' | 'closing' | 'closed_by_package_id'>,
  ): Promise<RegisterSnapshot> {
    const existing = this.registers.get(reg.register_id);
    if (existing && existing.status === 'closed') {
      throw new Error(`register ${reg.register_id} is closed — closed registers are immutable`);
    }
    if (existing && (existing.taxpayer_id !== reg.taxpayer_id || existing.kind !== reg.kind || existing.tax_year !== reg.tax_year)) {
      throw new Error(`register ${reg.register_id}: taxpayer/kind/tax_year are immutable`);
    }
    const snap: RegisterSnapshot = {
      ...reg,
      opening: { ...reg.opening },
      activity: { ...reg.activity },
      closing: null,
      status: 'open',
      closed_by_package_id: null,
    };
    this.registers.set(snap.register_id, snap);
    this.appendAudit('register.upserted', 'register', snap.register_id, {
      kind: snap.kind, tax_year: snap.tax_year, scope_ref: snap.scope_ref,
      opening: snap.opening, activity: snap.activity,
    });
    return { ...snap };
  }

  async getRegisters(taxpayer_id: string, tax_year: number, kind?: RegisterKind): Promise<RegisterSnapshot[]> {
    return [...this.registers.values()]
      .filter((r) => r.taxpayer_id === taxpayer_id && r.tax_year === tax_year && (kind === undefined || r.kind === kind))
      .sort((a, b) => a.register_id.localeCompare(b.register_id))
      .map((r) => ({ ...r }));
  }

  async closeRegister(
    register_id: string,
    closing: Record<string, string>,
    closed_by_package_id: string,
  ): Promise<RegisterSnapshot> {
    const reg = this.registers.get(register_id);
    if (!reg) throw new Error(`register ${register_id} not found`);
    if (reg.status === 'closed') throw new Error(`register ${register_id} already closed`);
    const closed: RegisterSnapshot = { ...reg, closing: { ...closing }, status: 'closed', closed_by_package_id };
    this.registers.set(register_id, closed);
    this.appendAudit('register.closed', 'register', register_id, { closing, closed_by_package_id });
    // The roll: next year's register opens with this year's closing.
    const nextId = `${register_id.replace(/:y\d+$/, '')}:y${reg.tax_year + 1}`;
    if (!this.registers.has(nextId)) {
      const next: RegisterSnapshot = {
        register_id: nextId,
        taxpayer_id: reg.taxpayer_id,
        scope_ref: reg.scope_ref,
        kind: reg.kind,
        tax_year: reg.tax_year + 1,
        opening: { ...closing },
        activity: {},
        closing: null,
        status: 'open',
        closed_by_package_id: null,
        opening_source_ref: `register://${register_id}`,
      };
      this.registers.set(nextId, next);
      this.appendAudit('register.upserted', 'register', nextId, {
        kind: next.kind, tax_year: next.tax_year, scope_ref: next.scope_ref,
        opening: next.opening, rolled_from: register_id,
      });
    }
    return { ...closed };
  }

  // ---------- SpineContracts ----------

  async getFacts(query: FactQuery): Promise<TaxFact[]> {
    return [...this.facts.values()].filter((f) => {
      if (f.taxpayer_id !== query.taxpayer_id) return false;
      if (f.tax_year !== query.tax_year) return false;
      if (query.concepts && !query.concepts.includes(f.concept)) return false;
      if (query.jurisdiction && !f.jurisdiction.includes(query.jurisdiction)) return false;
      if (query.scope && f.taxpayer_scope !== query.scope) return false;
      return true;
    });
  }

  async putSourceFact(input: PutSourceFactInput): Promise<TaxFact> {
    if (input.provenance.length === 0) {
      throw new Error(`putSourceFact ${input.fact_id}: sourced facts require provenance`);
    }
    for (const p of input.provenance) {
      if (!this.sources.has(p.source_id)) {
        throw new Error(`putSourceFact ${input.fact_id}: unknown source ${p.source_id}`);
      }
    }
    const existing = this.facts.get(input.fact_id);
    if (existing) {
      if (existing.derivation !== undefined) {
        throw new Error(`fact ${input.fact_id} is derived; cannot overwrite via putSourceFact`);
      }
      if (existing.value.eq(input.value)) return existing;
      const updated: TaxFact = {
        ...existing,
        value: input.value,
        status: input.confirmed === true ? 'confirmed' : 'unconfirmed',
        confidence: input.confidence,
      };
      this.facts.set(updated.fact_id, updated);
      this.appendAudit('fact.mutated', 'tax_fact', updated.fact_id, {
        concept: updated.concept,
        old_value: existing.value.toString(),
        new_value: updated.value.toString(),
      });
      // A.2: mutating a source fact MARKS all transitive dependents stale —
      // here, not at the caller's discretion. markStale() stays the query
      // for the gate-reopen impact; the staleness itself is never skippable.
      this.markFactsStale(this.transitiveDependents(updated.fact_id), updated.fact_id);
      return updated;
    }
    const fact: TaxFact = {
      fact_id: input.fact_id,
      taxpayer_id: input.taxpayer_id,
      concept: input.concept,
      tax_year: input.tax_year,
      jurisdiction: input.jurisdiction,
      taxpayer_scope: input.taxpayer_scope,
      value: input.value,
      unit: 'USD',
      status: input.confirmed === true ? 'confirmed' : 'unconfirmed',
      confidence: input.confidence,
      provenance: input.provenance,
    };
    this.facts.set(fact.fact_id, fact);
    this.appendAudit('fact.created', 'tax_fact', fact.fact_id, {
      concept: fact.concept,
      value: fact.value.toString(),
      sourced: true,
    });
    return fact;
  }

  async confirmFact(fact_id: string): Promise<void> {
    const f = this.facts.get(fact_id);
    if (!f) throw new Error(`fact ${fact_id} not found`);
    if (f.status === 'confirmed') return;
    this.facts.set(fact_id, { ...f, status: 'confirmed' });
    this.appendAudit('fact.confirmed', 'tax_fact', fact_id, { concept: f.concept });
  }

  /** Transitive derived dependents of a fact (via calc dependency edges). */
  private transitiveDependents(fact_id: string): Set<string> {
    const found = new Set<string>();
    const visit = (id: string): void => {
      const outs = this.dependents.get(id);
      if (!outs) return;
      for (const out of outs) {
        if (!found.has(out)) {
          found.add(out);
          visit(out);
        }
      }
    };
    visit(fact_id);
    return found;
  }

  private markFactsStale(ids: Iterable<string>, origin: string): void {
    for (const id of ids) {
      const f = this.facts.get(id);
      if (f && f.status !== 'stale') {
        this.facts.set(id, { ...f, status: 'stale' });
        this.appendAudit('fact.marked_stale', 'tax_fact', id, { origin });
      }
    }
  }

  async markStale(fact_id: string): Promise<StalenessImpact> {
    const origin = this.facts.get(fact_id);
    if (!origin) throw new Error(`fact ${fact_id} not found`);

    // Transitive derived dependents of the origin (the origin itself is
    // included only if it is derived — a mutated source fact is fresh).
    const stale = this.transitiveDependents(fact_id);
    if (origin.derivation !== undefined) stale.add(fact_id);
    this.markFactsStale(stale, fact_id);

    // Re-open every gate whose LATEST run consumed an affected fact
    // (dependency-scoped, not a full reset) — for THIS taxpayer only.
    const affected = new Set<string>([fact_id, ...stale]);
    const latestByGate = new Map<string, GateRun>();
    for (const run of this.gateRuns) {
      if (run.taxpayer_id !== origin.taxpayer_id) continue;
      latestByGate.set(`${run.gate}:${run.jurisdiction}`, run);
    }
    const reopened: StalenessImpact['reopened_gates'] = [];
    for (const run of latestByGate.values()) {
      if (run.consumed_fact_ids.some((id) => affected.has(id))) {
        reopened.push({ gate: run.gate, jurisdiction: run.jurisdiction });
      }
    }
    reopened.sort((a, b) => (a.gate - b.gate) || a.jurisdiction.localeCompare(b.jurisdiction));
    return { stale_fact_ids: [...stale].sort(), reopened_gates: reopened };
  }

  async appendGateRun(input: GateRunInput): Promise<GateRun> {
    this.runSeq = this.runSeq + 1;
    const now = this.clock.nowIso();
    const run: GateRun = {
      run_id: `gaterun-${String(this.runSeq).padStart(4, '0')}`,
      taxpayer_id: input.taxpayer_id,
      gate: input.gate,
      jurisdiction: input.jurisdiction,
      rule_version: input.rule_version,
      started: now,
      result: input.result,
      findings: input.findings,
      consumed_fact_ids: [...input.consumed_fact_ids].sort(),
      timestamp: now,
    };
    this.gateRuns.push(run);
    this.appendAudit(
      'gate_run.appended',
      'gate_run',
      run.run_id,
      {
        gate: run.gate,
        jurisdiction: run.jurisdiction,
        result: run.result,
        findings: run.findings.map((f) => f.finding_id),
      },
      run.rule_version,
    );
    return run;
  }

  async getLineage(fact_id: string): Promise<LineageNode> {
    return this.lineageOf(fact_id, new Set());
  }

  private lineageOf(fact_id: string, seen: Set<string>): LineageNode {
    if (seen.has(fact_id)) throw new Error(`lineage cycle at ${fact_id}`);
    seen.add(fact_id);
    const fact = this.facts.get(fact_id);
    if (!fact) throw new Error(`fact ${fact_id} not found`);
    if (fact.derivation !== undefined) {
      const calc = this.calculations.get(fact.derivation);
      if (!calc) throw new Error(`fact ${fact_id}: missing calculation ${fact.derivation}`);
      return {
        fact,
        calculation: calc,
        inputs: calc.inputs.map((id) => this.lineageOf(id, new Set(seen))),
      };
    }
    const sources = (fact.provenance ?? []).map((p) => {
      const s = this.sources.get(p.source_id);
      if (!s) throw new Error(`fact ${fact_id}: missing source ${p.source_id}`);
      return s;
    });
    return { fact, sources };
  }

  // ---------- ComputationSink ----------

  async commitComputation(result: ComputationResult): Promise<string[]> {
    const changed: string[] = [];
    const calcByOutput = new Map<string, Calculation>();
    for (const calc of result.calculations) calcByOutput.set(calc.output_fact_id, calc);

    for (const computed of result.computedFacts) {
      const calc = calcByOutput.get(computed.fact_id);
      if (!calc) {
        throw new Error(`commitComputation: derived fact ${computed.fact_id} has no Calculation record`);
      }
      if (computed.provenance !== undefined) {
        throw new Error(`commitComputation: derived fact ${computed.fact_id} must not carry provenance`);
      }
      const existing = this.facts.get(computed.fact_id);
      if (existing && existing.derivation === undefined) {
        throw new Error(`fact ${computed.fact_id} is sourced; kernel cannot overwrite it`);
      }
      const priorCalc = existing ? this.calculations.get(existing.derivation ?? '') : undefined;
      const unchanged =
        existing !== undefined &&
        existing.status !== 'stale' &&
        existing.value.eq(computed.value) &&
        priorCalc !== undefined &&
        priorCalc.rule_version === calc.rule_version &&
        priorCalc.formula_ref === calc.formula_ref;
      if (unchanged) continue; // idempotent recompute: clean graph → no-op

      const stored: TaxFact = { ...computed, status: 'confirmed', derivation: calc.calc_id };
      this.facts.set(stored.fact_id, stored);
      this.calculations.set(calc.calc_id, calc);
      for (const inputId of calc.inputs) {
        const set = this.dependents.get(inputId) ?? new Set<string>();
        set.add(calc.output_fact_id);
        this.dependents.set(inputId, set);
      }
      this.appendAudit(
        existing ? 'fact.mutated' : 'fact.created',
        'tax_fact',
        stored.fact_id,
        { concept: stored.concept, value: stored.value.toString(), derived: true },
        calc.rule_version,
      );
      this.appendAudit(
        'calculation.recorded',
        'calculation',
        calc.calc_id,
        { concept: calc.concept, formula_ref: calc.formula_ref, value: calc.value.toString() },
        calc.rule_version,
      );
      changed.push(stored.fact_id);
    }
    return changed;
  }

  // ---------- inspection (tests / demo only) ----------

  /** Async for interface parity with PgSpine (which genuinely queries). */
  async inspect(_taxpayer_id?: string): Promise<{
    auditLog: readonly AuditLogEntry[];
    gateRuns: readonly GateRun[];
    calculations: readonly Calculation[];
  }> {
    return {
      auditLog: this.audit,
      gateRuns: this.gateRuns,
      calculations: [...this.calculations.values()],
    };
  }
}
