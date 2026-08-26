/**
 * End-to-end proof (Session-1 step 4): pin rule version → source facts →
 * confirm → compute → gates 0–6 → mutate one source fact → assert the
 * dependency-scoped staleness cascade re-runs ONLY affected gates.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { C, type TaxFact } from '@taxfs/shared';
import { compute, type KernelResult } from '@taxfs/kernel';
import { editSourceFact, seedScenario, type Scenario } from '@taxfs/gates';
import { fedRules, ilRules } from './helpers.js';

let s: Scenario;

beforeEach(async () => {
  s = await seedScenario(fedRules, ilRules);
});

async function factValue(concept: string): Promise<string> {
  const f = (
    await s.spine.getFacts({ taxpayer_id: 'tp-e2e', tax_year: 2025, concepts: [concept] })
  ).find((x) => x.derivation !== undefined);
  return f?.value.toString() ?? '<missing>';
}

async function computeFromSpine(): Promise<KernelResult> {
  const sourced: TaxFact[] = (
    await s.spine.getFacts({ taxpayer_id: 'tp-e2e', tax_year: 2025 })
  ).filter((f) => f.derivation === undefined && f.status === 'confirmed');
  return compute({
    taxpayer_id: s.filing.taxpayer_id,
    tax_year: s.filing.tax_year,
    ctx: s.filing,
    facts: sourced,
    fed_rules: fedRules,
    il_rules: ilRules,
  });
}

describe('full trace: rule pin → facts → compute → gates 0–6 → package', () => {
  it('runs all gates per jurisdiction; hard gates pass, gate 5 warns only, package is ready', async () => {
    const runs = await s.orchestrator.runAll();
    expect(runs).toHaveLength(14); // 7 gates × 2 jurisdictions

    for (const run of runs) {
      if (run.gate === 5) {
        expect(run.result).toBe('warn'); // round-number Audit-Risk profile, warn-only
        expect(run.findings.length).toBeGreaterThan(0);
        expect(run.findings.every((f) => f.severity !== 'Error')).toBe(true);
      } else {
        expect(run.result, `gate ${run.gate} ${run.jurisdiction}`).toBe('pass');
      }
      expect(run.rule_version).toMatch(/PLACEHOLDER/); // pinned at Gate 0
    }

    // Derived results (from PLACEHOLDER fixture rule-data)
    expect(await factValue(C.FED_TAXABLE)).toBe('36200');
    expect(await factValue(C.FED_TAX)).toBe('4144');
    expect(await factValue(C.FED_REFUND_OR_DUE)).toBe('856'); // 5000 payments − 4144
    expect(await factValue(C.IL_TAX)).toBe('2397');
    expect(await factValue(C.IL_REFUND_OR_DUE)).toBe('603'); // 3000 payments − 2397

    const kinds = s.bus.history().map((e) => e.kind);
    for (const expected of [
      'FactCreated',
      'FactConfirmed',
      'CalculationCompleted',
      'GateEntered',
      'FindingRaised',
      'GateResult',
    ]) {
      expect(kinds).toContain(expected);
    }
    expect(kinds[kinds.length - 1]).toBe('PackageReady');
  });

  it('getLineage walks the federal refund back to the W-2 source document', async () => {
    await s.orchestrator.runAll();
    const refund = (
      await s.spine.getFacts({ taxpayer_id: 'tp-e2e', tax_year: 2025, concepts: [C.FED_REFUND_OR_DUE] })
    ).find((f) => f.derivation !== undefined);
    const lineage = await s.spine.getLineage(refund!.fact_id);
    const sourceIds = new Set<string>();
    const walk = (node: typeof lineage): void => {
      for (const src of node.sources ?? []) sourceIds.add(src.source_id);
      for (const input of node.inputs ?? []) walk(input);
    };
    walk(lineage);
    expect(sourceIds.has('s-w2-1')).toBe(true); // withholding line → W-2 document
  });
});

describe('staleness cascade re-runs only affected gates (A.2 / trace step 8)', () => {
  it('mutating the interest fact re-runs gates 2–6 both jurisdictions, never 0/1/3; recon catches the transcript drift; reverting restores the package', async () => {
    await s.orchestrator.runAll();
    const runsBefore = (await s.spine.inspect()).gateRuns.length;

    await editSourceFact(s, 'f:int-1:interest', '1500');
    const { impact, reruns } = await s.orchestrator.handleFactMutation('f:int-1:interest');

    // Dependency-scoped: every derived fact depends on interest (the FED
    // chain feeds IL via fed AGI), so gates 2–6 re-open in both
    // jurisdictions — but 0/1/3 never re-run.
    expect(impact.stale_fact_ids.length).toBeGreaterThan(0);
    const rerunKeys = reruns.map((r) => `${r.gate}:${r.jurisdiction}`).sort();
    expect(rerunKeys).toEqual(['2:FED', '2:IL', '4:FED', '4:IL', '5:FED', '5:IL', '6:FED', '6:IL']);
    expect((await s.spine.inspect()).gateRuns.length).toBe(runsBefore + 8);

    // Recomputed values under the new fact
    expect(await factValue(C.FED_TOTAL_INCOME)).toBe('51500');
    expect(await factValue(C.FED_TAX)).toBe('4180');
    expect(await factValue(C.FED_REFUND_OR_DUE)).toBe('820');
    expect(await factValue(C.IL_TAX)).toBe('2412');

    // The transcript still reports 1200, so the IRS lens must now fire and
    // gate 2 (hard) must block — which propagates to FED gate 6.
    const gate2Fed = reruns.find((r) => r.gate === 2 && r.jurisdiction === 'FED');
    expect(gate2Fed?.result).toBe('fail');
    expect(gate2Fed?.findings.some((f) => f.critic_id === 'IRS-INCOME-RECON' && f.severity === 'Error')).toBe(true);
    const gate6Fed = reruns.find((r) => r.gate === 6 && r.jurisdiction === 'FED');
    expect(gate6Fed?.result).toBe('fail');
    expect(s.bus.history()[s.bus.history().length - 1]?.kind).not.toBe('PackageReady');

    // Revert the edit → cascade again → everything reconciles → PackageReady.
    await editSourceFact(s, 'f:int-1:interest', '1200');
    const second = await s.orchestrator.handleFactMutation('f:int-1:interest');
    expect(second.reruns.every((r) => r.result === 'pass' || r.gate === 5)).toBe(true);
    expect(s.bus.history()[s.bus.history().length - 1]?.kind).toBe('PackageReady');
    expect(await factValue(C.FED_REFUND_OR_DUE)).toBe('856');
  });

  it('mutating an IL-only fact re-runs only IL gates', async () => {
    await s.orchestrator.runAll();
    await editSourceFact(s, 'f:w2-1:ilwh', '2200');
    const { reruns } = await s.orchestrator.handleFactMutation('f:w2-1:ilwh');
    expect(reruns.length).toBeGreaterThan(0);
    expect(reruns.every((r) => r.jurisdiction === 'IL')).toBe(true);
    expect(await factValue(C.IL_PAYMENTS)).toBe('3200');
    expect(await factValue(C.IL_REFUND_OR_DUE)).toBe('803');
  });

  it('F3 regression: an edit left unconfirmed cannot package — gate 6 re-verifies input confirmation', async () => {
    await s.orchestrator.runAll();
    // Spine-level edit that skips the confirmed flag (gate 1 will not re-run:
    // it consumes no fact values by design).
    const fact = (await s.spine.getFacts({ taxpayer_id: 'tp-e2e', tax_year: 2025 })).find(
      (f) => f.fact_id === 'f:int-1:interest',
    )!;
    await s.spine.putSourceFact({
      fact_id: fact.fact_id,
      taxpayer_id: fact.taxpayer_id,
      concept: fact.concept,
      tax_year: fact.tax_year,
      jurisdiction: fact.jurisdiction,
      taxpayer_scope: fact.taxpayer_scope,
      value: fact.value.add(fact.value), // any changed value
      confidence: 1,
      provenance: fact.provenance!,
      // no `confirmed: true`
    });
    const { reruns } = await s.orchestrator.handleFactMutation('f:int-1:interest');
    const gate6Fed = reruns.find((r) => r.gate === 6 && r.jurisdiction === 'FED');
    expect(gate6Fed?.result).toBe('fail');
    expect(
      gate6Fed?.findings.some((f) => f.message.includes('must be confirmed')),
      'gate 6 must name the unconfirmed input',
    ).toBe(true);
    expect(s.bus.history()[s.bus.history().length - 1]?.kind).not.toBe('PackageReady');
  });

  it('recomputing a clean graph is a no-op (idempotency, end-to-end)', async () => {
    await s.orchestrator.runAll();
    const auditBefore = (await s.spine.inspect()).auditLog.length;
    const changed = await s.spine.commitComputation(await computeFromSpine());
    expect(changed).toEqual([]);
    expect((await s.spine.inspect()).auditLog.length).toBe(auditBefore);
  });
});
