/**
 * Add Data read model (TaxOS P14.3, ported): what the documents already
 * answered — so the page only asks for what no document carries
 * (confirm-before-count happened upstream). Titles come from the source
 * itself (P14.2 smart titles), never a storage id.
 */
import { C, type TaxFact, type SourceDoc } from '@taxfs/shared';
import { withSpine } from './db';
import { TAX_YEAR } from './env';

export interface DetectedK1Dto {
  k1_id: string;
  source_title: string | null;
  box1: string | null;
  is_scorp: string | null;
  capital_gain: string | null;
  guaranteed_payment: string | null;
  needs_basis: boolean;
  needs_participation: boolean;
}

export interface AddDataDto {
  k1s: DetectedK1Dto[];
  brokerage: { source_title: string; concepts: { concept: string; value: string }[] }[];
  ptc: { detected: boolean; source_title: string | null; needs_household_size: boolean };
  foreign: {
    detected: boolean; source_title: string | null; tax_foreign: string | null; needs_completion: boolean;
    doc_date: string | null; currency: string | null;
    has_income: boolean; has_ltcg: boolean; has_rate: boolean;
  };
  caploss: { st: string | null; lt: string | null; from_worksheet: boolean };
}

function titleOf(src: SourceDoc | undefined): string | null {
  if (!src) return null;
  const payer = src.fields['__payer'];
  if (payer && src.type !== 'USER_ENTRY') return `${src.type} — ${payer} (${src.tax_year})`;
  if (src.raw_ref.startsWith('manual://')) return `Manual entry (${src.source_id})`;
  if (src.raw_ref.startsWith('demo://')) return `${src.type} (demo)`;
  const fname = src.fields['__filename'];
  if (fname) return `${src.type} — ${fname}`;
  return `${src.type} (${src.source_id})`;
}

export async function getAddData(userId: string, ws: string): Promise<AddDataDto> {
  const { facts, sources } = await withSpine({ userId, workspaceId: ws }, async (spine) => ({
    facts: (await spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }))
      .filter((f) => f.derivation === undefined && f.status === 'confirmed'),
    sources: await spine.getSources(ws, TAX_YEAR),
  }));
  const sourceById = new Map(sources.map((x) => [x.source_id, x]));
  const titleOfFact = (f: TaxFact): string | null => {
    const sid = f.provenance?.[0]?.source_id;
    return sid ? titleOf(sourceById.get(sid)) : null;
  };
  const fromDocOfType = (f: TaxFact, docTypes: string[]): boolean => {
    const sid = f.provenance?.[0]?.source_id;
    const src = sid ? sourceById.get(sid) : undefined;
    return src !== undefined && docTypes.includes(src.type);
  };

  // K-1s: a K-1 that arrived by document prefills its card — only
  // basis/participation (the recipient's own facts) remain.
  const k1Ids = [...new Set(
    facts.map((f) => /^k1\.([a-z0-9][a-z0-9_-]*)\./.exec(f.concept)?.[1]).filter((x): x is string => x !== undefined),
  )].sort();
  const k1s: DetectedK1Dto[] = k1Ids.map((id) => {
    const get = (suffix: string): TaxFact | undefined => facts.find((f) => f.concept === `k1.${id}.${suffix}`);
    const box1 = get('box1');
    return {
      k1_id: id,
      source_title: box1 ? titleOfFact(box1) : null,
      box1: box1?.value.toString() ?? null,
      is_scorp: get('is_scorp')?.value.toString() ?? null,
      capital_gain: get('capital_gain')?.value.toString() ?? null,
      guaranteed_payment: get('guaranteed_payment')?.value.toString() ?? null,
      needs_basis: get('basis_opening') === undefined,
      needs_participation: get('material_participation') === undefined,
    };
  }).filter((k) => k.needs_basis || k.needs_participation);

  const brokerageConcepts: string[] = [C.INTEREST, C.DIV_ORDINARY, C.DIV_QUALIFIED, C.CAPITAL_GAIN_NET];
  const byTitle = new Map<string, { concept: string; value: string }[]>();
  for (const f of facts) {
    if (!brokerageConcepts.includes(f.concept)) continue;
    if (!fromDocOfType(f, ['1099-INT', '1099-DIV', '1099-B', 'CONSOLIDATED-1099'])) continue;
    const title = titleOfFact(f) ?? 'uploaded document';
    byTitle.set(title, [...(byTitle.get(title) ?? []), { concept: f.concept, value: f.value.toString() }]);
  }

  const premium = facts.find((f) => f.concept === C.PTC_PREMIUM);
  const householdSize = facts.some((f) => f.concept === 'ptc.household_size');
  const foreignTds = facts.find((f) => f.concept === C.FOREIGN_TAX_FCY);
  const remitSrc = sources.find((x) => x.type === 'FOREIGN-REMITTANCE');
  const hasFxRate = facts.some((f) => f.concept === C.FOREIGN_FX_RATE);
  const hasForeignIncome = facts.some((f) => f.concept === C.FOREIGN_INCOME || f.concept === C.FOREIGN_INCOME_FCY);
  const hasLtcg = facts.some((f) => f.concept === 'foreign.income.passive.ltcg.foreign_currency');
  // P86 — surface what is ALREADY saved for the capital-loss carryover.
  const stFact = facts.find((f) => f.concept === C.CAPLOSS_CO_ST_PRIOR);
  const ltFact = facts.find((f) => f.concept === C.CAPLOSS_CO_LT_PRIOR);
  const fromWorksheet = [stFact, ltFact].some(
    (f) => f?.provenance?.[0]?.source_id.startsWith('worksheet-caploss-') === true,
  );

  return {
    k1s,
    caploss: {
      st: stFact?.value.toString() ?? null,
      lt: ltFact?.value.toString() ?? null,
      from_worksheet: fromWorksheet,
    },
    brokerage: [...byTitle.entries()].map(([source_title, concepts]) => ({ source_title, concepts })),
    ptc: {
      detected: premium !== undefined,
      source_title: premium ? titleOfFact(premium) : null,
      needs_household_size: premium !== undefined && !householdSize,
    },
    foreign: {
      detected: foreignTds !== undefined,
      source_title: foreignTds ? titleOfFact(foreignTds) : null,
      tax_foreign: foreignTds?.value.toString() ?? null,
      needs_completion: foreignTds !== undefined && (!hasFxRate || !hasForeignIncome),
      doc_date: remitSrc?.fields['remittance_date'] ?? null,
      currency: remitSrc?.fields['currency_code'] ?? null,
      has_income: hasForeignIncome,
      has_ltcg: hasLtcg,
      has_rate: hasFxRate,
    },
  };
}
