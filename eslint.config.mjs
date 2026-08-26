// TaxFS lint config.
// The money-safety block (Blueprint N1, guardrail G3) bans ALL native
// arithmetic, compound assignment, increment/decrement, and toNumber()
// inside the deterministic kernels and the critic set: money math there
// must go through the Money class (decimal.js). The ban includes string
// concatenation because '+' is banned unconditionally in that scope.
// Negative test: packages/kernel/test/money-lint.test.ts (G3, Blueprint 9.1).
import tseslint from 'typescript-eslint';

const ARITHMETIC_OPERATORS = ['+', '-', '*', '/', '%'];

const moneySafetySelectors = [
  ...ARITHMETIC_OPERATORS.map((op) => ({
    selector: `BinaryExpression[operator='${op}']`,
    message: `Native '${op}' is banned in kernel/critic code: money math must use the Money class (decimal.js). Float arithmetic on money = defect.`,
  })),
  ...ARITHMETIC_OPERATORS.map((op) => ({
    selector: `AssignmentExpression[operator='${op}=']`,
    message: `Native '${op}=' is banned in kernel/critic code: money math must use the Money class (decimal.js).`,
  })),
  {
    selector: "CallExpression[callee.property.name='toNumber']",
    message: 'toNumber() leaks money into IEEE-754 floats — banned in kernel/critic code.',
  },
  {
    selector: "UpdateExpression[operator='++'], UpdateExpression[operator='--']",
    message: 'Native increment/decrement is banned in kernel/critic code; keep all numeric work in Money.',
  },
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.next/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'apps/web/next-env.d.ts',
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Money-safety scope: both kernels and the critic set. kernel2 is listed
    // from day one so the wall already binds when Phase 3 ports it.
    files: [
      'packages/kernel/src/**/*.ts',
      'packages/kernel2/src/**/*.ts',
      'packages/gates/src/critics/**/*.ts',
    ],
    rules: {
      'no-restricted-syntax': ['error', ...moneySafetySelectors],
    },
  },
);
