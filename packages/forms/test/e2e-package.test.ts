/**
 * D.7 acceptance e2e: confirmed step-1 return → filled placeholder PDFs +
 * schema-valid XML (round-trip clean, byte-stable vs golden) + workpaper
 * index where every populated line resolves to lineage → locked versioned
 * package; a post-lock IL-only edit produces v2 touching only the IL chain.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import type { GateId, Jurisdiction } from '@taxfs/shared';
import { editSourceFact, seedScenario, type Scenario } from '@taxfs/gates';
import { PackageStore, buildPackage, type BuiltPackage, type Workpapers } from '@taxfs/forms';
import { loadFedRules, loadIlRules } from '../../kernel/test/helpers.js';
import { buildInputFor, fixedClock } from './helpers.js';

const fedRules = loadFedRules();
const ilRules = loadIlRules();
const golden = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../golden/${name}`, import.meta.url)), 'utf8');

let s: Scenario;

beforeEach(async () => {
  s = await seedScenario(fedRules, ilRules);
});

function hardGatesPassed(): boolean {
  const hard: GateId[] = [0, 1, 2, 3, 4, 6];
  const jurs: Jurisdiction[] = ['FED', 'IL'];
  return hard.every((g) => jurs.every((j) => s.orchestrator.gateState(g, j) === 'passed'));
}

async function buildFromScenario(): Promise<BuiltPackage> {
  const facts = await s.spine.getFacts({ taxpayer_id: 'tp-e2e', tax_year: 2025 });
  return buildPackage(
    buildInputFor('return1-single-w2', {
      taxpayer_id: 'tp-e2e',
      facts,
      gate_runs: (await s.spine.inspect()).gateRuns,
      hard_gates_passed: hardGatesPassed(),
      spine: s.spine,
    }),
  );
}

describe('end-to-end package (D.7)', () => {
  it('gates → clean build → golden byte-stable XML → workpapers fully lineaged → locked v1; IL-only edit → v2 touching only IL', async () => {
    await s.orchestrator.runAll();
    expect(hardGatesPassed()).toBe(true);

    const built = await buildFromScenario();
    expect(built.report.clean, JSON.stringify(built.report, null, 2)).toBe(true);

    // Form set: minimal scenario → 1040 / IL-1040 + Sch IL-WIT
    expect(built.instances.map((i) => i.form_id).sort()).toEqual(['1040', 'IL1040', 'SCHILWIT']);

    // Golden byte-stability per rule_version
    const xmlOf = (b: BuiltPackage, jur: string) =>
      b.artifacts.find((a) => a.target === 'mef_xml' && a.jurisdiction === jur)!.content;
    expect(xmlOf(built, 'FED')).toBe(golden('scenario1.FED.xml'));
    expect(xmlOf(built, 'IL')).toBe(golden('scenario1.IL.xml'));

    // Paper channel: placeholder PDFs for every form, positions marked TODO
    for (const instance of built.instances) {
      const pdf = built.artifacts.find((a) => a.artifact_id === `pdf:${instance.form_id}`);
      expect(pdf, instance.form_id).toBeDefined();
      expect(pdf?.content).toContain('POSITION-TODO');
    }

    // Workpapers: every populated line resolves to lineage; sourced lines
    // reach documents; derived lines carry their calc.
    const workpapers = JSON.parse(
      built.artifacts.find((a) => a.target === 'workpapers')!.content,
    ) as Workpapers;
    const populatedLineCount = built.instances.reduce((n, i) => n + Object.keys(i.values).length, 0);
    expect(workpapers.lines).toHaveLength(populatedLineCount);
    for (const line of workpapers.lines) {
      expect(line.fact_id, line.line_id).toBeTruthy();
      expect(line.calc_id, line.line_id).toBeTruthy(); // every mapped line is a kernel-emitted fact
      expect(line.formula_ref, line.line_id).toBeTruthy();
    }
    // e.g. total income traces to both the W-2 and the 1099-INT
    const totalIncome = workpapers.lines.find((l) => l.line_id === '1040.9')!;
    expect(totalIncome.source_docs).toEqual(['s-int-1', 's-w2-1']);
    // Gate log is neutral: results only, no finding text
    expect(workpapers.gate_log.length).toBeGreaterThan(0);
    expect(Object.keys(workpapers.gate_log[0]!).sort()).toEqual([
      'gate', 'jurisdiction', 'result', 'rule_version', 'timestamp',
    ]);

    // Lock v1
    const store = new PackageStore(fixedClock);
    const v1 = store.commit(built);
    store.lock(v1.package_id);
    const v1FedXml = xmlOf(built, 'FED');
    const v1IlXml = xmlOf(built, 'IL');

    // Post-lock IL-only correction: unlock → edit → scoped cascade → rebuild
    store.unlock(v1.package_id, 'corrected IL withholding per amended W-2 box 17');
    await editSourceFact(s, 'f:w2-1:ilwh', '2200');
    const { reruns } = await s.orchestrator.handleFactMutation('f:w2-1:ilwh');
    expect(reruns.every((r) => r.jurisdiction === 'IL')).toBe(true); // scoped, not a full reset
    expect(reruns.filter((r) => r.gate !== 5).every((r) => r.result === 'pass')).toBe(true);
    expect(hardGatesPassed()).toBe(true);

    const rebuilt = await buildFromScenario();
    expect(rebuilt.report.clean).toBe(true);
    const v2 = store.commit(rebuilt);
    store.lock(v2.package_id);

    expect(v2.version).toBe(2);
    expect(v2.supersedes).toBe(v1.package_id);
    expect(v2.unlock_history.map((u) => u.reason)).toEqual(['corrected IL withholding per amended W-2 box 17']);

    // Only the affected chain changed: FED XML byte-identical, IL differs.
    expect(xmlOf(rebuilt, 'FED')).toBe(v1FedXml);
    expect(xmlOf(rebuilt, 'IL')).not.toBe(v1IlXml);
    expect(xmlOf(rebuilt, 'IL')).toContain('<IL1040_WithholdingAmt>2200</IL1040_WithholdingAmt>');

    // v1 retained, still locked, still readable (runtime-state archival)
    const history = store.history('tp-e2e', 2025);
    expect(history.map((m) => m.version)).toEqual([1, 2]);
    expect(store.get(v1.package_id)?.manifest.status).toBe('locked');
    expect(store.get(v1.package_id)?.artifacts.find((a) => a.jurisdiction === 'IL')?.content).toBe(v1IlXml);
  });

  it('packaging refuses when hard gates have not passed (never bypasses gates)', async () => {
    // No orchestrator run → gates pending.
    const built = await buildFromScenario();
    expect(built.report.clean).toBe(false);
    expect(built.report.completeness_errors.some((e) => e.includes('never bypasses gates'))).toBe(true);
  });
});
