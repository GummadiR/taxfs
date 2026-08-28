/**
 * J.2 acceptance: checksum-before-tokenization (no token for a malformed
 * identifier) and account-closure = retention hold (archive intact, access
 * removed, purge blocked — never a purge).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Clock } from '@taxfs/shared';
import {
  RetentionVault,
  checkEinStructure,
  checkSsnStructure,
  loadSecurityRules,
  tokenizeIdentifier,
} from '@taxfs/compliance';

const rules = loadSecurityRules(
  JSON.parse(readFileSync(fileURLToPath(new URL('../../../rules/fixtures/2025.SECURITY.json', import.meta.url)), 'utf8')),
);
const clock: Clock = { nowIso: () => '2026-07-02T00:00:00.000Z' };

describe('SSN/EIN checksum-before-tokenization (J.2)', () => {
  it('valid structures tokenize; the token never contains the raw identifier', () => {
    const token = tokenizeIdentifier('ssn', '123-45-6789', rules);
    expect(token).toMatch(/^tok_ssn_[0-9a-f]{16}$/);
    expect(token).not.toContain('123');
    expect(token).not.toContain('6789');
    // Deterministic (same input → same token), distinct across values
    expect(tokenizeIdentifier('ssn', '123-45-6789', rules)).toBe(token);
    expect(tokenizeIdentifier('ssn', '223-45-6789', rules)).not.toBe(token);
    expect(tokenizeIdentifier('ein', '12-3456789', rules)).toMatch(/^tok_ein_/);
  });

  it.each([
    ['000-12-3456', 'area 000 is never issued'],
    ['666-12-3456', 'area 666 is never issued'],
    ['900-12-3456', 'exceeds the issued range'],
    ['123-00-3456', 'group 00 is never issued'],
    ['123-45-0000', 'serial 0000 is never issued'],
    ['12345-6789', 'formatted NNN-NN-NNNN'],
  ])('SEEDED DEFECT %s → structure check fails (%s)', (ssn, reasonFragment) => {
    const check = checkSsnStructure(ssn, rules);
    expect(check.valid).toBe(false);
    expect(check.reason).toContain(reasonFragment);
    expect(() => tokenizeIdentifier('ssn', ssn, rules)).toThrow(/refusing to tokenize/);
  });

  it('SEEDED DEFECT: an unassigned EIN prefix never becomes a token', () => {
    expect(checkEinStructure('07-1234567', rules).valid).toBe(false);
    expect(() => tokenizeIdentifier('ein', '07-1234567', rules)).toThrow(/refusing to tokenize/);
    expect(checkEinStructure('12-3456789', rules).valid).toBe(true);
  });
});

describe('account-closure retention hold (J.2)', () => {
  const records = {
    audit_log: [{ seq: 1, action: 'fact.created' }],
    gate_runs: [{ run_id: 'gaterun-0001', result: 'pass' }],
    facts: [{ fact_id: 'f-wages', value: '60000' }],
  };

  it('closure archives intact + revokes access; the hold end is rule-data', () => {
    const vault = new RetentionVault(clock, rules);
    const archived = vault.closeAccount('tp-closed', records);
    expect(archived.access).toBe('revoked');
    expect(archived.hold_until).toBe('2033-07-02'); // +7y PLACEHOLDER
    expect(archived.archive).toEqual(records);
    expect(Object.isFrozen(archived)).toBe(true);
    expect(() => vault.accessRecords('tp-closed')).toThrow(/access revoked/);
  });

  it('a "delete my data" request during the hold is refused and the archive survives', () => {
    const vault = new RetentionVault(clock, rules);
    vault.closeAccount('tp-closed', records);
    const outcome = vault.requestPurge('tp-closed');
    expect(outcome.purged).toBe(false);
    expect(outcome.reason).toContain('retention hold runs until 2033-07-02');
    // The archive is byte-for-byte intact after the "deletion" request
    expect(vault.inspectArchive('tp-closed').archive).toEqual(records);
    expect(vault.refusals()).toHaveLength(1);
    // Nothing purges implicitly even after the hold expires: close in 2026,
    // advance the clock past 2033 — purge is STILL a separate manual workflow.
    let now = '2026-07-02T00:00:00.000Z';
    const advancingClock: Clock = { nowIso: () => now };
    const lateVault = new RetentionVault(advancingClock, rules);
    lateVault.closeAccount('tp-late', records);
    now = '2035-01-01T00:00:00.000Z';
    expect(() => lateVault.requestPurge('tp-late')).toThrow(/deliberate manual workflow/);
  });
});
