/** Forms test rig: fixture loaders + BuildInput assembly over golden facts. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KERNEL_VERSION } from '@taxfs/kernel';
import type { Clock, GateRun, TaxFact } from '@taxfs/shared';
import type { LineageNode } from '@taxfs/spine';
import {
  buildPackage,
  loadBusinessRules,
  loadFormDefRelease,
  loadStubXsd,
  type BuildInput,
  type BuiltPackage,
  type FormDefRelease,
} from '@taxfs/forms';
import { buildCtx } from '../../gates/test/helpers.js';
import { loadFedRules, loadIlRules } from '../../kernel/test/helpers.js';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const readJson = (p: string): unknown => JSON.parse(readFileSync(root(p), 'utf8'));

export const fedRelease: FormDefRelease = loadFormDefRelease(readJson('rules/fixtures/forms/2025.FORMS.FED.json'));
export const ilRelease: FormDefRelease = loadFormDefRelease(readJson('rules/fixtures/forms/2025.FORMS.IL.json'));
export const stubFed = loadStubXsd(readJson('rules/fixtures/schemas/2025.FED.STUBXSD.json'));
export const stubIl = loadStubXsd(readJson('rules/fixtures/schemas/2025.IL.STUBXSD.json'));
export const bizRules = loadBusinessRules(readJson('rules/fixtures/2025.BIZRULES.json'));
export const pdfTemplatesJson = readJson('rules/fixtures/pdf/2025.PDF-TEMPLATES.json');

export const fixedClock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };
const fedRules = loadFedRules();
const ilRules = loadIlRules();

/** Sourced + derived facts for a golden return (via the gates test helper). */
export function factsFor(goldenName: string): TaxFact[] {
  return buildCtx(goldenName).facts;
}

/** Lineage stub for unit tests (real lineage is exercised in the e2e over InMemorySpine). */
export function stubSpine(facts: TaxFact[]): { getLineage(id: string): Promise<LineageNode> } {
  const byId = new Map(facts.map((f) => [f.fact_id, f]));
  return {
    getLineage: async (id: string): Promise<LineageNode> => {
      const fact = byId.get(id);
      if (!fact) throw new Error(`stub lineage: fact ${id} not found`);
      return { fact };
    },
  };
}

export function buildInputFor(
  goldenName: string,
  overrides: Partial<BuildInput> = {},
): BuildInput {
  const facts = overrides.facts ?? factsFor(goldenName);
  const gateRuns: GateRun[] = [];
  return {
    taxpayer_id: 'tp-golden',
    tax_year: 2025,
    facts,
    gate_runs: gateRuns,
    hard_gates_passed: true,
    rule_versions: { FED: fedRules.rule_version, IL: ilRules.rule_version },
    kernel_version: KERNEL_VERSION,
    releases: { fed: fedRelease, il: ilRelease },
    stub_xsd: { fed: stubFed, il: stubIl },
    business_rules: bizRules,
    pdf_templates: pdfTemplatesJson,
    spine: stubSpine(facts),
    clock: fixedClock,
    ...overrides,
  };
}

export async function buildFor(goldenName: string, overrides: Partial<BuildInput> = {}): Promise<BuiltPackage> {
  return buildPackage(buildInputFor(goldenName, overrides));
}
