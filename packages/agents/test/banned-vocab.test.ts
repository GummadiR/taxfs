/**
 * Banned-vocabulary lint (E.5, CI-gated per the session-2 acceptance).
 * (a) unit coverage of the checker; (b) a source scan: no agent source file
 * (banned-vocab.ts itself excluded — it defines the patterns) may contain
 * banned language, so prompts and canned strings stay clean.
 *
 * Personal-use pivot: advice-verbs are ALLOWED now (single-user tool, no
 * UPL exposure); immunity promises / numeric scores / guarantees stay
 * banned — they protect the owner.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBannedVocabulary } from '@taxfs/agents';

describe('banned-vocabulary checker', () => {
  it.each([
    'This return is audit-proof.',
    'This return is audit proof.',
    'Your risk score is low.',
    'We scored 12 items.',
    'Acceptance guaranteed.',
  ])('flags: %s', (text) => {
    expect(checkBannedVocabulary(text).length).toBeGreaterThan(0);
  });

  it.each([
    'This deduction is in the top 5% of your industry classification per public IRS statistics.',
    'A Form 8275 disclosure is available for positions at this level.',
    'Attaching the exact documented amounts resolves this item.',
    'Risk is reduced, never eliminated.',
    // Advice framing — allowed since the personal-use pivot:
    'You should claim the credit.',
    'You must deduct this now.',
    'We recommend taking the deduction.',
  ])('passes: %s', (text) => {
    expect(checkBannedVocabulary(text)).toEqual([]);
  });
});

describe('CI lint: agent sources contain no banned vocabulary', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));

  it('scans packages/agents/src', () => {
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts') && f !== 'banned-vocab.ts');
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      const violations = checkBannedVocabulary(text);
      expect(violations, `${file}: ${JSON.stringify(violations)}`).toEqual([]);
    }
  });
});
