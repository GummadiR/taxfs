/**
 * P4.5 — Texas Franchise Tax COMPLIANCE TRACKER (REQUIREMENTS §states: TX
 * has no personal income tax return and no XML target — TaxFS tracks the
 * registered entity's franchise obligations only, it does NOT compute the
 * margin tax). All figures are rule-data (2025.TX.json, PLACEHOLDER):
 * no-tax-due threshold, rates for the upper-bound exposure note, report
 * deadline. Post-2023 regime: entities at/below the threshold no longer
 * file a No Tax Due Report but still owe a Public Information Report.
 */
import { Money, PLACEHOLDER } from '@taxfs/shared';

export interface TxFranchiseRules {
  /** Annualized-total-revenue no-tax-due threshold (Tex. Tax Code §171.002(d)). */
  no_tax_due_threshold: string;
  /** Margin rate, retail/wholesale (§171.002(b)) — upper-bound note only. */
  rate_retail_wholesale: string;
  /** Margin rate, other entities (§171.002(a)) — upper-bound note only. */
  rate_other: string;
  /** Annual report due date (May 15 unless extended). */
  report_due_date: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function figure(raw: unknown, path: string): string {
  if (!isRecord(raw) || raw['status'] !== PLACEHOLDER || typeof raw['value'] !== 'string') {
    throw new Error(`tx franchise rules ${path}: figure with "${PLACEHOLDER}" marker required`);
  }
  return raw['value'];
}

export function loadTxFranchiseRules(json: unknown): TxFranchiseRules {
  if (!isRecord(json)) throw new Error('tx franchise rules: expected object');
  return {
    no_tax_due_threshold: figure(json['no_tax_due_threshold'], 'no_tax_due_threshold'),
    rate_retail_wholesale: figure(json['rate_retail_wholesale'], 'rate_retail_wholesale'),
    rate_other: figure(json['rate_other'], 'rate_other'),
    report_due_date: String(json['report_due_date'] ?? ''),
  };
}

export interface TxFranchiseInput {
  rules: TxFranchiseRules;
  /** Entity registered/doing business in TX (nexus). Everything below is moot without it. */
  registered_in_tx: boolean;
  /** Annualized total revenue (decimal string). */
  annualized_revenue: string;
  /** Retail/wholesale rate class (affects the upper-bound note only). */
  is_retail_wholesale: boolean;
}

export interface TxFranchiseStatus {
  nexus: boolean;
  below_no_tax_due_threshold: boolean;
  /** What must be filed this report year. */
  filings_required: ('public_information_report' | 'franchise_tax_report')[];
  report_due_date: string;
  /**
   * UPPER-BOUND exposure = revenue × rate. The real margin base (lowest of
   * 70% revenue / revenue−COGS / revenue−compensation / revenue−$1M) is NOT
   * computed — this is compliance tracking, not a tax computation.
   */
  upper_bound_exposure: string;
  notes: string[];
}

export function txFranchiseStatus(input: TxFranchiseInput): TxFranchiseStatus {
  const { rules } = input;
  if (!input.registered_in_tx) {
    return {
      nexus: false,
      below_no_tax_due_threshold: false,
      filings_required: [],
      report_due_date: rules.report_due_date,
      upper_bound_exposure: '0',
      notes: ['no TX registration/nexus recorded — no franchise obligations tracked'],
    };
  }
  const revenue = Money.fromString(input.annualized_revenue);
  const threshold = Money.fromString(rules.no_tax_due_threshold);
  const below = revenue.lte(threshold);
  const rate = input.is_retail_wholesale ? rules.rate_retail_wholesale : rules.rate_other;
  const exposure = below ? Money.zero() : Money.max(Money.zero(), revenue).mulRate(rate).roundToDollar();
  const notes = [
    `annualized revenue ${revenue.toString()} vs no-tax-due threshold ${threshold.toString()} (Tex. Tax Code §171.002(d))`,
    below
      ? 'at/below threshold: no franchise tax due; the Public Information Report is still required (post-2023 regime — the No Tax Due Report was retired)'
      : `above threshold: franchise tax report required; upper-bound exposure ${exposure.toString()} = revenue × ${rate} (the margin base — lowest of 70% revenue / revenue−COGS / revenue−compensation / revenue−$1M — is NOT computed; tracking only)`,
  ];
  return {
    nexus: true,
    below_no_tax_due_threshold: below,
    filings_required: below
      ? ['public_information_report']
      : ['public_information_report', 'franchise_tax_report'],
    report_due_date: rules.report_due_date,
    upper_bound_exposure: exposure.toString(),
    notes,
  };
}
