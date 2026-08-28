/**
 * I.4 — Amendment engine (1040-X / IL-1040-X).
 * Column A comes from the FILED baseline (pinned at markFiled), column C
 * from the corrected kernel run, column B is generated as C − A and the
 * per-line assertion re-verifies B = C − A over the assembled rows —
 * a tampered or drifted row fails, never ships. Explanations come ONLY
 * from pre-approved factual templates (rule-data); a finalized federal
 * change auto-opens the IL companion with the statutory countdown.
 */
import { C, Money, type TaxFact } from '@taxfs/shared';
import type { AmendmentCase, FilingRecord } from './cases';
import { fillTemplate, type AmendmentReason, type PostFilingRules } from './rules';

export interface AmendColumnRow {
  concept: string;
  label: string;
  col_a_original: string;
  col_b_change: string;
  col_c_corrected: string;
}

/** 1040-X row set for the step-1 slice `(verify real 1040-X line mechanics)`. */
const FED_1040X_LINES: [string, string][] = [
  [C.FED_TOTAL_INCOME, 'Total income'],
  [C.FED_AGI, 'Adjusted gross income'],
  [C.FED_DEDUCTION, 'Deduction'],
  [C.FED_TAXABLE, 'Taxable income'],
  [C.FED_TAX_AFTER_CREDITS, 'Tax after credits'],
  [C.FED_PAYMENTS, 'Payments'],
  [C.FED_REFUND_OR_DUE, 'Refund (+) / amount owed (−)'],
];

const IL_1040X_LINES: [string, string][] = [
  [C.IL_BASE_INCOME, 'IL base income'],
  [C.IL_NET_INCOME, 'IL net income'],
  [C.IL_TAX, 'IL tax'],
  [C.IL_PAYMENTS, 'IL payments'],
  [C.IL_REFUND_OR_DUE, 'IL refund (+) / amount owed (−)'],
];

function buildColumns(
  lines: [string, string][],
  baseline: Record<string, string>,
  corrected: TaxFact[],
): AmendColumnRow[] {
  return lines.map(([concept, label]) => {
    const a = baseline[concept];
    const cFact = corrected.find((f) => f.concept === concept && f.derivation !== undefined);
    if (a === undefined || !cFact) {
      throw new Error(`1040-X: missing ${a === undefined ? 'baseline' : 'corrected'} value for ${concept}`);
    }
    const colA = Money.fromString(a);
    const colC = cFact.value;
    return {
      concept,
      label,
      col_a_original: colA.toString(),
      col_b_change: colC.sub(colA).toString(),
      col_c_corrected: colC.toString(),
    };
  });
}

/** Per-line B = C − A assertion (I.4): re-verified over assembled rows. */
export function assertColumnConsistency(rows: AmendColumnRow[]): void {
  for (const row of rows) {
    const recomputed = Money.fromString(row.col_c_corrected).sub(Money.fromString(row.col_a_original));
    if (!recomputed.eq(Money.fromString(row.col_b_change))) {
      throw new Error(
        `1040-X column assertion failed on ${row.concept}: B=${row.col_b_change} but C−A=${recomputed.toString()}`,
      );
    }
  }
}

export interface AmendedReturn {
  amend_id: string;
  fed_rows: AmendColumnRow[];
  explanation_statement: string;
}

export function buildAmendedReturn(input: {
  amend: AmendmentCase;
  filing: FilingRecord;
  corrected_facts: TaxFact[];
  rules: PostFilingRules;
  slots: Record<string, string>;
}): AmendedReturn {
  const rows = buildColumns(FED_1040X_LINES, input.filing.baseline_lines, input.corrected_facts);
  assertColumnConsistency(rows);
  const template = input.rules.amendment_templates.find((t) => t.reason === input.amend.reason);
  if (!template) throw new Error(`no template for reason ${input.amend.reason}`);
  const taxRow = rows.find((r) => r.concept === C.FED_TAX_AFTER_CREDITS)!;
  const statement = fillTemplate(template.text, { delta: taxRow.col_b_change, ...input.slots });
  input.amend.explanation_statement = statement;
  return { amend_id: input.amend.amend_id, fed_rows: rows, explanation_statement: statement };
}

/**
 * I.4 federal→IL sync: finalizing the federal amendment starts the IL
 * conformity clock and auto-opens the IL companion. The alert persists
 * until the IL-1040-X is generated.
 */
export function finalizeFederalAmendment(input: {
  amend: AmendmentCase;
  new_package_ref: string;
  final_determination_date: string; // ISO date
  rules: PostFilingRules;
}): AmendmentCase {
  if (input.amend.status === 'finalized') throw new Error(`amendment ${input.amend.amend_id} already finalized`);
  const due = new Date(Date.parse(`${input.final_determination_date}T00:00:00.000Z`));
  due.setUTCDate(due.getUTCDate() + input.rules.il_sync_window_days);
  const due_date = due.toISOString().slice(0, 10);
  input.amend.new_package_ref = input.new_package_ref;
  input.amend.status = 'finalized';
  input.amend.il_companion = {
    due_date,
    alert: input.rules.il_sync_alert_template
      .replace('{days}', String(input.rules.il_sync_window_days))
      .replace('{due_date}', due_date),
    generated: false,
  };
  return input.amend;
}

export function generateIlCompanion(input: {
  amend: AmendmentCase;
  filing: FilingRecord;
  corrected_facts: TaxFact[];
}): { il_rows: AmendColumnRow[] } {
  if (input.amend.status !== 'finalized' || !input.amend.il_companion) {
    throw new Error('IL companion opens only from a finalized federal amendment');
  }
  const rows = buildColumns(IL_1040X_LINES, input.filing.baseline_lines, input.corrected_facts);
  assertColumnConsistency(rows);
  input.amend.il_companion.generated = true;
  return { il_rows: rows };
}

export type { AmendmentReason };
