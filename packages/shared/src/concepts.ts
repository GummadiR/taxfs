/**
 * Canonical TaxFact concept ids for the step-1 slice.
 * Source concepts come from confirmed documents; derived concepts are
 * emitted by the kernel with Calculation lineage.
 */
export const C = {
  // --- sourced (from confirmed documents) ---
  WAGES: 'income.wages', // W-2 box 1
  INTEREST: 'income.interest', // 1099-INT box 1
  DIV_ORDINARY: 'income.dividends.ordinary', // 1099-DIV box 1a (includes qualified)
  DIV_QUALIFIED: 'income.dividends.qualified', // 1099-DIV box 1b (informs cap-gain rate path)
  CAPITAL_GAIN_NET: 'income.capital_gain.net', // 1099-B → 8949 → Sch D net LT gain
  RETIREMENT: 'income.retirement', // 1099-R (federal-taxable; IL Sch M subtraction)
  /** 1099-INT box 8 / 1040 line 2a. NOT federally taxable, so it never enters
   *  federal total income — but Illinois ADDS IT BACK (IL-1040 line 2). */
  TAX_EXEMPT_INTEREST: 'income.tax_exempt_interest',
  /** The slice of the line-2 add-back that Illinois does NOT tax: interest on
   *  the SPECIFIC Illinois obligations the legislature has exempted, held
   *  DIRECTLY. Per IDOR Pub 101, Illinois state/local bond interest is taxable
   *  "except where legislation has been specifically adopted", and is NOT
   *  exempt when held indirectly through a mutual fund — so this is a short
   *  enumerated list, not "Illinois bonds".
   *  NOTE: interest on US government obligations is a DIFFERENT subtraction —
   *  it is federally TAXABLE, so it sits in income.interest inside AGI and
   *  never enters this add-back. Do not put it here. */
  IL_EXEMPT_OBLIGATIONS: 'il.tax_exempt_interest.exempt_obligations',
  SOCIAL_SECURITY: 'income.social_security', // SSA-1099 (IL Sch M subtraction)
  WAGES_SS: 'income.wages.ss', // W-2 box 3 (SE-tax wage-base coordination)
  WAGES_MEDICARE: 'income.wages.medicare', // W-2 box 5 (Form 8959 base)
  MEDICARE_WH: 'payments.fed.medicare_withholding', // W-2 box 6 (Form 8959 Part IV reconciliation)
  ADJUSTMENTS: 'adjustments.sch1.total',
  ITEMIZED: 'deduction.itemized.total', // Sch A total
  // --- Schedule A components (P67). Supply these INSTEAD of ITEMIZED and the
  // kernel builds the schedule itself: it already holds your property tax and
  // state income tax as facts, applies the SALT cap and the medical floor in
  // the math, and takes the greater of standard vs itemized. ITEMIZED stays
  // supported for a hand-computed total, but the two are mutually exclusive.
  SCHA_MEDICAL: 'deduction.sch_a.medical', // total paid, BEFORE the §213 AGI floor
  SCHA_STATE_TAX_OTHER: 'deduction.sch_a.state_tax_other', // state income tax paid beyond withholding/estimates (e.g. a prior-year balance paid this year)
  SCHA_PERSONAL_PROPERTY_TAX: 'deduction.sch_a.personal_property_tax', // Sch A line 5c
  SCHA_MORTGAGE_INTEREST: 'deduction.sch_a.mortgage_interest', // Form 1098 box 1
  SCHA_MORTGAGE_POINTS: 'deduction.sch_a.mortgage_points', // Form 1098 box 6
  SCHA_INVESTMENT_INTEREST: 'deduction.sch_a.investment_interest', // Form 4952
  SCHA_CHARITABLE: 'deduction.sch_a.charitable',
  CREDITS_SCH3: 'credits.sch3.total',
  FED_WITHHOLDING: 'payments.fed.withholding',
  FED_ESTIMATED: 'payments.fed.estimated',
  /** Form 2210 / IL-2210 late-payment penalty for underpayment of estimated
   *  tax. INPUT: both agencies invite you to let them figure it and bill you,
   *  so TaxOS carries the figure you (or your preparer/software) enter rather
   *  than inventing an interest-rate computation. It is real money owed, so
   *  it must reach the bottom line — see fed.net_amount_due / il.net_amount_due. */
  /** Form 5329 line 3: the early-distribution amount SUBJECT to the §72(t)
   *  additional tax, i.e. after the §72(t)(2) exceptions you qualify for. */
  EARLY_DIST_SUBJECT: 'tax.early_distribution.subject_amount',
  FED_EST_TAX_PENALTY: 'penalty.fed.estimated_tax',
  IL_EST_TAX_PENALTY: 'penalty.il.estimated_tax',
  IL_WITHHOLDING: 'payments.il.withholding',
  IL_PROPERTY_TAX: 'il.property_tax.residence', // Schedule ICR: principal-residence property tax paid
  /** IL-1040 line 15 / Schedule CR: income tax paid to ANOTHER state while an
   *  Illinois resident — a nonrefundable credit against IL tax. */
  IL_OTHER_STATE_CREDIT: 'il.credit.tax_paid_other_states',
  /** IL-1040 line 21: use tax on internet/mail-order/out-of-state purchases.
   *  The form says "Do not leave blank", so it is an explicit entry. */
  IL_USE_TAX: 'il.use_tax',
  /** IL-1040 line 28 (Sch K-1-P/K-1-T): pass-through entity tax credit — the
   *  owner's share of entity-level IL tax already paid. Refundable payment. */
  IL_PTE_CREDIT: 'payments.il.pte_credit',
  SOLAR_COST: 'credit.solar.installation_cost', // Form 5695 line 1: qualified solar property cost (contract total paid)
  // Form 2441 (P50) — child and dependent care credit inputs:
  DEPCARE_EXPENSES: 'credit.dependent_care.expenses', // 2441 line 3: qualified care expenses paid
  DEPCARE_PERSONS: 'credit.dependent_care.qualifying_persons', // 2441 line 2 count (1, or 2+)
  /** W-2 box 10 / Form 2441 Part III: employer-provided dependent care
   *  benefits excluded from income under §129. These REDUCE the §21 dollar
   *  cap — a $5,000 FSA against the $3,000 one-person cap leaves no credit. */
  DEPCARE_EMPLOYER_BENEFITS: 'credit.dependent_care.employer_benefits',
  /** 2441 lines 4–5 §21(d) earned-income limit: the LOWER of the spouses'
   *  earned income on a joint return. Optional — supply it when a spouse has
   *  little or no earned income, or the cap does not bind. */
  DEPCARE_EARNED_INCOME_LIMIT: 'credit.dependent_care.earned_income_limit',
  /** Explicit attestation that §21(d) does NOT bind — both spouses' earned
   *  income exceeded the expenses. Supply this OR the limit above; leaving
   *  both blank is not treated as "no limit" (the taxpayer-favourable guess). */
  DEPCARE_EARNED_INCOME_NOT_LIMITING: 'credit.dependent_care.earned_income_not_limiting',
  // Form 1116 (P18) — foreign tax credit, PASSIVE category. Amounts are USD:
  // the currency conversion is its own recorded calculation upstream, never a
  // silent step inside the credit.
  FOREIGN_INCOME: 'foreign.income.passive', // gross foreign-source income, passive category
  FOREIGN_INCOME_LTCG: 'foreign.income.passive.ltcg', // the part that is long-term capital gain (§904(b)(2)(B) adjustment)
  FOREIGN_TAX_PAID: 'foreign.tax_paid', // foreign income tax paid/accrued (e.g. Indian TDS u/s 195)
  // Foreign-currency originals + the rate used. The kernel converts (and shows
  // the arithmetic); intake never guesses an exchange rate.
  FOREIGN_INCOME_FCY: 'foreign.income.passive.foreign_currency',
  FOREIGN_LTCG_FCY: 'foreign.income.passive.ltcg.foreign_currency',
  FOREIGN_TAX_FCY: 'foreign.tax_paid.foreign_currency',
  FOREIGN_FX_RATE: 'foreign.fx.units_per_usd', // e.g. 83.5 INR per 1 USD
  /** §904(j) election: 1 = claim the credit WITHOUT Form 1116. Available only
   *  when every dollar of creditable foreign tax is passive-category income
   *  reported on a payee statement (1099-DIV/-INT, K-1) AND the total is at or
   *  under the statutory ceiling. Electing waives the §904 limitation — and
   *  waives the §904(c) carryback/carryforward of any excess (§904(j)(3)(A)). */
  FTC_DEMINIMIS_ELECTION: 'foreign.de_minimis_election',
  IL_ESTIMATED: 'payments.il.estimated',

  // --- derived, federal: per-line component totals (workstream D amendment,
  // spec D.9: form lines consume kernel-emitted filing-ready totals; the
  // mapping layer performs no math, not even summation across two W-2s) ---
  FED_WAGES_TOTAL: 'fed.wages.total',
  FED_TAX_EXEMPT_TOTAL: 'fed.tax_exempt_interest.total', // 1040 line 2a — whole-dollar (the sourced facts may carry cents; the kernel owns rounding)
  FED_INTEREST_TOTAL: 'fed.interest.total',
  FED_DIV_ORD_TOTAL: 'fed.dividends.ordinary.total',
  FED_DIV_QUAL_TOTAL: 'fed.dividends.qualified.total',
  FED_CAPGAIN_TOTAL: 'fed.capital_gain.net.total',
  // --- Schedule A derived lines (P67) ---
  FED_SCHA_MEDICAL_ALLOWED: 'fed.sch_a.medical.allowed', // line 4: excess over 7.5% AGI
  FED_SCHA_SALT_BEFORE_CAP: 'fed.sch_a.salt.before_cap', // line 5d
  FED_SCHA_SALT_ALLOWED: 'fed.sch_a.salt.allowed', // line 5e — after the §164(b)(6) cap
  FED_SCHA_INTEREST: 'fed.sch_a.interest', // line 10
  FED_SCHA_CHARITABLE: 'fed.sch_a.charitable', // line 14
  FED_SCHA_TOTAL: 'fed.sch_a.total', // line 17 → 1040 line 12 when it beats the standard
  FED_RETIREMENT_TOTAL: 'fed.retirement.total',
  FED_SCHC_NET_PROFIT_TOTAL: 'fed.schc.net_profit.total', // Sch 1 line 3 (sum of per-entity Sch C)
  // --- Schedule D / 8949 (P2) ---
  CAPLOSS_CO_ST_PRIOR: 'carryover.capital_loss.st', // sourced from prior-year register
  CAPLOSS_CO_LT_PRIOR: 'carryover.capital_loss.lt',
  FED_SCHD_ST_NET: 'fed.schd.st_net',
  FED_SCHD_LT_NET: 'fed.schd.lt_net',
  FED_SCHD_TOTAL: 'fed.schd.total', // line 16/21 result (loss capped)
  FED_SCHD_NCG: 'fed.schd.net_capital_gain', // preferential amount for QDCGT
  CAPLOSS_CO_ST_OUT: 'carryover.capital_loss.st.out',
  CAPLOSS_CO_LT_OUT: 'carryover.capital_loss.lt.out',
  // --- Schedule E p.2 / K-1 + QBI (P3) ---
  FED_SCHE_K1_TOTAL: 'fed.sche.k1_total', // Sch E p.2 -> Sch 1 line 5
  FED_F4797_TOTAL: 'fed.f4797.total', // Form 4797 ordinary gain/(loss) -> Sch 1 line 4 (P41)
  FED_F8582_ALLOWANCE: 'fed.f8582.special_allowance', // §469(i) rental allowance actually used (P41)
  FED_QBI_DEDUCTION: 'fed.qbi.deduction', // Form 8995 line 15
  FED_QBI_LOSS_OUT: 'fed.qbi.loss_carryforward.out', // negative combined QBI
  // --- 8995 openings + REIT/PTP component (P3 back-test slice) ---
  QBI_CO_PRIOR: 'carryover.qbi', // 8995 line 3 prior-year (−)QBI carryforward, entered as a POSITIVE loss; sourced from the qbi_loss register (or manual first-year opening)
  REIT_PTP_INCOME: 'income.reit_ptp.qualified', // 8995 line 6 — §199A REIT dividends (1099-DIV box 5) + PTP income
  // --- Form 8962 / 1095-A premium tax credit (P5, annual method) ---
  PTC_PREMIUM: 'ptc.annual_premium', // 1095-A col A annual total
  PTC_SLCSP: 'ptc.annual_slcsp', // 1095-A col B annual total
  PTC_APTC: 'ptc.annual_aptc', // 1095-A col C annual total (advance credit paid)
  PTC_HOUSEHOLD_SIZE: 'ptc.household_size', // 8962 line 1 (tax family size)
  FED_PTC_NET: 'fed.ptc.net_credit', // 8962 line 26 -> Sch 3 line 9
  FED_PTC_REPAYMENT: 'fed.ptc.repayment', // 8962 line 29 -> Sch 2 line 2
  FED_TAXABLE_BEFORE_QBI: 'fed.taxable_income.before_qbi',
  FED_SE_TAX: 'fed.se_tax.total', // Sch SE line 12 -> Sch 2
  FED_SE_DEDUCTION: 'fed.se_tax.deduction', // Sch SE line 13 -> Sch 1 adjustment
  FED_ADJUSTMENTS_TOTAL: 'fed.adjustments.total',
  FED_SCH1_INCOME_TOTAL: 'fed.sch1.additional_income.total', // Sch 1 line 10 -> 1040 line 8
  FED_SCH1_ADJ_TOTAL: 'fed.sch1.adjustments_total', // Sch 1 line 25 -> 1040 line 10 (sourced adjustments + ½SE)
  FED_SCH2_TOTAL: 'fed.sch2.total', // Sch 2 grand total (Part I + Part II), internal reconciliation line
  FED_SCH2_PART1: 'fed.sch2.part1.total', // Sch 2 line 3 (Part I: APTC repayment) -> 1040 line 17
  FED_SCH2_PART2: 'fed.sch2.part2.total', // Sch 2 line 21 (Part II: SE + 8959 + NIIT) -> 1040 line 23
  FED_WH_COMBINED: 'fed.withholding.combined', // 1040 line 25d (25a W-2 + 25c Form 8959; 25b 1099-WH is a recorded gap)
  FED_WH_TOTAL: 'fed.withholding.total',
  FED_EST_TOTAL: 'fed.estimated.total',
  FED_CREDITS_TOTAL: 'fed.credits.total',
  // --- Form 8959 / Form 8960 high-income surtaxes (P10) ---
  FED_ADDL_MEDICARE: 'fed.tax.additional_medicare', // 8959 line 18 -> Sch 2 line 11
  FED_ADDL_MEDICARE_WH: 'fed.withholding.additional_medicare', // 8959 line 24 -> 1040 line 25c
  FED_NIIT: 'fed.tax.niit', // 8960 line 17 -> Sch 2 line 12
  FED_EARLY_DIST_TAX: 'fed.tax.early_distribution', // Form 5329 Part I -> Sch 2 line 8
  // --- Form 5695 residential clean energy credit (P12) ---
  FED_SOLAR_CREDIT: 'fed.credit.residential_clean_energy', // 5695 line 15 -> Sch 3 line 5a (limited to tax)
  FED_FTC: 'fed.credit.foreign_tax', // Form 1116 line 35 → Sch 3 line 1 (line 33 is an intermediate)
  FED_DEPCARE_CREDIT: 'fed.credit.dependent_care', // Form 2441 line 11 → Sch 3 line 2
  /** Flag: the §21(d) earned-income limit was neither supplied nor attested. */
  FED_DEPCARE_EI_UNVERIFIED: 'fed.credit.dependent_care.earned_income_unverified',
  FED_FTC_UNUSED: 'fed.credit.foreign_tax.unused', // over the §904 limit — carries forward 10 years
  /** P73 — foreign tax that is NOT being credited because no foreign-source
   *  income was supplied and the §904(j) election was not made. Omitting a
   *  credit RAISES tax, so the return still computes; this fact makes the
   *  omission visible instead of silent. */
  FED_FTC_NOT_CLAIMED: 'fed.credit.foreign_tax.not_claimed',
  FED_SOLAR_UNUSED: 'fed.credit.solar.unused', // 5695 line 16 informational — §25D(c) carryforward usability post-2025 unresolved (OBBBA termination), NOT rolled to a register

  // --- derived, federal ---
  FED_TOTAL_INCOME: 'fed.total_income',
  FED_AGI: 'fed.agi',
  FED_STD_DEDUCTION: 'fed.deduction.standard',
  FED_DEDUCTION: 'fed.deduction.applied', // max(standard, itemized)
  FED_TAXABLE: 'fed.taxable_income',
  FED_TAX_ORDINARY: 'fed.tax.ordinary',
  FED_TAX_CAPGAIN: 'fed.tax.capgain',
  FED_TAX: 'fed.tax.total',
  FED_TAX_AFTER_CREDITS: 'fed.tax_after_credits',
  // P80 — the 1040's pure-addition subtotal boxes. The IRS form requires them
  // printed even though nothing downstream consumes them; the kernel owns
  // every form line, so they are emitted rather than summed in the mapper.
  FED_DEDUCTIONS_TOTAL: 'fed.deductions.total', // 1040 line 14 = 12e + 13a + 13b
  FED_TAX_PLUS_SCH2_PART1: 'fed.tax.plus_sch2_part1', // 1040 line 18 = 16 + 17
  FED_PAYMENTS: 'fed.payments.total',
  FED_TOTAL_TAX_LIABILITY: 'fed.tax.liability.total', // 1040 line 24 (after-credits + other taxes)
  FED_REFUND_OR_DUE: 'fed.refund_or_due', // positive = refund, negative = balance due
  /** 1040 line 37/34 net of the Form 2210 penalty — what you actually pay or receive. */
  FED_NET_AMOUNT_DUE: 'fed.net_amount_due',

  // --- derived, Illinois ---
  IL_WH_TOTAL: 'il.withholding.total', // Sch IL-WIT line total (kernel-emitted)
  IL_EST_TOTAL: 'il.estimated.total',
  IL_BASE_INCOME: 'il.base_income', // fed AGI ± Sch M
  IL_ADDITIONS: 'il.sch_m.additions', // IL-4562 bonus addback (decoupling)
  IL_TAX_EXEMPT_ADDBACK: 'il.tax_exempt_interest.addback', // IL-1040 line 2
  IL_DEP_SUBTRACTION: 'il.sch_m.depreciation_subtraction', // IL-4562 as-if depreciation
  IL_SUBTRACTIONS: 'il.sch_m.subtractions',
  IL_EXEMPTION: 'il.exemption.total',
  // P81 — IL-1040 boxes the printed form requires. Line 4 is the additions
  // subtotal (1+2+3); line 10a is the per-person exemption BEFORE the 65/blind
  // boxes on 10b/10c, which the form prints on its own line.
  IL_TOTAL_INCOME: 'il.total_income',              // IL-1040 line 4
  IL_EXEMPTION_BASE: 'il.exemption.base_persons',  // IL-1040 line 10a
  IL_NET_INCOME: 'il.net_income',
  IL_TAX: 'il.tax',
  IL_ICR_CREDIT: 'il.icr.property_tax_credit', // Schedule ICR line 4f (5% of residence property tax, capped)
  IL_ICR_PROPTAX_PAID: 'il.icr.property_tax_paid', // Schedule ICR line 4a — kernel-rounded whole dollars (D never rounds)
  IL_TOTAL_TAX: 'il.total_tax', // IL-1040 line 23 = line 19 + use tax
  IL_TAX_AFTER_CREDITS: 'il.tax_after_credits',
  IL_PAYMENTS: 'il.payments.total',
  IL_REFUND_OR_DUE: 'il.refund_or_due',
  /** IL-1040 line 41/37 net of the IL-2210 penalty (line 36). */
  IL_NET_AMOUNT_DUE: 'il.net_amount_due',

  // --- P93: retirement / HSA contribution inputs (validation waves) ---
  /** W-2 box 12 code W — employer + payroll HSA contributions. Already
   *  excluded from box 1 wages, so it is a LIMIT input, never income. */
  CONTRIB_HSA_EMPLOYER: 'contrib.hsa.employer',
  /** HSA contributions made directly (outside payroll) — the Sch 1 line 13
   *  deduction candidate, and the other half of the double-count check. */
  CONTRIB_HSA_DIRECT: 'contrib.hsa.direct',
  /** 1 = family HDHP coverage, 0 = self-only. Drives which §223 limit applies. */
  HSA_FAMILY_COVERAGE: 'contrib.hsa.family_coverage',
  /** Count (0-2) of account holders aged 55+ contributing — each adds one
   *  §223(b)(3) catch-up, valid only into that person's own HSA. */
  HSA_CATCHUP_COUNT: 'contrib.hsa.catch_up_count',
  /** Traditional IRA contributions, PER PERSON — §219 limits are individual. */
  CONTRIB_IRA_TRAD_TP: 'contrib.ira.traditional.tp',
  CONTRIB_IRA_TRAD_SP: 'contrib.ira.traditional.sp',
  /** Roth IRA contributions, per person — shares the §219 limit with Traditional. */
  CONTRIB_IRA_ROTH_TP: 'contrib.ira.roth.tp',
  CONTRIB_IRA_ROTH_SP: 'contrib.ira.roth.sp',
  /** W-2 box 12 codes D/E/AA/BB summed across employers, per person —
   *  the §402(g) base. */
  CONTRIB_DEFERRAL_TP: 'contrib.401k.deferral.tp',
  CONTRIB_DEFERRAL_SP: 'contrib.401k.deferral.sp',
  /** 1 = W-2 box 13 "Retirement plan" ticked for that person — the active-
   *  participant flag that turns on the §219(g) deduction phase-out. */
  W2_RETIREMENT_PLAN_TP: 'w2.box13.retirement_plan.tp',
  W2_RETIREMENT_PLAN_SP: 'w2.box13.retirement_plan.sp',

  // --- P94: HSA validation (Form 8889 / §223 / §4973) — derived ---
  /** The §223(b) annual limit that applies to THIS return: coverage-type
   *  limit + one catch-up per 55+ account holder. */
  FED_HSA_LIMIT: 'fed.hsa.limit',
  /** Form 8889 line 13 → Sch 1 line 13: direct (non-payroll) contributions,
   *  deductible up to the room the employer contributions left. */
  FED_HSA_DEDUCTION: 'fed.hsa.deduction',
  /** Contributions above the §223 limit — the §4973 excise base. */
  FED_HSA_EXCESS: 'fed.hsa.excess_contribution',
  /** §4973(a) 6% additional tax (Form 5329 Part VII → Sch 2). */
  FED_HSA_EXCISE: 'tax.hsa.excess_excise',

  // --- P95: Traditional IRA validation (§219 / Form 8606 / §4973) ---
  /** 1 = that person was 50+ at year end (enables the §219(b)(5)(B) catch-up). */
  IRA_CATCHUP_TP: 'contrib.ira.catch_up.tp',
  IRA_CATCHUP_SP: 'contrib.ira.catch_up.sp',
  /** Sch 1 line 20 — the DEDUCTIBLE slice of Traditional IRA contributions,
   *  both spouses combined, after the §219(g) phase-out. */
  FED_IRA_DEDUCTION: 'fed.ira.deduction',
  /** Form 8606 line 1 — nondeductible Traditional contributions, per person.
   *  BASIS: keep Form 8606 with the return every year until distribution. */
  FED_IRA_NONDEDUCTIBLE_TP: 'fed.ira.nondeductible.tp',
  FED_IRA_NONDEDUCTIBLE_SP: 'fed.ira.nondeductible.sp',
  /** Combined Traditional+Roth contributions above the §219 limit or above
   *  compensation — the §4973 excise base. */
  FED_IRA_EXCESS: 'fed.ira.excess_contribution',
  /** §4973(a) 6% additional tax on the IRA excess (Form 5329 Parts III/IV). */
  FED_IRA_EXCISE: 'tax.ira.excess_excise',

  // --- P97: employer plans (§402(g) / SIMPLE / SEP) ---
  /** 1 = that person was 60–63 at year end: the §414(v)(2)(E) enhanced
   *  catch-up REPLACES the age-50 amount for those four years. */
  DEFERRAL_SUPER_CATCHUP_TP: 'contrib.401k.catch_up_60_63.tp',
  DEFERRAL_SUPER_CATCHUP_SP: 'contrib.401k.catch_up_60_63.sp',
  /** SIMPLE IRA/401(k) deferrals per person — their OWN §408(p) limit, and
   *  they also count inside the person's §402(g) aggregate. */
  CONTRIB_SIMPLE_TP: 'contrib.simple.deferral.tp',
  CONTRIB_SIMPLE_SP: 'contrib.simple.deferral.sp',
  /** SEP / Solo-401(k) EMPLOYER-side contribution for the Sch C business. */
  CONTRIB_SEP: 'contrib.sep.employer',
  /** Excess elective deferrals are INCOME (1040 line 1h) — not an excise:
   *  taxed now, and taxed AGAIN at distribution if not withdrawn by Apr 15. */
  FED_DEFERRAL_EXCESS_INCOME: 'fed.deferral.excess_income',
  /** Sch 1 line 16 — self-employed SEP/Solo-401(k) deduction (Pub 560
   *  reduced-rate worksheet). */
  FED_SEP_DEDUCTION: 'fed.sep.deduction',
  FED_SEP_EXCESS: 'fed.sep.excess_contribution',
  /** §4972(a) 10% excise on the nondeductible employer contribution. */
  FED_SEP_EXCISE: 'tax.sep.nondeductible_excise',
} as const;

export type ConceptId = (typeof C)[keyof typeof C];

/** Sourced income concepts that flow into federal total income. */
export const FED_INCOME_CONCEPTS: readonly string[] = [
  C.WAGES,
  C.INTEREST,
  C.DIV_ORDINARY,
  C.CAPITAL_GAIN_NET,
  C.RETIREMENT,
];

/** Concepts a third-party form is expected to report (doc-match / transcript).
 *  P14.9: interest/dividend/capital-gain facts may also arrive on a combined
 *  brokerage statement (CONSOLIDATED-1099) — any listed form satisfies. */
/**
 * Concepts that are SINGULAR by law: each is exactly one figure on exactly
 * one line, taken from one worksheet. The kernel reads every concept with
 * `sumOfConcept`, which ADDS every confirmed fact — right for wages (many
 * W-2s) and interest (many 1099-INTs), and silently wrong for these, where a
 * second entry is never a second source, only the same figure counted twice.
 *
 * This is not hypothetical: a capital-loss carryover entered on both the Add
 * Data worksheet and the Documents typed-entry picker doubled, taking
 * $42,410 off Schedule D with nothing on any screen to say so. The Add Data
 * card uses `.find()`, so it showed ONE entry while the kernel summed two.
 *
 * Adding a concept here asserts it can never legitimately arrive twice.
 * Wages, interest, dividends and HSA employer contributions must NOT be
 * here — those genuinely have several payers.
 */
export const SINGULAR_CONCEPTS: readonly string[] = [
  C.CAPLOSS_CO_ST_PRIOR, // Schedule D line 6, from the Carryover Worksheet
  C.CAPLOSS_CO_LT_PRIOR, // Schedule D line 14, from the Carryover Worksheet
  C.PTC_HOUSEHOLD_SIZE, // Form 8962 line 1 — a COUNT; two entries of 4 make 8
  C.FED_EST_TAX_PENALTY, // Form 2210 — one figure for the return
  C.IL_EST_TAX_PENALTY, // IL-2210 — likewise
];

export const THIRD_PARTY_FORM_BY_CONCEPT: Readonly<Record<string, readonly string[]>> = {
  [C.WAGES]: ['W-2'],
  [C.INTEREST]: ['1099-INT', 'CONSOLIDATED-1099'],
  [C.TAX_EXEMPT_INTEREST]: ['1099-INT', 'CONSOLIDATED-1099'],
  [C.DIV_ORDINARY]: ['1099-DIV', 'CONSOLIDATED-1099'],
  [C.CAPITAL_GAIN_NET]: ['1099-B', 'CONSOLIDATED-1099'],
  [C.RETIREMENT]: ['1099-R'],
  [C.SOCIAL_SECURITY]: ['SSA-1099'],
  [C.PTC_PREMIUM]: ['1095-A'],
  [C.PTC_SLCSP]: ['1095-A'],
  [C.PTC_APTC]: ['1095-A'],
};

// ===========================================================================
// Concept registry (P0 foundation — ARCHITECTURE §4)
//
// The registry is the single vocabulary the kernel, forms mapping, and
// intake share. Concepts are either FLAT ids (the C table above) or
// NAMESPACED ids parameterized by an entity/asset/document instance:
//
//   schc.<entity_id>.<field>          Schedule C per business
//   schc.<entity_id>.expense.<cat>    official Part II expense taxonomy
//   dep.<asset_id>.<field>            per-asset depreciation (Form 4562)
//   k1.<k1_id>.<field>                K-1 box values (inbound or outbound)
//   entity.<entity_id>.<field>        entity-return lines (1065 / 1120-S)
//
// Intake can only categorize into registered concepts — free-form expense
// categories and Sch A / Sch C cross-posting are structurally impossible.
// ===========================================================================

/** Official Schedule C Part II expense categories (line-level taxonomy). */
export const SCHC_EXPENSE_CATEGORIES = [
  'advertising',
  'car_truck',
  'commissions_fees',
  'contract_labor',
  'depletion',
  'employee_benefits',
  'insurance',
  'interest_mortgage',
  'interest_other',
  'legal_professional',
  'office',
  'pension_profit_sharing',
  'rent_vehicles_equipment',
  'rent_other',
  'repairs',
  'supplies',
  'taxes_licenses',
  'travel',
  'meals', // 50% limit applied by the kernel, never by the user
  'utilities',
  'wages',
  'other',
  'home_office', // Form 8829 result line (8829 computes it; Sch C consumes it)
] as const;
export type SchcExpenseCategory = (typeof SCHC_EXPENSE_CATEGORIES)[number];

/** 1120-S page 1 / 1065 page 1 deduction taxonomy (line-level, closed). */
export const ENTITY_DEDUCTION_CATEGORIES = [
  'officers_comp', // 1120-S line 7 (1125-E)
  'salaries_wages',
  'repairs',
  'bad_debts',
  'rents',
  'taxes_licenses',
  'interest',
  'depreciation',
  'depletion',
  'advertising',
  'pension_profit_sharing',
  'employee_benefits',
  'other', // line 19 (statement required at Gate 5)
] as const;
export type EntityDeductionCategory = (typeof ENTITY_DEDUCTION_CATEGORIES)[number];

/** Separately-stated Schedule K income lines the entity kernel models (P4). */
export const ENTITY_K_LINES = [
  'int_income', // Sch K line 4
  'div_ordinary', // line 5a
  'div_qualified', // line 5b (informational for the recipient's rate path)
  'st_gain', // line 7
  'lt_gain', // line 8a
  'other_income_st', // line 10 stmt (ST character)
  'other_income_lt', // line 10 stmt (LT character)
] as const;
export type EntityKLine = (typeof ENTITY_K_LINES)[number];

const ID_SEG = '[a-z0-9][a-z0-9_-]*';
/** Namespaced concept patterns. Order matters only for familyOfConcept. */
const NAMESPACE_PATTERNS: readonly { family: FormFamily; re: RegExp }[] = [
  { family: 'schedule_c', re: new RegExp(`^schc\\.${ID_SEG}\\.expense\\.(${SCHC_EXPENSE_CATEGORIES.join('|')})$`) },
  { family: 'schedule_c', re: new RegExp(`^schc\\.${ID_SEG}\\.(gross_receipts|returns_allowances|cogs|net_profit|startup_costs_total|startup_amort_months|startup_deduction|homeoffice\\.(sq_ft|home_sq_ft|home_expenses_total|carryover_prior|deduction|carryover_out)|vehicle\\.(business_miles|deduction))$`) },
  { family: 'depreciation', re: new RegExp(`^dep\\.${ID_SEG}\\.(basis|method|life_years|convention|sec179|bonus|deduction_current|accumulated)$`) },
  { family: 'depreciation', re: /^fed\.sec179\.carryforward$/ },
  { family: 'capital_gains', re: new RegExp(`^lot\\.${ID_SEG}\\.(proceeds|basis|term|wash_disallowed)$`) },
  { family: 'k1_passthrough', re: new RegExp(`^k1\\.${ID_SEG}\\.box[0-9]+[a-z]?(_[a-z_]+)?$`) },
  { family: 'k1_passthrough', re: new RegExp(`^k1\\.${ID_SEG}\\.(is_scorp|material_participation|basis_opening|debt_basis_opening|contributions|distributions|liab_change|capital_gain|passive_carryover|qbi_eligible|qbi_amount|guaranteed_payment|rental_active|f4797|allowed_net|allowed_4797|basis_suspended\\.out|passive_suspended\\.out|debt_basis_closing|disposed_entire_interest)$`) },
  // Entity returns (P4): sourced entity lines, member ownership shares, and
  // kernel-derived entity/member outputs (K-1-P lines carry IL jurisdiction).
  { family: 'entity_return', re: new RegExp(`^entity\\.${ID_SEG}\\.deduction\\.(${ENTITY_DEDUCTION_CATEGORIES.join('|')})$`) },
  { family: 'entity_return', re: new RegExp(`^entity\\.${ID_SEG}\\.k\\.(${ENTITY_K_LINES.join('|')})$`) },
  { family: 'entity_return', re: new RegExp(`^entity\\.${ID_SEG}\\.member\\.${ID_SEG}\\.(share|guaranteed_payment|box1|capital_gain|k1p_line20|k1p_line26|k1p_line27|k1p_line29|k1p_line31)$`) },
  { family: 'entity_return', re: new RegExp(`^entity\\.${ID_SEG}\\.(is_scorp|gross_receipts|returns_allowances|cogs|liabilities_beginning|liabilities_ending|ordinary_income|k_total|il\\.base_income|il\\.replacement_tax)$`) },
];

/**
 * Form families for the capability registry (Gate 1). A return REQUIRES a
 * family when any confirmed fact maps into it — detection is data-driven.
 */
export type FormFamily =
  | '1040_core' // wages/interest/dividends/retirement, std-vs-itemized, brackets, IL-1040 base
  | 'capital_gains' // Sch D / 8949 net-gain fact path (rate stacking is in 1040_core)
  | 'schedule_c'
  | 'depreciation'
  | 'k1_passthrough'
  | 'entity_return'
  | 'social_security'
  | 'foreign_tax_credit' // Form 1116 — foreign tax on foreign-source income
  | 'ptc'; // Form 8962 / 1095-A premium tax credit reconciliation

/** Flat concepts → owning form family. Anything not listed is 1040_core. */
const FLAT_FAMILY: Readonly<Record<string, FormFamily>> = {
  [C.CAPITAL_GAIN_NET]: 'capital_gains',
  [C.CAPLOSS_CO_ST_PRIOR]: 'capital_gains',
  [C.CAPLOSS_CO_LT_PRIOR]: 'capital_gains',
  [C.SOCIAL_SECURITY]: 'social_security',
  // 8995 inputs live with the K-1 slice (PTP income is a K-1 item; the
  // REIT-dividend-only case still routes here so Gate 1 sees the 8995 need).
  [C.QBI_CO_PRIOR]: 'k1_passthrough',
  [C.REIT_PTP_INCOME]: 'k1_passthrough',
  [C.PTC_PREMIUM]: 'ptc',
  [C.PTC_SLCSP]: 'ptc',
  [C.PTC_APTC]: 'ptc',
  [C.PTC_HOUSEHOLD_SIZE]: 'ptc',
  [C.FOREIGN_INCOME]: 'foreign_tax_credit',
  [C.FOREIGN_INCOME_LTCG]: 'foreign_tax_credit',
  [C.FOREIGN_TAX_PAID]: 'foreign_tax_credit',
  [C.FOREIGN_INCOME_FCY]: 'foreign_tax_credit',
  [C.FOREIGN_LTCG_FCY]: 'foreign_tax_credit',
  [C.FOREIGN_TAX_FCY]: 'foreign_tax_credit',
  [C.FOREIGN_FX_RATE]: 'foreign_tax_credit',
  [C.FED_FTC]: 'foreign_tax_credit',
  [C.FED_FTC_UNUSED]: 'foreign_tax_credit',
  [C.FED_FTC_NOT_CLAIMED]: 'foreign_tax_credit',
  [C.FTC_DEMINIMIS_ELECTION]: 'foreign_tax_credit',
  [C.FED_PTC_NET]: 'ptc',
  [C.FED_PTC_REPAYMENT]: 'ptc',
};

const FLAT_CONCEPTS: ReadonlySet<string> = new Set(Object.values(C));

/** True iff the id is a registered flat concept or matches a namespace. */
export function isRegisteredConcept(id: string): boolean {
  if (FLAT_CONCEPTS.has(id)) return true;
  return NAMESPACE_PATTERNS.some((p) => p.re.test(id));
}

/** The form family a concept belongs to, or null if unregistered. */
export function familyOfConcept(id: string): FormFamily | null {
  if (FLAT_CONCEPTS.has(id)) return FLAT_FAMILY[id] ?? '1040_core';
  const hit = NAMESPACE_PATTERNS.find((p) => p.re.test(id));
  return hit ? hit.family : null;
}

/** Distinct form families required by a set of concept ids (Gate 1 input). */
export function requiredFamilies(conceptIds: readonly string[]): FormFamily[] {
  const out = new Set<FormFamily>();
  for (const id of conceptIds) {
    const fam = familyOfConcept(id);
    if (fam !== null) out.add(fam);
  }
  return [...out];
}
