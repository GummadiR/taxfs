/**
 * P70 — every rule-data block NOT covered by `verified_against` must be named
 * in `_meta.pending_verification`.
 *
 * This exists because a P67 edit that was supposed to add `schedule_a` to that
 * list silently no-op'd (it matched on an escaped "§" while the file holds
 * a literal "§"), and the commit message claimed the flag was in place. The
 * list is the ONLY thing standing between an unsourced figure and a live
 * filing, so "I meant to add it" cannot be the control. This test is.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fed = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../rules/fixtures/2025.FED.1.0.json', import.meta.url)), 'utf8'),
) as { _meta: { verified_against: string; pending_verification: string }; [k: string]: unknown };

/** Blocks carrying figures a signer has NOT yet checked. Add here AND to
 *  _meta.pending_verification when introducing a new unsourced block. */
const UNSOURCED_BLOCKS = [
  'child_dependent_care_credit',
  'early_distribution_additional_tax',
  'foreign_tax_credit_de_minimis',
  'schedule_a',
];

describe('_meta.pending_verification is complete', () => {
  it.each(UNSOURCED_BLOCKS)('names %s', (block) => {
    expect(fed).toHaveProperty(block); // the block really exists in the rule-data
    expect(fed._meta.pending_verification).toContain(block);
  });

  it('spells out that the compliance gate must clear them before live filing', () => {
    expect(fed._meta.pending_verification).toContain('compliance gate');
    expect(fed._meta.pending_verification).toMatch(/signer/);
  });

  it('warns that the SALT cap is year-specific, unlike the other figures', () => {
    // The §21/§72(t)/§904(j) amounts are non-indexed; the SALT cap steps up 1%
    // a year through 2029, so copying this file to another year is a defect.
    expect(fed._meta.pending_verification).toMatch(/SALT cap is NOT/);
  });
});
