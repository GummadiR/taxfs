/**
 * Register continuity (P0 — REQUIREMENTS §3 Gate 3, ARCHITECTURE §3.2).
 * Pure functions: the EngagementBoard calls these; no I/O here.
 */
import type { RegisterSnapshot } from './contracts';

export interface ContinuityBreak {
  register_id: string;
  kind: string;
  balance: string;
  opening: string | undefined;
  prior_closing: string | undefined;
  reason: 'opening_mismatch' | 'no_prior_register' | 'prior_not_closed' | 'manual_opening_unsupported';
}

/** Register identity across years: same taxpayer/kind/scope. */
function identityKey(r: RegisterSnapshot): string {
  return `${r.taxpayer_id}|${r.kind}|${r.scope_ref}`;
}

/**
 * Gate 3 assertion: every current-year register's opening equals its prior-
 * year register's LOCKED closing, balance by balance. A register with no
 * prior year is admissible only with an attached opening_source_ref
 * (first-year manual balance, flagged for the defense file).
 */
export function continuityBreaks(
  prior: readonly RegisterSnapshot[],
  current: readonly RegisterSnapshot[],
): ContinuityBreak[] {
  const priorByIdentity = new Map(prior.map((r) => [identityKey(r), r]));
  const breaks: ContinuityBreak[] = [];
  for (const cur of current) {
    const prev = priorByIdentity.get(identityKey(cur));
    if (!prev) {
      const hasOpening = Object.keys(cur.opening).length > 0;
      if (hasOpening && cur.opening_source_ref === null) {
        breaks.push({
          register_id: cur.register_id, kind: cur.kind, balance: '*',
          opening: undefined, prior_closing: undefined,
          reason: 'manual_opening_unsupported',
        });
      }
      continue;
    }
    if (prev.status !== 'closed' || prev.closing === null) {
      breaks.push({
        register_id: cur.register_id, kind: cur.kind, balance: '*',
        opening: undefined, prior_closing: undefined, reason: 'prior_not_closed',
      });
      continue;
    }
    const balances = new Set([...Object.keys(cur.opening), ...Object.keys(prev.closing)]);
    for (const b of balances) {
      if (cur.opening[b] !== prev.closing[b]) {
        breaks.push({
          register_id: cur.register_id, kind: cur.kind, balance: b,
          opening: cur.opening[b], prior_closing: prev.closing[b],
          reason: 'opening_mismatch',
        });
      }
    }
  }
  return breaks;
}
