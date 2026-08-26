/** Gates test helpers: build CriticContexts from the kernel golden fixtures. */
import {
  FED_INCOME_CONCEPTS,
  Money,
  THIRD_PARTY_FORM_BY_CONCEPT,
  type GateId,
  type Jurisdiction,
  type SourceDoc,
  type SourceType,
  type TaxFact,
} from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import type { CriticContext } from '@taxfs/gates';
import {
  TP,
  ctxOf,
  factsOf,
  loadFedRules,
  loadGolden,
  loadIlRules,
  type GoldenFixture,
} from '../../kernel/test/helpers.js';

export const fedRules = loadFedRules();
export const ilRules = loadIlRules();

export interface TranscriptRecord {
  form: string;
  payer: string;
  concept: string;
  amount: string;
}

export function transcriptFor(facts: TaxFact[]): TranscriptRecord[] {
  return facts
    .filter((f) => FED_INCOME_CONCEPTS.includes(f.concept) && f.derivation === undefined)
    .map((f) => ({
      form: THIRD_PARTY_FORM_BY_CONCEPT[f.concept]?.[0] ?? 'UNKNOWN',
      payer: `payer-of-${f.fact_id}`,
      concept: f.concept,
      amount: f.value.toString(),
    }));
}

export function sourcesFor(golden: GoldenFixture, records: TranscriptRecord[]): SourceDoc[] {
  const docs: SourceDoc[] = golden.facts.map((row) => ({
    source_id: `s:${row.fact_id}`,
    taxpayer_id: TP,
    type: (THIRD_PARTY_FORM_BY_CONCEPT[row.concept]?.[0] ?? 'USER_ENTRY') as SourceType,
    tax_year: 2025,
    fields: { value: row.value },
    ocr_confidence: 0.99,
    raw_ref: `blob://${row.fact_id}`,
    review_status: 'confirmed',
  }));
  docs.push({
    source_id: 's:transcript',
    taxpayer_id: TP,
    type: 'IRS_WI_TRANSCRIPT',
    tax_year: 2025,
    fields: { records: JSON.stringify(records) },
    ocr_confidence: 1,
    raw_ref: 'blob://transcript',
    review_status: 'confirmed',
  });
  return docs;
}

export interface BuildOptions {
  gate?: GateId;
  jurisdiction?: Jurisdiction;
  /** Replace a derived line's value (seeded-defect injection). */
  tamper?: Record<string, string>;
  transcript?: TranscriptRecord[];
  extraSources?: SourceDoc[];
  dropTranscript?: boolean;
  /** Additional sourced facts (included BEFORE compute). */
  extraFacts?: TaxFact[];
  /** Override a sourced fact's value by fact_id (applied BEFORE compute). */
  factOverrides?: Record<string, string>;
  /** Override the fed rule set (e.g., authority-grade variations). */
  fedRulesOverride?: typeof fedRules;
}

export function buildCtx(goldenName: string, opts: BuildOptions = {}): CriticContext {
  const golden = loadGolden(goldenName);
  let sourced = factsOf(golden);
  if (opts.factOverrides) {
    for (const [factId, value] of Object.entries(opts.factOverrides)) {
      sourced = sourced.map((f) => (f.fact_id === factId ? { ...f, value: Money.fromString(value) } : f));
    }
  }
  if (opts.extraFacts) sourced = [...sourced, ...opts.extraFacts];
  const filing = ctxOf(golden, fedRules, ilRules);
  const activeFedRules = opts.fedRulesOverride ?? fedRules;
  const result = compute({
    taxpayer_id: TP,
    tax_year: 2025,
    ctx: filing,
    facts: sourced,
    fed_rules: activeFedRules,
    il_rules: ilRules,
  });
  let derived = result.computedFacts;
  if (opts.tamper) {
    for (const [concept, value] of Object.entries(opts.tamper)) {
      derived = derived.map((f) => (f.concept === concept ? { ...f, value: Money.fromString(value) } : f));
    }
  }
  const records = opts.transcript ?? transcriptFor(sourced);
  let sources = sourcesFor(golden, records);
  if (opts.dropTranscript) sources = sources.filter((s) => s.type !== 'IRS_WI_TRANSCRIPT');
  if (opts.extraSources) sources = [...sources, ...opts.extraSources];
  return {
    gate: opts.gate ?? 2,
    jurisdiction: opts.jurisdiction ?? 'FED',
    facts: [...sourced, ...derived],
    calculations: result.calculations,
    sources,
    filing,
    fed_rules: activeFedRules,
    il_rules: ilRules,
  };
}
