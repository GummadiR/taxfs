/**
 * Deterministic fact-gap report (E.2 input). The agent PHRASES AND ORDERS;
 * what is needed is decided HERE, rule-driven — never by the model.
 */
import { C, THIRD_PARTY_FORM_BY_CONCEPT, type FilingContext, type SourceDoc, type TaxFact } from '@taxfs/shared';
import type { QuestionTemplate } from './rulestore';

export interface FactGap {
  gap_id: string;
  kind: 'missing_doc' | 'missing_concept' | 'attestation_required' | 'ledger_completeness';
  concept: string | null;
  detail: string;
  /** Set on attestation gaps: suggested template; the answer must route as an attestation. */
  attestation_template_id?: string;
}

export interface GapReportInput {
  facts: TaxFact[];
  sources: SourceDoc[];
  filing: FilingContext;
  templates: QuestionTemplate[];
}

export function buildGapReport(input: GapReportInput): FactGap[] {
  const gaps: FactGap[] = [];
  const confirmedConcepts = new Set(
    input.facts.filter((f) => f.status === 'confirmed' && f.derivation === undefined).map((f) => f.concept),
  );

  // (a) transcript records with no matching confirmed fact → missing document
  const transcript = input.sources.find((s) => s.type === 'IRS_WI_TRANSCRIPT');
  const rawRecords = transcript?.fields['records'];
  if (rawRecords !== undefined) {
    const records = JSON.parse(rawRecords) as { form: string; payer: string; concept: string; amount: string }[];
    for (const [i, rec] of records.entries()) {
      const matched = input.facts.some(
        (f) =>
          f.derivation === undefined &&
          f.status === 'confirmed' &&
          f.concept === rec.concept &&
          f.value.toString() === rec.amount,
      );
      if (!matched) {
        gaps.push({
          gap_id: `gap-doc-${i}`,
          kind: 'missing_doc',
          concept: rec.concept,
          detail: `${rec.form} from ${rec.payer} (${rec.amount}) appears on the IRS transcript but not among confirmed facts — upload or enter it`,
        });
      }
    }
  }

  // (b) wages confirmed but no withholding fact → likely missing W-2 boxes
  if (confirmedConcepts.has(C.WAGES) && !confirmedConcepts.has(C.FED_WITHHOLDING)) {
    gaps.push({
      gap_id: 'gap-fedwh',
      kind: 'missing_concept',
      concept: C.FED_WITHHOLDING,
      detail: 'Wages are confirmed but no federal withholding fact exists (W-2 box 2)',
    });
  }

  // (c) IL full-year residency attestation (Cap 25; R1 is IL-resident-only)
  if (!confirmedConcepts.has('attestation.il_residency')) {
    const template = input.templates.find((t) => t.determination === 'il_full_year_residency');
    if (template) {
      gaps.push({
        gap_id: 'gap-att-residency',
        kind: 'attestation_required',
        concept: template.maps_to,
        detail: 'Full-year IL residency is an attested determination and has not been captured',
        attestation_template_id: template.template_id,
      });
    }
  }

  // (d) Sch C ledger-completeness prompt (IRS-INCOME-RECON limitation:
  // "no 1099 ≠ no income") — fires once Sch C concepts exist (step 2+).
  if ([...confirmedConcepts].some((c) => c.startsWith('income.schc'))) {
    const template = input.templates.find((t) => t.maps_to === 'prompt.schc_ledger_completeness');
    if (template) {
      gaps.push({
        gap_id: 'gap-schc-ledger',
        kind: 'ledger_completeness',
        concept: template.maps_to,
        detail: 'Self-employment income present: transcript matching alone cannot prove completeness',
        attestation_template_id: template.template_id,
      });
    }
  }

  return gaps;
}

/** Concepts a third-party form is expected to cover (re-export for interview eval). */
export const EXPECTED_FORM_BY_CONCEPT = THIRD_PARTY_FORM_BY_CONCEPT;
