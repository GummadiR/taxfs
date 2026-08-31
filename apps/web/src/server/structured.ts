/**
 * Structured fact entry (TaxOS P6.2/P14.3, ported): one form submit writes a
 * GROUP of registered concepts under a single manual source (deleting the
 * source removes the whole K-1 / lot / 1095-A at once). Concepts are
 * validated against the registry — free-form ids are structurally
 * impossible, same as intake. Includes the P40/P66 capital-loss carryover
 * worksheet (computed FOR the user from the four printed 2024 numbers, and
 * SAVED with its steps) and the P74/P75 exchange-rate lookup.
 *
 * Stateless adaptation: every function takes (userId, ws) and runs on the
 * spine as the authenticated user; outcomes return as strings for the page
 * to surface — no flash cookie, no session cache.
 */
import { C, Money, isRegisteredConcept } from '@taxfs/shared';
import { withSpine } from './db';
import { computeCarryoverWorksheet } from './carryover-worksheet';
import { resolveFxRateFromCertificate } from './fx-rate';
import { TAX_YEAR } from './env';

interface StructuredField {
  /** Form field name and the concept suffix it feeds. */
  name: string;
  /** Builds the concept id from the entered instance id (where applicable). */
  concept: (id: string) => string;
  jurisdiction: ('FED' | 'IL')[];
  required?: boolean;
  /** taxpayer_scope override (depreciation assets attach to a business). */
  scope?: (id2: string) => string;
}

const STRUCTURED_FAMILIES: Record<string, { idField: string | null; idField2?: string; fields: StructuredField[] }> = {
  k1: {
    idField: 'k1_id',
    // P38 — NO hard-required fields (same lesson as the P34 foreign card): a
    // SCANNED K-1 already supplies box1 and is_scorp, so the user completing
    // it has only basis_opening and material_participation left — requiring
    // box1 here blocked exactly that save. Use the SAME id as the scanned
    // K-1 (shown on Review's source values) and fill only what is missing.
    fields: [
      { name: 'box1', concept: (id) => `k1.${id}.box1`, jurisdiction: ['FED', 'IL'] },
      { name: 'is_scorp', concept: (id) => `k1.${id}.is_scorp`, jurisdiction: ['FED'] },
      { name: 'material_participation', concept: (id) => `k1.${id}.material_participation`, jurisdiction: ['FED'] },
      { name: 'basis_opening', concept: (id) => `k1.${id}.basis_opening`, jurisdiction: ['FED'] },
      { name: 'debt_basis_opening', concept: (id) => `k1.${id}.debt_basis_opening`, jurisdiction: ['FED'] },
      { name: 'capital_gain', concept: (id) => `k1.${id}.capital_gain`, jurisdiction: ['FED', 'IL'] },
      { name: 'passive_carryover', concept: (id) => `k1.${id}.passive_carryover`, jurisdiction: ['FED'] },
      { name: 'disposed_entire_interest', concept: (id) => `k1.${id}.disposed_entire_interest`, jurisdiction: ['FED'] },
      { name: 'rental_active', concept: (id) => `k1.${id}.rental_active`, jurisdiction: ['FED'] },
      { name: 'f4797', concept: (id) => `k1.${id}.f4797`, jurisdiction: ['FED', 'IL'] },
      { name: 'guaranteed_payment', concept: (id) => `k1.${id}.guaranteed_payment`, jurisdiction: ['FED', 'IL'] },
      { name: 'qbi_eligible', concept: (id) => `k1.${id}.qbi_eligible`, jurisdiction: ['FED'] },
      { name: 'liab_change', concept: (id) => `k1.${id}.liab_change`, jurisdiction: ['FED'] },
    ],
  },
  // P14.3 — completion families: an UPLOADED K-1 / 1095-A already carries
  // the document-side facts; these save ONLY the recipient-side answers no
  // document contains, so nothing double-counts.
  k1_completion: {
    idField: 'k1_id',
    fields: [
      { name: 'basis_opening', concept: (id) => `k1.${id}.basis_opening`, jurisdiction: ['FED'], required: true },
      { name: 'material_participation', concept: (id) => `k1.${id}.material_participation`, jurisdiction: ['FED'], required: true },
      { name: 'debt_basis_opening', concept: (id) => `k1.${id}.debt_basis_opening`, jurisdiction: ['FED'] },
      { name: 'passive_carryover', concept: (id) => `k1.${id}.passive_carryover`, jurisdiction: ['FED'] },
      { name: 'disposed_entire_interest', concept: (id) => `k1.${id}.disposed_entire_interest`, jurisdiction: ['FED'] },
      { name: 'rental_active', concept: (id) => `k1.${id}.rental_active`, jurisdiction: ['FED'] },
      { name: 'qbi_eligible', concept: (id) => `k1.${id}.qbi_eligible`, jurisdiction: ['FED'] },
    ],
  },
  ptc_household: {
    idField: null,
    fields: [
      { name: 'household_size', concept: () => 'ptc.household_size', jurisdiction: ['FED'], required: true },
    ],
  },
  // P18 — Form 1116 foreign income, entered in the FOREIGN currency plus one
  // exchange rate; the kernel converts with the arithmetic on the record.
  foreign: {
    idField: null,
    // P34 — NO hard-required fields: the 15CA/15CB upload supplies the
    // income (and TDS) itself, so a user completing the card often has only
    // the exchange rate (or the LT portion) left to add. Blank fields are
    // skipped; an all-blank save is refused generically; a semantic gap
    // (rate without income anywhere, income without rate) is the kernel's
    // honesty wall, surfaced by the persistent refusal banner.
    fields: [
      { name: 'income_foreign', concept: () => 'foreign.income.passive.foreign_currency', jurisdiction: ['FED'] },
      { name: 'ltcg_foreign', concept: () => 'foreign.income.passive.ltcg.foreign_currency', jurisdiction: ['FED'] },
      { name: 'tax_foreign', concept: () => 'foreign.tax_paid.foreign_currency', jurisdiction: ['FED'] },
      { name: 'fx_rate', concept: () => 'foreign.fx.units_per_usd', jurisdiction: ['FED'] },
    ],
  },
  // P31 — prior-year capital-loss carryovers (2024 Schedule D → this year's
  // lines 6 and 14). Both amounts enter as POSITIVE numbers; the kernel
  // applies them as losses, enforces the §1211(b) 3,000/1,500 annual cap,
  // and rolls any unused remainder forward via the year-close registers.
  capital_loss_carryover: {
    idField: null,
    fields: [
      { name: 'st_carryover', concept: () => 'carryover.capital_loss.st', jurisdiction: ['FED'] },
      { name: 'lt_carryover', concept: () => 'carryover.capital_loss.lt', jurisdiction: ['FED'] },
    ],
  },
  lot: {
    idField: 'lot_id',
    fields: [
      { name: 'proceeds', concept: (id) => `lot.${id}.proceeds`, jurisdiction: ['FED', 'IL'], required: true },
      { name: 'basis', concept: (id) => `lot.${id}.basis`, jurisdiction: ['FED', 'IL'], required: true },
      { name: 'term', concept: (id) => `lot.${id}.term`, jurisdiction: ['FED'], required: true },
      { name: 'wash_disallowed', concept: (id) => `lot.${id}.wash_disallowed`, jurisdiction: ['FED'] },
    ],
  },
  ptc: {
    idField: null,
    fields: [
      { name: 'annual_premium', concept: () => 'ptc.annual_premium', jurisdiction: ['FED'], required: true },
      { name: 'annual_slcsp', concept: () => 'ptc.annual_slcsp', jurisdiction: ['FED'], required: true },
      { name: 'annual_aptc', concept: () => 'ptc.annual_aptc', jurisdiction: ['FED'], required: true },
      { name: 'household_size', concept: () => 'ptc.household_size', jurisdiction: ['FED'], required: true },
    ],
  },
  business: {
    idField: 'entity_id',
    fields: [
      { name: 'gross_receipts', concept: (id) => `schc.${id}.gross_receipts`, jurisdiction: ['FED', 'IL'], required: true },
      { name: 'returns_allowances', concept: (id) => `schc.${id}.returns_allowances`, jurisdiction: ['FED', 'IL'] },
      { name: 'cogs', concept: (id) => `schc.${id}.cogs`, jurisdiction: ['FED', 'IL'] },
      { name: 'startup_costs_total', concept: (id) => `schc.${id}.startup_costs_total`, jurisdiction: ['FED'] },
      { name: 'startup_amort_months', concept: (id) => `schc.${id}.startup_amort_months`, jurisdiction: ['FED'] },
    ],
  },
  business_expense: {
    idField: 'entity_id',
    idField2: 'category',
    fields: [
      { name: 'amount', concept: (id) => id /* fully built below */, jurisdiction: ['FED', 'IL'], required: true },
    ],
  },
  entity: {
    idField: 'entity_id',
    fields: [
      { name: 'is_scorp', concept: (id) => `entity.${id}.is_scorp`, jurisdiction: ['FED'], required: true },
      { name: 'gross_receipts', concept: (id) => `entity.${id}.gross_receipts`, jurisdiction: ['FED', 'IL'] },
      { name: 'returns_allowances', concept: (id) => `entity.${id}.returns_allowances`, jurisdiction: ['FED', 'IL'] },
      { name: 'cogs', concept: (id) => `entity.${id}.cogs`, jurisdiction: ['FED', 'IL'] },
      { name: 'liabilities_beginning', concept: (id) => `entity.${id}.liabilities_beginning`, jurisdiction: ['FED'] },
      { name: 'liabilities_ending', concept: (id) => `entity.${id}.liabilities_ending`, jurisdiction: ['FED'] },
    ],
  },
  entity_deduction: {
    idField: 'entity_id',
    idField2: 'category',
    fields: [
      { name: 'amount', concept: (id) => id, jurisdiction: ['FED', 'IL'], required: true },
    ],
  },
  entity_k: {
    idField: 'entity_id',
    idField2: 'k_line',
    fields: [
      { name: 'amount', concept: (id) => id, jurisdiction: ['FED', 'IL'], required: true },
    ],
  },
  entity_member: {
    idField: 'entity_id',
    idField2: 'member_id',
    fields: [
      { name: 'share', concept: (id) => id, jurisdiction: ['FED'], required: true },
      { name: 'guaranteed_payment', concept: (id) => id, jurisdiction: ['FED', 'IL'] },
    ],
  },
  dep_asset: {
    idField: 'entity_id',
    idField2: 'asset_id',
    fields: [
      { name: 'basis', concept: (id) => `dep.${id}.basis`, jurisdiction: ['FED'], required: true, scope: (eid) => `entity:${eid}` },
      { name: 'sec179', concept: (id) => `dep.${id}.sec179`, jurisdiction: ['FED'], scope: (eid) => `entity:${eid}` },
      { name: 'life_years', concept: (id) => `dep.${id}.life_years`, jurisdiction: ['FED'], required: true, scope: (eid) => `entity:${eid}` },
    ],
  },
};

const ENTITY_K_CHOICES = ['int_income', 'div_ordinary', 'div_qualified', 'st_gain', 'lt_gain', 'other_income_st', 'other_income_lt'];

const ID_OK = /^[a-z0-9][a-z0-9_-]*$/;


export async function structuredEntry(userId: string, ws: string, formData: FormData): Promise<string> {
  const family = String(formData.get('family') ?? '');
  const spec = STRUCTURED_FAMILIES[family];
  if (!spec) return 'Unknown entry type.';
  const rawId = spec.idField ? String(formData.get(spec.idField) ?? '').trim().toLowerCase() : '';
  if (spec.idField && !ID_OK.test(rawId)) {
    return 'Give this item a short id (letters/numbers, e.g. "asap-llc" or "vti-lot1").';
  }
  const rawId2 = spec.idField2 ? String(formData.get(spec.idField2) ?? '').trim().toLowerCase() : '';
  if (spec.idField2 && !ID_OK.test(rawId2)) {
    return 'The second identifier is required (e.g. expense category or asset id).';
  }

  // Collect + validate every provided field BEFORE writing anything.
  const rows: { concept: string; value: Money; jurisdiction: ('FED' | 'IL')[]; scope: string; field: string }[] = [];
  for (const f of spec.fields) {
    const raw = String(formData.get(f.name) ?? '').trim();
    if (raw === '') {
      if (f.required) return `"${f.name}" is required for this entry.`;
      continue;
    }
    let value: Money;
    try {
      value = Money.fromString(raw);
    } catch {
      return `"${raw}" is not a valid amount for ${f.name}.`;
    }
    const concept =
      family === 'business_expense'
        ? `schc.${rawId}.expense.${rawId2}`
        : family === 'entity_deduction'
          ? `entity.${rawId}.deduction.${rawId2}`
          : family === 'entity_k'
            ? (ENTITY_K_CHOICES.includes(rawId2) ? `entity.${rawId}.k.${rawId2}` : 'INVALID')
            : family === 'entity_member'
              ? `entity.${rawId}.member.${rawId2}.${f.name}`
              : family === 'dep_asset'
                ? f.concept(rawId2)
                : f.concept(rawId);
    if (!isRegisteredConcept(concept)) {
      return `"${concept}" is not a registered concept — check the id${family === 'business_expense' ? ' or category' : ''}.`;
    }
    rows.push({
      concept,
      value,
      jurisdiction: f.jurisdiction,
      scope: f.scope ? f.scope(rawId) : 'primary',
      field: f.name,
    });
  }
  if (rows.length === 0) return 'Nothing to save — fill in at least one amount.';

  const sourceId = `manual-${crypto.randomUUID()}`;
  await withSpine({ userId, workspaceId: ws }, async (spine) => {
    await spine.registerSource({
      source_id: sourceId,
      taxpayer_id: ws,
      type: 'USER_ENTRY',
      tax_year: TAX_YEAR,
      fields: Object.fromEntries(rows.map((r) => [r.concept, r.value.toString()])),
      ocr_confidence: 1,
      raw_ref: `manual://${sourceId}`,
    });
    await spine.confirmSource(sourceId);
    for (const r of rows) {
      await spine.putSourceFact({
        fact_id: `f:${sourceId}:${r.concept}`,
        taxpayer_id: ws,
        concept: r.concept,
        tax_year: TAX_YEAR,
        jurisdiction: r.jurisdiction,
        taxpayer_scope: r.scope as 'primary',
        value: r.value,
        confidence: 1,
        provenance: [{ source_id: sourceId, source_field: r.field }],
        confirmed: true,
      });
    }
  });
  return `Saved ${rows.length} value${rows.length === 1 ? '' : 's'}.`;
}

/**
 * P40/P66 — run the IRS Capital Loss Carryover Worksheet from the four 2024
 * numbers and SAVE both results with the full step trail on the source.
 * The machine runs the worksheet; the human only transcribes printed
 * figures — retyping a computed result destroyed the derivation trail.
 */
export async function computeCarryoversFrom2024(userId: string, ws: string, formData: FormData): Promise<string> {
  const parse = (name: string): Money | null => {
    const raw = String(formData.get(name) ?? '').trim().replace(/[,$()]/g, (m) => (m === '(' ? '-' : m === ')' ? '' : m === ',' || m === '$' ? '' : m));
    if (raw === '') return null;
    try {
      return Money.fromString(raw);
    } catch {
      return null;
    }
  };
  const taxable_income = parse('wk_taxable_income');
  const schd_line7 = parse('wk_line7');
  const schd_line15 = parse('wk_line15');
  const schd_line21 = parse('wk_line21');
  if (!taxable_income || !schd_line7 || !schd_line15 || !schd_line21) {
    return 'Worksheet needs all four 2024 numbers (losses as negative, e.g. -48842): Form 1040 line 15, Schedule D lines 7, 15, and 21.';
  }
  const r = computeCarryoverWorksheet({ taxable_income, schd_line7, schd_line15, schd_line21 });

  const sourceId = `worksheet-caploss-${crypto.randomUUID()}`;
  let superseded = 0;
  await withSpine({ userId, workspaceId: ws }, async (spine) => {
    // A capital-loss carryover is SINGULAR: Schedule D line 6 and line 14
    // each take one figure. Every run of this worksheet used to mint a fresh
    // source with a fresh UUID, so running it twice left TWO confirmed facts
    // per concept and the kernel — which sums every confirmed fact — took the
    // loss off Schedule D twice. That is exactly what happened on a real
    // return: $42,410 of carryover subtracted as $84,820, with the Add Data
    // card showing one entry because it looked the value up with `.find()`.
    //
    // Re-running the worksheet now REPLACES the previous run rather than
    // adding to it, which is what "run the worksheet again" has always
    // meant to the operator. Safe to delete the whole source: a
    // worksheet-caploss source carries nothing but these two concepts.
    // Cascade drops the derived layer, so the next gate run rebuilds it —
    // the same contract document removal already uses.
    const prior = (await spine.getSources(ws, TAX_YEAR))
      .filter((x) => x.source_id.startsWith('worksheet-caploss-'));
    for (const old of prior) {
      await spine.deleteSource(old.source_id, { cascade: true });
      superseded += 1;
    }
    await spine.registerSource({
      source_id: sourceId,
      taxpayer_id: ws,
      type: 'USER_ENTRY',
      tax_year: TAX_YEAR,
      fields: {
        worksheet: 'IRS Capital Loss Carryover Worksheet (from the 2024 return)',
        prior_taxable_income: taxable_income.toString(),
        prior_schd_line7: schd_line7.toString(),
        prior_schd_line15: schd_line15.toString(),
        prior_schd_line21: schd_line21.toString(),
        st_carryover: r.st_carryover.toString(),
        lt_carryover: r.lt_carryover.toString(),
        steps: r.steps.join(' · '),
      },
      ocr_confidence: 1,
      raw_ref: `worksheet://${sourceId}`,
    });
    await spine.confirmSource(sourceId);
    const save = async (concept: string, value: Money, field: string): Promise<void> => {
      await spine.putSourceFact({
        fact_id: `f:${sourceId}:${concept}`,
        taxpayer_id: ws,
        concept,
        tax_year: TAX_YEAR,
        jurisdiction: ['FED'],
        taxpayer_scope: 'primary',
        value,
        confidence: 1,
        provenance: [{ source_id: sourceId, source_field: field }],
        confirmed: true,
      });
    };
    await save(C.CAPLOSS_CO_ST_PRIOR, r.st_carryover, 'st_carryover');
    await save(C.CAPLOSS_CO_LT_PRIOR, r.lt_carryover, 'lt_carryover');
  });
  const replaced = superseded > 0
    ? ` This REPLACED ${superseded} earlier worksheet ${superseded === 1 ? 'entry' : 'entries'}, so the carryover is counted once — re-run the gates to rebuild the return.`
    : '';
  return `Worksheet complete and SAVED: short-term carryover ${r.st_carryover.toString()}, long-term ${r.lt_carryover.toString()}. The full step trail is on the worksheet source.${replaced}`;
}

/** P74 — look up AND SAVE the ECB rate for the certificate's own date. */
export async function lookupFxRate(userId: string, ws: string): Promise<string> {
  return withSpine({ userId, workspaceId: ws }, async (spine) => {
    const result = await resolveFxRateFromCertificate(spine, ws, TAX_YEAR, await spine.getSources(ws, TAX_YEAR));
    return result.message;
  });
}
