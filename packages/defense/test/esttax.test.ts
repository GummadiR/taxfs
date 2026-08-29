/**
 * G.5 estimated-tax tracker: safe harbor AND annualized-income methods
 * shown with the cash-flow difference; nudges before due dates; missed-
 * quarter warning (S4). All parameters from PLACEHOLDER rule-data.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Clock } from '@taxfs/shared';
import { estimatedTaxReport, loadEstTaxRules, type IncomeLedgerEntry } from '@taxfs/defense';

const rules = loadEstTaxRules(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../../rules/fixtures/2025.ESTTAX.json', import.meta.url)), 'utf8')),
);

function ledger(entries: [string, string][]): IncomeLedgerEntry[] {
  return entries.map(([income_date, amount], i) => ({
    record_id: `inc-${i}`,
    created_at: income_date,
    income_date,
    source: 'consulting',
    amount,
  }));
}

const clockAt = (date: string): Clock => ({ nowIso: () => `${date}T00:00:00.000Z` });

describe('estimated-tax tracker (both methods, S4)', () => {
  it('annualized method tracks a slow-start year below the rigid safe harbor', () => {
    // Prior tax 10000 → safe-harbor annual 11000 (110% PLACEHOLDER).
    // Income: 5000 by Q1, 5000 more by Q2 (seasonal, back-loaded year).
    const report = estimatedTaxReport({
      rules,
      clock: clockAt('2025-06-01'),
      prior_year_tax: '10000',
      payments: [{ date: '2025-04-10', amount: '1000' }],
      income_ledger: ledger([
        ['2025-03-01', '5000'],
        ['2025-06-10', '5000'],
      ]),
    });
    const q1 = report.quarters[0]!;
    // SH: 11000 × 0.225 = 2475 ; AI: 5000×4=20000 ×0.20 ×0.225 = 900
    expect(q1.safe_harbor_required_cumulative).toBe('2475');
    expect(q1.annualized_required_cumulative).toBe('900');
    expect(q1.method_difference).toBe('1575'); // the cash-flow gap the H copy explains
    expect(q1.phase).toBe('past');
    expect(q1.status).toBe('met'); // paid 1000 ≥ min(2475, 900)

    const q2 = report.quarters[1]!;
    expect(q2.phase).toBe('upcoming'); // due 2025-06-16, clock 2025-06-01
    expect(q2.status).toBe('nudge');
    expect(q2.note).toMatch(/Due 2025-06-16/);
  });

  it('missed quarters carry the S4 warning and are listed', () => {
    const report = estimatedTaxReport({
      rules,
      clock: clockAt('2026-02-01'), // all quarters past
      prior_year_tax: '10000',
      payments: [{ date: '2025-04-10', amount: '1000' }],
      income_ledger: ledger([
        ['2025-03-01', '5000'],
        ['2025-06-10', '5000'],
        ['2025-09-01', '20000'],
        ['2025-12-01', '30000'],
      ]),
    });
    expect(report.missed_quarters.length).toBeGreaterThan(0);
    const missed = report.quarters.find((q) => q.status === 'underpaid')!;
    expect(missed.note).toMatch(/cannot be unwound/);
    // Both methods always present on every row
    for (const q of report.quarters) {
      expect(q.safe_harbor_required_cumulative).toMatch(/^\d+$/);
      expect(q.annualized_required_cumulative).toMatch(/^\d+$/);
    }
  });

  it('no aggregate metric leaks into the report schema', () => {
    const report = estimatedTaxReport({
      rules,
      clock: clockAt('2025-06-01'),
      prior_year_tax: '10000',
      payments: [],
      income_ledger: [],
    });
    expect(JSON.stringify(report)).not.toMatch(/score/i);
  });
});
