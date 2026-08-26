/**
 * MeF schema catalog (P0 — ARCHITECTURE §8, REQUIREMENTS §3 Gate 10).
 *
 * Real IRS MeF / state XSDs are year-specific procurement artifacts vendored
 * under `schemas/mef/<tax_year>/<jurisdiction>/` (see schemas/mef/README.md).
 * The catalog reports, per (year, jurisdiction), whether validation runs in
 * `real` mode (vendored XSDs present) or `stub` mode (fixture stand-in).
 *
 * HONESTY RULE: stub mode is never silent — Gate 10 must surface it, and the
 * §4 production-ready definition requires real-mode validation. When XSDs
 * are vendored, a real SchemaValidator implementation replaces the stub
 * behind the existing interface (validate.ts); this catalog is what tells
 * the gate which one it exercised.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Jurisdiction } from '@taxfs/shared';

export type SchemaMode = 'real' | 'stub';

export interface SchemaCatalogEntry {
  tax_year: number;
  jurisdiction: Jurisdiction;
  mode: SchemaMode;
  /** Absolute dir of vendored XSDs (real mode) or null (stub mode). */
  schema_dir: string | null;
  /** .xsd files found (real mode); empty in stub mode. */
  xsd_files: string[];
}

/** Repo-relative vendoring convention. */
export function schemaDirFor(rootDir: string, taxYear: number, jurisdiction: Jurisdiction): string {
  return join(rootDir, 'schemas', 'mef', String(taxYear), jurisdiction);
}

/**
 * Resolve the validation mode for a (year, jurisdiction). A directory with
 * at least one .xsd file switches the catalog to real mode; anything else
 * (missing dir, empty dir) is stub mode.
 */
export function resolveSchemaCatalog(
  rootDir: string,
  taxYear: number,
  jurisdiction: Jurisdiction,
): SchemaCatalogEntry {
  const dir = schemaDirFor(rootDir, taxYear, jurisdiction);
  if (!existsSync(dir)) {
    return { tax_year: taxYear, jurisdiction, mode: 'stub', schema_dir: null, xsd_files: [] };
  }
  const xsds = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.xsd')).sort();
  if (xsds.length === 0) {
    return { tax_year: taxYear, jurisdiction, mode: 'stub', schema_dir: null, xsd_files: [] };
  }
  return { tax_year: taxYear, jurisdiction, mode: 'real', schema_dir: dir, xsd_files: xsds };
}
