/**
 * Lineage DTO — ported from TaxOS (P42/P77), which built the shape the
 * drawer reads. Everything the reader sees is decided HERE, on the server:
 * human labels, plain-English explanations, real document titles, whether
 * the parts literally add up, and the unit (a foreign amount or an exchange
 * rate must never wear a $). The client only draws it.
 */
import type { LineageNode } from '@taxfs/spine';
import type { SourceDoc, TaxFact } from '@taxfs/shared';
import type { OriginBadge } from '@/components/badges';
import { conceptLabel, docTitle, LINE_EXPLAIN } from './labels';

export interface LineageDto {
  concept: string;
  label: string;
  explain?: string;
  /** True when the value is exactly the signed sum of its inputs, so the
   *  drawer can render a literal "adds up to" ledger; false for brackets,
   *  percentages, mins/maxes etc. where the inputs feed a formula. */
  adds_up: boolean;
  value: string;
  origin: OriginBadge;
  formula_ref?: string;
  steps?: string[];
  /** Sources carry their display TITLE; the drawer never shows a raw id. */
  sources?: { source_id: string; type: string; title: string }[];
  /** Absent = US dollars. 'foreign' = an amount in the foreign currency;
   *  'rate' = foreign units per US dollar. The client must not render $. */
  unit?: 'foreign' | 'rate';
  children: LineageDto[];
}

/** Ported verbatim from TaxOS: one provenance vocabulary everywhere. */
export function originOf(fact: TaxFact, sourceTypeById: Map<string, string>): OriginBadge {
  if (fact.derivation !== undefined) return 'calculated';
  const first = fact.provenance?.[0];
  const type = first ? sourceTypeById.get(first.source_id) : undefined;
  if (type === 'IRS_WI_TRANSCRIPT') return 'imported';
  if (type === 'USER_ENTRY') return first?.source_field === 'attestation' ? 'wizard' : 'manual';
  if (type) return 'scanned';
  return 'manual';
}

const FX_RATE_CONCEPT = 'foreign.fx.units_per_usd';

export function toLineageDto(node: LineageNode, sources: readonly SourceDoc[]): LineageDto {
  const typeById = new Map(sources.map((s) => [s.source_id, s.type as string]));
  const byId = new Map(sources.map((s) => [s.source_id, s]));

  const build = (n: LineageNode): LineageDto => {
    const children = (n.inputs ?? []).map(build);
    // Does the value literally equal the signed sum of its inputs? If so the
    // drawer shows a real "adds up" ledger; if not, a formula fed by them.
    const childSum = children.reduce((acc, c) => acc + Number(c.value), 0);
    const addsUp = children.length > 0 && Math.round(childSum) === Math.round(Number(n.fact.value.toString()));
    const dto: LineageDto = {
      concept: n.fact.concept,
      label: conceptLabel(n.fact.concept),
      adds_up: addsUp,
      value: n.fact.value.toString(),
      origin: originOf(n.fact, typeById),
      children,
    };
    const explain = LINE_EXPLAIN[n.fact.concept];
    if (explain) dto.explain = explain;
    if (n.fact.concept.endsWith('.foreign_currency')) dto.unit = 'foreign';
    else if (n.fact.concept === FX_RATE_CONCEPT) dto.unit = 'rate';
    if (n.calculation) {
      dto.formula_ref = n.calculation.formula_ref;
      dto.steps = n.calculation.steps;
    }
    if (n.sources && n.sources.length > 0) {
      dto.sources = n.sources.map((x) => {
        const src = byId.get(x.source_id);
        return {
          source_id: x.source_id,
          type: x.type,
          title: src ? docTitle(src) : `${x.type} (${x.source_id})`,
        };
      });
    }
    return dto;
  };
  return build(node);
}
