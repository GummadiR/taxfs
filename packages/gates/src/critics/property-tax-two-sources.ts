/**
 * The same property tax, reported by two different kinds of document.
 *
 * A servicer that escrows prints the year's real-estate taxes on the Form
 * 1098 itself, and the county prints the same money on its bill. Both feed
 * `il.property_tax.residence`, and the kernel reads that concept with
 * `sumOfConcept`, which ADDS every confirmed fact. Upload both and the
 * return claims the tax twice — the federal SALT line and, where it bites
 * hardest, the Illinois Schedule ICR credit at 5% of a doubled figure.
 *
 * Not an Error, because two documents CAN legitimately hold different money:
 * an escrow that covered only part of a year the taxpayer bought or
 * refinanced in, or a second property whose bill is genuinely additional.
 * Two installment receipts from the same county are legitimate too, which is
 * why this fires on a MIX OF DOCUMENT KINDS rather than on a count — a 1098
 * beside a county bill is the case that is usually the same money, and it is
 * invisible on every screen because each row looks correct on its own.
 *
 * Gate 0 (intake integrity): the operator confirms facts before the kernel
 * sums them, so the moment to ask is while both rows are still in front of
 * them on Documents.
 */
import { C, type SourceDoc, type TaxFact } from '@taxfs/shared';
import type { Critic, CriticContext, FindingDraft } from '../critic';

/** Document kinds that can each carry a principal-residence property tax. */
const PROPERTY_TAX_DOC_TYPES = ['1098', 'PROPERTY-TAX-BILL'] as const;

/** Confirmed, operator-supplied property-tax facts — what the kernel sums. */
function propertyTaxFacts(ctx: CriticContext): TaxFact[] {
  return ctx.facts.filter(
    (f) =>
      f.concept === C.IL_PROPERTY_TAX && f.derivation === undefined && f.status === 'confirmed',
  );
}

/** The document a fact came from, when its provenance names one we hold. */
function sourceOf(ctx: CriticContext, fact: TaxFact): SourceDoc | undefined {
  const id = fact.provenance?.[0]?.source_id;
  return id === undefined ? undefined : ctx.sources.find((s) => s.source_id === id);
}

/** Document kinds represented among a set of facts, in a stable order. */
function kindsAmong(ctx: CriticContext, facts: TaxFact[]): string[] {
  const seen = new Set<string>();
  for (const f of facts) {
    const type = sourceOf(ctx, f)?.type;
    if (type !== undefined && (PROPERTY_TAX_DOC_TYPES as readonly string[]).includes(type)) {
      seen.add(type);
    }
  }
  return PROPERTY_TAX_DOC_TYPES.filter((t) => seen.has(t));
}

export const accPropertyTaxFromTwoDocumentKinds: Critic = {
  id: 'ACC-PROPERTY-TAX-TWO-SOURCES',
  lens: 'ACCOUNTANT',
  gates: [0],
  jurisdiction: ['FED', 'IL'],
  applies_when: (ctx) => kindsAmong(ctx, propertyTaxFacts(ctx)).length > 1,
  evaluate(ctx) {
    const facts = propertyTaxFacts(ctx);
    if (kindsAmong(ctx, facts).length < 2) return [];
    const total = facts.reduce((sum, f) => sum.add(f.value), facts[0]!.value.sub(facts[0]!.value));
    const lines = facts
      .map((f) => {
        const src = sourceOf(ctx, f);
        const where = src === undefined ? 'an unnamed source' : `${src.type} ${src.source_id}`;
        return `${f.value.toString()} (from ${where})`;
      })
      .join(' + ');
    return [
      {
        critic_id: this.id,
        lens: 'ACCOUNTANT',
        severity: 'Flag',
        affected: facts.map((f) => f.fact_id),
        message: `Property tax is coming from both a Form 1098 and a property-tax bill, and the kernel ADDS them: ${lines}, so the return is claiming ${total.toString()}. A servicer that escrows prints the year's taxes on the 1098 and the county prints the same money on its bill — if these are the same payment, it is being counted twice, which inflates the Schedule A state-and-local line and the Illinois Schedule ICR credit computed at 5% of it. Open both rows on Documents and check what each covers. Keep both only if they are genuinely different money (a part-year escrow, or a second property); otherwise Remove one.`,
        fix_ref: 'fix://documents/property-tax-two-sources',
      } satisfies FindingDraft,
    ];
  },
};

export function createPropertyTaxSourceCritics(): Critic[] {
  return [accPropertyTaxFromTwoDocumentKinds];
}
