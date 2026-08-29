/**
 * J.2 — SSN/EIN checksum-before-tokenization.
 * Structure is validated BEFORE a token is created: a malformed identifier
 * never becomes a token (garbage tokenized is garbage protected). Rules
 * come from PLACEHOLDER rule-data (2025.SECURITY.json) — real structure
 * rules must be verified before live data. Raw identifiers are never
 * stored or returned; the token embeds only a non-reversible hash suffix.
 */
import { PLACEHOLDER, inputHash } from '@taxfs/shared';

export interface SecurityRules {
  retention_years: number;
  ssn_invalid_areas: string[];
  ssn_area_max: number;
  ein_invalid_prefixes: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function marked(raw: unknown, path: string): Record<string, unknown> {
  if (!isRecord(raw) || raw['status'] !== PLACEHOLDER) {
    throw new Error(`security rules ${path}: missing "${PLACEHOLDER}" marker`);
  }
  return raw;
}

export function loadSecurityRules(json: unknown): SecurityRules {
  if (!isRecord(json)) throw new Error('security rules: expected object');
  return {
    retention_years: Number(marked(json['retention_years'], 'retention_years')['value']),
    ssn_invalid_areas: (marked(json['ssn_invalid_areas'], 'ssn_invalid_areas')['value'] as unknown[]).map(String),
    ssn_area_max: Number(marked(json['ssn_area_max'], 'ssn_area_max')['value']),
    ein_invalid_prefixes: (marked(json['ein_invalid_prefixes'], 'ein_invalid_prefixes')['value'] as unknown[]).map(String),
  };
}

export interface StructureCheck {
  valid: boolean;
  reason?: string;
}

export function checkSsnStructure(ssn: string, rules: SecurityRules): StructureCheck {
  const m = /^(\d{3})-(\d{2})-(\d{4})$/.exec(ssn.trim());
  if (!m) return { valid: false, reason: 'SSN must be formatted NNN-NN-NNNN' };
  const [, area, group, serial] = m;
  if (rules.ssn_invalid_areas.includes(area!)) return { valid: false, reason: `SSN area ${area} is never issued` };
  if (Number(area) > rules.ssn_area_max) return { valid: false, reason: `SSN area ${area} exceeds the issued range` };
  if (group === '00') return { valid: false, reason: 'SSN group 00 is never issued' };
  if (serial === '0000') return { valid: false, reason: 'SSN serial 0000 is never issued' };
  return { valid: true };
}

export function checkEinStructure(ein: string, rules: SecurityRules): StructureCheck {
  const m = /^(\d{2})-(\d{7})$/.exec(ein.trim());
  if (!m) return { valid: false, reason: 'EIN must be formatted NN-NNNNNNN' };
  if (rules.ein_invalid_prefixes.includes(m[1]!)) {
    return { valid: false, reason: `EIN prefix ${m[1]} is not assigned` };
  }
  return { valid: true };
}

/**
 * Validate-then-tokenize. Throws on structural failure — no token is ever
 * minted for a malformed identifier. The raw value is not retained.
 */
export function tokenizeIdentifier(
  kind: 'ssn' | 'ein',
  raw: string,
  rules: SecurityRules,
): string {
  const check = kind === 'ssn' ? checkSsnStructure(raw, rules) : checkEinStructure(raw, rules);
  if (!check.valid) {
    throw new Error(`refusing to tokenize ${kind.toUpperCase()}: ${check.reason} (checksum-before-tokenization)`);
  }
  return `tok_${kind}_${inputHash(`${kind}:${raw}`)}`;
}
