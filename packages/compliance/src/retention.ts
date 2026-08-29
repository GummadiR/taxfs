/**
 * J.2 — Account-closure = RETENTION HOLD, never a purge.
 * Closing an account archives the records and rule-execution logs intact,
 * revokes normal access, and BLOCKS purge until the statutory retention
 * period (rule-data, PLACEHOLDER ~7 years — verify obligations) expires.
 * A "delete my data" request during the hold is refused with the reason;
 * the archive survives.
 */
import type { Clock } from '@taxfs/shared';
import type { SecurityRules } from './checksum';

export interface ArchivedAccount {
  taxpayer_id: string;
  archived_at: string;
  hold_until: string; // ISO date
  access: 'revoked';
  /** Snapshots preserved intact — audit log, gate runs, facts, packages. */
  archive: Record<string, unknown>;
}

function deepFreeze<T>(obj: T): T {
  if (obj !== null && typeof obj === 'object') {
    for (const value of Object.values(obj)) deepFreeze(value);
    Object.freeze(obj);
  }
  return obj;
}

export class RetentionVault {
  private readonly archives = new Map<string, ArchivedAccount>();
  private readonly purgeRefusals: { taxpayer_id: string; requested_at: string; reason: string }[] = [];

  constructor(
    private readonly clock: Clock,
    private readonly rules: SecurityRules,
  ) {}

  /** Close the account: archive intact + access revoked. */
  closeAccount(taxpayer_id: string, records: Record<string, unknown>): ArchivedAccount {
    if (this.archives.has(taxpayer_id)) throw new Error(`account ${taxpayer_id} is already closed`);
    const now = this.clock.nowIso();
    const hold = new Date(Date.parse(now));
    hold.setUTCFullYear(hold.getUTCFullYear() + this.rules.retention_years);
    const archived: ArchivedAccount = deepFreeze({
      taxpayer_id,
      archived_at: now,
      hold_until: hold.toISOString().slice(0, 10),
      access: 'revoked' as const,
      archive: structuredClone(records),
    });
    this.archives.set(taxpayer_id, archived);
    return archived;
  }

  /** Normal access after closure is refused — the archive is not browsable. */
  accessRecords(taxpayer_id: string): never {
    const archived = this.archives.get(taxpayer_id);
    if (archived) {
      throw new Error(
        `access revoked: account ${taxpayer_id} is closed and under retention hold until ${archived.hold_until}`,
      );
    }
    throw new Error(`account ${taxpayer_id} is not archived here`);
  }

  /**
   * A deletion/purge request during the hold is REFUSED — retention
   * obligations outlive the account relationship. The refusal itself is
   * recorded (it is part of the compliance story).
   */
  requestPurge(taxpayer_id: string): { purged: false; reason: string } {
    const archived = this.archives.get(taxpayer_id);
    if (!archived) throw new Error(`account ${taxpayer_id} is not archived here`);
    const today = this.clock.nowIso().slice(0, 10);
    if (today < archived.hold_until) {
      const reason = `purge blocked: statutory retention hold runs until ${archived.hold_until} (PLACEHOLDER ${this.rules.retention_years}-year period — verify). The archive remains intact with access revoked.`;
      this.purgeRefusals.push({ taxpayer_id, requested_at: this.clock.nowIso(), reason });
      return { purged: false, reason };
    }
    // Post-hold purging is a separate, deliberate workflow — not implemented
    // in the skeleton; nothing is ever purged implicitly.
    throw new Error('post-hold purge is a deliberate manual workflow (not part of the closure path)');
  }

  /** Compliance inspection only (not tenant access): archive integrity check. */
  inspectArchive(taxpayer_id: string): ArchivedAccount {
    const archived = this.archives.get(taxpayer_id);
    if (!archived) throw new Error(`account ${taxpayer_id} is not archived here`);
    return archived;
  }

  refusals(): readonly { taxpayer_id: string; requested_at: string; reason: string }[] {
    return this.purgeRefusals;
  }
}
