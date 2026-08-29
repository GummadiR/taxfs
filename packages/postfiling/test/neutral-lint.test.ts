/**
 * Acceptance: neutral-template lint in CI — no advocacy language in the
 * templates fixture, the package source, or template output. Records and
 * rule-store citations only (I.3/I.7, K boundary).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNeutralLanguage, fillTemplate } from '@taxfs/postfiling';
import { pfRules } from './helpers';

describe('neutral-language checker', () => {
  it.each([
    'We contend the assessment is baseless.',
    'The IRS is wrong about this item.',
    'Clearly the taxpayer is entitled to the deduction.',
    'You must agree the records are erroneous.',
  ])('flags advocacy: %s', (text) => {
    expect(checkNeutralLanguage(text).length).toBeGreaterThan(0);
  });

  it.each([
    'The attached records show interest income of $1,000 as reported on the filed return.',
    'Exhibit EX-02 contains the reconciliation report for the item in question.',
    'This amended return is filed solely to incorporate a corrected 1099-INT.',
  ])('passes factual record language: %s', (text) => {
    expect(checkNeutralLanguage(text)).toEqual([]);
  });

  it('fillTemplate refuses output that becomes advocacy through slot content', () => {
    const template = pfRules.amendment_templates.find((t) => t.reason === 'user_correction')!;
    expect(() =>
      fillTemplate(template.text, { concept_summary: 'the clearly erroneous IRS figure', delta: '42' }),
    ).toThrow(/neutral-language/);
  });
});

describe('CI lint: templates fixture and package source are advocacy-free', () => {
  it('every pre-approved template is neutral (with slots filled factually)', () => {
    for (const t of pfRules.amendment_templates) {
      const filled = fillTemplate(t.text, {
        doc: 'a corrected 1099-INT',
        concept_summary: 'interest income',
        delta: '42',
        notice_ref: 'CP2000 dated 2026-05-15',
        rule_ref: '2025.FED.0.0.2',
      });
      expect(checkNeutralLanguage(filled), t.template_id).toEqual([]);
    }
    expect(checkNeutralLanguage(pfRules.agree_alert_template.replace('{summary}', 'x').replace('{delta}', '1'))).toEqual([]);
    expect(checkNeutralLanguage(pfRules.il_sync_alert_template)).toEqual([]);
  });

  it('package source contains no advocacy phrasing (outside the banned-pattern definitions)', () => {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    for (const file of readdirSync(srcDir).filter((f) => f.endsWith('.ts') && f !== 'rules.ts')) {
      const text = readFileSync(join(srcDir, file), 'utf8');
      expect(checkNeutralLanguage(text), file).toEqual([]);
    }
  });
});
