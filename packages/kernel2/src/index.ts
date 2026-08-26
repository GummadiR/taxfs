/**
 * kernel2 — the Gate-7 INDEPENDENT calculator (ARCHITECTURE §7).
 *
 * A deliberately separate, straight-line reimplementation of the headline
 * lines: total income, AGI, taxable income, federal tax (incl. capital-gain
 * stacking), SE tax, total liability, payments, refund/owe, and the IL
 * result. Shares ONLY `@taxfs/shared` (Money + signed rule data) with the
 * main kernel — importing `@taxfs/kernel` here is forbidden (enforced by
 * the isolation test). Divergence from the kernel on any golden return is a
 * red build; at runtime it is Gate 7's hard block.
 *
 * Style is intentionally different from the kernel: one pass, plain sums,
 * no emitter/DAG — so a bug must be made twice to survive.
 */
import { Money, type FilingStatus, type RuleSet, type BracketRow } from '@taxfs/shared';

export interface SimpleFact {
  concept: string;
  value: string; // decimal string
  taxpayer_scope?: string;
}

export interface Kernel2Input {
  facts: SimpleFact[]; // sourced, confirmed facts ONLY
  filing_status: FilingStatus;
  il_exemption_count: number;
  /** §63(f) age-65/blind additional-standard-deduction boxes checked (0–4). */
  addl_std_boxes: number;
  fed_rules: RuleSet;
  il_rules: RuleSet;
}

export interface HeadlineLines {
  total_income: string;
  agi: string;
  taxable_income: string;
  fed_tax_total: string; // ordinary + capgain (pre-credit)
  se_tax: string;
  total_liability: string;
  fed_payments: string;
  fed_refund_or_due: string;
  il_tax: string;
  il_refund_or_due: string;
  /** Bottom lines NET of the entered Form 2210 / IL-2210 penalties. */
  fed_net_amount_due: string;
  il_net_amount_due: string;
}

const D = (s: string): Money => Money.fromString(s);
const R = (m: Money): Money => m.roundToDollar();

function sum(facts: SimpleFact[], concept: string): Money {
  return Money.sum(facts.filter((f) => f.concept === concept).map((f) => R(D(f.value))));
}

function bracket(rows: BracketRow[], amount: Money): Money {
  let tax = Money.zero();
  let lower = Money.zero();
  for (const row of rows) {
    if (amount.lte(lower)) break;
    const upper = row.up_to === null ? amount : Money.min(amount, D(row.up_to));
    if (upper.gt(lower)) tax = tax.add(upper.sub(lower).mulRate(row.rate));
    if (row.up_to === null) break;
    lower = D(row.up_to);
  }
  return tax;
}

function stackedCapGain(rows: BracketRow[], ordinaryTop: Money, taxable: Money): Money {
  let tax = Money.zero();
  let lower = Money.zero();
  for (const row of rows) {
    const upper = row.up_to === null ? taxable : Money.min(taxable, D(row.up_to));
    const from = Money.max(lower, ordinaryTop);
    if (upper.gt(from)) tax = tax.add(upper.sub(from).mulRate(row.rate));
    if (row.up_to === null) break;
    lower = D(row.up_to);
  }
  return tax;
}

/** Tentative profit (pre-8829): gross − returns − cogs − expenses − vehicle − startup − non-§179 depreciation − §179 allocation. */
function businessTentative(facts: SimpleFact[], entity: string, rules: RuleSet, sec179Alloc: Money): Money {
  const schc = rules.fed!.schc!;
  const f = (field: string): Money => sum(facts, `schc.${entity}.${field}`);
  let expenses = Money.zero();
  for (const fact of facts) {
    const m = /^schc\.([a-z0-9][a-z0-9_-]*)\.expense\.([a-z_]+)$/.exec(fact.concept);
    if (!m || m[1] !== entity) continue;
    const raw = R(D(fact.value));
    expenses = expenses.add(m[2] === 'meals' ? R(raw.mulRate(schc.meals_deductible_rate)) : raw);
  }
  const vehicle = R(f('vehicle.business_miles').mulRate(schc.standard_mileage_rate));

  let startup = Money.zero();
  const startupTotal = f('startup_costs_total');
  if (startupTotal.gt(Money.zero())) {
    const over = Money.max(Money.zero(), startupTotal.sub(D(schc.startup_phaseout_threshold)));
    const firstYear = Money.max(Money.zero(), Money.min(D(schc.startup_expense_cap).sub(over), startupTotal));
    const months = Money.min(Money.max(Money.zero(), f('startup_amort_months')), D(schc.startup_amortization_months));
    const amort = startupTotal.sub(firstYear).mulFraction(months.toString(), schc.startup_amortization_months);
    startup = R(firstYear.add(amort));
  }

  // other (non-§179) depreciation for this entity's assets
  const dep = rules.fed!.depreciation;
  let otherDep = Money.zero();
  if (dep) {
    for (const asset of assetsOf(facts, entity)) {
      const a = assetInputs(facts, entity, asset);
      const after179 = a.basis.sub(a.sec179);
      const bonus = R(after179.mulRate(dep.bonus_rate));
      const macrs1 = R(after179.sub(bonus).mulRate(dep.macrs_hy[a.life]![0]!));
      otherDep = otherDep.add(bonus).add(macrs1);
    }
  }

  return f('gross_receipts').sub(f('returns_allowances')).sub(f('cogs'))
    .sub(expenses).sub(vehicle).sub(startup).sub(otherDep).sub(sec179Alloc);
}

/** Net profit of one business, straight-line (meals/§195/8829/vehicle/4562). */
function business(facts: SimpleFact[], entity: string, rules: RuleSet, sec179Alloc: Money): Money {
  const schc = rules.fed!.schc!;
  const f = (field: string): Money => sum(facts, `schc.${entity}.${field}`);
  const tentative = businessTentative(facts, entity, rules, sec179Alloc);

  // Form 8829: greater of simplified vs actual, capped by tentative profit.
  let homeOffice = Money.zero();
  const hoSqFt = f('homeoffice.sq_ft');
  if (hoSqFt.gt(Money.zero())) {
    const limit = Money.max(Money.zero(), tentative);
    const simplified = R(Money.min(hoSqFt, D(schc.homeoffice_simplified_sqft_cap)).mulRate(schc.homeoffice_simplified_rate));
    const homeSqFt = f('homeoffice.home_sq_ft');
    const share = homeSqFt.isZero()
      ? Money.zero()
      : f('homeoffice.home_expenses_total').mulFraction(hoSqFt.toString(), homeSqFt.toString());
    const actual = R(share.add(f('homeoffice.carryover_prior')));
    homeOffice = Money.max(Money.min(actual, limit), Money.min(simplified, limit));
  }
  return R(tentative.sub(homeOffice));
}

function entitiesOf(facts: SimpleFact[]): string[] {
  return [...new Set(
    facts.map((f) => /^schc\.([a-z0-9][a-z0-9_-]*)\./.exec(f.concept)?.[1]).filter((e): e is string => !!e),
  )].sort();
}

function assetsOf(facts: SimpleFact[], entity: string): string[] {
  return [...new Set(
    facts
      .filter((f) => f.taxpayer_scope === `entity:${entity}` && f.concept.startsWith('dep.'))
      .map((f) => /^dep\.([a-z0-9][a-z0-9_-]*)\./.exec(f.concept)?.[1])
      .filter((a): a is string => !!a),
  )].sort();
}

function assetInputs(facts: SimpleFact[], entity: string, asset: string) {
  const scoped = facts.filter((f) => f.taxpayer_scope === `entity:${entity}`);
  const g = (field: string): Money => sum(scoped, `dep.${asset}.${field}`);
  const basis = g('basis');
  return { basis, sec179: Money.min(g('sec179'), basis), life: g('life_years').toString() };
}

interface K1Result { scheTotal: Money; qbiNet: Money; niitPassiveNet: Money; f4797Total: Money }

/** Sum of positive k1.<id>.capital_gain amounts (feeds Sch D LT; gains only,
 *  matching the kernel's recorded gap for K-1 capital losses). */
function k1CapGainTotal(facts: SimpleFact[]): Money {
  const byId = new Map<string, Money>();
  for (const f of facts) {
    const m = /^k1\.([a-z0-9][a-z0-9_-]*)\.capital_gain$/.exec(f.concept);
    if (m) byId.set(m[1]!, (byId.get(m[1]!) ?? Money.zero()).add(Money.fromString(f.value)));
  }
  return Money.sum([...byId.values()].map((v) => Money.max(Money.zero(), R(v))));
}

/** Inbound K-1s straight-line: basis limit (incl. S-corp debt basis), then
 *  the Form 8582 activity model — losses (basis-allowed + prior unallowed)
 *  deduct up to aggregate passive income; the unallowed remainder is borne
 *  by overall-loss activities pro-rata (Part VII), cumulative rounding.
 *  Ordering: basis → passive. K-1 capital gains are passive income here but
 *  land on Sch D, not Sch E. */
function inboundK1s(
  facts: SimpleFact[],
  fs: FilingStatus,
  fed: NonNullable<RuleSet['fed']>,
  magiBase: Money,
): K1Result | null {
  const ids = [...new Set(
    facts.map((f) => /^k1\.([a-z0-9][a-z0-9_-]*)\./.exec(f.concept)?.[1]).filter((x): x is string => !!x),
  )].sort();
  if (ids.length === 0) return null;
  const rows = ids.map((id) => {
    const g = (field: string): Money => sum(facts, `k1.${id}.${field}`);
    const f4797 = g('f4797'); // P41 — 4797 stream shares the limits, reports on Sch 1 line 4
    const income = g('box1').add(g('box2')).add(f4797);
    const pos = Money.max(Money.zero(), income);
    const loss = Money.max(Money.zero(), income.neg());
    const loss4797 = loss.isZero() ? Money.zero() : Money.min(loss, Money.max(Money.zero(), f4797.neg()));
    const pos4797 = Money.max(Money.zero(), f4797);
    const scorp = !g('is_scorp').isZero();
    const passive = g('material_participation').isZero();
    const rentalActive = passive && !g('rental_active').isZero();
    const cg = Money.max(Money.zero(), R(g('capital_gain')));
    const basisBefore = g('basis_opening').add(g('contributions'))
      .add(scorp ? Money.zero() : g('liab_change')).add(pos).add(cg).sub(g('distributions'));
    const stockUsed = Money.min(loss, Money.max(Money.zero(), basisBefore));
    const debtUsed = scorp ? Money.min(loss.sub(stockUsed), g('debt_basis_opening')) : Money.zero();
    const allowed = stockUsed.add(debtUsed);
    const pool = passive ? allowed.add(Money.max(Money.zero(), R(g('passive_carryover')))) : allowed;
    const qbiEligible = !facts.some((f) => f.concept === `k1.${id}.qbi_eligible` && Money.fromString(f.value).isZero());
    // §199A amount as reported on the K-1 statement, when supplied.
    const qbiReported = facts.some((f) => f.concept === `k1.${id}.qbi_amount`)
      ? sum(facts, `k1.${id}.qbi_amount`)
      : null;
    // Guaranteed payments (partnerships only): outside basis/passive limits;
    // never QBI (§199A(c)(4)(B)).
    const gp = scorp ? Money.zero() : Money.max(Money.zero(), R(g('guaranteed_payment')));
    // §469(g): entire interest disposed of in a fully taxable transaction.
    const disposed = !g('disposed_entire_interest').isZero();
    // A carryover on a NONPASSIVE activity never joined the pool above; it is
    // held until §469(f)(1)(A) or §469(g) frees it.
    const held = passive ? Money.zero() : Money.max(Money.zero(), R(g('passive_carryover')));
    return { id, pos, cg, gp, allowed, pool, passive, qbiEligible, qbiReported, rentalActive, loss, loss4797, pos4797, disposed, held };
  });
  type Row = (typeof rows)[number];
  const passiveRows = rows.filter((r) => r.passive);
  const incomeOf = (r: Row): Money => r.pos.add(r.cg);
  const overallOf = (r: Row): Money => Money.max(Money.zero(), r.pool.sub(incomeOf(r)));
  const unallowedTotal = Money.max(
    Money.zero(),
    Money.sum(passiveRows.map((r) => r.pool)).sub(Money.sum(passiveRows.map(incomeOf))),
  );
  const bearers = passiveRows.filter((r) => overallOf(r).gt(Money.zero()));
  const overallTotal = Money.sum(bearers.map(overallOf));
  const cumTo = (n: number): Money =>
    overallTotal.isZero()
      ? Money.zero()
      : unallowedTotal
          .mulFraction(Money.sum(bearers.slice(0, n).map(overallOf)).toString(), overallTotal.toString())
          .roundToDollar();
  const suspended = new Map<string, Money>();
  // Pairwise cumulative bounds without native index arithmetic (banned here):
  // bounds = [cumTo(0)..cumTo(n)], each bearer takes bounds[i+1]-bounds[i]
  // via a shifted slice.
  const bearerBounds = [...bearers.map((_, i) => cumTo(i)), cumTo(bearers.length)];
  const bearerNext = bearerBounds.slice(1);
  bearers.forEach((r, i) => suspended.set(r.id, bearerNext[i]!.sub(bearerBounds[i]!)));
  // P41 — §469(i): free rental-with-active-participation suspended losses up
  // to the phased-out special allowance; MAGI = nonpassive income base.
  const rentals = bearers.filter((r) => r.rentalActive);
  const rentalSusp = Money.sum(rentals.map((r) => suspended.get(r.id) ?? Money.zero()));
  if (rentalSusp.gt(Money.zero())) {
    const p469 = fed.sec469i;
    if (!p469) throw new Error('kernel2: rental-active loss present but rule data lacks sec469i parameters');
    const nonpassiveNet = Money.sum(rows.filter((r) => !r.passive).map((r) => r.pos.add(r.gp).sub(r.allowed)));
    const magi = R(magiBase.add(nonpassiveNet));
    const cap = fs === 'mfs' ? Money.zero() : D(p469.allowance);
    const phased = Money.max(
      Money.zero(),
      cap.sub(Money.max(Money.zero(), magi.sub(D(p469.phaseout_start))).mulRate(p469.phaseout_rate)),
    ).roundToDollar();
    const allowanceUsed = Money.min(phased, rentalSusp);
    if (allowanceUsed.gt(Money.zero())) {
      const freeTo = (n: number): Money =>
        allowanceUsed
          .mulFraction(
            Money.sum(rentals.slice(0, n).map((r) => suspended.get(r.id) ?? Money.zero())).toString(),
            rentalSusp.toString(),
          )
          .roundToDollar();
      const rentalBounds = [...rentals.map((_, i) => freeTo(i)), freeTo(rentals.length)];
      const rentalNext = rentalBounds.slice(1);
      rentals.forEach((r, i) => {
        suspended.set(r.id, (suspended.get(r.id) ?? Money.zero()).sub(rentalNext[i]!.sub(rentalBounds[i]!)));
      });
    }
  }
  let scheTotal = Money.zero();
  let qbiNet = Money.zero();
  let niitPassiveNet = Money.zero();
  let f4797Total = Money.zero();
  for (const r of rows) {
    // §469(g)(1): a disposed activity bears no suspension — whatever the pool
    // could not absorb is freed. Derived by subtraction so the mirror does not
    // copy the kernel's reassignment.
    const suspRaw = suspended.get(r.id) ?? Money.zero();
    const susp = r.disposed ? suspRaw.sub(suspRaw) : suspRaw;
    const deducted = r.passive ? r.pool.sub(susp) : r.allowed;
    // §469(f)(1)(A) frees a held carryover only against this activity's own
    // income; §469(g) frees all of it. Expressed as "what stays held".
    const stillHeld = r.disposed ? Money.zero() : Money.max(Money.zero(), r.held.sub(r.pos));
    const heldReleased = r.held.sub(stillHeld);
    // P41 — allowed loss splits pro-rata between the Sch E and 4797 streams.
    const allowed4797Loss =
      r.loss4797.gt(Money.zero()) && r.loss.gt(Money.zero()) && deducted.gt(Money.zero())
        ? deducted.mulFraction(r.loss4797.toString(), r.loss.toString()).roundToDollar()
        : Money.zero();
    f4797Total = f4797Total.add(r.pos4797.sub(allowed4797Loss));
    const net = r.pos.sub(r.pos4797).add(r.gp).sub(deducted.sub(allowed4797Loss)).sub(heldReleased);
    scheTotal = scheTotal.add(net);
    if (r.qbiEligible) {
      // Reg. §1.199A-3(b)(1)(iv): the entity-level §199A figure is not this
      // owner's QBI once a basis/§469 limit or a released carryover is in play.
      // Suspension/release in play here means: a §469 amount held back for this
      // activity, a loss the basis limit cut, or a prior-year carryover folded
      // into the pool and released this year.
      const suspInPlay =
        susp.gt(Money.zero()) ||
        r.loss.gt(r.allowed) ||
        r.pool.gt(r.allowed) ||
        heldReleased.gt(Money.zero());
      if (r.qbiReported !== null && suspInPlay) {
        throw new Error(`kernel2: k1.${r.id}.qbi_amount supplied on an activity with a suspension/release — refuse the override`);
      }
      qbiNet = qbiNet.add(r.qbiReported !== null ? r.qbiReported : net.add(r.pos4797.sub(allowed4797Loss)).sub(r.gp));
    }
    // §1411 (8960 line 4a): passive ordinary net — capital gain rides Sch D,
    // guaranteed payments are compensation, never investment income.
    if (r.passive) niitPassiveNet = niitPassiveNet.add(r.pos.sub(deducted));
  }
  return { scheTotal: R(scheTotal), qbiNet: R(qbiNet), niitPassiveNet, f4797Total: R(f4797Total) };
}

interface SchdResult { line7: Money; ncg: Money }

/** Schedule D straight-line: lot netting with §1091 add-back, §1211(b) cap.
 *  `fcy` is converted foreign income from the 15CA/15CB path (P25): reported
 *  here because no US form carries it — LT on Part II, remainder on Part I. */
function scheduleD(
  facts: SimpleFact[],
  fs: FilingStatus,
  rules: RuleSet,
  fcy: { lt: Money; ord: Money } | null,
): SchdResult | null {
  const lotIds = [...new Set(
    facts.map((f) => /^lot\.([a-z0-9][a-z0-9_-]*)\./.exec(f.concept)?.[1]).filter((x): x is string => !!x),
  )].sort();
  const stCo = sum(facts, 'carryover.capital_loss.st');
  const ltCo = sum(facts, 'carryover.capital_loss.lt');
  const k1Cg = k1CapGainTotal(facts);
  if (lotIds.length === 0 && stCo.isZero() && ltCo.isZero() && k1Cg.isZero() && fcy === null) return null;
  const schd = rules.fed!.schd!;
  // Sourced 1099-B net totals FOLD into Part II when the sub-DAG is active
  // (they never activate it alone — the legacy line handles that case);
  // Sch D must carry the whole capital-gain story or line 7 undercounts.
  const legacyNet = sum(facts, 'income.capital_gain.net');
  let st = stCo.neg().add(fcy ? fcy.ord : Money.zero());
  let lt = ltCo.neg().add(k1Cg).add(legacyNet).add(fcy ? fcy.lt : Money.zero()); // K-1 pass-through LT gains (Sch D line 11)
  for (const id of lotIds) {
    const g = (field: string): Money => sum(facts, `lot.${id}.${field}`);
    let gain = g('proceeds').sub(g('basis'));
    const wash = g('wash_disallowed');
    if (gain.isNegative() && wash.gt(Money.zero())) gain = gain.add(Money.min(wash, gain.neg()));
    if (g('term').isZero()) st = st.add(gain);
    else lt = lt.add(gain);
  }
  const combined = st.add(lt);
  const cap = D(fs === 'mfs' ? schd.capital_loss_cap_mfs : schd.capital_loss_cap);
  const line7 = combined.isNegative() ? Money.max(combined, cap.neg()) : combined;
  const ncg = Money.max(Money.zero(), Money.max(Money.zero(), lt).sub(Money.max(Money.zero(), st.neg())));
  return { line7: R(line7), ncg: R(ncg) };
}

export function computeHeadlines(input: Kernel2Input): HeadlineLines {
  const fed = input.fed_rules.fed!;
  const il = input.il_rules.il!;
  const facts = input.facts;
  const fs = input.filing_status;

  const wages = sum(facts, 'income.wages');
  const interest = sum(facts, 'income.interest');
  const divOrd = sum(facts, 'income.dividends.ordinary');
  const divQual = sum(facts, 'income.dividends.qualified');
  const capGainLegacy = sum(facts, 'income.capital_gain.net');
  // P25 — FCY foreign income (the 15CA/15CB path) is converted here and
  // REPORTED through Schedule D: LT portion on Part II, remainder on Part I
  // (ordinary rates). Mirrors the kernel; USD foreign.* concepts stay
  // characterization-only of income reported elsewhere.
  const fxRows = facts.filter((f) => f.concept === 'foreign.fx.units_per_usd');
  const fx = (concept: string): Money => {
    const fcy = sum(facts, concept);
    if (fcy.isZero()) return Money.zero();
    if (fxRows.length !== 1 || D(fxRows[0]!.value).isZero()) {
      throw new Error('kernel2: foreign-currency amounts need exactly one non-zero exchange rate');
    }
    return R(fcy.mulFraction('1', fxRows[0]!.value));
  };
  if (sum(facts, 'foreign.income.passive.ltcg.foreign_currency').gt(sum(facts, 'foreign.income.passive.foreign_currency'))) {
    throw new Error('kernel2: the long-term portion of foreign income exceeds the total foreign income');
  }
  const fcyIncomeUsd = fx('foreign.income.passive.foreign_currency');
  const fcyLtcgUsd = fx('foreign.income.passive.ltcg.foreign_currency');
  const fcyTaxUsd = fx('foreign.tax_paid.foreign_currency');
  const schd = scheduleD(
    facts, fs, input.fed_rules,
    fcyIncomeUsd.isZero() ? null : { lt: fcyLtcgUsd, ord: fcyIncomeUsd.sub(fcyLtcgUsd) },
  );
  const capGain = schd ? schd.line7 : capGainLegacy;
  const retirement = sum(facts, 'income.retirement');

  // ---- businesses: §179 first (needs aggregate pre-§179 income), then nets
  const entities = entitiesOf(facts);
  let sec179Total = Money.zero();
  const alloc = new Map<string, Money>();
  const dep = fed.depreciation;
  if (entities.length > 0 && dep) {
    const requests = entities.map((e) => ({
      e,
      req: Money.sum(assetsOf(facts, e).map((a) => assetInputs(facts, e, a).sec179)),
    }));
    const requested = Money.sum(requests.map((r) => r.req));
    if (requested.gt(Money.zero())) {
      const placed = Money.sum(entities.flatMap((e) => assetsOf(facts, e).map((a) => assetInputs(facts, e, a).basis)));
      const cap = Money.max(Money.zero(), D(dep.sec179_cap).sub(Money.max(Money.zero(), placed.sub(D(dep.sec179_phaseout_threshold)))));
      // §179(b)(3) income limit: pre-§179, pre-8829 business income + W-2
      // wages (Reg. §1.179-2(c)(6)(iv)) — same base the kernel uses.
      const preSec179 = Money.sum(entities.map((e) => businessTentative(facts, e, input.fed_rules, Money.zero())));
      const incomeLimit = Money.max(Money.zero(), preSec179.add(wages));
      sec179Total = R(Money.min(Money.min(requested, cap), incomeLimit));
      // Cumulative rounding over the global sorted asset order — grouping-
      // invariant, so per-entity sums here equal the kernel's per-asset sums.
      const orderedAssets = entities.flatMap((e) =>
        assetsOf(facts, e).map((a) => ({ e, req: assetInputs(facts, e, a).sec179 })),
      );
      const cumTo = (n: number): Money =>
        sec179Total
          .mulFraction(Money.sum(orderedAssets.slice(0, n).map((x) => x.req)).toString(), requested.toString())
          .roundToDollar();
      const assetBounds = [...orderedAssets.map((_, i) => cumTo(i)), cumTo(orderedAssets.length)];
      const assetNext = assetBounds.slice(1);
      orderedAssets.forEach((row, i) => {
        const share = assetNext[i]!.sub(assetBounds[i]!);
        alloc.set(row.e, (alloc.get(row.e) ?? Money.zero()).add(share));
      });
    }
  }
  const schcNet = Money.sum(entities.map((e) => business(facts, e, input.fed_rules, alloc.get(e) ?? Money.zero())));

  // ---- SE tax
  let seTax = Money.zero();
  let seDeduction = Money.zero();
  let seNetEarnings = Money.zero(); // Sch SE line 6, carried out for Form 8959 Part II
  if (entities.length > 0 && schcNet.gt(Money.zero())) {
    const se = fed.se!;
    const netEarnings = R(schcNet.mulRate(se.net_earnings_factor));
    if (netEarnings.gte(D(se.se_tax_floor))) { // §6017 floor
      const ssRoom = Money.max(Money.zero(), D(se.ss_wage_base).sub(sum(facts, 'income.wages.ss')));
      seTax = R(Money.min(netEarnings, ssRoom).mulRate(se.ss_rate).add(netEarnings.mulRate(se.medicare_rate)));
      seDeduction = R(seTax.mulRate('0.5'));
      seNetEarnings = netEarnings;
    }
  }

  const magiBase = wages.add(interest).add(divOrd).add(capGain).add(retirement)
    .add(entities.length ? schcNet : Money.zero());
  const k1 = inboundK1s(facts, fs, fed, magiBase);
  // P97 — §402(g)/§408(p) mirror: per-person deferral limits with both
  // catch-up tiers; the excess is INCOME (line 1h). SEP mirror: Pub 560
  // reduced-rate worksheet on net SE earnings, §415(c) cap, §4972 excise.
  let deferralExcess = Money.zero();
  let sepDeduction = Money.zero();
  let sepExcise = Money.zero();
  {
    const dPeople = [
      { def: sum(facts, 'contrib.401k.deferral.tp'), simple: sum(facts, 'contrib.simple.deferral.tp'), c50: sum(facts, 'contrib.ira.catch_up.tp'), c60: sum(facts, 'contrib.401k.catch_up_60_63.tp') },
      { def: sum(facts, 'contrib.401k.deferral.sp'), simple: sum(facts, 'contrib.simple.deferral.sp'), c50: sum(facts, 'contrib.ira.catch_up.sp'), c60: sum(facts, 'contrib.401k.catch_up_60_63.sp') },
    ];
    const sepContrib = sum(facts, 'contrib.sep.employer');
    if (dPeople.some((pp) => !pp.def.isZero() || !pp.simple.isZero()) || !sepContrib.isZero()) {
      const rc = fed.retirement_contributions;
      if (!rc) throw new Error('kernel2: employer-plan contributions present but rule data lacks retirement_contributions parameters');
      for (const pp of dPeople) {
        const aggregate = pp.def.add(pp.simple);
        if (aggregate.isZero()) continue;
        const catchUp = !pp.c60.isZero() ? D(rc.elective_deferral.catch_up_60_63) : !pp.c50.isZero() ? D(rc.elective_deferral.catch_up_50) : Money.zero();
        const aggExcess = Money.max(Money.zero(), aggregate.sub(D(rc.elective_deferral.limit).add(catchUp)));
        const simpleCatch = !pp.c60.isZero() ? D(rc.simple.catch_up_60_63) : !pp.c50.isZero() ? D(rc.simple.catch_up_50) : Money.zero();
        const simpleExcess = Money.max(Money.zero(), pp.simple.sub(D(rc.simple.limit).add(simpleCatch)));
        deferralExcess = deferralExcess.add(Money.max(aggExcess, simpleExcess));
      }
      deferralExcess = R(deferralExcess);
      if (!sepContrib.isZero()) {
        const base = Money.max(Money.zero(), seNetEarnings.sub(seDeduction));
        const ratePct = D(rc.sep.compensation_rate).mulRate('100').roundToDollar().toString(); // audit-allow: percent base (ratio scaffolding), not a dollar figure
        const denomPct = D(rc.sep.compensation_rate).mulRate('100').add(D('100')).roundToDollar().toString(); // audit-allow: percent base (ratio scaffolding), not a dollar figure
        const cap = Money.min(R(base.mulFraction(ratePct, denomPct)), D(rc.sep.annual_additions_limit));
        sepDeduction = R(Money.min(sepContrib, cap));
        sepExcise = R(Money.max(Money.zero(), sepContrib.sub(cap)).mulRate(rc.sep.nondeductible_excise_rate));
      }
    }
  }
  const totalIncome = wages.add(interest).add(divOrd).add(capGain).add(retirement)
    .add(entities.length ? schcNet : Money.zero()).add(k1 ? k1.scheTotal : Money.zero())
    .add(k1 ? k1.f4797Total : Money.zero()).add(deferralExcess);
  // P94 — Form 8889 HSA mirror: deduction for direct contributions up to the
  // coverage-based §223 limit net of employer money; excess carries the §4973
  // 6% excise. Independent restatement of the kernel's 8889 block.
  let hsaDeduction = Money.zero();
  let hsaExcise = Money.zero();
  {
    const employer = sum(facts, 'contrib.hsa.employer');
    const direct = sum(facts, 'contrib.hsa.direct');
    if (!employer.isZero() || !direct.isZero()) {
      const rc = fed.retirement_contributions;
      if (!rc) throw new Error('kernel2: HSA contributions present but rule data lacks retirement_contributions parameters');
      const family = !sum(facts, 'contrib.hsa.family_coverage').isZero();
      const catchCount = Math.min(2, Math.max(0, Math.trunc(Number(sum(facts, 'contrib.hsa.catch_up_count').toString()))));
      const limit = D(family ? rc.hsa.limit_family : rc.hsa.limit_self_only)
        .add(D(rc.hsa.catch_up).mulRate(String(catchCount)));
      hsaDeduction = R(Money.min(direct, Money.max(Money.zero(), limit.sub(employer))));
      hsaExcise = R(Money.max(Money.zero(), employer.add(direct).sub(limit)).mulRate(rc.excess_contribution_excise_rate));
    }
  }
  // P95 — Traditional IRA mirror: per-person §219 limits and catch-ups, the
  // §219(g) phase-out worksheet (round UP to $10, $200 floor), compensation
  // cap, excess → §4973 excise. Independent restatement of the kernel block.
  let iraDeduction = Money.zero();
  let iraExcise = Money.zero();
  {
    const people = [
      { trad: sum(facts, 'contrib.ira.traditional.tp'), roth: sum(facts, 'contrib.ira.roth.tp'), catch: sum(facts, 'contrib.ira.catch_up.tp'), covered: sum(facts, 'w2.box13.retirement_plan.tp') },
      { trad: sum(facts, 'contrib.ira.traditional.sp'), roth: sum(facts, 'contrib.ira.roth.sp'), catch: sum(facts, 'contrib.ira.catch_up.sp'), covered: sum(facts, 'w2.box13.retirement_plan.sp') },
    ];
    if (people.some((pp) => !pp.trad.isZero() || !pp.roth.isZero())) {
      const rc = fed.retirement_contributions;
      if (!rc) throw new Error('kernel2: IRA contributions present but rule data lacks retirement_contributions parameters');
      const preIraAgi = totalIncome.sub(sum(facts, 'adjustments.sch1.total')).sub(seDeduction).sub(hsaDeduction);
      const compensation = wages.add(Money.max(Money.zero(), seNetEarnings.sub(seDeduction)));
      const anyCovered = people.some((pp) => !pp.covered.isZero());
      const married = fs === 'mfj' || fs === 'qss';
      const phased = (personLimit: Money, magi: Money, range: { start: string; end: string }): Money => {
        const start = D(range.start);
        const end = D(range.end);
        if (magi.gte(end)) return Money.zero();
        if (magi.lte(start)) return personLimit;
        const frac = personLimit.mulFraction(end.sub(magi).toString(), end.sub(start).toString());
        return Money.min(personLimit, Money.max(D(rc.ira.reduced_limit_floor), frac.mulFraction('1', '10').roundUpToDollar().mulRate('10')));
      };
      let perLimitExcess = Money.zero();
      let contribAll = Money.zero();
      for (const pp of people) {
        const combined = pp.trad.add(pp.roth);
        if (combined.isZero()) continue;
        contribAll = contribAll.add(combined);
        const personLimit = D(rc.ira.limit).add(pp.catch.isZero() ? Money.zero() : D(rc.ira.catch_up));
        const tradExcess = Money.max(Money.zero(), pp.trad.sub(personLimit));
        const rothRoom = Money.max(Money.zero(), phased(personLimit, preIraAgi, rc.ira.roth_phaseout[fs]).sub(pp.trad));
        perLimitExcess = perLimitExcess.add(tradExcess).add(Money.max(Money.zero(), pp.roth.sub(rothRoom)));
        const selfCovered = !pp.covered.isZero();
        const spouseCovered = anyCovered && !selfCovered;
        let range: { start: string; end: string } | null = null;
        if (selfCovered) range = rc.ira.deduction_phaseout[fs];
        else if (spouseCovered && married) range = rc.ira.deduction_phaseout.mfj_spouse_covered;
        else if (spouseCovered && fs === 'mfs') range = rc.ira.deduction_phaseout.mfs;
        const dedBase = Money.min(pp.trad, personLimit);
        const allowed = range === null ? dedBase : Money.min(dedBase, phased(personLimit, preIraAgi, range));
        iraDeduction = iraDeduction.add(R(Money.min(dedBase, allowed)));
      }
      const compExcess = Money.max(Money.zero(), contribAll.sub(perLimitExcess).sub(compensation));
      iraExcise = R(perLimitExcess.add(compExcess).mulRate(rc.excess_contribution_excise_rate));
    }
  }
  const agi = totalIncome.sub(sum(facts, 'adjustments.sch1.total')).sub(seDeduction).sub(hsaDeduction).sub(iraDeduction).sub(sepDeduction);
  // §63(f) age-65/blind add-on: base + boxes × per-box (independent mirror).
  const stdBoxes = Math.max(0, Math.trunc(input.addl_std_boxes));
  const stdMarried = fs === 'mfj' || fs === 'mfs' || fs === 'qss';
  let standardDed = D(fed.standard_deduction[fs]);
  if (stdBoxes > 0) {
    if (!fed.additional_std_deduction) throw new Error('kernel2: age/blind boxes claimed but rule data lacks §63(f) figures');
    const perBox = D(stdMarried ? fed.additional_std_deduction.per_box_married : fed.additional_std_deduction.per_box_unmarried);
    standardDed = standardDed.add(perBox.mulRate(String(stdBoxes)));
  }
  // Schedule A — independent mirror (P67). Built by SUMMING the allowed pieces
  // in a different order from the kernel, and deriving the SALT cap by
  // subtracting the phase-down from the base rather than branching on status
  // first. A hand-computed total and components are mutually exclusive; the
  // kernel refuses that combination, so here components simply win.
  const schaMedicalRaw = R(sum(facts, 'deduction.sch_a.medical'));
  const schaStateOther = R(sum(facts, 'deduction.sch_a.state_tax_other'));
  const schaPersonalProp = R(sum(facts, 'deduction.sch_a.personal_property_tax'));
  const schaMortgage = R(sum(facts, 'deduction.sch_a.mortgage_interest'));
  const schaPoints = R(sum(facts, 'deduction.sch_a.mortgage_points'));
  const schaInvInt = R(sum(facts, 'deduction.sch_a.investment_interest'));
  const schaCharity = R(sum(facts, 'deduction.sch_a.charitable'));
  const hasSchaComponent = !schaMedicalRaw.isZero() || !schaStateOther.isZero() || !schaPersonalProp.isZero()
    || !schaMortgage.isZero() || !schaPoints.isZero() || !schaInvInt.isZero() || !schaCharity.isZero();
  let itemizedTotal = R(sum(facts, 'deduction.itemized.total'));
  if (fed.schedule_a) {
    const sa = fed.schedule_a;
    const isMfs = fs === 'mfs';
    const saltRaw = R(sum(facts, 'payments.il.withholding'))
      .add(R(sum(facts, 'payments.il.estimated')))
      .add(schaStateOther)
      .add(R(sum(facts, 'il.property_tax.residence')))
      .add(schaPersonalProp);
    const baseCap = D(isMfs ? sa.salt_cap_mfs : sa.salt_cap);
    const start = D(isMfs ? sa.salt_phasedown_agi_mfs : sa.salt_phasedown_agi);
    const floorCap = D(isMfs ? sa.salt_cap_floor_mfs : sa.salt_cap_floor);
    const excess = Money.max(Money.zero(), agi.sub(start));
    const cap = Money.max(floorCap, baseCap.sub(R(excess.mulFraction(sa.salt_phasedown_rate, '1'))));
    const saltAllowed = Money.min(R(saltRaw), cap);
    // Same activation rule as the kernel, expressed the other way round:
    // run unless there is neither a component nor a SALT-beats-standard case.
    const worthRunning = hasSchaComponent || saltAllowed.gt(standardDed);
    if (worthRunning) {
      const medFloor = R(agi.mulFraction(sa.medical_agi_floor_pct, '1'));
      const medAllowed = Money.max(Money.zero(), schaMedicalRaw.sub(medFloor));
      itemizedTotal = medAllowed
        .add(saltAllowed)
        .add(schaMortgage).add(schaPoints).add(schaInvInt)
        .add(schaCharity);
    }
  } else if (hasSchaComponent) {
    throw new Error('kernel2: Schedule A components present but rule data lacks schedule_a parameters');
  }
  const deduction = Money.max(standardDed, itemizedTotal);
  const taxableBeforeQbi = Money.max(Money.zero(), agi.sub(deduction));

  // Form 8995 (under-threshold path; over-threshold → 0, matching the kernel).
  // Line 5 (20% × QBI net of the prior carryforward) and line 9 (20% ×
  // REIT/PTP) round separately before line 10 sums them.
  let qbi = Money.zero();
  const qbiCoPrior = sum(facts, 'carryover.qbi');
  const reitPtp = sum(facts, 'income.reit_ptp.qualified');
  if ((entities.length > 0 || k1 || !qbiCoPrior.isZero() || !reitPtp.isZero()) && !fed.qbi) {
    throw new Error('kernel2: QBI sources present but rule data lacks qbi parameters');
  }
  if ((entities.length > 0 || k1 || !qbiCoPrior.isZero() || !reitPtp.isZero()) && fed.qbi) {
    const combined = (entities.length ? schcNet : Money.zero()).sub(seDeduction)
      .add(k1 ? k1.qbiNet : Money.zero()).sub(R(qbiCoPrior));
    if (taxableBeforeQbi.lte(D(fed.qbi.threshold[fs]))) {
      const qbiComponent = combined.isNegative() ? Money.zero() : R(combined.mulRate(fed.qbi.rate));
      const reitComponent = reitPtp.isNegative() ? Money.zero() : R(reitPtp.mulRate(fed.qbi.rate));
      const prefAmt = (schd ? schd.ncg : Money.max(Money.zero(), capGain)).add(divQual);
      const limit = Money.max(Money.zero(), taxableBeforeQbi.sub(prefAmt));
      qbi = Money.min(qbiComponent.add(reitComponent), R(limit.mulRate(fed.qbi.rate)));
    }
  }
  const taxable = Money.max(Money.zero(), agi.sub(deduction).sub(qbi));

  const pref = R(Money.min(divQual.add(schd ? schd.ncg : Money.max(Money.zero(), capGain)), taxable));
  const ordinaryTop = Money.max(Money.zero(), taxable.sub(pref));
  const fedTax = R(bracket(fed.brackets[fs], ordinaryTop)).add(
    pref.isZero() ? Money.zero() : R(stackedCapGain(fed.capital_gains_brackets[fs], ordinaryTop, taxable)),
  );
  // Form 8962 PTC (annual method) — independent mirror of the kernel block.
  // Net PTC is refundable (payments side); excess APTC repays as other tax,
  // capped below the cliff; MFS ineligible; at/above the cliff uncapped.
  let ptcNet = Money.zero();
  let ptcRepay = Money.zero();
  const ptcPremium = sum(facts, 'ptc.annual_premium');
  const ptcSlcsp = sum(facts, 'ptc.annual_slcsp');
  const ptcAptc = sum(facts, 'ptc.annual_aptc');
  if ((!ptcPremium.isZero() || !ptcSlcsp.isZero() || !ptcAptc.isZero()) && fed.ptc) {
    const size = Money.max(D('1'), sum(facts, 'ptc.household_size'));
    const fpl = D(fed.ptc.fpl_base).add(D(fed.ptc.fpl_per_additional).mulRate(size.sub(D('1')).toString()));
    const income = Money.max(Money.zero(), agi);
    const pct = income.mulFraction('100', fpl.toString()); // audit-allow: percent base (ratio scaffolding), not a dollar figure
    const cliff = D(fed.ptc.cliff_pct);
    let ptc = Money.zero();
    if (fs !== 'mfs' && pct.lt(cliff)) {
      const pts = fed.ptc.applicable_points.map((p) => ({ at: D(p.at_pct), fig: D(p.figure) }));
      const lower = [...pts].reverse().find((p) => p.at.lte(pct));
      const upper = pts.find((p) => p.at.gt(pct));
      const figv = lower === undefined ? pts[0]!.fig : upper === undefined ? lower.fig
        : lower.fig.add(upper.fig.sub(lower.fig).mulFraction(pct.sub(lower.at).toString(), upper.at.sub(lower.at).toString()));
      const contribution = R(income.mulRate(figv.toString()));
      ptc = Money.max(Money.zero(), Money.min(ptcPremium, ptcSlcsp.sub(contribution)));
    }
    if (ptc.gt(ptcAptc)) ptcNet = ptc.sub(ptcAptc);
    else if (ptcAptc.gt(ptc)) {
      const excess = ptcAptc.sub(ptc);
      if (pct.gte(cliff)) ptcRepay = excess;
      else {
        const row = fed.ptc.repayment_caps.find((r) => pct.lte(D(r.up_to_pct)));
        ptcRepay = row === undefined
          ? excess
          : Money.min(excess, D(fs === 'single' || fs === 'mfs' ? row.cap_single : row.cap_other));
      }
    }
  }

  // Form 8959 Additional Medicare Tax — independent mirror: 0.9% on Medicare
  // wages over the threshold + SE net earnings over the wage-reduced
  // threshold; Part IV box-6 excess counts as income-tax withholding.
  let addlMedicare = Money.zero();
  let addlMedicareWh = Money.zero();
  const medWages = sum(facts, 'income.wages.medicare');
  const medWh = sum(facts, 'payments.fed.medicare_withholding');
  if ((!medWages.isZero() || !medWh.isZero()) && !fed.addl_medicare) {
    throw new Error('kernel2: Medicare wage/withholding facts present but rule data lacks additional_medicare parameters');
  }
  if (fed.addl_medicare && (!medWages.isZero() || !medWh.isZero() || seNetEarnings.gt(Money.zero()))) {
    const am = fed.addl_medicare;
    const threshold = D(am.threshold[fs]);
    const wageTax = R(Money.max(Money.zero(), medWages.sub(threshold)).mulRate(am.rate));
    const seThr = Money.max(Money.zero(), threshold.sub(medWages));
    const seAddl = R(Money.max(Money.zero(), seNetEarnings.sub(seThr)).mulRate(am.rate));
    addlMedicare = wageTax.add(seAddl);
    if (!medWh.isZero()) {
      addlMedicareWh = Money.max(Money.zero(), medWh.sub(R(medWages.mulRate(am.regular_wh_rate))));
    }
  }

  // Form 8960 NIIT — independent mirror: 3.8% × min(NII, MAGI excess).
  let niit = Money.zero();
  const nii = interest.add(divOrd).add(capGain).add(k1 ? k1.niitPassiveNet : Money.zero());
  if (nii.gt(Money.zero())) {
    if (!fed.niit) throw new Error('kernel2: investment income present but rule data lacks niit parameters');
    const excess = Money.max(Money.zero(), agi.sub(D(fed.niit.threshold[fs])));
    niit = R(Money.min(nii, excess).mulRate(fed.niit.rate));
  }

  // 1040 line 22 = max(0, line 18 − line 21): the APTC repayment (Sch 2
  // Part I) rides into line 18, so unused nonrefundable credits offset it;
  // Part II (SE + 8959 + NIIT) adds on line 23 — mirror of the kernel's
  // Part I/II split (P11 CPA finding).
  // Form 5695 residential clean energy credit — independent mirror: 30% of
  // qualified solar cost, limited to the tax available after other credits.
  const otherCredits = sum(facts, 'credits.sch3.total');

  // Form 1116 foreign tax credit — independent mirror: the §904 limitation is
  // US tax before credits × (adjusted foreign-source taxable income ÷
  // worldwide taxable income), with foreign long-term gain scaled by the
  // §904(b)(2)(B) rate differential. Taken ahead of §25D in the credit stack.
  let ftc = Money.zero();
  // FX conversion happened above (before Schedule D, where the converted
  // income is REPORTED); the credit reuses those values here.
  const foreignTax = R(sum(facts, 'foreign.tax_paid')).add(fcyTaxUsd);
  const deMinimis = !sum(facts, 'foreign.de_minimis_election').isZero();
  if (!foreignTax.isZero() && deMinimis) {
    // §904(j): the election drops the limitation entirely — the whole
    // creditable tax rides, provided it is at or under the statutory ceiling.
    // Mirror derivation: build the ceiling from the joint-status set rather
    // than branching on 'mfj' alone, and test it with a not-greater compare.
    if (!fed.ftc_de_minimis) throw new Error('kernel2: §904(j) election claimed but rule data lacks ftc_de_minimis parameters');
    const jointStatuses: FilingStatus[] = ['mfj', 'qss'];
    const ceiling = D(jointStatuses.includes(fs) ? fed.ftc_de_minimis.limit_mfj : fed.ftc_de_minimis.limit_other);
    const claimed = R(foreignTax);
    if (!ceiling.gt(claimed) && !ceiling.eq(claimed)) {
      throw new Error(`kernel2: §904(j) election claimed but creditable foreign tax ${claimed.toString()} exceeds the ${ceiling.toString()} ceiling`);
    }
    ftc = claimed;
  } else if (!foreignTax.isZero()) {
    const foreignGross = R(sum(facts, 'foreign.income.passive')).add(fcyIncomeUsd);
    // P73 — no foreign-source income means no §904 limitation can be computed.
    // Mirror of the kernel: take NO credit rather than refuse the return.
    // Omitting a credit raises tax, so it is never a windfall.
    if (foreignGross.isZero()) {
      ftc = Money.zero();
    } else {
    const foreignLtcg = R(sum(facts, 'foreign.income.passive.ltcg')).add(fcyLtcgUsd);
    const topRate = fed.brackets[fs].reduce((hi, b) => (D(b.rate).gt(D(hi)) ? b.rate : hi), '0');
    // marginal preferential rate at this taxable income
    let cgRate = fed.capital_gains_brackets[fs][0]?.rate ?? '0';
    for (const row of fed.capital_gains_brackets[fs]) {
      cgRate = row.rate;
      if (row.up_to !== null && !taxable.gt(D(row.up_to))) break;
    }
    const scaled = D(topRate).isZero() ? foreignLtcg : foreignLtcg.mulFraction(cgRate, topRate);
    const adjusted = R(foreignGross.sub(foreignLtcg).add(scaled));
    const capped = Money.min(adjusted, taxable);
    const usTaxBefore = fedTax.add(ptcRepay);
    const limitation = taxable.gt(Money.zero())
      ? R(usTaxBefore.mulFraction(capped.toString(), taxable.toString()))
      : Money.zero();
    ftc = Money.min(foreignTax, limitation);
    }
  }

  // Form 2441 child and dependent care credit (§21) — independent mirror.
  let depCare = Money.zero();
  const dcExpenses = sum(facts, 'credit.dependent_care.expenses');
  if (!dcExpenses.isZero()) {
    if (!fed.dependent_care) throw new Error('kernel2: dependent-care expenses present but rule data lacks dependent_care parameters');
    const dc = fed.dependent_care;
    // §21(e)(2): no credit on a separate return (§7703(b) exception unmodelled).
    if (fs === 'mfs') throw new Error('kernel2: §21(e)(2) bars the dependent-care credit on a married-filing-separately return');
    const persons = sum(facts, 'credit.dependent_care.qualifying_persons');
    // §21(b)(1): no qualifying individual, no credit.
    if (persons.isZero()) throw new Error('kernel2: dependent-care expenses present but qualifying_persons is missing or zero (§21(b)(1))');
    const many = persons.gt(D('1'));
    // Part III / §129: employer benefits excluded from income cut the cap.
    const benefits = Money.max(Money.zero(), sum(facts, 'credit.dependent_care.employer_benefits'));
    const cap = Money.max(Money.zero(), D(many ? dc.max_expenses_two_or_more : dc.max_expenses_one_person).sub(benefits));
    let exp = Money.min(Money.max(Money.zero(), dcExpenses), cap);
    const eiFacts = facts.filter((f) => f.concept === 'credit.dependent_care.earned_income_limit');
    if (eiFacts.length > 0) exp = Money.min(exp, sum(facts, 'credit.dependent_care.earned_income_limit'));
    // Rate: start at rate_max, drop rate_per_step for each step (or FRACTION
    // of one) of AGI above the start, floor at rate_min. Derived here from the
    // Form 2441 line-8 table directly as a CEILING count — deliberately a
    // different formulation from the kernel's accumulator loop, so that a
    // misreading of "or fraction thereof" cannot survive in both engines.
    const stepAmt = D(dc.phasedown_agi_step);
    const perStep = D(dc.phasedown_rate_per_step);
    let rate = D(dc.rate_min);
    if (!stepAmt.isZero() && !perStep.isZero()) {
      const over = Money.max(Money.zero(), agi.sub(D(dc.phasedown_agi_start)));
      // "or fraction thereof" IS a ceiling: divide exactly, then round UP.
      const steps = over.mulFraction('1', stepAmt.toString()).roundUpToDollar();
      rate = Money.max(D(dc.rate_min), D(dc.rate_max).sub(perStep.mulRate(steps.toString())));
    }
    const room = Money.max(Money.zero(), fedTax.add(ptcRepay).sub(ftc)); // 2441 worksheet: line 18 − Sch 3 line 1
    depCare = Money.min(R(exp.mulRate(rate.toString())), room);
  }

  let solarCredit = Money.zero();
  const solarCost = sum(facts, 'credit.solar.installation_cost');
  if (!solarCost.isZero()) {
    if (!fed.residential_clean_energy) {
      throw new Error('kernel2: solar installation cost present but rule data lacks residential_clean_energy parameters');
    }
    const tentative = R(solarCost.mulRate(fed.residential_clean_energy.rate));
    const available = Money.max(Money.zero(), fedTax.add(ptcRepay).sub(otherCredits).sub(ftc).sub(depCare));
    solarCredit = Money.min(tentative, available);
  }
  const afterCredits = Money.max(
    Money.zero(),
    fedTax.add(ptcRepay).sub(otherCredits).sub(ftc).sub(depCare).sub(solarCredit),
  );
  // Form 5329 Part I §72(t) additional tax (Sch 2 line 8) — independent mirror.
  let earlyDistTax = Money.zero();
  const earlySubject = sum(facts, 'tax.early_distribution.subject_amount');
  if (!earlySubject.isZero()) {
    if (!fed.early_distribution) throw new Error('kernel2: early-distribution amount present but rule data lacks early_distribution parameters');
    earlyDistTax = R(Money.max(Money.zero(), earlySubject).mulRate(fed.early_distribution.rate));
  }
  const liability = afterCredits.add(seTax).add(addlMedicare).add(niit).add(earlyDistTax).add(hsaExcise).add(iraExcise).add(sepExcise);
  const fedPayments = sum(facts, 'payments.fed.withholding').add(sum(facts, 'payments.fed.estimated')).add(ptcNet).add(addlMedicareWh);

  // ---- Illinois (incl. IL-4562 decoupling when federal bonus < 100%)
  const subtractions = Money.sum(il.sch_m_subtraction_concepts.map((c) => sum(facts, c)));
  let ilAdd = Money.zero();
  let ilDepSub = Money.zero();
  if (dep && D(dep.bonus_rate).lt(D('1'))) {
    for (const e of entities) {
      for (const a of assetsOf(facts, e)) {
        const ai = assetInputs(facts, e, a);
        const bonus = R(ai.basis.sub(ai.sec179).mulRate(dep.bonus_rate));
        ilAdd = ilAdd.add(bonus);
        ilDepSub = ilDepSub.add(R(bonus.mulRate(dep.macrs_hy[ai.life]![0]!)));
      }
    }
  }
  // IL-1040 line 2: federally tax-exempt interest is added back (independent mirror).
  // Net addition: the line-2 add-back less the exempt slice, which can never
  // exceed it (independent mirror — computed as a clamp on the subtraction).
  const teAdd = Money.max(Money.zero(), R(sum(facts, 'income.tax_exempt_interest')));
  const teExempt = Money.max(Money.zero(), R(sum(facts, 'il.tax_exempt_interest.exempt_obligations')));
  ilAdd = ilAdd.add(teAdd.sub(Money.min(teExempt, teAdd)));
  const ilBase = agi.add(ilAdd).sub(subtractions).sub(ilDepSub);
  // Exemption: per-person + $1,000/age-blind box, disallowed over the AGI cap.
  // 204(g): the higher threshold is for a JOINT return only.
  const ilExCap = fs === 'mfj' ? il.exemption_disallowed_agi_mfj : il.exemption_disallowed_agi_single;
  let ilExemption = R(D(il.exemption_per_person).mulRate(String(input.il_exemption_count)));
  const ilExBoxes = Math.max(0, Math.trunc(input.addl_std_boxes));
  if (ilExBoxes > 0) {
    if (!il.exemption_age_blind_per_box) throw new Error('kernel2: IL age/blind boxes claimed but rule data lacks exemption_age_blind_per_box');
    ilExemption = ilExemption.add(D(il.exemption_age_blind_per_box).mulRate(String(ilExBoxes)));
  }
  if (ilExCap !== undefined && agi.gt(D(ilExCap))) ilExemption = Money.zero();
  const ilNet = Money.max(Money.zero(), ilBase.sub(ilExemption));
  const ilTax = R(ilNet.mulRate(il.flat_rate));
  // Schedule ICR property-tax credit (nonrefundable; AGI-capped) — mirror.
  let ilIcr = Money.zero();
  const ilPropTax = sum(facts, 'il.property_tax.residence');
  if (!ilPropTax.isZero() && il.icr) {
    const cap = D(fs === 'mfj' ? il.icr.agi_cap_joint : il.icr.agi_cap_single);
    if (agi.lte(cap)) ilIcr = Money.min(R(ilPropTax.mulRate(il.icr.property_tax_credit_rate)), Money.max(Money.zero(), ilTax));
  }
  // Sch CR other-state credit joins ICR (line 18, capped at the tax); use tax
  // rides on top (line 21); PTE credit is a refundable payment (line 28).
  const ilOtherState = Money.max(Money.zero(), R(sum(facts, 'il.credit.tax_paid_other_states')));
  const ilNonref = Money.min(ilTax, ilOtherState.add(ilIcr));
  const ilUseTax = Money.max(Money.zero(), R(sum(facts, 'il.use_tax')));
  const ilAfterCredits = Money.max(Money.zero(), ilTax.sub(ilNonref)); // line 19
  const ilTotalTax = ilAfterCredits.add(ilUseTax); // line 23
  const ilPayments = sum(facts, 'payments.il.withholding')
    .add(sum(facts, 'payments.il.estimated'))
    .add(Money.max(Money.zero(), R(sum(facts, 'payments.il.pte_credit'))));

  return {
    total_income: totalIncome.toString(),
    agi: agi.toString(),
    taxable_income: taxable.toString(),
    fed_tax_total: fedTax.toString(),
    se_tax: seTax.toString(),
    total_liability: liability.toString(),
    fed_payments: fedPayments.toString(),
    fed_refund_or_due: fedPayments.sub(liability).toString(),
    il_tax: ilTax.toString(),
    il_refund_or_due: ilPayments.sub(ilTotalTax).toString(),
    // Entered Form 2210 / IL-2210 penalties come off the bottom lines.
    fed_net_amount_due: fedPayments.sub(liability).sub(Money.max(Money.zero(), sum(facts, 'penalty.fed.estimated_tax'))).toString(),
    il_net_amount_due: ilPayments.sub(ilTotalTax).sub(Money.max(Money.zero(), sum(facts, 'penalty.il.estimated_tax'))).toString(),
  };
}

// ===========================================================================
// P4 — independent ENTITY headline recompute (1120-S). Same isolation rules:
// straight-line, no kernel import; divergence on the entity golden = red.
// ===========================================================================

export interface EntityHeadlines {
  ordinary_income: string;
  k_total: string;
  il_base_income: string;
  il_replacement_tax: string;
  member_box1: Record<string, string>;
  member_capital_gain: Record<string, string>;
}

const ENTITY_DEDUCTIONS2 = ['officers_comp', 'salaries_wages', 'repairs', 'bad_debts', 'rents',
  'taxes_licenses', 'interest', 'depreciation', 'depletion', 'advertising',
  'pension_profit_sharing', 'employee_benefits', 'other'];
const ENTITY_K2 = ['int_income', 'div_ordinary', 'st_gain', 'lt_gain', 'other_income_st', 'other_income_lt'];

export function computeEntityHeadlines(facts: SimpleFact[], ilRules: RuleSet): Record<string, EntityHeadlines> {
  const il = ilRules.il;
  if (!il?.replacement_tax) throw new Error('kernel2: entity facts need il.replacement_tax rates');
  const ids = [...new Set(
    facts.map((f) => /^entity\.([a-z0-9][a-z0-9_-]*)\./.exec(f.concept)?.[1]).filter((x): x is string => !!x),
  )].sort();
  const out: Record<string, EntityHeadlines> = {};
  for (const eid of ids) {
    const g = (field: string): Money => sum(facts, `entity.${eid}.${field}`);
    const scorp = !g('is_scorp').isZero();
    const allMids = [...new Set(
      facts
        .map((f) => new RegExp(`^entity\\.${eid}\\.member\\.([a-z0-9][a-z0-9_-]*)\\.`).exec(f.concept)?.[1])
        .filter((x): x is string => !!x),
    )].sort();
    // GP is deducted on page 1 and comes back into the Sch K reconciliation.
    const gpTotal = scorp
      ? Money.zero()
      : Money.sum(allMids.map((mid) => R(sum(facts, `entity.${eid}.member.${mid}.guaranteed_payment`))));
    const deductions = Money.sum(ENTITY_DEDUCTIONS2.map((c) => g(`deduction.${c}`))).add(gpTotal);
    const ordinary = R(g('gross_receipts').sub(g('returns_allowances')).sub(g('cogs')).sub(deductions));
    const kTotal = R(ordinary.add(Money.sum(ENTITY_K2.map((l) => g(`k.${l}`)))).add(gpTotal));
    const rt = R(Money.max(Money.zero(), kTotal).mulRate(
      scorp ? il.replacement_tax.scorp_rate : il.replacement_tax.partnership_rate,
    ));

    // Member allocation — running-cumulative form (same law, different code
    // shape from the kernel's slice/indexOf version).
    const mids = [...new Set(
      facts
        .map((f) => new RegExp(`^entity\\.${eid}\\.member\\.([a-z0-9][a-z0-9_-]*)\\.share$`).exec(f.concept)?.[1])
        .filter((x): x is string => !!x),
    )].sort();
    const shares = mids.map((mid) =>
      Money.sum(facts.filter((f) => f.concept === `entity.${eid}.member.${mid}.share`).map((f) => D(f.value))),
    );
    const allocate = (line: Money): Money[] => {
      const allocs: Money[] = [];
      let cumShare = Money.zero();
      let allocated = Money.zero();
      for (const share of shares) {
        cumShare = cumShare.add(share);
        const cumAlloc = R(line.mulRate(cumShare.toString()));
        allocs.push(cumAlloc.sub(allocated));
        allocated = cumAlloc;
      }
      return allocs;
    };
    const box1 = allocate(ordinary);
    const cgLines = ['st_gain', 'lt_gain', 'other_income_st', 'other_income_lt'].map((l) => allocate(R(g(`k.${l}`))));
    const memberBox1: Record<string, string> = {};
    const memberCg: Record<string, string> = {};
    mids.forEach((mid, i) => {
      memberBox1[mid] = box1[i]!.toString();
      memberCg[mid] = Money.sum(cgLines.map((allocs) => allocs[i]!)).toString();
    });
    out[eid] = {
      ordinary_income: ordinary.toString(),
      k_total: kTotal.toString(),
      il_base_income: kTotal.toString(),
      il_replacement_tax: rt.toString(),
      member_box1: memberBox1,
      member_capital_gain: memberCg,
    };
  }
  return out;
}
