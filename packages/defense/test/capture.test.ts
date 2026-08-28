/**
 * G.5 acceptance: append-only capture with immutable created_at; edits
 * create new versions with the old version retained; the §274(d) generic-
 * purpose substance check gates Defense-File eligibility.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Clock } from '@taxfs/shared';
import { CaptureStore, assessPurpose, loadCaptureRules } from '@taxfs/defense';

const rules = loadCaptureRules(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../../rules/fixtures/2025.CAPTURE-RULES.json', import.meta.url)), 'utf8')),
);

function tickingClock(): Clock {
  let t = 0;
  return { nowIso: () => `2025-03-0${(t += 1)}T09:00:00.000Z` };
}

describe('substance check (§274(d))', () => {
  it('flags generic purposes and short purposes; passes specific ones', () => {
    expect(assessPurpose('business meeting', rules).substantiation).toBe('incomplete');
    expect(assessPurpose('errand', rules).substantiation).toBe('incomplete');
    expect(assessPurpose('lunch w/ J. Rivera re: Q3 site contract', rules).substantiation).toBe('complete');
    expect(assessPurpose('business meeting', rules).prompt).toMatch(/WHEN, not WHAT/);
  });
});

describe('append-only capture store', () => {
  it('edits create a new version; the original is retained with its created_at untouched', () => {
    const store = new CaptureStore(tickingClock(), rules);
    const v1 = store.addMileage({ trip_date: '2025-03-01', purpose: 'business meeting', miles: '18' });
    expect(v1.substantiation).toBe('incomplete');
    expect(v1.created_at).toBe('2025-03-01T09:00:00.000Z');

    const v2 = store.amend(v1.record_id, { purpose: 'drive to Aurora site walkthrough w/ GC re: change order 12' });
    expect(v2.version).toBe(2);
    expect(v2.supersedes).toBe(v1.record_id);
    expect(v2.substantiation).toBe('complete');
    expect(v2.created_at).not.toBe(v1.created_at); // its own contemporaneity

    const history = store.history(v1.chain_id);
    expect(history).toHaveLength(2);
    expect(history[0]).toBe(v1); // original retained, untouched
    expect(history[0]?.purpose).toBe('business meeting');
    expect(store.current().map((r) => r.record_id)).toEqual([v2.record_id]);
  });

  it('records are frozen — direct mutation throws', () => {
    const store = new CaptureStore(tickingClock(), rules);
    const entry = store.addMileage({ trip_date: '2025-03-01', purpose: 'site visit for panel install, Elgin', miles: '22' });
    expect(() => {
      (entry as { created_at: string }).created_at = '1999-01-01T00:00:00.000Z';
    }).toThrow();
  });

  it('amending a superseded version is refused (no forked history)', () => {
    const store = new CaptureStore(tickingClock(), rules);
    const v1 = store.addReceipt({ receipt_date: '2025-03-01', payee: 'Depot', amount: '84.12', purpose: 'misc', photo_ref: 'ph1' });
    store.amend(v1.record_id, { purpose: 'anchor bolts for the Elgin panel install' });
    expect(() => store.amend(v1.record_id, { purpose: 'x' })).toThrow(/superseded/);
  });

  it('only substantiation-complete heads are Defense-File eligible', () => {
    const store = new CaptureStore(tickingClock(), rules);
    store.addMileage({ trip_date: '2025-03-01', purpose: 'business trip', miles: '10' }); // incomplete
    const ok = store.addMileage({ trip_date: '2025-03-02', purpose: 'client kickoff at Rivera & Co, Naperville', miles: '31' });
    expect(store.defenseEligible().map((r) => r.record_id)).toEqual([ok.record_id]);
  });

  it('income ledger is append-only with immutable timestamps', () => {
    const store = new CaptureStore(tickingClock(), rules);
    const e = store.addIncome({ income_date: '2025-02-15', source: 'consulting invoice 14', amount: '2500' });
    expect(e.created_at).toBe('2025-03-01T09:00:00.000Z');
    expect(() => {
      (e as { amount: string }).amount = '9999';
    }).toThrow();
    expect(store.incomeLedger()).toHaveLength(1);
  });
});
