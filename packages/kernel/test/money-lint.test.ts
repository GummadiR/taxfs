/**
 * Subject: money-safety lint (guardrail G3, Blueprint §9.1).
 * Negative tests: deliberately-defective snippets virtually placed inside
 * the protected scopes must be FLAGGED; the same snippet outside the scope
 * must not fire; and the real kernel source must be clean.
 */
import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

const SEEDED_FLOAT_DEFECT = `
export function seededFloatDefect(wages: number, rate: number): number {
  const tax = wages * rate; // float arithmetic on money — must be caught
  return tax + 0.01;
}
`;

const SEEDED_TONUMBER_DEFECT = `
export function seededLeak(m: { toNumber(): number }): number {
  return m.toNumber();
}
`;

const SEEDED_STRING_CONCAT = `
export function seededConcat(a: string, b: string): string {
  return a + b; // '+' is banned in-scope even for strings (Blueprint N1)
}
`;

describe('money-safety lint rule (kernel/kernel2/critic scope)', () => {
  const eslint = new ESLint({ cwd: repoRoot, errorOnUnmatchedPattern: false });

  it('catches seeded float arithmetic inside packages/kernel/src', async () => {
    const [result] = await eslint.lintText(SEEDED_FLOAT_DEFECT, {
      filePath: 'packages/kernel/src/__seeded_float_defect__.ts',
    });
    const restricted = (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax');
    expect(restricted.length).toBeGreaterThanOrEqual(2); // '*' and '+'
    expect(restricted[0]?.message).toMatch(/Money/);
  });

  it('catches seeded float arithmetic inside packages/kernel2/src (binds before the port)', async () => {
    const [result] = await eslint.lintText(SEEDED_FLOAT_DEFECT, {
      filePath: 'packages/kernel2/src/__seeded_float_defect__.ts',
    });
    const restricted = (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax');
    expect(restricted.length).toBeGreaterThanOrEqual(2);
  });

  it('catches seeded toNumber() leakage inside the critics directory', async () => {
    const [result] = await eslint.lintText(SEEDED_TONUMBER_DEFECT, {
      filePath: 'packages/gates/src/critics/__seeded_leak__.ts',
    });
    const restricted = (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax');
    expect(restricted.length).toBeGreaterThanOrEqual(1);
    expect(restricted[0]?.message).toMatch(/toNumber/);
  });

  it('catches string concatenation in-scope (the + ban is unconditional)', async () => {
    const [result] = await eslint.lintText(SEEDED_STRING_CONCAT, {
      filePath: 'packages/kernel/src/__seeded_concat__.ts',
    });
    const restricted = (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax');
    expect(restricted.length).toBeGreaterThanOrEqual(1);
  });

  it('does NOT fire outside the protected scopes', async () => {
    const [result] = await eslint.lintText(SEEDED_FLOAT_DEFECT, {
      filePath: 'packages/spine/src/__not_protected__.ts',
    });
    const restricted = (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-syntax');
    expect(restricted).toHaveLength(0);
  });

  it('control: the real kernel/critic source is clean under the rule', async () => {
    const results = await eslint.lintFiles([
      'packages/kernel/src/**/*.ts',
      'packages/kernel2/src/**/*.ts',
      'packages/gates/src/critics/**/*.ts',
    ]);
    const errors = results.flatMap((r) => r.messages.filter((m) => m.ruleId === 'no-restricted-syntax'));
    expect(errors).toEqual([]);
  });
});
