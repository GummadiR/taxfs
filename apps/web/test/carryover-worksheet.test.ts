/**
 * Subject: the IRS Capital Loss Carryover Worksheet (TaxOS P40, ported) —
 * including the subtlety a naive subtraction misses: the allowed loss is
 * only "used up" to the extent taxable income absorbed it, so a low or
 * negative prior-year taxable income carries MORE forward.
 */
import { describe, it, expect } from 'vitest';
import { Money } from '@taxfs/shared';
import { computeCarryoverWorksheet } from '../src/server/carryover-worksheet';

const M = (s: string) => Money.fromString(s);

describe('capital-loss carryover worksheet', () => {
  it('negative taxable income leaves the loss largely UNUSED (the P40 subtlety)', () => {
    const r = computeCarryoverWorksheet({
      taxable_income: M('-2000'),
      schd_line7: M('-4000'),
      schd_line15: M('500'),
      schd_line21: M('-3000'),
    });
    // Only 1000 of the allowed 3000 was absorbed by income; ST loss 4000
    // minus (used 1000 + LT gain 500) = 2500 carries — a naive
    // "loss − 3000" would wrongly carry only 500.
    expect(r.st_carryover.toString()).toBe('2500');
    expect(r.lt_carryover.toString()).toBe('0');
  });

  it('gains both terms → nothing carries', () => {
    const r = computeCarryoverWorksheet({
      taxable_income: M('50000'),
      schd_line7: M('200'),
      schd_line15: M('300'),
      schd_line21: M('500'),
    });
    expect(r.st_carryover.isZero()).toBe(true);
    expect(r.lt_carryover.isZero()).toBe(true);
  });

  it('large LT loss with ST gain: gain offsets first, then the deducted 3000', () => {
    const r = computeCarryoverWorksheet({
      taxable_income: M('100000'),
      schd_line7: M('1000'),
      schd_line15: M('-48842'),
      schd_line21: M('-3000'),
    });
    expect(r.st_carryover.toString()).toBe('0');
    expect(r.lt_carryover.toString()).toBe('44842'); // 48842 − 1000 − 3000
    expect(r.steps.join(' ')).toContain('LONG-TERM carryover');
  });
});
