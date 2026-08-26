/**
 * Thin end-to-end harness (the skeleton's "expose the flow" surface).
 * Seeds the step-1 scenario — W-2 + 1099-INT + estimated payments + mock
 * IRS Wage & Income transcript — wires spine + kernel + gates together,
 * and is used by both the e2e test suite and scripts/demo.ts.
 */
import {
  C,
  EventBus,
  Money,
  type Clock,
  type FilingContext,
  type Jurisdiction,
  type RuleSet,
  type SourceType,
} from '@taxfs/shared';
import { InMemorySpine } from '@taxfs/spine';
import { CriticRegistry } from './critic';
import { createStep1Critics } from './critics/step1';
import { createF7RemainingCritics } from './critics/f7-remaining';
import { Orchestrator } from './orchestrator';

/** Deterministic clock: fixed base instant, +1s per reading. */
export class FixedClock implements Clock {
  private tick = 0;
  constructor(private readonly baseIso = '2026-07-02T00:00:00.000Z') {}
  nowIso(): string {
    this.tick = this.tick + 1;
    const base = new Date(this.baseIso).getTime();
    return new Date(base + this.tick * 1000).toISOString();
  }
}

export const SCENARIO_TP = 'tp-e2e';
export const SCENARIO_YEAR = 2025;

export interface Scenario {
  spine: InMemorySpine;
  bus: EventBus;
  registry: CriticRegistry;
  orchestrator: Orchestrator;
  filing: FilingContext;
}

interface SeedDoc {
  source_id: string;
  type: SourceType;
  fields: Record<string, string>;
  facts: { fact_id: string; concept: string; field: string; jurisdiction: Jurisdiction[] }[];
}

const SEED_DOCS: SeedDoc[] = [
  {
    source_id: 's-w2-1',
    type: 'W-2',
    fields: { box1_wages: '50000', box2_fed_withholding: '4000', box17_il_withholding: '2000' },
    facts: [
      { fact_id: 'f:w2-1:wages', concept: C.WAGES, field: 'box1_wages', jurisdiction: ['FED', 'IL'] },
      { fact_id: 'f:w2-1:fedwh', concept: C.FED_WITHHOLDING, field: 'box2_fed_withholding', jurisdiction: ['FED'] },
      { fact_id: 'f:w2-1:ilwh', concept: C.IL_WITHHOLDING, field: 'box17_il_withholding', jurisdiction: ['IL'] },
    ],
  },
  {
    source_id: 's-int-1',
    type: '1099-INT',
    fields: { box1_interest: '1200' },
    facts: [{ fact_id: 'f:int-1:interest', concept: C.INTEREST, field: 'box1_interest', jurisdiction: ['FED', 'IL'] }],
  },
  {
    source_id: 's-fedest',
    type: 'USER_ENTRY',
    fields: { amount: '1000' },
    facts: [{ fact_id: 'f:user:fedest', concept: C.FED_ESTIMATED, field: 'amount', jurisdiction: ['FED'] }],
  },
  {
    source_id: 's-ilest',
    type: 'USER_ENTRY',
    fields: { amount: '1000' },
    facts: [{ fact_id: 'f:user:ilest', concept: C.IL_ESTIMATED, field: 'amount', jurisdiction: ['IL'] }],
  },
];

const TRANSCRIPT_RECORDS = [
  { form: 'W-2', payer: 'Acme Corp', concept: C.WAGES, amount: '50000' },
  { form: '1099-INT', payer: 'First Bank', concept: C.INTEREST, amount: '1200' },
];

export async function seedScenario(
  fed: RuleSet,
  il: RuleSet,
  clock: Clock = new FixedClock(),
): Promise<Scenario> {
  const spine = new InMemorySpine(clock, 'e2e');
  const bus = new EventBus();
  const filing: FilingContext = {
    taxpayer_id: SCENARIO_TP,
    tax_year: SCENARIO_YEAR,
    filing_status: 'single',
    il_exemption_count: 1,
    addl_std_boxes: 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };

  for (const doc of SEED_DOCS) {
    await spine.registerSource({
      source_id: doc.source_id,
      taxpayer_id: SCENARIO_TP,
      type: doc.type,
      tax_year: SCENARIO_YEAR,
      fields: doc.fields,
      ocr_confidence: 0.98,
      raw_ref: `blob://${doc.source_id}`,
    });
    for (const f of doc.facts) {
      const value = doc.fields[f.field];
      if (value === undefined) throw new Error(`seed: missing field ${f.field}`);
      await spine.putSourceFact({
        fact_id: f.fact_id,
        taxpayer_id: SCENARIO_TP,
        concept: f.concept,
        tax_year: SCENARIO_YEAR,
        jurisdiction: f.jurisdiction,
        taxpayer_scope: 'primary',
        value: Money.fromString(value),
        confidence: 0.98,
        provenance: [{ source_id: doc.source_id, source_field: f.field }],
      });
      bus.publish({ kind: 'FactCreated', fact_id: f.fact_id, concept: f.concept });
    }
  }
  await spine.registerSource({
    source_id: 's-transcript',
    taxpayer_id: SCENARIO_TP,
    type: 'IRS_WI_TRANSCRIPT',
    tax_year: SCENARIO_YEAR,
    fields: { records: JSON.stringify(TRANSCRIPT_RECORDS) },
    ocr_confidence: 1,
    raw_ref: 'blob://s-transcript',
  });

  // Gate-1 handoff: the user confirms extracted fields (AI → deterministic).
  for (const doc of SEED_DOCS) await spine.confirmSource(doc.source_id);
  await spine.confirmSource('s-transcript');
  for (const doc of SEED_DOCS) {
    for (const f of doc.facts) {
      await spine.confirmFact(f.fact_id);
      bus.publish({ kind: 'FactConfirmed', fact_id: f.fact_id });
    }
  }

  const registry = new CriticRegistry();
  for (const critic of createStep1Critics()) registry.register(critic);
  for (const critic of createF7RemainingCritics()) registry.register(critic);
  const orchestrator = new Orchestrator(spine, registry, bus, filing, { fed, il }, clock);
  return { spine, bus, registry, orchestrator, filing };
}

/**
 * User corrects a confirmed source fact (mutation path used by the e2e
 * trace + demo). Per E.6 the correction mutates the CAPTURE too — the
 * source field is amended alongside the fact so the record stays
 * internally consistent (doc-reconciliation critics compare the two).
 */
export async function editSourceFact(s: Scenario, fact_id: string, newValue: string): Promise<void> {
  const fact = (
    await s.spine.getFacts({ taxpayer_id: SCENARIO_TP, tax_year: SCENARIO_YEAR })
  ).find((f) => f.fact_id === fact_id);
  if (!fact || fact.provenance === undefined) throw new Error(`not a sourced fact: ${fact_id}`);
  for (const p of fact.provenance) {
    await s.spine.amendSourceField(p.source_id, p.source_field, newValue);
  }
  await s.spine.putSourceFact({
    fact_id: fact.fact_id,
    taxpayer_id: fact.taxpayer_id,
    concept: fact.concept,
    tax_year: fact.tax_year,
    jurisdiction: fact.jurisdiction,
    taxpayer_scope: fact.taxpayer_scope,
    value: Money.fromString(newValue),
    confidence: 1,
    provenance: fact.provenance,
    confirmed: true, // user-entered edit is itself the confirmation
  });
}
