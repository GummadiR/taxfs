/**
 * Workstream D objects (spec D.1).
 * D consumes only confirmed/derived TaxFacts + Calculation lineage. It
 * performs NO tax computation and NO rounding — kernel values arrive
 * filing-ready; D serializes only.
 */
import type { Jurisdiction, Money } from '@taxfs/shared';

/** Declarative attachment/line conditions — rule-data, never code (D.2). */
export type RequiredWhen =
  | { kind: 'always' }
  | { kind: 'concept_present'; concept: string }
  | { kind: 'any_concept_present'; concepts: string[] }
  | { kind: 'concept_nonzero'; concept: string }
  | { kind: 'any_concept_sum_exceeds'; concepts: string[]; threshold: string };

export type SignConvention = 'as_is' | 'positive_only' | 'abs_of_negative';

export interface LineDef {
  line_id: string; // e.g. "1040.1a" — PLACEHOLDER line numbering, verify vs real forms
  label: string;
  /** MeF element name (FED) or IL field name — PLACEHOLDER until real schemas procured. */
  mef_element?: string;
  il_field?: string;
  datatype: 'money';
  from_concept: string;
  /**
   * Sign conventions are declarative per LineDef (D.2): e.g. refund lines
   * carry only the positive part, amount-owed lines the absolute value of
   * the negative part. A null result omits the line.
   */
  sign_convention: SignConvention;
  /** Omit the line when the value is exactly zero (MeF-style sparse output). */
  omit_when_zero?: boolean;
  /** Line's concept exists only when its sub-DAG ran — absence is NOT a defect. */
  optional?: boolean;
  /** Cross-form artifact check target: this line must equal that line (D.2). */
  must_equal?: { form_id: string; line_id: string };
}

export interface FormDefinition {
  form_id: string;
  jurisdiction: Jurisdiction;
  tax_year: number;
  revision: string;
  source_schema_ref: string; // MeF/IL schema pointer — PLACEHOLDER until procured
  pdf_template_ref: string;
  required_when: RequiredWhen;
  /** Assembly order for the paper bundle (IRS/IL stapling order — verify). */
  attachment_order: number;
  lines: LineDef[];
}

export interface FormInstance {
  instance_id: string;
  form_id: string;
  revision: string;
  jurisdiction: Jurisdiction;
  tax_year: number;
  taxpayer_id: string;
  /** Populated line values (filing-ready Money; omitted lines absent). */
  values: Record<string, Money>;
  /** Form-line lineage: every populated line maps to fact_id (+calc_id when derived). */
  lineage: Record<string, { fact_id: string; calc_id?: string }>;
  status: 'draft' | 'review' | 'final';
}

export interface MappingDefect {
  form_id: string;
  line_id: string;
  kind: 'missing_fact' | 'ambiguous_fact' | 'cross_form_mismatch' | 'not_whole_dollar' | 'unmapped_pdf_line' | 'value_exceeds_field';
  message: string;
}

export type PackageTarget = 'paper' | 'mef_xml' | 'workpapers';

export interface SchemaViolation {
  form_id: string;
  element: string;
  message: string;
}

export interface ValidationReport {
  schema_violations: SchemaViolation[];
  business_rule_errors: { rule_id: string; message: string }[];
  round_trip_mismatches: { form_id: string; line_id: string; expected: string; parsed: string }[];
  completeness_errors: string[];
  clean: boolean;
}

export interface PackageArtifact {
  artifact_id: string;
  target: PackageTarget;
  jurisdiction: Jurisdiction | 'ALL';
  content_type: 'application/xml' | 'text/x-pdf-placeholder' | 'application/json' | 'application/pdf';
  /** Deterministic content — byte-stable per rule_version (D.7 golden packages).
   *  For application/pdf this is BASE64 of the filled official template. */
  content: string;
}

export interface PackageManifest {
  package_id: string;
  taxpayer_id: string;
  tax_year: number;
  version: number;
  supersedes?: string; // prior package_id after unlock → rebuild
  targets: PackageTarget[];
  forms: string[]; // instance_ids
  generated_at: string;
  status: 'draft' | 'locked';
  /** Runtime-state archival (D.5, Rev. Proc. 97-22 posture — verify): */
  rule_versions: Record<Jurisdiction, string>;
  form_def_versions: Record<string, string>; // form_id → revision
  form_def_releases: Record<Jurisdiction, string>;
  kernel_version: string;
  schema_validation_report: ValidationReport;
  unlock_history: { unlocked_at: string; reason: string }[];
}
