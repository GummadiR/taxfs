/**
 * G.2 — Risk-profile assembly + acknowledgment ledger.
 * F critics DETECT; E.5 EXPLAINS; this module ASSEMBLES AND PERSISTS.
 * Itemized only — no aggregate or numeric risk metric exists anywhere in
 * this schema (M2), and the test suite asserts that word-for-word.
 */
import type { AuthorityGrade, Clock, Finding, GateRun } from '@taxfs/shared';

export interface RiskProfileItem {
  finding_id: string;
  /** The deterministic trigger: critic id (weights/benchmark deltas arrive with Cap 23 data). */
  trigger_ref: string;
  gate: number;
  jurisdiction: string;
  message: string;
  authority_grade?: AuthorityGrade;
  defense_artifact_ref?: string;
  fix_ref?: string;
  status: 'open' | 'fixed' | 'acknowledged';
  /** Stable identity across regenerations: same critic + same substance ⇒ acks persist. */
  content_key: string;
}

export interface RiskProfile {
  profile_id: string;
  taxpayer_id: string;
  tax_year: number;
  rule_version: string;
  generated_at: string;
  items: RiskProfileItem[];
}

export interface AckRecord {
  ack_id: string;
  item_ref: string; // finding_id at time of ack
  content_key: string;
  user_id: string;
  timestamp: string;
  /**
   * Rationale note. REQUIRED for weak-authority items: a compelled ledger
   * showing documented reasoning defends; one showing bare clicks convicts.
   */
  note?: string;
  /** The exact §7602 compellable-notice text the user saw, verbatim. */
  disclosure_shown: string;
}

export function contentKey(f: Pick<Finding, 'critic_id' | 'message' | 'affected'>): string {
  return `${f.critic_id}|${[...f.affected].sort().join(',')}|${f.message}`;
}

function latestRuns(gateRuns: readonly GateRun[]): GateRun[] {
  const latest = new Map<string, GateRun>();
  for (const run of gateRuns) latest.set(`${run.gate}:${run.jurisdiction}`, run);
  return [...latest.values()].sort(
    (a, b) => a.gate - b.gate || a.jurisdiction.localeCompare(b.jurisdiction),
  );
}

/** A finding belongs on the risk profile when it is a Gate-5 item or carries an authority grade. */
function isRiskItem(f: Finding): boolean {
  return f.gate === 5 || f.severity === 'Audit-Risk' || f.authority_grade !== undefined;
}

export class RiskLedger {
  private readonly acks: AckRecord[] = [];
  private seq = 0;

  constructor(private readonly clock: Clock) {}

  /**
   * Assemble the itemized profile from the latest gate runs. Regenerates on
   * staleness like any derived artifact; acknowledgments persist only when
   * the item's substance (content_key) is unchanged (D.5 scoped cascade).
   */
  assembleProfile(input: {
    taxpayer_id: string;
    tax_year: number;
    rule_version: string;
    gateRuns: readonly GateRun[];
  }): RiskProfile {
    this.seq += 1;
    const items: RiskProfileItem[] = [];
    for (const run of latestRuns(input.gateRuns)) {
      for (const f of run.findings) {
        if (!isRiskItem(f)) continue;
        const key = contentKey(f);
        const item: RiskProfileItem = {
          finding_id: f.finding_id,
          trigger_ref: f.critic_id,
          gate: f.gate,
          jurisdiction: run.jurisdiction,
          message: f.message,
          status: this.acks.some((a) => a.content_key === key) ? 'acknowledged' : 'open',
          content_key: key,
        };
        if (f.authority_grade) item.authority_grade = f.authority_grade;
        if (f.defense_artifact_ref) item.defense_artifact_ref = f.defense_artifact_ref;
        if (f.fix_ref) item.fix_ref = f.fix_ref;
        items.push(item);
      }
    }
    return {
      profile_id: `riskprofile-${String(this.seq).padStart(4, '0')}`,
      taxpayer_id: input.taxpayer_id,
      tax_year: input.tax_year,
      rule_version: input.rule_version,
      generated_at: this.clock.nowIso(),
      items,
    };
  }

  /**
   * Record an acknowledgment. The disclosure text shown to the user is
   * stored verbatim (it states §7602 compellability — these records are
   * excluded from IRS-facing output by default, and they are not hidden).
   */
  acknowledge(input: {
    item: RiskProfileItem;
    user_id: string;
    disclosure_shown: string;
    note?: string;
  }): AckRecord {
    const trimmed = input.note?.trim() ?? '';
    if (input.item.authority_grade === 'weak_or_none' && trimmed.length < 20) {
      throw new Error(
        'weak-authority items require a substantive rationale note (≥ 20 chars): documented reasoning defends; a bare acknowledgment does not',
      );
    }
    if (!/§\s?7602|7602/.test(input.disclosure_shown)) {
      throw new Error('disclosure_shown must be the compellability notice actually displayed (must reference §7602)');
    }
    const ack: AckRecord = {
      ack_id: `ack-${String(this.acks.length + 1).padStart(4, '0')}`,
      item_ref: input.item.finding_id,
      content_key: input.item.content_key,
      user_id: input.user_id,
      timestamp: this.clock.nowIso(),
      disclosure_shown: input.disclosure_shown,
      ...(trimmed.length > 0 ? { note: trimmed } : {}),
    };
    this.acks.push(ack);
    return ack;
  }

  /**
   * Restore previously recorded acknowledgments — for a persistent store,
   * where the ledger is rebuilt per request rather than living in a session.
   * These records were validated by acknowledge() when they were created, so
   * they are NOT re-validated here; acknowledge() stays the one and only
   * door new records come through, and its rules stay the only rules.
   */
  hydrate(records: readonly AckRecord[]): void {
    for (const r of records) this.acks.push(r);
  }

  /** Ledger access for the platform's OWN surfaces only — never bundled into IRS-facing output. */
  ledger(): readonly AckRecord[] {
    return this.acks;
  }
}
