/** P5.3 — Gate 13 transcript matching (post-filing verification). */
import { describe, expect, it } from 'vitest';
import { assessEngagement } from '../src/engagement';
import { matchTranscript } from '../src/transcript';

const filed = {
  'fed.agi': '249287',
  'fed.taxable_income': '219286',
  'fed.tax.liability.total': '38947',
  'fed.withholding.total': '38848',
};

describe('matchTranscript', () => {
  it('line-for-line match → zero mismatches', () => {
    const r = matchTranscript(filed, [
      { concept: 'fed.agi', label: 'ADJUSTED GROSS INCOME', transcript_value: '249287' },
      { concept: 'fed.tax.liability.total', label: 'TAX PER RETURN', transcript_value: '38947' },
    ]);
    expect(r.mismatched).toBe(0);
    expect(r.matched).toBe(2);
    expect(r.rows.every((row) => row.delta === '0')).toBe(true);
  });

  it('a differing line is named with filed vs IRS values and the delta', () => {
    const r = matchTranscript(filed, [
      { concept: 'fed.withholding.total', label: 'FEDERAL INCOME TAX WITHHELD', transcript_value: '38648' },
    ]);
    expect(r.mismatched).toBe(1);
    expect(r.rows[0]).toMatchObject({ package_value: '38848', transcript_value: '38648', delta: '200', match: false });
  });

  it('a transcript line with no package concept is a mismatch, never silently skipped', () => {
    const r = matchTranscript(filed, [
      { concept: 'fed.se_tax.total', label: 'SELF EMPLOYMENT TAX', transcript_value: '1000' },
    ]);
    expect(r.mismatched).toBe(1);
    expect(r.rows[0]!.package_value).toBe('<missing>');
  });
});

describe('gate 13 on the engagement board', () => {
  const base = { computationalRuns: [], scope: null, continuity: null };

  it('pending until a transcript is entered (normal while the IRS processes)', () => {
    const cells = assessEngagement({ ...base, transcript: null });
    expect(cells.find((c) => c.id === 13)!.state).toBe('pending');
  });

  it('passes on a clean match', () => {
    const cells = assessEngagement({
      ...base,
      transcript: matchTranscript(filed, [{ concept: 'fed.agi', label: 'AGI', transcript_value: '249287' }]),
    });
    expect(cells.find((c) => c.id === 13)!.state).toBe('pass');
  });

  it('blocks on a mismatch and names the line', () => {
    const cells = assessEngagement({
      ...base,
      transcript: matchTranscript(filed, [{ concept: 'fed.agi', label: 'AGI', transcript_value: '250000' }]),
    });
    const g13 = cells.find((c) => c.id === 13)!;
    expect(g13.state).toBe('blocked');
    expect(g13.blocking[0]).toMatch(/fed\.agi.*249287.*250000/);
  });

  it('an empty transcript stays pending with a warning (nothing compared ≠ verified)', () => {
    const cells = assessEngagement({ ...base, transcript: matchTranscript(filed, []) });
    const g13 = cells.find((c) => c.id === 13)!;
    expect(g13.state).toBe('pending');
    expect(g13.warnings[0]).toMatch(/zero lines/);
  });
});
