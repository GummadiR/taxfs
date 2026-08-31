/**
 * PART C — deterministic kernel, step-1 slice.
 *
 * Pure functions: no I/O, no clock, no randomness. All tax figures come
 * from injected rule-data (RuleSet); this file contains structure only.
 * Every derived value emits a Calculation record (inputs, formula_ref,
 * rule_version, steps, value).
 *
 * ROUNDING (kernel-owned): every derived line is rounded to whole dollars
 * (HALF_UP) as it is emitted; totals are computed over already-rounded
 * component lines, so rounded totals = sum of rounded lines by
 * construction. The mapping layer never rounds.
 *
 * Known step-1 structural simplifications (not figures — structure):
 *  - capital-loss limitation ($3,000 cap) not yet modeled; goldens do not
 *    exercise net losses. Requires a rule-data figure when added.
 *  - qualified dividends + net LTCG are taxed via a simplified stacked
 *    preferential-rate worksheet (formula_ref marks it SIMPLIFIED).
 */
import {
  C,
  Money,
  type BracketRow,
  type Calculation,
  type FilingContext,
  type Jurisdiction,
  type RuleSet,
  type TaxFact,
} from '@taxfs/shared';

export interface KernelInput {
  taxpayer_id: string;
  tax_year: number;
  ctx: FilingContext;
  /** Confirmed facts visible to the kernel (sourced + previously derived are ignored/recomputed). */
  facts: TaxFact[];
  fed_rules: RuleSet;
  il_rules: RuleSet;
}

export interface KernelResult {
  computedFacts: TaxFact[];
  calculations: Calculation[];
}

// Emitter + fact-summing helpers live in emit.ts (shared with the entity
// kernel, P4); re-exported here so existing imports keep working.
export { derivedFactId } from './emit';
import { makeEmitter, sourcedFacts, sumOfConcept } from './emit';

/** Progressive bracket tax on `amount` (rule-data bracket rows). Unrounded result. */
function bracketTax(rows: BracketRow[], amount: Money, steps: string[]): Money {
  let tax = Money.zero();
  let lower = Money.zero();
  for (const row of rows) {
    if (amount.lte(lower)) break;
    const upper = row.up_to === null ? amount : Money.min(amount, Money.fromString(row.up_to));
    const portion = upper.sub(lower);
    if (portion.gt(Money.zero())) {
      const t = portion.mulRate(row.rate);
      tax = tax.add(t);
      steps.push(
        `bracket (${lower.toString()}, ${row.up_to ?? '∞'}]: ${portion.toString()} × ${row.rate} = ${t.toString()}`,
      );
    }
    if (row.up_to === null) break;
    lower = Money.fromString(row.up_to);
  }
  return tax;
}

/**
 * Simplified stacked preferential-rate tax: the preferential amount is
 * stacked on top of the ordinary portion; each capital-gains bracket taxes
 * the overlap of [ordinaryTop, taxable] with that bracket.
 */
function capGainTax(
  rows: BracketRow[],
  ordinaryTop: Money,
  taxable: Money,
  steps: string[],
): Money {
  let tax = Money.zero();
  let lower = Money.zero();
  for (const row of rows) {
    const upper = row.up_to === null ? taxable : Money.min(taxable, Money.fromString(row.up_to));
    const from = Money.max(lower, ordinaryTop);
    const portion = upper.sub(from);
    if (portion.gt(Money.zero())) {
      const t = portion.mulRate(row.rate);
      tax = tax.add(t);
      steps.push(
        `capgain bracket (${lower.toString()}, ${row.up_to ?? '∞'}]: ${portion.toString()} × ${row.rate} = ${t.toString()}`,
      );
    }
    if (row.up_to === null) break;
    lower = Money.fromString(row.up_to);
  }
  return tax;
}

/** The bracket rate that applies to the LAST dollar of `amount` — used for the
 *  §904(b)(2)(B) rate differential. Brackets are ascending with a null top. */
function marginalRate(rows: readonly BracketRow[], amount: Money): string {
  let rate = rows.length > 0 ? rows[0]!.rate : '0';
  for (const row of rows) {
    rate = row.rate;
    if (row.up_to !== null && !amount.gt(Money.fromString(row.up_to))) break;
  }
  return rate;
}

export function compute(input: KernelInput): KernelResult {
  const fed = input.fed_rules.fed;
  const il = input.il_rules.il;
  if (!fed) throw new Error('kernel: FED rule set missing fed parameters');
  if (!il) throw new Error('kernel: IL rule set missing il parameters');
  const rvFed = input.fed_rules.rule_version;
  const rvIl = input.il_rules.rule_version;
  const fs = input.ctx.filing_status;
  const em = makeEmitter(input);

  // Per-line component totals (workstream D amendment, spec D.9): every
  // form line consumes a kernel-emitted filing-ready total — the mapping
  // layer does no math, so even "sum of two W-2 box 1" is a kernel line.
  const componentOf = (
    srcConcept: string,
    outConcept: string,
    jurisdiction: Jurisdiction[],
    rule_version: string,
  ): TaxFact => {
    const s = sumOfConcept(input, srcConcept);
    return em.emit({
      concept: outConcept,
      jurisdiction,
      inputs: s.inputs,
      formula_ref: `LINE_TOTAL.${srcConcept}`,
      rule_version,
      steps: s.steps,
      value: s.total,
    });
  };

  // ---------- FEDERAL ----------

  const wagesTotal = componentOf(C.WAGES, C.FED_WAGES_TOTAL, ['FED'], rvFed);
  const interestTotal = componentOf(C.INTEREST, C.FED_INTEREST_TOTAL, ['FED'], rvFed);
  const divOrdTotal = componentOf(C.DIV_ORDINARY, C.FED_DIV_ORD_TOTAL, ['FED'], rvFed);
  const qualDivTotal = componentOf(C.DIV_QUALIFIED, C.FED_DIV_QUAL_TOTAL, ['FED'], rvFed);
  const retirementTotal = componentOf(C.RETIREMENT, C.FED_RETIREMENT_TOTAL, ['FED'], rvFed);
  // 1040 line 2a — informational (not in total income), but a FORM line, so
  // the kernel must emit it filing-ready: the sourced facts may carry cents
  // (a bank statement figure), and the mapping layer never rounds.
  const exemptIntForm = sumOfConcept(input, C.TAX_EXEMPT_INTEREST);
  if (exemptIntForm.inputs.length > 0) {
    em.emit({
      concept: C.FED_TAX_EXEMPT_TOTAL, jurisdiction: ['FED'],
      inputs: exemptIntForm.inputs, formula_ref: 'FED.1040.LINE2A.TAX_EXEMPT_TOTAL', rule_version: rvFed,
      steps: [
        ...exemptIntForm.steps,
        `round_half_up(${exemptIntForm.total.toString()}) = ${exemptIntForm.total.roundToDollar().toString()} (1040 line 2a is whole dollars; the kernel owns rounding)`,
      ],
      value: exemptIntForm.total.roundToDollar(),
    });
  }
  // Sourced 1099-B / manual capital-gain net totals. Whether these become
  // the legacy 1040 line 7 or FOLD INTO Schedule D depends on whether the
  // Sch D sub-DAG activates — decided below, AFTER the FX conversion.
  const capGainSourced = sumOfConcept(input, C.CAPITAL_GAIN_NET);

  // ---------- FOREIGN-CURRENCY CONVERSION (P18/P25 — the 15CA/15CB path) ----------
  // These amounts arrive in the certificate's own currency and exist NOWHERE
  // else on a US form, so the kernel both CONVERTS them (arithmetic on the
  // record) and REPORTS them: the converted income enters Schedule D below
  // (long-term portion on Part II; any non-long-term remainder on Part I,
  // which taxes it at ordinary rates), and the converted tax feeds Form 1116.
  // The USD foreign.* concepts remain pure characterization of income
  // reported elsewhere — entered once, counted once.
  const fxRate = sumOfConcept(input, C.FOREIGN_FX_RATE);
  const fcyIncome = sumOfConcept(input, C.FOREIGN_INCOME_FCY);
  const fcyLtcg = sumOfConcept(input, C.FOREIGN_LTCG_FCY);
  const fcyTax = sumOfConcept(input, C.FOREIGN_TAX_FCY);
  const fxSteps: string[] = [];
  let convertedIncome = Money.zero();
  let convertedLtcg = Money.zero();
  let convertedTax = Money.zero();
  if (fcyIncome.inputs.length > 0 || fcyLtcg.inputs.length > 0 || fcyTax.inputs.length > 0) {
    const rows = sourcedFacts(input, C.FOREIGN_FX_RATE);
    if (rows.length !== 1 || rows[0]!.value.isZero()) {
      throw new Error(
        'kernel: foreign-currency amounts are present but exactly one non-zero exchange rate (foreign.fx.units_per_usd) is required to convert them',
      );
    }
    if (fcyLtcg.total.gt(fcyIncome.total)) {
      throw new Error(
        'kernel: the long-term portion of foreign income exceeds the total foreign income — the entries are inconsistent',
      );
    }
    const rate = rows[0]!.value;
    convertedIncome = fcyIncome.total.mulFraction('1', rate.toString()).roundToDollar();
    convertedLtcg = fcyLtcg.total.mulFraction('1', rate.toString()).roundToDollar();
    convertedTax = fcyTax.total.mulFraction('1', rate.toString()).roundToDollar();
    fxSteps.push(
      `currency conversion at ${rate.toString()} foreign units per USD: income ${fcyIncome.total.toString()} ÷ ${rate.toString()} = ${convertedIncome.toString()}${fcyLtcg.inputs.length > 0 ? `; long-term gain portion ${fcyLtcg.total.toString()} ÷ ${rate.toString()} = ${convertedLtcg.toString()}` : ''}; tax ${fcyTax.total.toString()} ÷ ${rate.toString()} = ${convertedTax.toString()}`,
      // P68 — two things a foreign certificate CANNOT settle, said plainly on
      // the record because getting either wrong is a large, quiet error.
      'THE US GAIN IS NOT THE CERTIFICATE FIGURE: a foreign certificate states income chargeable under FOREIGN law — India, for instance, indexes the cost of acquisition for inflation and the US does not (§1001: amount realized − adjusted basis, no indexation). Enter the US-measured gain, not the remittance and not the foreign chargeable amount.',
      `SIMPLIFIED: one exchange rate is applied to everything. Strictly the amount realized is translated at the SALE-date spot rate and the basis at the ACQUISITION-date rate, so a long-held asset carries an exchange component this single rate cannot express (recorded gap). WHICH DATE THIS RATE CAME FROM MATTERS: a 15CA/15CB certifies money LEAVING the country, which routinely happens weeks or months after the sale, and an automatic lookup can only use the date the certificate prints. §1001 wants the SALE date. Check the rate's own date against your sale date; if they differ, supply the sale-date rate. ${fcyLtcg.inputs.length > 0 ? 'The long-term portion supplied here must reflect the US holding period (§1222(3): more than one year) — not the foreign law\'s own long-term test.' : 'No long-term portion was supplied, so ALL of this is taxed at ordinary rates.'}`,
    );
  }

  // ---------- SCHEDULE D / FORM 8949 (P2) ----------
  // Activates when lot.* or capital-loss-carryover facts exist; otherwise the
  // legacy sourced income.capital_gain.net path is used unchanged.
  const LOT_RE = /^lot\.([a-z0-9][a-z0-9_-]*)\.(proceeds|basis|term|wash_disallowed)$/;
  const lotIds = [...new Set(
    input.facts
      .filter((f) => f.derivation === undefined && f.status === 'confirmed')
      .map((f) => LOT_RE.exec(f.concept)?.[1])
      .filter((x): x is string => x !== undefined),
  )].sort();
  const stCoPrior = sumOfConcept(input, C.CAPLOSS_CO_ST_PRIOR);
  const ltCoPrior = sumOfConcept(input, C.CAPLOSS_CO_LT_PRIOR);

  // K-1 net LT capital gains (1120-S K-1 box 8a / 1065 K-1 box 9a) flow to
  // Schedule D Part II here, increase basis in the K-1 block (7203 line 3g /
  // §705(a)(1)), and count as passive income on Form 8582 when the activity
  // is passive. Net capital LOSSES on a K-1 are a recorded gap: losses need
  // character tracking through the basis/passive limits, so the kernel
  // accepts gains only and says so in the trail.
  const K1_CG_RE = /^k1\.([a-z0-9][a-z0-9_-]*)\.capital_gain$/;
  const k1CgInputs: TaxFact[] = [];
  const k1CgById = new Map<string, Money>();
  for (const f of input.facts) {
    const m = K1_CG_RE.exec(f.concept);
    if (!m || f.derivation !== undefined || f.status !== 'confirmed') continue;
    k1CgInputs.push(f);
    k1CgById.set(m[1]!, (k1CgById.get(m[1]!) ?? Money.zero()).add(f.value.roundToDollar()));
  }
  const k1CgTotal = Money.sum([...k1CgById.values()].map((v) => Money.max(Money.zero(), v)));

  const schdActive = lotIds.length > 0 || !stCoPrior.total.isZero() || !ltCoPrior.total.isZero()
    || k1CgTotal.gt(Money.zero()) || !convertedIncome.isZero();

  // The legacy sourced line exists ONLY when Schedule D is inactive. When
  // the sub-DAG runs, the sourced 1099-B net totals fold into Part II below
  // — a parallel legacy line would put the same income on the 1040 twice
  // (and both line ids map to the SAME box on the official PDF).
  const capGainTotal = schdActive
    ? null
    : componentOf(C.CAPITAL_GAIN_NET, C.FED_CAPGAIN_TOTAL, ['FED'], rvFed);

  let schdTotalFact: TaxFact | null = null;
  let schdNcgFact: TaxFact | null = null;
  // Form 1116 line 3e is GROSS income from all sources, so capital LOSSES
  // netted into the Schedule D line must be added back. Captured here where
  // the raw per-term totals exist; consumed in the §904 block far below.
  let schdGrossPositive: Money | null = null;
  if (schdActive) {
    if (!fed.schd) throw new Error('kernel: Schedule D facts present but rule data lacks schedule_d parameters');
    const lotInputs: TaxFact[] = [];
    let stRaw = Money.zero();
    let ltRaw = Money.zero();
    const stSteps: string[] = [];
    const ltSteps: string[] = [];
    for (const lot of lotIds) {
      const get = (field: string) => sumOfConcept(input, `lot.${lot}.${field}`);
      const proceeds = get('proceeds');
      const basis = get('basis');
      const term = get('term'); // 0 = short, 1 = long
      const wash = get('wash_disallowed');
      lotInputs.push(...proceeds.inputs, ...basis.inputs, ...term.inputs, ...wash.inputs);
      let gain = proceeds.total.sub(basis.total);
      let note = `lot.${lot}: ${proceeds.total.toString()} − ${basis.total.toString()} = ${gain.toString()}`;
      if (gain.isNegative() && wash.total.gt(Money.zero())) {
        // §1091: wash-sale loss disallowed — added back, capped at the loss.
        const addback = Money.min(wash.total, gain.neg());
        gain = gain.add(addback);
        note = `${note}; wash-sale disallowed +${addback.toString()} (§1091) → ${gain.toString()}`;
      }
      if (term.total.isZero()) {
        stRaw = stRaw.add(gain);
        stSteps.push(note);
      } else {
        ltRaw = ltRaw.add(gain);
        ltSteps.push(note);
      }
    }
    // K-1 pass-through LT gains land on Sch D line 11 (gains only; see scan).
    if (k1CgTotal.gt(Money.zero())) {
      ltRaw = ltRaw.add(k1CgTotal);
      ltSteps.push(`K-1 pass-through net LT capital gains +${k1CgTotal.toString()} (Sch D line 11)`);
    }
    // Sourced 1099-B net totals (brokerage "total capital gain" lines and
    // manual entries) fold into Part II here whenever the sub-DAG is active
    // — they are net LONG-TERM treatment in the legacy path, and Sch D must
    // carry the WHOLE capital-gain story or the 1040 line 7 undercounts.
    const ltInputs: TaxFact[] = [];
    const stInputs: TaxFact[] = [];
    if (capGainSourced.inputs.length > 0) {
      ltRaw = ltRaw.add(capGainSourced.total);
      ltSteps.push(`sourced capital-gain net totals ${capGainSourced.total.isNegative() ? '' : '+'}${capGainSourced.total.toString()} (1099-B/manual — folded into Part II)`);
      ltInputs.push(...capGainSourced.inputs);
    }
    // Foreign income from the 15CA/15CB path is reported HERE — no US form
    // carries it, so the kernel-converted amount enters the return exactly
    // once: LT portion on Part II, any remainder on Part I (ordinary rates).
    if (!convertedIncome.isZero()) {
      const foreignOrd = convertedIncome.sub(convertedLtcg);
      if (!convertedLtcg.isZero()) {
        ltRaw = ltRaw.add(convertedLtcg);
        ltSteps.push(...fxSteps, `foreign income (15CA/15CB path, converted in-kernel) long-term portion +${convertedLtcg.toString()}`);
        ltInputs.push(...fcyLtcg.inputs, ...fcyIncome.inputs, ...fxRate.inputs);
      }
      if (!foreignOrd.isZero()) {
        stRaw = stRaw.add(foreignOrd);
        stSteps.push(
          ...(convertedLtcg.isZero() ? fxSteps : []),
          `foreign income (15CA/15CB path, converted in-kernel) non-long-term portion +${foreignOrd.toString()} — Part I taxes it at ordinary rates`,
        );
        stInputs.push(...fcyIncome.inputs, ...fxRate.inputs);
      }
    }
    // Prior-year carryovers enter as losses on their term's line.
    const stNet = stRaw.sub(stCoPrior.total);
    const ltNet = ltRaw.sub(ltCoPrior.total);
    if (!stCoPrior.total.isZero()) stSteps.push(`ST carryover from prior year −${stCoPrior.total.toString()}`);
    if (!ltCoPrior.total.isZero()) ltSteps.push(`LT carryover from prior year −${ltCoPrior.total.toString()}`);
    schdGrossPositive = Money.max(Money.zero(), stRaw).add(Money.max(Money.zero(), ltRaw));
    const stNetFact = em.emit({
      concept: C.FED_SCHD_ST_NET, jurisdiction: ['FED'], inputs: [...lotInputs, ...stCoPrior.inputs, ...stInputs],
      formula_ref: 'FED.SCHD.PART1.ST_NET', rule_version: rvFed,
      steps: [...stSteps, `st_net = ${stNet.toString()}`], value: stNet,
    });
    const ltNetFact = em.emit({
      concept: C.FED_SCHD_LT_NET, jurisdiction: ['FED'], inputs: [...lotInputs, ...ltCoPrior.inputs, ...k1CgInputs, ...ltInputs],
      formula_ref: 'FED.SCHD.PART2.LT_NET', rule_version: rvFed,
      steps: [...ltSteps, `lt_net = ${ltNet.toString()}`], value: ltNet,
    });

    const combined = stNetFact.value.add(ltNetFact.value);
    const cap = Money.fromString(fs === 'mfs' ? fed.schd.capital_loss_cap_mfs : fed.schd.capital_loss_cap);
    const schdSteps: string[] = [`combined = st ${stNetFact.value.toString()} + lt ${ltNetFact.value.toString()} = ${combined.toString()}`];
    let line7 = combined;
    if (combined.isNegative()) {
      const totalLoss = combined.neg();
      const allowed = Money.min(cap, totalLoss);
      line7 = allowed.neg();
      schdSteps.push(`loss capped at ${cap.toString()} (§1211(b)${fs === 'mfs' ? ', MFS' : ''}): allowed ${allowed.toString()}`);
      // Carryover worksheet (Pub 550): the allowed loss absorbs ST loss first.
      const stLossAfterLt = Money.max(Money.zero(), stNetFact.value.neg().sub(Money.max(Money.zero(), ltNetFact.value)));
      const stCo = Money.max(Money.zero(), stLossAfterLt.sub(allowed));
      const allowedLeft = Money.max(Money.zero(), allowed.sub(stLossAfterLt));
      const ltLossAfterSt = Money.max(Money.zero(), ltNetFact.value.neg().sub(Money.max(Money.zero(), stNetFact.value)));
      const ltCo = Money.max(Money.zero(), ltLossAfterSt.sub(allowedLeft));
      if (stCo.gt(Money.zero())) {
        em.emit({
          concept: C.CAPLOSS_CO_ST_OUT, jurisdiction: ['FED'], inputs: [stNetFact, ltNetFact],
          formula_ref: 'FED.SCHD.CARRYOVER.ST', rule_version: rvFed,
          steps: [`st_carryover = ${stLossAfterLt.toString()} − allowed(ST-first) ${Money.min(allowed, stLossAfterLt).toString()} = ${stCo.toString()} (year-close writes the capital_loss register)`],
          value: stCo,
        });
      }
      if (ltCo.gt(Money.zero())) {
        em.emit({
          concept: C.CAPLOSS_CO_LT_OUT, jurisdiction: ['FED'], inputs: [stNetFact, ltNetFact],
          formula_ref: 'FED.SCHD.CARRYOVER.LT', rule_version: rvFed,
          steps: [`lt_carryover = ${ltLossAfterSt.toString()} − remaining allowed ${allowedLeft.toString()} = ${ltCo.toString()} (year-close writes the capital_loss register)`],
          value: ltCo,
        });
      }
    }
    schdTotalFact = em.emit({
      concept: C.FED_SCHD_TOTAL, jurisdiction: ['FED'], inputs: [stNetFact, ltNetFact],
      formula_ref: 'FED.SCHD.LINE16.TOTAL', rule_version: rvFed,
      steps: schdSteps, value: line7,
    });
    // 1040 line 7 = Schedule D line 16 — the SAME figure. The form defs map
    // 1040.7 / SCHD.16 / F8949.2h from fed.capital_gain.net.total, which the
    // legacy path emits but this sub-DAG deliberately did not (double-count
    // guard) — so every Schedule D return rendered its forms with line 7
    // MISSING and SCHD.16/F8949.2h flagged as mapping defects. Emit the line
    // as an alias of the Sch D total: derived from it, never summed anywhere
    // (income assembly consumes schdTotalFact, and the legacy component is
    // only emitted when the sub-DAG is inactive).
    em.emit({
      concept: C.FED_CAPGAIN_TOTAL, jurisdiction: ['FED'], inputs: [schdTotalFact],
      formula_ref: 'FED.1040.LINE7.FROM_SCHD', rule_version: rvFed,
      steps: [`1040 line 7 = Schedule D line 16 = ${schdTotalFact.value.toString()} (same figure, emitted so the form line maps without math)`],
      value: schdTotalFact.value,
    });
    // Net capital gain (§1(h)): net LT gain reduced by net ST loss — the
    // preferential amount for the QDCGT worksheet. Never negative.
    const ncg = Money.max(
      Money.zero(),
      Money.max(Money.zero(), ltNetFact.value).sub(Money.max(Money.zero(), stNetFact.value.neg())),
    );
    schdNcgFact = em.emit({
      concept: C.FED_SCHD_NCG, jurisdiction: ['FED'], inputs: [stNetFact, ltNetFact],
      formula_ref: 'FED.SCHD.NET_CAPITAL_GAIN', rule_version: rvFed,
      steps: [`net_capital_gain = max(0, lt⁺ ${Money.max(Money.zero(), ltNetFact.value).toString()} − st_loss ${Money.max(Money.zero(), stNetFact.value.neg()).toString()})`],
      value: ncg,
    });
  }
  // Exactly one path owns the capital-gain line: Sch D when active, the
  // legacy sourced line otherwise — never both (the 1040 has ONE line 7).
  const capGainLineFact = (schdTotalFact ?? capGainTotal)!;
  const ncgForPref = schdNcgFact ? schdNcgFact.value : Money.max(Money.zero(), capGainTotal!.value);

  // ---------- SCHEDULE C (per business entity) + FORM 4562 + SE TAX (P1) ----------
  // Sub-DAG activates only when schc.* facts exist; returns without a
  // business are byte-identical to the pre-P1 kernel.
  const SCHC_RE = /^schc\.([a-z0-9][a-z0-9_-]*)\.(gross_receipts|returns_allowances|cogs|expense\.([a-z_]+))$/;
  const DEP_RE = /^dep\.([a-z0-9][a-z0-9_-]*)\.(basis|sec179|life_years)$/;
  const schcEntities = [...new Set(
    input.facts
      .filter((f) => f.derivation === undefined && f.status === 'confirmed')
      .map((f) => SCHC_RE.exec(f.concept)?.[1])
      .filter((e): e is string => e !== undefined),
  )].sort();

  let schcTotalFact: TaxFact | null = null;
  let seTaxFact: TaxFact | null = null;
  let seDeductionFact: TaxFact | null = null;
  // Sch SE line 6 — carried out for Form 8959 Part II (set only when Sch SE runs).
  let seNetEarnings = Money.zero();
  // IL decoupling inputs (Form IL-4562): federal bonus claimed and the
  // as-if regular MACRS on that bonus basis, accumulated per asset.
  let ilBonusClaimed = Money.zero();
  let ilBonusAsIfMacrs = Money.zero();

  if (schcEntities.length > 0) {
    if (!fed.se || !fed.schc) {
      throw new Error('kernel: schc facts present but rule data lacks self_employment/schedule_c parameters');
    }
    const mealsRate = fed.schc.meals_deductible_rate;

    // ---- Phase A (pure): per-entity core + per-asset pre-§179 depreciation.
    // The §179(b)(3) income limit needs aggregate business income BEFORE
    // §179 (but AFTER bonus/MACRS), so nothing is emitted until phase B.
    interface AssetCore {
      asset: string;
      entity: string;
      basisFacts: TaxFact[];
      basis: Money;
      sec179Requested: Money;
      bonus: Money;
      macrs1: Money;
      life: string;
      steps: string[];
    }
    interface EntityCore {
      entity: string;
      gross: ReturnType<typeof sumOfConcept>;
      returns: ReturnType<typeof sumOfConcept>;
      cogs: ReturnType<typeof sumOfConcept>;
      expenses: Money;
      expenseInputs: TaxFact[];
      expenseSteps: string[];
      miles: ReturnType<typeof sumOfConcept>;
      vehicleValue: Money;
      startup: { value: Money; inputs: TaxFact[]; steps: string[] } | null;
      assets: AssetCore[];
      preSec179: Money;
    }

    // Assets attach to a business via taxpayer_scope = `entity:<id>`.
    const depFacts = input.facts.filter(
      (f) => f.derivation === undefined && f.status === 'confirmed' && DEP_RE.test(f.concept),
    );
    const assetsByEntity = new Map<string, Map<string, TaxFact[]>>();
    for (const f of depFacts) {
      const scope = f.taxpayer_scope;
      if (!scope.startsWith('entity:')) {
        throw new Error(`kernel: dep fact ${f.fact_id} must carry taxpayer_scope entity:<id> (got ${scope})`);
      }
      const entity = scope.slice('entity:'.length);
      const asset = DEP_RE.exec(f.concept)![1]!;
      const byAsset = assetsByEntity.get(entity) ?? new Map<string, TaxFact[]>();
      const list = byAsset.get(asset) ?? [];
      list.push(f);
      byAsset.set(asset, list);
      assetsByEntity.set(entity, byAsset);
    }

    const dep = fed.depreciation;
    const cores: EntityCore[] = schcEntities.map((entity) => {
      const gross = sumOfConcept(input, `schc.${entity}.gross_receipts`);
      const returns = sumOfConcept(input, `schc.${entity}.returns_allowances`);
      const cogs = sumOfConcept(input, `schc.${entity}.cogs`);
      const expenseSteps: string[] = [];
      const expenseInputs: TaxFact[] = [];
      let expenses = Money.zero();
      const expenseFacts = input.facts
        .filter((f) => {
          const m = SCHC_RE.exec(f.concept);
          return f.derivation === undefined && f.status === 'confirmed' && m?.[1] === entity && m?.[3] !== undefined;
        })
        .sort((a, b) => a.concept.localeCompare(b.concept) || a.fact_id.localeCompare(b.fact_id));
      for (const f of expenseFacts) {
        const category = SCHC_RE.exec(f.concept)![3]!;
        const raw = f.value.roundToDollar();
        // IRC §274(n): meals limited BY THE KERNEL — the user never applies it.
        const allowed = category === 'meals' ? raw.mulRate(mealsRate).roundToDollar() : raw;
        expenses = expenses.add(allowed);
        expenseInputs.push(f);
        expenseSteps.push(
          category === 'meals'
            ? `expense.meals: ${raw.toString()} × ${mealsRate} (IRC §274(n)) = ${allowed.toString()}`
            : `expense.${category} += ${allowed.toString()} (${f.fact_id})`,
        );
      }

      const miles = sumOfConcept(input, `schc.${entity}.vehicle.business_miles`);
      const vehicleValue = miles.total.gt(Money.zero())
        ? miles.total.mulRate(fed.schc!.standard_mileage_rate).roundToDollar()
        : Money.zero();

      // IRC §195 (pure part; emission in phase B)
      const startupTotal = sumOfConcept(input, `schc.${entity}.startup_costs_total`);
      let startup: EntityCore['startup'] = null;
      if (startupTotal.total.gt(Money.zero())) {
        const cap = Money.fromString(fed.schc!.startup_expense_cap);
        const threshold = Money.fromString(fed.schc!.startup_phaseout_threshold);
        const reduction = Money.max(Money.zero(), startupTotal.total.sub(threshold));
        const firstYear = Money.max(Money.zero(), Money.min(cap.sub(reduction), startupTotal.total));
        const remainder = startupTotal.total.sub(firstYear);
        const months = sumOfConcept(input, `schc.${entity}.startup_amort_months`);
        const monthsClamped = Money.min(
          Money.max(Money.zero(), months.total),
          Money.fromString(fed.schc!.startup_amortization_months),
        );
        const amort = remainder.isZero()
          ? Money.zero()
          : remainder.mulFraction(monthsClamped.toString(), fed.schc!.startup_amortization_months);
        const startupSteps = [
          ...startupTotal.steps,
          `§195(b): phaseout_reduction = max(0, ${startupTotal.total.toString()} − ${threshold.toString()}) = ${reduction.toString()}`,
          `§195(b): first_year = max(0, min(cap ${cap.toString()} − ${reduction.toString()}, total)) = ${firstYear.toString()}`,
          `§195(b): remainder ${remainder.toString()} amortized ${monthsClamped.toString()}/${fed.schc!.startup_amortization_months} months (clamped to the statutory period) = ${amort.toString()}`,
        ];
        if (!remainder.isZero() && months.total.isZero()) {
          startupSteps.push('no amortization months supplied → 0 amortization this year (Gate 6 flags the missing election data)');
        }
        startup = {
          value: firstYear.add(amort).roundToDollar(),
          inputs: [...startupTotal.inputs, ...months.inputs],
          steps: startupSteps,
        };
      }

      // Per-asset pre-§179 depreciation (Form 4562 basics: year 1, half-year
      // convention): bonus on (basis − §179 requested), MACRS year-1 on the rest.
      const assets: AssetCore[] = [];
      for (const [asset, facts] of [...(assetsByEntity.get(entity) ?? new Map()).entries()].sort()) {
        if (!dep) throw new Error('kernel: dep facts present but rule data lacks depreciation parameters');
        const get = (field: string): { total: Money; inputs: TaxFact[] } => {
          const rows = (facts as TaxFact[]).filter((f) => f.concept === `dep.${asset}.${field}`);
          return { total: Money.sum(rows.map((f) => f.value.roundToDollar())), inputs: rows };
        };
        const basis = get('basis');
        const sec179Req = Money.min(get('sec179').total, basis.total);
        const life = get('life_years').total.toString();
        const table = dep.macrs_hy[life];
        if (!table) throw new Error(`kernel: no MACRS table for ${life}-year property (dep.${asset})`);
        const afterSec179 = basis.total.sub(sec179Req);
        const bonus = afterSec179.mulRate(dep.bonus_rate).roundToDollar();
        const macrs1 = afterSec179.sub(bonus).mulRate(table[0]!).roundToDollar();
        ilBonusClaimed = ilBonusClaimed.add(bonus);
        ilBonusAsIfMacrs = ilBonusAsIfMacrs.add(bonus.mulRate(table[0]!).roundToDollar());
        assets.push({
          asset, entity,
          basisFacts: [...basis.inputs, ...get('sec179').inputs, ...get('life_years').inputs],
          basis: basis.total, sec179Requested: sec179Req, bonus, macrs1, life,
          steps: [
            `basis ${basis.total.toString()}; §179 requested ${sec179Req.toString()}`,
            `bonus = (basis − §179) × ${dep.bonus_rate} (§168(k)) = ${bonus.toString()}`,
            `MACRS yr1 (${life}-yr HY, ${table[0]!}) on remainder = ${macrs1.toString()}`,
          ],
        });
      }

      const otherDep = Money.sum(assets.map((a) => a.bonus.add(a.macrs1)));
      const preSec179 = gross.total.sub(returns.total).sub(cogs.total).sub(expenses).sub(vehicleValue)
        .sub(startup ? startup.value : Money.zero()).sub(otherDep);
      return { entity, gross, returns, cogs, expenses, expenseInputs, expenseSteps, miles, vehicleValue, startup, assets, preSec179 };
    });

    // ---- §179 aggregate limits: dollar cap (with §179(b)(2) phase-out on
    // total §179 property placed in service) and the §179(b)(3) income limit
    // (aggregate active business income before §179 — W-2 wages count for
    // individuals, Reg. §1.179-2(c)(6)(iv)).
    const allAssets = cores.flatMap((c) => c.assets);
    const sec179Requested = Money.sum(allAssets.map((a) => a.sec179Requested));
    let sec179Allowed = Money.zero();
    const sec179Steps: string[] = [];
    if (dep && sec179Requested.gt(Money.zero())) {
      const propertyPlaced = Money.sum(allAssets.map((a) => a.basis));
      const capReduction = Money.max(Money.zero(), propertyPlaced.sub(Money.fromString(dep.sec179_phaseout_threshold)));
      const dollarCap = Money.max(Money.zero(), Money.fromString(dep.sec179_cap).sub(capReduction));
      const incomeLimit = Money.max(Money.zero(), Money.sum(cores.map((c) => c.preSec179)).add(wagesTotal.value));
      sec179Allowed = Money.min(Money.min(sec179Requested, dollarCap), incomeLimit).roundToDollar();
      sec179Steps.push(
        `§179 requested ${sec179Requested.toString()}; dollar cap ${dollarCap.toString()} (§179(b)(1)-(2), property placed ${propertyPlaced.toString()})`,
        `income limit ${incomeLimit.toString()} (§179(b)(3): business income before §179 + W-2 wages)`,
        `§179 allowed = ${sec179Allowed.toString()}`,
      );
    }

    // ---- Phase B: emit per-asset and per-entity facts.
    const perEntity: TaxFact[] = [];
    for (const core of cores) {
      const { entity } = core;
      const steps: string[] = [...core.gross.steps, ...core.returns.steps, ...core.cogs.steps, ...core.expenseSteps];

      let vehicleFact: TaxFact | null = null;
      if (core.miles.total.gt(Money.zero())) {
        vehicleFact = em.emit({
          concept: `schc.${entity}.vehicle.deduction`,
          jurisdiction: ['FED'],
          inputs: core.miles.inputs,
          formula_ref: 'FED.SCHC.LINE9.STANDARD_MILEAGE',
          rule_version: rvFed,
          steps: [
            `vehicle = ${core.miles.total.toString()} business miles × ${fed.schc!.standard_mileage_rate}/mile (annual IRS notice; contemporaneous mileage log required — Gate 5)`,
          ],
          value: core.vehicleValue,
        });
        steps.push(`vehicle (standard mileage) = ${vehicleFact.value.toString()}`);
      }

      let startupFact: TaxFact | null = null;
      if (core.startup) {
        startupFact = em.emit({
          concept: `schc.${entity}.startup_deduction`,
          jurisdiction: ['FED'],
          inputs: core.startup.inputs,
          formula_ref: 'FED.SCHC.SEC195.STARTUP',
          rule_version: rvFed,
          steps: core.startup.steps,
          value: core.startup.value,
        });
        steps.push(`§195 startup deduction = ${startupFact.value.toString()}`);
      }

      // Per-asset current-year deduction: pro-rata §179 + bonus + MACRS yr 1.
      // §179 allocation uses CUMULATIVE rounding (alloc_i = round(cum_i) −
      // round(cum_{i−1}) over the global sorted asset order) so allocations
      // sum exactly to the allowed total under ANY grouping — the kernel's
      // per-asset and kernel2's per-entity views agree to the dollar.
      const assetFacts: TaxFact[] = [];
      let entityDep = Money.zero();
      for (const a of core.assets) {
        const alloc = sec179Requested.isZero()
          ? Money.zero()
          : (() => {
              const before = allAssets.slice(0, allAssets.indexOf(a));
              const upTo = (list: readonly AssetCore[]): Money =>
                sec179Allowed
                  .mulFraction(
                    Money.sum(list.map((x) => x.sec179Requested)).toString(),
                    sec179Requested.toString(),
                  )
                  .roundToDollar();
              return upTo([...before, a]).sub(upTo(before));
            })();
        const current = alloc.add(a.bonus).add(a.macrs1);
        const f = em.emit({
          concept: `dep.${a.asset}.deduction_current`,
          jurisdiction: ['FED'],
          inputs: a.basisFacts,
          formula_ref: 'FED.F4562.CURRENT_YEAR',
          rule_version: rvFed,
          steps: [...a.steps, ...sec179Steps, `§179 allocated to ${a.asset} = ${alloc.toString()} (pro-rata by request)`, `deduction_current = ${current.toString()}`],
          value: current,
          taxpayer_scope: `entity:${entity}`,
        });
        assetFacts.push(f);
        entityDep = entityDep.add(f.value);
      }
      if (!entityDep.isZero()) steps.push(`depreciation (Form 4562) = ${entityDep.toString()}`);

      const startupDed = startupFact ? startupFact.value : Money.zero();
      // Tentative profit BEFORE Form 8829 — the §280A(c)(5) gross-income limit.
      const tentative = core.gross.total.sub(core.returns.total).sub(core.cogs.total).sub(core.expenses)
        .sub(core.vehicleValue).sub(startupDed).sub(entityDep);
      steps.push(
        `tentative_profit = ${core.gross.total.toString()} − returns ${core.returns.total.toString()} − cogs ${core.cogs.total.toString()} − expenses ${core.expenses.toString()} − vehicle ${core.vehicleValue.toString()} − startup ${startupDed.toString()} − depreciation ${entityDep.toString()} = ${tentative.toString()}`,
      );

      // Form 8829: the kernel computes BOTH methods and applies the greater
      // allowed deduction (the simplified-method election is annual, Rev.
      // Proc. 2013-13). The gross-income limitation caps either method; only
      // the ACTUAL method generates a carryover (§280A(c)(5)); under a
      // simplified year, prior actual carryover rolls forward untouched.
      const hoSqFt = sumOfConcept(input, `schc.${entity}.homeoffice.sq_ft`);
      let hoFact: TaxFact | null = null;
      if (hoSqFt.total.gt(Money.zero())) {
        const hoRate = fed.schc!.homeoffice_simplified_rate;
        const hoCap = Money.fromString(fed.schc!.homeoffice_simplified_sqft_cap);
        const limit = Money.max(Money.zero(), tentative);
        const simplifiedRaw = Money.min(hoSqFt.total, hoCap).mulRate(hoRate);
        const homeSqFt = sumOfConcept(input, `schc.${entity}.homeoffice.home_sq_ft`);
        const homeExpenses = sumOfConcept(input, `schc.${entity}.homeoffice.home_expenses_total`);
        const carryPrior = sumOfConcept(input, `schc.${entity}.homeoffice.carryover_prior`);
        const businessShare = homeSqFt.total.isZero()
          ? Money.zero()
          : homeExpenses.total.mulFraction(hoSqFt.total.toString(), homeSqFt.total.toString());
        const actualRaw = businessShare.add(carryPrior.total).roundToDollar();
        const simplifiedAllowed = Money.min(simplifiedRaw, limit).roundToDollar();
        const actualAllowed = Money.min(actualRaw, limit).roundToDollar();
        const useActual = actualAllowed.gte(simplifiedAllowed);
        const hoDeduction = useActual ? actualAllowed : simplifiedAllowed;
        const carryOut = useActual
          ? Money.max(Money.zero(), actualRaw.sub(actualAllowed))
          : carryPrior.total.roundToDollar();
        hoFact = em.emit({
          concept: `schc.${entity}.homeoffice.deduction`,
          jurisdiction: ['FED'],
          inputs: [...hoSqFt.inputs, ...homeSqFt.inputs, ...homeExpenses.inputs, ...carryPrior.inputs],
          formula_ref: 'FED.F8829.HOME_OFFICE',
          rule_version: rvFed,
          steps: [
            `simplified = min(${hoSqFt.total.toString()} sq ft, cap ${hoCap.toString()}) × ${hoRate} = ${simplifiedRaw.toString()} (Rev. Proc. 2013-13)`,
            `actual = home_expenses ${homeExpenses.total.toString()} × ${hoSqFt.total.toString()}/${homeSqFt.total.toString()} + prior carryover ${carryPrior.total.toString()} = ${actualRaw.toString()}`,
            `gross-income limit = max(0, tentative ${tentative.toString()}) = ${limit.toString()} (§280A(c)(5))`,
            `method = ${useActual ? 'actual' : 'simplified'} (greater allowed deduction; the election is annual)`,
          ],
          value: hoDeduction,
        });
        if (carryOut.gt(Money.zero())) {
          em.emit({
            concept: `schc.${entity}.homeoffice.carryover_out`,
            jurisdiction: ['FED'],
            inputs: [hoFact],
            formula_ref: 'FED.F8829.CARRYOVER',
            rule_version: rvFed,
            steps: [
              useActual
                ? `carryover_out = actual ${actualRaw.toString()} − allowed ${actualAllowed.toString()} = ${carryOut.toString()} (§280A(c)(5); year-close writes the home_office_carryover register)`
                : `simplified elected this year → prior actual carryover ${carryOut.toString()} rolls forward untouched`,
            ],
            value: carryOut,
          });
        }
      }
      const hoDed = hoFact ? hoFact.value : Money.zero();
      const net = tentative.sub(hoDed);
      steps.push(`net_profit = tentative ${tentative.toString()} − home_office ${hoDed.toString()} = ${net.toString()}`);
      perEntity.push(
        em.emit({
          concept: `schc.${entity}.net_profit`,
          jurisdiction: ['FED', 'IL'],
          inputs: [...core.gross.inputs, ...core.returns.inputs, ...core.cogs.inputs, ...core.expenseInputs,
                   ...(vehicleFact ? [vehicleFact] : []), ...(startupFact ? [startupFact] : []),
                   ...assetFacts, ...(hoFact ? [hoFact] : [])],
          formula_ref: 'FED.SCHC.NET_PROFIT',
          rule_version: rvFed,
          steps,
          value: net,
        }),
      );
    }

    // §179 carryforward (§179(b)(3)(B)): requested beyond allowed rolls to
    // next year (year-close writes the register).
    if (sec179Requested.gt(sec179Allowed)) {
      em.emit({
        concept: 'fed.sec179.carryforward',
        jurisdiction: ['FED'],
        inputs: [],
        formula_ref: 'FED.F4562.SEC179.CARRYFORWARD',
        rule_version: rvFed,
        steps: [...sec179Steps, `carryforward = ${sec179Requested.toString()} − ${sec179Allowed.toString()} = ${sec179Requested.sub(sec179Allowed).toString()}`],
        value: sec179Requested.sub(sec179Allowed),
      });
    }

    schcTotalFact = em.emit({
      concept: C.FED_SCHC_NET_PROFIT_TOTAL,
      jurisdiction: ['FED'],
      inputs: perEntity,
      formula_ref: 'FED.SCH1.LINE3.SCHC_TOTAL',
      rule_version: rvFed,
      steps: perEntity.map((f) => `schc_total += ${f.value.toString()} (${f.concept})`),
      value: Money.sum(perEntity.map((f) => f.value)),
    });

    // Sch SE (only on positive combined net profit; no SE loss carrybacks here)
    if (schcTotalFact.value.gt(Money.zero())) {
      const netEarnings = schcTotalFact.value.mulRate(fed.se.net_earnings_factor).roundToDollar();
      const seFloor = Money.fromString(fed.se.se_tax_floor);
      if (netEarnings.lt(seFloor)) {
        // §6017: net earnings under the floor owe no SE tax (and no deduction).
      } else {
      const ssWages = sumOfConcept(input, C.WAGES_SS);
      const wageBase = Money.fromString(fed.se.ss_wage_base);
      const ssRoom = Money.max(Money.zero(), wageBase.sub(ssWages.total));
      const ssPortionBase = Money.min(netEarnings, ssRoom);
      const ssTax = ssPortionBase.mulRate(fed.se.ss_rate);
      const medicareTax = netEarnings.mulRate(fed.se.medicare_rate);
      seNetEarnings = netEarnings;
      seTaxFact = em.emit({
        concept: C.FED_SE_TAX,
        jurisdiction: ['FED'],
        inputs: [schcTotalFact, ...ssWages.inputs],
        formula_ref: 'FED.SCHSE.SE_TAX',
        rule_version: rvFed,
        steps: [
          `net_earnings = ${schcTotalFact.value.toString()} × ${fed.se.net_earnings_factor} = ${netEarnings.toString()} (Sch SE 4a)`,
          `ss_base = min(net_earnings, wage_base ${wageBase.toString()} − W-2 SS wages ${ssWages.total.toString()}) = ${ssPortionBase.toString()}`,
          `ss_tax = ${ssPortionBase.toString()} × ${fed.se.ss_rate} = ${ssTax.toString()}`,
          `medicare_tax = ${netEarnings.toString()} × ${fed.se.medicare_rate} = ${medicareTax.toString()}`,
          `se_tax = ss_tax + medicare_tax (the Additional Medicare 0.9% rides on Form 8959, not Sch SE)`,
        ],
        value: ssTax.add(medicareTax),
      });
      seDeductionFact = em.emit({
        concept: C.FED_SE_DEDUCTION,
        jurisdiction: ['FED'],
        inputs: [seTaxFact],
        formula_ref: 'FED.SCHSE.LINE13.HALF_SE_TAX',
        rule_version: rvFed,
        steps: [`se_deduction = ${seTaxFact.value.toString()} × 0.5 (Sch SE line 13)`],
        value: seTaxFact.value.mulRate('0.5'),
      });
      }
    }
  }

  // ---------- SCHEDULE E p.2 — INBOUND K-1s (P3) ----------
  // Loss-limitation ORDERING (REQUIREMENTS §2B): basis first (§704(d) /
  // §1366(d) incl. 7203 debt basis), then passive (§469 / 8582). At-risk
  // (§465) is treated as equal to basis in this slice (gap: differs under
  // nonrecourse financing); §461(l) excess-business-loss is a recorded gap.
  const K1_RE = /^k1\.([a-z0-9][a-z0-9_-]*)\.(box1|box2|is_scorp|material_participation|basis_opening|debt_basis_opening|contributions|distributions|liab_change|capital_gain|passive_carryover|qbi_eligible|qbi_amount|guaranteed_payment|disposed_entire_interest)$/;
  const k1Ids = [...new Set(
    input.facts
      .filter((f) => f.derivation === undefined && f.status === 'confirmed')
      .map((f) => K1_RE.exec(f.concept)?.[1])
      .filter((x): x is string => x !== undefined),
  )].sort();

  let scheK1Fact: TaxFact | null = null;
  let f4797TotalFact: TaxFact | null = null;
  let k1QbiNet = Money.zero(); // allowed net K-1 amounts (QBI component)
  // Form 8960 line 4a: passive activities' ordinary net (income − allowed
  // losses, EXCLUDING the capital-gain component (picked up via Sch D/5a)
  // and guaranteed payments (compensation, not investment income)).
  let k1NiitPassiveNet = Money.zero();
  if (k1Ids.length > 0) {
    interface K1Core {
      id: string; inputs: TaxFact[]; passive: boolean; scorp: boolean; qbiEligible: boolean;
      /** §199A amount AS REPORTED on the K-1 statement (1120-S box 17 code V /
       *  1065 box 20 code Z) when supplied — it legitimately differs from box 1
       *  (health insurance, §179, W-2 wage adjustments). Overrides the derived
       *  QBI for this entity. */
      qbiReported: Money | null;
      rentalActive: boolean;
      posIncome: Money; capGain: Money; gp: Money; loss: Money; basisAllowed: Money;
      suspendedBasis: Money; lossPool: Money; heldCarry: Money; steps: string[];
      /** §469(g): the entire interest was disposed of in a fully taxable
       *  transaction this year, releasing every suspended loss. */
      disposed: boolean;
      /** Share of `loss` attributable to the Form 4797 stream (P41). */
      loss4797: Money;
      /** Positive Form 4797 ordinary gain (income stream, Sch 1 line 4). */
      pos4797: Money;
    }
    const cores: K1Core[] = k1Ids.map((id) => {
      const g = (field: string) => sumOfConcept(input, `k1.${id}.${field}`);
      const box1 = g('box1');
      const box2 = g('box2');
      const scorp = !g('is_scorp').total.isZero();
      const passive = g('material_participation').total.isZero();
      // P41 — Form 4797 ordinary gain/(loss) passed through on the K-1
      // (property dispositions). It rides the SAME basis and §469 limits as
      // the box-1 stream, but reports on Sch 1 line 4, not Sch E — so the
      // loss components are tracked separately for the final split.
      const steps0: string[] = [];
      const f4797 = g('f4797');
      // P41 — §469(i): rental real estate with ACTIVE participation. Only
      // meaningful on a passive activity (material participation makes the
      // whole activity nonpassive and unlimited anyway).
      const rentalActiveRaw = !g('rental_active').total.isZero();
      const rentalActive = passive && rentalActiveRaw;
      const income = box1.total.add(box2.total).add(f4797.total);
      const posIncome = Money.max(Money.zero(), income);
      const loss = Money.max(Money.zero(), income.neg());
      // Loss split for reporting: when both streams lose, each keeps its own
      // magnitude; when one gains it offsets the other (net characterized by
      // the losing stream). Simplification recorded in the trail.
      const loss4797 = loss.isZero()
        ? Money.zero()
        : Money.min(loss, Money.max(Money.zero(), f4797.total.neg()));
      const pos4797 = Money.max(Money.zero(), f4797.total);
      if (!f4797.total.isZero()) {
        steps0.push(`Form 4797 stream ${f4797.total.toString()} joins the basis/§469 limits; reports on Sch 1 line 4, not Sch E`);
      }
      if (rentalActiveRaw && !passive) {
        steps0.push('rental_active set on a NONPASSIVE activity — ignored (material participation already frees the loss)');
      }
      const contributions = g('contributions');
      const distributions = g('distributions');
      const liabChange = scorp ? { total: Money.zero(), inputs: [], steps: [] } : g('liab_change');
      const opening = g('basis_opening');
      // K-1 net LT capital gain: on Sch D via the D sub-DAG; here it raises
      // basis (7203 line 3g / §705(a)(1)) and, when the activity is passive,
      // counts as passive income on Form 8582. Gains only (see the D scan).
      const cgRaw = k1CgById.get(id) ?? Money.zero();
      const capGain = Money.max(Money.zero(), cgRaw);
      const cgFacts = k1CgInputs.filter((f) => f.concept === `k1.${id}.capital_gain`);
      const steps: string[] = [
        `k1.${id}: box1 ${box1.total.toString()} + box2 ${box2.total.toString()} + f4797 ${f4797.total.toString()} → ${income.toString()} (${scorp ? 'S-corp' : 'partnership'}, ${passive ? `passive${rentalActive ? ', rental w/ active participation' : ''}` : 'nonpassive'})`,
        ...steps0,
      ];
      if (cgRaw.isNegative()) {
        steps.push(`net capital LOSS ${cgRaw.toString()} on the K-1 NOT modeled (recorded gap — needs character tracking through the loss limits); treated as 0`);
      } else if (capGain.gt(Money.zero())) {
        steps.push(`net LT capital gain ${capGain.toString()} → Sch D line 11; raises basis (${scorp ? '7203 line 3g' : '§705(a)(1)'})${passive ? '; passive income on 8582' : ''}`);
      }
      // Basis before losses: opening + contributions (+ §752 liability-share
      // change for partnerships) + current income (incl. capital gain) −
      // distributions. A negative result means distributions exceeded basis —
      // excess-distribution GAIN is a recorded gap; the kernel clamps and says so.
      const basisBeforeLoss = opening.total.add(contributions.total).add(liabChange.total)
        .add(posIncome).add(capGain).sub(distributions.total);
      steps.push(
        `basis before losses = opening ${opening.total.toString()} + contrib ${contributions.total.toString()} + §752 Δliab ${liabChange.total.toString()} + income ${posIncome.toString()} + cap gain ${capGain.toString()} − distrib ${distributions.total.toString()} = ${basisBeforeLoss.toString()}`,
      );
      if (basisBeforeLoss.isNegative()) {
        steps.push('distributions exceed basis — excess-distribution gain NOT modeled (recorded gap); basis clamped to 0');
      }
      const stockAvail = Money.max(Money.zero(), basisBeforeLoss);
      const stockUsed = Money.min(loss, stockAvail);
      const debtOpening = scorp ? g('debt_basis_opening').total : Money.zero();
      const debtUsed = scorp ? Money.min(loss.sub(stockUsed), debtOpening) : Money.zero();
      const basisAllowed = stockUsed.add(debtUsed);
      const suspendedBasis = loss.sub(basisAllowed);
      if (loss.gt(Money.zero())) {
        const debtNote = scorp ? `, 7203 debt basis absorbs ${debtUsed.toString()} (of ${debtOpening.toString()})` : '';
        steps.push(
          `loss ${loss.toString()}: stock/outside basis absorbs ${stockUsed.toString()}${debtNote} → allowed ${basisAllowed.toString()}, suspended ${suspendedBasis.toString()}`,
        );
      }
      // Prior-year unallowed passive loss (8582 worksheet col (c), from the
      // passive_loss register / a supported manual opening). Already survived
      // basis in the year it arose — it enters the passive pool directly.
      // §469(g)(1): disposing of the ENTIRE interest in a fully taxable
      // transaction frees this activity's suspended losses outright. The
      // §469(g)(1)(B) related-party bar is fact-specific and stays the filer's
      // attestation — the flag asserts a QUALIFYING disposition.
      const disposedRaw = g('disposed_entire_interest');
      const disposed = disposedRaw.inputs.length > 0 && !disposedRaw.total.isZero();
      const carryRaw = g('passive_carryover');
      let carryPrior = Money.zero();
      let heldCarry = Money.zero();
      if (carryRaw.total.gt(Money.zero())) {
        if (passive) {
          carryPrior = carryRaw.total.roundToDollar();
          steps.push(`prior-year unallowed passive loss ${carryPrior.toString()} joins the 8582 loss pool (not re-limited by basis)`);
        } else {
          heldCarry = carryRaw.total.roundToDollar();
          steps.push(`prior-year unallowed passive loss ${heldCarry.toString()} carried on a NONPASSIVE activity — releasable under §469(f)(1)(A) against this activity's own income, or in full under §469(g) on disposition`);
        }
      }
      // Guaranteed payments (K-1 box 4, partnerships only): ordinary income
      // to the recipient regardless of basis or passivity — GPs are
      // compensation for services/capital use, not a distributive share.
      // SE tax on GPs / §1402(a) partner SE earnings is a recorded gap.
      const gpRaw = g('guaranteed_payment');
      let gp = Money.zero();
      if (!gpRaw.total.isZero()) {
        if (scorp) {
          steps.push(`guaranteed_payment ${gpRaw.total.toString()} on an S-CORP K-1 ignored (1065-only concept — fix the intake data)`);
        } else if (gpRaw.total.isNegative()) {
          steps.push(`negative guaranteed_payment ${gpRaw.total.toString()} invalid — treated as 0 (recorded in trail)`);
        } else {
          gp = gpRaw.total.roundToDollar();
          steps.push(`guaranteed payment ${gp.toString()} — ordinary income outside the basis/passive limits (SE-tax treatment is a recorded gap)`);
        }
      }
      const qe = g('qbi_eligible');
      const qbiEligible = qe.inputs.length === 0 || !qe.total.isZero();
      const qa = g('qbi_amount');
      const qbiReported = qa.inputs.length > 0 ? qa.total.roundToDollar() : null;
      if (qbiReported !== null) {
        steps.push(`§199A amount as reported on the K-1 statement = ${qbiReported.toString()} (used instead of the box-1-derived QBI, which it may legitimately differ from — health insurance, §179, W-2 wage adjustments)`);
      }
      return {
        id, passive, scorp, qbiEligible, qbiReported, rentalActive, posIncome, capGain, gp, loss, basisAllowed,
        suspendedBasis, lossPool: basisAllowed.add(carryPrior), heldCarry, disposed, steps, loss4797, pos4797,
        inputs: [...box1.inputs, ...box2.inputs, ...f4797.inputs, ...opening.inputs, ...contributions.inputs,
                 ...distributions.inputs, ...liabChange.inputs, ...cgFacts, ...carryRaw.inputs,
                 ...qe.inputs, ...qa.inputs, ...gpRaw.inputs, ...disposedRaw.inputs, ...g('rental_active').inputs],
      };
    });

    // §469 / Form 8582 activity model (no §469(i) $25k rental allowance in
    // this slice — recorded gap). Aggregate: losses (current basis-allowed +
    // prior unallowed) are deductible up to aggregate passive income.
    const passives = cores.filter((c) => c.passive);
    const activityIncome = (c: K1Core): Money => c.posIncome.add(c.capGain);
    const passiveIncome = Money.sum(passives.map(activityIncome));
    const passiveLossPool = Money.sum(passives.map((c) => c.lossPool));
    const passiveAllowed = Money.min(passiveLossPool, passiveIncome);
    const passiveSuspendedTotal = passiveLossPool.sub(passiveAllowed);

    // 8582 Part VII: the unallowed total is borne ONLY by activities with an
    // OVERALL loss (income − losses < 0), pro-rata by overall loss, with
    // cumulative rounding (grouping-invariant — same scheme as §179).
    // Activities with an overall gain deduct all their losses.
    const overallLossOf = (c: K1Core): Money => Money.max(Money.zero(), c.lossPool.sub(activityIncome(c)));
    const losers = passives.filter((c) => overallLossOf(c).gt(Money.zero()));
    const overallLossTotal = Money.sum(losers.map(overallLossOf));
    const suspendedBy = new Map<string, Money>();
    if (passiveSuspendedTotal.gt(Money.zero()) && overallLossTotal.gt(Money.zero())) {
      const upTo = (list: readonly K1Core[]): Money =>
        passiveSuspendedTotal
          .mulFraction(Money.sum(list.map(overallLossOf)).toString(), overallLossTotal.toString())
          .roundToDollar();
      losers.forEach((c) => {
        const before = losers.slice(0, losers.indexOf(c));
        suspendedBy.set(c.id, upTo([...before, c]).sub(upTo(before)));
      });
    }

    // P41 — §469(i): up to $25,000 of RENTAL-real-estate-with-active-
    // participation loss deducts against nonpassive income even with no
    // passive income, phased out 50¢ per dollar of MAGI over $100,000 (all
    // parameters rule-data). MAGI per the 8582 instructions = income figured
    // WITHOUT passive items — assembled here from the modeled nonpassive
    // components. Applied AFTER the Part VII allocation: it frees suspended
    // loss on rental-active activities only, pro-rata, cumulative rounding.
    let sec469iAllowance = Money.zero();
    const rentalCores = losers.filter((c) => c.rentalActive);
    const rentalSuspTotal = Money.sum(rentalCores.map((c) => suspendedBy.get(c.id) ?? Money.zero()));
    if (rentalSuspTotal.gt(Money.zero())) {
      if (!fed.sec469i) {
        throw new Error('kernel: a rental-with-active-participation K-1 loss is present but rule data lacks sec469i parameters');
      }
      const nonpassiveK1Net = Money.sum(
        cores.filter((c) => !c.passive).map((c) => c.posIncome.add(c.gp).sub(c.basisAllowed)),
      );
      const magi = sumOfConcept(input, 'income.wages').total
        .add(sumOfConcept(input, 'income.interest').total)
        .add(sumOfConcept(input, 'income.dividends.ordinary').total)
        .add(sumOfConcept(input, 'income.retirement').total)
        .add(schdTotalFact ? schdTotalFact.value : Money.zero())
        .add(schcTotalFact ? schcTotalFact.value : Money.zero())
        .add(nonpassiveK1Net)
        .roundToDollar();
      const cap = fs === 'mfs' ? Money.zero() : Money.fromString(fed.sec469i.allowance);
      const excess = Money.max(Money.zero(), magi.sub(Money.fromString(fed.sec469i.phaseout_start)));
      const phased = Money.max(Money.zero(), cap.sub(excess.mulRate(fed.sec469i.phaseout_rate))).roundToDollar();
      sec469iAllowance = Money.min(phased, rentalSuspTotal);
      const allowanceSteps = [
        `§469(i): rental-active suspended losses ${rentalSuspTotal.toString()}; MAGI (income w/o passive items) = ${magi.toString()}`,
        `allowance = max(0, ${cap.toString()} − ${fed.sec469i.phaseout_rate} × max(0, MAGI − ${fed.sec469i.phaseout_start})) = ${phased.toString()}${fs === 'mfs' ? ' (MFS: allowance 0 — living-apart election not modeled)' : ''}`,
        `special allowance used = min(${phased.toString()}, ${rentalSuspTotal.toString()}) = ${sec469iAllowance.toString()}`,
      ];
      // Free the allowance from rental-active activities pro-rata (cumulative
      // rounding — grouping-invariant, same scheme as Part VII above).
      if (sec469iAllowance.gt(Money.zero())) {
        const freedUpTo = (list: readonly K1Core[]): Money =>
          sec469iAllowance
            .mulFraction(
              Money.sum(list.map((c) => suspendedBy.get(c.id) ?? Money.zero())).toString(),
              rentalSuspTotal.toString(),
            )
            .roundToDollar();
        rentalCores.forEach((c) => {
          const before = rentalCores.slice(0, rentalCores.indexOf(c));
          const freed = freedUpTo([...before, c]).sub(freedUpTo(before));
          suspendedBy.set(c.id, (suspendedBy.get(c.id) ?? Money.zero()).sub(freed));
          c.steps.push(`§469(i): ${freed.toString()} of this rental's suspended loss FREED by the special allowance`);
        });
      }
      em.emit({
        concept: C.FED_F8582_ALLOWANCE, jurisdiction: ['FED'],
        inputs: rentalCores.flatMap((c) => c.inputs),
        formula_ref: 'FED.F8582.PART2', rule_version: rvFed,
        steps: allowanceSteps, value: sec469iAllowance,
      });
    }

    const perK1: TaxFact[] = [];
    let f4797Total = Money.zero();
    const f4797Inputs: TaxFact[] = [];
    for (const c of cores) {
      let passiveSusp = suspendedBy.get(c.id) ?? Money.zero();
      // §469(g)(1): the disposed activity stays IN the 8582 netting above (its
      // loss offsets other activities' passive income in the statutory order),
      // but whatever the pool could not absorb is RELEASED here rather than
      // carried. Other activities' shares are untouched.
      let releasedOnDisposition = Money.zero();
      if (c.disposed && passiveSusp.gt(Money.zero())) {
        releasedOnDisposition = passiveSusp;
        passiveSusp = Money.zero();
      }
      // A nonpassive activity's held carryover releases under §469(f)(1)(A)
      // only against THIS activity's own income — or in full on a §469(g)
      // disposition. A nonpassive activity running a loss releases nothing.
      let releasedHeld = Money.zero();
      if (c.heldCarry.gt(Money.zero())) {
        releasedHeld = c.disposed ? c.heldCarry : Money.min(c.heldCarry, c.posIncome);
      }
      const lossDeducted = (c.passive ? c.lossPool : c.basisAllowed).sub(passiveSusp);
      // P41 — split the ALLOWED loss between the Sch E stream and the Form
      // 4797 stream pro-rata by their loss shares (the CPA-workpaper ratio
      // method); positive 4797 amounts are income on Sch 1 line 4 directly.
      let allowed4797Loss = Money.zero();
      if (c.loss4797.gt(Money.zero()) && c.loss.gt(Money.zero()) && lossDeducted.gt(Money.zero())) {
        allowed4797Loss = lossDeducted
          .mulFraction(c.loss4797.toString(), c.loss.toString())
          .roundToDollar();
      }
      const activity4797 = c.pos4797.sub(allowed4797Loss);
      const net = c.posIncome.sub(c.pos4797).add(c.gp).sub(lossDeducted.sub(allowed4797Loss)).sub(releasedHeld);
      const steps = [...c.steps];
      if (releasedOnDisposition.gt(Money.zero())) {
        steps.push(`§469(g)(1): entire interest disposed of in a fully taxable transaction — ${releasedOnDisposition.toString()} the 8582 pool could not absorb is RELEASED and allowed in full (SIMPLIFIED: the §469(g)(1)(A) ordering against disposition gain, then other passive income, then nonpassive income is not itemised; the §469(g)(1)(B) related-party bar is the filer's attestation)`);
      }
      if (releasedHeld.gt(Money.zero())) {
        steps.push(
          c.disposed
            ? `§469(g)(1): held carryover ${releasedHeld.toString()} RELEASED in full on the disposition`
            : `§469(f)(1)(A): ${releasedHeld.toString()} of the ${c.heldCarry.toString()} held carryover released against this activity's own income ${c.posIncome.toString()} — the rest stays suspended`,
        );
      }
      if (c.passive && passiveSusp.gt(Money.zero())) {
        steps.push(`§469: ${passiveSusp.toString()} of the ${c.lossPool.toString()} loss pool suspended (8582 Part VII — overall-loss activities bear the unallowed ${passiveSuspendedTotal.toString()} of pool ${passiveLossPool.toString()} vs passive income ${passiveIncome.toString()})`);
      }
      if (!c.qbiEligible) {
        steps.push('excluded from QBI (qbi_eligible = 0 — the K-1 reports no §199A items)');
      }
      steps.push(`allowed_net = ${net.toString()}`);
      const f = em.emit({
        concept: `k1.${c.id}.allowed_net`, jurisdiction: ['FED', 'IL'], inputs: c.inputs,
        formula_ref: 'FED.SCHE.P2.K1_ALLOWED', rule_version: rvFed, steps, value: net,
      });
      perK1.push(f);
      if (!activity4797.isZero() || c.loss4797.gt(Money.zero()) || !c.pos4797.isZero()) {
        const f4797Fact = em.emit({
          concept: `k1.${c.id}.allowed_4797`, jurisdiction: ['FED'], inputs: c.inputs,
          formula_ref: 'FED.F4797.K1_ALLOWED', rule_version: rvFed,
          steps: [`allowed Form 4797 stream = income ${c.pos4797.toString()} − allowed loss share ${allowed4797Loss.toString()} = ${activity4797.toString()} (pro-rata of the activity's allowed loss)`],
          value: activity4797,
        });
        f4797Total = f4797Total.add(activity4797);
        f4797Inputs.push(f4797Fact);
      }
      // §199A(c)(4)(B): guaranteed payments are never QBI — the QBI
      // contribution is the allowed net EXCLUDING the GP component.
      // P41 — QBI includes the 4797 ordinary stream (it is business income;
      // only the REPORTING line differs), still excluding GPs (§199A(c)(4)(B)).
      if (c.qbiEligible) {
        // A reported §199A amount wins over the box-1 derivation — but it is
        // the ENTITY-level figure, computed before this owner's basis/§469
        // limits. Reg. §1.199A-3(b)(1)(iv) counts items only "to the extent
        // included or allowed in determining taxable income", and counts a
        // prior-year loss in the year it is ALLOWED. So when this activity has
        // any suspension or release in play the reported figure is the wrong
        // number and we REFUSE it rather than silently over- or under-claiming.
        const suspensionInPlay =
          c.suspendedBasis.gt(Money.zero()) || passiveSusp.gt(Money.zero()) || c.heldCarry.gt(Money.zero());
        if (c.qbiReported !== null && suspensionInPlay) {
          throw new Error(
            `kernel: k1.${c.id}.qbi_amount was supplied, but this activity has a basis/§469 suspension or a released carryover, so the entity-level §199A figure is not this owner's QBI (Reg. §1.199A-3(b)(1)(iv)). Remove the override and let the kernel derive it, or supply an owner-level amount.`,
          );
        }
        k1QbiNet = k1QbiNet.add(c.qbiReported !== null ? c.qbiReported : f.value.add(activity4797).sub(c.gp));
      }
      // §1411: passive ordinary net feeds Form 8960 line 4a (capital gain
      // rides Sch D → line 5a; GP is compensation, never investment income).
      if (c.passive) k1NiitPassiveNet = k1NiitPassiveNet.add(c.posIncome.sub(lossDeducted));
      if (c.suspendedBasis.gt(Money.zero())) {
        em.emit({
          concept: `k1.${c.id}.basis_suspended.out`, jurisdiction: ['FED'], inputs: [f],
          formula_ref: c.scorp ? 'FED.F7203.SUSPENDED' : 'FED.SEC704D.SUSPENDED', rule_version: rvFed,
          steps: [`basis-limited loss ${c.suspendedBasis.toString()} carries forward (${c.scorp ? '§1366(d)/7203' : '§704(d)'}; year-close writes the basis register)`],
          value: c.suspendedBasis,
        });
      }
      const heldOut = c.heldCarry.sub(releasedHeld);
      const passiveOut = passiveSusp.add(heldOut);
      if (passiveOut.gt(Money.zero())) {
        em.emit({
          concept: `k1.${c.id}.passive_suspended.out`, jurisdiction: ['FED'], inputs: [f],
          formula_ref: 'FED.F8582.SUSPENDED', rule_version: rvFed,
          steps: [
            ...(passiveSusp.gt(Money.zero()) ? [`§469 suspended passive loss ${passiveSusp.toString()} carries forward (year-close writes the passive_loss register)`] : []),
            ...(heldOut.gt(Money.zero()) ? [`prior carryover ${heldOut.toString()} still held on the nonpassive activity — §469(f)(1)(A) releases it only against this activity's own income`] : []),
          ],
          value: passiveOut,
        });
      }
    }
    if (f4797Inputs.length > 0) {
      f4797TotalFact = em.emit({
        concept: C.FED_F4797_TOTAL, jurisdiction: ['FED', 'IL'], inputs: f4797Inputs,
        formula_ref: 'FED.SCH1.LINE4.F4797', rule_version: rvFed,
        steps: f4797Inputs.map((f) => `f4797_total += ${f.value.toString()} (${f.concept})`),
        value: f4797Total,
      });
    }
    scheK1Fact = em.emit({
      concept: C.FED_SCHE_K1_TOTAL, jurisdiction: ['FED'], inputs: perK1,
      formula_ref: 'FED.SCHE.P2.TOTAL', rule_version: rvFed,
      steps: perK1.map((f) => `sche_k1 += ${f.value.toString()} (${f.concept})`),
      value: Money.sum(perK1.map((f) => f.value)),
    });
  }

  // Sch 1 line 10 (additional income): kernel-emitted so the form line is
  // a real fact, never mapping math.
  if (schcTotalFact !== null || scheK1Fact !== null || f4797TotalFact !== null) {
    const parts = [...(schcTotalFact ? [schcTotalFact] : []), ...(scheK1Fact ? [scheK1Fact] : []),
      ...(f4797TotalFact ? [f4797TotalFact] : [])];
    em.emit({
      concept: C.FED_SCH1_INCOME_TOTAL, jurisdiction: ['FED'], inputs: parts,
      formula_ref: 'FED.SCH1.LINE10.TOTAL', rule_version: rvFed,
      steps: parts.map((f) => `sch1_income += ${f.value.toString()} (${f.concept})`),
      value: Money.sum(parts.map((f) => f.value)),
    });
  }

  // P97 — §402(g) elective-deferral validation, per person. Deferrals are
  // summed across every employer (the limit follows the PERSON, not the job —
  // two W-2s each under the cap can still overshoot together). SIMPLE
  // deferrals check their own §408(p) limit AND ride inside the aggregate.
  // The 60-63 enhanced catch-up REPLACES the age-50 amount (§414(v)(2)(E)).
  // An excess deferral is INCOME on line 1h — not an excise: it is taxed now,
  // and taxed AGAIN at distribution if not pulled out by April 15.
  let deferralExcessFact: TaxFact | null = null;
  {
    const dPersons = [
      { key: 'tp', def: sumOfConcept(input, C.CONTRIB_DEFERRAL_TP), simple: sumOfConcept(input, C.CONTRIB_SIMPLE_TP), c50: sumOfConcept(input, C.IRA_CATCHUP_TP), c60: sumOfConcept(input, C.DEFERRAL_SUPER_CATCHUP_TP) },
      { key: 'sp', def: sumOfConcept(input, C.CONTRIB_DEFERRAL_SP), simple: sumOfConcept(input, C.CONTRIB_SIMPLE_SP), c50: sumOfConcept(input, C.IRA_CATCHUP_SP), c60: sumOfConcept(input, C.DEFERRAL_SUPER_CATCHUP_SP) },
    ];
    const anyDef = dPersons.some((pp) => pp.def.inputs.length > 0 || pp.simple.inputs.length > 0);
    if (anyDef) {
      const rc = fed.retirement_contributions;
      if (!rc) {
        throw new Error('kernel: elective deferrals present but rule data lacks retirement_contributions parameters');
      }
      let excessTotal = Money.zero();
      const steps: string[] = [];
      const inputsAll: TaxFact[] = [];
      for (const pp of dPersons) {
        const aggregate = pp.def.total.add(pp.simple.total);
        if (aggregate.isZero()) continue;
        inputsAll.push(...pp.def.inputs, ...pp.simple.inputs, ...pp.c50.inputs, ...pp.c60.inputs);
        const super6063 = !pp.c60.total.isZero();
        const over50 = !pp.c50.total.isZero();
        const catchUp = super6063
          ? Money.fromString(rc.elective_deferral.catch_up_60_63)
          : over50
            ? Money.fromString(rc.elective_deferral.catch_up_50)
            : Money.zero();
        const aggLimit = Money.fromString(rc.elective_deferral.limit).add(catchUp);
        const aggExcess = Money.max(Money.zero(), aggregate.sub(aggLimit));
        const simpleCatch = super6063
          ? Money.fromString(rc.simple.catch_up_60_63)
          : over50
            ? Money.fromString(rc.simple.catch_up_50)
            : Money.zero();
        const simpleLimit = Money.fromString(rc.simple.limit).add(simpleCatch);
        const simpleExcess = Money.max(Money.zero(), pp.simple.total.sub(simpleLimit));
        const personExcess = Money.max(aggExcess, simpleExcess);
        steps.push(`${pp.key}: deferrals ${pp.def.total.toString()} + SIMPLE ${pp.simple.total.toString()} = ${aggregate.toString()} vs §402(g) limit ${aggLimit.toString()}${super6063 ? ' (60–63 catch-up)' : over50 ? ' (age-50 catch-up)' : ''}${pp.simple.total.isZero() ? '' : `; SIMPLE alone vs §408(p) limit ${simpleLimit.toString()}`}${personExcess.isZero() ? ' → within limits' : ` → EXCESS ${personExcess.toString()}`}`);
        excessTotal = excessTotal.add(personExcess);
      }
      if (!excessTotal.isZero()) {
        deferralExcessFact = em.emit({
          concept: C.FED_DEFERRAL_EXCESS_INCOME, jurisdiction: ['FED'],
          inputs: inputsAll,
          formula_ref: 'FED.1040.LINE1H.EXCESS_DEFERRAL', rule_version: rvFed,
          steps: [
            ...steps,
            `excess deferral ${excessTotal.roundToDollar().toString()} is added to WAGES INCOME (1040 line 1h). Ask the plan to distribute it by April 15 — left in place, the same dollars are taxed a second time when eventually distributed.`,
          ],
          value: excessTotal.roundToDollar(),
        });
      }
    }
  }

  // P97 — SEP / Solo-401(k) employer contribution for the Sch C business.
  // Pub 560 rate worksheet: for a self-employed person a "25%" plan really
  // allows 25/125 (=20%) of net SE earnings AFTER the ½SE deduction, capped
  // by §415(c). The deductible slice goes to Sch 1 line 16; anything above
  // is a nondeductible employer contribution carrying the §4972 10% excise.
  let sepDeductionFact: TaxFact | null = null;
  let sepExciseFact: TaxFact | null = null;
  {
    const sepContrib = sumOfConcept(input, C.CONTRIB_SEP);
    if (sepContrib.inputs.length > 0 && !sepContrib.total.isZero()) {
      const rc = fed.retirement_contributions;
      if (!rc) {
        throw new Error('kernel: SEP contribution present but rule data lacks retirement_contributions parameters');
      }
      const seDedForSep = seDeductionFact ? seDeductionFact.value : Money.zero();
      const base = Money.max(Money.zero(), seNetEarnings.sub(seDedForSep));
      // reduced rate = rate/(1+rate): 0.25 → 25/125.
      const ratePct = Money.fromString(rc.sep.compensation_rate).mulRate('100').roundToDollar().toString(); // audit-allow: percent base (ratio scaffolding), not a dollar figure
      const denomPct = Money.fromString(rc.sep.compensation_rate).mulRate('100').add(Money.fromString('100')).roundToDollar().toString(); // audit-allow: percent base (ratio scaffolding), not a dollar figure
      const worksheetMax = base.mulFraction(ratePct, denomPct).roundToDollar();
      const cap = Money.min(worksheetMax, Money.fromString(rc.sep.annual_additions_limit));
      const deductible = Money.min(sepContrib.total, cap).roundToDollar();
      const excess = Money.max(Money.zero(), sepContrib.total.sub(cap)).roundToDollar();
      if (!deductible.isZero()) {
        sepDeductionFact = em.emit({
          concept: C.FED_SEP_DEDUCTION, jurisdiction: ['FED'],
          inputs: sepContrib.inputs,
          formula_ref: 'FED.SCH1.LINE16', rule_version: rvFed,
          steps: [
            `self-employed base = net SE earnings ${seNetEarnings.toString()} − ½SE ${seDedForSep.toString()} = ${base.toString()}`,
            `Pub 560 worksheet: ${base.toString()} × ${ratePct}/${denomPct} = ${worksheetMax.toString()}, capped by §415(c) ${rc.sep.annual_additions_limit} → allowed ${cap.toString()}`,
            `deduction (Sch 1 line 16) = min(contribution ${sepContrib.total.toString()}, allowed ${cap.toString()}) = ${deductible.toString()}`,
          ],
          value: deductible,
        });
      }
      if (!excess.isZero()) {
        const excessFact = em.emit({
          concept: C.FED_SEP_EXCESS, jurisdiction: ['FED'],
          inputs: sepContrib.inputs,
          formula_ref: 'FED.F5330.SEP.EXCESS', rule_version: rvFed,
          steps: [
            `contribution ${sepContrib.total.toString()} − allowed ${cap.toString()} = NONDEDUCTIBLE ${excess.toString()}${base.isZero() ? ' (no self-employment earnings support a SEP at all this year)' : ''}`,
            `withdraw before the return due date or carry it as next year's contribution to stop the §4972 excise repeating`,
          ],
          value: excess,
        });
        sepExciseFact = em.emit({
          concept: C.FED_SEP_EXCISE, jurisdiction: ['FED'],
          inputs: [excessFact],
          formula_ref: 'FED.F5330.SEC4972', rule_version: rvFed,
          steps: [
            `§4972(a): ${excess.toString()} × ${rc.sep.nondeductible_excise_rate} = ${excess.mulRate(rc.sep.nondeductible_excise_rate).roundToDollar().toString()} (Form 5330)`,
          ],
          value: excess.mulRate(rc.sep.nondeductible_excise_rate).roundToDollar(),
        });
      }
    }
  }

  // total income = wages + interest + ordinary dividends + net capital gain
  // + retirement + Sch C net profit (Sch 1 line 3) when a business exists
  // + any excess elective deferral (line 1h).
  const incomeComponents = [wagesTotal, interestTotal, divOrdTotal,
    ...(schdTotalFact ? [schdTotalFact] : capGainTotal ? [capGainTotal] : []), retirementTotal,
    ...(schcTotalFact ? [schcTotalFact] : []), ...(scheK1Fact ? [scheK1Fact] : []),
    ...(f4797TotalFact ? [f4797TotalFact] : []),
    ...(deferralExcessFact ? [deferralExcessFact] : [])];
  const totalIncomeFact = em.emit({
    concept: C.FED_TOTAL_INCOME,
    jurisdiction: ['FED'],
    inputs: incomeComponents,
    terms: incomeComponents.map((f) => ({ fact: f, sign: 1 as const })),
    formula_ref: 'FED.1040.TOTAL_INCOME',
    rule_version: rvFed,
    steps: incomeComponents.map((f) => `total_income += ${f.value.toString()} (${f.concept})`),
    value: Money.sum(incomeComponents.map((f) => f.value)),
  });

  // AGI = total income − Sch 1 adjustments
  const adjustmentsTotal = componentOf(C.ADJUSTMENTS, C.FED_ADJUSTMENTS_TOTAL, ['FED'], rvFed);
  const seDed = seDeductionFact ? seDeductionFact.value : Money.zero();

  // P94 — Form 8889: HSA contribution validation (§223). The limit is set by
  // COVERAGE (self-only vs family), not filing status, plus one §223(b)(3)
  // catch-up per 55+ account holder. Employer/payroll contributions (W-2 box
  // 12 code W) are already pre-tax, so only DIRECT contributions can deduct —
  // and only up to the room the employer money left. Anything above the limit
  // is an excess contribution carrying the §4973 6% excise until withdrawn.
  let hsaDeductionFact: TaxFact | null = null;
  let hsaExciseFact: TaxFact | null = null;
  {
    const employer = sumOfConcept(input, C.CONTRIB_HSA_EMPLOYER);
    const direct = sumOfConcept(input, C.CONTRIB_HSA_DIRECT);
    if (employer.inputs.length > 0 || direct.inputs.length > 0) {
      const rc = fed.retirement_contributions;
      if (!rc) {
        throw new Error('kernel: HSA contributions present but rule data lacks retirement_contributions parameters');
      }
      const coverage = sumOfConcept(input, C.HSA_FAMILY_COVERAGE);
      const family = !coverage.total.isZero();
      const catchRaw = sumOfConcept(input, C.HSA_CATCHUP_COUNT);
      const catchCount = Math.min(2, Math.max(0, Number(catchRaw.total.roundToDollar().toString())));
      const baseLimit = Money.fromString(family ? rc.hsa.limit_family : rc.hsa.limit_self_only);
      const catchTotal = Money.fromString(rc.hsa.catch_up).mulRate(String(catchCount));
      const limit = baseLimit.add(catchTotal);
      const coverageStep = coverage.inputs.length === 0
        ? `coverage type not entered → assumed SELF-ONLY (the conservative limit; enter "HSA: family HDHP coverage" if you had family coverage)`
        : `coverage: ${family ? 'family' : 'self-only'} HDHP`;
      const limitFact = em.emit({
        concept: C.FED_HSA_LIMIT, jurisdiction: ['FED'],
        inputs: [...coverage.inputs, ...catchRaw.inputs],
        formula_ref: 'FED.F8889.LINE8', rule_version: rvFed,
        steps: [
          coverageStep,
          `limit = ${baseLimit.toString()} (§223(b), ${family ? 'family' : 'self-only'}) + ${catchTotal.toString()} (${catchCount} × ${rc.hsa.catch_up} age-${rc.hsa.catch_up_age} catch-up) = ${limit.toString()}`,
        ],
        value: limit,
      });
      const total = employer.total.add(direct.total);
      const room = Money.max(Money.zero(), limit.sub(employer.total));
      const deduction = Money.min(direct.total, room).roundToDollar();
      if (!deduction.isZero()) {
        hsaDeductionFact = em.emit({
          concept: C.FED_HSA_DEDUCTION, jurisdiction: ['FED'],
          inputs: [limitFact, ...employer.inputs, ...direct.inputs],
          formula_ref: 'FED.F8889.LINE13', rule_version: rvFed,
          steps: [
            `employer (box 12 W) ${employer.total.toString()} is already pre-tax — never deducted again`,
            `deduction = min(direct ${direct.total.toString()}, limit ${limit.toString()} − employer ${employer.total.toString()}) = ${deduction.toString()} (8889 line 13 → Sch 1 line 13)`,
          ],
          value: deduction,
        });
      }
      const excess = Money.max(Money.zero(), total.sub(limit)).roundToDollar();
      if (!excess.isZero()) {
        const excessFact = em.emit({
          concept: C.FED_HSA_EXCESS, jurisdiction: ['FED'],
          inputs: [limitFact, ...employer.inputs, ...direct.inputs],
          formula_ref: 'FED.F8889.EXCESS', rule_version: rvFed,
          steps: [
            `total contributions ${total.toString()} − limit ${limit.toString()} = EXCESS ${excess.toString()}`,
            `withdraw the excess (plus its earnings) before the filing deadline to avoid the §4973 excise`,
          ],
          value: excess,
        });
        hsaExciseFact = em.emit({
          concept: C.FED_HSA_EXCISE, jurisdiction: ['FED'],
          inputs: [excessFact],
          formula_ref: 'FED.F5329.PART7', rule_version: rvFed,
          steps: [
            `5329 Part VII: ${excess.toString()} × ${rc.excess_contribution_excise_rate} = ${excess.mulRate(rc.excess_contribution_excise_rate).roundToDollar().toString()} (§4973(a); capped at 6% of year-end HSA value — not modeled, verify if the account is nearly empty)`,
          ],
          value: excess.mulRate(rc.excess_contribution_excise_rate).roundToDollar(),
        });
      }
    }
  }
  const hsaDed = hsaDeductionFact ? hsaDeductionFact.value : Money.zero();

  // P95 — Traditional IRA validation (§219 / Form 8606 / §4973), PER PERSON:
  // the contribution limit, the catch-up, and the deduction phase-out are all
  // individual. MAGI for §219(g) is figured WITHOUT the IRA deduction itself
  // (§219(g)(3)), so the pre-IRA AGI below is the phase-out input.
  let iraDeductionFact: TaxFact | null = null;
  let iraExciseFact: TaxFact | null = null;
  {
    const persons = [
      { key: 'tp', trad: sumOfConcept(input, C.CONTRIB_IRA_TRAD_TP), roth: sumOfConcept(input, C.CONTRIB_IRA_ROTH_TP), catch: sumOfConcept(input, C.IRA_CATCHUP_TP), covered: sumOfConcept(input, C.W2_RETIREMENT_PLAN_TP), nondedConcept: C.FED_IRA_NONDEDUCTIBLE_TP },
      { key: 'sp', trad: sumOfConcept(input, C.CONTRIB_IRA_TRAD_SP), roth: sumOfConcept(input, C.CONTRIB_IRA_ROTH_SP), catch: sumOfConcept(input, C.IRA_CATCHUP_SP), covered: sumOfConcept(input, C.W2_RETIREMENT_PLAN_SP), nondedConcept: C.FED_IRA_NONDEDUCTIBLE_SP },
    ];
    const anyIra = persons.some((pp) => pp.trad.inputs.length > 0 || pp.roth.inputs.length > 0);
    if (anyIra) {
      const rc = fed.retirement_contributions;
      if (!rc) {
        throw new Error('kernel: IRA contributions present but rule data lacks retirement_contributions parameters');
      }
      const preIraAgi = totalIncomeFact.value.sub(adjustmentsTotal.value).sub(seDed).sub(hsaDed);
      // §219(b)(1)(B): contributions cannot exceed compensation. Wages plus
      // net SE earnings after the ½SE deduction; on a joint return the
      // §219(c) spousal rule pools the couple's compensation.
      const compensation = wagesTotal.value.add(Money.max(Money.zero(), seNetEarnings.sub(seDed)));
      const anyCovered = persons.some((pp) => !pp.covered.total.isZero());
      // Pub 590-A worksheet mechanics, shared by the §219(g) deduction
      // phase-out (Worksheet 1-2) and the §408A(c)(3) Roth limit phase-out
      // (Worksheet 2-2): limit × (end − MAGI)/width, rounded UP to the next
      // $10, never below $200 while only partially phased.
      const phasedLimit = (personLimit: Money, magi: Money, range: { start: string; end: string }): Money => {
        const start = Money.fromString(range.start);
        const end = Money.fromString(range.end);
        if (magi.gte(end)) return Money.zero();
        if (magi.lte(start)) return personLimit;
        const frac = personLimit.mulFraction(end.sub(magi).toString(), end.sub(start).toString());
        const up10 = frac.mulFraction('1', '10').roundUpToDollar().mulRate('10');
        return Money.min(personLimit, Money.max(Money.fromString(rc.ira.reduced_limit_floor), up10));
      };
      const dedFactInputs: TaxFact[] = [];
      const dedSteps: string[] = [];
      let dedTotal = Money.zero();
      let perLimitExcess = Money.zero();
      let contribAll = Money.zero();
      for (const pp of persons) {
        const combined = pp.trad.total.add(pp.roth.total);
        if (combined.isZero()) continue;
        contribAll = contribAll.add(combined);
        const hasCatch = !pp.catch.total.isZero();
        const personLimit = Money.fromString(rc.ira.limit).add(hasCatch ? Money.fromString(rc.ira.catch_up) : Money.zero());
        // P96 — the trad side can exceed the person limit, and the Roth side
        // can exceed its own MAGI-phased room (§408A(c)(2): Roth room = the
        // phased limit MINUS all traditional contributions). The two pieces
        // partition, so summing them never double-counts a dollar.
        const tradExcess = Money.max(Money.zero(), pp.trad.total.sub(personLimit));
        const rothRange = rc.ira.roth_phaseout[fs];
        const rothPhased = phasedLimit(personLimit, preIraAgi, rothRange);
        const rothRoom = Money.max(Money.zero(), rothPhased.sub(pp.trad.total));
        const rothExcess = Money.max(Money.zero(), pp.roth.total.sub(rothRoom));
        if (!pp.roth.total.isZero()) {
          dedSteps.push(
            `${pp.key} Roth: §408A MAGI ${preIraAgi.toString()} vs ${fs} range ${rothRange.start}–${rothRange.end} → phased limit ${rothPhased.toString()}, minus traditional ${pp.trad.total.toString()} → room ${rothRoom.toString()}; contributed ${pp.roth.total.toString()}${rothExcess.isZero() ? '' : ` → EXCESS ${rothExcess.toString()}`}`,
          );
        }
        perLimitExcess = perLimitExcess.add(tradExcess).add(rothExcess);
        // Which §219(g) range applies to THIS person's deduction?
        const selfCovered = !pp.covered.total.isZero();
        const spouseCovered = anyCovered && !selfCovered;
        const married = fs === 'mfj' || fs === 'qss';
        let range: { start: string; end: string } | null = null;
        let rangeWhy = 'no one is covered by a workplace plan → fully deductible at any income (§219(g) does not apply)';
        if (selfCovered) {
          range = rc.ira.deduction_phaseout[fs];
          rangeWhy = `${pp.key} is covered by a workplace plan (W-2 box 13) → ${fs} phase-out ${range.start}–${range.end}`;
        } else if (spouseCovered && married) {
          range = rc.ira.deduction_phaseout.mfj_spouse_covered;
          rangeWhy = `${pp.key} is not covered but the spouse is → §219(g)(7) phase-out ${range.start}–${range.end}`;
        } else if (spouseCovered && fs === 'mfs') {
          range = rc.ira.deduction_phaseout.mfs;
          rangeWhy = `married filing separately with a covered spouse → phase-out ${range.start}–${range.end}`;
        }
        const dedBase = Money.min(pp.trad.total, personLimit);
        const allowed = range === null ? dedBase : Money.min(dedBase, phasedLimit(personLimit, preIraAgi, range));
        const deductible = Money.min(dedBase, allowed).roundToDollar();
        const nondeductible = Money.max(Money.zero(), Money.min(pp.trad.total, personLimit).sub(deductible)).roundToDollar();
        dedSteps.push(rangeWhy);
        dedSteps.push(`${pp.key}: traditional ${pp.trad.total.toString()}, limit ${personLimit.toString()}${hasCatch ? ' (incl. age-50 catch-up)' : ''} → deductible ${deductible.toString()}, nondeductible ${nondeductible.toString()}`);
        dedFactInputs.push(...pp.trad.inputs, ...pp.covered.inputs, ...pp.catch.inputs);
        dedTotal = dedTotal.add(deductible);
        if (!nondeductible.isZero()) {
          em.emit({
            concept: pp.nondedConcept, jurisdiction: ['FED'],
            inputs: pp.trad.inputs,
            formula_ref: 'FED.F8606.LINE1', rule_version: rvFed,
            steps: [
              `nondeductible contribution ${nondeductible.toString()} → Form 8606 line 1. This is BASIS: file 8606 now and keep it until the money comes out, or the same dollars get taxed twice.`,
            ],
            value: nondeductible,
          });
        }
      }
      // Excess = per-person limit overruns, plus whatever total contributions
      // exceed the couple's compensation beyond those overruns (§219(b)(1)).
      const compExcess = Money.max(Money.zero(), contribAll.sub(perLimitExcess).sub(compensation));
      const excess = perLimitExcess.add(compExcess).roundToDollar();
      if (!dedTotal.isZero()) {
        iraDeductionFact = em.emit({
          concept: C.FED_IRA_DEDUCTION, jurisdiction: ['FED'],
          inputs: dedFactInputs,
          formula_ref: 'FED.SCH1.LINE20', rule_version: rvFed,
          steps: [
            `MAGI for §219(g) = pre-IRA AGI ${preIraAgi.toString()} (the IRA deduction itself never enters its own phase-out)`,
            ...dedSteps,
            `IRA deduction (Sch 1 line 20) = ${dedTotal.roundToDollar().toString()}`,
          ],
          value: dedTotal.roundToDollar(),
        });
      }
      if (!excess.isZero()) {
        const excessFact = em.emit({
          concept: C.FED_IRA_EXCESS, jurisdiction: ['FED'],
          inputs: dedFactInputs.length > 0 ? dedFactInputs : persons.flatMap((pp) => [...pp.trad.inputs, ...pp.roth.inputs]),
          formula_ref: 'FED.F5329.IRA.EXCESS', rule_version: rvFed,
          steps: [
            ...dedSteps,
            `per-person overruns (§219 dollar limit + §408A Roth-MAGI limit) ${perLimitExcess.toString()} + contributions beyond compensation ${compExcess.toString()} (compensation ${compensation.toString()}) = EXCESS ${excess.toString()}`,
            `withdraw the excess (plus its earnings) before the filing deadline to avoid the §4973 excise repeating every year`,
          ],
          value: excess,
        });
        iraExciseFact = em.emit({
          concept: C.FED_IRA_EXCISE, jurisdiction: ['FED'],
          inputs: [excessFact],
          formula_ref: 'FED.F5329.PART3', rule_version: rvFed,
          steps: [
            `5329 Parts III/IV: ${excess.toString()} × ${rc.excess_contribution_excise_rate} = ${excess.mulRate(rc.excess_contribution_excise_rate).roundToDollar().toString()} (§4973(a); capped at 6% of year-end IRA value — not modeled, verify if the account is nearly empty)`,
          ],
          value: excess.mulRate(rc.excess_contribution_excise_rate).roundToDollar(),
        });
      }
    }
  }
  const iraDed = iraDeductionFact ? iraDeductionFact.value : Money.zero();
  const sepDed = sepDeductionFact ? sepDeductionFact.value : Money.zero();

  // Sch 1 line 25 (total adjustments incl. ½SE, HSA, and IRA deductions) —
  // the 1040 line 10 feed.
  em.emit({
    concept: C.FED_SCH1_ADJ_TOTAL, jurisdiction: ['FED'],
    inputs: [adjustmentsTotal, ...(seDeductionFact ? [seDeductionFact] : []), ...(hsaDeductionFact ? [hsaDeductionFact] : []), ...(iraDeductionFact ? [iraDeductionFact] : []), ...(sepDeductionFact ? [sepDeductionFact] : [])],
    formula_ref: 'FED.SCH1.LINE25.TOTAL', rule_version: rvFed,
    steps: [`sch1_adjustments = sourced ${adjustmentsTotal.value.toString()} + ½SE ${seDed.toString()} + hsa ${hsaDed.toString()} + ira ${iraDed.toString()} + sep ${sepDed.toString()}`],
    value: adjustmentsTotal.value.add(seDed).add(hsaDed).add(iraDed).add(sepDed),
  });
  const agiFact = em.emit({
    concept: C.FED_AGI,
    jurisdiction: ['FED', 'IL'], // IL pass starts from federal AGI
    inputs: [totalIncomeFact, adjustmentsTotal, ...(seDeductionFact ? [seDeductionFact] : []), ...(hsaDeductionFact ? [hsaDeductionFact] : []), ...(iraDeductionFact ? [iraDeductionFact] : []), ...(sepDeductionFact ? [sepDeductionFact] : [])],
    terms: [
      { fact: totalIncomeFact, sign: 1 as const },
      { fact: adjustmentsTotal, sign: -1 as const },
      ...[seDeductionFact, hsaDeductionFact, iraDeductionFact, sepDeductionFact]
        .filter((f): f is NonNullable<typeof f> => f !== null)
        .map((f) => ({ fact: f, sign: -1 as const })),
    ],
    formula_ref: 'FED.1040.AGI',
    rule_version: rvFed,
    steps: [
      `agi = ${totalIncomeFact.value.toString()} − adjustments ${adjustmentsTotal.value.toString()} − se_deduction ${seDed.toString()} − hsa_deduction ${hsaDed.toString()} − ira_deduction ${iraDed.toString()} − sep_deduction ${sepDed.toString()}`,
    ],
    value: totalIncomeFact.value.sub(adjustmentsTotal.value).sub(seDed).sub(hsaDed).sub(iraDed).sub(sepDed),
  });

  // standard deduction (rule data) vs itemized (Sch A fact) — greater-of.
  // The base table amount is bumped by the §63(f) age-65/blind add-on: one
  // per-box amount for each checked box (taxpayer 65+, taxpayer blind, spouse
  // 65+, spouse blind), at the unmarried rate for single/HoH and the married
  // rate for mfj/mfs/qss.
  const stdBase = Money.fromString(fed.standard_deduction[fs]);
  const addlBoxes = Math.max(0, Math.trunc(input.ctx.addl_std_boxes));
  const married = fs === 'mfj' || fs === 'mfs' || fs === 'qss';
  const stdSteps = [`standard_deduction[${fs}] = ${stdBase.toString()} (rule data)`];
  let stdAmount = stdBase;
  if (addlBoxes > 0) {
    if (!fed.additional_std_deduction) {
      throw new Error(
        'age/blind additional-deduction boxes were claimed but the rule data carries no §63(f) additional_std_deduction figures',
      );
    }
    const perBox = Money.fromString(
      married ? fed.additional_std_deduction.per_box_married : fed.additional_std_deduction.per_box_unmarried,
    );
    const addl = perBox.mulRate(String(addlBoxes));
    stdAmount = stdBase.add(addl);
    const rateWord = married ? 'married' : 'unmarried';
    stdSteps.push(
      `additional standard deduction (§63(f), age 65+ / blind): ${addlBoxes} box(es) × ${perBox.toString()} (${rateWord} rate) = ${addl.toString()}`,
    );
    stdSteps.push(`standard deduction = ${stdBase.toString()} + ${addl.toString()} = ${stdAmount.toString()}`);
  }
  const stdFact = em.emit({
    concept: C.FED_STD_DEDUCTION,
    jurisdiction: ['FED'],
    inputs: [],
    formula_ref: 'FED.STD_DEDUCTION.TABLE',
    rule_version: rvFed,
    steps: stdSteps,
    value: stdAmount,
  });
  // ---------- SCHEDULE A (P67) ----------
  // Built from components when any are supplied. The point is that TaxOS
  // ALREADY holds most of this — property tax from the tax bill, state income
  // tax from W-2 withholding — so making the filer re-add them by hand was
  // busywork that also hid the SALT cap inside their arithmetic instead of
  // showing it in the trail.
  //
  // The legacy single-figure ITEMIZED input stays supported for a
  // hand-computed Schedule A, but the two are MUTUALLY EXCLUSIVE: supplying
  // both would double-count silently, so the kernel refuses.
  const itemizedDirect = sumOfConcept(input, C.ITEMIZED);
  const schaMedical = sumOfConcept(input, C.SCHA_MEDICAL);
  const schaStateOther = sumOfConcept(input, C.SCHA_STATE_TAX_OTHER);
  const schaPersonalProp = sumOfConcept(input, C.SCHA_PERSONAL_PROPERTY_TAX);
  const schaMortgage = sumOfConcept(input, C.SCHA_MORTGAGE_INTEREST);
  const schaPoints = sumOfConcept(input, C.SCHA_MORTGAGE_POINTS);
  const schaInvInterest = sumOfConcept(input, C.SCHA_INVESTMENT_INTEREST);
  const schaCharitable = sumOfConcept(input, C.SCHA_CHARITABLE);
  // Already-known facts that belong on Schedule A line 5: the residence
  // property tax (line 5b) and the state income tax actually PAID this year
  // (line 5a — withholding plus estimates, the cash-basis measure).
  const ilPropTaxFacts = sumOfConcept(input, C.IL_PROPERTY_TAX);
  const ilWhFacts = sumOfConcept(input, C.IL_WITHHOLDING);
  const ilEstFacts = sumOfConcept(input, C.IL_ESTIMATED);

  const schaComponentInputs = [
    ...schaMedical.inputs, ...schaStateOther.inputs, ...schaPersonalProp.inputs,
    ...schaMortgage.inputs, ...schaPoints.inputs, ...schaInvInterest.inputs, ...schaCharitable.inputs,
  ];

  // §164(b)(6): the cap phases DOWN over a MAGI threshold, with a floor.
  // Computed up front because it decides whether Schedule A is worth running.
  const fsSchA = input.ctx.filing_status;
  const mfsSchA = fsSchA === 'mfs';
  const stateIncomeTax = ilWhFacts.total.add(ilEstFacts.total).add(schaStateOther.total).roundToDollar();
  const realEstate = ilPropTaxFacts.total.roundToDollar();
  const saltBefore = stateIncomeTax.add(realEstate).add(schaPersonalProp.total.roundToDollar());
  let saltCap = Money.zero();
  let saltAllowed = Money.zero();
  if (fed.schedule_a) {
    const baseCap = Money.fromString(mfsSchA ? fed.schedule_a.salt_cap_mfs : fed.schedule_a.salt_cap);
    const phaseStart = Money.fromString(mfsSchA ? fed.schedule_a.salt_phasedown_agi_mfs : fed.schedule_a.salt_phasedown_agi);
    const capFloor = Money.fromString(mfsSchA ? fed.schedule_a.salt_cap_floor_mfs : fed.schedule_a.salt_cap_floor);
    const over = Money.max(Money.zero(), agiFact.value.sub(phaseStart));
    const reduction = over.mulFraction(fed.schedule_a.salt_phasedown_rate, '1').roundToDollar();
    saltCap = Money.max(capFloor, baseCap.sub(reduction));
    saltAllowed = Money.min(saltBefore, saltCap);
  }

  // Activate on an explicit component OR when the taxes TaxOS already holds
  // would BEAT the standard deduction on their own. Without the second clause
  // a filer with a large property-tax bill and nothing else would silently
  // lose the benefit — and with the SALT cap at $40k that is now realistic.
  const schaActive = fed.schedule_a !== undefined
    && (schaComponentInputs.length > 0 || saltAllowed.gt(stdFact.value));

  if (schaComponentInputs.length > 0 && itemizedDirect.inputs.length > 0) {
    // HONESTY GUARD: a hand-computed total PLUS components is ambiguous — the
    // total probably already contains them. Refuse rather than pick one.
    // Name the offenders. "Remove one" without saying WHICH left the filer
    // staring at a blocked return with no way to find the conflict.
    const componentIds = [...new Set(schaComponentInputs.map((f) => f.concept))].join(', ');
    throw new Error(
      `kernel: your return has BOTH a hand-computed itemized total (${C.ITEMIZED} = ${itemizedDirect.total.roundToDollar().toString()}) AND Schedule A components (${componentIds}). They are mutually exclusive — the total almost certainly already contains the components, so using both would double-count the deduction. Remove whichever is the duplicate on the Documents page: delete the "Itemized deductions total" entry if the components cover everything, or delete the components if you prefer to enter one hand-computed figure.`,
    );
  }
  if (schaComponentInputs.length > 0 && !fed.schedule_a) {
    // HONESTY GUARD: without the floor and the cap there is no Schedule A.
    throw new Error('kernel: Schedule A components are present but rule data lacks schedule_a parameters');
  }

  let schaTotalFact: TaxFact | null = null;
  // Hoisted: Form 1116 line 3a needs the ALLOWED medical (post-§213 floor).
  let schaMedicalAllowed = Money.zero();
  if (schaActive) {
    const sa = fed.schedule_a!;

    // Line 1-4 — §213(a): only the excess over the AGI floor is deductible.
    let medicalAllowed = Money.zero();
    if (schaMedical.inputs.length > 0) {
      const floor = agiFact.value.mulFraction(sa.medical_agi_floor_pct, '1').roundToDollar();
      medicalAllowed = Money.max(Money.zero(), schaMedical.total.roundToDollar().sub(floor));
      em.emit({
        concept: C.FED_SCHA_MEDICAL_ALLOWED, jurisdiction: ['FED'],
        inputs: [...schaMedical.inputs, agiFact], formula_ref: 'FED.SCHA.LINE4', rule_version: rvFed,
        steps: [
          `medical paid ${schaMedical.total.roundToDollar().toString()} − §213(a) floor ${sa.medical_agi_floor_pct} × AGI ${agiFact.value.toString()} = ${floor.toString()} → allowed ${medicalAllowed.toString()}`,
        ],
        value: medicalAllowed,
      });
    }
    schaMedicalAllowed = medicalAllowed;

    // Line 5 — state/local income tax PAID + real estate + personal property.
    const saltInputs = [
      ...ilWhFacts.inputs, ...ilEstFacts.inputs, ...schaStateOther.inputs,
      ...ilPropTaxFacts.inputs, ...schaPersonalProp.inputs,
    ];
    const saltBeforeFact = em.emit({
      concept: C.FED_SCHA_SALT_BEFORE_CAP, jurisdiction: ['FED'], inputs: saltInputs,
      formula_ref: 'FED.SCHA.LINE5D', rule_version: rvFed,
      steps: [
        `state/local income tax paid ${stateIncomeTax.toString()} (withholding + estimates${schaStateOther.total.isZero() ? '' : ' + other paid'}) + real estate tax ${realEstate.toString()}${schaPersonalProp.total.isZero() ? '' : ` + personal property tax ${schaPersonalProp.total.roundToDollar().toString()}`} = ${saltBefore.toString()}`,
        'These come from the property-tax bill and your W-2 state withholding — already on the return, never re-entered.',
      ],
      value: saltBefore,
    });
    const saltFact = em.emit({
      concept: C.FED_SCHA_SALT_ALLOWED, jurisdiction: ['FED'], inputs: [saltBeforeFact, agiFact],
      formula_ref: 'FED.SCHA.LINE5E', rule_version: rvFed,
      steps: [
        `§164(b)(6) cap for ${fsSchA} at AGI ${agiFact.value.toString()} = ${saltCap.toString()}`,
        `line 5e = min(${saltBefore.toString()}, ${saltCap.toString()}) = ${saltAllowed.toString()}${saltAllowed.lt(saltBefore) ? ' — THE CAP BIT' : ''}`,
      ],
      value: saltAllowed,
    });

    // Line 8-10 — mortgage interest, points, investment interest.
    const interestTotal = schaMortgage.total.add(schaPoints.total).add(schaInvInterest.total).roundToDollar();
    const interestInputs = [...schaMortgage.inputs, ...schaPoints.inputs, ...schaInvInterest.inputs];
    let interestFact: TaxFact | null = null;
    if (interestInputs.length > 0) {
      interestFact = em.emit({
        concept: C.FED_SCHA_INTEREST, jurisdiction: ['FED'], inputs: interestInputs,
        formula_ref: 'FED.SCHA.LINE10', rule_version: rvFed,
        steps: [
          `mortgage interest ${schaMortgage.total.roundToDollar().toString()}${schaPoints.total.isZero() ? '' : ` + points ${schaPoints.total.roundToDollar().toString()}`}${schaInvInterest.total.isZero() ? '' : ` + investment interest ${schaInvInterest.total.roundToDollar().toString()}`} = ${interestTotal.toString()}`,
          'SIMPLIFIED: the §163(h)(3) acquisition-debt limit ($750k post-2017 / $1M grandfathered) is NOT applied — enter the deductible portion (recorded gap)',
        ],
        value: interestTotal,
      });
    }

    // Line 11-14 — charitable.
    let charFact: TaxFact | null = null;
    if (schaCharitable.inputs.length > 0) {
      charFact = em.emit({
        concept: C.FED_SCHA_CHARITABLE, jurisdiction: ['FED'], inputs: schaCharitable.inputs,
        formula_ref: 'FED.SCHA.LINE14', rule_version: rvFed,
        steps: [
          `charitable contributions ${schaCharitable.total.roundToDollar().toString()}`,
          'SIMPLIFIED: the §170(b) AGI percentage ceilings and the 5-year carryover are NOT applied (recorded gap)',
        ],
        value: schaCharitable.total.roundToDollar(),
      });
    }

    const schaTotal = medicalAllowed.add(saltAllowed).add(interestTotal).add(schaCharitable.total.roundToDollar());
    schaTotalFact = em.emit({
      concept: C.FED_SCHA_TOTAL, jurisdiction: ['FED'],
      inputs: [saltFact, ...(interestFact ? [interestFact] : []), ...(charFact ? [charFact] : [])],
      formula_ref: 'FED.SCHA.LINE17', rule_version: rvFed,
      steps: [
        `Schedule A total = medical ${medicalAllowed.toString()} + SALT ${saltAllowed.toString()} + interest ${interestTotal.toString()} + charitable ${schaCharitable.total.roundToDollar().toString()} = ${schaTotal.toString()}`,
      ],
      value: schaTotal,
    });
  }

  const itemized = schaTotalFact !== null
    ? { total: schaTotalFact.value, inputs: [schaTotalFact], steps: [] as string[] }
    : itemizedDirect;
  const deductionFact = em.emit({
    concept: C.FED_DEDUCTION,
    jurisdiction: ['FED'],
    inputs: [stdFact, ...itemized.inputs],
    formula_ref: 'FED.1040.DEDUCTION.GREATER_OF',
    rule_version: rvFed,
    steps: [
      ...itemized.steps,
      `deduction = max(standard ${stdFact.value.toString()}, itemized ${itemized.total.toString()})`,
    ],
    value: Money.max(stdFact.value, itemized.total.roundToDollar()),
  });

  // taxable income before QBI = max(0, AGI − deduction)
  const taxableBeforeQbi = Money.max(Money.zero(), agiFact.value.sub(deductionFact.value));

  // ---------- QBI — FORM 8995 (P3, under-threshold path only) ----------
  // Combined QBI = allowed Sch C net (reduced by the ½-SE-tax deduction,
  // §199A(c)(4)) + allowed K-1 net. Negative combined QBI carries forward.
  // Over the §199A(e)(2) threshold the 8995-A limitations apply — NOT
  // implemented: the kernel emits a zero deduction with an explicit step
  // and the capability registry blocks production use (recorded gap).
  let qbiFact: TaxFact | null = null;
  const qbiCoPrior = sumOfConcept(input, C.QBI_CO_PRIOR); // 8995 line 3, entered as a POSITIVE loss
  const reitPtp = sumOfConcept(input, C.REIT_PTP_INCOME); // 8995 line 6
  const hasQbiSources = schcTotalFact !== null || scheK1Fact !== null
    || !qbiCoPrior.total.isZero() || !reitPtp.total.isZero();
  // HONESTY GUARD: silently skipping QBI when the rule set lacks the block
  // would compute a WRONG return (missing deduction), not a partial one.
  if (hasQbiSources && !fed.qbi) {
    throw new Error('kernel: QBI sources present (Sch C / K-1 / carryover / REIT-PTP) but rule data lacks qbi parameters');
  }
  if (hasQbiSources && fed.qbi) {
    const schcComponent = (schcTotalFact ? schcTotalFact.value : Money.zero())
      .sub(seDeductionFact ? seDeductionFact.value : Money.zero());
    // 8995 line 4: current QBI net of the prior-year (−)QBI carryforward.
    const combined = schcComponent.add(k1QbiNet).sub(qbiCoPrior.total.roundToDollar());
    const threshold = Money.fromString(fed.qbi.threshold[fs]);
    const qbiSteps = [
      `combined QBI = schc ${schcComponent.toString()} (net − ½SE, §199A(c)(4)) + k1 ${k1QbiNet.toString()} − prior-year carryforward ${qbiCoPrior.total.roundToDollar().toString()} = ${combined.toString()} (8995 lines 2–4)`,
    ];
    let ded = Money.zero();
    if (combined.isNegative()) {
      qbiSteps.push(`combined QBI negative → QBI component 0; ${combined.neg().toString()} carries forward (§199A(c)(2))`);
      em.emit({
        concept: C.FED_QBI_LOSS_OUT, jurisdiction: ['FED'],
        inputs: [...(schcTotalFact ? [schcTotalFact] : []), ...(scheK1Fact ? [scheK1Fact] : []), ...qbiCoPrior.inputs],
        formula_ref: 'FED.F8995.LOSS_CARRYFORWARD', rule_version: rvFed,
        steps: [`negative combined QBI ${combined.neg().toString()} carries to next year (year-close writes the qbi_loss register)`],
        value: combined.neg(),
      });
    }
    if (taxableBeforeQbi.gt(threshold)) {
      qbiSteps.push(`taxable before QBI ${taxableBeforeQbi.toString()} exceeds the §199A(e)(2) threshold ${threshold.toString()} — 8995-A not implemented, deduction 0 (capability gap; Gate 1 blocks production use)`);
    } else {
      // Per-line 8995 rounding: line 5 (20% × QBI) and line 9 (20% × REIT/PTP)
      // round separately, then line 10 sums — a $4 PTP amount yields a $1
      // deduction (0.8 → 1, HALF_UP), matching filed-return behavior.
      const qbiComponent = combined.isNegative()
        ? Money.zero()
        : combined.mulRate(fed.qbi.rate).roundToDollar();
      let reitComponent = Money.zero();
      if (reitPtp.total.isNegative()) {
        qbiSteps.push(`REIT/PTP component negative (${reitPtp.total.toString()}) — its own carryforward NOT modeled (recorded gap); component 0`);
      } else if (reitPtp.total.gt(Money.zero())) {
        reitComponent = reitPtp.total.mulRate(fed.qbi.rate).roundToDollar();
        qbiSteps.push(`REIT/PTP component = ${fed.qbi.rate} × ${reitPtp.total.toString()} = ${reitComponent.toString()} (8995 lines 6–9)`);
      }
      const prefForQbi = ncgForPref.add(qualDivTotal.value);
      const incomeLimit = Money.max(Money.zero(), taxableBeforeQbi.sub(prefForQbi));
      ded = Money.min(qbiComponent.add(reitComponent), incomeLimit.mulRate(fed.qbi.rate).roundToDollar());
      qbiSteps.push(
        `deduction = min(QBI component ${qbiComponent.toString()} + REIT/PTP component ${reitComponent.toString()}, ${fed.qbi.rate} × income limit ${incomeLimit.toString()}) = ${ded.toString()} (Form 8995 lines 10–15)`,
      );
    }
    qbiFact = em.emit({
      concept: C.FED_QBI_DEDUCTION, jurisdiction: ['FED'],
      inputs: [...(schcTotalFact ? [schcTotalFact] : []), ...(scheK1Fact ? [scheK1Fact] : []),
               ...qbiCoPrior.inputs, ...reitPtp.inputs, deductionFact],
      formula_ref: 'FED.F8995.QBI_DEDUCTION', rule_version: rvFed,
      steps: qbiSteps, value: ded,
    });
  }

  // 1040 line 14 (= 12e + 13a + 13b). A printed form needs the subtotal box
  // filled even though the kernel computes taxable income directly.
  em.emit({
    concept: C.FED_DEDUCTIONS_TOTAL, jurisdiction: ['FED'],
    inputs: [deductionFact, ...(qbiFact ? [qbiFact] : [])],
    formula_ref: 'FED.1040.LINE14.DEDUCTIONS_TOTAL', rule_version: rvFed,
    steps: [`line 14 = deduction ${deductionFact.value.toString()} + §199A ${(qbiFact ? qbiFact.value : Money.zero()).toString()}`],
    value: deductionFact.value.add(qbiFact ? qbiFact.value : Money.zero()),
  });

  const taxableFact = em.emit({
    concept: C.FED_TAXABLE,
    jurisdiction: ['FED'],
    inputs: [agiFact, deductionFact, ...(qbiFact ? [qbiFact] : [])],
    terms: [
      { fact: agiFact, sign: 1 as const },
      { fact: deductionFact, sign: -1 as const },
      ...(qbiFact ? [{ fact: qbiFact, sign: -1 as const }] : []),
    ],
    clamp_zero: true,
    formula_ref: 'FED.1040.TAXABLE_INCOME',
    rule_version: rvFed,
    steps: [`taxable = max(0, ${agiFact.value.toString()} − ${deductionFact.value.toString()} − qbi ${(qbiFact ? qbiFact.value : Money.zero()).toString()})`],
    value: Money.max(Money.zero(), agiFact.value.sub(deductionFact.value).sub(qbiFact ? qbiFact.value : Money.zero())),
  });

  // preferential income = qualified dividends + net capital gain (Sch D NCG
  // when the D sub-DAG ran; legacy sourced line otherwise), clamped to taxable
  const prefRaw = qualDivTotal.value.add(ncgForPref);
  const pref = Money.min(prefRaw, taxableFact.value).roundToDollar();
  const ordinaryPortion = Money.max(Money.zero(), taxableFact.value.sub(pref));

  const ordSteps: string[] = [`ordinary_portion = ${taxableFact.value.toString()} − pref ${pref.toString()} = ${ordinaryPortion.toString()}`];
  const ordTax = bracketTax(fed.brackets[fs], ordinaryPortion, ordSteps);
  const ordTaxFact = em.emit({
    concept: C.FED_TAX_ORDINARY,
    jurisdiction: ['FED'],
    inputs: [taxableFact, qualDivTotal, capGainLineFact],
    formula_ref: 'FED.TAX.BRACKETS',
    rule_version: rvFed,
    steps: ordSteps,
    value: ordTax,
  });

  const cgSteps: string[] = [`pref = min(qualified_div ${qualDivTotal.value.toString()} + net_capgain⁺ ${ncgForPref.toString()}, taxable) = ${pref.toString()}`];
  const cgTax = pref.isZero()
    ? Money.zero()
    : capGainTax(fed.capital_gains_brackets[fs], ordinaryPortion, taxableFact.value, cgSteps);
  if (pref.isZero()) cgSteps.push('pref = 0 → capgain tax = 0');
  const cgTaxFact = em.emit({
    concept: C.FED_TAX_CAPGAIN,
    jurisdiction: ['FED'],
    inputs: [taxableFact, qualDivTotal, capGainLineFact],
    formula_ref: 'FED.TAX.QDCGT.WORKSHEET.SIMPLIFIED',
    rule_version: rvFed,
    steps: cgSteps,
    value: cgTax,
  });

  // total tax = rounded ordinary line + rounded capgain line
  const taxFact = em.emit({
    concept: C.FED_TAX,
    jurisdiction: ['FED'],
    inputs: [ordTaxFact, cgTaxFact],
    terms: [{ fact: ordTaxFact, sign: 1 as const }, { fact: cgTaxFact, sign: 1 as const }],
    formula_ref: 'FED.TAX.TOTAL',
    rule_version: rvFed,
    steps: [`tax = ${ordTaxFact.value.toString()} + ${cgTaxFact.value.toString()}`],
    value: ordTaxFact.value.add(cgTaxFact.value),
  });

  // ---------- FORM 8962 — PREMIUM TAX CREDIT (P5, ANNUAL method) ----------
  // Reconciles 1095-A advance credit against the actual PTC. Annual totals
  // only (the monthly computation is a recorded gap). Household income uses
  // AGI — the MAGI add-backs (tax-exempt interest, excluded foreign income,
  // nontaxable SS) are a recorded gap flagged in the trail. Net PTC is a
  // REFUNDABLE credit (Sch 3 line 9 → 1040 payments); excess APTC repays as
  // a Sch 2 tax, capped below the cliff (§36B(f)(2)(B)).
  let ptcNetFact: TaxFact | null = null;
  let ptcRepayFact: TaxFact | null = null;
  {
    const premium = sumOfConcept(input, C.PTC_PREMIUM);
    const slcsp = sumOfConcept(input, C.PTC_SLCSP);
    const aptc = sumOfConcept(input, C.PTC_APTC);
    if (premium.inputs.length > 0 || slcsp.inputs.length > 0 || aptc.inputs.length > 0) {
      if (!fed.ptc) throw new Error('kernel: 1095-A facts present but rule data lacks ptc parameters');
      // The tax family size sets the FPL the credit is measured against, so
      // it is not a figure that may be assumed. It used to fall back to a
      // household of ONE whenever it was absent. Add Data does prompt for it
      // once a 1095-A premium is detected, but that is a prompt, not a gate:
      // skip it and a family of four was scored far higher up the FPL scale
      // and, near the 400% cliff, repaid the entire advance credit. Missing
      // data THROWS; it never defaults.
      const sizeRaw = sumOfConcept(input, C.PTC_HOUSEHOLD_SIZE);
      if (sizeRaw.inputs.length === 0) {
        throw new Error(
          'kernel: 1095-A facts are on the return but the tax family size (ptc.household_size, Form 8962 line 1) is missing. It sets the federal poverty line the premium credit is measured against and cannot be assumed — enter it on Documents.',
        );
      }
      const size = Money.max(Money.fromString('1'), sizeRaw.total.roundToDollar());
      const fpl = Money.fromString(fed.ptc.fpl_base).add(
        Money.fromString(fed.ptc.fpl_per_additional).mulRate(size.sub(Money.fromString('1')).toString()),
      );
      // §36B(d)(2)(B): household income is MAGI — AGI PLUS tax-exempt interest
      // (plus excluded foreign income and nontaxable SS, still a recorded gap).
      // Using bare AGI understated the applicable percentage and, just under
      // the 400%-FPL cliff, could understate repayment by thousands.
      const ptcExemptInt = Money.max(Money.zero(), sumOfConcept(input, C.TAX_EXEMPT_INTEREST).total.roundToDollar());
      const ptcMagi = agiFact.value.add(ptcExemptInt);
      const income = Money.max(Money.zero(), ptcMagi);
      const pct = income.mulFraction('100', fpl.toString()); // audit-allow: percent-of-FPL base, not a dollar figure
      const cliff = Money.fromString(fed.ptc.cliff_pct);
      const aptcAmt = aptc.total.roundToDollar();
      const ptcSteps = [
        `household income = AGI ${agiFact.value.toString()} + tax-exempt interest ${ptcExemptInt.toString()} = ${ptcMagi.toString()} (§36B(d)(2)(B); excluded foreign income and nontaxable SS remain a recorded gap)`,
        `FPL(household of ${size.toString()}) = ${fpl.toString()} → income at ${pct.toString()}% of FPL`,
      ];
      let ptcAllowed = Money.zero();
      let atCliff = false;
      if (fs === 'mfs') {
        ptcSteps.push('MFS is ineligible for the PTC (§36B(c)(1)(C); abuse/abandonment exception not modeled — recorded gap) → PTC 0; repayment caps still apply');
      } else if (pct.gte(cliff)) {
        atCliff = true;
        ptcSteps.push(`at/above the ${cliff.toString()}% cliff — no credit; APTC repays IN FULL, uncapped (§36B(f); post-2025 regime)`);
      } else {
        const pts = fed.ptc.applicable_points.map((p) => ({ at: Money.fromString(p.at_pct), fig: Money.fromString(p.figure) }));
        const lower = [...pts].reverse().find((p) => p.at.lte(pct));
        const upper = pts.find((p) => p.at.gt(pct));
        const figureM = lower === undefined
          ? pts[0]!.fig
          : upper === undefined
            ? lower.fig
            : lower.fig.add(upper.fig.sub(lower.fig).mulFraction(pct.sub(lower.at).toString(), upper.at.sub(lower.at).toString()));
        const contribution = income.mulRate(figureM.toString()).roundToDollar();
        ptcAllowed = Money.max(
          Money.zero(),
          Money.min(premium.total.roundToDollar(), slcsp.total.roundToDollar().sub(contribution)),
        );
        ptcSteps.push(
          `applicable figure ${figureM.toString()} (§36B(b)(3)(A), linear interpolation) → contribution = ${contribution.toString()}`,
          `PTC = max(0, min(premium ${premium.total.roundToDollar().toString()}, SLCSP ${slcsp.total.roundToDollar().toString()} − contribution)) = ${ptcAllowed.toString()}`,
        );
      }
      const ptcInputs = [...premium.inputs, ...slcsp.inputs, ...aptc.inputs, ...sizeRaw.inputs, agiFact];
      if (ptcAllowed.gt(aptcAmt)) {
        ptcNetFact = em.emit({
          concept: C.FED_PTC_NET, jurisdiction: ['FED'], inputs: ptcInputs,
          formula_ref: 'FED.F8962.NET_PTC', rule_version: rvFed,
          steps: [...ptcSteps, `net PTC = ${ptcAllowed.toString()} − APTC ${aptcAmt.toString()} = ${ptcAllowed.sub(aptcAmt).toString()} (8962 line 26 → Sch 3 line 9, refundable)`],
          value: ptcAllowed.sub(aptcAmt),
        });
      } else if (aptcAmt.gt(ptcAllowed)) {
        const excess = aptcAmt.sub(ptcAllowed);
        const capRow = fed.ptc.repayment_caps.find((r) => pct.lte(Money.fromString(r.up_to_pct)));
        const capVal = atCliff || capRow === undefined
          ? null
          : Money.fromString(fs === 'single' || fs === 'mfs' ? capRow.cap_single : capRow.cap_other);
        const repay = capVal === null ? excess : Money.min(excess, capVal);
        ptcRepayFact = em.emit({
          concept: C.FED_PTC_REPAYMENT, jurisdiction: ['FED'], inputs: ptcInputs,
          formula_ref: 'FED.F8962.APTC_REPAYMENT', rule_version: rvFed,
          steps: [...ptcSteps,
            `excess APTC = ${aptcAmt.toString()} − PTC ${ptcAllowed.toString()} = ${excess.toString()}`,
            capVal === null
              ? 'no repayment cap applies (at/above the cliff)'
              : `repayment limited to ${capVal.toString()} (§36B(f)(2)(B) cap for this %FPL/status) → ${repay.toString()}`,
            'repayment → Sch 2 line 2 (part of total tax)'],
          value: repay,
        });
      }
    }
  }

  // ---------- FORM 8959 — ADDITIONAL MEDICARE TAX (P10.1) ----------
  // 0.9% on Medicare wages (W-2 box 5) over the §3101(b)(2) threshold, plus
  // SE net earnings over the wage-reduced threshold (Part II). Part IV
  // reconciles box 6 over-withholding into income-tax withholding (line 25c).
  let addlMedicareFact: TaxFact | null = null;
  let addlMedicareWhFact: TaxFact | null = null;
  {
    const medWages = sumOfConcept(input, C.WAGES_MEDICARE);
    const medWh = sumOfConcept(input, C.MEDICARE_WH);
    if (medWages.inputs.length > 0 || medWh.inputs.length > 0 || seNetEarnings.gt(Money.zero())) {
      // HONESTY GUARD: never silently skip a surtax the facts call for.
      if (!fed.addl_medicare) {
        if (medWages.inputs.length > 0 || medWh.inputs.length > 0) {
          throw new Error('kernel: Medicare wage/withholding facts present but rule data lacks additional_medicare parameters');
        }
      } else {
        const am = fed.addl_medicare;
        const threshold = Money.fromString(am.threshold[fs]);
        const wageExcess = Money.max(Money.zero(), medWages.total.sub(threshold));
        const wageTax = wageExcess.mulRate(am.rate).roundToDollar();
        // Part II: the threshold is first reduced by Medicare wages (8959 line 9).
        const seThreshold = Money.max(Money.zero(), threshold.sub(medWages.total));
        const seExcess = Money.max(Money.zero(), seNetEarnings.sub(seThreshold));
        const seAddl = seExcess.mulRate(am.rate).roundToDollar();
        const total = wageTax.add(seAddl);
        if (total.gt(Money.zero())) {
          addlMedicareFact = em.emit({
            concept: C.FED_ADDL_MEDICARE, jurisdiction: ['FED'],
            inputs: [...medWages.inputs, ...(seTaxFact ? [seTaxFact] : [])],
            formula_ref: 'FED.F8959.TOTAL', rule_version: rvFed,
            steps: [
              `Part I: Medicare wages ${medWages.total.toString()} − threshold(${fs}) ${threshold.toString()} → excess ${wageExcess.toString()} × ${am.rate} = ${wageTax.toString()}`,
              ...(seNetEarnings.gt(Money.zero())
                ? [`Part II: SE net earnings ${seNetEarnings.toString()} − reduced threshold ${seThreshold.toString()} → excess ${seExcess.toString()} × ${am.rate} = ${seAddl.toString()} (RRTA Part III not modeled — recorded gap)`]
                : []),
              `additional_medicare = ${total.toString()} (8959 line 18 → Sch 2 line 11)`,
            ],
            value: total,
          });
        }
        // Part IV: Medicare withholding above the regular 1.45% of box 5 is
        // INCOME-tax withholding — it pays any tax, not just this one.
        if (medWh.inputs.length > 0) {
          const regular = medWages.total.mulRate(am.regular_wh_rate).roundToDollar();
          const addlWh = Money.max(Money.zero(), medWh.total.sub(regular));
          if (addlWh.gt(Money.zero())) {
            addlMedicareWhFact = em.emit({
              concept: C.FED_ADDL_MEDICARE_WH, jurisdiction: ['FED'],
              inputs: [...medWh.inputs, ...medWages.inputs],
              formula_ref: 'FED.F8959.PART_IV', rule_version: rvFed,
              steps: [`box 6 ${medWh.total.toString()} − ${am.regular_wh_rate} × box 5 ${medWages.total.toString()} (= ${regular.toString()}) → additional Medicare withholding ${addlWh.toString()} (8959 line 24 → 1040 line 25c)`],
              value: addlWh,
            });
          }
        }
      }
    }
  }

  // ---------- FORM 8960 — NET INVESTMENT INCOME TAX (P10.2) ----------
  // §1411: 3.8% × min(net investment income, MAGI excess over the statutory
  // threshold). MAGI = AGI here (§911/CFC/PFIC add-backs — recorded gap).
  let niitFact: TaxFact | null = null;
  {
    const schdComponent = capGainLineFact; // 8960 line 5a (a capped loss stays negative)
    const nii = interestTotal.value
      .add(divOrdTotal.value)
      .add(schdComponent.value)
      .add(k1NiitPassiveNet);
    if (nii.gt(Money.zero())) {
      // HONESTY GUARD: investment income exists — the NIIT determination is
      // required, so missing rule data is an error, never a silent skip.
      if (!fed.niit) throw new Error('kernel: investment income present but rule data lacks niit parameters');
      const threshold = Money.fromString(fed.niit.threshold[fs]);
      const magiExcess = Money.max(Money.zero(), agiFact.value.sub(threshold));
      const base = Money.min(nii, magiExcess);
      const tax = base.mulRate(fed.niit.rate).roundToDollar();
      if (tax.gt(Money.zero())) {
        niitFact = em.emit({
          concept: C.FED_NIIT, jurisdiction: ['FED'],
          inputs: [interestTotal, divOrdTotal, schdComponent, ...(scheK1Fact ? [scheK1Fact] : []), agiFact],
          formula_ref: 'FED.F8960.NIIT', rule_version: rvFed,
          steps: [
            `NII = interest ${interestTotal.value.toString()} + ordinary dividends ${divOrdTotal.value.toString()} + net gain ${schdComponent.value.toString()} + passive pass-through ${k1NiitPassiveNet.toString()} = ${nii.toString()} (investment-expense allocations not modeled — recorded gap)`,
            `MAGI ${agiFact.value.toString()} − threshold(${fs}) ${threshold.toString()} → excess ${magiExcess.toString()}`,
            `niit = min(NII, excess) ${base.toString()} × ${fed.niit.rate} = ${tax.toString()} (8960 line 17 → Sch 2 line 12)`,
          ],
          value: tax,
        });
      }
    }
  }

  // Sch 2 Part I (line 3 = 1a APTC repayment; 1b-1y not modeled) → 1040 line 17.
  // Part I rides INTO line 18 (16 + 17), so unused nonrefundable credits can
  // offset it on line 22 — folding it in after credits would overstate tax
  // whenever credits exceed the bracket tax (CPA finding, P11 review).
  let sch2Part1Fact: TaxFact | null = null;
  if (ptcRepayFact !== null) {
    sch2Part1Fact = em.emit({
      concept: C.FED_SCH2_PART1, jurisdiction: ['FED'], inputs: [ptcRepayFact],
      formula_ref: 'FED.SCH2.LINE3', rule_version: rvFed,
      steps: [`Sch 2 line 1a = ${ptcRepayFact.value.toString()} (APTC repayment) → 1z → line 3 → 1040 line 17`],
      value: ptcRepayFact.value,
    });
  }
  const part1Val = sch2Part1Fact ? sch2Part1Fact.value : Money.zero();

  // ---------- FORM 1116 — FOREIGN TAX CREDIT (P18) ----------
  // §901/§904, PASSIVE category. Foreign tax on foreign-source income is
  // creditable only up to the US tax on that same income:
  //   limitation = US tax before credits × (foreign-source taxable income
  //                                          ÷ worldwide taxable income)
  // Amounts arrive in USD — the currency conversion is its own recorded
  // calculation upstream, never a hidden step in here.
  const sourcedCredits = sumOfConcept(input, C.CREDITS_SCH3);
  let ftcFact: TaxFact | null = null;
  {
    // The foreign-currency originals were converted ABOVE (before Schedule D,
    // where the converted income is REPORTED); this block reuses those values
    // to compute the credit. FCY amounts count once: income via Sch D, tax
    // here — while USD foreign.* concepts only characterize income reported
    // elsewhere.
    const foreignTaxSum = sumOfConcept(input, C.FOREIGN_TAX_PAID);
    const foreignTax = {
      total: foreignTaxSum.total.add(convertedTax),
      inputs: [...foreignTaxSum.inputs, ...fcyTax.inputs, ...fxRate.inputs],
    };
    const deMinimisElected = !sumOfConcept(input, C.FTC_DEMINIMIS_ELECTION).total.isZero();
    if (foreignTax.inputs.length > 0 && deMinimisElected) {
      // ---------- §904(j) — CREDIT WITHOUT FORM 1116 ----------
      // The election trades the §904 limitation (and the §904(c) carryover of
      // any excess) for not filing Form 1116. It is available only when every
      // dollar of creditable tax is passive-category income shown on a payee
      // statement AND the total is at or under the statutory ceiling.
      if (!fed.ftc_de_minimis) {
        // HONESTY GUARD: without the ceiling there is nothing to test the
        // election against, and an untested election is an unlimited credit.
        throw new Error(
          'kernel: the §904(j) de minimis election is claimed but rule data lacks ftc_de_minimis parameters',
        );
      }
      const dm = fed.ftc_de_minimis;
      const ceiling = Money.fromString(
        input.ctx.filing_status === 'mfj' || input.ctx.filing_status === 'qss'
          ? dm.limit_mfj
          : dm.limit_other,
      );
      const claimed = foreignTax.total.roundToDollar();
      if (claimed.gt(ceiling)) {
        // HONESTY GUARD: over the ceiling the election is simply unavailable.
        // Silently falling through to Form 1116 would file a return the filer
        // did not choose; silently capping at the ceiling would forfeit the
        // excess. Refuse and make them pick.
        throw new Error(
          `kernel: the §904(j) de minimis election is claimed but creditable foreign tax ${claimed.toString()} exceeds the ${ceiling.toString()} ceiling for this filing status — remove ${C.FTC_DEMINIMIS_ELECTION} and supply foreign-source income (${C.FOREIGN_INCOME}) so Form 1116 can compute the §904 limitation`,
        );
      }
      ftcFact = em.emit({
        concept: C.FED_FTC, jurisdiction: ['FED'],
        inputs: [...foreignTax.inputs, ...sumOfConcept(input, C.FTC_DEMINIMIS_ELECTION).inputs],
        formula_ref: 'FED.SEC904J.ELECTION', rule_version: rvFed,
        steps: [
          ...fxSteps,
          `§904(j) election claimed — no Form 1116 is filed`,
          `creditable foreign tax = ${claimed.toString()}, at or under the ${ceiling.toString()} ceiling for ${input.ctx.filing_status}`,
          `credit = ${claimed.toString()} in full — the §904 limitation does not apply (→ Sch 3 line 1)`,
          'ELECTION CONDITIONS ARE THE FILER\'S ATTESTATION: all foreign-source income must be passive category and reported on a payee statement (1099-DIV/-INT, K-1). §904(j)(3)(A) also forfeits any §904(c) carryback/carryforward — none is emitted here.',
        ],
        value: claimed,
      });
    } else if (foreignTax.inputs.length > 0) {
      const foreignGrossSum = sumOfConcept(input, C.FOREIGN_INCOME);
      const foreignGross = {
        total: foreignGrossSum.total.add(convertedIncome),
        inputs: [...foreignGrossSum.inputs, ...fcyIncome.inputs],
      };
      if (foreignGross.inputs.length === 0) {
        // P73 — a credit with no income to limit it against cannot be computed:
        // the §904 limitation needs foreign-source income. This USED to throw,
        // which blacked out the entire return — federal, Illinois, everything —
        // the moment a brokerage 1099 carrying box 7 foreign tax was uploaded.
        //
        // Refusing is the wrong shape here. Omitting a CREDIT raises tax, so it
        // can never be a windfall; the conservative answer is to compute the
        // return WITHOUT the credit and make the omission loudly visible. (An
        // omitted INCOME item is the opposite — that understates tax, and those
        // guards below still throw.)
        em.emit({
          concept: C.FED_FTC_NOT_CLAIMED, jurisdiction: ['FED'], inputs: foreignTax.inputs,
          formula_ref: 'FED.F1116.NOT_CLAIMED', rule_version: rvFed,
          steps: [
            `${foreignTax.total.roundToDollar().toString()} of foreign tax is NOT being credited: Form 1116 needs foreign-source income (${C.FOREIGN_INCOME}) to compute its §904 limitation, and none was supplied.`,
            `Either supply the foreign-source income, or — if this is small, passive-category tax shown on a payee statement such as 1099-DIV box 7 — claim the §904(j) election (${C.FTC_DEMINIMIS_ELECTION} = 1) to take it in full with no Form 1116.`,
            'The return is computed WITHOUT this credit, so the tax shown is HIGHER than it should be.',
          ],
          value: foreignTax.total.roundToDollar(),
        });
      }
      if (foreignGross.inputs.length === 0) {
        // Skip the Form 1116 computation entirely — flagged above.
      } else {
      const foreignLtcgSum = sumOfConcept(input, C.FOREIGN_INCOME_LTCG);
      const foreignLtcg = {
        total: foreignLtcgSum.total.add(convertedLtcg),
        inputs: [...foreignLtcgSum.inputs, ...fcyLtcg.inputs],
      };
      const topOrdinaryRate = fed.brackets[input.ctx.filing_status].reduce(
        (hi, b) => (Money.fromString(b.rate).gt(Money.fromString(hi)) ? b.rate : hi),
        '0',
      );
      // §904(b)(2)(B): foreign-source income taxed at the preferential
      // capital-gain rates is scaled by rate ÷ top ordinary rate, so the
      // limitation is not inflated by income the US taxed more lightly.
      const ltcgRate = marginalRate(fed.capital_gains_brackets[input.ctx.filing_status], taxableFact.value);
      const ltcgPart = foreignLtcg.total.roundToDollar();
      const scaledLtcg = Money.fromString(topOrdinaryRate).isZero()
        ? ltcgPart
        : ltcgPart.mulFraction(ltcgRate, topOrdinaryRate);
      const adjustedForeign = foreignGross.total.roundToDollar().sub(ltcgPart).add(scaledLtcg).roundToDollar();
      // §904(b)(2)(B)(ii): the SAME rate-differential adjustment applies to
      // ENTIRE taxable income (Form 1116 line 18), not only to the
      // foreign-source numerator. Scaling one side and not the other
      // understates the ratio, the limitation, and therefore the credit —
      // and every dollar of credit lost is a dollar of extra US tax.
      //
      // Verified against a professionally prepared return: taxable income
      // 295,678 with net capital gain 89,824 + qualified dividends 3,857
      // gave line 18 = 239,975, a reduction of 55,703 — exactly
      // (89,824 + 3,857) x (1 - 15/37). Leaving the denominator raw put the
      // credit at 6,118 where the preparer had 7,539.
      const usPreferential = Money.min(
        Money.max(
          Money.zero(),
          capGainLineFact.value.roundToDollar().add(qualDivTotal.value.roundToDollar()),
        ),
        taxableFact.value,
      );
      const worldwideReduction = Money.fromString(topOrdinaryRate).isZero()
        ? Money.zero()
        : usPreferential.sub(usPreferential.mulFraction(ltcgRate, topOrdinaryRate)).roundToDollar();
      const worldwide = Money.max(Money.zero(), taxableFact.value.sub(worldwideReduction));

      // ---------- FORM 1116 PART I, LINES 3 AND 4 ----------
      // Deductions are apportioned AGAINST foreign-source income, which the
      // kernel did not model at all — so the numerator, the limitation and
      // the credit all came out too generous. Verified line-for-line against
      // a professionally prepared Form 1116:
      //
      //   3a  certain itemized deductions          17,144
      //   3d  GROSS foreign source income         106,766
      //   3e  GROSS income from all sources       371,473
      //   3f  3d ÷ 3e                              0.2874
      //   3g  3c × 3f                               4,927
      //   4a  home mortgage interest × 3f           1,053
      //   6   total deductions                      5,980
      //
      // Line 3a is the itemized deductions NOT definitely related to any
      // income: the residence real-estate tax, medical, personal property
      // tax. State INCOME tax is excluded — it is definitely related to the
      // income the state taxed. On that return 3a was 17,144, which is
      // exactly SALT 28,337 less Illinois income tax withheld 11,193, and
      // the kernel already holds the residence property tax as a fact
      // (Schedule A line 5b / Schedule ICR), so nothing new is asked of the
      // operator. When the standard deduction is taken it goes on 3a whole.
      //
      // Line 3e is GROSS, so capital losses netted into the Schedule D line
      // are added back: 328,668 + 42,410 carryovers + 395 short-term loss
      // = 371,473, to the dollar.
      const usesItemized = schaTotalFact !== null
        ? deductionFact.value.eq(schaTotalFact.value.roundToDollar())
        : deductionFact.value.eq(itemizedDirect.total.roundToDollar());
      const notDefinitelyRelated = usesItemized
        ? ilPropTaxFacts.total.roundToDollar()
            .add(schaMedicalAllowed)
            .add(schaPersonalProp.total.roundToDollar())
        : deductionFact.value;
      const grossAllSources = totalIncomeFact.value.add(
        schdGrossPositive === null
          ? Money.zero()
          : Money.max(Money.zero(), schdGrossPositive.sub(capGainLineFact.value)),
      );
      const grossForeign = foreignGross.total.roundToDollar();
      const mortgageForApportionment = schaMortgage.total.roundToDollar()
        .add(schaPoints.total.roundToDollar());
      const apportioned = grossAllSources.gt(Money.zero())
        ? notDefinitelyRelated
            .mulFraction(grossForeign.toString(), grossAllSources.toString())
            .roundToDollar()
        : Money.zero();
      const mortgageApportioned = grossAllSources.gt(Money.zero())
        ? mortgageForApportionment
            .mulFraction(grossForeign.toString(), grossAllSources.toString())
            .roundToDollar()
        : Money.zero();
      const foreignDeductions = apportioned.add(mortgageApportioned);
      const netForeign = Money.max(Money.zero(), adjustedForeign.sub(foreignDeductions));
      const usTaxBefore = taxFact.value.add(part1Val);
      // The ratio is capped at 1: foreign-source income cannot exceed worldwide.
      const cappedForeign = Money.min(netForeign, worldwide);
      const limitation = worldwide.gt(Money.zero())
        ? usTaxBefore.mulFraction(cappedForeign.toString(), worldwide.toString()).roundToDollar()
        : Money.zero();
      const ratio = `${cappedForeign.toString()} ÷ ${worldwide.toString()}`;
      const allowed = Money.min(foreignTax.total.roundToDollar(), limitation);
      ftcFact = em.emit({
        concept: C.FED_FTC, jurisdiction: ['FED'],
        inputs: [...foreignTax.inputs, ...foreignGross.inputs, ...foreignLtcg.inputs, taxFact, taxableFact],
        formula_ref: 'FED.F1116.LINE33', rule_version: rvFed,
        steps: [
          ...fxSteps,
          `foreign tax paid (line 8) = ${foreignTax.total.roundToDollar().toString()}`,
          `foreign-source income (line 1a) = ${foreignGross.total.roundToDollar().toString()}${
            ltcgPart.isZero()
              ? ''
              : `, of which long-term capital gain ${ltcgPart.toString()} is scaled by ${ltcgRate} ÷ ${topOrdinaryRate} = ${scaledLtcg.toString()} (§904(b)(2)(B) rate differential)`
          }`,
          `deductions apportioned to foreign income (Part I): ${notDefinitelyRelated.toString()} ${usesItemized ? 'of itemized deductions not definitely related (residence real-estate tax, medical, personal property — state INCOME tax is excluded, being definitely related to the income the state taxed)' : '(standard deduction)'} × ${grossForeign.toString()} ÷ ${grossAllSources.toString()} gross income from all sources = ${apportioned.toString()} (line 3g)${mortgageForApportionment.isZero() ? '' : `, plus home mortgage interest ${mortgageForApportionment.toString()} × the same ratio = ${mortgageApportioned.toString()} (line 4a)`} → total ${foreignDeductions.toString()} (line 6)`,
          `net foreign-source taxable income (line 7) = ${adjustedForeign.toString()} − ${foreignDeductions.toString()} = ${netForeign.toString()}`,
          `adjusted foreign-source taxable income (line 17) = ${netForeign.toString()}`,
          `worldwide taxable income (line 18) = ${worldwide.toString()}${
            worldwideReduction.isZero()
              ? ''
              : ` (taxable income ${taxableFact.value.toString()} reduced by ${worldwideReduction.toString()} — the same §904(b)(2)(B) rate differential applied to US net capital gain + qualified dividends ${usPreferential.toString()})`
          }; ratio (line 19) = ${ratio}`,
          `limitation (line 21) = US tax before credits ${usTaxBefore.toString()} × ratio = ${limitation.toString()}`,
          `credit (line 35) = min(foreign tax, limitation) = ${allowed.toString()} (→ Sch 3 line 1)`,
          'SIMPLIFIED: passive category only; deductions allocable to foreign income are not modeled; the rate differential uses the marginal preferential rate rather than splitting across rate buckets (recorded gaps)',
        ],
        value: allowed,
      });
      const unusedFtc = foreignTax.total.roundToDollar().sub(allowed);
      if (unusedFtc.gt(Money.zero())) {
        em.emit({
          concept: C.FED_FTC_UNUSED, jurisdiction: ['FED'], inputs: [ftcFact],
          formula_ref: 'FED.F1116.CARRYOVER', rule_version: rvFed,
          steps: [
            `unused foreign tax ${unusedFtc.toString()} — §904(c) carries back 1 year and forward 10; the carryback/forward register is a recorded gap (informational here)`,
          ],
          value: unusedFtc,
        });
      }
      }
    }
  }

  // ---------- FORM 5695 — RESIDENTIAL CLEAN ENERGY CREDIT (P12.1) ----------
  // §25D: 30% of qualified solar cost, nonrefundable, limited to the tax
  // ---------- FORM 2441 — child and dependent care credit (P50) ----------
  // §21: expenses are capped by the number of qualifying persons AND by the
  // §21(d) earned-income limit, then multiplied by a rate that starts at
  // rate_max and steps down over AGI to a rate_min floor. Nonrefundable
  // (ARPA's 2021 refundable expansion expired) → Sch 3 line 2.
  let depCareFact: TaxFact | null = null;
  {
    const expenses = sumOfConcept(input, C.DEPCARE_EXPENSES);
    if (expenses.inputs.length > 0 && !expenses.total.isZero()) {
      if (!fed.dependent_care) {
        throw new Error('kernel: dependent-care expenses present but rule data lacks dependent_care parameters');
      }
      const dc = fed.dependent_care;
      // §21(e)(2): MFS may not claim the credit (the §7703(b) living-apart
      // exception is NOT modelled — a filer who qualifies must claim it
      // outside TaxOS). Refusing is the safe direction.
      if (fs === 'mfs') {
        throw new Error(
          'kernel: dependent-care expenses present on a married-filing-separately return — §21(e)(2) bars the credit (the §7703(b) living-apart exception is not modelled)',
        );
      }
      const persons = sumOfConcept(input, C.DEPCARE_PERSONS);
      // §21(b)(1): there is no credit without a qualifying individual. Refuse
      // rather than silently granting the one-person cap on a zero count.
      if (persons.inputs.length === 0 || persons.total.isZero()) {
        throw new Error(
          'kernel: dependent-care expenses present but credit.dependent_care.qualifying_persons is missing or zero — §21(b)(1) allows no credit without a qualifying individual',
        );
      }
      const multiple = persons.total.gt(Money.fromString('1'));
      const rawCap = Money.fromString(multiple ? dc.max_expenses_two_or_more : dc.max_expenses_one_person);
      // Form 2441 Part III / §129: employer-provided dependent care benefits
      // excluded from income (W-2 box 10) REDUCE the dollar cap. A $5,000 FSA
      // against the $3,000 one-person cap leaves nothing to claim — omitting
      // this was the largest overstatement in the credit, and a dependent-care
      // FSA is the common case in exactly the households that have expenses.
      const dcb = sumOfConcept(input, C.DEPCARE_EMPLOYER_BENEFITS);
      const dcbVal = Money.max(Money.zero(), dcb.total.roundToDollar());
      const expenseCap = Money.max(Money.zero(), rawCap.sub(dcbVal));
      const eiLimit = sumOfConcept(input, C.DEPCARE_EARNED_INCOME_LIMIT);
      let allowedExpenses = Money.min(Money.max(Money.zero(), expenses.total.roundToDollar()), expenseCap);
      const dcSteps = [
        ...expenses.steps,
        ...dcb.steps,
        ...(dcbVal.isZero()
          ? []
          : [`Part III §129: dollar cap ${rawCap.toString()} − employer dependent care benefits ${dcbVal.toString()} (W-2 box 10) = ${expenseCap.toString()}`]),
        `2441 line 3 = min(expenses ${expenses.total.toString()}, cap ${expenseCap.toString()} for ${multiple ? '2 or more' : 'one'} qualifying person(s)) = ${allowedExpenses.toString()}`,
      ];
      if (eiLimit.inputs.length > 0) {
        const capped = Money.min(allowedExpenses, eiLimit.total.roundToDollar());
        dcSteps.push(`lines 4–5 §21(d) earned-income limit ${eiLimit.total.toString()} → ${capped.toString()}`);
        allowedExpenses = capped;
      } else {
        // §21(d) caps expenses at earned income (the LOWER of the spouses' on a
        // joint return). A missing figure is NOT evidence that it does not
        // bind — guessing in the taxpayer's favour here is exactly what the
        // statute exists to prevent. The credit is still computed so the return
        // stays workable, but the assumption is recorded as a fact the
        // ACC-DEPCARE-EARNED-INCOME critic turns into a visible Warning.
        const attested = !sumOfConcept(input, C.DEPCARE_EARNED_INCOME_NOT_LIMITING).total.isZero();
        dcSteps.push(
          attested
            ? 'lines 4–5 §21(d): you confirmed both spouses\u2019 earned income exceeded these expenses, so the limit does not bind'
            : 'lines 4–5 §21(d) earned-income limit NOT supplied and NOT attested — the credit below assumes it does not bind, which may overstate it',
        );
        if (!attested) {
          em.emit({
            concept: C.FED_DEPCARE_EI_UNVERIFIED, jurisdiction: ['FED'], inputs: expenses.inputs,
            formula_ref: 'FED.F2441.LINE4_5.UNVERIFIED', rule_version: rvFed,
            steps: ['§21(d) earned-income limit neither supplied nor attested — flagged for review'],
            value: Money.fromString('1'),
          });
        }
      }
      // Rate step-down: one step per WHOLE-OR-PART increment of AGI over the
      // start. Counted by accumulating Money (never native division — money
      // math stays in decimal.js), and stopped as soon as the reduction
      // reaches the rate_max→rate_min spread, so the loop is bounded.
      const over = Money.max(Money.zero(), agiFact.value.sub(Money.fromString(dc.phasedown_agi_start)));
      const stepAmt = Money.fromString(dc.phasedown_agi_step);
      const perStep = Money.fromString(dc.phasedown_rate_per_step);
      const spread = Money.max(Money.zero(), Money.fromString(dc.rate_max).sub(Money.fromString(dc.rate_min)));
      const one = Money.fromString('1');
      let steps = Money.zero();
      let covered = Money.zero();
      let reduction = Money.zero();
      if (!stepAmt.isZero() && !perStep.isZero()) {
        while (covered.lt(over) && reduction.lt(spread)) {
          steps = steps.add(one);
          covered = covered.add(stepAmt);
          reduction = reduction.add(perStep);
        }
      }
      const rate = Money.max(Money.fromString(dc.rate_min), Money.fromString(dc.rate_max).sub(reduction));
      const tentative = allowedExpenses.mulRate(rate.toString()).roundToDollar();
      // Nonrefundable: limited to the tax remaining after the credits already taken.
      // Form 2441 Credit Limit Worksheet: 1040 line 18 MINUS Schedule 3 line 1
      // (the foreign tax credit) only — NOT the rest of Schedule 3. §21 sits on
      // Sch 3 line 2, ahead of the other nonrefundable credits.
      const ftcVal0 = ftcFact ? ftcFact.value : Money.zero();
      const room = Money.max(Money.zero(), taxFact.value.add(part1Val).sub(ftcVal0));
      const allowed = Money.min(tentative, room);
      dcSteps.push(
        `line 8 rate = max(${dc.rate_min}, ${dc.rate_max} − ${dc.phasedown_rate_per_step} × ${steps.toString()} step(s) of ${dc.phasedown_agi_step} over AGI ${dc.phasedown_agi_start}) = ${rate.toString()}`,
      );
      dcSteps.push(`line 9 = ${allowedExpenses.toString()} × ${rate.toString()} = ${tentative.toString()}`);
      dcSteps.push(`line 11 = min(tentative, tax remaining ${room.toString()}) = ${allowed.toString()} (nonrefundable → Sch 3 line 2)`);
      depCareFact = em.emit({
        concept: C.FED_DEPCARE_CREDIT, jurisdiction: ['FED'],
        inputs: [...expenses.inputs, ...persons.inputs, ...eiLimit.inputs, taxFact],
        formula_ref: 'FED.F2441.LINE11', rule_version: rvFed,
        steps: dcSteps,
        value: allowed,
      });
    }
  }

  // available after the OTHER Sch 3 credits (5695 credit-limit worksheet,
  // simplified to this model's credit set). 2025 is the FINAL year (OBBBA
  // §70506 terminates §25D for expenditures after 2025-12-31 — verify).
  let solarCreditFact: TaxFact | null = null;
  {
    const solarCost = sumOfConcept(input, C.SOLAR_COST);
    if (solarCost.inputs.length > 0) {
      // HONESTY GUARD: never silently skip a credit the facts call for.
      if (!fed.residential_clean_energy) {
        throw new Error('kernel: solar installation cost present but rule data lacks residential_clean_energy parameters');
      }
      const rate = fed.residential_clean_energy.rate;
      const tentative = solarCost.total.mulRate(rate).roundToDollar();
      const ftcVal = ftcFact ? ftcFact.value : Money.zero();
      const available = Money.max(Money.zero(), taxFact.value.add(part1Val).sub(sourcedCredits.total).sub(ftcVal).sub(depCareFact ? depCareFact.value : Money.zero()));
      const allowed = Money.min(tentative, available);
      solarCreditFact = em.emit({
        concept: C.FED_SOLAR_CREDIT, jurisdiction: ['FED'],
        inputs: [...solarCost.inputs, taxFact],
        formula_ref: 'FED.F5695.LINE15', rule_version: rvFed,
        steps: [
          `5695 line 13 = cost ${solarCost.total.toString()} × ${rate} = ${tentative.toString()} (§25D(a); 2025 is the final year — OBBBA §70506)`,
          `line 14 limitation = tax available after other credits${ftcFact ? ` (including the ${ftcFact.value.toString()} foreign tax credit, which is taken first)` : ''} = ${available.toString()} (credit-limit worksheet, simplified to this model's credit set)`,
          `line 15 = min → ${allowed.toString()} (→ Sch 3 line 5a)`,
        ],
        value: allowed,
      });
      const unused = tentative.sub(allowed);
      if (unused.gt(Money.zero())) {
        em.emit({
          concept: C.FED_SOLAR_UNUSED, jurisdiction: ['FED'], inputs: [solarCreditFact],
          formula_ref: 'FED.F5695.LINE16', rule_version: rvFed,
          steps: [`unused ${unused.toString()} — §25D(c) carryforward; usability after 2025 is unresolved post-termination (IRS guidance pending), NOT rolled to a register (recorded gap)`],
          value: unused,
        });
      }
    }
  }

  // credits (Sch 3) → 1040 line 22 = max(0, line 18 − line 21)
  const solarVal = solarCreditFact ? solarCreditFact.value : Money.zero();
  const creditsTotal = em.emit({
    concept: C.FED_CREDITS_TOTAL,
    jurisdiction: ['FED'],
    inputs: [...sourcedCredits.inputs, ...(ftcFact ? [ftcFact] : []), ...(depCareFact ? [depCareFact] : []), ...(solarCreditFact ? [solarCreditFact] : [])],
    formula_ref: 'FED.1040.CREDITS_TOTAL',
    rule_version: rvFed,
    steps: [
      ...sourcedCredits.steps,
      ...(ftcFact ? [`credits += ${ftcFact.value.toString()} (Form 1116 foreign tax credit → Sch 3 line 1)`] : []),
      ...(depCareFact ? [`credits += ${depCareFact.value.toString()} (Form 2441 child and dependent care → Sch 3 line 2)`] : []),
      ...(solarCreditFact ? [`credits += ${solarVal.toString()} (Form 5695 residential clean energy → Sch 3 line 5a)`] : []),
    ],
    value: sourcedCredits.total.add(ftcFact ? ftcFact.value : Money.zero()).add(depCareFact ? depCareFact.value : Money.zero()).add(solarVal),
  });
  // 1040 line 18 (= 16 + 17) — the other addition box the form prints.
  em.emit({
    concept: C.FED_TAX_PLUS_SCH2_PART1, jurisdiction: ['FED'],
    inputs: [taxFact, ...(sch2Part1Fact ? [sch2Part1Fact] : [])],
    formula_ref: 'FED.1040.LINE18.TAX_PLUS_SCH2_PART1', rule_version: rvFed,
    steps: [`line 18 = tax ${taxFact.value.toString()} + Sch 2 line 3 ${part1Val.toString()}`],
    value: taxFact.value.add(part1Val),
  });
  const taxAfterCreditsFact = em.emit({
    concept: C.FED_TAX_AFTER_CREDITS,
    jurisdiction: ['FED'],
    inputs: [taxFact, ...(sch2Part1Fact ? [sch2Part1Fact] : []), creditsTotal],
    formula_ref: 'FED.1040.TAX_AFTER_CREDITS',
    rule_version: rvFed,
    steps: [
      `line 18 = tax ${taxFact.value.toString()}${sch2Part1Fact ? ` + Sch 2 line 3 ${part1Val.toString()}` : ''}`,
      `line 22 = max(0, ${taxFact.value.add(part1Val).toString()} − credits ${creditsTotal.value.toString()})`,
    ],
    value: Money.max(Money.zero(), taxFact.value.add(part1Val).sub(creditsTotal.value)),
  });

  // payments = withholding + estimated + refundable net PTC (1040 line 31)
  // + additional Medicare withholding (8959 line 24 → 1040 line 25c)
  const fedWhTotal = componentOf(C.FED_WITHHOLDING, C.FED_WH_TOTAL, ['FED'], rvFed);
  const fedEstTotal = componentOf(C.FED_ESTIMATED, C.FED_EST_TOTAL, ['FED'], rvFed);
  const ptcNetVal = ptcNetFact ? ptcNetFact.value : Money.zero();
  const addlWhVal = addlMedicareWhFact ? addlMedicareWhFact.value : Money.zero();
  // 1040 line 25d = 25a (W-2) + 25c (Form 8959); 25b 1099-withholding is a
  // recorded gap. Emitted so the printed form's total line is a real fact.
  const whCombinedFact = em.emit({
    concept: C.FED_WH_COMBINED, jurisdiction: ['FED'],
    inputs: [fedWhTotal, ...(addlMedicareWhFact ? [addlMedicareWhFact] : [])],
    formula_ref: 'FED.1040.LINE25D', rule_version: rvFed,
    steps: [`line 25d = 25a ${fedWhTotal.value.toString()}${addlMedicareWhFact ? ` + 25c ${addlWhVal.toString()}` : ''} (25b 1099 withholding — recorded gap)`],
    value: fedWhTotal.value.add(addlWhVal),
  });
  const fedPaymentsFact = em.emit({
    concept: C.FED_PAYMENTS,
    jurisdiction: ['FED'],
    inputs: [whCombinedFact, fedEstTotal, ...(ptcNetFact ? [ptcNetFact] : [])],
    terms: [
      { fact: whCombinedFact, sign: 1 as const },
      { fact: fedEstTotal, sign: 1 as const },
      ...(ptcNetFact ? [{ fact: ptcNetFact, sign: 1 as const }] : []),
    ],
    formula_ref: 'FED.1040.PAYMENTS',
    rule_version: rvFed,
    steps: [`payments = 25d ${whCombinedFact.value.toString()} + estimated ${fedEstTotal.value.toString()}${ptcNetFact ? ` + net PTC ${ptcNetVal.toString()} (refundable, Sch 3 line 9)` : ''}`],
    value: whCombinedFact.value.add(fedEstTotal.value).add(ptcNetVal),
  });

  // Sch 2 Part II (line 21: SE tax + 8959 + NIIT) → 1040 line 23. The APTC
  // repayment is a Part I item and NEVER re-enters here (the old single
  // grand total mapped to line 21 double-counted it — CPA finding).
  // Form 5329 Part I — §72(t) additional tax on early retirement
  // distributions (Sch 2 line 8). The exceptions in §72(t)(2) are
  // fact-specific, so the INPUT is Form 5329 line 3: the amount subject to the
  // tax after whatever exceptions apply. TaxOS applies only the rate.
  let earlyDistFact: TaxFact | null = null;
  {
    const subject = sumOfConcept(input, C.EARLY_DIST_SUBJECT);
    if (subject.inputs.length > 0 && !subject.total.isZero()) {
      if (!fed.early_distribution) {
        throw new Error('kernel: early-distribution amount present but rule data lacks early_distribution parameters');
      }
      const rate = fed.early_distribution.rate;
      const amount = Money.max(Money.zero(), subject.total.roundToDollar()); // never a negative tax
      earlyDistFact = em.emit({
        concept: C.FED_EARLY_DIST_TAX, jurisdiction: ['FED'], inputs: subject.inputs,
        formula_ref: 'FED.F5329.PART1', rule_version: rvFed,
        steps: [
          ...subject.steps,
          `5329 line 4 = ${amount.toString()} × ${rate} = ${amount.mulRate(rate).roundToDollar().toString()} (§72(t)(1); the line-3 amount is already net of any §72(t)(2) exception you qualify for → Sch 2 line 8)`,
        ],
        value: amount.mulRate(rate).roundToDollar(),
      });
    }
  }
  const part2Facts = [
    ...(seTaxFact ? [seTaxFact] : []),
    ...(addlMedicareFact ? [addlMedicareFact] : []),
    ...(niitFact ? [niitFact] : []),
    ...(earlyDistFact ? [earlyDistFact] : []),
    ...(hsaExciseFact ? [hsaExciseFact] : []),
    ...(iraExciseFact ? [iraExciseFact] : []),
    ...(sepExciseFact ? [sepExciseFact] : []),
  ];
  let sch2Part2Fact: TaxFact | null = null;
  if (part2Facts.length > 0) {
    sch2Part2Fact = em.emit({
      concept: C.FED_SCH2_PART2, jurisdiction: ['FED'], inputs: part2Facts,
      formula_ref: 'FED.SCH2.LINE21', rule_version: rvFed,
      steps: part2Facts.map((f) => `sch2 line 21 += ${f.value.toString()} (${f.concept})`),
      value: Money.sum(part2Facts.map((f) => f.value)),
    });
  }
  const part2Val = sch2Part2Fact ? sch2Part2Fact.value : Money.zero();

  // Sch 2 grand total (Part I + Part II) — internal reconciliation line.
  const otherTaxFacts = [...(sch2Part1Fact ? [sch2Part1Fact] : []), ...(sch2Part2Fact ? [sch2Part2Fact] : [])];
  if (otherTaxFacts.length > 0) {
    em.emit({
      concept: C.FED_SCH2_TOTAL, jurisdiction: ['FED'], inputs: otherTaxFacts,
      formula_ref: 'FED.SCH2.TOTAL', rule_version: rvFed,
      steps: otherTaxFacts.map((f) => `sch2 += ${f.value.toString()} (${f.concept})`),
      value: Money.sum(otherTaxFacts.map((f) => f.value)),
    });
  }

  // total liability (1040 line 24) = line 22 + line 23 (Part I is already
  // inside line 22 via line 18 — adding it again would double-count).
  const totalLiabilityFact = em.emit({
    concept: C.FED_TOTAL_TAX_LIABILITY,
    jurisdiction: ['FED'],
    inputs: [taxAfterCreditsFact, ...(sch2Part2Fact ? [sch2Part2Fact] : [])],
    formula_ref: 'FED.1040.TOTAL_TAX',
    rule_version: rvFed,
    steps: [`total_tax (line 24) = line 22 ${taxAfterCreditsFact.value.toString()} + line 23 ${part2Val.toString()}`],
    value: taxAfterCreditsFact.value.add(part2Val),
  });

  // refund (+) or balance due (−)
  const refundFact = em.emit({
    concept: C.FED_REFUND_OR_DUE,
    jurisdiction: ['FED'],
    inputs: [fedPaymentsFact, totalLiabilityFact],
    terms: [{ fact: fedPaymentsFact, sign: 1 as const }, { fact: totalLiabilityFact, sign: -1 as const }],
    formula_ref: 'FED.1040.REFUND_OR_DUE',
    rule_version: rvFed,
    steps: [`refund_or_due = payments ${fedPaymentsFact.value.toString()} − total_tax ${totalLiabilityFact.value.toString()}`],
    value: fedPaymentsFact.value.sub(totalLiabilityFact.value),
  });

  // 1040 line 38 — the Form 2210 penalty for underpayment of estimated tax.
  // It is REAL money owed on top of the tax, so the amount you actually pay is
  // the refund/due line NET of it. The IRS invites you to let it figure the
  // penalty and bill you, so this is an entered figure, not a computed one.
  const fedPenalty = sumOfConcept(input, C.FED_EST_TAX_PENALTY);
  const fedPenaltyVal = Money.max(Money.zero(), fedPenalty.total); // a penalty never increases a refund
  em.emit({
    concept: C.FED_NET_AMOUNT_DUE,
    jurisdiction: ['FED'],
    inputs: [refundFact, ...fedPenalty.inputs],
    formula_ref: 'FED.1040.NET_AMOUNT_DUE',
    rule_version: rvFed,
    steps: [
      ...fedPenalty.steps,
      fedPenaltyVal.isZero()
        ? `net = ${refundFact.value.toString()} (no Form 2210 estimated-tax penalty entered)`
        : `net = ${refundFact.value.toString()} − Form 2210 penalty ${fedPenaltyVal.toString()} = ${refundFact.value.sub(fedPenaltyVal).toString()} (positive = refund, negative = you owe)`,
    ],
    value: refundFact.value.sub(fedPenaltyVal),
  });

  // ---------- ILLINOIS (starts from federal AGI) ----------

  // Sch M subtractions: concepts listed in IL rule data (SS + most retirement NOT taxed)
  const subtractionParts = il.sch_m_subtraction_concepts.map((concept) => sumOfConcept(input, concept));
  const subtractionsFact = em.emit({
    concept: C.IL_SUBTRACTIONS,
    jurisdiction: ['IL'],
    inputs: subtractionParts.flatMap((p) => p.inputs),
    formula_ref: 'IL.SCH_M.SUBTRACTIONS',
    rule_version: rvIl,
    steps: subtractionParts.flatMap((p) => p.steps),
    value: Money.sum(subtractionParts.map((p) => p.total)),
  });

  // IL decoupling (Form IL-4562): when federal bonus is claimed at less
  // than 100%, IL requires an ADDITION of the bonus and allows a
  // SUBTRACTION of the regular depreciation that would have applied to the
  // bonus basis. At a 100% federal rate IL conforms — no adjustment.
  const bonusDecoupled = ilBonusClaimed.gt(Money.zero()) &&
    (fed.depreciation ? Money.fromString(fed.depreciation.bonus_rate).lt(Money.fromString('1')) : false);
  let ilAdditionsFact: TaxFact | null = null;
  let ilDepSubFact: TaxFact | null = null;
  if (bonusDecoupled) {
    ilAdditionsFact = em.emit({
      concept: C.IL_ADDITIONS,
      jurisdiction: ['IL'],
      inputs: [],
      formula_ref: 'IL.IL4562.BONUS_ADDBACK',
      rule_version: rvIl,
      steps: [`il_addition = federal §168(k) bonus claimed ${ilBonusClaimed.toString()} (Form IL-4562 Step 2 — IL decouples from sub-100% bonus)`],
      value: ilBonusClaimed,
    });
    ilDepSubFact = em.emit({
      concept: C.IL_DEP_SUBTRACTION,
      jurisdiction: ['IL'],
      inputs: [ilAdditionsFact],
      formula_ref: 'IL.IL4562.ASIF_DEPRECIATION',
      rule_version: rvIl,
      steps: [`il_subtraction = as-if regular MACRS on the bonus basis = ${ilBonusAsIfMacrs.toString()} (Form IL-4562 Step 3, year 1; later years via depreciation register)`],
      value: ilBonusAsIfMacrs,
    });
  }
  // IL-1040 line 2: federally tax-exempt interest/dividends are ADDED BACK to
  // Illinois income (35 ILCS 5/203(a)(2)(A)). The portion from Illinois or US
  // government obligations is subtractable on Sch M — that runs through the
  // rule-data's sch_m_subtraction_concepts list, so only the net is taxed.
  // The exempt slice is computed HERE, coupled to the add-back, rather than
  // riding the generic sch_m_subtraction_concepts list. Every other entry in
  // that list is already inside federal AGI; this one is not, so leaving it
  // there let a filer claim the subtraction with NO add-back and drop Illinois
  // income by money that was never in it. It is now capped at the add-back.
  const exemptInterest = sumOfConcept(input, C.TAX_EXEMPT_INTEREST);
  const exemptObligations = sumOfConcept(input, C.IL_EXEMPT_OBLIGATIONS);
  let ilExemptIntFact: TaxFact | null = null;
  if (!exemptInterest.total.isZero() || exemptObligations.inputs.length > 0) {
    const addBack = Money.max(Money.zero(), exemptInterest.total.roundToDollar());
    const claimed = Money.max(Money.zero(), exemptObligations.total.roundToDollar());
    const exemptSlice = Money.min(claimed, addBack); // never subtract more than was added
    const netAddition = addBack.sub(exemptSlice);
    const exSteps = [
      ...exemptInterest.steps,
      ...exemptObligations.steps,
      `IL-1040 line 2 add-back = federally tax-exempt interest ${addBack.toString()} (Illinois taxes it)`,
    ];
    if (!claimed.isZero()) {
      exSteps.push(
        claimed.gt(addBack)
          ? `Sch M exempt-obligation subtraction ${claimed.toString()} CAPPED at the add-back ${addBack.toString()} — you cannot subtract more Illinois-exempt interest than you added back`
          : `Sch M exempt-obligation subtraction ${exemptSlice.toString()} (specific Illinois obligations held directly — IDOR Pub 101)`,
      );
    }
    exSteps.push(`net Illinois addition = ${addBack.toString()} − ${exemptSlice.toString()} = ${netAddition.toString()}`);
    ilExemptIntFact = em.emit({
      concept: C.IL_TAX_EXEMPT_ADDBACK,
      jurisdiction: ['IL'],
      inputs: [...exemptInterest.inputs, ...exemptObligations.inputs],
      formula_ref: 'IL.1040.LINE2.TAX_EXEMPT_ADDBACK',
      rule_version: rvIl,
      steps: exSteps,
      value: netAddition,
    });
  }
  const ilAdd = (ilAdditionsFact ? ilAdditionsFact.value : Money.zero())
    .add(ilExemptIntFact ? ilExemptIntFact.value : Money.zero());
  const ilDepSub = ilDepSubFact ? ilDepSubFact.value : Money.zero();
  // IL-1040 line 4 = line 1 (federal AGI) + line 2 (tax-exempt add-back) +
  // line 3 (Sch M additions). A printed IL return needs the subtotal box even
  // though base income is computed straight through.
  em.emit({
    concept: C.IL_TOTAL_INCOME, jurisdiction: ['IL'],
    inputs: [agiFact, ...(ilAdditionsFact ? [ilAdditionsFact] : []), ...(ilExemptIntFact ? [ilExemptIntFact] : [])],
    formula_ref: 'IL.1040.LINE4.TOTAL_INCOME', rule_version: rvIl,
    steps: [`line 4 = federal AGI ${agiFact.value.toString()} + additions ${ilAdd.toString()}`],
    value: agiFact.value.add(ilAdd),
  });
  const ilBaseFact = em.emit({
    concept: C.IL_BASE_INCOME,
    jurisdiction: ['IL'],
    inputs: [agiFact, subtractionsFact, ...(ilAdditionsFact ? [ilAdditionsFact] : []), ...(ilExemptIntFact ? [ilExemptIntFact] : []), ...(ilDepSubFact ? [ilDepSubFact] : [])],
    terms: [
      { fact: agiFact, sign: 1 as const },
      ...(ilAdditionsFact ? [{ fact: ilAdditionsFact, sign: 1 as const }] : []),
      ...(ilExemptIntFact ? [{ fact: ilExemptIntFact, sign: 1 as const }] : []),
      { fact: subtractionsFact, sign: -1 as const },
      ...(ilDepSubFact ? [{ fact: ilDepSubFact, sign: -1 as const }] : []),
    ],
    formula_ref: 'IL.1040.BASE_INCOME',
    rule_version: rvIl,
    steps: [`il_base = fed_agi ${agiFact.value.toString()} + additions ${ilAdd.toString()} − sch_m subtractions ${subtractionsFact.value.toString()} − il_dep_subtraction ${ilDepSub.toString()}`],
    value: agiFact.value.add(ilAdd).sub(subtractionsFact.value).sub(ilDepSub),
  });

  // Exemption allowance (35 ILCS 5/204) = per-person amount × exemption count,
  // PLUS $1,000 per checked age-65/blind box (IL-1040 Step 4 lines 10b/10c —
  // the same boxes that drive the federal §63(f) add-on), and DISALLOWED
  // entirely when federal AGI exceeds the statutory threshold (204(g)).
  // 35 ILCS 5/204(g): the $500,000 threshold applies ONLY to "spouses filing a
  // joint federal tax return". MFS and QSS are NOT joint returns and take the
  // $250,000 threshold — same rule the Schedule ICR cap already follows below.
  const ilExCap = fs === 'mfj' ? il.exemption_disallowed_agi_mfj : il.exemption_disallowed_agi_single;
  const ilExDisallowed = ilExCap !== undefined && agiFact.value.gt(Money.fromString(ilExCap));
  const ilBasePersons = Money.fromString(il.exemption_per_person).mulRate(String(input.ctx.il_exemption_count));
  const ilExBoxes = Math.max(0, Math.trunc(input.ctx.addl_std_boxes));
  const ilExSteps = [
    `exemption = ${il.exemption_per_person} × ${input.ctx.il_exemption_count} persons (rule data) = ${ilBasePersons.toString()}`,
  ];
  let ilExemptionValue = ilBasePersons;
  if (ilExBoxes > 0) {
    if (il.exemption_age_blind_per_box === undefined) {
      throw new Error(
        'IL age/blind exemption boxes were claimed but the IL rule data carries no exemption_age_blind_per_box figure',
      );
    }
    const perBox = Money.fromString(il.exemption_age_blind_per_box);
    const addl = perBox.mulRate(String(ilExBoxes));
    ilExemptionValue = ilExemptionValue.add(addl);
    ilExSteps.push(
      `age 65+ / blind: ${ilExBoxes} box(es) × ${perBox.toString()} (IL-1040 Step 4 lines 10b/10c) = ${addl.toString()}`,
    );
    ilExSteps.push(`exemption allowance = ${ilBasePersons.toString()} + ${addl.toString()} = ${ilExemptionValue.toString()}`);
  }
  if (ilExDisallowed) {
    ilExSteps.push(
      `federal AGI ${agiFact.value.toString()} exceeds ${ilExCap!} — the entire exemption allowance is disallowed (35 ILCS 5/204(g))`,
    );
    ilExemptionValue = Money.zero();
  }
  // IL-1040 line 10a — the per-person exemption alone. Lines 10b/10c carry the
  // 65-or-older and blind add-ons separately on the printed form, so line 10a
  // is NOT the same number as the line-10 allowance whenever a box is ticked.
  em.emit({
    concept: C.IL_EXEMPTION_BASE, jurisdiction: ['IL'],
    inputs: [agiFact], formula_ref: 'IL.1040.LINE10A.EXEMPTION_BASE', rule_version: rvIl,
    steps: [
      `line 10a = ${il.exemption_per_person} × ${input.ctx.il_exemption_count} persons = ${ilBasePersons.toString()}`,
      ...(ilExDisallowed ? [`disallowed in full — federal AGI exceeds ${ilExCap!} (35 ILCS 5/204(g))`] : []),
    ],
    value: ilExDisallowed ? Money.zero() : ilBasePersons,
  });
  const exemptionFact = em.emit({
    concept: C.IL_EXEMPTION,
    jurisdiction: ['IL'],
    inputs: [agiFact],
    formula_ref: 'IL.1040.EXEMPTION',
    rule_version: rvIl,
    steps: ilExSteps,
    value: ilExemptionValue,
  });

  const ilNetFact = em.emit({
    concept: C.IL_NET_INCOME,
    jurisdiction: ['IL'],
    inputs: [ilBaseFact, exemptionFact],
    terms: [{ fact: ilBaseFact, sign: 1 as const }, { fact: exemptionFact, sign: -1 as const }],
    clamp_zero: true,
    formula_ref: 'IL.1040.NET_INCOME',
    rule_version: rvIl,
    steps: [`il_net = max(0, ${ilBaseFact.value.toString()} − ${exemptionFact.value.toString()})`],
    value: Money.max(Money.zero(), ilBaseFact.value.sub(exemptionFact.value)),
  });

  const ilTaxFact = em.emit({
    concept: C.IL_TAX,
    jurisdiction: ['IL'],
    inputs: [ilNetFact],
    formula_ref: 'IL.1040.TAX.FLAT_RATE',
    rule_version: rvIl,
    steps: [`il_tax = ${ilNetFact.value.toString()} × ${il.flat_rate}`],
    value: ilNetFact.value.mulRate(il.flat_rate),
  });

  const ilWhTotal = componentOf(C.IL_WITHHOLDING, C.IL_WH_TOTAL, ['IL'], rvIl);
  const ilEstTotal = componentOf(C.IL_ESTIMATED, C.IL_EST_TOTAL, ['IL'], rvIl);
  const ilPte = sumOfConcept(input, C.IL_PTE_CREDIT);
  const ilPteVal = Money.max(Money.zero(), ilPte.total.roundToDollar());
  const ilPaymentsFact = em.emit({
    concept: C.IL_PAYMENTS,
    jurisdiction: ['IL'],
    inputs: [ilWhTotal, ilEstTotal, ...ilPte.inputs],
    terms: [
      { fact: ilWhTotal, sign: 1 as const },
      { fact: ilEstTotal, sign: 1 as const },
      ...ilPte.inputs.map((f) => ({ fact: f, sign: 1 as const })),
    ],
    formula_ref: 'IL.1040.PAYMENTS',
    rule_version: rvIl,
    steps: [
      ...ilPte.steps,
      `il_payments = withholding ${ilWhTotal.value.toString()} + estimated ${ilEstTotal.value.toString()}${ilPteVal.isZero() ? '' : ` + pass-through entity tax credit ${ilPteVal.toString()} (Sch K-1-P/K-1-T → line 28)`}`,
    ],
    value: ilWhTotal.value.add(ilEstTotal.value).add(ilPteVal),
  });

  // ---------- Schedule ICR: property-tax credit (P9.1) ----------
  // 35 ILCS 5/208: 5% of principal-residence property tax, NONREFUNDABLE
  // (capped at IL tax); P.A. 100-0022 AGI caps (500k joint / 250k other).
  // QSS note: the joint cap applies only to a joint return — QSS uses the
  // other-filers cap here (recorded for rule authoring to confirm).
  let ilCreditFact: TaxFact | null = null;
  {
    const propTax = sumOfConcept(input, C.IL_PROPERTY_TAX);
    if (propTax.inputs.length > 0) {
      if (!il.icr) throw new Error('kernel: IL property-tax facts present but rule data lacks icr parameters');
      const cap = Money.fromString(fs === 'mfj' ? il.icr.agi_cap_joint : il.icr.agi_cap_single);
      const eligible = agiFact.value.lte(cap);
      // Schedule ICR lines 4a/4f print WHOLE DOLLARS — the kernel owns the
      // rounding (the mapping layer refuses cent-carrying values), so the
      // rounded paid amount is emitted as its own line fact.
      const propTaxRounded = propTax.total.roundToDollar();
      em.emit({
        concept: C.IL_ICR_PROPTAX_PAID,
        jurisdiction: ['IL'],
        inputs: [...propTax.inputs],
        formula_ref: 'IL.SCH_ICR.LINE4A',
        rule_version: rvIl,
        steps: [`property tax paid on the principal residence = ${propTax.total.toString()} → ${propTaxRounded.toString()} (whole dollars on the form)`],
        value: propTaxRounded,
      });
      const raw = propTaxRounded.mulRate(il.icr.property_tax_credit_rate).roundToDollar();
      const credit = eligible ? Money.min(raw, Money.max(Money.zero(), ilTaxFact.value)) : Money.zero();
      ilCreditFact = em.emit({
        concept: C.IL_ICR_CREDIT,
        jurisdiction: ['IL'],
        inputs: [...propTax.inputs, agiFact, ilTaxFact],
        formula_ref: 'IL.SCH_ICR.PROPERTY_TAX_CREDIT',
        rule_version: rvIl,
        steps: [
          `property tax paid ${propTax.total.roundToDollar().toString()} × ${il.icr.property_tax_credit_rate} = ${raw.toString()} (35 ILCS 5/208)`,
          eligible
            ? `AGI ${agiFact.value.toString()} ≤ cap ${cap.toString()} → credit = min(${raw.toString()}, IL tax ${ilTaxFact.value.toString()}) = ${credit.toString()} (nonrefundable)`
            : `AGI ${agiFact.value.toString()} exceeds the ${cap.toString()} cap (P.A. 100-0022) → credit 0`,
        ],
        value: credit,
      });
    }
  }
  const ilCreditVal = ilCreditFact ? ilCreditFact.value : Money.zero();
  // IL-1040 line 15 (Sch CR) — tax paid to another state while an IL resident.
  const ilOtherState = sumOfConcept(input, C.IL_OTHER_STATE_CREDIT);
  const ilOtherStateVal = Money.max(Money.zero(), ilOtherState.total.roundToDollar());
  // IL-1040 line 21 — use tax on out-of-state purchases ("do not leave blank").
  const ilUseTax = sumOfConcept(input, C.IL_USE_TAX);
  const ilUseTaxVal = Money.max(Money.zero(), ilUseTax.total.roundToDollar());
  // Line 18: nonrefundable credits can never exceed the tax on line 14.
  const ilNonrefundable = Money.min(ilTaxFact.value, ilOtherStateVal.add(ilCreditVal));
  const ilAfterCreditsFact = em.emit({
    concept: C.IL_TAX_AFTER_CREDITS,
    jurisdiction: ['IL'],
    inputs: [ilTaxFact, ...(ilCreditFact ? [ilCreditFact] : []), ...ilOtherState.inputs, ...ilUseTax.inputs],
    formula_ref: 'IL.1040.TAX_AFTER_CREDITS',
    rule_version: rvIl,
    steps: [
      ...ilOtherState.steps,
      // Line 18 caps the nonrefundable credits at the tax — they can never
      // create a refund. Use tax is an OTHER tax and rides on line 21, so it
      // must NOT be folded in here: this line is IL-1040 line 19.
      `il line 18 credits = min(tax ${ilTaxFact.value.toString()}, other-state ${ilOtherStateVal.toString()} + icr ${ilCreditVal.toString()}) = ${ilNonrefundable.toString()}`,
      `il line 19 tax after nonrefundable credits = ${ilTaxFact.value.toString()} − ${ilNonrefundable.toString()} = ${Money.max(Money.zero(), ilTaxFact.value.sub(ilNonrefundable)).toString()}`,
    ],
    value: Money.max(Money.zero(), ilTaxFact.value.sub(ilNonrefundable)),
  });

  // IL-1040 line 23 — TOTAL tax = line 19 + use tax (line 21). Kept as its own
  // concept so line 19 keeps its own meaning on the printed form.
  const ilTotalTaxFact = em.emit({
    concept: C.IL_TOTAL_TAX,
    jurisdiction: ['IL'],
    inputs: [ilAfterCreditsFact, ...ilUseTax.inputs],
    formula_ref: 'IL.1040.TOTAL_TAX',
    rule_version: rvIl,
    steps: [
      ...ilUseTax.steps,
      `il line 23 total tax = line 19 ${ilAfterCreditsFact.value.toString()} + use tax ${ilUseTaxVal.toString()} = ${ilAfterCreditsFact.value.add(ilUseTaxVal).toString()}`,
    ],
    value: ilAfterCreditsFact.value.add(ilUseTaxVal),
  });

  const ilRefundFact = em.emit({
    concept: C.IL_REFUND_OR_DUE,
    jurisdiction: ['IL'],
    inputs: [ilPaymentsFact, ilTotalTaxFact],
    terms: [{ fact: ilPaymentsFact, sign: 1 as const }, { fact: ilTotalTaxFact, sign: -1 as const }],
    formula_ref: 'IL.1040.REFUND_OR_DUE',
    rule_version: rvIl,
    steps: [`il_refund_or_due = payments ${ilPaymentsFact.value.toString()} − total tax (line 23) ${ilTotalTaxFact.value.toString()}`],
    value: ilPaymentsFact.value.sub(ilTotalTaxFact.value),
  });

  // IL-1040 line 34/36 — the IL-2210 late-payment penalty for underpayment of
  // estimated tax; line 41 adds it to the amount owed. Entered, like the
  // federal one (IDOR also offers to figure it and bill you).
  const ilPenalty = sumOfConcept(input, C.IL_EST_TAX_PENALTY);
  const ilPenaltyVal = Money.max(Money.zero(), ilPenalty.total);
  em.emit({
    concept: C.IL_NET_AMOUNT_DUE,
    jurisdiction: ['IL'],
    inputs: [ilRefundFact, ...ilPenalty.inputs],
    formula_ref: 'IL.1040.NET_AMOUNT_DUE',
    rule_version: rvIl,
    steps: [
      ...ilPenalty.steps,
      ilPenaltyVal.isZero()
        ? `net = ${ilRefundFact.value.toString()} (no IL-2210 late-payment penalty entered)`
        : `net = ${ilRefundFact.value.toString()} − IL-2210 penalty ${ilPenaltyVal.toString()} = ${ilRefundFact.value.sub(ilPenaltyVal).toString()} (positive = refund, negative = you owe)`,
    ],
    value: ilRefundFact.value.sub(ilPenaltyVal),
  });

  return { computedFacts: em.facts, calculations: em.calculations };
}
