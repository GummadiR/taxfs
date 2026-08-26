/**
 * Materiality policy (P0 — REQUIREMENTS §3 supporting controls).
 *
 * The thresholds the engagement gates use (YoY variance %, dollar floors,
 * confirmation tiers) are defined HERE as versioned, cited rule data —
 * never as magic numbers inside a gate. Gate runs cite the policy version
 * they were evaluated under.
 */

export interface MaterialityPolicy {
  policy_version: string;
  tax_year: number;
  /** Gate 9: a YoY variance is material when BOTH bounds are exceeded. */
  yoy_variance_ratio: string; // e.g. "0.20" = 20%
  yoy_variance_floor: string; // e.g. "1000" dollars
  /** Gate 3/R1: a prior-year payer absent this year is flagged above this. */
  missing_source_floor: string;
  /** Intake: values at/above this are "critical" (type-to-verify). */
  critical_value_floor: string;
  notes: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function decimalString(raw: unknown, path: string): string {
  if (typeof raw !== 'string' || !/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new Error(`materiality policy ${path}: expected a decimal string`);
  }
  return raw;
}

export function loadMaterialityPolicy(json: unknown): MaterialityPolicy {
  if (!isRecord(json)) throw new Error('materiality policy: expected object');
  const meta = json['_meta'];
  if (!isRecord(meta) || meta['kind'] !== 'MATERIALITY-POLICY') {
    throw new Error('materiality policy: _meta.kind must be "MATERIALITY-POLICY"');
  }
  if (typeof meta['policy_version'] !== 'string' || typeof meta['tax_year'] !== 'number') {
    throw new Error('materiality policy: _meta.policy_version (string) and _meta.tax_year (number) required');
  }
  const p = json['parameters'];
  if (!isRecord(p)) throw new Error('materiality policy: parameters missing');
  return {
    policy_version: meta['policy_version'],
    tax_year: meta['tax_year'],
    yoy_variance_ratio: decimalString(p['yoy_variance_ratio'], 'yoy_variance_ratio'),
    yoy_variance_floor: decimalString(p['yoy_variance_floor'], 'yoy_variance_floor'),
    missing_source_floor: decimalString(p['missing_source_floor'], 'missing_source_floor'),
    critical_value_floor: decimalString(p['critical_value_floor'], 'critical_value_floor'),
    notes: typeof json['notes'] === 'string' ? json['notes'] : '',
  };
}
