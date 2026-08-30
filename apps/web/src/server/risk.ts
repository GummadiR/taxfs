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
  RiskLedger,
  type AckRecord,
  type RiskProfileItem,
  buildCompMemo,
  buildDefenseFile,
  buildReconciliation,
  loadBenchmarkRelease,
  loadCaptureRules,
  type CaptureSnapshot,
  type DefenseFile,
} from '@taxfs/defense';
import type { Clock } from '@taxfs/shared';
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

/** The typed phrase that records an acknowledgment (TaxOS verbatim). */
export const ACK_PHRASE = 'I acknowledge';

export interface RiskItemDto {
  finding_id: string;
  critic_id: string;
  severity: string;
  message: string;
  acknowledged: boolean;
  /** The recorded reasoning, shown back so the ledger is visible, not implied. */
  ack_note?: string;
  ack_at?: string;
  /**
   * A weak-authority position: the ledger REFUSES a bare acknowledgment on
   * one of these. Surfaced so the form can say so before it is refused.
   */
  note_required: boolean;
}

export interface RiskDto {
  overview: string;
  items: RiskItemDto[];
  acknowledgment_copy: string;
  defense_available: boolean;
}

/** Stored acknowledgments, tolerating the earlier bare-id shape. */
function readAcks(raw: unknown): AckRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((r): r is AckRecord => typeof r === 'object' && r !== null && 'content_key' in r);
}

/** Rebuild the ledger for this request, with what was already recorded. */
async function ledgerFor(userId: string, ws: string, clock: Clock): Promise<RiskLedger> {
  const ledger = new RiskLedger(clock);
  const stored = await withUserClient(userId, (client) => readSetting(client, ws, ACKS_KEY));
  ledger.hydrate(readAcks(stored));
  return ledger;
}

export async function getRisk(userId: string, ws: string): Promise<RiskDto> {
  const clock = new RealClock();
  const { gateRuns } = await withSpine({ userId, workspaceId: ws }, (spine) => spine.inspect(ws));
  const ledger = await ledgerFor(userId, ws, clock);
  // The ported G.2 assembly decides what belongs on the profile and what an
  // item's stable identity is — the screen must not re-derive either, or an
  // acknowledgment stops surviving a re-run the way the ledger promises.
  const profile = ledger.assembleProfile({
    taxpayer_id: ws,
    tax_year: TAX_YEAR,
    rule_version: '',
    gateRuns,
  });
  const byKey = new Map(ledger.ledger().map((a) => [a.content_key, a]));
  const severityOf = new Map<string, string>();
  for (const run of gateRuns) for (const f of run.findings) severityOf.set(f.finding_id, f.severity);
  const rows = await listPackages(userId, ws);
  return {
    overview:
      profile.items.length === 0
        ? 'No informational audit-readiness items were found — every documented pattern check came back clean.'
        : 'Informational review items. None block filing; each describes a pattern that draws attention per public IRS statistics, with the records that address it.',
    items: profile.items.map((item) => {
      const ack = byKey.get(item.content_key);
      return {
        finding_id: item.finding_id,
        critic_id: item.trigger_ref,
        severity: severityOf.get(item.finding_id) ?? 'Audit-Risk',
        message: `[${item.jurisdiction}] ${item.message}`,
        acknowledged: item.status === 'acknowledged',
        ...(ack?.note ? { ack_note: ack.note } : {}),
        ...(ack ? { ack_at: ack.timestamp } : {}),
        note_required: item.authority_grade === 'weak_or_none',
      };
    }),
    acknowledgment_copy: ACK_COPY,
    defense_available: rows[0]?.status === 'locked',
  };
}

/**
 * Record an acknowledgment — through the ledger, never around it.
 *
 * The screen used to write a bare list of critic ids straight to settings,
 * which is precisely what the disclosure on that screen says does NOT
 * defend you: "a compelled ledger showing documented reasoning defends; one
 * showing bare clicks convicts". The rules (the typed phrase, and a
 * substantive rationale on a weak-authority position) live in the ported
 * RiskLedger; this returns their refusal message rather than a thrown
 * error, so the operator can fix it in place.
 *
 * Returns null on success, or the reason it was refused.
 */
export async function acknowledgeFinding(
  userId: string,
  ws: string,
  input: { findingId: string; typed: string; note: string },
): Promise<string | null> {
  if (input.typed.trim() !== ACK_PHRASE) {
    return `To record an acknowledgment, type exactly: ${ACK_PHRASE}. Nothing was recorded.`;
  }
  const clock = new RealClock();
  const { gateRuns } = await withSpine({ userId, workspaceId: ws }, (spine) => spine.inspect(ws));
  const ledger = await ledgerFor(userId, ws, clock);
  const profile = ledger.assembleProfile({ taxpayer_id: ws, tax_year: TAX_YEAR, rule_version: '', gateRuns });
  const item: RiskProfileItem | undefined = profile.items.find((i) => i.finding_id === input.findingId);
  if (!item) return 'That item is no longer on the current risk profile — nothing was recorded.';
  if (item.status === 'acknowledged') return null;
  const note = input.note.trim();
  let record: AckRecord;
  try {
    record = ledger.acknowledge({
      item,
      user_id: userId,
      disclosure_shown: ACK_COPY,
      ...(note.length > 0 ? { note } : {}),
    });
  } catch (e) {
    return e instanceof Error ? e.message : 'The acknowledgment was refused — nothing was recorded.';
  }
  await withUserClient(userId, async (client) => {
    const stored = readAcks(await readSetting(client, ws, ACKS_KEY));
    stored.push(record);
    await writeSetting(client, ws, ACKS_KEY, stored);
  });
  return null;
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
