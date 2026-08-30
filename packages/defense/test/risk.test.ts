/**
 * G.2 acceptance: itemized RiskProfile from F findings, ack flow with
 * disclosure-version capture and weak-authority rationale requirement, and
 * the M2 guarantee — NO score field exists anywhere (asserted against both
 * the serialized schema and the package source).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Clock, Finding, GateRun } from '@taxfs/shared';
import { RiskLedger, contentKey } from '@taxfs/defense';

const clock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };

function finding(overrides: Partial<Finding>): Finding {
  return {
    finding_id: 'fnd-0001',
    critic_id: 'IRS-ROUNDNUM',
    lens: 'IRS',
    severity: 'Audit-Risk',
    affected: ['f-1'],
    message: 'round-number pattern',
    gate: 5,
    defense_artifact_ref: 'defense://substantiation-index',
    ...overrides,
  };
}

function run(findings: Finding[], gate = 5, jurisdiction: 'FED' | 'IL' = 'FED'): GateRun {
  return {
    run_id: `gr-${gate}-${jurisdiction}`,
    taxpayer_id: 'tp',
    gate: gate as GateRun['gate'],
    jurisdiction,
    rule_version: 'rv-PLACEHOLDER',
    started: clock.nowIso(),
    result: 'warn',
    findings,
    consumed_fact_ids: [],
    timestamp: clock.nowIso(),
  };
}

const DISCLOSURE =
  'Your acknowledgment is excluded from the IRS-facing package, but it lives in the platform ledger and can be legally compelled (for example under an IRS §7602 summons).';

describe('RiskProfile assembly (G.2)', () => {
  it('itemizes gate-5 and authority-graded findings from the latest runs only', () => {
    const ledger = new RiskLedger(clock);
    const older = run([finding({ finding_id: 'old-1' })]);
    const newer = run([
      finding({ finding_id: 'new-1' }),
      finding({ finding_id: 'new-2', critic_id: 'IRS-AUTHORITY', authority_grade: 'reasonable_basis', gate: 5 }),
    ]);
    const errorFinding = finding({ finding_id: 'e-1', severity: 'Error', gate: 2, authority_grade: undefined });
    const gate2 = run([errorFinding], 2);
    const profile = ledger.assembleProfile({
      taxpayer_id: 'tp',
      tax_year: 2025,
      rule_version: 'rv-PLACEHOLDER',
      gateRuns: [older, gate2, newer],
    });
    expect(profile.items.map((i) => i.finding_id)).toEqual(['new-1', 'new-2']); // latest run wins; plain gate-2 Error is not a risk item
    expect(profile.items.every((i) => i.status === 'open')).toBe(true);
    expect(profile.items[1]?.authority_grade).toBe('reasonable_basis');
  });

  it('M2: no score exists — not in the serialized profile, not in the package source', () => {
    const ledger = new RiskLedger(clock);
    const profile = ledger.assembleProfile({
      taxpayer_id: 'tp',
      tax_year: 2025,
      rule_version: 'rv',
      gateRuns: [run([finding({})])],
    });
    expect(JSON.stringify(profile)).not.toMatch(/score/i);

    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      expect(text, `${file} must not contain a score concept`).not.toMatch(/\bscore\b/i);
    }
  });
});

describe('acknowledgment ledger (G.2)', () => {
  it('stores the exact disclosure text and rejects a non-compellability disclosure', () => {
    const ledger = new RiskLedger(clock);
    const profile = ledger.assembleProfile({ taxpayer_id: 'tp', tax_year: 2025, rule_version: 'rv', gateRuns: [run([finding({})])] });
    const item = profile.items[0]!;
    expect(() => ledger.acknowledge({ item, user_id: 'u1', disclosure_shown: 'this stays between us' })).toThrow(/7602/);
    const ack = ledger.acknowledge({ item, user_id: 'u1', disclosure_shown: DISCLOSURE, note: 'reviewed the docs' });
    expect(ack.disclosure_shown).toBe(DISCLOSURE);
    expect(ack.note).toBe('reviewed the docs');
  });

  it('REQUIRES a substantive rationale for weak-authority items', () => {
    const ledger = new RiskLedger(clock);
    const weak = run([finding({ finding_id: 'w-1', critic_id: 'IRS-AUTHORITY', authority_grade: 'weak_or_none' })]);
    const item = ledger
      .assembleProfile({ taxpayer_id: 'tp', tax_year: 2025, rule_version: 'rv', gateRuns: [weak] })
      .items[0]!;
    expect(() => ledger.acknowledge({ item, user_id: 'u1', disclosure_shown: DISCLOSURE })).toThrow(/rationale/);
    expect(() => ledger.acknowledge({ item, user_id: 'u1', disclosure_shown: DISCLOSURE, note: 'ok' })).toThrow(/rationale/);
    const ack = ledger.acknowledge({
      item,
      user_id: 'u1',
      disclosure_shown: DISCLOSURE,
      note: 'Position rests on the 2024 engagement letter and the payment trail in the vault.',
    });
    expect(ack.note).toMatch(/engagement letter/);
  });

  it('hydration restores recorded acks WITHOUT becoming a second door into the ledger', () => {
    // A persistent store rebuilds the ledger per request, so it must be able
    // to load what was already recorded. The risk is that hydration becomes
    // a way to write records that acknowledge() would have refused — so this
    // pins that hydrate only READS BACK, and that new records still go
    // through the one validated door.
    const first = new RiskLedger(clock);
    const weak = run([finding({ finding_id: 'w-1', critic_id: 'IRS-AUTHORITY', authority_grade: 'weak_or_none' })]);
    const item = first
      .assembleProfile({ taxpayer_id: 'tp', tax_year: 2025, rule_version: 'rv', gateRuns: [weak] })
      .items[0]!;
    const ack = first.acknowledge({
      item, user_id: 'u1', disclosure_shown: DISCLOSURE,
      note: 'Position rests on the 2024 engagement letter and the payment trail in the vault.',
    });

    // A fresh ledger, given that record, shows the item acknowledged again.
    const rebuilt = new RiskLedger(clock);
    rebuilt.hydrate([ack]);
    const reassembled = rebuilt.assembleProfile({ taxpayer_id: 'tp', tax_year: 2025, rule_version: 'rv', gateRuns: [weak] });
    expect(reassembled.items[0]?.status).toBe('acknowledged');
    expect(rebuilt.ledger()).toHaveLength(1);

    // And the rules did not move: a bare acknowledgment on a weak-authority
    // item is still refused on the hydrated ledger (negative test, §9.1).
    const other = run([finding({ finding_id: 'w-2', critic_id: 'IRS-OTHER', authority_grade: 'weak_or_none' })]);
    const otherItem = rebuilt
      .assembleProfile({ taxpayer_id: 'tp', tax_year: 2025, rule_version: 'rv', gateRuns: [other] })
      .items[0]!;
    expect(() => rebuilt.acknowledge({ item: otherItem, user_id: 'u1', disclosure_shown: DISCLOSURE }))
      .toThrow(/rationale/);
  });

  it('acks persist across regeneration only while the item substance is unchanged (D.5 scoped cascade)', () => {
    const ledger = new RiskLedger(clock);
    const original = finding({});
    const p1 = ledger.assembleProfile({ taxpayer_id: 'tp', tax_year: 2025, rule_version: 'rv', gateRuns: [run([original])] });
    ledger.acknowledge({ item: p1.items[0]!, user_id: 'u1', disclosure_shown: DISCLOSURE });

    // Same substance, new finding id (re-run) → still acknowledged
    const rerun = finding({ finding_id: 'fnd-0099' });
    const p2 = ledger.assembleProfile({ taxpayer_id: 'tp', tax_year: 2025, rule_version: 'rv', gateRuns: [run([rerun])] });
    expect(p2.items[0]?.status).toBe('acknowledged');
    expect(contentKey(rerun)).toBe(contentKey(original));

    // Substance changed (message differs after an edit) → back to open
    const changed = finding({ finding_id: 'fnd-0100', message: '4 source amounts are round multiples' });
    const p3 = ledger.assembleProfile({ taxpayer_id: 'tp', tax_year: 2025, rule_version: 'rv', gateRuns: [run([changed])] });
    expect(p3.items[0]?.status).toBe('open');
  });
});
