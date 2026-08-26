/**
 * Money — fixed-point decimal money type.
 *
 * DECISION (documented per kickoff): money is represented with decimal.js
 * (arbitrary-precision decimal), wrapped in an opaque `Money` class, NOT
 * integer cents. Rationale: tax math multiplies money by fractional rates
 * (bracket rates, IL 4.95%) and the rounding convention (IRS whole-dollar,
 * half-up) must be owned explicitly by the kernel; decimal.js gives exact
 * decimal multiplication with an explicit, auditable rounding step.
 *
 * Float arithmetic on money anywhere = defect. The class never exposes a
 * `number`; construction and serialization are string-based. ESLint bans
 * native arithmetic operators and `toNumber()` in kernel/critic source.
 */
import { Decimal } from 'decimal.js';

// Deterministic global config: enough precision for any return; HALF_UP is
// the IRS "round half up" convention ($0.50 rounds to $1).
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export class Money {
  private readonly d: Decimal;

  private constructor(d: Decimal) {
    this.d = d;
  }

  static fromString(s: string): Money {
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
      throw new Error(`Money.fromString: invalid decimal string "${s}"`);
    }
    return new Money(new Decimal(s));
  }

  static zero(): Money {
    return new Money(new Decimal(0));
  }

  static sum(items: readonly Money[]): Money {
    return items.reduce((acc, m) => acc.add(m), Money.zero());
  }

  static max(a: Money, b: Money): Money {
    return a.gte(b) ? a : b;
  }

  static min(a: Money, b: Money): Money {
    return a.lte(b) ? a : b;
  }

  add(o: Money): Money {
    return new Money(this.d.plus(o.d));
  }

  sub(o: Money): Money {
    return new Money(this.d.minus(o.d));
  }

  neg(): Money {
    return new Money(this.d.negated());
  }

  /** Multiply by a rate given as a decimal string from rule-data (e.g. "0.0495"). */
  mulRate(rate: string): Money {
    return new Money(this.d.times(new Decimal(rate)));
  }

  /** Multiply by an exact fraction numer/denom (e.g. months/180 for §195 amortization). */
  mulFraction(numer: string, denom: string): Money {
    return new Money(this.d.times(new Decimal(numer)).dividedBy(new Decimal(denom)));
  }

  /** IRS whole-dollar rounding, half-up. The kernel owns all rounding. */
  roundToDollar(): Money {
    return new Money(this.d.toDecimalPlaces(0, Decimal.ROUND_HALF_UP));
  }

  /** FBAR whole-dollar rounding: UP to the next dollar (FinCEN 114 instructions). */
  roundUpToDollar(): Money {
    return new Money(this.d.toDecimalPlaces(0, Decimal.ROUND_CEIL));
  }

  isWholeDollars(): boolean {
    return this.d.isInteger();
  }

  isZero(): boolean {
    return this.d.isZero();
  }

  isNegative(): boolean {
    return this.d.isNegative();
  }

  eq(o: Money): boolean {
    return this.d.equals(o.d);
  }

  gt(o: Money): boolean {
    return this.d.greaterThan(o.d);
  }

  gte(o: Money): boolean {
    return this.d.greaterThanOrEqualTo(o.d);
  }

  lt(o: Money): boolean {
    return this.d.lessThan(o.d);
  }

  lte(o: Money): boolean {
    return this.d.lessThanOrEqualTo(o.d);
  }

  /** Ratio of this to `denom` as a decimal string (for rate sanity checks). */
  ratioOf(denom: Money): string {
    if (denom.isZero()) {
      throw new Error('Money.ratioOf: division by zero');
    }
    return this.d.dividedBy(denom.d).toString();
  }

  /** True if this amount is an exact multiple of `multiple` (round-number check). */
  isMultipleOf(multiple: string): boolean {
    const m = new Decimal(multiple);
    if (m.isZero()) return false;
    return this.d.modulo(m).isZero();
  }

  /** Canonical decimal string, e.g. "2833" or "1234.56". */
  toString(): string {
    return this.d.toFixed();
  }

  toJSON(): string {
    return this.toString();
  }
}
