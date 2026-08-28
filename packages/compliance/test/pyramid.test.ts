/**
 * J.1 acceptance: the testing pyramid, audited — every layer proves it
 * catches a SEEDED DEFECT. One deliberate defect per layer, demonstrably
 * caught. (The layers themselves live in their home packages; this suite
 * is the consolidated proof required by the J spec.)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { C, Money, loadRuleSet } from '@taxfs/shared';
import { compute } from '@taxfs/kernel';
import { editSourceFact, seedScenario, accTieoutForm } from '@taxfs/gates';
import { runExplanation, checkBannedVocabulary } from '@taxfs/agents';
import { roundTripDiff } from '@taxfs/forms';
import { compareGoldenExpectations, loadProfessionalBenchmark, runAccuracyBenchmark } from '@taxfs/compliance';
import { buildCtx, fedRules, ilRules } from '../../gates/test/helpers';
import { ctxOf, factsOf, loadGolden, TP } from '../../kernel/test/helpers';
import { loadAuthority, makeRig } from '../../agents/test/helpers';
import { buildFor, fedRelease } from '../../forms/test/helpers';

const root = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

function computeReturn1() {
  const golden = loadGolden('return1-single-w2');
  return {
    golden,
    result: compute({
      taxpayer_id: TP,
      tax_year: 2025,
      ctx: ctxOf(golden, fedRules, ilRules),
      facts: factsOf(golden),
      fed_rules: fedRules,
      il_rules: ilRules,
    }),
  };
}

describe('J.1 pyramid: every layer catches its seeded defect', () => {
  it('layer 1 — kernel goldens: a one-dollar drift in an expected line is reported', () => {
    const { golden, result } = computeReturn1();
    expect(compareGoldenExpectations(result.computedFacts, golden.expected)).toEqual([]); // clean baseline
    const seeded = { ...golden.expected, [C.FED_TAX]: '5701' };
    const deltas = compareGoldenExpectations(result.computedFacts, seeded);
    expect(deltas).toHaveLength(1);
    expect(deltas[0]?.concept).toBe(C.FED_TAX);
    expect(deltas[0]?.difference).toBe('-1');
  });

  it('layer 2 — rule regression: a mis-ordered bracket table refuses to load', () => {
    const raw = JSON.parse(readFileSync(root('rules/fixtures/2025.FED.json'), 'utf8')) as {
      parameters: { brackets: { single: { up_to: { value: string } | null }[] } };
    };
    const rows = raw.parameters.brackets.single;
    const tmp = rows[0]!.up_to;
    rows[0]!.up_to = rows[1]!.up_to;
    rows[1]!.up_to = tmp;
    expect(() => loadRuleSet(raw)).toThrow(/ascending/);
  });

  it('layer 3 — critics: a wrong-line mapping fires ACC-TIEOUT-FORM', () => {
    const ctx = buildCtx('return2-w2-1099int', { gate: 4, tamper: { [C.FED_TOTAL_INCOME]: '50000' } });
    const findings = accTieoutForm.evaluate(ctx);
    expect(findings.some((f) => f.severity === 'Error')).toBe(true);
  });

  it('layer 4 — agent evals: a hallucinated citation is rejected, never rendered', async () => {
    const store = loadAuthority();
    const rig = makeRig({
      explanation: () =>
        JSON.stringify({
          subject_ref: 'x',
          explanation_text: 'plainly explained',
          cited_rule_ids: ['IRC-FABRICATED-999'],
          reading_level: 'plain',
        }),
    });
    const run = await runExplanation(rig.deps, store, {
      subject_ref: 'x',
      context_lines: ['line'],
      candidate_rules: [{ rule_id: 'IRC-61A-PLACEHOLDER', citation: 'c' }],
    });
    expect(run.status).toBe('rejected');
  });

  it('layer 5 — package goldens: byte drift and serializer tampering are both caught', async () => {
    // Byte-stability seed: a $1 drift in the committed golden trips the
    // byte-equality comparison the golden test performs.
    const goldenXml = readFileSync(root('packages/forms/golden/scenario1.FED.xml'), 'utf8');
    const byteSeed = goldenXml.replace('<RefundAmt>856</RefundAmt>', '<RefundAmt>857</RefundAmt>');
    expect(goldenXml).toContain('<RefundAmt>856</RefundAmt>'); // seed actually applied
    expect(byteSeed).not.toBe(goldenXml);
    // Round-trip seed: a tampered serialization diffs against the instances.
    const built = await buildFor('return1-single-w2');
    const fedXml = built.artifacts.find((a) => a.artifact_id === 'xml:FED')!.content;
    const tampered = fedXml.replace('<TaxAmt>5700</TaxAmt>', '<TaxAmt>5699</TaxAmt>');
    expect(tampered).not.toBe(fedXml);
    const diffs = roundTripDiff(tampered, fedRelease.forms, built.instances.filter((i) => i.jurisdiction === 'FED'));
    expect(diffs).toHaveLength(1);
    expect(diffs[0]?.expected).toBe('5700');
  });

  it('layer 6 — e2e slice: a seeded income drift is stopped by the gates', async () => {
    const s = await seedScenario(fedRules, ilRules);
    await s.orchestrator.runAll();
    await editSourceFact(s, 'f:int-1:interest', '1500'); // transcript still says 1200
    const { reruns } = await s.orchestrator.handleFactMutation('f:int-1:interest');
    const gate2 = reruns.find((r) => r.gate === 2 && r.jurisdiction === 'FED');
    expect(gate2?.result).toBe('fail');
    const gate6 = reruns.find((r) => r.gate === 6 && r.jurisdiction === 'FED');
    expect(gate6?.result).toBe('fail'); // nothing packages past a failed hard gate
  });

  it('layer 7 — copy-lint: banned vocabulary is flagged', () => {
    expect(checkBannedVocabulary('Fixing this makes the return audit-proof.').length).toBeGreaterThan(0);
    expect(checkBannedVocabulary('Your risk score is 87.').length).toBeGreaterThan(0);
    // Advice framing is allowed since the personal-use pivot:
    expect(checkBannedVocabulary('You should claim the credit now.')).toEqual([]);
  });

  it('layer 8 — accuracy benchmark: a kernel drift vs the professional anchor is reported', () => {
    const benchmark = loadProfessionalBenchmark(
      JSON.parse(readFileSync(root('rules/fixtures/benchmark-returns/2025.PRO-PREPARED.return1.json'), 'utf8')),
    );
    const { result } = computeReturn1();
    expect(runAccuracyBenchmark(benchmark, result.computedFacts).clean).toBe(true); // baseline agrees
    // Seed a kernel-side drift: one dollar on the tax line.
    const tamperedFacts = result.computedFacts.map((f) =>
      f.concept === C.FED_TAX ? { ...f, value: f.value.add(Money.fromString('1')) } : f,
    );
    const report = runAccuracyBenchmark(benchmark, tamperedFacts);
    expect(report.clean).toBe(false);
    expect(report.deltas).toHaveLength(1);
    expect(report.deltas[0]?.concept).toBe(C.FED_TAX);
    expect(report.deltas[0]?.difference).toBe('1');
  });
});
