/**
 * P5.1 — FBAR (FinCEN Form 114) threshold monitor + filing-output payload
 * (REQUIREMENTS §international). TaxFS monitors the aggregate-maximum
 * threshold and GENERATES the per-account filing data — the FBAR itself is
 * filed externally through the BSA e-filing system (never transmitted from
 * here, same non-goal as MeF). Parameters are rule-data (2025.FBAR.json,
 * PLACEHOLDER): $10,000 aggregate threshold (31 CFR §1010.350), due date
 * (Apr 15) with the automatic FinCEN extension (Oct 15).
 *
 * Two deliberate mechanics from the FinCEN instructions:
 * - Balances round UP to the next whole dollar (not HALF_UP).
 * - The threshold tests the SUM OF PER-ACCOUNT MAXIMUMS — money moved
 *   between accounts counts twice; the instructions accept that.
 */
import { Money, PLACEHOLDER } from '@taxfs/shared';

export interface FbarRules {
  /** Aggregate maximum-balance threshold (31 U.S.C. §5314 / 31 CFR §1010.350). */
  aggregate_threshold: string;
  report_due_date: string;
  automatic_extension_date: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function figure(raw: unknown, path: string): string {
  if (!isRecord(raw) || raw['status'] !== PLACEHOLDER || typeof raw['value'] !== 'string') {
    throw new Error(`fbar rules ${path}: figure with "${PLACEHOLDER}" marker required`);
  }
  return raw['value'];
}

export function loadFbarRules(json: unknown): FbarRules {
  if (!isRecord(json)) throw new Error('fbar rules: expected object');
  return {
    aggregate_threshold: figure(json['aggregate_threshold'], 'aggregate_threshold'),
    report_due_date: String(json['report_due_date'] ?? ''),
    automatic_extension_date: String(json['automatic_extension_date'] ?? ''),
  };
}

export interface ForeignAccount {
  account_id: string; // internal id — NEVER the real account number in facts/logs
  /** Maximum value during the year, already in USD (Treasury year-end rate conversion is intake work). */
  max_balance_usd: string;
  country: string;
  institution_ref: string; // reference to the encrypted detail record, not the detail itself
  jointly_owned: boolean;
}

export interface FbarStatus {
  filing_required: boolean;
  aggregate_max: string; // sum of rounded-UP per-account maxima
  threshold: string;
  report_due_date: string;
  automatic_extension_date: string;
  /** Per-account output rows for the externally-filed FinCEN 114. */
  output_rows: { account_id: string; max_balance_rounded: string; country: string; jointly_owned: boolean }[];
  notes: string[];
}

export function fbarStatus(input: { rules: FbarRules; accounts: ForeignAccount[] }): FbarStatus {
  const { rules, accounts } = input;
  const rows = accounts.map((a) => {
    const rounded = Money.fromString(a.max_balance_usd).roundUpToDollar();
    if (rounded.isNegative()) {
      throw new Error(`fbar: account ${a.account_id} has a negative max balance — fix the intake data`);
    }
    return {
      account_id: a.account_id,
      max_balance_rounded: rounded.toString(),
      country: a.country,
      jointly_owned: a.jointly_owned,
    };
  });
  const aggregate = Money.sum(rows.map((r) => Money.fromString(r.max_balance_rounded)));
  const threshold = Money.fromString(rules.aggregate_threshold);
  const required = aggregate.gt(threshold);
  const notes = [
    `aggregate of per-account maxima ${aggregate.toString()} vs threshold ${threshold.toString()} (31 CFR §1010.350; transfers between accounts intentionally double-count per the FinCEN instructions)`,
    required
      ? `FBAR REQUIRED — due ${rules.report_due_date}, automatic extension to ${rules.automatic_extension_date}; filed externally via BSA e-filing (TaxFS generates the data, never transmits)`
      : 'below the aggregate threshold — no FBAR required this year (signature authority and non-account assets are intake questions, not covered by this monitor)',
  ];
  if (accounts.length === 0) notes.push('no foreign accounts recorded');
  return {
    filing_required: required,
    aggregate_max: aggregate.toString(),
    threshold: threshold.toString(),
    report_due_date: rules.report_due_date,
    automatic_extension_date: rules.automatic_extension_date,
    output_rows: rows,
    notes,
  };
}
