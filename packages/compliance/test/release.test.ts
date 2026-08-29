/**
 * J.4/J.5 acceptance: the compliance-review gate — no release tag without
 * a populated release record — plus the full dry run on the step-1 rule
 * set: golden suites green, benchmark run, record populated, stub signer.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Clock } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import {
  RELEASE_SCOPE_STATEMENT,
  ReleaseRegistry,
  compareGoldenExpectations,
  createReleaseRecord,
  loadProfessionalBenchmark,
  runAccuracyBenchmark,
  type BenchmarkReport,
} from '@taxfs/compliance';
import { GOLDEN_NAMES, TP, ctxOf, factsOf, loadGolden } from '../../kernel/test/helpers';
import { fedRules, ilRules } from '../../gates/test/helpers';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const clock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };

function cleanBenchmark(): BenchmarkReport {
  const benchmark = loadProfessionalBenchmark(
    JSON.parse(readFileSync(root('rules/fixtures/benchmark-returns/2025.PRO-PREPARED.return1.json'), 'utf8')),
  );
  const golden = loadGolden('return1-single-w2');
  const result = compute({
    taxpayer_id: TP,
    tax_year: 2025,
    ctx: ctxOf(golden, fedRules, ilRules),
    facts: factsOf(golden),
    fed_rules: fedRules,
    il_rules: ilRules,
  });
  return runAccuracyBenchmark(benchmark, result.computedFacts);
}

const SUITES = { suites: ['kernel-goldens', 'critics', 'agents', 'packages', 'e2e', 'copy-lint'], total_tests: 250, failed: 0 };
const SIGNER = { name: 'Stub Signer, EA (DEMO — a named human, never a build step)', credential: 'EA #0000000 (STUB)' };

describe('release record validation (J.4)', () => {
  it('refuses an unnamed signer, failing suites, or a dirty benchmark', () => {
    const benchmark = cleanBenchmark();
    expect(() =>
      createReleaseRecord({
        release_tag: 'r1',
        rule_versions: {},
        signer: { name: '  ', credential: '' },
        clock,
        suite_results: SUITES,
        benchmark,
      }),
    ).toThrow(/NAMED signer/);
    expect(() =>
      createReleaseRecord({
        release_tag: 'r1',
        rule_versions: {},
        signer: SIGNER,
        clock,
        suite_results: { ...SUITES, failed: 1 },
        benchmark,
      }),
    ).toThrow(/must be green/);
    expect(() =>
      createReleaseRecord({
        release_tag: 'r1',
        rule_versions: {},
        signer: SIGNER,
        clock,
        suite_results: SUITES,
        benchmark: { ...benchmark, clean: false, deltas: [{ concept: 'x', ours: '1', professional: '2', difference: '-1' }] },
      }),
    ).toThrow(/unexplained delta/);
  });

  it('CI gate: tagging without a record fails; scope statement is the fixed wording', () => {
    const registry = new ReleaseRegistry();
    expect(() => registry.tagRelease('2025.FED.0.0.1-PLACEHOLDER', null)).toThrow(/no release record/);
    expect(() => registry.tagRelease('2025.FED.0.0.1-PLACEHOLDER', undefined)).toThrow(/compliance gate is not optional/);
    const record = createReleaseRecord({
      release_tag: 'tag-a',
      rule_versions: { FED: fedRules.rule_version },
      signer: SIGNER,
      clock,
      suite_results: SUITES,
      benchmark: cleanBenchmark(),
    });
    expect(() => registry.tagRelease('tag-b', record)).toThrow(/does not match/);
    const doctored = { ...record, scope_statement: 'certifies everything forever' as never };
    expect(() => registry.tagRelease('tag-a', doctored)).toThrow(/scope statement/);
  });
});

describe('compliance-gate DRY RUN on the step-1 rule set (J.5)', () => {
  it('golden suites green → benchmark clean → record populated → tag succeeds', () => {
    // 1. Golden suites: every fixture return matches its expectations.
    let totalLines = 0;
    for (const name of GOLDEN_NAMES) {
      const golden = loadGolden(name);
      const result = compute({
        taxpayer_id: TP,
        tax_year: 2025,
        ctx: ctxOf(golden, fedRules, ilRules),
        facts: factsOf(golden),
        fed_rules: fedRules,
        il_rules: ilRules,
      });
      const deltas = compareGoldenExpectations(result.computedFacts, golden.expected);
      expect(deltas, name).toEqual([]);
      totalLines += Object.keys(golden.expected).length;
    }

    // 2. Accuracy benchmark vs the professional anchor.
    const benchmark = cleanBenchmark();
    expect(benchmark.clean).toBe(true);

    // 3. Populated release record with the stub signer + exact scope wording.
    const record = createReleaseRecord({
      release_tag: '2025.STEP1.dryrun-PLACEHOLDER',
      rule_versions: { FED: fedRules.rule_version, IL: ilRules.rule_version },
      signer: SIGNER,
      clock,
      suite_results: { suites: ['kernel-goldens'], total_tests: totalLines, failed: 0 },
      benchmark,
    });
    expect(record.scope_statement).toBe(RELEASE_SCOPE_STATEMENT);
    expect(record.scope_statement).toContain('not certify any individual taxpayer return');
    expect(record.signer.name).toContain('Stub Signer');
    expect(record.signed_date).toBe('2026-07-02');
    expect(record.benchmark_results.deltas).toBe(0);

    // 4. The tag exists only because the record does.
    const registry = new ReleaseRegistry();
    const tagged = registry.tagRelease('2025.STEP1.dryrun-PLACEHOLDER', record);
    expect(Object.isFrozen(tagged)).toBe(true);
    expect(registry.get('2025.STEP1.dryrun-PLACEHOLDER')?.signer.credential).toContain('STUB');
  });
});
