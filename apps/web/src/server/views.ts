/**
 * Read models for the Forms and E-file screens, ported from TaxOS
 * (P7.2 printable return view, P11.2 e-file companion) onto TaxFS's
 * stateless per-request model — no session cache (§1.3.1), every read runs
 * as the authenticated user over RLS.
 *
 * Mapping does no math: every value on these views is a kernel-emitted
 * total with lineage, resolved through packages/forms.
 */
import { resolveFormSet, populateInstances, type FormDefRelease } from '@taxfs/forms';
import { C, type TaxFact } from '@taxfs/shared';
import { withSpine, withUserClient } from './db';
import { filingContext } from './filing';
import { releases } from './rules';
import { TAX_YEAR } from './env';

export interface FormLineDto { line_id: string; label: string; value: string }
export interface FormInstanceDto {
  form_id: string;
  jurisdiction: string;
  revision: string;
  pdf_available: boolean;
  headline: string;
  lines: FormLineDto[];
}
export interface FormsViewDto { forms: FormInstanceDto[]; defects: string[] }

async function confirmedFacts(userId: string, ws: string): Promise<TaxFact[]> {
  return withSpine({ userId, workspaceId: ws }, async (spine) =>
    (await spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR })).filter((f) => f.status === 'confirmed'));
}

/** Populated form instances over the CURRENT facts (draft view; the locked
 *  package on File It stays the filing artifact of record). */
export async function getFormsView(userId: string, ws: string): Promise<FormsViewDto> {
  const facts = await confirmedFacts(userId, ws);
  const out: FormsViewDto = { forms: [], defects: [] };
  // P36 (TaxOS): a virgin workspace has nothing to map — that is the empty
  // state, not a wall of mapping defects.
  if (facts.length === 0) return out;
  const rel = releases();
  for (const release of [rel.formsFed, rel.formsIl]) {
    const defs = resolveFormSet(release, facts);
    const { instances, defects } = populateInstances(defs, facts, ws, TAX_YEAR);
    for (const d of defects) out.defects.push(`${d.form_id} ${d.line_id}: ${d.message}`);
    for (const inst of instances) {
      const def = defs.find((x) => x.form_id === inst.form_id);
      const lines = Object.entries(inst.values).map(([line_id, v]) => ({
        line_id,
        label: def?.lines.find((l) => l.line_id === line_id)?.label ?? line_id,
        value: v.toString(),
      }));
      if (lines.length === 0) continue;
      const last =
        lines.find((l) => /refund|amount .*owe|overpaid|balance due/i.test(l.label)) ?? lines[lines.length - 1]!;
      out.forms.push({
        form_id: inst.form_id,
        jurisdiction: inst.jurisdiction,
        revision: inst.revision,
        pdf_available: rel.fieldMaps.forms[inst.form_id] !== undefined && rel.pdfTemplates[inst.form_id] !== undefined,
        headline: `${last.label}: ${last.value}`,
        lines,
      });
    }
  }
  return out;
}

export interface EfileSheetDto {
  fed_forms: { form_id: string; lines: FormLineDto[] }[];
  il_lines: FormLineDto[];
  /** Reconciliation targets — FFFF/MyTax computed results MUST match these
   *  before transmitting; a mismatch means stop and investigate. */
  reconcile: { label: string; value: string }[];
  has_lines: boolean;
  /** P33 (TaxOS): lines from a run with no income data are a stale/empty
   *  snapshot, never a transmittable return. */
  empty_run: boolean;
}

export async function getEfileSheet(userId: string, ws: string): Promise<EfileSheetDto> {
  const facts = await confirmedFacts(userId, ws);
  const filing = await withUserClient(userId, (client) => filingContext(client, ws));
  const rel = releases();
  const sheet: EfileSheetDto = { fed_forms: [], il_lines: [], reconcile: [], has_lines: false, empty_run: false };
  const collect = (release: FormDefRelease): { form_id: string; order: number; lines: FormLineDto[] }[] => {
    const defs = resolveFormSet(release, facts);
    const { instances } = populateInstances(defs, facts, ws, TAX_YEAR);
    return instances
      .map((inst) => {
        const def = defs.find((d) => d.form_id === inst.form_id);
        return {
          form_id: inst.form_id,
          order: def?.attachment_order ?? 99,
          lines: Object.entries(inst.values).map(([line_id, v]) => ({
            line_id,
            label: def?.lines.find((l) => l.line_id === line_id)?.label ?? line_id,
            value: v.toString(),
          })),
        };
      })
      .filter((f) => f.lines.length > 0)
      .sort((a, b) => a.order - b.order);
  };
  sheet.fed_forms = collect(rel.formsFed).map(({ form_id, lines }) => ({ form_id, lines }));
  sheet.il_lines = collect(rel.formsIl).flatMap((f) => f.lines);
  const derived = (concept: string): string | null =>
    facts.find((f) => f.concept === concept && f.derivation !== undefined)?.value.toString() ?? null;
  const target = (label: string, concept: string): void => {
    const v = derived(concept);
    if (v !== null) sheet.reconcile.push({ label, value: v });
  };
  if (filing) {
    // Status FIRST: it drives brackets, deduction and thresholds — a wrong
    // one is caught by eye before any number is compared.
    sheet.reconcile.push({
      label: 'Filing status (verify FIRST — drives brackets, deduction, thresholds)',
      value: filing.filing_status.toUpperCase(),
    });
  }
  target('Federal AGI (1040 line 11)', C.FED_AGI);
  target('Federal total tax (1040 line 24)', C.FED_TOTAL_TAX_LIABILITY);
  target('Federal refund (+) / owed (−)', C.FED_REFUND_OR_DUE);
  target('Illinois tax', C.IL_TAX);
  target('Illinois refund (+) / owed (−)', C.IL_REFUND_OR_DUE);
  sheet.has_lines = sheet.fed_forms.length > 0 || sheet.il_lines.length > 0;
  const totalIncome = derived(C.FED_TOTAL_INCOME);
  sheet.empty_run = sheet.has_lines && (totalIncome === null || totalIncome === '0');
  return sheet;
}
