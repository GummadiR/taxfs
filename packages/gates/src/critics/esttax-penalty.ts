/**
 * §6654 — the estimated-tax penalty the return can silently omit.
 *
 * Found when the operator's own numbers would not tie to a professionally
 * prepared return: the CPA's 1040 carried a $270 Form 2210 penalty and TaxFS
 * carried none, because nothing ever ASKED. `penalty.fed.estimated_tax` is a
 * pure input, so a return with a real underpayment quietly understates what
 * is owed and no gate says a word. In a tax application every dollar has to
 * be accountable to the IRS; a penalty nobody mentioned is not accountable.
 *
 * What this critic can and cannot do, stated plainly because the difference
 * matters:
 *
 *  - It CAN see that tax minus withholding clears the §6654(e)(1) de-minimis
 *    floor, which is the point at which a penalty becomes possible at all.
 *  - It CANNOT decide whether one is actually owed. The prior-year safe
 *    harbour (§6654(d)(1)(B)) can eliminate it entirely, and prior-year tax
 *    and AGI are not in the gate context.
 *  - It CANNOT compute the amount. That needs the §6621 underpayment
 *    interest rates, published quarterly, and they are NOT in this
 *    repository's rule data — see docs/PLAN_OF_RECORD.md. Inventing a rate
 *    to produce an authoritative-looking penalty is exactly what
 *    non-negotiable #2 forbids.
 *
 * So it does the honest thing: it says a penalty may be owed, says why it
 * cannot finish the sum, and names both ways to resolve it. Gate 5, which
 * warns and never blocks a lawful return.
 */
import { C, Money, type TaxFact } from '@taxfs/shared';
import type { Critic, CriticContext, FindingDraft } from '../critic';

function derived(ctx: CriticContext, concept: string): TaxFact | undefined {
  return ctx.facts.find((f) => f.concept === concept && f.derivation !== undefined);
}

function sourcedTotal(ctx: CriticContext, concept: string): Money {
  return Money.sum(
    ctx.facts
      .filter((f) => f.concept === concept && f.derivation === undefined && f.status === 'confirmed')
      .map((f) => f.value),
  );
}

export const accEstTaxPenaltyUndetermined: Critic = {
  id: 'ACC-EST-PENALTY-UNDETERMINED',
  lens: 'ACCOUNTANT',
  gates: [5],
  jurisdiction: ['FED'],
  // Needs both a computed return and the §6654 de-minimis floor; without
  // either it stays silent rather than guessing.
  applies_when: (ctx) =>
    ctx.esttax_rules !== undefined
    && derived(ctx, C.FED_TAX_AFTER_CREDITS) !== undefined,
  evaluate(ctx) {
    const findings: FindingDraft[] = [];
    const rules = ctx.esttax_rules;
    const totalTax = derived(ctx, C.FED_TAX_AFTER_CREDITS);
    if (!rules || !totalTax) return findings;

    // A penalty already entered is the operator's answer; nothing to say.
    const entered = ctx.facts.some(
      (f) => f.concept === C.FED_EST_TAX_PENALTY && f.derivation === undefined && f.status === 'confirmed',
    );
    if (entered) return findings;

    const withholding = sourcedTotal(ctx, C.FED_WITHHOLDING);
    const balanceDue = Money.max(Money.zero(), totalTax.value.sub(withholding));
    const floor = Money.fromString(rules.de_minimis_balance_due);
    if (balanceDue.lt(floor)) return findings; // §6654(e)(1): no penalty possible

    findings.push({
      critic_id: this.id,
      lens: 'ACCOUNTANT',
      severity: 'Flag',
      affected: [totalTax.fact_id],
      message: `Your tax after credits less federal withholding is ${balanceDue.toString()}, at or above the ${floor.toString()} floor in \u00a76654(e)(1) \u2014 so a Form 2210 underpayment penalty MAY be owed, and this return currently reports none. It is not included in what you owe below. TaxFS cannot settle it here for two reasons, both real: the prior-year safe harbour under \u00a76654(d)(1)(B) can remove the penalty entirely, and your prior-year tax and AGI are not available to the gates; and the amount needs the quarterly \u00a76621 underpayment interest rates, which are not in this release's rule data. Either enter the figure your preparer or software computed (Documents \u2192 Typed entry \u2192 Federal estimated-tax penalty), or leave it blank and let the IRS bill you \u2014 the IRS will compute it and send a notice. What you must not do is assume it is zero.`,
      fix_ref: 'fix://documents/enter-est-tax-penalty',
    });
    return findings;
  },
};

export function createEstTaxPenaltyCritics(): Critic[] {
  return [accEstTaxPenaltyUndetermined];
}
