/**
 * Deterministic demo documents (Phase 4 intake). The extraction agent's
 * LIVE document path (real uploads, scrub, vision) is Phase 7 work per
 * Blueprint §6/§7; until then intake is these fixtures plus manual entry —
 * every value still enters unconfirmed and crosses the SAME confirm door
 * (G8): registerSource → putSourceFact(unconfirmed) → operator confirms.
 * No demo value is a real person's data.
 */
import { C, Money, type Jurisdiction } from '@taxfs/shared';
import type { SpineBackend } from '@taxfs/spine';
import { TAX_YEAR } from './env';

export interface DemoDoc {
  id: string;
  label: string;
  type: string;
  fields: Record<string, string>;
  facts: { concept: string; field: string; jurisdiction: Jurisdiction[] }[];
}

export const DEMO_DOCS: DemoDoc[] = [
  {
    id: 'demo-w2',
    label: 'Demo W-2 (wages 50,000)',
    type: 'W-2',
    // box12w_hsa is captured as a FIELD with no mapped fact: the Discovery
    // card asks about the missing coverage type (§6) without inventing data.
    fields: { box1_wages: '50000', box2_fed_withholding: '4000', box17_il_withholding: '2000', box12w_hsa: '1000' },
    facts: [
      { concept: C.WAGES, field: 'box1_wages', jurisdiction: ['FED', 'IL'] },
      { concept: C.FED_WITHHOLDING, field: 'box2_fed_withholding', jurisdiction: ['FED'] },
      { concept: C.IL_WITHHOLDING, field: 'box17_il_withholding', jurisdiction: ['IL'] },
    ],
  },
  {
    id: 'demo-1099int',
    label: 'Demo 1099-INT (interest 1,200)',
    type: '1099-INT',
    fields: { box1_interest: '1200' },
    facts: [{ concept: C.INTEREST, field: 'box1_interest', jurisdiction: ['FED', 'IL'] }],
  },
];

/** Manual-entry concepts (the P55 rule: every computation has an intake path
 *  — this list grows with the coverage matrix). */
export const MANUAL_CONCEPTS: { concept: string; label: string; jurisdiction: Jurisdiction[] }[] = [
  { concept: C.WAGES, label: 'Wages (W-2 box 1)', jurisdiction: ['FED', 'IL'] },
  { concept: C.INTEREST, label: 'Interest income', jurisdiction: ['FED', 'IL'] },
  { concept: C.DIV_ORDINARY, label: 'Ordinary dividends', jurisdiction: ['FED', 'IL'] },
  { concept: C.DIV_QUALIFIED, label: 'Qualified dividends', jurisdiction: ['FED'] },
  { concept: C.FED_WITHHOLDING, label: 'Federal withholding', jurisdiction: ['FED'] },
  { concept: C.FED_ESTIMATED, label: 'Federal estimated payments', jurisdiction: ['FED'] },
  { concept: C.IL_WITHHOLDING, label: 'IL withholding', jurisdiction: ['IL'] },
  { concept: C.IL_ESTIMATED, label: 'IL estimated payments', jurisdiction: ['IL'] },
];

export async function addDemoDoc(spine: SpineBackend, ws: string, doc: DemoDoc): Promise<void> {
  const source_id = `${doc.id}-${Date.now().toString(36)}`;
  await spine.registerSource({
    source_id,
    taxpayer_id: ws,
    type: doc.type as never,
    tax_year: TAX_YEAR,
    fields: doc.fields,
    ocr_confidence: 0.98,
    raw_ref: `demo://${doc.id}`,
  });
  for (const f of doc.facts) {
    await spine.putSourceFact({
      fact_id: `f:${source_id}:${f.field}`,
      taxpayer_id: ws,
      concept: f.concept,
      tax_year: TAX_YEAR,
      jurisdiction: f.jurisdiction,
      taxpayer_scope: 'primary',
      value: Money.fromString(doc.fields[f.field]!),
      confidence: 0.98,
      provenance: [{ source_id, source_field: f.field }],
    });
  }
}

export async function addManualEntry(
  spine: SpineBackend,
  ws: string,
  concept: string,
  amount: string,
): Promise<void> {
  const def = MANUAL_CONCEPTS.find((c) => c.concept === concept);
  if (!def) throw new Error(`manual entry for ${concept} is not an offered intake path`);
  const source_id = `manual-${concept.replaceAll('.', '-')}-${Date.now().toString(36)}`;
  await spine.registerSource({
    source_id,
    taxpayer_id: ws,
    type: 'USER_ENTRY' as never,
    tax_year: TAX_YEAR,
    fields: { amount },
    ocr_confidence: 1,
    raw_ref: `manual://${source_id}`,
  });
  // Typed by the operator — the entry IS the confirmation (E.6).
  await spine.putSourceFact({
    fact_id: `f:${source_id}:amount`,
    taxpayer_id: ws,
    concept,
    tax_year: TAX_YEAR,
    jurisdiction: def.jurisdiction,
    taxpayer_scope: 'primary',
    value: Money.fromString(amount),
    confidence: 1,
    provenance: [{ source_id, source_field: 'amount' }],
    confirmed: true,
  });
  await spine.confirmSource(source_id);
}
