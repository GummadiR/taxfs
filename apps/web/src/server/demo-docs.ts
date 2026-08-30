/**
 * Deterministic demo documents (Phase 4 intake). The extraction agent's
 * LIVE document path (real uploads, scrub, vision) is Phase 7 work per
 * Blueprint §6/§7; until then intake is these fixtures plus manual entry —
 * every value still enters unconfirmed and crosses the SAME confirm door
 * (G8): registerSource → putSourceFact(unconfirmed) → operator confirms.
 * No demo value is a real person's data.
 */
import { C, Money, type Jurisdiction } from '@taxfs/shared';
import type { SpineBackend } from '@taxfs/spine';
import { TAX_YEAR } from './env';

export interface DemoDoc {
  id: string;
  label: string;
  type: string;
  fields: Record<string, string>;
  facts: { concept: string; field: string; jurisdiction: Jurisdiction[] }[];
}

export const DEMO_DOCS: DemoDoc[] = [
  {
    id: 'demo-w2',
    label: 'Demo W-2 (wages 50,000)',
    type: 'W-2',
    // box12w_hsa is captured as a FIELD with no mapped fact: the Discovery
    // card asks about the missing coverage type (§6) without inventing data.
    fields: { box1_wages: '50000', box2_fed_withholding: '4000', box17_il_withholding: '2000', box12w_hsa: '1000' },
    facts: [
      { concept: C.WAGES, field: 'box1_wages', jurisdiction: ['FED', 'IL'] },
      { concept: C.FED_WITHHOLDING, field: 'box2_fed_withholding', jurisdiction: ['FED'] },
      { concept: C.IL_WITHHOLDING, field: 'box17_il_withholding', jurisdiction: ['IL'] },
    ],
  },
  {
    id: 'demo-1099int',
    label: 'Demo 1099-INT (interest 1,200)',
    type: '1099-INT',
    fields: { box1_interest: '1200' },
    facts: [{ concept: C.INTEREST, field: 'box1_interest', jurisdiction: ['FED', 'IL'] }],
  },
];

/**
 * Manual-entry concepts — every amount that has no scannable document.
 *
 * P55: every computation has an intake path. TaxOS offered 61 of these on
 * its Documents page; this list had been cut to eight, which left most of a
 * real return unenterable — itemized deductions, the foreign tax credit,
 * tax-exempt interest, dependent care, HSA/IRA/401(k), the estimated-tax
 * penalty. The kernel supported every one of them the whole time; only the
 * dropdown was missing, so the numbers simply could not be made to match a
 * professionally-prepared return.
 *
 * Wording is TaxOS's, which is careful about the traps (what NOT to combine,
 * what is already counted elsewhere, which box a figure comes from). Every
 * entry maps to a concept the kernel actually consumes — offering one it
 * ignores would be worse than omitting it, because the value would land and
 * change nothing.
 *
 * `group` drives the optgroup in the picker; a 45-item flat list is its own
 * kind of unusable.
 */
export const MANUAL_CONCEPTS: {
  concept: string;
  label: string;
  jurisdiction: Jurisdiction[];
  group: string;
}[] = [
  // ---- Income ----
  { concept: C.WAGES, label: 'Wages (W-2 box 1)', jurisdiction: ['FED', 'IL'], group: 'Income' },
  { concept: C.INTEREST, label: 'Taxable interest income (1099-INT box 1)', jurisdiction: ['FED', 'IL'], group: 'Income' },
  { concept: C.TAX_EXEMPT_INTEREST, label: 'Tax-exempt interest (1099-INT box 8 — Illinois taxes it)', jurisdiction: ['FED', 'IL'], group: 'Income' },
  { concept: C.IL_EXEMPT_OBLIGATIONS, label: 'Tax-exempt interest: portion from exempt Illinois bonds held directly', jurisdiction: ['IL'], group: 'Income' },
  { concept: C.DIV_ORDINARY, label: 'Ordinary dividends (1099-DIV box 1a)', jurisdiction: ['FED', 'IL'], group: 'Income' },
  { concept: C.DIV_QUALIFIED, label: 'Qualified dividends (1099-DIV box 1b)', jurisdiction: ['FED'], group: 'Income' },
  { concept: C.CAPITAL_GAIN_NET, label: 'Net capital gain, summary (1099-B)', jurisdiction: ['FED', 'IL'], group: 'Income' },
  { concept: C.REIT_PTP_INCOME, label: 'Section 199A REIT dividends (1099-DIV box 5)', jurisdiction: ['FED'], group: 'Income' },
  { concept: C.RETIREMENT, label: 'Retirement income, taxable (1099-R)', jurisdiction: ['FED', 'IL'], group: 'Income' },
  { concept: C.SOCIAL_SECURITY, label: 'Social Security benefits (SSA-1099)', jurisdiction: ['FED', 'IL'], group: 'Income' },
  { concept: C.WAGES_SS, label: 'Social Security wages (W-2 box 3)', jurisdiction: ['FED'], group: 'Income' },
  { concept: C.WAGES_MEDICARE, label: 'Medicare wages (W-2 box 5)', jurisdiction: ['FED'], group: 'Income' },

  // ---- Schedule A — supply THESE or the single total below, never both ----
  { concept: C.SCHA_MORTGAGE_INTEREST, label: 'Schedule A: home mortgage interest (Form 1098 box 1)', jurisdiction: ['FED'], group: 'Itemized deductions' },
  { concept: C.SCHA_MORTGAGE_POINTS, label: 'Schedule A: points paid on purchase (Form 1098 box 6)', jurisdiction: ['FED'], group: 'Itemized deductions' },
  { concept: C.SCHA_CHARITABLE, label: 'Schedule A: charitable contributions (skip amounts from donation receipts you uploaded — already counted)', jurisdiction: ['FED'], group: 'Itemized deductions' },
  { concept: C.SCHA_MEDICAL, label: 'Schedule A: medical/dental paid (the full amount — the AGI floor is applied for you)', jurisdiction: ['FED'], group: 'Itemized deductions' },
  { concept: C.SCHA_INVESTMENT_INTEREST, label: 'Schedule A: investment interest (Form 4952)', jurisdiction: ['FED'], group: 'Itemized deductions' },
  { concept: C.SCHA_PERSONAL_PROPERTY_TAX, label: 'Schedule A: personal property tax on vehicles (car registration tax — NOT real-estate tax on your home)', jurisdiction: ['FED'], group: 'Itemized deductions' },
  { concept: C.SCHA_STATE_TAX_OTHER, label: 'Schedule A: state income tax paid beyond withholding/estimates', jurisdiction: ['FED'], group: 'Itemized deductions' },
  { concept: C.ITEMIZED, label: 'Itemized deductions — one already-computed total (do NOT combine with the individual Schedule A rows above)', jurisdiction: ['FED'], group: 'Itemized deductions' },
  { concept: C.IL_PROPERTY_TAX, label: 'Property tax paid on your home (feeds the federal deduction AND the IL credit — skip if you uploaded the tax bill)', jurisdiction: ['FED', 'IL'], group: 'Itemized deductions' },

  // ---- Foreign (Form 1116) ----
  { concept: C.FOREIGN_TAX_PAID, label: 'Foreign tax paid (1099-DIV box 7 / 1099-INT box 6)', jurisdiction: ['FED'], group: 'Foreign' },
  { concept: C.FOREIGN_INCOME, label: 'Foreign income for the tax credit, in US dollars — ALSO enter it above as interest/dividends; this row only sets the credit limit, never double-counts', jurisdiction: ['FED'], group: 'Foreign' },
  { concept: C.FOREIGN_INCOME_LTCG, label: 'Foreign income that is long-term capital gain (§904(b)(2)(B) adjustment)', jurisdiction: ['FED'], group: 'Foreign' },
  { concept: C.FTC_DEMINIMIS_ELECTION, label: 'Claim the foreign tax credit without Form 1116 — small amounts only, §904(j) (type 1 for yes)', jurisdiction: ['FED'], group: 'Foreign' },

  // ---- Credits ----
  { concept: C.SOLAR_COST, label: 'Solar installation cost (Form 5695 — total contract price paid)', jurisdiction: ['FED'], group: 'Credits' },
  { concept: C.DEPCARE_EXPENSES, label: 'Child/dependent care expenses paid (Form 2441)', jurisdiction: ['FED'], group: 'Credits' },
  { concept: C.DEPCARE_PERSONS, label: 'Dependent care: number of qualifying persons (1, or 2+)', jurisdiction: ['FED'], group: 'Credits' },
  { concept: C.DEPCARE_EMPLOYER_BENEFITS, label: 'Dependent care: employer benefits (W-2 box 10)', jurisdiction: ['FED'], group: 'Credits' },
  { concept: C.DEPCARE_EARNED_INCOME_LIMIT, label: "Dependent care: lower-earning spouse's earned income, if it limits the credit", jurisdiction: ['FED'], group: 'Credits' },
  { concept: C.DEPCARE_EARNED_INCOME_NOT_LIMITING, label: 'Dependent care: both spouses earned more than the expenses (type 1 for yes)', jurisdiction: ['FED'], group: 'Credits' },
  { concept: C.CREDITS_SCH3, label: 'Other Schedule 3 credits — an already-computed total (not solar; that has its own row)', jurisdiction: ['FED'], group: 'Credits' },

  // ---- Retirement & HSA contributions ----
  { concept: C.CONTRIB_HSA_EMPLOYER, label: 'HSA: employer/payroll contributions (W-2 box 12 code W)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_HSA_DIRECT, label: 'HSA: contributions you made directly, outside payroll', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.HSA_FAMILY_COVERAGE, label: 'HSA: family HDHP coverage (type 1 for family, 0 for self-only)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.HSA_CATCHUP_COUNT, label: 'HSA: how many account holders were 55 or older (0, 1, or 2)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_IRA_TRAD_TP, label: 'Traditional IRA contribution — you', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_IRA_TRAD_SP, label: 'Traditional IRA contribution — spouse', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_IRA_ROTH_TP, label: 'Roth IRA contribution — you', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_IRA_ROTH_SP, label: 'Roth IRA contribution — spouse', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.IRA_CATCHUP_TP, label: 'IRA: you were 50 or older at year end (type 1 for yes)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.IRA_CATCHUP_SP, label: 'IRA: spouse was 50 or older at year end (type 1 for yes)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_DEFERRAL_TP, label: '401(k)/403(b) elective deferrals, all employers — you (W-2 box 12 D/E/AA/BB)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_DEFERRAL_SP, label: '401(k)/403(b) elective deferrals, all employers — spouse', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.DEFERRAL_SUPER_CATCHUP_TP, label: '401(k): you were 60–63 at year end (type 1 for yes — higher catch-up)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.DEFERRAL_SUPER_CATCHUP_SP, label: '401(k): spouse was 60–63 at year end (type 1 for yes)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_SIMPLE_TP, label: 'SIMPLE IRA/401(k) deferrals — you', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_SIMPLE_SP, label: 'SIMPLE IRA/401(k) deferrals — spouse', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.CONTRIB_SEP, label: 'SEP / Solo-401(k) employer contribution for your business', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.W2_RETIREMENT_PLAN_TP, label: 'W-2 box 13 "Retirement plan" checked — you (type 1 for yes)', jurisdiction: ['FED'], group: 'Retirement & HSA' },
  { concept: C.W2_RETIREMENT_PLAN_SP, label: 'W-2 box 13 "Retirement plan" checked — spouse (type 1 for yes)', jurisdiction: ['FED'], group: 'Retirement & HSA' },

  // ---- Carryovers from a prior year ----
  { concept: C.CAPLOSS_CO_ST_PRIOR, label: 'Capital loss carryover — short-term (prior year)', jurisdiction: ['FED'], group: 'Carryovers' },
  { concept: C.CAPLOSS_CO_LT_PRIOR, label: 'Capital loss carryover — long-term (prior year)', jurisdiction: ['FED'], group: 'Carryovers' },
  { concept: C.QBI_CO_PRIOR, label: 'QBI loss carryforward (prior-year 8995 line 16, as positive)', jurisdiction: ['FED'], group: 'Carryovers' },

  // ---- Payments, other taxes and penalties ----
  { concept: C.FED_WITHHOLDING, label: 'Federal withholding (W-2 box 2 / 1099)', jurisdiction: ['FED'], group: 'Payments & other taxes' },
  { concept: C.MEDICARE_WH, label: 'Medicare tax withheld (W-2 box 6)', jurisdiction: ['FED'], group: 'Payments & other taxes' },
  { concept: C.FED_ESTIMATED, label: 'Federal estimated tax payments (1040-ES total)', jurisdiction: ['FED'], group: 'Payments & other taxes' },
  { concept: C.IL_WITHHOLDING, label: 'Illinois withholding', jurisdiction: ['IL'], group: 'Payments & other taxes' },
  { concept: C.IL_ESTIMATED, label: 'Illinois estimated tax payments (IL-1040-ES total)', jurisdiction: ['IL'], group: 'Payments & other taxes' },
  { concept: C.ADJUSTMENTS, label: 'Schedule 1 adjustments to income — an already-computed total', jurisdiction: ['FED'], group: 'Payments & other taxes' },
  { concept: C.EARLY_DIST_SUBJECT, label: 'Early retirement distribution subject to the 10% tax (Form 5329 line 3)', jurisdiction: ['FED'], group: 'Payments & other taxes' },
  { concept: C.FED_EST_TAX_PENALTY, label: 'Federal estimated-tax penalty (Form 2210)', jurisdiction: ['FED'], group: 'Payments & other taxes' },
  { concept: C.IL_EST_TAX_PENALTY, label: 'Illinois late-payment penalty (IL-2210)', jurisdiction: ['IL'], group: 'Payments & other taxes' },
  { concept: C.IL_OTHER_STATE_CREDIT, label: 'IL credit for tax paid to another state (Schedule CR)', jurisdiction: ['IL'], group: 'Payments & other taxes' },
  { concept: C.IL_USE_TAX, label: 'IL use tax on out-of-state purchases (IL-1040 line 21)', jurisdiction: ['IL'], group: 'Payments & other taxes' },
  { concept: C.IL_PTE_CREDIT, label: 'IL pass-through entity tax credit (Sch K-1-P/K-1-T)', jurisdiction: ['IL'], group: 'Payments & other taxes' },
];

export async function addDemoDoc(spine: SpineBackend, ws: string, doc: DemoDoc): Promise<void> {
  const source_id = `${doc.id}-${Date.now().toString(36)}`;
  await spine.registerSource({
    source_id,
    taxpayer_id: ws,
    type: doc.type as never,
    tax_year: TAX_YEAR,
    fields: doc.fields,
    ocr_confidence: 0.98,
    raw_ref: `demo://${doc.id}`,
  });
  for (const f of doc.facts) {
    await spine.putSourceFact({
      fact_id: `f:${source_id}:${f.field}`,
      taxpayer_id: ws,
      concept: f.concept,
      tax_year: TAX_YEAR,
      jurisdiction: f.jurisdiction,
      taxpayer_scope: 'primary',
      value: Money.fromString(doc.fields[f.field]!),
      confidence: 0.98,
      provenance: [{ source_id, source_field: f.field }],
    });
  }
}

export async function addManualEntry(
  spine: SpineBackend,
  ws: string,
  concept: string,
  amount: string,
): Promise<void> {
  const def = MANUAL_CONCEPTS.find((c) => c.concept === concept);
  if (!def) throw new Error(`manual entry for ${concept} is not an offered intake path`);
  const source_id = `manual-${concept.replaceAll('.', '-')}-${Date.now().toString(36)}`;
  await spine.registerSource({
    source_id,
    taxpayer_id: ws,
    type: 'USER_ENTRY' as never,
    tax_year: TAX_YEAR,
    fields: { amount },
    ocr_confidence: 1,
    raw_ref: `manual://${source_id}`,
  });
  // Typed by the operator — the entry IS the confirmation (E.6).
  await spine.putSourceFact({
    fact_id: `f:${source_id}:amount`,
    taxpayer_id: ws,
    concept,
    tax_year: TAX_YEAR,
    jurisdiction: def.jurisdiction,
    taxpayer_scope: 'primary',
    value: Money.fromString(amount),
    confidence: 1,
    provenance: [{ source_id, source_field: 'amount' }],
    confirmed: true,
  });
  await spine.confirmSource(source_id);
}
