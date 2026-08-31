/**
 * A figure that is singular by law, entered twice, is counted twice.
 *
 * The kernel reads every concept with `sumOfConcept`, which ADDS every
 * confirmed fact. That is right for wages (many W-2s) and interest (many
 * 1099-INTs). For a capital-loss carryover it is silently wrong: Schedule D
 * line 6 and line 14 each take ONE figure from the Carryover Worksheet, so a
 * second entry is never a second source — only the same loss subtracted
 * again.
 *
 * Found by tying a real return to a professionally prepared one. Two
 * carryover entries took $42,410 off Schedule D — capital gain read $48,517
 * where the CPA had $89,824 — and cascaded into taxable income, the NIIT and
 * the §904 foreign-tax limitation, understating the balance due by roughly
 * $8,850. Nothing anywhere said a word: the Add Data card looks the value up
 * with `.find()`, so it displayed ONE entry while the kernel summed two.
 *
 * Gate 0 (intake integrity) and Error, so it blocks: a return that counts a
 * loss twice is not merely advisory-wrong, and the operator cannot see the
 * duplicate on any screen that exists today.
 */
import { SINGULAR_CONCEPTS, type TaxFact } from '@taxfs/shared';
import type { Critic, CriticContext, FindingDraft } from '../critic';

/** Confirmed, operator-supplied facts for a concept — what the kernel sums. */
function sourcedFor(ctx: CriticContext, concept: string): TaxFact[] {
  return ctx.facts.filter(
    (f) => f.concept === concept && f.derivation === undefined && f.status === 'confirmed',
  );
}

export const accSingularConceptEnteredTwice: Critic = {
  id: 'ACC-SINGULAR-CONCEPT-DOUBLED',
  lens: 'ACCOUNTANT',
  gates: [0],
  jurisdiction: ['FED'],
  applies_when: (ctx) => SINGULAR_CONCEPTS.some((c) => sourcedFor(ctx, c).length > 1),
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    for (const concept of SINGULAR_CONCEPTS) {
      const dupes = sourcedFor(ctx, concept);
      if (dupes.length < 2) continue;
      const total = dupes.reduce((sum, f) => sum.add(f.value), dupes[0]!.value.sub(dupes[0]!.value));
      const amounts = dupes.map((f) => f.value.toString()).join(' + ');
      findings.push({
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Error',
        affected: dupes.map((f) => f.fact_id),
        message: `${concept} is entered ${dupes.length} times (${amounts}) and the kernel ADDS them, so the return is using ${total.toString()}. This figure is singular — it is one line taken from one worksheet, so a second entry is the same amount counted twice, not a second source. Remove all but one on Documents. Until then every number downstream of it is wrong, including what you owe.`,
        fix_ref: 'fix://documents/remove-duplicate-singular',
      });
    }
    return findings;
  },
};

export function createDuplicateSingularCritics(): Critic[] {
  return [accSingularConceptEnteredTwice];
}
