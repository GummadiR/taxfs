/**
 * Golden benchmark harness (verified rule-data).
 *
 * Runs the benchmark return's INPUT facts through the kernel on the
 * SOURCE-VERIFIED 2025 rule-data (2025.FED.1.0 / 2025.IL.1.0 via the verified
 * adapter) and asserts dollar-for-dollar equality with the return's expected
 * 1040 / IL-1040 line outputs.
 *
 * It auto-detects your REAL return: if
 * rules/fixtures/benchmark-returns/2025.REAL.return1.json exists (gitignored —
 * it holds your actual tax figures), the harness uses it; otherwise it runs
 * the committed SAMPLE scaffold (dummy inputs whose expected lines are the
 * kernel's own output, so the scaffold is green). Once you populate REAL, any
 * kernel disagreement with your professionally-prepared return fails the test.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Money, loadVerifiedRuleSet, type FilingContext, type TaxFact } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { loadBenchmarkReturn, runAccuracyBenchmark, type BenchmarkReport } from '@taxfs/compliance';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const rd = (p: string) => JSON.parse(readFileSync(root(p), 'utf8'));

const TP = 'tp-benchmark';

const fedRules = loadVerifiedRuleSet(
  rd('rules/fixtures/2025.FED.1.0.json'),
  rd('rules/fixtures/2025.SYSTEM.FED.json'),
);
const ilRules = loadVerifiedRuleSet(
  rd('rules/fixtures/2025.IL.1.0.json'),
  rd('rules/fixtures/2025.SYSTEM.IL.json'),
);

const SAMPLE = 'rules/fixtures/benchmark-returns/2025.SAMPLE.return1.json';

/** Run a benchmark-return fixture through the kernel on the verified rules. */
function runBenchmark(relPath: string): BenchmarkReport {
  const ret = loadBenchmarkReturn(rd(relPath));
  const facts: TaxFact[] = ret.input_facts.map((row) => ({
    fact_id: row.fact_id,
    taxpayer_id: TP,
    concept: row.concept,
    tax_year: 2025,
    jurisdiction: row.jurisdiction,
    taxpayer_scope: row.scope ?? 'primary',
    value: Money.fromString(row.value),
    unit: 'USD' as const,
    status: 'confirmed' as const,
    confidence: 0.99,
    provenance: [{ source_id: `s:${row.fact_id}`, source_field: 'value' }],
  }));
  const ctx: FilingContext = {
    taxpayer_id: TP,
    tax_year: 2025,
    filing_status: ret.filing_status,
    il_exemption_count: ret.il_exemption_count,
    addl_std_boxes: ret.addl_std_boxes,
    rule_versions: { FED: fedRules.rule_version, IL: ilRules.rule_version },
  };
  const result = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fedRules, il_rules: ilRules });
  return runAccuracyBenchmark(ret.benchmark, result.computedFacts);
}

/** Every REAL return you drop in (2025.REAL.return1.json, .return2.json, … —
 *  one per person/return, all gitignored) is auto-discovered and anchored. When
 *  none exist, the committed SAMPLE scaffold runs so the suite is green for
 *  anyone who has no local returns. */
function discoverRealReturns(): string[] {
  const dir = 'rules/fixtures/benchmark-returns';
  const abs = root(dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => /^2025\.REAL\.return.*\.json$/.test(f) && !f.endsWith('.template.json'))
    .sort()
    .map((f) => `${dir}/${f}`);
}

describe('golden benchmark: verified rule-data vs professional return', () => {
  const real = discoverRealReturns();
  const targets = real.length > 0 ? real : [SAMPLE];

  it.each(targets)('ties dollar-for-dollar through the kernel on verified data [%s]', (relPath) => {
    const report = runBenchmark(relPath);
    // Lines where TaxFS deliberately diverges from the preparer (e.g. a §469(i)
    // MAGI the preparer got wrong) are documented in the fixture and excluded
    // from the tie — expected_lines already hold TaxFS's corrected value there.
    const ret = loadBenchmarkReturn(rd(relPath));
    const divergent = new Set(Object.keys(ret.preparer_divergences));
    const realDeltas = report.deltas.filter((d) => !divergent.has(d.concept));
    expect(realDeltas, JSON.stringify(report.deltas, null, 2)).toEqual([]);
    expect(report.lines_compared).toBeGreaterThan(0);
  });

  it('the harness actually catches drift: a tampered expected line reports a delta', () => {
    const ret = loadBenchmarkReturn(rd(SAMPLE));
    const facts: TaxFact[] = ret.input_facts.map((row) => ({
      fact_id: row.fact_id,
      taxpayer_id: TP,
      concept: row.concept,
      tax_year: 2025,
      jurisdiction: row.jurisdiction,
      taxpayer_scope: row.scope ?? 'primary',
      value: Money.fromString(row.value),
      unit: 'USD' as const,
      status: 'confirmed' as const,
      confidence: 0.99,
      provenance: [{ source_id: `s:${row.fact_id}`, source_field: 'value' }],
    }));
    const ctx: FilingContext = {
      taxpayer_id: TP,
      tax_year: 2025,
      filing_status: ret.filing_status,
      il_exemption_count: ret.il_exemption_count,
      addl_std_boxes: ret.addl_std_boxes,
      rule_versions: { FED: fedRules.rule_version, IL: ilRules.rule_version },
    };
    const result = compute({ taxpayer_id: TP, tax_year: 2025, ctx, facts, fed_rules: fedRules, il_rules: ilRules });
    const tampered = {
      ...ret.benchmark,
      expected_lines: { ...ret.benchmark.expected_lines, 'fed.tax.total': '9999' },
    };
    const report = runAccuracyBenchmark(tampered, result.computedFacts);
    expect(report.clean).toBe(false);
    expect(report.deltas.some((d) => d.concept === 'fed.tax.total')).toBe(true);
  });
});
