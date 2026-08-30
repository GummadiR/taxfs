/**
 * P14.4 (ported from TaxOS) — plain-English presentation copy for Review.
 * Every line the operator reads gets a human name and, where it helps, a
 * one-liner on what the line means and the rule behind it. This is
 * PRESENTATION copy only: the authoritative math stays in the clickable
 * lineage. Deliberately figure-free — dollar amounts live in rule-data and
 * the lineage, never baked into prose where they could drift.
 */
import type { SourceDoc, TaxFact } from '@taxfs/shared';
import { documentDisplayName } from './doc-ref';
import { TAX_YEAR } from './env';

/** Federal Review lines, in reading order. Lines render only when computed. */
export const LINE_LABELS: [string, string][] = [
  ['fed.schc.net_profit.total', 'Schedule C net profit'],
  ['fed.schd.total', 'Schedule D capital gain/(loss)'],
  ['fed.sche.k1_total', 'Schedule E page 2 (K-1s)'],
  ['fed.total_income', 'Total income'],
  ['fed.se_tax.deduction', '½ self-employment tax deduction'],
  ['fed.agi', 'Adjusted gross income'],
  ['fed.sch_a.medical.allowed', 'Schedule A — medical above the AGI floor'],
  ['fed.sch_a.salt.allowed', 'Schedule A — state & local taxes (after the cap)'],
  ['fed.sch_a.interest', 'Schedule A — mortgage & investment interest'],
  ['fed.sch_a.charitable', 'Schedule A — charitable contributions'],
  ['fed.sch_a.total', 'Schedule A — total itemized deductions'],
  ['fed.deduction.applied', 'Deduction applied'],
  ['fed.qbi.deduction', 'QBI deduction (Form 8995)'],
  ['fed.credit.foreign_tax', 'Foreign tax credit (Form 1116)'],
  ['fed.credit.foreign_tax.unused', 'Unused foreign tax (informational — §904(c) carryover)'],
  ['fed.credit.residential_clean_energy', 'Residential clean energy credit (Form 5695)'],
  ['fed.credit.solar.unused', 'Unused solar credit (informational — see Form 5695 trail)'],
  ['fed.credit.dependent_care', 'Child and dependent care credit (Form 2441)'],
  ['fed.taxable_income', 'Taxable income'],
  ['fed.tax.total', 'Federal tax'],
  ['fed.se_tax.total', 'Self-employment tax'],
  ['fed.ptc.net_credit', 'Net premium tax credit (Form 8962)'],
  ['fed.ptc.repayment', 'Advance premium credit repayment (Form 8962)'],
  ['fed.tax.additional_medicare', 'Additional Medicare Tax (Form 8959)'],
  ['fed.withholding.additional_medicare', 'Additional Medicare withholding (1040 line 25c)'],
  ['fed.tax.niit', 'Net investment income tax (Form 8960)'],
  ['fed.tax.early_distribution', 'Additional tax on early retirement distributions (Form 5329)'],
  ['fed.tax.liability.total', 'Total tax (line 24)'],
  ['fed.payments.total', 'Payments'],
  ['fed.refund_or_due', 'Refund (+) / balance due (−)'],
  ['fed.net_amount_due', 'What you actually pay / receive, after any Form 2210 penalty'],
];

export const IL_LINE_LABELS: [string, string][] = [
  ['il.base_income', 'IL base income'],
  ['il.net_income', 'IL net income'],
  ['il.tax', 'IL tax'],
  ['il.icr.property_tax_credit', 'IL property tax credit (Schedule ICR)'],
  ['il.tax_after_credits', 'IL tax after nonrefundable credits (line 19)'],
  ['il.total_tax', 'IL total tax, including use tax (line 23)'],
  ['il.payments.total', 'IL payments'],
  ['il.refund_or_due', 'IL refund (+) / balance due (−)'],
  ['il.net_amount_due', 'What you actually pay Illinois / receive, after any IL-2210 penalty'],
];

/** What each computed line means, in plain English, with the rule behind it.
 *  Figure-free on purpose: the exact dollar caps/rates live in the loaded
 *  rule-data and appear in the line's own lineage. */
export const LINE_EXPLAIN: Record<string, string> = {
  'fed.total_income': 'Everything taxable added together — wages, interest, dividends, capital gains, business and K-1 income (Form 1040 line 9).',
  'fed.se_tax.deduction': 'Self-employed taxpayers deduct half of their self-employment tax — the employer half, mirroring what employees never pay themselves (§164(f)).',
  'fed.agi': 'Adjusted gross income: total income minus above-the-line adjustments. Many limits key off this number (Form 1040 line 11).',
  'fed.deduction.applied': 'The larger of your standard deduction (from the loaded rule-data) and your itemized deductions. The tool compares and takes the bigger one.',
  'fed.deduction.standard': 'Your standard deduction for your filing status, from the loaded rule-data.',
  'fed.deductions.total': 'The deduction actually subtracted from AGI on the way to taxable income.',
  'fed.qbi.deduction': 'Qualified business income deduction: generally 20% of pass-through business income, with income-based limits (§199A, Form 8995).',
  'fed.taxable_income': 'AGI minus deductions — the amount the tax brackets actually apply to (Form 1040 line 15).',
  'fed.tax.total': 'Bracket tax on taxable income, using the preferential rates for qualified dividends and long-term capital gains where they apply.',
  'fed.tax.ordinary': 'Tax at the ordinary brackets.',
  'fed.tax.capgain': 'Tax at the lower capital-gains rates (0/15/20%).',
  'fed.se_tax.total': 'Social Security + Medicare tax on self-employment profit — both halves, because no employer pays the other half (Schedule SE).',
  'fed.credit.foreign_tax': 'Tax you paid to a foreign country credited against your US tax — but only up to the US tax on that same income (§904, Form 1116).',
  'fed.credit.foreign_tax.unused': 'The part of the foreign tax above this year’s limit. It can carry back 1 year and forward 10 (§904(c)) — shown for your records.',
  'fed.credit.residential_clean_energy': 'Residential Clean Energy Credit: 30% of what you paid for the solar installation, limited to the tax you owe this year (§25D, Form 5695).',
  'fed.credit.solar.unused': 'The part of the solar credit above this year’s tax — shown for the record.',
  'fed.ptc.net_credit': 'Premium tax credit reconciliation: the marketplace subsidy you were entitled to vs what was advanced to your insurer (Form 8962). Positive = extra credit to you.',
  'fed.ptc.repayment': 'You received more advance marketplace subsidy than your final income allows — the excess is repaid here, subject to income-based caps (Form 8962 Part III).',
  'fed.tax.additional_medicare': 'Extra Medicare tax on wages/self-employment income above the §3101(b)(2) thresholds (Form 8959).',
  'fed.withholding.additional_medicare': 'The 0.9% extra Medicare tax your employer already withheld (W-2 box 6 beyond 1.45%) — credited against the surtax (1040 line 25c).',
  'fed.tax.niit': 'Net investment income tax on investment income when AGI exceeds the §1411 thresholds (Form 8960).',
  'fed.tax.liability.total': 'Your actual year’s tax: bracket tax plus surtaxes, minus credits (Form 1040 line 24). Compare THIS to your payments — not your April bill.',
  'fed.payments.total': 'Everything already paid in: withholding from W-2s/1099s, estimated payments, and refundable credits (Form 1040 line 33).',
  'fed.net_amount_due': 'The number that matters: your refund or balance due AFTER the Form 2210 estimated-tax penalty. If you underpaid during the year, this is what you actually write the check for.',
  'il.net_amount_due': 'Your Illinois refund or balance due AFTER the IL-2210 late-payment penalty (IL-1040 line 41).',
  'fed.credit.dependent_care': 'Credit for money you paid someone to care for a child or dependent so you could work (Form 2441, §21). Nonrefundable — it can wipe out tax but never create a refund.',
  'fed.tax.early_distribution': 'The extra 10% tax on retirement money taken out early (Form 5329, §72(t)) — on top of the ordinary income tax.',
  'il.total_tax': 'Illinois tax after credits PLUS use tax on out-of-state purchases (IL-1040 line 23).',
  'fed.refund_or_due': 'Payments minus total tax. Positive = the IRS owes you; negative = you owe. A big number either way usually means withholding is mis-tuned, not that the tax changed.',
  'fed.schc.net_profit.total': 'Sole-proprietorship profit: business receipts minus expenses (Schedule C). Feeds both income tax and self-employment tax.',
  'fed.schd.total': 'Net capital gain or loss across all sales; net losses deduct up to the annual §1211(b) cap, the rest carries forward (Schedule D).',
  'fed.schd.st_net': 'Short-term gain/(loss), all sales combined, including any short-term carryover from last year (Schedule D line 7).',
  'fed.schd.lt_net': 'Long-term gain/(loss), all sales combined, including any long-term carryover from last year (Schedule D line 15).',
  'fed.schd.net_capital_gain': 'Net capital gain taxed at the lower rates.',
  'fed.sch_a.medical.allowed': 'Medical expenses count only above a percentage-of-AGI floor (§213(a)) — this line is the part that cleared the floor, not what you paid.',
  'fed.sch_a.salt.allowed': 'State and local taxes — income tax withheld/estimated plus property tax — after the §164(b)(6) cap. Click the drilldown to see what you actually paid before the cap.',
  'fed.sch_a.interest': 'Mortgage interest and points from your Form 1098, plus any investment interest (Schedule A lines 8–10).',
  'fed.sch_a.charitable': 'Donations to qualified charities (Schedule A lines 11–14).',
  'fed.sch_a.total': 'Every itemized category added up (Schedule A line 17). It is USED only when it beats your standard deduction — the "Deduction applied" line shows which one won.',
  'fed.sche.k1_total': 'Pass-through income from your S-corps and partnerships — the K-1 box 1 amounts after basis and passive-loss limits (Schedule E page 2).',
  'il.base_income': 'Illinois starts from federal AGI, then adds/subtracts Illinois differences (retirement income and Social Security are subtracted — Illinois does not tax them).',
  'il.net_income': 'Base income minus Illinois exemptions (per person, from the loaded rule-data).',
  'il.tax': 'Illinois flat tax on net income (35 ILCS 5/201).',
  'il.icr.property_tax_credit': 'Illinois property tax credit: 5% of the property tax you paid on your principal residence (Schedule ICR), subject to income limits.',
  'il.tax_after_credits': 'IL tax minus nonrefundable credits — what the year actually cost you in Illinois tax.',
  'il.payments.total': 'Illinois withholding (W-2 box 17, Schedule IL-WIT) plus IL estimated payments.',
  'il.refund_or_due': 'IL payments minus IL tax after credits. Positive = Illinois owes you; negative = you owe Illinois.',
  'il.exemption.total': 'Illinois exemptions, all persons combined, from the loaded rule-data.',
  'carryover.capital_loss.st.out': 'Short-term capital loss carrying to next year — written to the register at year close.',
  'carryover.capital_loss.lt.out': 'Long-term capital loss carrying to next year — written to the register at year close.',
};

/** Plain-English names for SOURCED (entered) concepts. */
export const SOURCE_LABELS: Record<string, string> = {
  'income.wages': 'Wages (W-2 box 1)',
  'income.wages.ss': 'Social Security wages (W-2 box 3)',
  'income.wages.medicare': 'Medicare wages (W-2 box 5)',
  'income.interest': 'Taxable interest',
  'income.dividends.ordinary': 'Ordinary dividends',
  'income.dividends.qualified': 'Qualified dividends',
  'income.capital_gain.net': 'Investment sale gain/(loss)',
  'income.retirement': 'Retirement income',
  'income.social_security': 'Social Security benefits',
  'income.reit_ptp.qualified': 'REIT/PTP dividends',
  'income.tax_exempt_interest': 'Tax-exempt interest (e.g. municipal bonds)',
  'carryover.capital_loss.st': 'Short-term capital-loss carryover from last year',
  'carryover.capital_loss.lt': 'Long-term capital-loss carryover from last year',
  'carryover.qbi': 'QBI loss carryover from last year',
  'payments.fed.withholding': 'Federal tax withheld (W-2/1099 box)',
  'payments.fed.estimated': 'Federal estimated payments you made',
  'payments.fed.medicare_withholding': 'Extra Medicare tax withheld (W-2 box 6)',
  'payments.il.withholding': 'Illinois tax withheld (W-2 box 17)',
  'payments.il.estimated': 'Illinois estimated payments you made',
  'payments.il.pte_credit': 'Pass-through entity tax credit (from a K-1)',
  'il.property_tax.residence': 'Property tax paid on your home',
  'il.use_tax': 'Illinois use tax on out-of-state purchases',
  'il.credit.tax_paid_other_states': 'Credit for tax paid to another state',
  'il.tax_exempt_interest.exempt_obligations': 'Portion from exempt Illinois bonds',
  'foreign.income.passive.foreign_currency': 'Foreign income (in the foreign currency)',
  'foreign.income.passive.ltcg.foreign_currency': 'Foreign long-term gain (in the foreign currency)',
  'foreign.tax_paid.foreign_currency': 'Foreign tax paid (in the foreign currency)',
  'foreign.fx.units_per_usd': 'Exchange rate (foreign units per US dollar)',
  'foreign.income.passive': 'Foreign income, in US dollars',
  'foreign.income.passive.ltcg': 'Foreign long-term capital gain, in US dollars',
  'foreign.tax_paid': 'Foreign tax paid, in US dollars',
  'foreign.de_minimis_election': 'Election to claim the foreign tax credit without Form 1116',
  'deduction.sch_a.medical': 'Medical expenses you paid',
  'deduction.sch_a.state_tax_other': 'State income tax paid outside withholding',
  'deduction.sch_a.personal_property_tax': 'Personal property tax (e.g. vehicle)',
  'deduction.sch_a.mortgage_interest': 'Mortgage interest (Form 1098 box 1)',
  'deduction.sch_a.mortgage_points': 'Mortgage points (Form 1098 box 6)',
  'deduction.sch_a.investment_interest': 'Investment interest paid',
  'deduction.sch_a.charitable': 'Charitable donations',
  'deduction.itemized.total': 'Itemized deductions (entered as one total)',
  'adjustments.sch1.total': 'Adjustments to income (Schedule 1 total)',
  'credits.sch3.total': 'Other credits (Schedule 3 total)',
  'ptc.annual_premium': 'Health premiums paid (1095-A column A)',
  'ptc.annual_slcsp': 'Benchmark "second-lowest-cost silver" premium (1095-A column B)',
  'ptc.annual_aptc': 'Advance credit paid to your insurer (1095-A column C)',
  'ptc.household_size': 'Household size (Form 8962 line 1)',
  'penalty.fed.estimated_tax': 'Penalty for underpaying during the year (Form 2210)',
  'penalty.il.estimated_tax': 'Illinois penalty for underpaying during the year (IL-2210)',
  'tax.early_distribution.subject_amount': 'Early retirement withdrawal subject to the extra tax',
  'credit.solar.installation_cost': 'Solar installation cost you paid',
  'credit.dependent_care.expenses': 'Care expenses you paid (Form 2441)',
  'credit.dependent_care.qualifying_persons': 'Number of children/dependents cared for',
  'credit.dependent_care.employer_benefits': 'Employer dependent-care benefits (W-2 box 10)',
  'credit.dependent_care.earned_income_limit': 'Lower-earning spouse’s earned income (care-credit limit)',
  'credit.dependent_care.earned_income_not_limiting': 'Confirmation both spouses earned more than the care expenses',
  'attestation.il_residency': 'Attestation: full-year Illinois resident',
};

/** Derived sub-lines that appear in the tables or drilldown. */
export const DRILLDOWN_LABELS: Record<string, string> = {
  'fed.schd.st_net': 'Short-term gain/(loss), all sales (Schedule D line 7)',
  'fed.schd.lt_net': 'Long-term gain/(loss), all sales (Schedule D line 15)',
  'fed.schd.net_capital_gain': 'Net capital gain taxed at the lower rates',
  'fed.sch1.additional_income.total': 'Additional income (Schedule 1 line 10)',
  'fed.sch_a.salt.before_cap': 'State & local taxes actually paid (before the cap)',
  'fed.withholding.combined': 'Tax withheld, all forms combined (1040 line 25d)',
  'fed.withholding.total': 'Tax withheld across your forms',
  'fed.estimated.total': 'Estimated payments, year total',
  'il.withholding.total': 'Illinois tax withheld across your forms',
  'il.estimated.total': 'Illinois estimated payments, year total',
  'fed.tax.ordinary': 'Tax at the ordinary brackets',
  'fed.tax.capgain': 'Tax at the lower capital-gains rates',
  'fed.deduction.standard': 'Your standard deduction',
  'fed.sch1.adjustments_total': 'Adjustments to income (Schedule 1 line 25)',
  'fed.sch2.total': 'Other taxes, combined (Schedule 2)',
  'fed.sch2.part1.total': 'Advance premium credit repayment (Schedule 2 Part I)',
  'fed.sch2.part2.total': 'Self-employment, Medicare surtax and investment taxes (Schedule 2 Part II)',
  'fed.credits.total': 'Credits, combined',
  'fed.tax_after_credits': 'Tax after credits',
  'fed.tax.plus_sch2_part1': 'Tax plus Schedule 2 Part I',
  'fed.wages.total': 'Wages, all jobs combined',
  'fed.tax_exempt_interest.total': 'Tax-exempt interest, whole-dollar total (1040 line 2a)',
  'fed.interest.total': 'Interest, all payers combined',
  'fed.dividends.ordinary.total': 'Ordinary dividends, all payers combined',
  'fed.dividends.qualified.total': 'Qualified dividends, all payers combined',
  'fed.capital_gain.net.total': 'Investment sale gains/(losses), combined',
  'fed.retirement.total': 'Retirement income, combined',
  'fed.adjustments.total': 'Adjustments to income, combined',
  'fed.deductions.total': 'Deductions applied, combined',
  'il.sch_m.additions': 'Illinois additions (Schedule M)',
  'il.sch_m.subtractions': 'Income Illinois does not tax (retirement, Social Security)',
  'il.sch_m.depreciation_subtraction': 'Illinois depreciation subtraction (IL-4562)',
  'il.tax_exempt_interest.addback': 'Tax-exempt interest Illinois adds back (IL-1040 line 2)',
  'il.exemption.total': 'Illinois exemptions, all persons',
  'il.exemption.base_persons': 'Illinois exemptions — base persons count',
  'il.icr.property_tax_paid': 'Property tax paid on your Illinois home (Schedule ICR)',
  'il.total_income': 'Illinois total income',
  'fed.f8582.special_allowance': 'Rental loss allowed under the special allowance (Form 8582)',
  'fed.f4797.total': 'Business property sale gain/(loss) (Form 4797)',
  'fed.qbi.loss_carryforward.out': 'Business-income loss carrying to next year (Form 8995)',
  'carryover.capital_loss.st.out': 'Short-term capital loss carrying to next year',
  'carryover.capital_loss.lt.out': 'Long-term capital loss carrying to next year',
  'fed.credit.foreign_tax.not_claimed': 'Foreign tax paid but not claimed as a credit (informational)',
  'fed.credit.dependent_care.earned_income_unverified': 'Care credit computed without verifying earned income (informational)',
};

const DERIVED_LABEL = new Map<string, string>([...LINE_LABELS, ...IL_LINE_LABELS]);

/** Turn any concept id into a readable name: curated first, else humanized. */
export function conceptLabel(concept: string): string {
  const curated = DERIVED_LABEL.get(concept) ?? SOURCE_LABELS[concept] ?? DRILLDOWN_LABELS[concept];
  if (curated) return curated;
  // Per-K-1 lines: k1.<id>.<field> → "<Id> — <field>".
  const k1 = /^k1\.([a-z0-9][a-z0-9_-]*)\.(.+)$/.exec(concept);
  if (k1) {
    const name = k1[1]!.replace(/-/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase()).trim();
    const field = k1[2]!.replace(/_/g, ' ').replace(/\./g, ' ');
    return `${name} — ${field}`;
  }
  // Generic fallback: drop the jurisdiction prefix, humanize the rest.
  return concept
    .replace(/^(fed|il)\./, '')
    .replace(/\.(out|total)$/, '')
    .replace(/[._]/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase());
}

/** $1,234,567-style formatting for narrative sentences (display only). */
export function fmtUsd(v: string): string {
  const neg = v.startsWith('-');
  const digits = (neg ? v.slice(1) : v).replace(/\..*$/, '');
  return `${neg ? '−$' : '$'}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** Compose the top-of-Review narrative from computed facts — reads what the
 *  kernel emitted, computes nothing. */
export function buildSummary(facts: readonly TaxFact[], filingStatus: string): { fed: string[]; il: string[] } | null {
  const v = (concept: string): string | null =>
    facts.find((f) => f.concept === concept && f.derivation !== undefined)?.value.toString() ?? null;
  const totalIncome = v('fed.total_income');
  if (totalIncome === null) return null;
  const fed: string[] = [];
  const STATUS_WORDS: Record<string, string> = {
    mfj: 'married filing jointly', mfs: 'married filing separately',
    hoh: 'head of household', qss: 'qualifying surviving spouse', single: 'single',
  };
  const statusLabel = STATUS_WORDS[filingStatus] ?? filingStatus;
  fed.push(`Your ${TAX_YEAR} federal return (filing ${statusLabel}) shows total income of ${fmtUsd(totalIncome)}.`);
  const ded = v('fed.deduction.applied');
  const qbi = v('fed.qbi.deduction');
  const taxable = v('fed.taxable_income');
  if (ded && taxable) {
    fed.push(
      `After a ${fmtUsd(ded)} deduction${qbi && qbi !== '0' ? ` and a ${fmtUsd(qbi)} QBI deduction` : ''}, taxable income is ${fmtUsd(taxable)}.`,
    );
  }
  const tax = v('fed.tax.total');
  const extras: string[] = [];
  const se = v('fed.se_tax.total');
  if (se && se !== '0') extras.push(`self-employment tax ${fmtUsd(se)}`);
  const am = v('fed.tax.additional_medicare');
  if (am && am !== '0') extras.push(`Additional Medicare Tax ${fmtUsd(am)}`);
  const niit = v('fed.tax.niit');
  if (niit && niit !== '0') extras.push(`net investment income tax ${fmtUsd(niit)}`);
  const ptcRepay = v('fed.ptc.repayment');
  if (ptcRepay && ptcRepay !== '0') extras.push(`excess advance premium credit repayment ${fmtUsd(ptcRepay)}`);
  const credits: string[] = [];
  const ftcAmt = v('fed.credit.foreign_tax');
  if (ftcAmt && ftcAmt !== '0') credits.push(`the ${fmtUsd(ftcAmt)} foreign tax credit`);
  const solar = v('fed.credit.residential_clean_energy');
  if (solar && solar !== '0') credits.push(`the ${fmtUsd(solar)} residential clean energy credit`);
  const totalTax = v('fed.tax.liability.total');
  if (tax && totalTax) {
    fed.push(
      `Bracket tax comes to ${fmtUsd(tax)}${extras.length > 0 ? `, plus ${extras.join(', ')}` : ''}${credits.length > 0 ? `, reduced by ${credits.join(' and ')}` : ''} — total tax ${fmtUsd(totalTax)}.`,
    );
  }
  const payments = v('fed.payments.total');
  const refund = v('fed.refund_or_due');
  if (payments && refund) {
    fed.push(
      refund.startsWith('-')
        ? `You have paid in ${fmtUsd(payments)}, so you owe ${fmtUsd(refund.slice(1))} with the return.`
        : `You have paid in ${fmtUsd(payments)}, so your refund is ${fmtUsd(refund)}.`,
    );
  }
  const il: string[] = [];
  const ilBase = v('il.base_income');
  const ilTax = v('il.tax_after_credits') ?? v('il.tax');
  if (ilBase) il.push(`Illinois starts from your federal income: base income ${fmtUsd(ilBase)}.`);
  if (ilTax) {
    const icr = v('il.icr.property_tax_credit');
    il.push(
      `At the Illinois flat rate${icr && icr !== '0' ? `, minus the ${fmtUsd(icr)} property-tax credit,` : ''} Illinois tax is ${fmtUsd(ilTax)}.`,
    );
  }
  const ilRefund = v('il.refund_or_due');
  const ilPay = v('il.payments.total');
  if (ilRefund && ilPay) {
    il.push(
      ilRefund.startsWith('-')
        ? `Against ${fmtUsd(ilPay)} withheld/paid, you owe Illinois ${fmtUsd(ilRefund.slice(1))}.`
        : `Against ${fmtUsd(ilPay)} withheld/paid, Illinois owes you ${fmtUsd(ilRefund)}.`,
    );
  }
  return { fed, il };
}

/** Display title for a source document (same rules as the Documents page). */
export function docTitle(s: SourceDoc): string {
  const fname = s.fields['__filename'] ?? documentDisplayName(s.raw_ref);
  if (fname) return fname;
  if (s.raw_ref.startsWith('manual://')) return `Manual entry (${s.source_id})`;
  if (s.raw_ref.startsWith('demo://')) return `${s.type} (demo)`;
  return `${s.type} (${s.source_id})`;
}

/** P14.5 — no raw doc ids in anything the user reads: replace doc-<uuid>
 *  (and demo/manual source ids) in a finding message with document titles. */
export function humanizeDocRefs(text: string, sources: readonly SourceDoc[]): string {
  let out = text;
  for (const s of sources) {
    if (out.includes(s.source_id)) out = out.replaceAll(s.source_id, `“${docTitle(s)}”`);
  }
  return out;
}
