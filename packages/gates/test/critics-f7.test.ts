/**
 * Fires-when-should + silent-when-shouldn't pairs for the five remaining
 * F.7 critics (Session-2 Goal 2.5).
 */
import { describe, expect, it } from 'vitest';
import { Money, type RuleSet, type TaxFact } from '@taxfs/shared';
import {
  accCarryFwd,
  accCreditFinder,
  accEvidSufficiency,
  accFilingStatus,
  irsAuthority,
} from '@taxfs/gates';
import { buildCtx, fedRules } from './helpers.js';

function extraFact(fact_id: string, concept: string, value: string): TaxFact {
  return {
    fact_id,
    taxpayer_id: 'tp-golden',
    concept,
    tax_year: 2025,
    jurisdiction: ['FED'],
    taxpayer_scope: 'primary',
    value: Money.fromString(value),
    unit: 'USD',
    status: 'confirmed',
    confidence: 1,
    provenance: [{ source_id: 's:user-entry', source_field: 'value' }],
  };
}

describe('IRS-AUTHORITY (light, gates 2/5)', () => {
  it('silent when claimed positions carry substantial authority', () => {
    // return3 claims credits.sch3.total, graded substantial_authority in the fixture.
    const ctx = buildCtx('return3-mfj-multidoc');
    expect(irsAuthority.applies_when(ctx)).toBe(true);
    expect(irsAuthority.evaluate(ctx)).toEqual([]);
  });

  it('fires Audit-Risk + form_8275_required on a weak-or-none position', () => {
    const weakRules: RuleSet = {
      ...fedRules,
      authority: { 'credits.sch3.total': 'weak_or_none' },
    };
    const ctx = buildCtx('return3-mfj-multidoc', { fedRulesOverride: weakRules });
    const findings = irsAuthority.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Audit-Risk');
    expect(findings[0]?.authority_grade).toBe('weak_or_none');
    expect(findings[0]?.form_8275_required).toBe(true);
  });

  it('reasonable-basis position fires with the 8275 path optional', () => {
    const rbRules: RuleSet = {
      ...fedRules,
      authority: { 'credits.sch3.total': 'reasonable_basis' },
    };
    const findings = irsAuthority.evaluate(buildCtx('return3-mfj-multidoc', { fedRulesOverride: rbRules }));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.form_8275_required).toBe(false);
  });

  it('does not apply when the rule set has no authority records', () => {
    const rest: RuleSet = { ...fedRules };
    delete rest.authority;
    const ctx = buildCtx('return3-mfj-multidoc', { fedRulesOverride: rest });
    expect(irsAuthority.applies_when(ctx)).toBe(false);
  });
});

describe('ACC-FILINGSTATUS (gate 2)', () => {
  it('silent for single and MFJ', () => {
    expect(accFilingStatus.evaluate(buildCtx('return1-single-w2'))).toEqual([]);
    expect(accFilingStatus.evaluate(buildCtx('return3-mfj-multidoc'))).toEqual([]);
  });

  it('fires Optimization for MFS', () => {
    const ctx = buildCtx('return1-single-w2');
    const findings = accFilingStatus.evaluate({
      ...ctx,
      filing: { ...ctx.filing, filing_status: 'mfs' },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Optimization');
  });

  it('fires Flag for HoH with no qualifying person in the profile', () => {
    const ctx = buildCtx('return1-single-w2');
    const findings = accFilingStatus.evaluate({
      ...ctx,
      filing: { ...ctx.filing, filing_status: 'hoh', il_exemption_count: 1 },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Flag');
  });
});

describe('ACC-CARRYFWD (gate 2)', () => {
  it('silent when no carryforwards exist', () => {
    expect(accCarryFwd.evaluate(buildCtx('return1-single-w2'))).toEqual([]);
  });

  it('fires Error when a prior-year carryforward is present but dropped', () => {
    const ctx = buildCtx('return1-single-w2', {
      extraFacts: [extraFact('f:prior:caploss', 'carryforward.capital_loss', '2500')],
    });
    const findings = accCarryFwd.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Error');
    expect(findings[0]?.message).toMatch(/NOT applied/);
  });
});

describe('ACC-EVID-SUFFICIENCY (gates 2/5)', () => {
  it('silent when nothing itemized is claimed', () => {
    expect(accEvidSufficiency.evaluate(buildCtx('return1-single-w2'))).toEqual([]);
  });

  it('fires Error with irc_substantiation_met=false when undocumented itemized drives the deduction', () => {
    // itemized 18000 > standard 15000 → drives the applied deduction.
    const ctx = buildCtx('return1-single-w2', {
      extraFacts: [extraFact('f:user:itemized', 'deduction.itemized.total', '18000')],
    });
    const findings = accEvidSufficiency.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Error');
    expect(findings[0]?.irc_substantiation_met).toBe(false);
  });

  it('fires Flag (not Error) when the undocumented itemized total loses to the standard deduction', () => {
    const ctx = buildCtx('return1-single-w2', {
      extraFacts: [extraFact('f:user:itemized', 'deduction.itemized.total', '4000')],
    });
    const findings = accEvidSufficiency.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Flag');
  });
});

describe('ACC-CREDIT-FINDER (gate 5)', () => {
  it('silent when AGI exceeds the rule-data ceiling', () => {
    expect(accCreditFinder.evaluate(buildCtx('return1-single-w2', { gate: 5 }))).toEqual([]);
  });

  it('silent when credits are already claimed', () => {
    const ctx = buildCtx('return3-mfj-multidoc', { gate: 5 });
    expect(accCreditFinder.evaluate(ctx)).toEqual([]);
  });

  it('fires Optimization for low AGI with wages and no credits claimed', () => {
    const ctx = buildCtx('return1-single-w2', {
      gate: 5,
      factOverrides: { 'f:w2-1:wages': '30000' },
    });
    const findings = accCreditFinder.evaluate(ctx);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('Optimization');
    expect(findings[0]?.message).toMatch(/Saver/);
  });
});
