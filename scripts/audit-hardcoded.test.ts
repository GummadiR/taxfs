/**
 * Subject: hardcoded-values audit (guardrail G4, Blueprint §9.1).
 * Negative tests: a seeded dollar literal in kernel scope must be flagged;
 * an audit-allow'd line and small structural constants must not.
 */
import { describe, expect, it } from 'vitest';
import { auditFile } from './audit-hardcoded';

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

  it('flags a Money string literal — dollars travel as quoted strings', () => {
    const findings = auditFile('packages/kernel/src/__seed__.ts', "const floor = Money.fromString('200');\n");
    expect(findings).toHaveLength(1);
    const f2 = auditFile('packages/kernel2/src/__seed__.ts', "const cap = Money.max(D('3000'), x).mulRate('0.5');\n");
    expect(f2).toHaveLength(1);
  });

  it('does not flag form numbers or dollar prose inside strings/templates', () => {
    const src = 'const step = `1040 line 11 shows the $3,000 cap from 8582`;\nconst s2 = "Schedule 8949 Box E";\n';
    expect(auditFile('packages/kernel/src/__seed__.ts', src)).toHaveLength(0);
  });

  it('does not flag statute citations (§ prefix)', () => {
    expect(auditFile('packages/kernel/src/__seed__.ts', 'throw new Error(`§904(j) election`); // §63\n')).toHaveLength(0);
  });

  it('honours an explicit audit-allow with reason', () => {
    const findings = auditFile(
      'packages/kernel/src/__seed__.ts',
      'const MS_PER_DAY = 86_400_000; // audit-allow: time-unit, not money\n',
    );
    expect(findings).toHaveLength(0);
  });
});
