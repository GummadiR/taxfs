/** P1.6 — §6654 required annual payment / Form 2210 exposure. Hand-verified. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadEstTaxRules, requiredAnnualPayment } from '../src/esttax';

const rules = loadEstTaxRules(
  JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'rules', 'fixtures', '2025.ESTTAX.json'), 'utf8')),
);

describe('requiredAnnualPayment (§6654)', () => {
  it('estimated payments already made suppress exposure (F4 critique fix)', () => {
    const r = requiredAnnualPayment({
      rules,
      current_year_tax: '32981',
      withholding: '12000',
      estimated_payments: '10000',
      prior_year_tax: '20000',
      prior_year_agi: '160000',
      filing_status: 'single',
    });
    expect(r.shortfall).toBe('0'); // required 22,000 − 12,000 wh − 10,000 est
    expect(r.penalty_exposure).toBe(false);
  });

  it('owner-like case: high prior AGI → 110% anchor wins the lesser-of', () => {
    // 90% × 32,981 = 29,682.9 → 29,683; 110% × 20,000 = 22,000 → required 22,000
    const r = requiredAnnualPayment({
      rules,
      current_year_tax: '32981',
      withholding: '12000',
      estimated_payments: '0',
      prior_year_tax: '20000',
      prior_year_agi: '160000',
      filing_status: 'single',
    });
    expect(r.ninety_pct_current).toBe('29683');
    expect(r.prior_year_anchor_pct).toBe('1.10');
    expect(r.prior_year_anchor).toBe('22000');
    expect(r.required_annual_payment).toBe('22000');
    expect(r.shortfall).toBe('10000');
    expect(r.quarterly_voucher).toBe('2500');
    expect(r.penalty_exposure).toBe(true);
  });

  it('prior AGI at/below $150k uses the 100% anchor', () => {
    const r = requiredAnnualPayment({
      rules,
      current_year_tax: '32981',
      withholding: '12000',
      estimated_payments: '0',
      prior_year_tax: '20000',
      prior_year_agi: '150000', // not > threshold
      filing_status: 'single',
    });
    expect(r.prior_year_anchor_pct).toBe('1.00');
    expect(r.prior_year_anchor).toBe('20000');
    expect(r.required_annual_payment).toBe('20000');
  });

  it('MFS uses the $75k threshold', () => {
    const r = requiredAnnualPayment({
      rules,
      current_year_tax: '10000',
      withholding: '0',
      estimated_payments: '0',
      prior_year_tax: '8000',
      prior_year_agi: '80000',
      filing_status: 'mfs',
    });
    expect(r.prior_year_anchor_pct).toBe('1.10'); // 80k > 75k MFS threshold
  });

  it('90% of current wins when income dropped', () => {
    // 90% × 10,000 = 9,000 < 100% × 30,000 = 30,000
    const r = requiredAnnualPayment({
      rules,
      current_year_tax: '10000',
      withholding: '0',
      estimated_payments: '0',
      prior_year_tax: '30000',
      prior_year_agi: '100000',
      filing_status: 'single',
    });
    expect(r.required_annual_payment).toBe('9000');
  });

  it('de minimis: balance due under $1,000 → no penalty exposure', () => {
    // tax 5,000 − wh 4,100 = 900 < 1,000 → §6654(e)(1)
    const r = requiredAnnualPayment({
      rules,
      current_year_tax: '5000',
      withholding: '4100',
      estimated_payments: '0',
      prior_year_tax: '6000',
      prior_year_agi: '100000',
      filing_status: 'single',
    });
    expect(r.balance_due_after_withholding).toBe('900');
    expect(r.de_minimis_met).toBe(true);
    expect(r.penalty_exposure).toBe(false);
    expect(r.shortfall).toBe('400'); // required 4,500 − wh 4,100 — reported, but not penalized
  });

  it('zero prior-year liability → no required payment (§6654(e)(2))', () => {
    const r = requiredAnnualPayment({
      rules,
      current_year_tax: '40000',
      withholding: '0',
      estimated_payments: '0',
      prior_year_tax: '0',
      prior_year_agi: '0',
      filing_status: 'single',
    });
    expect(r.no_prior_year_liability).toBe(true);
    expect(r.required_annual_payment).toBe('0');
    expect(r.penalty_exposure).toBe(false);
  });
});
