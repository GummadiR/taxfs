/**
 * Subject: hardcoded-values audit (guardrail G4, Blueprint §9.1).
 * Negative tests: a seeded dollar literal in kernel scope must be flagged;
 * an audit-allow'd line and small structural constants must not.
 */
import { describe, expect, it } from 'vitest';
import { auditFile } from './audit-hardcoded.js';

describe('hardcoded-values audit (G4)', () => {
  it('flags a seeded dollar figure in kernel scope', () => {
    const findings = auditFile('packages/kernel/src/__seed__.ts', 'const CAP = 3000;\n');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatch(/rule data/);
  });

  it('flags underscore-separated literals too', () => {
    const findings = auditFile('packages/kernel/src/__seed__.ts', 'const LIMIT = 23_500;\n');
    expect(findings).toHaveLength(1);
  });

  it('does not flag small structural constants', () => {
    const findings = auditFile('packages/kernel/src/__seed__.ts', 'const GATES = 13; const HALF = 0.5;\n');
    expect(findings).toHaveLength(0);
  });

  it('does not flag figures quoted in comments (prose, not code)', () => {
    const findings = auditFile('packages/kernel/src/__seed__.ts', 'x(); // the $3,000 cap comes from rule data 3000\n');
    expect(findings).toHaveLength(0);
  });

  it('honours an explicit audit-allow with reason', () => {
    const findings = auditFile(
      'packages/kernel/src/__seed__.ts',
      'const MS_PER_DAY = 86_400_000; // audit-allow: time-unit, not money\n',
    );
    expect(findings).toHaveLength(0);
  });
});
