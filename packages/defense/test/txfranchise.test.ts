/** P4.5 — TX franchise compliance tracker (tracking only, no margin math). */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadTxFranchiseRules, txFranchiseStatus } from '../src/txfranchise';

const rules = loadTxFranchiseRules(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'rules', 'fixtures', '2025.TX.json'), 'utf8')),
);

describe('txFranchiseStatus', () => {
  it('no TX registration → nothing tracked', () => {
    const s = txFranchiseStatus({ rules, registered_in_tx: false, annualized_revenue: '5000000', is_retail_wholesale: false });
    expect(s.nexus).toBe(false);
    expect(s.filings_required).toEqual([]);
  });

  it('below the no-tax-due threshold → PIR only, zero exposure', () => {
    const s = txFranchiseStatus({ rules, registered_in_tx: true, annualized_revenue: '150000', is_retail_wholesale: false });
    expect(s.below_no_tax_due_threshold).toBe(true);
    expect(s.filings_required).toEqual(['public_information_report']);
    expect(s.upper_bound_exposure).toBe('0');
    expect(s.report_due_date).toBe('2025-05-15');
  });

  it('at the threshold exactly → still below (lte)', () => {
    const s = txFranchiseStatus({ rules, registered_in_tx: true, annualized_revenue: '2470000', is_retail_wholesale: false });
    expect(s.below_no_tax_due_threshold).toBe(true);
  });

  it('above the threshold → franchise report + upper-bound exposure at the other-entity rate', () => {
    const s = txFranchiseStatus({ rules, registered_in_tx: true, annualized_revenue: '3000000', is_retail_wholesale: false });
    expect(s.below_no_tax_due_threshold).toBe(false);
    expect(s.filings_required).toEqual(['public_information_report', 'franchise_tax_report']);
    expect(s.upper_bound_exposure).toBe('22500'); // 3,000,000 × 0.0075
    expect(s.notes.join(' ')).toMatch(/NOT computed/);
  });

  it('retail/wholesale uses the lower rate', () => {
    const s = txFranchiseStatus({ rules, registered_in_tx: true, annualized_revenue: '3000000', is_retail_wholesale: true });
    expect(s.upper_bound_exposure).toBe('11250'); // 3,000,000 × 0.00375
  });
});
