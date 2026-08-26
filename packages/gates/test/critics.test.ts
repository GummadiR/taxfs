/**
 * Critic fixture suites: every step-1 critic has a fires-when-should and a
 * silent-when-shouldn't case (kickoff acceptance).
 */
import { describe, expect, it } from 'vitest';
import { C, Money } from '@taxfs/shared';
import {
  accDocComplete,
  accDupDoc,
  accIlSubtract,
  accMethod,
  accSanity,
  accStdVsItem,
  accTieoutForm,
  accWithholdRecon,
  irsDocMatch,
  irsIncomeRecon,
  irsRoundNum,
} from '@taxfs/gates';
import { buildCtx } from './helpers.js';

describe('IRS-INCOME-RECON (gate 2, mock transcript)', () => {
  it('silent when every income fact reconciles to the transcript', () => {
    const ctx = buildCtx('return2-w2-1099int');
    expect(irsIncomeRecon.applies_when(ctx)).toBe(true);
    expect(irsIncomeRecon.evaluate(ctx)).toEqual([]);
  });

  it('fires Error for on-transcript-but-not-on-return (omitted income)', () => {
    const ctx = buildCtx('return2-w2-1099int');
    const records = JSON.parse(
      ctx.sources.find((s) => s.type === 'IRS_WI_TRANSCRIPT')!.fields['records']!,
    ) as unknown[];
    records.push({ form: '1099-INT', payer: 'Second Bank', concept: 'income.interest', amount: '350' });
    const ctx2 = buildCtx('return2-w2-1099int', { transcript: records as never });
    const findings = irsIncomeRecon.evaluate(ctx2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Error');
    expect(findings[0]?.message).toMatch(/omitted income/);
  });

  it('fires Flag for on-return-but-not-on-transcript', () => {
    const ctx = buildCtx('return2-w2-1099int');
    const records = (JSON.parse(
      ctx.sources.find((s) => s.type === 'IRS_WI_TRANSCRIPT')!.fields['records']!,
    ) as { concept: string }[]).filter((r) => r.concept !== 'income.interest');
    const ctx2 = buildCtx('return2-w2-1099int', { transcript: records as never });
    const findings = irsIncomeRecon.evaluate(ctx2);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Flag');
  });

  it('does not apply without a transcript (partial-reconciliation path is explicit)', () => {
    const ctx = buildCtx('return2-w2-1099int', { dropTranscript: true });
    expect(irsIncomeRecon.applies_when(ctx)).toBe(false);
  });
});

describe('IRS-DOC-MATCH (gate 2)', () => {
  it('silent when every third-party fact is backed by its form', () => {
    expect(irsDocMatch.evaluate(buildCtx('return3-mfj-multidoc'))).toEqual([]);
  });

  it('fires Flag when a wages fact is not backed by a W-2', () => {
    const ctx = buildCtx('return2-w2-1099int');
    const sources = ctx.sources.map((s) =>
      s.source_id === 's:f:w2-1:wages' ? { ...s, type: 'USER_ENTRY' as const } : s,
    );
    const findings = irsDocMatch.evaluate({ ...ctx, sources });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Flag');
    expect(findings[0]?.message).toMatch(/W-2/);
  });
});

describe('IRS-ROUNDNUM (gate 5)', () => {
  it('silent below the round-number threshold', () => {
    const ctx = buildCtx('return2-w2-1099int', { gate: 5 });
    expect(irsRoundNum.evaluate(ctx)).toEqual([]);
  });

  it('fires Audit-Risk when enough source amounts are round multiples', () => {
    const ctx = buildCtx('return3-mfj-multidoc', { gate: 5 });
    const findings = irsRoundNum.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Audit-Risk');
  });
});

describe('ACC-DOC-COMPLETE (gate 2)', () => {
  it('silent when every document produced a fact', () => {
    expect(accDocComplete.evaluate(buildCtx('return1-single-w2'))).toEqual([]);
  });

  it('fires Error for a document with no extracted fact', () => {
    const ctx = buildCtx('return1-single-w2', {
      extraSources: [
        {
          source_id: 's:orphan-1099int',
          taxpayer_id: 'tp-golden',
          type: '1099-INT',
          tax_year: 2025,
          fields: { box1: '425' },
          ocr_confidence: 0.9,
          raw_ref: 'blob://orphan',
          review_status: 'confirmed',
        },
      ],
    });
    const findings = accDocComplete.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Error');
    expect(findings[0]?.affected).toEqual(['s:orphan-1099int']);
  });
});

describe('ACC-STD-VS-ITEM (gate 2)', () => {
  it('silent when the greater deduction was applied', () => {
    expect(accStdVsItem.evaluate(buildCtx('return1-single-w2'))).toEqual([]);
  });

  it('fires Optimization when the applied deduction is not the greater-of', () => {
    const ctx = buildCtx('return1-single-w2', { tamper: { [C.FED_DEDUCTION]: '10000' } });
    const findings = accStdVsItem.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Optimization');
  });
});

describe('ACC-WITHHOLD-RECON (gates 2/4)', () => {
  it('gate 2: silent when withholding facts match their documents', () => {
    expect(accWithholdRecon.evaluate(buildCtx('return1-single-w2', { gate: 2 }))).toEqual([]);
  });

  it('gate 2: fires Error when a withholding fact disagrees with its document field', () => {
    const ctx = buildCtx('return1-single-w2', { gate: 2 });
    const sources = ctx.sources.map((s) =>
      s.source_id === 's:f:w2-1:fedwh' ? { ...s, fields: { value: '6500' } } : s,
    );
    const findings = accWithholdRecon.evaluate({ ...ctx, sources });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Error');
  });

  it('gate 4: silent when the derived payments total reconciles', () => {
    expect(accWithholdRecon.evaluate(buildCtx('return1-single-w2', { gate: 4 }))).toEqual([]);
  });

  it('gate 4: fires Error when the derived payments total drifts from documents', () => {
    const ctx = buildCtx('return1-single-w2', { gate: 4, tamper: { [C.FED_PAYMENTS]: '9999' } });
    const findings = accWithholdRecon.evaluate(ctx);
    expect(findings.some((f) => f.severity === 'Error')).toBe(true);
  });
});

describe('ACC-TIEOUT-FORM (gate 4) — catches the seeded wrong-line mapping', () => {
  it('silent on a clean computed return', () => {
    expect(accTieoutForm.evaluate(buildCtx('return2-w2-1099int', { gate: 4 }))).toEqual([]);
    expect(
      accTieoutForm.evaluate(buildCtx('return3-mfj-multidoc', { gate: 4, jurisdiction: 'IL' })),
    ).toEqual([]);
  });

  it('SEEDED DEFECT: interest dropped from total income (wrong-line mapping) → Error', () => {
    // return2 total income should be 51200 (50000 wages + 1200 interest);
    // a wrong-line mapping that drops interest yields 50000.
    const ctx = buildCtx('return2-w2-1099int', { gate: 4, tamper: { [C.FED_TOTAL_INCOME]: '50000' } });
    const findings = accTieoutForm.evaluate(ctx);
    expect(findings.some((f) => f.severity === 'Error' && f.message.includes('fed.total_income'))).toBe(true);
  });

  it('IL: fires Error when base income does not tie to fed AGI − Sch M', () => {
    const ctx = buildCtx('return3-mfj-multidoc', {
      gate: 4,
      jurisdiction: 'IL',
      tamper: { [C.IL_BASE_INCOME]: '142800' }, // forgot to subtract retirement
    });
    const findings = accTieoutForm.evaluate(ctx);
    expect(findings.some((f) => f.severity === 'Error' && f.message.includes('il.base_income'))).toBe(true);
  });
});

describe('ACC-METHOD (gate 4)', () => {
  it('silent on a method-correct return', () => {
    expect(accMethod.evaluate(buildCtx('return1-single-w2', { gate: 4 }))).toEqual([]);
  });

  it('fires Error on a non-whole-dollar line (rounding convention violated)', () => {
    const ctx = buildCtx('return1-single-w2', { gate: 4, tamper: { [C.FED_TAX_ORDINARY]: '5700.25' } });
    const findings = accMethod.evaluate(ctx);
    expect(findings.some((f) => f.message.includes('whole-dollar'))).toBe(true);
    expect(findings.some((f) => f.message.includes('does not reproduce'))).toBe(true);
  });
});

describe('ACC-SANITY (gate 4)', () => {
  it('silent on a plausible return', () => {
    expect(accSanity.evaluate(buildCtx('return1-single-w2', { gate: 4 }))).toEqual([]);
    expect(accSanity.evaluate(buildCtx('return1-single-w2', { gate: 4, jurisdiction: 'IL' }))).toEqual([]);
  });

  it('fires Flag when the effective rate leaves the sanity band', () => {
    const ctx = buildCtx('return1-single-w2', { gate: 4, tamper: { [C.FED_TAX]: '40000' } });
    const findings = accSanity.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Flag');
    expect(findings[0]?.message).toMatch(/Effective rate/);
  });

  it('F5 regression: fires Flag when qualified dividends exceed ordinary dividends', () => {
    const ctx = buildCtx('return3-mfj-multidoc', {
      gate: 4,
      extraFacts: [
        {
          fact_id: 'f:div-2:qualified',
          taxpayer_id: 'tp-golden',
          concept: C.DIV_QUALIFIED,
          tax_year: 2025,
          jurisdiction: ['FED'],
          taxpayer_scope: 'primary',
          value: Money.fromString('3000'), // 1500 + 3000 = 4500 > ordinary 2000
          unit: 'USD',
          status: 'confirmed',
          confidence: 1,
          provenance: [{ source_id: 's:f:div-2:qualified', source_field: 'value' }],
        },
      ],
    });
    const findings = accSanity.evaluate(ctx);
    expect(findings.some((f) => f.severity === 'Flag' && f.message.includes('box 1b'))).toBe(true);
  });
});

describe('ACC-IL-SUBTRACT (gates 2/4, IL)', () => {
  it('silent when SS/retirement are correctly subtracted on Sch M', () => {
    expect(
      accIlSubtract.evaluate(buildCtx('return3-mfj-multidoc', { gate: 4, jurisdiction: 'IL' })),
    ).toEqual([]);
  });

  it('fires Error when eligible retirement income is NOT subtracted (IL over-taxes)', () => {
    const ctx = buildCtx('return3-mfj-multidoc', {
      gate: 4,
      jurisdiction: 'IL',
      tamper: { [C.IL_SUBTRACTIONS]: '0' },
    });
    const findings = accIlSubtract.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Error');
    expect(findings[0]?.message).toMatch(/miss eligible/);
  });

  it('fires Error on an unsupported (excess) subtraction', () => {
    const ctx = buildCtx('return3-mfj-multidoc', {
      gate: 4,
      jurisdiction: 'IL',
      tamper: { [C.IL_SUBTRACTIONS]: '25000' },
    });
    const findings = accIlSubtract.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.message).toMatch(/exceed/);
  });
});

describe('ACC-DUP-DOC (gate 2, probable duplicate uploads)', () => {
  it('silent when every amount is reported by one document', () => {
    const ctx = buildCtx('return2-w2-1099int');
    expect(accDupDoc.evaluate(ctx)).toEqual([]);
  });

  it('Flags two same-type documents reporting the IDENTICAL amount (never blocks)', () => {
    const ctx = buildCtx('return2-w2-1099int');
    const orig = ctx.facts.find((f) => f.derivation === undefined && f.concept === C.INTEREST)!;
    const srcOfOrig = ctx.sources.find((s) => s.source_id === orig.provenance![0]!.source_id)!;
    const clone = {
      ...orig,
      fact_id: 'f:dup:interest',
      provenance: [{ source_id: 's:dup-upload', source_field: 'box1_interest' }],
    };
    const sources = [...ctx.sources, { ...srcOfOrig, source_id: 's:dup-upload' }];
    const findings = accDupDoc.evaluate({ ...ctx, facts: [...ctx.facts, clone], sources });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.severity).toBe('Flag');
    expect(findings[0]!.message).toContain('IDENTICAL');
    expect(findings[0]!.message).toContain('s:dup-upload');
  });

  it('silent when the identical amount comes from documents of DIFFERENT types', () => {
    const ctx = buildCtx('return2-w2-1099int');
    const orig = ctx.facts.find((f) => f.derivation === undefined && f.concept === C.INTEREST)!;
    const clone = {
      ...orig,
      fact_id: 'f:dup:interest',
      provenance: [{ source_id: 's:k1-doc', source_field: 'other' }],
    };
    const srcOfOrig = ctx.sources.find((s) => s.source_id === orig.provenance![0]!.source_id)!;
    const sources = [...ctx.sources, { ...srcOfOrig, source_id: 's:k1-doc', type: 'K-1' as const }];
    expect(accDupDoc.evaluate({ ...ctx, facts: [...ctx.facts, clone], sources })).toEqual([]);
  });
});
