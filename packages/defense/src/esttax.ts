/**
 * G.5 — Estimated-tax tracker: prior-year safe harbor AND the Annualized
 * Income Installment Method (2210 Schedule AI shape), both shown with the
 * cash-flow difference — rigid safe harbor over-withholds falling income
 * and under-prepares spiking income. All parameters are rule-data
 * (2025.ESTTAX.json, PLACEHOLDER); the effective-rate proxy stands in
 * until the kernel computes Schedule AI tax directly (verify).
 */
import { Money, PLACEHOLDER, type Clock } from '@taxfs/shared';
import type { IncomeLedgerEntry } from './capture';

export interface EstTaxRules {
  /** §6654(d)(1)(C): prior-year anchor when prior AGI exceeds the threshold (110%). */
  safe_harbor_prior_year_pct: string;
  /** §6654(d)(1)(B)(ii): prior-year anchor otherwise (100%). */
  safe_harbor_prior_year_pct_low: string;
  /** §6654(d)(1)(C)(i): prior-AGI threshold for the 110% anchor ($150,000). */
  high_agi_threshold: string;
  /** §6654(d)(1)(C)(ii): MFS threshold ($75,000). */
  high_agi_threshold_mfs: string;
  /** §6654(e)(1): no penalty when balance due after withholding is under this ($1,000). */
  de_minimis_balance_due: string;
  current_year_required_pct: string;
  annualized_effective_rate_proxy: string;
  quarters: { quarter: number; due_date: string; annualization_factor: string; cumulative_installment_pct: string }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function figure(raw: unknown, path: string): string {
  if (!isRecord(raw) || raw['status'] !== PLACEHOLDER || typeof raw['value'] !== 'string') {
    throw new Error(`esttax rules ${path}: figure with "${PLACEHOLDER}" marker required`);
  }
  return raw['value'];
}

export function loadEstTaxRules(json: unknown): EstTaxRules {
  if (!isRecord(json) || !Array.isArray(json['quarters'])) throw new Error('esttax rules: expected { quarters: [...] }');
  return {
    safe_harbor_prior_year_pct: figure(json['safe_harbor_prior_year_pct'], 'safe_harbor_prior_year_pct'),
    safe_harbor_prior_year_pct_low: figure(json['safe_harbor_prior_year_pct_low'], 'safe_harbor_prior_year_pct_low'),
    high_agi_threshold: figure(json['high_agi_threshold'], 'high_agi_threshold'),
    high_agi_threshold_mfs: figure(json['high_agi_threshold_mfs'], 'high_agi_threshold_mfs'),
    de_minimis_balance_due: figure(json['de_minimis_balance_due'], 'de_minimis_balance_due'),
    current_year_required_pct: figure(json['current_year_required_pct'], 'current_year_required_pct'),
    annualized_effective_rate_proxy: figure(json['annualized_effective_rate_proxy'], 'annualized_effective_rate_proxy'),
    quarters: json['quarters'].map((q, i) => {
      if (!isRecord(q)) throw new Error(`esttax quarters[${i}]: expected object`);
      return {
        quarter: Number(q['quarter']),
        due_date: String(q['due_date']),
        annualization_factor: figure(q['annualization_factor'], `quarters[${i}].annualization_factor`),
        cumulative_installment_pct: figure(q['cumulative_installment_pct'], `quarters[${i}].cumulative_installment_pct`),
      };
    }),
  };
}

export interface QuarterStatus {
  quarter: number;
  due_date: string;
  phase: 'past' | 'upcoming' | 'future';
  /** Method A: prior-year safe harbor, equal cumulative installments. */
  safe_harbor_required_cumulative: string;
  /** Method B: annualized income installment (Schedule AI shape). */
  annualized_required_cumulative: string;
  /** Positive = safe harbor demands MORE cash by this date than annualization. */
  method_difference: string;
  paid_cumulative: string;
  status: 'met' | 'underpaid' | 'nudge' | 'not_due';
  note: string;
}

export interface EstTaxReport {
  prior_year_tax: string;
  methods_note: string;
  quarters: QuarterStatus[];
  missed_quarters: number[];
}

export function estimatedTaxReport(input: {
  rules: EstTaxRules;
  clock: Clock;
  prior_year_tax: string; // decimal string (user-supplied or Cap 22 later)
  payments: { date: string; amount: string }[];
  income_ledger: readonly IncomeLedgerEntry[];
}): EstTaxReport {
  const today = input.clock.nowIso().slice(0, 10);
  const priorTax = Money.fromString(input.prior_year_tax);
  const shAnnual = priorTax.mulRate(input.rules.safe_harbor_prior_year_pct).roundToDollar();
  const quarters: QuarterStatus[] = [];
  const missed: number[] = [];

  for (const q of input.rules.quarters) {
    // Method A — safe harbor: cumulative share of the prior-year anchor.
    const shCum = shAnnual.mulRate(q.cumulative_installment_pct).roundToDollar();

    // Method B — annualized income: income actually earned through the
    // period, annualized by the factor, taxed at the proxy rate, required
    // at the same cumulative share.
    const earned = Money.sum(
      input.income_ledger
        .filter((e) => e.income_date <= q.due_date)
        .map((e) => Money.fromString(e.amount)),
    );
    const annualizedIncome = earned.mulRate(q.annualization_factor);
    const aiCum = annualizedIncome
      .mulRate(input.rules.annualized_effective_rate_proxy)
      .mulRate(q.cumulative_installment_pct)
      .roundToDollar();

    const paidCum = Money.sum(
      input.payments.filter((p) => p.date <= q.due_date).map((p) => Money.fromString(p.amount)),
    ).roundToDollar();

    // The lower lawful requirement governs (both methods are always shown).
    const requiredCum = Money.min(shCum, aiCum);
    const phase: QuarterStatus['phase'] =
      q.due_date < today ? 'past' : daysBetween(today, q.due_date) <= 30 ? 'upcoming' : 'future';

    let status: QuarterStatus['status'];
    let note: string;
    if (phase === 'past') {
      if (paidCum.gte(requiredCum)) {
        status = 'met';
        note = 'Cumulative payments met the lower of the two methods for this installment.';
      } else {
        status = 'underpaid';
        missed.push(q.quarter);
        note = 'Missed installment: an underpayment locked in on this date cannot be unwound at filing time — it only stops growing (S4).';
      }
    } else if (phase === 'upcoming') {
      status = 'nudge';
      note = `Due ${q.due_date}: pay the lower of the two methods by the due date to stay covered.`;
    } else {
      status = 'not_due';
      note = 'Not yet due.';
    }

    quarters.push({
      quarter: q.quarter,
      due_date: q.due_date,
      phase,
      safe_harbor_required_cumulative: shCum.toString(),
      annualized_required_cumulative: aiCum.toString(),
      method_difference: shCum.sub(aiCum).toString(),
      paid_cumulative: paidCum.toString(),
      status,
      note,
    });
  }

  return {
    prior_year_tax: priorTax.toString(),
    methods_note:
      'Both methods are shown. Prior-year safe harbor is predictable but ignores how your income actually arrives; the annualized method follows your income ledger — the difference column is the cash-flow gap between them. Every parameter is PLACEHOLDER rule-data pending verification.',
    quarters,
    missed_quarters: missed,
  };
}

function daysBetween(fromIso: string, toIso: string): number {
  const ms = Date.parse(toIso) - Date.parse(fromIso);
  return Math.round(ms / 86_400_000);
}

// ===========================================================================
// P1.6 — §6654 required annual payment / Form 2210 exposure (Gate 0 input).
// Pure: consumes the kernel's total liability (incl. SE tax) + withholding.
// ===========================================================================

export interface RequiredAnnualPaymentInput {
  rules: EstTaxRules;
  /** fed.tax.liability.total (1040 line 24, incl. SE tax), decimal string. */
  current_year_tax: string;
  /** fed.withholding.total — withholding is treated as paid evenly (§6654(g)). */
  withholding: string;
  /** Total estimated payments already made this year (annual view; quarterly
   *  timing is the Schedule-AI tracker's job). */
  estimated_payments: string;
  prior_year_tax: string;
  prior_year_agi: string;
  filing_status: 'single' | 'mfj' | 'mfs' | 'hoh' | 'qss';
}

export interface RequiredAnnualPaymentReport {
  ninety_pct_current: string;
  prior_year_anchor_pct: string;
  prior_year_anchor: string;
  required_annual_payment: string;
  /** max(0, required − withholding): what estimates must cover. */
  shortfall: string;
  quarterly_voucher: string;
  balance_due_after_withholding: string;
  de_minimis_met: boolean;
  no_prior_year_liability: boolean;
  penalty_exposure: boolean;
  notes: string[];
}

export function requiredAnnualPayment(input: RequiredAnnualPaymentInput): RequiredAnnualPaymentReport {
  const r = input.rules;
  const tax = Money.fromString(input.current_year_tax);
  const wh = Money.fromString(input.withholding);
  const est = Money.fromString(input.estimated_payments);
  const priorTax = Money.fromString(input.prior_year_tax);
  const priorAgi = Money.fromString(input.prior_year_agi);
  const notes: string[] = [];

  const ninety = tax.mulRate(r.current_year_required_pct).roundToDollar();

  const threshold = Money.fromString(
    input.filing_status === 'mfs' ? r.high_agi_threshold_mfs : r.high_agi_threshold,
  );
  const anchorPct = priorAgi.gt(threshold) ? r.safe_harbor_prior_year_pct : r.safe_harbor_prior_year_pct_low;
  const anchor = priorTax.mulRate(anchorPct).roundToDollar();
  notes.push(
    `prior-year anchor = ${anchorPct} × ${priorTax.toString()} = ${anchor.toString()} ` +
      `(prior AGI ${priorAgi.toString()} ${priorAgi.gt(threshold) ? '>' : '≤'} ${threshold.toString()}, §6654(d)(1))`,
  );

  const noPrior = priorTax.isZero();
  let required = Money.min(ninety, anchor);
  if (noPrior) {
    // §6654(e)(2): no penalty when the preceding 12-month year had zero liability.
    required = Money.zero();
    notes.push('prior-year liability was zero → no required annual payment (§6654(e)(2))');
  }

  const balanceDue = Money.max(Money.zero(), tax.sub(wh));
  const deMinimis = balanceDue.lt(Money.fromString(r.de_minimis_balance_due));
  if (deMinimis) notes.push(`balance due ${balanceDue.toString()} under ${r.de_minimis_balance_due} → no penalty (§6654(e)(1))`);

  const shortfall = Money.max(Money.zero(), required.sub(wh).sub(est));
  const voucher = shortfall.mulFraction('1', '4').roundToDollar();
  const exposure = !noPrior && !deMinimis && shortfall.gt(Money.zero());
  if (est.gt(Money.zero())) notes.push(`estimated payments ${est.toString()} credited (annual view; per-quarter timing via Schedule AI)`);

  return {
    ninety_pct_current: ninety.toString(),
    prior_year_anchor_pct: anchorPct,
    prior_year_anchor: anchor.toString(),
    required_annual_payment: required.toString(),
    shortfall: shortfall.toString(),
    quarterly_voucher: voucher.toString(),
    balance_due_after_withholding: balanceDue.toString(),
    de_minimis_met: deMinimis,
    no_prior_year_liability: noPrior,
    penalty_exposure: exposure,
    notes,
  };
}
