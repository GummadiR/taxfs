/** Test helpers shared by kernel + gates suites (test-only, not kernel src). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Money,
  loadRuleSet,
  type FilingContext,
  type FilingStatus,
  type Jurisdiction,
  type RuleSet,
  type TaxFact,
  type TaxpayerScope,
} from '@taxfs/shared';

export const TP = 'tp-golden';

export interface GoldenFactRow {
  fact_id: string;
  concept: string;
  value: string;
  jurisdiction: Jurisdiction[];
  scope?: TaxpayerScope;
}

export interface GoldenFixture {
  name: string;
  description: string;
  filing_status: FilingStatus;
  il_exemption_count: number;
  addl_std_boxes?: number;
  facts: GoldenFactRow[];
  expected: Record<string, string>;
}

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

export function loadFedRules(): RuleSet {
  return loadRuleSet(JSON.parse(readFileSync(root('rules/fixtures/2025.FED.json'), 'utf8')));
}

export function loadIlRules(): RuleSet {
  return loadRuleSet(JSON.parse(readFileSync(root('rules/fixtures/2025.IL.json'), 'utf8')));
}

export function loadGolden(name: string): GoldenFixture {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`../golden/${name}.json`, import.meta.url)), 'utf8'),
  ) as GoldenFixture;
}

export const GOLDEN_NAMES = ['return1-single-w2', 'return2-w2-1099int', 'return3-mfj-multidoc', 'return4-schc-se', 'return5-schc-startup', 'return6-schc-homeoffice', 'return7-schc-vehicle', 'return8-schc-depreciation', 'return9-hoh-itemized', 'return10-mfs-schc', 'return11-qss-w2', 'return12-sec179-split', 'return13-se-floor', 'return14-schd-gains', 'return15-schd-loss-cap', 'return16-schd-mfs-wash', 'return17-k1-scorp-qbi', 'return18-k1-passive-cascade', 'return19-k1-debt-basis', 'return20-backtest-2022-oracle', 'return21-ptc-net-credit', 'return22-ptc-repayment-capped', 'return23-ptc-cliff', 'return24-il-property-tax-credit', 'return25-addl-medicare-niit', 'return26-solar-credit', 'return27-foreign-tax-credit', 'return28-foreign-fcy', 'return29-foreign-plus-brokerage',
  // P69 — goldens for the paths P49–P68 added. Before this the CI-enforced
  // golden and divergence suites had NO coverage of any of them: the unit
  // tests passed while a regression in the tax logic would ship silently.
  'return30-schedule-a-salt', 'return31-schedule-a-salt-capped', 'return32-foreign-ltcg-declared',
  'return33-ftc-904j-election', 'return34-dependent-care-2441', 'return35-early-distribution-5329',
  'return36-il-exempt-interest-addback', 'return37-sec469g-disposition', 'return38-estimated-tax-penalties',
  // P98 — the contribution-validation paths (P93-P97) join the CI net.
  'return39-hsa-ira-deductions', 'return40-deferral-roth-excess'];

export function factsOf(golden: GoldenFixture, taxYear = 2025): TaxFact[] {
  return golden.facts.map((row) => ({
    fact_id: row.fact_id,
    taxpayer_id: TP,
    concept: row.concept,
    tax_year: taxYear,
    jurisdiction: row.jurisdiction,
    taxpayer_scope: row.scope ?? 'primary',
    value: Money.fromString(row.value),
    unit: 'USD' as const,
    status: 'confirmed' as const,
    confidence: 0.99,
    provenance: [{ source_id: `s:${row.fact_id}`, source_field: 'value' }],
  }));
}

export function ctxOf(golden: GoldenFixture, fed: RuleSet, il: RuleSet): FilingContext {
  return {
    taxpayer_id: TP,
    tax_year: 2025,
    filing_status: golden.filing_status,
    il_exemption_count: golden.il_exemption_count,
    addl_std_boxes: golden.addl_std_boxes ?? 0,
    rule_versions: { FED: fed.rule_version, IL: il.rule_version },
  };
}
