/**
 * Amendment cases (TaxOS P9.3 / I.4, ported): the UI layer over the 1040-X
 * engine. Column A is pinned at markFiled, column C is the CURRENT kernel
 * run, B = C − A is engine-asserted per line — the UI never computes a
 * column value. Built columns and IL companion rows persist as settings
 * rows (TaxOS kept them in the session; a built 1040-X vanished on
 * restart).
 */
import {
  buildAmendedReturn,
  finalizeFederalAmendment,
  generateIlCompanion,
  loadPostFilingRules,
  type AmendColumnRow,
  type AmendedReturn,
  type AmendmentReason,
} from '@taxfs/postfiling';
import { withSpine, withUserClient } from './db';
import { readSetting, writeSetting } from './filing';
import { withPostFiling } from './postfiling';
import { readFixture } from './rules';
import { TAX_YEAR } from './env';

const BUILT_KEY = 'amend.built';
const IL_KEY = 'amend.il_rows';
const REASONS: AmendmentReason[] = ['user_correction', 'late_doc', 'rule_patch', 'notice_outcome'];

function pfRules() {
  return loadPostFilingRules(readFixture(`rules/fixtures/${TAX_YEAR}.POSTFILING.json`));
}

export interface AmendRowDto { concept: string; label: string; col_a: string; col_b: string; col_c: string }
export interface AmendCaseDto {
  amend_id: string;
  reason: string;
  status: string;
  concepts: string[];
  delta_facts: { fact_id: string; concept: string; old_value: string; new_value: string }[];
  built: { fed_rows: AmendRowDto[]; explanation: string } | null;
  il_companion: { due_date: string; alert: string; generated: boolean } | null;
  il_rows: AmendRowDto[] | null;
  needs_reference: boolean;
}
export interface AmendViewDto {
  filed: { filing_id: string; filed_date: string; package_version: number; channel: string } | null;
  source_concepts: { concept: string; label: string }[];
  cases: AmendCaseDto[];
}

const toRow = (r: AmendColumnRow): AmendRowDto => ({
  concept: r.concept,
  label: r.label,
  col_a: r.col_a_original,
  col_b: r.col_b_change,
  col_c: r.col_c_corrected,
});

export async function getAmendView(userId: string, ws: string): Promise<AmendViewDto> {
  const filing = await withPostFiling(userId, ws, (store) => store.latestFiling(ws, TAX_YEAR));
  if (!filing) return { filed: null, source_concepts: [], cases: [] };
  const facts = await withSpine({ userId, workspaceId: ws }, (spine) =>
    spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }));
  const { built, ilRows, cases } = await withUserClient(userId, async (client) => ({
    built: ((await readSetting(client, ws, BUILT_KEY)) as Record<string, AmendedReturn> | undefined) ?? {},
    ilRows: ((await readSetting(client, ws, IL_KEY)) as Record<string, AmendColumnRow[]> | undefined) ?? {},
    cases: null,
  }));
  void cases;
  const amendments = await withPostFiling(userId, ws, (store) => store.amendmentsFor(filing.filing_id));
  return {
    filed: {
      filing_id: filing.filing_id,
      filed_date: filing.filed_date,
      package_version: filing.package_version,
      channel: filing.channel,
    },
    source_concepts: [...new Set(facts.filter((f) => f.derivation === undefined).map((f) => f.concept))]
      .sort()
      .map((concept) => ({ concept, label: concept })),
    cases: amendments.map((a) => {
      const b = built[a.amend_id];
      return {
        amend_id: a.amend_id,
        reason: a.reason,
        status: a.status,
        concepts: a.correction_concepts,
        delta_facts: a.delta_facts.map((d) => ({ ...d })),
        built: b ? { fed_rows: b.fed_rows.map(toRow), explanation: b.explanation_statement } : null,
        il_companion: a.il_companion ? { ...a.il_companion, generated: ilRows[a.amend_id] !== undefined } : null,
        il_rows: ilRows[a.amend_id]?.map(toRow) ?? null,
        needs_reference: a.reason !== 'user_correction',
      };
    }),
  };
}

export async function openAmendment(userId: string, ws: string, reasonRaw: string, concept: string): Promise<string> {
  const reason = REASONS.find((r) => r === reasonRaw);
  if (!reason) return 'Pick a reason for the amendment.';
  const filing = await withPostFiling(userId, ws, (store) => store.latestFiling(ws, TAX_YEAR));
  if (!filing) return 'Amendments start from a FILED return — lock the package and mark it filed first.';
  const facts = await withSpine({ userId, workspaceId: ws }, (spine) =>
    spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }));
  if (!facts.some((f) => f.derivation === undefined && f.concept === concept)) {
    return 'Pick the source concept the correction touches — it must exist on the return as entered.';
  }
  try {
    // The AUR/CP2000 procedural block surfaces here as a refusal message.
    const amend = await withPostFiling(userId, ws, (store) =>
      store.openAmendmentCase({ filing, reason, correction_concepts: [concept] }));
    return `Amendment case ${amend.amend_id} opened for ${concept}. Make the correction on the Review page — it is recorded against this case.`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function buildAmendment(
  userId: string,
  ws: string,
  amendId: string,
  conceptSummary: string,
  reference: string,
): Promise<string> {
  if (conceptSummary.length === 0) {
    return 'Describe what was corrected (e.g. "interest income") — it fills the pre-approved explanation template.';
  }
  const filing = await withPostFiling(userId, ws, (store) => store.latestFiling(ws, TAX_YEAR));
  if (!filing) return 'No filed return on record.';
  try {
    const amend = await withPostFiling(userId, ws, (store) => store.getAmendment(amendId));
    if (amend.reason !== 'user_correction' && reference.length === 0) {
      return 'This reason needs a reference (the late document, notice, or rule release) for the explanation statement.';
    }
    const corrected = await withSpine({ userId, workspaceId: ws }, (spine) =>
      spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }));
    const result = buildAmendedReturn({
      amend,
      filing,
      corrected_facts: corrected,
      rules: pfRules(),
      slots: { concept_summary: conceptSummary, doc: reference, notice_ref: reference, rule_ref: reference },
    });
    await withUserClient(userId, async (client) => {
      const built = ((await readSetting(client, ws, BUILT_KEY)) as Record<string, AmendedReturn> | undefined) ?? {};
      built[amendId] = result;
      await writeSetting(client, ws, BUILT_KEY, built);
    });
    return `1040-X columns built for ${amendId} — review columns A/B/C below.`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function finalizeAmendment(userId: string, ws: string, amendId: string): Promise<string> {
  try {
    const hasBuilt = await withUserClient(userId, async (client) => {
      const built = ((await readSetting(client, ws, BUILT_KEY)) as Record<string, AmendedReturn> | undefined) ?? {};
      return built[amendId] !== undefined;
    });
    if (!hasBuilt) return 'Build the 1040-X columns first — finalizing pins the corrected figures you reviewed.';
    await withPostFiling(userId, ws, (store) => {
      const amend = store.getAmendment(amendId);
      // Corrected-package rebuild is a recorded gap (the original package
      // stays locked as the filed artifact); the ref names the column view.
      finalizeFederalAmendment({
        amend,
        new_package_ref: `1040x:${amendId}`,
        final_determination_date: new Date().toISOString().slice(0, 10),
        rules: pfRules(),
      });
    });
    return `Federal amendment ${amendId} finalized. The Illinois conformity clock is running — generate the IL companion below.`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export async function makeIlCompanion(userId: string, ws: string, amendId: string): Promise<string> {
  const filing = await withPostFiling(userId, ws, (store) => store.latestFiling(ws, TAX_YEAR));
  if (!filing) return 'No filed return on record.';
  try {
    const amend = await withPostFiling(userId, ws, (store) => store.getAmendment(amendId));
    const corrected = await withSpine({ userId, workspaceId: ws }, (spine) =>
      spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }));
    const { il_rows } = generateIlCompanion({ amend, filing, corrected_facts: corrected });
    await withUserClient(userId, async (client) => {
      const rows = ((await readSetting(client, ws, IL_KEY)) as Record<string, AmendColumnRow[]> | undefined) ?? {};
      rows[amendId] = il_rows;
      await writeSetting(client, ws, IL_KEY, rows);
    });
    return `IL-1040-X companion rows generated for ${amendId}.`;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}
