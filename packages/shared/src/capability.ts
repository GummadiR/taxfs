/**
 * Capability registry (P0 — REQUIREMENTS §3 Gate 1, ARCHITECTURE §3.3).
 *
 * Gate 1 (Scope Qualification) admits a return only when every form family
 * it requires is `production_ready` for the tax year. Status is DATA, never
 * a hardcoded topic list, and may only be advanced when the §4 verification
 * conditions hold — the evidence block records why.
 */
import { requiredFamilies, type FormFamily } from './concepts';

export type CapabilityStatus = 'absent' | 'in_development' | 'verified' | 'production_ready';

export interface Capability {
  form_family: FormFamily;
  tax_year: number;
  status: CapabilityStatus;
  /** Golden coverage refs, cross-check refs, rules sign-off ids (§4). */
  evidence: Record<string, unknown>;
}

export interface CapabilityRegistry {
  tax_year: number;
  capabilities: readonly Capability[];
}

export interface ScopeQualification {
  admitted: boolean;
  required: FormFamily[];
  /** Families required by the facts but not production_ready. */
  blocked: { family: FormFamily; status: CapabilityStatus }[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const STATUSES: readonly CapabilityStatus[] = ['absent', 'in_development', 'verified', 'production_ready'];

const FAMILIES: readonly FormFamily[] = [
  '1040_core',
  'capital_gains',
  'schedule_c',
  'depreciation',
  'k1_passthrough',
  'entity_return',
  'social_security',
  'foreign_tax_credit',
  'ptc',
];

export function loadCapabilityRegistry(json: unknown): CapabilityRegistry {
  if (!isRecord(json)) throw new Error('capability registry: expected object');
  const meta = json['_meta'];
  if (!isRecord(meta) || meta['kind'] !== 'CAPABILITY-REGISTRY' || typeof meta['tax_year'] !== 'number') {
    throw new Error('capability registry: _meta.kind must be "CAPABILITY-REGISTRY" with numeric tax_year');
  }
  const raw = json['capabilities'];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('capability registry: capabilities must be a non-empty array');
  }
  const seen = new Set<string>();
  const capabilities = raw.map((row, i) => {
    if (!isRecord(row)) throw new Error(`capability registry: capabilities[${i}] must be an object`);
    const family = row['form_family'];
    if (typeof family !== 'string' || !(FAMILIES as readonly string[]).includes(family)) {
      throw new Error(`capability registry: capabilities[${i}].form_family unknown: ${String(family)}`);
    }
    if (seen.has(family)) throw new Error(`capability registry: duplicate form_family ${family}`);
    seen.add(family);
    const status = row['status'];
    if (typeof status !== 'string' || !(STATUSES as readonly string[]).includes(status)) {
      throw new Error(`capability registry: capabilities[${i}].status unknown: ${String(status)}`);
    }
    // production_ready requires evidence — an empty claim cannot load (§4).
    const evidence = isRecord(row['evidence']) ? row['evidence'] : {};
    if (status === 'production_ready' && Object.keys(evidence).length === 0) {
      throw new Error(
        `capability registry: ${family} claims production_ready with no evidence — §4 conditions must be recorded`,
      );
    }
    return { form_family: family as FormFamily, tax_year: meta['tax_year'] as number, status: status as CapabilityStatus, evidence };
  });
  // Every family must be listed — absence is declared, never implied.
  for (const fam of FAMILIES) {
    if (!seen.has(fam)) throw new Error(`capability registry: form_family ${fam} missing (declare it, even as absent)`);
  }
  return { tax_year: meta['tax_year'], capabilities };
}

/** Gate 1: which families do these concepts require, and are they admitted? */
export function scopeQualification(
  conceptIds: readonly string[],
  registry: CapabilityRegistry,
): ScopeQualification {
  const required = requiredFamilies(conceptIds);
  const byFamily = new Map(registry.capabilities.map((c) => [c.form_family, c]));
  const blocked = required
    .map((family) => ({ family, status: byFamily.get(family)?.status ?? ('absent' as CapabilityStatus) }))
    .filter((r) => r.status !== 'production_ready');
  return { admitted: blocked.length === 0, required, blocked };
}
