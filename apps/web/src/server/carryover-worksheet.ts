/**
 * P40 — the IRS "Capital Loss Carryover Worksheet" (Schedule D instructions,
 * lines 6 and 14), computed FOR the user from four numbers printed on the
 * prior-year return. Exists because the manual fallback ("subtract these
 * three figures") confused a careful user into copying the prior year's
 * line 14 — the machine should run the worksheet, the human should only
 * transcribe printed numbers.
 *
 * The subtlety the worksheet handles that a naive subtraction misses: the
 * $3,000 allowed loss is only "used up" to the extent taxable income
 * absorbed it — a low or negative prior-year taxable income means less was
 * used and MORE carries forward (lines 1–4).
 */
import { Money } from '@taxfs/shared';

export interface CarryoverInputs {
  /** 2024 Form 1040 line 15 (taxable income — may be negative). */
  taxable_income: Money;
  /** 2024 Schedule D line 7 (net short-term — gain positive, loss negative). */
  schd_line7: Money;
  /** 2024 Schedule D line 15 (net long-term — gain positive, loss negative). */
  schd_line15: Money;
  /** 2024 Schedule D line 21 (allowed loss — enter as shown, negative or positive). */
  schd_line21: Money;
}

export interface CarryoverResult {
  st_carryover: Money;
  lt_carryover: Money;
  steps: string[];
}

const ZERO = Money.zero();

function max0(m: Money): Money {
  return m.isNegative() ? ZERO : m;
}

function abs(m: Money): Money {
  return m.isNegative() ? m.neg() : m;
}

export function computeCarryoverWorksheet(input: CarryoverInputs): CarryoverResult {
  const steps: string[] = [];
  const line1 = input.taxable_income;
  const line2 = abs(input.schd_line21); // allowed loss as a positive amount
  const line3 = max0(line1.add(line2));
  const line4 = Money.min(line2, line3);
  steps.push(`1. 2024 taxable income: ${line1.toString()}`);
  steps.push(`2. 2024 allowed loss (Sch D line 21, as positive): ${line2.toString()}`);
  steps.push(`3. Combine 1 and 2 (not below 0): ${line3.toString()}`);
  steps.push(`4. Smaller of 2 or 3 — the loss the 2024 return actually USED: ${line4.toString()}`);

  let st = ZERO;
  let line5 = ZERO;
  if (input.schd_line7.isNegative()) {
    line5 = abs(input.schd_line7);
    const line6 = max0(input.schd_line15);
    const line7w = line4.add(line6);
    st = max0(line5.sub(line7w));
    steps.push(`5. Short-term loss (line 7 as positive): ${line5.toString()}`);
    steps.push(`6. Long-term GAIN (line 15, if a gain): ${line6.toString()}`);
    steps.push(`7. Add 4 and 6: ${line7w.toString()}`);
    steps.push(`8. SHORT-TERM carryover to 2025 = 5 − 7 (not below 0): ${st.toString()}`);
  } else {
    steps.push(`5–8. 2024 line 7 was a gain (${input.schd_line7.toString()}) — no short-term carryover.`);
  }

  let lt = ZERO;
  if (input.schd_line15.isNegative()) {
    const line9 = abs(input.schd_line15);
    const line10 = max0(input.schd_line7);
    const line11 = max0(line4.sub(line5));
    const line12 = line10.add(line11);
    lt = max0(line9.sub(line12));
    steps.push(`9. Long-term loss (line 15 as positive): ${line9.toString()}`);
    steps.push(`10. Short-term GAIN (line 7, if a gain): ${line10.toString()}`);
    steps.push(`11. Line 4 minus line 5 (not below 0): ${line11.toString()}`);
    steps.push(`12. Add 10 and 11: ${line12.toString()}`);
    steps.push(`13. LONG-TERM carryover to 2025 = 9 − 12 (not below 0): ${lt.toString()}`);
  } else {
    steps.push(`9–13. 2024 line 15 was a gain (${input.schd_line15.toString()}) — no long-term carryover.`);
  }

  return { st_carryover: st, lt_carryover: lt, steps };
}
