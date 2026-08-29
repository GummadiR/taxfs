/** P5.1 — FBAR threshold monitor (FinCEN 114; generated, never transmitted). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fbarStatus, loadFbarRules } from '../src/fbar';

const rules = loadFbarRules(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'rules', 'fixtures', '2025.FBAR.json'), 'utf8')),
);

const acct = (id: string, max: string) => ({
  account_id: id, max_balance_usd: max, country: 'IN', institution_ref: `enc:${id}`, jointly_owned: false,
});

describe('fbarStatus', () => {
  it('no accounts → not required', () => {
    const s = fbarStatus({ rules, accounts: [] });
    expect(s.filing_required).toBe(false);
    expect(s.aggregate_max).toBe('0');
  });

  it('balances round UP to the next dollar (FinCEN rule, not HALF_UP)', () => {
    const s = fbarStatus({ rules, accounts: [acct('a', '4200.01'), acct('b', '5799.10')] });
    // 4,201 + 5,800 = 10,001 > 10,000 — rounding UP is what crosses the line
    expect(s.aggregate_max).toBe('10001');
    expect(s.filing_required).toBe(true);
    expect(s.output_rows.map((r) => r.max_balance_rounded)).toEqual(['4201', '5800']);
  });

  it('exactly at the threshold → not required (must EXCEED $10,000)', () => {
    const s = fbarStatus({ rules, accounts: [acct('a', '10000')] });
    expect(s.filing_required).toBe(false);
  });

  it('aggregate of maxima double-counts transfers by design', () => {
    // 6k moved from a to b mid-year: both peaked at 6k → aggregate 12k
    const s = fbarStatus({ rules, accounts: [acct('a', '6000'), acct('b', '6000')] });
    expect(s.filing_required).toBe(true);
    expect(s.notes.join(' ')).toMatch(/double-count/);
  });

  it('due and extension dates surface from rule data', () => {
    const s = fbarStatus({ rules, accounts: [acct('a', '20000')] });
    expect(s.report_due_date).toBe('2026-04-15');
    expect(s.automatic_extension_date).toBe('2026-10-15');
  });

  it('negative max balance is a hard error', () => {
    expect(() => fbarStatus({ rules, accounts: [acct('a', '-5')] })).toThrow(/negative/);
  });
});
