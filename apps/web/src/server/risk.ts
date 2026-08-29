/**
 * Audit-readiness read model + Defense File assembly (TaxOS F/E.6, ported).
 * Being ready IF a letter comes — never a prediction of audit odds. Gate-5
 * findings are the informational items; acknowledgments persist in settings
 * (H.2: excluded from the IRS-facing bundle, never called "private" —
 * compellability stated plainly). The Defense File assembles ENTIRELY from
 * existing structures — zero manual entry.
 */
import {
  BenchmarkStore,
  CaptureStore,
  buildCompMemo,
  buildDefenseFile,
  buildReconciliation,
  loadBenchmarkRelease,
  loadCaptureRules,
  type CaptureSnapshot,
  type DefenseFile,
} from '@taxfs/defense';
import type { Clock, Finding } from '@taxfs/shared';
import { withSpine, withUserClient } from './db';
import { readSetting, writeSetting } from './filing';
import { readFixture } from './rules';
import { listPackages } from './packages';
import { buildCurrentPackage } from './packages';
import { TAX_YEAR } from './env';

class RealClock implements Clock {
  nowIso(): string {
    return new Date().toISOString();
  }
}

/** H.2 harvested copy — never "private"; compellability stated plainly. */
export const ACK_COPY =
  'Your acknowledgment is excluded from the IRS-facing package, but it lives in the platform ledger and can be legally compelled (for example under an IRS §7602 summons). Acknowledge because you have reviewed the item — not because this record is hidden. It is not hidden.';

const ACKS_KEY = 'risk.acknowledgments';

export interface RiskItemDto {
  finding_id: string;
  severity: string;
  message: string;
  acknowledged: boolean;
}

export interface RiskDto {
  overview: string;
  items: RiskItemDto[];
  acknowledgment_copy: string;
  defense_available: boolean;
}

export async function getRisk(userId: string, ws: string): Promise<RiskDto> {
  const { gateRuns } = await withSpine({ userId, workspaceId: ws }, (spine) => spine.inspect(ws));
  const latest = new Map<string, (typeof gateRuns)[number]>();
  for (const run of gateRuns) latest.set(`${run.gate}:${run.jurisdiction}`, run);
  const gate5: { finding: Finding; jurisdiction: string }[] = [];
  for (const run of latest.values()) {
    if (run.gate !== 5) continue;
    for (const f of run.findings) gate5.push({ finding: f, jurisdiction: run.jurisdiction });
  }
  const acks = await withUserClient(userId, async (client) =>
    ((await readSetting(client, ws, ACKS_KEY)) as string[] | undefined) ?? []);
  const rows = await listPackages(userId, ws);
  return {
    overview:
      gate5.length === 0
        ? 'No informational audit-readiness items were found — every documented pattern check came back clean.'
        : 'Informational review items. None block filing; each describes a pattern that draws attention per public IRS statistics, with the records that address it.',
    items: gate5.map(({ finding, jurisdiction }) => ({
      finding_id: finding.critic_id,
      severity: finding.severity,
      message: `[${jurisdiction}] ${finding.message}`,
      acknowledged: acks.includes(finding.critic_id),
    })),
    acknowledgment_copy: ACK_COPY,
    defense_available: rows[0]?.status === 'locked',
  };
}

export async function acknowledgeFinding(userId: string, ws: string, findingId: string): Promise<void> {
  await withUserClient(userId, async (client) => {
    const acks = ((await readSetting(client, ws, ACKS_KEY)) as string[] | undefined) ?? [];
    if (!acks.includes(findingId)) acks.push(findingId);
    await writeSetting(client, ws, ACKS_KEY, acks);
  });
}

function compMemo(clock: Clock) {
  const store = new BenchmarkStore();
  const release = loadBenchmarkRelease(readFixture(`rules/fixtures/benchmarks/${TAX_YEAR}.BLS-OEWS.MOCK.json`));
  store.load(release);
  return buildCompMemo({
    store,
    dataset: 'BLS_OEWS',
    version: release.version,
    clock,
    revenue_source_analysis:
      'Demo substance analysis: revenue derives from the owner\u2019s personal services (fixture \u2014 the full engine arrives with S-corp scope).',
    roles: [
      { soc_code: '15-1252', weight_pct: '0.6' },
      { soc_code: '11-1021', weight_pct: '0.4' },
    ],
  });
}

/** Assemble the Defense File from the LOCKED head package — zero manual entry. */
export async function assembleDefenseFile(userId: string, ws: string): Promise<DefenseFile> {
  const rows = await listPackages(userId, ws);
  const head = rows[0];
  if (!head || head.status !== 'locked') {
    throw new Error('Lock a package on File It first — the Defense File is assembled from it and versioned per package version.');
  }
  const built = await buildCurrentPackage(userId, ws);
  const { facts, sources, gateRuns } = await withSpine({ userId, workspaceId: ws }, async (spine) => ({
    facts: await spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }),
    sources: await spine.getSources(ws, TAX_YEAR),
    gateRuns: (await spine.inspect(ws)).gateRuns,
  }));
  const clock = new RealClock();
  const snap = await withUserClient(userId, async (client) =>
    ((await readSetting(client, ws, 'capture.state')) as CaptureSnapshot | undefined) ?? null);
  const capture = CaptureStore.fromSnapshot(
    clock,
    loadCaptureRules(readFixture(`rules/fixtures/${TAX_YEAR}.CAPTURE-RULES.json`)),
    snap,
  );
  return buildDefenseFile(
    {
      manifest: { ...built.manifest, status: 'locked', package_id: head.package_id, version: head.version },
      artifacts: built.artifacts,
      reconciliation: buildReconciliation(facts, sources, clock.nowIso()),
      memos: [compMemo(clock)],
      capture_records: capture.defenseEligible(),
      gate_runs: gateRuns,
    },
    clock,
  );
}
