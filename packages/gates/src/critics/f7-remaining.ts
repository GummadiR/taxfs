/**
 * The five remaining F.7 critics (Session-2 Goal 2.5). Pure registration —
 * no engine change. All light/step-1 versions per the skeleton catalog;
 * every threshold or grade comes from rule-data (PLACEHOLDER — verify).
 * Money math is Money-only — native arithmetic is lint-banned here.
 */
import { C, Money, type TaxFact } from '@taxfs/shared';
import type { Critic, CriticContext, FindingDraft } from '../critic';

function sourced(ctx: CriticContext, concept: string): TaxFact[] {
  return ctx.facts.filter(
    (f) => f.concept === concept && f.derivation === undefined && f.status === 'confirmed',
  );
}

function derivedFact(ctx: CriticContext, concept: string): TaxFact | undefined {
  return ctx.facts.find((f) => f.concept === concept && f.derivation !== undefined);
}

/**
 * IRS-AUTHORITY (light, gates 2/5): grades each claimed position via the
 * rule store's authority tier (§7 second axis). Weak-or-none ⇒ Form 8275
 * disclosure decision required; reasonable-basis ⇒ Audit-Risk with the
 * disclosure path optional. Full grading arrives with workstream B
 * authority records.
 */
export const irsAuthority: Critic = {
  id: 'IRS-AUTHORITY',
  lens: 'IRS',
  gates: [2, 5],
  jurisdiction: ['FED'],
  applies_when: (ctx) => ctx.fed_rules.authority !== undefined,
  evaluate(ctx) {
    const grades = ctx.fed_rules.authority ?? {};
    const findings: FindingDraft[] = [];
    for (const [concept, grade] of Object.entries(grades)) {
      const claimed = sourced(ctx, concept);
      if (claimed.length === 0) continue;
      if (Money.sum(claimed.map((f) => f.value)).isZero()) continue;
      if (grade === 'substantial_authority' || grade === 'more_likely_than_not') continue;
      const weak = grade === 'weak_or_none';
      findings.push({
        critic_id: this.id,
        lens: 'IRS',
        severity: 'Audit-Risk',
        authority_grade: grade,
        form_8275_required: weak,
        affected: claimed.map((f) => f.fact_id),
        message: weak
          ? `Position ${concept} is graded weak-or-none: §6662 exposure — disclose (Form 8275), change the position, or document why you proceed (this authority grading is preliminary in this release)`
          : `Position ${concept} is graded reasonable-basis: supportable but below substantial authority; Form 8275 disclosure available (this authority grading is preliminary in this release)`,
        fix_ref: 'fix://authority/review-position',
        defense_artifact_ref: 'defense://position-memo',
      });
    }
    return findings;
  },
};

/**
 * ACC-FILINGSTATUS (gate 2): MFJ-vs-MFS / HoH eligibility heuristics.
 * Light: a real comparison engine needs both-spouse computation (step 2+).
 */
export const accFilingStatus: Critic = {
  id: 'ACC-FILINGSTATUS',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    if (ctx.filing.filing_status === 'mfs') {
      findings.push({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Optimization',
        affected: ['filing_status'],
        message:
          'Filing status married-filing-separately: filing jointly usually yields lower combined tax — worth confirming the reason for separate filing (a rough screen, not a full comparison)',
        fix_ref: 'fix://filing-status/compare-mfj',
      });
    }
    if (ctx.filing.filing_status === 'hoh' && ctx.filing.il_exemption_count < 2) {
      findings.push({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: ['filing_status'],
        message:
          'Filing status head-of-household requires a qualifying person, and the household profile shows none — confirm eligibility on Get Started (a rough screen, not a full test)',
        fix_ref: 'fix://filing-status/verify-hoh',
      });
    }
    return findings;
  },
};

/**
 * ACC-CARRYFWD (gate 2): prior-year carryforwards applied. The step-1
 * kernel does not consume carryforwards (Cap 22 lands later), so ANY
 * confirmed carryforward.* fact is by definition dropped ⇒ Error.
 */
export const accCarryFwd: Critic = {
  id: 'ACC-CARRYFWD',
  lens: 'ACCOUNTANT',
  gates: [2],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    return ctx.facts
      .filter(
        (f) =>
          f.derivation === undefined &&
          f.status === 'confirmed' &&
          f.concept.startsWith('carryforward.') &&
          !f.value.isZero(),
      )
      .map((f): FindingDraft => ({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Error',
        affected: [f.fact_id],
        message: `A prior-year carryforward entry (${f.concept}, ${f.value.toString()}) is in an old format TaxOS no longer applies — it is NOT applied, which overstates your tax. Re-enter it on the Add Data carryover worksheet (capital losses) or Manual entry (QBI loss), then delete this old entry`,
        fix_ref: 'fix://carryforward/apply-or-defer',
      }));
  },
};

/**
 * ACC-EVID-SUFFICIENCY (gates 2/5): evidence must be STATUTORILY
 * sufficient, not merely present — §170 acknowledgment/appraisal for
 * charitable, §274(d) contemporaneous records `(verify)`. Step-1 light
 * check: an itemized-deduction total backed only by user entry (no
 * underlying document) is insufficient; Error when it drives the applied
 * deduction, Flag otherwise. Sets irc_substantiation_met=false.
 */
export const accEvidSufficiency: Critic = {
  id: 'ACC-EVID-SUFFICIENCY',
  lens: 'ACCOUNTANT',
  gates: [2, 5],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const itemized = sourced(ctx, C.ITEMIZED).filter((f) => !f.value.isZero());
    if (itemized.length === 0) return [];
    const findings: FindingDraft[] = [];
    for (const f of itemized) {
      const documented = (f.provenance ?? []).some((p) => {
        const src = ctx.sources.find((s) => s.source_id === p.source_id);
        return src !== undefined && src.type !== 'USER_ENTRY';
      });
      if (documented) continue;
      const applied = derivedFact(ctx, C.FED_DEDUCTION);
      const std = derivedFact(ctx, C.FED_STD_DEDUCTION);
      const drivesDeduction =
        applied !== undefined && std !== undefined && applied.value.gt(std.value);
      findings.push({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: drivesDeduction ? 'Error' : 'Flag',
        irc_substantiation_met: false,
        affected: [f.fact_id],
        message: `Itemized deduction ${f.value.toString()} rests on user entry with no underlying documentation — donations and similar items need qualifying records (receipts, acknowledgment letters) to survive an exam (§170/§274(d))`,
        fix_ref: 'fix://evidence/attach-qualifying-records',
        defense_artifact_ref: 'defense://substantiation-index',
      });
    }
    return findings;
  },
};

/**
 * ACC-CREDIT-FINDER (gate 5, informational): eligible-but-unclaimed
 * credits. Step-1 light rule from rule-data: wages present, AGI at or
 * under the (PLACEHOLDER) Saver's-Credit ceiling, and no credits claimed.
 */
export const accCreditFinder: Critic = {
  id: 'ACC-CREDIT-FINDER',
  lens: 'ACCOUNTANT',
  gates: [5],
  jurisdiction: ['FED'],
  applies_when: (ctx) => ctx.fed_rules.credit_finder !== undefined,
  evaluate(ctx) {
    const finder = ctx.fed_rules.credit_finder;
    const agi = derivedFact(ctx, C.FED_AGI);
    if (!finder || !agi) return [];
    if (sourced(ctx, C.WAGES).length === 0) return [];
    if (sourced(ctx, C.CREDITS_SCH3).some((f) => !f.value.isZero())) return [];
    if (agi.value.gt(Money.fromString(finder.saver_credit_agi_max))) return [];
    return [
      {
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Optimization',
        affected: [agi.fact_id],
        message: `AGI ${agi.value.toString()} is within the Saver's-Credit ceiling (${finder.saver_credit_agi_max} — a preliminary threshold in this release) and no credits are claimed — possible eligible-but-unclaimed credit`,
        fix_ref: 'fix://credits/review-savers-credit',
      },
    ];
  },
};

export function createF7RemainingCritics(): Critic[] {
  return [irsAuthority, accFilingStatus, accCarryFwd, accEvidSufficiency, accCreditFinder];
}
