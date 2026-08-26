/**
 * Rule-data loader (workstream-B schema, skeleton subset).
 *
 * Every tax figure lives in fixture JSON, never in code, and every figure
 * must carry the marker `"status": "PLACEHOLDER — verify"`. The loader
 * refuses any figure without the marker, so a "real-looking" number cannot
 * silently enter the kernel without going through workstream B.
 */
import { Money } from './money';
import type { AuthorityGrade, FilingStatus, Jurisdiction } from './types';
import { STATE_CODES } from './types';

export const PLACEHOLDER = 'PLACEHOLDER — verify';

export interface BracketRow {
  /** Upper bound of the bracket (decimal string), null = unbounded top bracket. */
  up_to: string | null;
  rate: string;
}

export interface SeParameters {
  /** IRC §1402(b) / SSA COLA: Social Security wage base for the year. */
  ss_wage_base: string;
  /** IRC §1401(a): 12.4% OASDI portion. */
  ss_rate: string;
  /** IRC §1401(b): 2.9% Medicare portion (Additional 0.9% is Form 8959, later phase). */
  medicare_rate: string;
  /** Sch SE line 4a: net earnings factor 92.35%. */
  net_earnings_factor: string;
  /** §6017 / Sch SE: no SE tax when net earnings are under this ($400). */
  se_tax_floor: string;
}

export interface SchcParameters {
  /** IRC §274(n): deductible fraction of meals (0.50). */
  meals_deductible_rate: string;
  /** IRC §195(b)(1)(A): first-year startup expensing cap ($5,000). */
  startup_expense_cap: string;
  /** IRC §195(b)(1)(A)(ii): cap phases out dollar-for-dollar over this ($50,000). */
  startup_phaseout_threshold: string;
  /** IRC §195(b)(1)(B): amortization period in months (180). */
  startup_amortization_months: string;
  /** Rev. Proc. 2013-13: simplified home-office rate per sq ft ($5). */
  homeoffice_simplified_rate: string;
  /** Rev. Proc. 2013-13: simplified-method square-footage cap (300). */
  homeoffice_simplified_sqft_cap: string;
  /** Annual IRS notice (2025: Notice 2025-5): standard mileage rate $/mile. */
  standard_mileage_rate: string;
}

export interface DepreciationParameters {
  /** §179(b)(1) dollar cap (2025: $2,500,000 per OBBBA §70306 — verify). */
  sec179_cap: string;
  /** §179(b)(2) phase-out threshold on total §179 property placed in service. */
  sec179_phaseout_threshold: string;
  /** §168(k) bonus rate (2025: 1.00 for property acquired after 1/19/2025 per OBBBA §70301 — verify). */
  bonus_rate: string;
  /** MACRS half-year-convention percentages by recovery period (Pub 946 Table A-1), year-indexed. */
  macrs_hy: Record<string, string[]>;
}

export interface SchdParameters {
  /** §1211(b): capital-loss cap against ordinary income ($3,000). */
  capital_loss_cap: string;
  /** §1211(b)(1): MFS cap ($1,500). */
  capital_loss_cap_mfs: string;
}

/** §469(i): rental real estate special allowance (active participation). */
export interface Sec469iParameters {
  /** §469(i)(2): maximum offset ($25,000; statutory, not indexed). */
  allowance: string;
  /** §469(i)(5): MFS-living-apart cap ($12,500); MFS living together gets 0 —
   *  the kernel applies 0 for MFS (living-apart attestation not modeled). */
  allowance_mfs: string;
  /** §469(i)(3)(A): phase-out starts at this MAGI ($100,000). */
  phaseout_start: string;
  /** §469(i)(3)(A): reduction rate over the excess (0.5). */
  phaseout_rate: string;
}

export interface QbiParameters {
  /** §199A(a): deduction rate (0.20). */
  rate: string;
  /** §199A(e)(2) taxable-income threshold by status (8995 vs 8995-A boundary). */
  threshold: Record<FilingStatus, string>;
}

export interface PtcParameters {
  /** FPL table (48 contiguous states): size-1 base + per-additional-person increment. */
  fpl_base: string;
  fpl_per_additional: string;
  /** §36B(b)(3)(A) applicable-figure points, ascending %FPL; linear interpolation between points, flat below the first and above the last. */
  applicable_points: { at_pct: string; figure: string }[];
  /** §36B(f)(2)(B) repayment caps below the cliff, ascending up_to_pct brackets. */
  repayment_caps: { up_to_pct: string; cap_single: string; cap_other: string }[];
  /** %FPL at/above which no credit is allowed (the 400% cliff, post-2025 regime). */
  cliff_pct: string;
}

export interface AddlMedicareParameters {
  /** IRC §3101(b)(2): Additional Medicare Tax rate (0.009). */
  rate: string;
  /** IRC §3101(b)(1): regular Medicare rate (0.0145) — Form 8959 Part IV withholding baseline. */
  regular_wh_rate: string;
  /** IRC §3101(b)(2)(A)–(C) thresholds by status (statutory, NOT inflation-indexed). */
  threshold: Record<FilingStatus, string>;
}

/** A MAGI phase-out band: full benefit below start, none above end. */
export interface PhaseoutRange {
  start: string;
  end: string;
}

/** P93 — contribution-limit rule data for the HSA / IRA / employer-plan
 *  validation waves. Every dollar figure is tax-year data (Rev. Proc.
 *  2024-25, Notice 2024-80 for 2025); ONLY the statutory ages ride along as
 *  plain numbers. */
export interface RetirementContributionParameters {
  hsa: {
    limit_self_only: string;
    limit_family: string;
    /** §223(b)(3) additional amount, age `catch_up_age`+ — per spouse, and
     *  only into that spouse's own HSA. */
    catch_up: string;
    catch_up_age: number;
  };
  ira: {
    /** §219(b)(5)(A) — COMBINED across Traditional + Roth, per person. */
    limit: string;
    catch_up: string;
    catch_up_age: number;
    /** §219(g)(2)(B) — a partially-phased-out limit never drops below this
     *  floor (Pub 590-A Worksheet 1-2 line 7; same rule in the §408A Roth
     *  worksheet). Statutory dollar amount, so it lives in rule data. */
    reduced_limit_floor: string;
    /** §219(g) deduction phase-out for active plan participants.
     *  mfj_spouse_covered is §219(g)(7): contributor not covered, spouse is. */
    deduction_phaseout: Record<FilingStatus, PhaseoutRange> & { mfj_spouse_covered: PhaseoutRange };
    /** §408A(c)(3) Roth contribution phase-out. */
    roth_phaseout: Record<FilingStatus, PhaseoutRange>;
  };
  elective_deferral: {
    /** §402(g), summed across employers per person. */
    limit: string;
    catch_up_50: string;
    /** §414(v)(2)(E): REPLACES catch_up_50 at ages 60-63. */
    catch_up_60_63: string;
  };
  simple: {
    limit: string;
    catch_up_50: string;
    catch_up_60_63: string;
  };
  sep: {
    /** §408(k): lesser of this rate × compensation or the §415(c) cap; for
     *  the self-employed the rate applies AFTER the ½SE deduction. */
    compensation_rate: string;
    annual_additions_limit: string;
    min_compensation: string;
    /** §4972(a): 10% excise on NONDEDUCTIBLE employer contributions. */
    nondeductible_excise_rate: string;
  };
  /** §4973(a) — 6% per year on excess IRA/HSA contributions left in place. */
  excess_contribution_excise_rate: string;
}

export interface ScheduleAParameters {
  /** §213(a): medical expenses deductible only above this fraction of AGI. */
  medical_agi_floor_pct: string;
  /** §164(b)(6) SALT cap, and the MFS half. */
  salt_cap: string;
  salt_cap_mfs: string;
  /** The cap phases DOWN by `salt_phasedown_rate` of MAGI over this threshold,
   *  but never below `salt_cap_floor`. */
  salt_phasedown_agi: string;
  salt_phasedown_agi_mfs: string;
  salt_phasedown_rate: string;
  salt_cap_floor: string;
  salt_cap_floor_mfs: string;
}

export interface FtcDeMinimisParameters {
  /** IRC §904(j)(2)(B): creditable foreign tax ceiling for the election,
   *  joint return. STATUTORY, not inflation-indexed. */
  limit_mfj: string;
  /** IRC §904(j)(2)(B): the ceiling for every other filing status. */
  limit_other: string;
}

export interface NiitParameters {
  /** IRC §1411(a)(1): net investment income tax rate (0.038). */
  rate: string;
  /** IRC §1411(b) MAGI thresholds by status (statutory, NOT inflation-indexed). */
  threshold: Record<FilingStatus, string>;
}

export interface ResidentialCleanEnergyParameters {
  /** IRC §25D(a): credit rate (0.30). TERMINATED for expenditures after
   *  2025-12-31 (OBBBA §70506) — 2025 is the final year `(verify)`. */
  rate: string;
}

/** IRC §63(f) additional standard deduction for age 65+/blindness. The
 *  statute sets one amount per box for UNMARRIED filers (single/HoH) and a
 *  smaller amount per box for MARRIED filers (mfj/mfs) and QSS — 2025:
 *  $2,000 unmarried, $1,600 married. Optional: absent on stub fixtures that
 *  predate the age/blind wiring (boxes are then required to be 0). */
export interface AddlStdDeductionParameters {
  per_box_unmarried: string;
  per_box_married: string;
}

/** IRC §21 child and dependent care credit (Form 2441). STATUTORY, not
 *  inflation-indexed: ARPA's 2021 expansion expired, so the credit is
 *  nonrefundable and the caps reverted. The rate starts at rate_max and drops
 *  by phasedown_rate_per_step for each phasedown_agi_step (or fraction) of AGI
 *  over phasedown_agi_start, never below rate_min. */
export interface DependentCareParameters {
  max_expenses_one_person: string;
  max_expenses_two_or_more: string;
  rate_max: string;
  rate_min: string;
  phasedown_agi_start: string;
  phasedown_agi_step: string;
  phasedown_rate_per_step: string;
}

/** §72(t)(1) additional tax on early retirement distributions (Form 5329
 *  Part I). The §72(t)(2) exceptions are fact-specific, so the kernel takes
 *  Form 5329 line 3 — the amount subject to the tax AFTER exceptions. */
export interface EarlyDistributionParameters {
  rate: string;
}

export interface FedParameters {
  standard_deduction: Record<FilingStatus, string>;
  /** Present when the rule-data carries the §63(f) age/blind add-on figures. */
  additional_std_deduction?: AddlStdDeductionParameters;
  brackets: Record<FilingStatus, BracketRow[]>;
  capital_gains_brackets: Record<FilingStatus, BracketRow[]>;
  /** Present when the Schedule C / SE form families are loaded (P1). */
  se?: SeParameters;
  schc?: SchcParameters;
  depreciation?: DepreciationParameters;
  schd?: SchdParameters;
  sec469i?: Sec469iParameters;
  qbi?: QbiParameters;
  /** Present when the PTC/1095-A family is loaded (P5). */
  ptc?: PtcParameters;
  /** Form 8959 / Form 8960 high-income surtaxes (P10). */
  addl_medicare?: AddlMedicareParameters;
  niit?: NiitParameters;
  /** Form 5695 residential clean energy credit (P12). */
  residential_clean_energy?: ResidentialCleanEnergyParameters;
  /** Form 2441 child and dependent care credit (P50). */
  dependent_care?: DependentCareParameters;
  /** Form 5329 Part I early-distribution additional tax (P53). */
  early_distribution?: EarlyDistributionParameters;
  /** §904(j) de minimis election — credit without Form 1116 (P57). */
  ftc_de_minimis?: FtcDeMinimisParameters;
  /** Schedule A: medical floor and the §164(b)(6) SALT cap (P67). */
  schedule_a?: ScheduleAParameters;
  /** HSA / IRA / employer-plan contribution limits (P93). */
  retirement_contributions?: RetirementContributionParameters;
}

export interface IlParameters {
  flat_rate: string;
  exemption_per_person: string;
  /** 35 ILCS 5/204(a): $1,000 per checked box for age 65+ / legally blind
   *  (IL-1040 Step 4, lines 10b and 10c) — the Illinois counterpart of the
   *  federal §63(f) additional standard deduction. Optional: absent on stub
   *  fixtures predating the wiring (boxes then contribute nothing). */
  exemption_age_blind_per_box?: string;
  /** 35 ILCS 5/204(g): the exemption allowance is DISALLOWED entirely when
   *  federal AGI exceeds these thresholds. Optional for the same reason. */
  exemption_disallowed_agi_single?: string;
  exemption_disallowed_agi_mfj?: string;
  /** Concept ids subtractable on Sch M (SS + most retirement NOT taxed by IL). */
  sch_m_subtraction_concepts: string[];
  /** Present when the entity-return family is loaded (P4): IL replacement
   *  tax rates (35 ILCS 5/201(c)-(d)) for IL-1120-ST / IL-1065. */
  replacement_tax?: { scorp_rate: string; partnership_rate: string };
  /** Schedule ICR property-tax credit (35 ILCS 5/208; P.A. 100-0022 AGI caps). */
  icr?: { property_tax_credit_rate: string; agi_cap_single: string; agi_cap_joint: string };
}

export interface AuditParameters {
  round_number_multiple: string;
  round_number_min_count: number;
  effective_rate_max: string;
}

export interface RuleSet {
  rule_version: string;
  tax_year: number;
  jurisdiction: Jurisdiction;
  status: 'draft' | 'review' | 'signed' | 'live' | 'retired';
  fed?: FedParameters;
  il?: IlParameters;
  audit: AuditParameters;
  /** Standard-of-authority grade per claimed-position concept (§7 second axis, Cap 26). */
  authority?: Record<string, AuthorityGrade>;
  /** Eligible-but-unclaimed credit prompts (ACC-CREDIT-FINDER). */
  credit_finder?: { saver_credit_agi_max: string };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function figure(raw: unknown, path: string): string {
  if (!isRecord(raw) || typeof raw['value'] !== 'string') {
    throw new Error(`rule-data ${path}: expected { value, status } figure object`);
  }
  if (raw['status'] !== PLACEHOLDER) {
    throw new Error(
      `rule-data ${path}: figure is missing the "${PLACEHOLDER}" marker — ` +
        `unverified figures cannot load (workstream B sign-off required)`,
    );
  }
  return raw['value'];
}

const FILING_STATUSES: FilingStatus[] = ['single', 'mfj', 'mfs', 'hoh', 'qss'];

/** QSS is taxed at MFJ rates and amounts (IRC §2(a)). Fixtures written
 *  before the qss key existed fall back to their mfj entry; an explicit qss
 *  key always wins. */
function statusRaw(raw: Record<string, unknown>, fs: FilingStatus, key: string): unknown {
  if (raw[key] !== undefined) return raw[key];
  if (fs === 'qss') return raw['mfj'];
  return raw[key];
}

function earlyDistParams(
  raw: unknown,
  parse: (v: unknown, path: string) => string,
  path: string,
): { early_distribution?: EarlyDistributionParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected object`);
  return { early_distribution: { rate: parse(raw['rate'], `${path}.rate`) } };
}

function scheduleAParams(
  raw: unknown,
  parse: (v: unknown, path: string) => string,
  path: string,
): { schedule_a?: ScheduleAParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected object`);
  const g = (k: keyof ScheduleAParameters): string => parse(raw[k], `${path}.${k}`);
  return {
    schedule_a: {
      medical_agi_floor_pct: g('medical_agi_floor_pct'),
      salt_cap: g('salt_cap'),
      salt_cap_mfs: g('salt_cap_mfs'),
      salt_phasedown_agi: g('salt_phasedown_agi'),
      salt_phasedown_agi_mfs: g('salt_phasedown_agi_mfs'),
      salt_phasedown_rate: g('salt_phasedown_rate'),
      salt_cap_floor: g('salt_cap_floor'),
      salt_cap_floor_mfs: g('salt_cap_floor_mfs'),
    },
  };
}

function phaseRange(raw: unknown, parse: (v: unknown, path: string) => string, path: string): PhaseoutRange {
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected { start, end }`);
  return { start: parse(raw['start'], `${path}.start`), end: parse(raw['end'], `${path}.end`) };
}

function phaseByStatus(
  raw: unknown,
  parse: (v: unknown, path: string) => string,
  path: string,
): Record<FilingStatus, PhaseoutRange> {
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected per-status object`);
  const out = {} as Record<FilingStatus, PhaseoutRange>;
  for (const fs of FILING_STATUSES) {
    out[fs] = phaseRange(statusRaw(raw, fs, fs), parse, `${path}.${fs}`);
  }
  return out;
}

function statutoryAge(raw: unknown, path: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`rule-data ${path}: expected a positive integer age`);
  }
  return raw;
}

function retirementContribParams(
  raw: unknown,
  parse: (v: unknown, path: string) => string,
  path: string,
): { retirement_contributions?: RetirementContributionParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected object`);
  const section = (k: string): Record<string, unknown> => {
    const v = raw[k];
    if (!isRecord(v)) throw new Error(`rule-data ${path}.${k}: expected object`);
    return v;
  };
  const hsa = section('hsa');
  const ira = section('ira');
  const deferral = section('elective_deferral');
  const simple = section('simple');
  const sep = section('sep');
  const excise = section('excess_contribution_excise');
  return {
    retirement_contributions: {
      hsa: {
        limit_self_only: parse(hsa['limit_self_only'], `${path}.hsa.limit_self_only`),
        limit_family: parse(hsa['limit_family'], `${path}.hsa.limit_family`),
        catch_up: parse(hsa['catch_up'], `${path}.hsa.catch_up`),
        catch_up_age: statutoryAge(hsa['catch_up_age'], `${path}.hsa.catch_up_age`),
      },
      ira: {
        limit: parse(ira['limit'], `${path}.ira.limit`),
        catch_up: parse(ira['catch_up'], `${path}.ira.catch_up`),
        catch_up_age: statutoryAge(ira['catch_up_age'], `${path}.ira.catch_up_age`),
        reduced_limit_floor: parse(ira['reduced_limit_floor'], `${path}.ira.reduced_limit_floor`),
        deduction_phaseout: {
          ...phaseByStatus(ira['deduction_phaseout'], parse, `${path}.ira.deduction_phaseout`),
          mfj_spouse_covered: phaseRange(
            (ira['deduction_phaseout'] as Record<string, unknown>)['mfj_spouse_covered'],
            parse,
            `${path}.ira.deduction_phaseout.mfj_spouse_covered`,
          ),
        },
        roth_phaseout: phaseByStatus(ira['roth_phaseout'], parse, `${path}.ira.roth_phaseout`),
      },
      elective_deferral: {
        limit: parse(deferral['limit'], `${path}.elective_deferral.limit`),
        catch_up_50: parse(deferral['catch_up_50'], `${path}.elective_deferral.catch_up_50`),
        catch_up_60_63: parse(deferral['catch_up_60_63'], `${path}.elective_deferral.catch_up_60_63`),
      },
      simple: {
        limit: parse(simple['limit'], `${path}.simple.limit`),
        catch_up_50: parse(simple['catch_up_50'], `${path}.simple.catch_up_50`),
        catch_up_60_63: parse(simple['catch_up_60_63'], `${path}.simple.catch_up_60_63`),
      },
      sep: {
        compensation_rate: parse(sep['compensation_rate'], `${path}.sep.compensation_rate`),
        annual_additions_limit: parse(sep['annual_additions_limit'], `${path}.sep.annual_additions_limit`),
        min_compensation: parse(sep['min_compensation'], `${path}.sep.min_compensation`),
        nondeductible_excise_rate: parse(sep['nondeductible_excise_rate'], `${path}.sep.nondeductible_excise_rate`),
      },
      excess_contribution_excise_rate: parse(excise['rate'], `${path}.excess_contribution_excise.rate`),
    },
  };
}

function ftcDeMinimisParams(
  raw: unknown,
  parse: (v: unknown, path: string) => string,
  path: string,
): { ftc_de_minimis?: FtcDeMinimisParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected object`);
  return {
    ftc_de_minimis: {
      limit_mfj: parse(raw['limit_mfj'], `${path}.limit_mfj`),
      limit_other: parse(raw['limit_other'], `${path}.limit_other`),
    },
  };
}

function depCareParams(
  raw: unknown,
  parse: (v: unknown, path: string) => string,
  path: string,
): { dependent_care?: DependentCareParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected object`);
  const g = (k: keyof DependentCareParameters): string => parse(raw[k], `${path}.${k}`);
  return {
    dependent_care: {
      max_expenses_one_person: g('max_expenses_one_person'),
      max_expenses_two_or_more: g('max_expenses_two_or_more'),
      rate_max: g('rate_max'),
      rate_min: g('rate_min'),
      phasedown_agi_start: g('phasedown_agi_start'),
      phasedown_agi_step: g('phasedown_agi_step'),
      phasedown_rate_per_step: g('phasedown_rate_per_step'),
    },
  };
}

function figureByStatus(raw: unknown, path: string): Record<FilingStatus, string> {
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected object keyed by filing status`);
  const out = {} as Record<FilingStatus, string>;
  for (const fs of FILING_STATUSES) {
    out[fs] = figure(statusRaw(raw, fs, fs), `${path}.${fs}`);
  }
  return out;
}

/**
 * IRC §63(f) age-65/blind add-on, carried as two extra keys alongside the
 * per-status base in the same standard_deduction object. `parse` is `figure`
 * on the placeholder path ({value,status}) and `num` on the verified path
 * (raw number) — the key NAMES are identical across both shapes. Both keys
 * must be present together or the whole add-on is absent (goldens that predate
 * it load unchanged and force boxes = 0 in the kernel).
 */
function addlStdDeduction(
  raw: unknown,
  parse: (v: unknown, path: string) => string,
  path: string,
): { additional_std_deduction?: AddlStdDeductionParameters } {
  if (!isRecord(raw)) return {};
  const single = raw['additional_age65_or_blind_single'];
  const married = raw['additional_age65_or_blind_married_per_person'];
  if (single === undefined && married === undefined) return {};
  if (single === undefined || married === undefined) {
    throw new Error(
      `rule-data ${path}: additional_age65_or_blind_single and ` +
        `additional_age65_or_blind_married_per_person must both be present or both absent`,
    );
  }
  return {
    additional_std_deduction: {
      per_box_unmarried: parse(single, `${path}.additional_age65_or_blind_single`),
      per_box_married: parse(married, `${path}.additional_age65_or_blind_married_per_person`),
    },
  };
}

/**
 * IL exemption extras (35 ILCS 5/204): the $1,000-per-box age-65/blind
 * addition and the AGI thresholds above which the whole exemption allowance
 * is disallowed. `parse` is `figure` on the placeholder path and `num` on the
 * verified path; the key NAMES are identical across both shapes. Each item is
 * independently optional so older stub fixtures keep loading unchanged.
 */
function ilExemptionExtras(
  raw: unknown,
  parse: (v: unknown, path: string) => string,
  path: string,
): Pick<IlParameters, 'exemption_age_blind_per_box' | 'exemption_disallowed_agi_single' | 'exemption_disallowed_agi_mfj'> {
  if (!isRecord(raw)) return {};
  const perBox = raw['additional_age65_or_blind_per_check'];
  const capSingle = raw['disallowed_if_fed_agi_over_single'];
  const capMfj = raw['disallowed_if_fed_agi_over_mfj'];
  if ((capSingle === undefined) !== (capMfj === undefined)) {
    throw new Error(
      `rule-data ${path}: disallowed_if_fed_agi_over_single and disallowed_if_fed_agi_over_mfj must both be present or both absent`,
    );
  }
  return {
    ...(perBox !== undefined
      ? { exemption_age_blind_per_box: parse(perBox, `${path}.additional_age65_or_blind_per_check`) }
      : {}),
    ...(capSingle !== undefined && capMfj !== undefined
      ? {
          exemption_disallowed_agi_single: parse(capSingle, `${path}.disallowed_if_fed_agi_over_single`),
          exemption_disallowed_agi_mfj: parse(capMfj, `${path}.disallowed_if_fed_agi_over_mfj`),
        }
      : {}),
  };
}

/**
 * Structural sanity for a bracket table (auditor finding F4): the kernel's
 * bracket walk assumes a null-topped, strictly-ascending table with sane
 * rates. A mis-ordered table or a >100% rate must fail at LOAD, never
 * compute. Shared by both the placeholder loader and the verified adapter
 * so the guarantee is identical regardless of source shape.
 */
function validateBracketRows(rows: BracketRow[], path: string): void {
  const last = rows[rows.length - 1];
  if (last === undefined || last.up_to !== null) {
    throw new Error(`rule-data ${path}: top bracket must have up_to = null`);
  }
  const one = Money.fromString('1');
  let prev: Money | null = null;
  for (const [i, row] of rows.entries()) {
    let rate: Money;
    try {
      rate = Money.fromString(row.rate);
    } catch {
      throw new Error(`rule-data ${path}[${i}].rate: "${row.rate}" is not a decimal string`);
    }
    if (rate.isNegative() || rate.gt(one)) {
      throw new Error(`rule-data ${path}[${i}].rate: ${row.rate} outside [0, 1]`);
    }
    if (row.up_to === null) {
      if (i !== rows.length - 1) {
        throw new Error(`rule-data ${path}[${i}]: only the top bracket may have up_to = null`);
      }
      continue;
    }
    const bound = Money.fromString(row.up_to);
    if (bound.isNegative() || bound.isZero()) {
      throw new Error(`rule-data ${path}[${i}].up_to: bound must be positive`);
    }
    if (prev !== null && !bound.gt(prev)) {
      throw new Error(`rule-data ${path}[${i}].up_to: brackets must be strictly ascending (${row.up_to} after ${prev.toString()})`);
    }
    prev = bound;
  }
}

function bracketTable(raw: unknown, path: string): BracketRow[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`rule-data ${path}: expected non-empty bracket array`);
  }
  const rows = raw.map((row, i) => {
    if (!isRecord(row)) throw new Error(`rule-data ${path}[${i}]: expected object`);
    const upTo = row['up_to'] === null ? null : figure(row['up_to'], `${path}[${i}].up_to`);
    return { up_to: upTo, rate: figure(row['rate'], `${path}[${i}].rate`) };
  });
  validateBracketRows(rows, path);
  return rows;
}

function bracketsByStatus(raw: unknown, path: string): Record<FilingStatus, BracketRow[]> {
  if (!isRecord(raw)) throw new Error(`rule-data ${path}: expected object keyed by filing status`);
  const out = {} as Record<FilingStatus, BracketRow[]>;
  for (const fs of FILING_STATUSES) {
    out[fs] = bracketTable(statusRaw(raw, fs, fs), `${path}.${fs}`);
  }
  return out;
}

const AUTHORITY_GRADES: AuthorityGrade[] = [
  'substantial_authority',
  'reasonable_basis',
  'more_likely_than_not',
  'weak_or_none',
];

function authorityGrades(raw: unknown): Record<string, AuthorityGrade> | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error('rule-data parameters.authority_grades: expected object');
  const out: Record<string, AuthorityGrade> = {};
  for (const [concept, fig] of Object.entries(raw)) {
    const value = figure(fig, `parameters.authority_grades.${concept}`);
    const grade = AUTHORITY_GRADES.find((g) => g === value);
    if (grade === undefined) {
      throw new Error(`rule-data parameters.authority_grades.${concept}: unknown grade "${value}"`);
    }
    out[concept] = grade;
  }
  return out;
}

function creditFinder(raw: unknown): { saver_credit_agi_max: string } | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) throw new Error('rule-data parameters.credit_finder: expected object');
  return {
    saver_credit_agi_max: figure(raw['saver_credit_agi_max'], 'parameters.credit_finder.saver_credit_agi_max'),
  };
}

function auditParameters(raw: unknown): AuditParameters {
  if (!isRecord(raw)) throw new Error('rule-data audit_params: missing');
  const minCountRaw = figure(raw['round_number_min_count'], 'audit_params.round_number_min_count');
  return {
    round_number_multiple: figure(raw['round_number_multiple'], 'audit_params.round_number_multiple'),
    round_number_min_count: Number.parseInt(minCountRaw, 10),
    effective_rate_max: figure(raw['effective_rate_max'], 'audit_params.effective_rate_max'),
  };
}

/** Optional SE parameter block (stub: figure objects; verified: plain numbers). */
function seParams(raw: unknown, read: (v: unknown, p: string) => string): { se?: SeParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.self_employment: expected object');
  return {
    se: {
      ss_wage_base: read(raw['ss_wage_base'], 'parameters.self_employment.ss_wage_base'),
      ss_rate: read(raw['ss_rate'], 'parameters.self_employment.ss_rate'),
      medicare_rate: read(raw['medicare_rate'], 'parameters.self_employment.medicare_rate'),
      net_earnings_factor: read(raw['net_earnings_factor'], 'parameters.self_employment.net_earnings_factor'),
      se_tax_floor: read(raw['se_tax_floor'], 'parameters.self_employment.se_tax_floor'),
    },
  };
}

function schcParams(raw: unknown, read: (v: unknown, p: string) => string): { schc?: SchcParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.schedule_c: expected object');
  return {
    schc: {
      meals_deductible_rate: read(raw['meals_deductible_rate'], 'parameters.schedule_c.meals_deductible_rate'),
      startup_expense_cap: read(raw['startup_expense_cap'], 'parameters.schedule_c.startup_expense_cap'),
      startup_phaseout_threshold: read(raw['startup_phaseout_threshold'], 'parameters.schedule_c.startup_phaseout_threshold'),
      startup_amortization_months: read(raw['startup_amortization_months'], 'parameters.schedule_c.startup_amortization_months'),
      homeoffice_simplified_rate: read(raw['homeoffice_simplified_rate'], 'parameters.schedule_c.homeoffice_simplified_rate'),
      homeoffice_simplified_sqft_cap: read(raw['homeoffice_simplified_sqft_cap'], 'parameters.schedule_c.homeoffice_simplified_sqft_cap'),
      standard_mileage_rate: read(raw['standard_mileage_rate'], 'parameters.schedule_c.standard_mileage_rate'),
    },
  };
}

function depParams(raw: unknown, read: (v: unknown, p: string) => string): { depreciation?: DepreciationParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.depreciation: expected object');
  const tablesRaw = raw['macrs_hy'];
  if (!isRecord(tablesRaw)) throw new Error('rule-data parameters.depreciation.macrs_hy: expected object');
  const macrs_hy: Record<string, string[]> = {};
  for (const [life, rows] of Object.entries(tablesRaw)) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`rule-data parameters.depreciation.macrs_hy.${life}: expected non-empty array`);
    }
    macrs_hy[life] = rows.map((r, i) => read(r, `parameters.depreciation.macrs_hy.${life}[${i}]`));
    const sum = macrs_hy[life]!.reduce((a, b) => a + Number(b), 0);
    if (Math.abs(sum - 1) > 0.0001) {
      throw new Error(`rule-data parameters.depreciation.macrs_hy.${life}: percentages sum to ${sum}, not 1`);
    }
  }
  return {
    depreciation: {
      sec179_cap: read(raw['sec179_cap'], 'parameters.depreciation.sec179_cap'),
      sec179_phaseout_threshold: read(raw['sec179_phaseout_threshold'], 'parameters.depreciation.sec179_phaseout_threshold'),
      bonus_rate: read(raw['bonus_rate'], 'parameters.depreciation.bonus_rate'),
      macrs_hy,
    },
  };
}

function schdParams(raw: unknown, read: (v: unknown, p: string) => string): { schd?: SchdParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.schedule_d: expected object');
  return {
    schd: {
      capital_loss_cap: read(raw['capital_loss_cap'], 'parameters.schedule_d.capital_loss_cap'),
      capital_loss_cap_mfs: read(raw['capital_loss_cap_mfs'], 'parameters.schedule_d.capital_loss_cap_mfs'),
    },
  };
}

function sec469iParams(raw: unknown, read: (v: unknown, p: string) => string): { sec469i?: Sec469iParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.sec469i: expected object');
  return {
    sec469i: {
      allowance: read(raw['allowance'], 'parameters.sec469i.allowance'),
      allowance_mfs: read(raw['allowance_mfs'], 'parameters.sec469i.allowance_mfs'),
      phaseout_start: read(raw['phaseout_start'], 'parameters.sec469i.phaseout_start'),
      phaseout_rate: read(raw['phaseout_rate'], 'parameters.sec469i.phaseout_rate'),
    },
  };
}

function qbiParams(raw: unknown, read: (v: unknown, p: string) => string): { qbi?: QbiParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.qbi: expected object');
  const thr = raw['threshold'];
  if (!isRecord(thr)) throw new Error('rule-data parameters.qbi.threshold: expected object');
  const threshold = {} as Record<FilingStatus, string>;
  for (const fs of FILING_STATUSES) {
    threshold[fs] = read(statusRaw(thr, fs, fs), `parameters.qbi.threshold.${fs}`);
  }
  return { qbi: { rate: read(raw['rate'], 'parameters.qbi.rate'), threshold } };
}

function ptcParams(raw: unknown, read: (v: unknown, p: string) => string): { ptc?: PtcParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.ptc: expected object');
  const points = raw['applicable_points'];
  const caps = raw['repayment_caps'];
  if (!Array.isArray(points) || points.length === 0 || !Array.isArray(caps) || caps.length === 0) {
    throw new Error('rule-data parameters.ptc: applicable_points and repayment_caps arrays required');
  }
  return {
    ptc: {
      fpl_base: read(raw['fpl_base'], 'parameters.ptc.fpl_base'),
      fpl_per_additional: read(raw['fpl_per_additional'], 'parameters.ptc.fpl_per_additional'),
      cliff_pct: read(raw['cliff_pct'], 'parameters.ptc.cliff_pct'),
      applicable_points: points.map((p, i) => {
        if (!isRecord(p)) throw new Error(`rule-data parameters.ptc.applicable_points[${i}]: expected object`);
        return {
          at_pct: read(p['at_pct'], `parameters.ptc.applicable_points[${i}].at_pct`),
          figure: read(p['figure'], `parameters.ptc.applicable_points[${i}].figure`),
        };
      }),
      repayment_caps: caps.map((c, i) => {
        if (!isRecord(c)) throw new Error(`rule-data parameters.ptc.repayment_caps[${i}]: expected object`);
        return {
          up_to_pct: read(c['up_to_pct'], `parameters.ptc.repayment_caps[${i}].up_to_pct`),
          cap_single: read(c['cap_single'], `parameters.ptc.repayment_caps[${i}].cap_single`),
          cap_other: read(c['cap_other'], `parameters.ptc.repayment_caps[${i}].cap_other`),
        };
      }),
    },
  };
}

function addlMedicareParams(raw: unknown, read: (v: unknown, p: string) => string): { addl_medicare?: AddlMedicareParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.additional_medicare: expected object');
  const thr = raw['threshold'];
  if (!isRecord(thr)) throw new Error('rule-data parameters.additional_medicare.threshold: expected object');
  const threshold = {} as Record<FilingStatus, string>;
  for (const fs of FILING_STATUSES) {
    threshold[fs] = read(statusRaw(thr, fs, fs), `parameters.additional_medicare.threshold.${fs}`);
  }
  return {
    addl_medicare: {
      rate: read(raw['rate'], 'parameters.additional_medicare.rate'),
      regular_wh_rate: read(raw['regular_wh_rate'], 'parameters.additional_medicare.regular_wh_rate'),
      threshold,
    },
  };
}

function niitParams(raw: unknown, read: (v: unknown, p: string) => string): { niit?: NiitParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.niit: expected object');
  const thr = raw['threshold'];
  if (!isRecord(thr)) throw new Error('rule-data parameters.niit.threshold: expected object');
  const threshold = {} as Record<FilingStatus, string>;
  for (const fs of FILING_STATUSES) {
    threshold[fs] = read(statusRaw(thr, fs, fs), `parameters.niit.threshold.${fs}`);
  }
  return { niit: { rate: read(raw['rate'], 'parameters.niit.rate'), threshold } };
}

function rceParams(raw: unknown, read: (v: unknown, p: string) => string): { residential_clean_energy?: ResidentialCleanEnergyParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('rule-data parameters.residential_clean_energy: expected object');
  return { residential_clean_energy: { rate: read(raw['rate'], 'parameters.residential_clean_energy.rate') } };
}

export function loadRuleSet(json: unknown): RuleSet {
  if (!isRecord(json)) throw new Error('rule-data: expected object');
  const jRaw = json['jurisdiction'];
  const jurisdiction: Jurisdiction = jRaw === 'FED' ? 'FED' : jRaw === 'IL' ? 'IL' : (() => {
    throw new Error('rule-data: jurisdiction must be FED or IL');
  })();
  if (typeof json['rule_version'] !== 'string' || typeof json['tax_year'] !== 'number') {
    throw new Error('rule-data: rule_version (string) and tax_year (number) required');
  }
  const sRaw = json['status'];
  const statuses = ['draft', 'review', 'signed', 'live', 'retired'] as const;
  const status = statuses.find((s) => s === sRaw);
  if (status === undefined) {
    throw new Error('rule-data: invalid status');
  }
  const params = json['parameters'];
  if (!isRecord(params)) throw new Error('rule-data: parameters missing');

  const base = {
    rule_version: json['rule_version'],
    tax_year: json['tax_year'],
    jurisdiction,
    status,
    audit: auditParameters(json['audit_params']),
  };

  if (jurisdiction === 'FED') {
    const authority = authorityGrades(params['authority_grades']);
    const finder = creditFinder(params['credit_finder']);
    return {
      ...base,
      fed: {
        standard_deduction: figureByStatus(params['standard_deduction'], 'parameters.standard_deduction'),
        ...addlStdDeduction(params['standard_deduction'], figure, 'parameters.standard_deduction'),
        ...seParams(params['self_employment'], figure),
        ...schcParams(params['schedule_c'], figure),
        ...depParams(params['depreciation'], figure),
        ...schdParams(params['schedule_d'], figure),
        ...sec469iParams(params['sec469i'], figure),
        ...qbiParams(params['qbi'], figure),
        ...ptcParams(params['ptc'], figure),
        ...addlMedicareParams(params['additional_medicare'], figure),
        ...niitParams(params['niit'], figure),
        ...rceParams(params['residential_clean_energy'], figure),
        ...depCareParams(params['child_dependent_care_credit'], figure, 'parameters.child_dependent_care_credit'),
        ...earlyDistParams(params['early_distribution_additional_tax'], figure, 'parameters.early_distribution_additional_tax'),
        ...ftcDeMinimisParams(params['foreign_tax_credit_de_minimis'], figure, 'parameters.foreign_tax_credit_de_minimis'),
        ...scheduleAParams(params['schedule_a'], figure, 'parameters.schedule_a'),
        ...retirementContribParams(params['retirement_contributions'], figure, 'parameters.retirement_contributions'),
        brackets: bracketsByStatus(params['brackets'], 'parameters.brackets'),
        capital_gains_brackets: bracketsByStatus(
          params['capital_gains_brackets'],
          'parameters.capital_gains_brackets',
        ),
      },
      ...(authority !== undefined ? { authority } : {}),
      ...(finder !== undefined ? { credit_finder: finder } : {}),
    };
  }
  const subtractions = params['sch_m_subtraction_concepts'];
  if (!isRecord(subtractions) || !Array.isArray(subtractions['value'])) {
    throw new Error('rule-data parameters.sch_m_subtraction_concepts: expected { value: string[], status }');
  }
  if (subtractions['status'] !== PLACEHOLDER) {
    throw new Error(`rule-data parameters.sch_m_subtraction_concepts: missing "${PLACEHOLDER}" marker`);
  }
  const replacementTax = params['replacement_tax'];
  if (replacementTax !== undefined && !isRecord(replacementTax)) {
    throw new Error('rule-data parameters.replacement_tax: expected { scorp_rate, partnership_rate }');
  }
  return {
    ...base,
    il: {
      flat_rate: figure(params['flat_rate'], 'parameters.flat_rate'),
      exemption_per_person: figure(params['exemption_per_person'], 'parameters.exemption_per_person'),
      ...ilExemptionExtras(params, figure, 'parameters'),
      sch_m_subtraction_concepts: subtractions['value'].map((c) => String(c)),
      ...(replacementTax !== undefined
        ? {
            replacement_tax: {
              scorp_rate: figure(replacementTax['scorp_rate'], 'parameters.replacement_tax.scorp_rate'),
              partnership_rate: figure(replacementTax['partnership_rate'], 'parameters.replacement_tax.partnership_rate'),
            },
          }
        : {}),
      ...(isRecord(params['icr'])
        ? {
            icr: {
              property_tax_credit_rate: figure((params['icr'] as Record<string, unknown>)['property_tax_credit_rate'], 'parameters.icr.property_tax_credit_rate'),
              agi_cap_single: figure((params['icr'] as Record<string, unknown>)['agi_cap_single'], 'parameters.icr.agi_cap_single'),
              agi_cap_joint: figure((params['icr'] as Record<string, unknown>)['agi_cap_joint'], 'parameters.icr.agi_cap_joint'),
            },
          }
        : {}),
    },
  };
}

// ===========================================================================
// Source-verified rule-data adapter (2025.FED.1.0 / 2025.IL.1.0)
//
// The verified files carry PURE tax figures in their own IRS/IL-shaped
// structure (plain numbers, full-name filing statuses, `over`-keyed lower-
// bound brackets) plus a `_meta` block with provenance. This adapter maps
// that shape onto the kernel's internal RuleSet WITHOUT hand-editing any
// verified figure. Non-IRS-published platform parameters (audit heuristics,
// authority grades, saver-credit prompt, IL Sch-M concept IDs) come from a
// clearly-labeled companion 2025.SYSTEM.* config, kept separate so the
// verified tax figures stay pure.
//
// Guard: instead of the PLACEHOLDER marker, the verified path requires
// `_meta.status` + `_meta.verified_against` — so unverified data still
// cannot load. Status is always mapped to 'review' (source-verified but NOT
// signed); production clearance is the compliance/release gate's job (J.4),
// never a JSON field.
// ===========================================================================

/** Verified files use full-name filing statuses; the kernel uses short keys. */
const VERIFIED_STATUS_KEY: Record<FilingStatus, string> = {
  single: 'single',
  mfj: 'married_filing_jointly',
  mfs: 'married_filing_separately',
  hoh: 'head_of_household',
  qss: 'qualifying_surviving_spouse',
};

/** Verified-shape QSS fallback: IRC §2(a) taxes QSS at MFJ rates/amounts, so
 *  a verified file without an explicit qualifying_surviving_spouse section
 *  resolves to its married_filing_jointly section. Explicit keys win. */
function verifiedStatusRaw(raw: Record<string, unknown>, fs: FilingStatus): unknown {
  const key = VERIFIED_STATUS_KEY[fs];
  if (raw[key] !== undefined) return raw[key];
  if (fs === 'qss') return raw[VERIFIED_STATUS_KEY.mfj];
  return raw[key];
}

function num(raw: unknown, path: string): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error(`verified rule-data ${path}: expected a finite number`);
  }
  // Number.prototype.toString yields the shortest round-tripping decimal
  // (0.0495 -> "0.0495"); Money then parses it exactly. Bounds are integers.
  return String(raw);
}

/** Transform IRS-shaped lower-bound rows [{rate, over}] into the kernel's
 *  upper-bound rows [{up_to, rate}] (row i.up_to = row i+1.over; top = null). */
function bracketFromOver(raw: unknown, path: string): BracketRow[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`verified rule-data ${path}: expected non-empty bracket array`);
  }
  const parsed = raw.map((row, i) => {
    if (!isRecord(row)) throw new Error(`verified rule-data ${path}[${i}]: expected object`);
    return { rate: num(row['rate'], `${path}[${i}].rate`), over: num(row['over'], `${path}[${i}].over`) };
  });
  if (parsed[0]!.over !== '0') {
    throw new Error(`verified rule-data ${path}[0].over: first bracket must start at 0 (got ${parsed[0]!.over})`);
  }
  const rows: BracketRow[] = parsed.map((row, i) => ({
    up_to: i + 1 < parsed.length ? parsed[i + 1]!.over : null,
    rate: row.rate,
  }));
  validateBracketRows(rows, path); // same F4 structural guard as the stub path
  return rows;
}

function verifiedBracketsByStatus(raw: unknown, path: string): Record<FilingStatus, BracketRow[]> {
  if (!isRecord(raw)) throw new Error(`verified rule-data ${path}: expected object keyed by filing status`);
  const out = {} as Record<FilingStatus, BracketRow[]>;
  for (const fs of FILING_STATUSES) {
    out[fs] = bracketFromOver(verifiedStatusRaw(raw, fs), `${path}.${VERIFIED_STATUS_KEY[fs]}`);
  }
  return out;
}

function verifiedStdByStatus(raw: unknown, path: string): Record<FilingStatus, string> {
  if (!isRecord(raw)) throw new Error(`verified rule-data ${path}: expected object`);
  const out = {} as Record<FilingStatus, string>;
  for (const fs of FILING_STATUSES) {
    out[fs] = num(verifiedStatusRaw(raw, fs), `${path}.${VERIFIED_STATUS_KEY[fs]}`);
  }
  return out;
}

function verifiedMeta(json: unknown): { release_id: string; tax_year: number; jurisdiction: Jurisdiction } {
  if (!isRecord(json)) throw new Error('verified rule-data: expected object');
  const meta = json['_meta'];
  if (!isRecord(meta)) throw new Error('verified rule-data: missing _meta block');
  // The verified guard (replaces the PLACEHOLDER marker): both fields must be
  // present and non-empty, or the data does not load.
  for (const key of ['status', 'verified_against']) {
    if (typeof meta[key] !== 'string' || (meta[key] as string).trim() === '') {
      throw new Error(
        `verified rule-data: _meta.${key} required and non-empty — unverified rule-data cannot load ` +
          `(source-verification is the load guard; the PLACEHOLDER marker is for stub fixtures only)`,
      );
    }
  }
  const jRaw = meta['jurisdiction'];
  if (jRaw !== 'FED' && !(STATE_CODES as readonly string[]).includes(String(jRaw))) {
    throw new Error(`verified rule-data: _meta.jurisdiction must be FED or one of ${STATE_CODES.join(', ')}`);
  }
  const jurisdiction = jRaw as Jurisdiction;
  if (typeof meta['release_id'] !== 'string' || typeof meta['tax_year'] !== 'number') {
    throw new Error('verified rule-data: _meta.release_id (string) and _meta.tax_year (number) required');
  }
  return { release_id: meta['release_id'], tax_year: meta['tax_year'], jurisdiction };
}

/** Companion platform config (2025.SYSTEM.*): audit heuristics etc. Not tax
 *  figures — no verified-against guard, but must declare _meta.kind. */
function systemMeta(sys: unknown, jurisdiction: Jurisdiction): Record<string, unknown> {
  if (!isRecord(sys)) throw new Error('system config: expected object');
  const meta = sys['_meta'];
  if (!isRecord(meta) || meta['kind'] !== 'PLATFORM-CONFIG') {
    throw new Error('system config: _meta.kind must be "PLATFORM-CONFIG"');
  }
  if (meta['jurisdiction'] !== jurisdiction) {
    throw new Error(`system config: _meta.jurisdiction ${String(meta['jurisdiction'])} != rule-data ${jurisdiction}`);
  }
  return sys;
}

function plainAuditParameters(raw: unknown): AuditParameters {
  if (!isRecord(raw)) throw new Error('system config: audit_params missing');
  const get = (k: string): string => {
    const v = raw[k];
    if (typeof v !== 'string' || v.trim() === '') throw new Error(`system config: audit_params.${k} required`);
    return v;
  };
  return {
    round_number_multiple: get('round_number_multiple'),
    round_number_min_count: Number.parseInt(get('round_number_min_count'), 10),
    effective_rate_max: get('effective_rate_max'),
  };
}

/**
 * Load a source-verified rule set (verified tax figures + companion platform
 * config) into the kernel's internal RuleSet. Verified figures are never
 * hand-edited; they are mapped from the IRS/IL-shaped structure. Status is
 * pinned to 'review' — source-verified is NOT signed; production clearance
 * is the compliance/release gate (J.4).
 */
/** Verified files carry §3101(b)(2)/§1411(b) thresholds flat
 *  (threshold_single/mfj/mfs). HOH statutorily shares the single threshold;
 *  QSS shares the joint one — status mapping, not a new figure. */
function verifiedSurtaxThresholds(raw: Record<string, unknown>, path: string): Record<FilingStatus, string> {
  const single = num(raw['threshold_single'], `${path}.threshold_single`);
  const mfj = num(raw['threshold_mfj'], `${path}.threshold_mfj`);
  const mfs = num(raw['threshold_mfs'], `${path}.threshold_mfs`);
  return { single, mfj, mfs, hoh: single, qss: mfj };
}

function verifiedAddlMedicare(raw: unknown): { addl_medicare?: AddlMedicareParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('verified rule-data additional_medicare_tax: expected object');
  return {
    addl_medicare: {
      rate: num(raw['rate'], 'additional_medicare_tax.rate'),
      regular_wh_rate: num(raw['regular_medicare_rate'], 'additional_medicare_tax.regular_medicare_rate'),
      threshold: verifiedSurtaxThresholds(raw, 'additional_medicare_tax'),
    },
  };
}

function verifiedNiit(raw: unknown): { niit?: NiitParameters } {
  if (raw === undefined) return {};
  if (!isRecord(raw)) throw new Error('verified rule-data net_investment_income_tax: expected object');
  return {
    niit: {
      rate: num(raw['rate'], 'net_investment_income_tax.rate'),
      threshold: verifiedSurtaxThresholds(raw, 'net_investment_income_tax'),
    },
  };
}

export function loadVerifiedRuleSet(verifiedJson: unknown, systemJson: unknown): RuleSet {
  const meta = verifiedMeta(verifiedJson);
  const v = verifiedJson as Record<string, unknown>;
  const sys = systemMeta(systemJson, meta.jurisdiction);

  const base = {
    rule_version: meta.release_id,
    tax_year: meta.tax_year,
    jurisdiction: meta.jurisdiction,
    status: 'review' as const, // source-verified, pending EA/CPA signature — never auto-production
    audit: plainAuditParameters(sys['audit_params']),
  };

  if (meta.jurisdiction === 'FED') {
    const authority = ((): Record<string, AuthorityGrade> | undefined => {
      const raw = sys['authority_grades'];
      if (raw === undefined) return undefined;
      if (!isRecord(raw)) throw new Error('system config: authority_grades must be an object');
      const out: Record<string, AuthorityGrade> = {};
      for (const [concept, val] of Object.entries(raw)) {
        const grade = AUTHORITY_GRADES.find((g) => g === val);
        if (grade === undefined) throw new Error(`system config: authority_grades.${concept}: unknown grade "${String(val)}"`);
        out[concept] = grade;
      }
      return out;
    })();
    const finder = ((): { saver_credit_agi_max: string } | undefined => {
      const raw = sys['credit_finder'];
      if (raw === undefined) return undefined;
      if (!isRecord(raw) || typeof raw['saver_credit_agi_max'] !== 'string') {
        throw new Error('system config: credit_finder.saver_credit_agi_max (string) required');
      }
      return { saver_credit_agi_max: raw['saver_credit_agi_max'] };
    })();
    return {
      ...base,
      fed: {
        standard_deduction: verifiedStdByStatus(v['standard_deduction'], 'standard_deduction'),
        ...addlStdDeduction(v['standard_deduction'], num, 'standard_deduction'),
        brackets: verifiedBracketsByStatus(v['ordinary_income_brackets'], 'ordinary_income_brackets'),
        ...seParams(v['self_employment'], num),
        ...schcParams(v['schedule_c'], num),
        ...depParams(v['depreciation'], num),
        ...schdParams(v['schedule_d'], num),
        ...sec469iParams(v['sec469i'], num),
        ...qbiParams(v['qbi'], num),
        ...ptcParams(v['ptc'], num),
        ...verifiedAddlMedicare(v['additional_medicare_tax']),
        ...verifiedNiit(v['net_investment_income_tax']),
        ...rceParams(v['residential_clean_energy'], num),
        ...depCareParams(v['child_dependent_care_credit'], num, 'child_dependent_care_credit'),
        ...earlyDistParams(v['early_distribution_additional_tax'], num, 'early_distribution_additional_tax'),
        ...ftcDeMinimisParams(v['foreign_tax_credit_de_minimis'], num, 'foreign_tax_credit_de_minimis'),
        ...scheduleAParams(v['schedule_a'], num, 'schedule_a'),
        ...retirementContribParams(v['retirement_contributions'], num, 'retirement_contributions'),
        capital_gains_brackets: verifiedBracketsByStatus(
          v['long_term_capital_gains_brackets'],
          'long_term_capital_gains_brackets',
        ),
      },
      ...(authority !== undefined ? { authority } : {}),
      ...(finder !== undefined ? { credit_finder: finder } : {}),
    };
  }

  const taxRate = v['tax_rate'];
  const exemption = v['personal_exemption'];
  if (!isRecord(taxRate)) throw new Error('verified rule-data: tax_rate object required');
  if (!isRecord(exemption)) throw new Error('verified rule-data: personal_exemption object required');
  const concepts = sys['sch_m_subtraction_concepts'];
  if (!Array.isArray(concepts)) {
    throw new Error('system config: sch_m_subtraction_concepts (string[]) required');
  }
  const vReplacement = v['replacement_tax'];
  if (vReplacement !== undefined && !isRecord(vReplacement)) {
    throw new Error('verified rule-data: replacement_tax must be an object');
  }
  return {
    ...base,
    il: {
      flat_rate: num(taxRate['flat_rate'], 'tax_rate.flat_rate'),
      exemption_per_person: num(exemption['amount_per_person'], 'personal_exemption.amount_per_person'),
      ...ilExemptionExtras(exemption, num, 'personal_exemption'),
      sch_m_subtraction_concepts: concepts.map((c) => String(c)),
      ...(vReplacement !== undefined
        ? {
            replacement_tax: {
              scorp_rate: num(vReplacement['scorp_rate'], 'replacement_tax.scorp_rate'),
              partnership_rate: num(vReplacement['partnership_rate'], 'replacement_tax.partnership_rate'),
            },
          }
        : {}),
      ...(isRecord(v['icr'])
        ? {
            icr: {
              property_tax_credit_rate: num((v['icr'] as Record<string, unknown>)['property_tax_credit_rate'], 'icr.property_tax_credit_rate'),
              agi_cap_single: num((v['icr'] as Record<string, unknown>)['agi_cap_single'], 'icr.agi_cap_single'),
              agi_cap_joint: num((v['icr'] as Record<string, unknown>)['agi_cap_joint'], 'icr.agi_cap_joint'),
            },
          }
        : {}),
    },
  };
}
