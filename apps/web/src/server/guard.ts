/**
 * Guardrail G9, endpoint side: no server input may carry an SSN-shaped value.
 * Identity has exactly one home (the browser vault, §5) — a nine-digit
 * pattern arriving in any free-text server field is either a mistake or an
 * attempt, and both get the same loud refusal BEFORE anything is stored.
 * Negative-tested end-to-end: the e2e suite posts SSN-shaped values at the
 * accepting inputs and then scans every table for them.
 */
const SSN_SHAPES = [
  /\b\d{3}-\d{2}-\d{4}\b/, // dashed
  /\b\d{3}\s\d{2}\s\d{4}\b/, // spaced
  /\b\d{9}\b/, // bare nine digits
];

export function assertNoIdentityLike(value: string, label: string): string {
  for (const shape of SSN_SHAPES) {
    if (shape.test(value)) {
      throw new Error(
        `${label} looks like it contains an SSN or similar identifier — TaxFS never stores identity on the server. Keep identity in the browser vault on File It.`,
      );
    }
  }
  return value;
}
