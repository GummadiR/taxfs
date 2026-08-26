/**
 * P98 — the critic layer over the P94–P97 contribution validation. The kernel
 * already computes the limits, excesses, and excises; these critics turn each
 * situation into a Gates-Board finding with the corrective action in plain
 * language, and add the cross-checks no single computation sees:
 *  - any excess (HSA / IRA / deferral / SEP) surfaces as a finding, not just
 *    a number buried in Sch 2;
 *  - HSA contributions with no coverage type entered → the kernel assumed
 *    self-only; say so where the operator will look;
 *  - nondeductible IRA basis exists → Form 8606 must be filed and KEPT;
 *  - the same HSA employer amount arriving twice (a W-2 extraction AND a
 *    manual entry) → possible double count.
 */
import { C, type TaxFact } from '@taxfs/shared';
import type { Critic, CriticContext, FindingDraft } from '../critic';

function sourced(ctx: CriticContext, concept: string): TaxFact[] {
  return ctx.facts.filter((f) => f.concept === concept && f.derivation === undefined && f.status === 'confirmed');
}

function derivedFact(ctx: CriticContext, concept: string): TaxFact | undefined {
  return ctx.facts.find((f) => f.concept === concept && f.derivation !== undefined);
}

/** Every kernel-detected excess becomes a visible finding with its cure. */
export const accContribExcess: Critic = {
  id: 'ACC-CONTRIB-EXCESS',
  lens: 'ACCOUNTANT',
  gates: [5],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const cases = [
      {
        concept: C.FED_HSA_EXCESS,
        what: 'HSA contributions exceed the §223 limit',
        cure: 'have the HSA custodian return the excess (plus its earnings) before the filing deadline — the 6% excise repeats every year it stays in',
      },
      {
        concept: C.FED_IRA_EXCESS,
        what: 'IRA contributions exceed what §219/§408A allow',
        cure: 'withdraw the excess (plus earnings) before the filing deadline, or recharacterize/apply it to next year with the custodian — the 6% excise repeats every year it stays in',
      },
      {
        concept: C.FED_DEFERRAL_EXCESS_INCOME,
        what: 'Elective deferrals exceed the §402(g)/§408(p) limit',
        cure: 'ask the plan administrator to distribute the excess by April 15 — it is already added to income here; left in the plan, the same dollars are taxed AGAIN at distribution',
      },
      {
        concept: C.FED_SEP_EXCESS,
        what: 'The SEP/Solo-401(k) contribution exceeds the deductible limit',
        cure: 'withdraw it before the return due date or apply it to next year — the §4972 10% excise repeats while it stays nondeductible',
      },
    ];
    for (const cse of cases) {
      const d = derivedFact(ctx, cse.concept);
      if (d && !d.value.isZero()) {
        findings.push({
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Error',
          affected: [d.fact_id],
          message: `${cse.what} by ${d.value.toString()}. What to do: ${cse.cure}. The drilldown on this line shows exactly which limit applied and how the excess was computed.`,
          fix_ref: 'fix://contributions/resolve-excess',
        });
      }
    }
    return findings;
  },
};

/** HSA present but coverage type never entered → the conservative assumption
 *  is in force; a family-coverage filer is being under-limited. */
export const accHsaCoverage: Critic = {
  id: 'ACC-HSA-COVERAGE',
  lens: 'ACCOUNTANT',
  gates: [5],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const anyHsa = [...sourced(ctx, C.CONTRIB_HSA_EMPLOYER), ...sourced(ctx, C.CONTRIB_HSA_DIRECT)];
    if (anyHsa.length === 0) return [];
    if (sourced(ctx, C.HSA_FAMILY_COVERAGE).length > 0) return [];
    return [
      {
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: anyHsa.map((f) => f.fact_id),
        message:
          'HSA contributions are entered but the coverage type is not — the SELF-ONLY limit was assumed (the conservative choice). If you had family HDHP coverage, add "HSA: family HDHP coverage" on Documents and re-run gates; the limit nearly doubles.',
        fix_ref: 'fix://documents/enter-hsa-coverage',
      },
    ];
  },
};

/** Nondeductible IRA basis emitted → Form 8606 is REQUIRED with the return. */
export const accIra8606: Critic = {
  id: 'ACC-IRA-8606',
  lens: 'ACCOUNTANT',
  gates: [5],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    for (const concept of [C.FED_IRA_NONDEDUCTIBLE_TP, C.FED_IRA_NONDEDUCTIBLE_SP] as const) {
      const d = derivedFact(ctx, concept);
      if (d && !d.value.isZero()) {
        findings.push({
          critic_id: this.id,
          lens: 'ACCOUNTANT',
          severity: 'Flag',
          affected: [d.fact_id],
          message: `${d.value.toString()} of the Traditional IRA contribution is NONDEDUCTIBLE — Form 8606 must be filed with this return to record the basis, and kept until the money comes out. TaxOS has no official 8606 template yet: file the form manually and keep a copy with the workpapers, or the same dollars get taxed twice at distribution.`,
          fix_ref: 'fix://forms/file-8606',
        });
      }
    }
    return findings;
  },
};

/** The same HSA employer amount arriving from a W-2 extraction AND a manual
 *  entry is very likely the SAME dollars counted twice. */
export const accHsaDupSource: Critic = {
  id: 'ACC-HSA-DUP-SOURCE',
  lens: 'ACCOUNTANT',
  gates: [5],
  jurisdiction: ['FED'],
  applies_when: () => true,
  evaluate(ctx) {
    const employer = sourced(ctx, C.CONTRIB_HSA_EMPLOYER);
    if (employer.length < 2) return [];
    const findings: FindingDraft[] = [];
    // No index arithmetic in critic source (money-safety lint): pair by
    // nested forEach and keep only the upper triangle via index comparison.
    employer.forEach((a, i) => {
      employer.forEach((b, j) => {
        if (j <= i) return;
        if (a.value.eq(b.value) && !a.value.isZero()) {
          findings.push({
            critic_id: this.id,
            lens: 'ACCOUNTANT',
            severity: 'Flag',
            affected: [a.fact_id, b.fact_id],
            message: `Two HSA employer-contribution entries carry the identical amount ${a.value.toString()} — if one came from the W-2 (box 12 code W) and one was typed by hand, the same dollars are counted twice against the limit. Delete one on Documents unless they really are two separate employers.`,
            fix_ref: 'fix://documents/remove-duplicate',
          });
        }
      });
    });
    return findings;
  },
};

export function createP98RetirementCritics(): Critic[] {
  return [accContribExcess, accHsaCoverage, accIra8606, accHsaDupSource];
}
