/**
 * PART F — critic framework.
 * A critic is a deterministic analyzer registered against one or more gates.
 * Critics READ TaxFacts + rule data, EMIT findings, never mutate facts and
 * never compute final tax. No AI lives here (explanation is workstream E).
 */
import type {
  AuthorityGrade,
  Calculation,
  FilingContext,
  GateId,
  Jurisdiction,
  Lens,
  RuleSet,
  Severity,
  SourceDoc,
  TaxFact,
} from '@taxfs/shared';

export interface CriticContext {
  gate: GateId;
  jurisdiction: Jurisdiction;
  /** All facts for the taxpayer/tax-year (both jurisdictions; critics filter). */
  facts: TaxFact[];
  /** The kernel run's calculation graph — the tie-out critic re-adds the
   *  recorded terms instead of restating any formula (§3.2, P76 class). */
  calculations: Calculation[];
  sources: SourceDoc[];
  filing: FilingContext;
  fed_rules: RuleSet;
  il_rules: RuleSet;
  /**
   * §6654 / Form 2210 parameters, when the caller has them. Typed
   * STRUCTURALLY rather than imported from @taxfs/defense: gates has no
   * dependency on defense today, and one critic needing one threshold is not
   * a reason to add a package edge. OPTIONAL on purpose, so every existing
   * orchestrator construction site keeps compiling and a critic that needs
   * it declares so in applies_when.
   */
  esttax_rules?: { de_minimis_balance_due: string };
}

/** A finding as produced by a critic; the gate engine assigns finding_id + gate. */
export interface FindingDraft {
  critic_id: string;
  lens: Lens;
  severity: Severity;
  affected: string[];
  message: string;
  fix_ref?: string;
  defense_artifact_ref?: string;
  authority_grade?: AuthorityGrade;
  irc_substantiation_met?: boolean;
  form_8275_required?: boolean;
}

export interface Critic {
  id: string;
  lens: Lens;
  gates: GateId[];
  jurisdiction: Jurisdiction[];
  applies_when(ctx: CriticContext): boolean;
  /** Pure and deterministic. */
  evaluate(ctx: CriticContext): FindingDraft[];
}

/** Registry: adding a critic = registering it, not editing the engine. */
export class CriticRegistry {
  private readonly critics: Critic[] = [];

  register(critic: Critic): void {
    if (this.critics.some((c) => c.id === critic.id)) {
      throw new Error(`critic ${critic.id} already registered`);
    }
    this.critics.push(critic);
  }

  forGate(gate: GateId, jurisdiction: Jurisdiction): Critic[] {
    return this.critics.filter(
      (c) => c.gates.includes(gate) && c.jurisdiction.includes(jurisdiction),
    );
  }

  all(): readonly Critic[] {
    return this.critics;
  }
}
