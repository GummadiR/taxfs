/**
 * G.3/G.4 acceptance: Defense File assembles end-to-end from existing
 * structures with zero manual entry, versioned per package version,
 * AckRecords structurally absent; benchmark release loads versioned and
 * the comp memo cites dataset+version+vintage (golden regression).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Clock } from '@taxfs/shared';
import { seedScenario } from '@taxfs/gates';
import { PackageStore, buildPackage, type PackageManifest } from '@taxfs/forms';
import {
  BenchmarkStore,
  CaptureStore,
  RiskLedger,
  buildCompMemo,
  buildDefenseFile,
  buildReconciliation,
  loadBenchmarkRelease,
  loadCaptureRules,
  type CompMemo,
  type DefenseFile,
} from '@taxfs/defense';
import { buildInputFor } from '../../forms/test/helpers';
import { loadFedRules, loadIlRules } from '../../kernel/test/helpers';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const clock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };

const benchmarkJson = JSON.parse(readFileSync(root('rules/fixtures/benchmarks/2025.BLS-OEWS.MOCK.json'), 'utf8'));
const captureRules = loadCaptureRules(JSON.parse(readFileSync(root('rules/fixtures/2025.CAPTURE-RULES.json'), 'utf8')));

let defense: DefenseFile;
let memo: CompMemo;
let ledgerSize = 0;
let capture: CaptureStore;
let manifest: PackageManifest;

beforeAll(async () => {
  const s = await seedScenario(loadFedRules(), loadIlRules());
  await s.orchestrator.runAll();
  const facts = await s.spine.getFacts({ taxpayer_id: 'tp-e2e', tax_year: 2025 });
  const pkg = await buildPackage(
    buildInputFor('return1-single-w2', {
      taxpayer_id: 'tp-e2e',
      facts,
      gate_runs: (await s.spine.inspect()).gateRuns,
      hard_gates_passed: true,
      spine: s.spine,
    }),
  );
  const store = new PackageStore(clock);
  manifest = store.commit(pkg);
  store.lock(manifest.package_id);

  const benchmarks = new BenchmarkStore();
  benchmarks.load(loadBenchmarkRelease(benchmarkJson));
  memo = buildCompMemo({
    store: benchmarks,
    dataset: 'BLS_OEWS',
    version: 'BLS-OEWS.MOCK.0.0.1-PLACEHOLDER',
    clock,
    revenue_source_analysis:
      'Revenue derives from the owner’s personal services (fixture analysis) — substance drives the range.',
    roles: [
      { soc_code: '15-1252', weight_pct: '0.6' },
      { soc_code: '11-1021', weight_pct: '0.4' },
    ],
  });

  capture = new CaptureStore(clock, captureRules);
  capture.addMileage({ trip_date: '2025-03-02', purpose: 'client kickoff at Rivera & Co, Naperville', miles: '31' });
  capture.addMileage({ trip_date: '2025-03-05', purpose: 'business meeting', miles: '12' }); // incomplete → excluded

  const ledger = new RiskLedger(clock);
  const profile = ledger.assembleProfile({
    taxpayer_id: 'tp-e2e',
    tax_year: 2025,
    rule_version: 'rv',
    gateRuns: (await s.spine.inspect()).gateRuns,
  });
  ledger.acknowledge({
    item: profile.items[0]!,
    user_id: 'tp-e2e',
    disclosure_shown: 'ledger record; can be legally compelled (IRS §7602 summons).',
    note: 'SECRET-RATIONALE-MARKER reviewed against the substantiation index',
  });
  ledgerSize = ledger.ledger().length;

  const stored = store.get(manifest.package_id)!;
  const sources = await s.spine.getSources('tp-e2e', 2025);
  defense = buildDefenseFile(
    {
      manifest: stored.manifest,
      artifacts: stored.artifacts,
      reconciliation: buildReconciliation(facts, sources, '2026-07-02'),
      memos: [memo],
      capture_records: capture.defenseEligible(),
      gate_runs: (await s.spine.inspect()).gateRuns,
    },
    clock,
  );
});

describe('Defense File builder (G.3)', () => {
  it('assembles all sections from existing structures, versioned per package version', () => {
    expect(defense.defense_file_id).toMatch(/-v1$/);
    expect(defense.package_version).toBe(1);
    expect(defense.sections.map((x) => x.section_id)).toEqual([
      'returns',
      'substantiation-index',
      'reconciliation',
      'position-memos',
      'contemporaneous',
      'basis-carryforward',
      'gate-log',
    ]);
    const returns = defense.sections[0]!;
    expect(returns.files.some((f) => f.name === 'xml:FED')).toBe(true);
    expect(returns.files.some((f) => f.name.startsWith('pdf:'))).toBe(true);
    expect(defense.bundle_index).toContain('SECTION gate-log');
  });

  it('AckRecords are structurally absent (S2); exclusion stated without the word "private"', () => {
    expect(ledgerSize).toBe(1); // an ack exists in the platform ledger…
    const serialized = JSON.stringify(defense);
    expect(serialized).not.toContain('SECRET-RATIONALE-MARKER'); // …but never reaches the bundle
    expect(serialized).not.toContain('"ack_id"');
    expect(defense.exclusion_note).toMatch(/7602/);
    expect(serialized).not.toMatch(/\bprivate\b/i);
    expect(serialized).not.toMatch(/score/i);
  });

  it('reconciliation is lag-guarded; only substantiation-complete capture included', () => {
    const recon = defense.sections.find((x) => x.section_id === 'reconciliation')!;
    expect(recon.files[0]?.content).toContain('Partially verified');
    const contemporaneous = defense.sections.find((x) => x.section_id === 'contemporaneous')!;
    expect(contemporaneous.files).toHaveLength(1); // the generic-purpose trip is excluded
    expect(contemporaneous.files[0]?.content).toContain('Rivera');
  });

  it('refuses an incomplete capture record outright', () => {
    const incomplete = capture.current().find((r) => r.substantiation === 'incomplete')!;
    expect(() =>
      buildDefenseFile(
        {
          manifest,
          artifacts: [],
          reconciliation: { status: 'x', lag_caveat: 'x', matches: [] },
          memos: [],
          capture_records: [incomplete],
          gate_runs: [],
        },
        clock,
      ),
    ).toThrow(/274\(d\)/);
  });

  it('gate log is neutral: results and timestamps only, no finding text', () => {
    const log = defense.sections.find((x) => x.section_id === 'gate-log')!.files[0]!.content;
    expect(log).toContain('NEUTRAL GATE LOG');
    expect(log).toMatch(/gate 5\s+FED\s+warn/);
    expect(log).not.toContain('round-number'); // no finding messages
  });
});

describe('benchmark lifecycle (G.4)', () => {
  it('memo cites dataset + version + vintage; range is a golden regression', () => {
    expect(memo.citations[0]).toContain('BLS_OEWS');
    expect(memo.citations[0]).toContain('BLS-OEWS.MOCK.0.0.1-PLACEHOLDER');
    expect(memo.citations[0]).toContain('May 2024');
    // Golden: 0.6×92000 + 0.4×78000 = 86400 ; 0.6×148000 + 0.4×141000 = 145200
    expect(memo.range_low).toBe('86400');
    expect(memo.range_high).toBe('145200');
    expect(memo.language_note).toMatch(/not a floor/);
  });

  it('releases are immutable: double-load throws', () => {
    const store2 = new BenchmarkStore();
    store2.load(loadBenchmarkRelease(benchmarkJson));
    expect(() => store2.load(loadBenchmarkRelease(benchmarkJson))).toThrow(/immutable/);
  });
});
