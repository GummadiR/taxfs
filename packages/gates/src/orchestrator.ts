/**
 * PART F — gate orchestration.
 * Gates 0–6 as a deterministic state machine; every gate runs a Federal
 * pass and an IL pass. Hard gates (0–4, 6) block on Error; Gate 5 warns
 * and never blocks. Re-entrant via the spine's dependency-scoped
 * staleness cascade (A.2): mutating a source fact re-opens only the gates
 * whose latest run consumed an affected fact.
 */
import {
  C,
  EventBus,
  type Clock,
  type FilingContext,
  type Finding,
  type GateId,
  type GateResult,
  type GateRun,
  type Jurisdiction,
  type RuleSet,
  type TaxFact,
} from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import type { ComputationSink, SourceStore, SpineContracts, StalenessImpact } from '@taxfs/spine';
import { CriticRegistry, type CriticContext, type FindingDraft } from './critic';

export type Spine = SpineContracts & SourceStore & ComputationSink;
export type GateStateValue = 'pending' | 'passed' | 'failed' | 'warned' | 'stale';

const JURISDICTIONS: readonly Jurisdiction[] = ['FED', 'IL'];

export interface MutationOutcome {
  impact: StalenessImpact;
  reruns: GateRun[];
}

export class Orchestrator {
  private readonly states = new Map<string, GateStateValue>();
  /** Latest kernel run's calculation graph, for critic contexts (tie-outs). */
  private lastCalculations: readonly import('@taxfs/shared').Calculation[] = [];
  private findingSeq = 0;
  /** Per-instance uniqueness tag: finding rows PERSIST in Postgres across
   *  server restarts while findingSeq resets to 0 — a bare `fnd-0001` id
   *  collides with the previous session's rows on the first re-run
   *  (findings_pkey violation, hit in live testing). The tag makes ids
   *  globally unique without a schema change. */
  private readonly instanceTag = crypto.randomUUID().slice(0, 8);

  constructor(
    private readonly spine: Spine,
    private readonly registry: CriticRegistry,
    private readonly bus: EventBus,
    private readonly filing: FilingContext,
    private readonly rules: { fed: RuleSet; il: RuleSet },
    private readonly clock: Clock,
  ) {}

  gateState(gate: GateId, jur: Jurisdiction): GateStateValue {
    return this.states.get(`${gate}:${jur}`) ?? 'pending';
  }

  private setState(gate: GateId, jur: Jurisdiction, v: GateStateValue): void {
    this.states.set(`${gate}:${jur}`, v);
  }

  /** Full pipeline: gates 0–1, compute, gates 2–6. Stops at the first hard failure. */
  async runAll(): Promise<GateRun[]> {
    const runs: GateRun[] = [];
    for (const gate of [0, 1] as GateId[]) {
      for (const jur of JURISDICTIONS) {
        const run = await this.runGate(gate, jur);
        runs.push(run);
        if (run.result === 'fail') return runs;
      }
    }
    await this.computeAndCommit();
    for (const gate of [2, 3, 4, 5, 6] as GateId[]) {
      for (const jur of JURISDICTIONS) {
        const run = await this.runGate(gate, jur);
        runs.push(run);
        if (run.result === 'fail') return runs;
      }
    }
    this.maybePackageReady();
    return runs;
  }

  /**
   * Staleness re-entrancy (A.2 / trace step 8): the mutated fact's transitive
   * dependents go stale, affected gates re-open, the kernel recomputes, and
   * ONLY the re-opened gates re-run — dependency-scoped, not a full reset.
   */
  async handleFactMutation(fact_id: string): Promise<MutationOutcome> {
    const impact = await this.spine.markStale(fact_id);
    this.bus.publish({ kind: 'FactMutated', fact_id, stale_fact_ids: impact.stale_fact_ids });
    for (const g of impact.reopened_gates) this.setState(g.gate, g.jurisdiction, 'stale');
    await this.computeAndCommit();
    const reruns: GateRun[] = [];
    const ordered = [...impact.reopened_gates].sort(
      (a, b) => (a.gate - b.gate) || a.jurisdiction.localeCompare(b.jurisdiction),
    );
    // Unlike the initial pipeline, re-validation runs ALL re-opened gates so
    // the user sees the complete finding set; a failed hard gate still
    // blocks packaging via the Gate-6 state check.
    for (const g of ordered) {
      reruns.push(await this.runGate(g.gate, g.jurisdiction));
    }
    this.maybePackageReady();
    return { impact, reruns };
  }

  // ---------- internals ----------

  private allFacts(): Promise<TaxFact[]> {
    return this.spine.getFacts({ taxpayer_id: this.filing.taxpayer_id, tax_year: this.filing.tax_year });
  }

  private async computeAndCommit(): Promise<void> {
    const sourced = (await this.allFacts()).filter(
      (f) => f.derivation === undefined && f.status === 'confirmed',
    );
    const result = compute({
      taxpayer_id: this.filing.taxpayer_id,
      tax_year: this.filing.tax_year,
      ctx: this.filing,
      facts: sourced,
      fed_rules: this.rules.fed,
      il_rules: this.rules.il,
    });
    this.lastCalculations = result.calculations;
    const changed = await this.spine.commitComputation(result);
    for (const calc of result.calculations) {
      if (changed.includes(calc.output_fact_id)) {
        this.bus.publish({ kind: 'CalculationCompleted', calc_id: calc.calc_id, concept: calc.concept });
      }
    }
  }

  private ruleVersion(jur: Jurisdiction): string {
    return jur === 'FED' ? this.rules.fed.rule_version : this.rules.il.rule_version;
  }

  private finalizeFindings(gate: GateId, jur: Jurisdiction, drafts: FindingDraft[]): Finding[] {
    return drafts.map((d) => {
      this.findingSeq = this.findingSeq + 1;
      const finding: Finding = {
        finding_id: `fnd-${this.instanceTag}-${String(this.findingSeq).padStart(4, '0')}`,
        gate,
        ...d,
      };
      this.bus.publish({ kind: 'FindingRaised', finding });
      return finding;
    });
  }

  private async runGate(gate: GateId, jur: Jurisdiction): Promise<GateRun> {
    this.bus.publish({ kind: 'GateEntered', gate, jurisdiction: jur });
    const facts = await this.allFacts();
    const factsInJur = facts.filter((f) => f.jurisdiction.includes(jur));
    let drafts: FindingDraft[] = [];
    let consumed: string[] = [];

    switch (gate) {
      case 0:
        drafts = this.gate0Checks(jur);
        break;
      case 1:
        drafts = await this.gate1Checks();
        break;
      case 3:
        drafts = this.gate3Checks(jur);
        break;
      case 6:
        drafts = this.gate6Checks(jur, factsInJur);
        // Consumes sourced facts too: gate 6 re-verifies input confirmation
        // (defense-in-depth vs an edit left unconfirmed), so it must re-open
        // when any of them mutate.
        consumed = factsInJur.map((f) => f.fact_id);
        break;
      default: {
        // Gates 2, 4, 5: critic gates.
        const ctx: CriticContext = {
          gate,
          jurisdiction: jur,
          facts,
          calculations: [...this.lastCalculations],
          sources: await this.spine.getSources(this.filing.taxpayer_id, this.filing.tax_year),
          filing: this.filing,
          fed_rules: this.rules.fed,
          il_rules: this.rules.il,
        };
        for (const critic of this.registry.forGate(gate, jur)) {
          if (critic.applies_when(ctx)) drafts.push(...critic.evaluate(ctx));
        }
        consumed = factsInJur.map((f) => f.fact_id);
        break;
      }
    }

    const findings = this.finalizeFindings(gate, jur, drafts);
    const hasError = findings.some((f) => f.severity === 'Error');
    let result: GateResult;
    if (gate === 5) {
      // Gate 5 warns + requires acknowledgment; it NEVER blocks a lawful return.
      result = findings.length > 0 ? 'warn' : 'pass';
    } else {
      result = hasError ? 'fail' : 'pass';
    }
    const run = await this.spine.appendGateRun({
      taxpayer_id: this.filing.taxpayer_id,
      gate,
      jurisdiction: jur,
      rule_version: this.ruleVersion(jur),
      result,
      findings,
      consumed_fact_ids: consumed,
    });
    this.setState(gate, jur, result === 'fail' ? 'failed' : result === 'warn' ? 'warned' : 'passed');
    this.bus.publish({ kind: 'GateResult', gate, jurisdiction: jur, result });
    return run;
  }

  /** Gate 0 — context: rule set pinned for year × jurisdiction, carryforwards loaded. */
  private gate0Checks(jur: Jurisdiction): FindingDraft[] {
    const drafts: FindingDraft[] = [];
    const rs = jur === 'FED' ? this.rules.fed : this.rules.il;
    const err = (message: string): void => {
      drafts.push({ critic_id: 'GATE0-CONTEXT', lens: 'ACCOUNTANT', severity: 'Error', affected: [], message });
    };
    if (rs.jurisdiction !== jur) err(`rule set jurisdiction ${rs.jurisdiction} ≠ ${jur}`);
    if (rs.tax_year !== this.filing.tax_year) {
      err(`rule set tax_year ${rs.tax_year} ≠ filing context ${this.filing.tax_year}`);
    }
    if (this.filing.rule_versions[jur] !== rs.rule_version) {
      err(`pinned rule_version ${this.filing.rule_versions[jur]} ≠ loaded ${rs.rule_version}`);
    }
    // Prior-year carryforwards: none exist in the step-1 slice (Cap 22 lands later).
    return drafts;
  }

  /** Gate 1 — input validation: documents + extracted fields confirmed by the user. */
  private async gate1Checks(): Promise<FindingDraft[]> {
    const drafts: FindingDraft[] = [];
    for (const s of await this.spine.getSources(this.filing.taxpayer_id, this.filing.tax_year)) {
      if (s.review_status !== 'confirmed') {
        drafts.push({
          critic_id: 'GATE1-INPUT',
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [s.source_id],
          message: `Document ${s.source_id} (${s.type}) not confirmed by user`,
        });
      }
    }
    for (const f of await this.allFacts()) {
      if (f.derivation === undefined && f.status !== 'confirmed') {
        drafts.push({
          critic_id: 'GATE1-INPUT',
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [f.fact_id],
          message: `Extracted fact ${f.fact_id} (${f.concept}) not confirmed by user`,
        });
      }
    }
    return drafts;
  }

  /** Gate 3 — rule validation: rule set usable for this jurisdiction. */
  private gate3Checks(jur: Jurisdiction): FindingDraft[] {
    const drafts: FindingDraft[] = [];
    const rs = jur === 'FED' ? this.rules.fed : this.rules.il;
    if (rs.status === 'retired') {
      drafts.push({
        critic_id: 'GATE3-RULES',
        lens: 'ACCOUNTANT',
        severity: 'Error',
        affected: [rs.rule_version],
        message: `rule set ${rs.rule_version} is retired`,
      });
    }
    if (jur === 'FED' && rs.fed === undefined) {
      drafts.push({
        critic_id: 'GATE3-RULES',
        lens: 'ACCOUNTANT',
        severity: 'Error',
        affected: [rs.rule_version],
        message: 'FED parameters missing from rule set',
      });
    }
    if (jur === 'IL' && rs.il === undefined) {
      drafts.push({
        critic_id: 'GATE3-RULES',
        lens: 'ACCOUNTANT',
        severity: 'Error',
        affected: [rs.rule_version],
        message: 'IL parameters missing from rule set',
      });
    }
    return drafts;
  }

  /** Gate 6 — filing readiness: required lines present, prior hard gates passed. */
  private gate6Checks(jur: Jurisdiction, factsInJur: TaxFact[]): FindingDraft[] {
    const drafts: FindingDraft[] = [];
    const err = (affected: string[], message: string): void => {
      drafts.push({ critic_id: 'GATE6-PACKAGE', lens: 'ACCOUNTANT', severity: 'Error', affected, message });
    };
    for (const gate of [0, 1, 2, 3, 4] as GateId[]) {
      if (this.gateState(gate, jur) !== 'passed') {
        err([], `hard gate ${gate} (${jur}) is ${this.gateState(gate, jur)} — cannot package`);
      }
    }
    // Defense-in-depth (auditor finding F3): gate 1 checks confirmation
    // status but consumes no fact values, so it does not re-run on edits.
    // An edit left unconfirmed is excluded from compute and from critic
    // reconciliation baselines, so gates 2–5 can pass on silently-lower
    // totals. The package gate therefore re-verifies every input.
    for (const f of factsInJur) {
      if (f.derivation === undefined && f.status !== 'confirmed') {
        err([f.fact_id], `source fact ${f.concept} is ${f.status} — all inputs must be confirmed before packaging`);
      }
    }
    const required =
      jur === 'FED'
        ? [C.FED_TOTAL_INCOME, C.FED_AGI, C.FED_TAXABLE, C.FED_TAX, C.FED_REFUND_OR_DUE]
        : [C.IL_BASE_INCOME, C.IL_NET_INCOME, C.IL_TAX, C.IL_REFUND_OR_DUE];
    for (const concept of required) {
      const f = factsInJur.find((x) => x.concept === concept && x.derivation !== undefined);
      if (!f) {
        err([concept], `required form line ${concept} missing`);
      } else if (f.status === 'stale') {
        err([f.fact_id], `required form line ${concept} is stale`);
      } else if (!f.value.isWholeDollars()) {
        err([f.fact_id], `required form line ${concept} not schema-valid (whole dollars)`);
      }
    }
    return drafts;
  }

  private maybePackageReady(): void {
    if (this.gateState(6, 'FED') === 'passed' && this.gateState(6, 'IL') === 'passed') {
      this.bus.publish({ kind: 'PackageReady', tax_year: this.filing.tax_year });
    }
  }
}
