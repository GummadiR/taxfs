/**
 * Entity returns + business filing (TaxOS P13, ported): each S-corp files
 * Form 1120-S and each partnership Form 1065, with per-member K-1s; the
 * entity kernel computes, the mapping does no math. Determinism is the
 * storage: packages REBUILD from confirmed facts on every read (same
 * principle as artifact regeneration) — a settings flag records that the
 * operator built them, nothing else persists.
 */
import { computeEntities } from '@taxfs/kernel';
import { buildEntityPackages, instantiateEntityForms, type EntityPackage } from '@taxfs/forms';
import type { TaxFact } from '@taxfs/shared';
import { withSpine, withUserClient } from './db';
import { filingContext, readSetting, writeSetting } from './filing';
import { releases } from './rules';
import { TAX_YEAR } from './env';

const BUILT_FLAG = 'biz.packages_built';

export interface EntityReturnDto {
  lines: { concept: string; value: string }[];
  error: string | null;
}

async function confirmedSourced(userId: string, ws: string): Promise<TaxFact[]> {
  return withSpine({ userId, workspaceId: ws }, async (spine) =>
    (await spine.getFacts({ taxpayer_id: ws, tax_year: TAX_YEAR }))
      .filter((f) => f.derivation === undefined && f.status === 'confirmed'));
}

export async function getEntityReturns(userId: string, ws: string): Promise<EntityReturnDto> {
  const filing = await withUserClient(userId, (client) => filingContext(client, ws));
  if (!filing) return { lines: [], error: null };
  const facts = await confirmedSourced(userId, ws);
  if (!facts.some((f) => f.concept.startsWith('entity.'))) return { lines: [], error: null };
  const rel = releases();
  try {
    const result = computeEntities({
      taxpayer_id: ws,
      tax_year: TAX_YEAR,
      ctx: filing,
      facts,
      fed_rules: rel.fedRules,
      il_rules: rel.ilRules,
    });
    return {
      lines: result.computedFacts.map((f) => ({ concept: f.concept, value: f.value.toString() })),
      error: null,
    };
  } catch (e) {
    return { lines: [], error: e instanceof Error ? e.message : String(e) };
  }
}

export interface BusinessFormDto {
  form_id: string;
  jurisdiction: string;
  artifact_id: string;
  member_id: string | null;
  real_pdf: boolean;
  lines: { line_id: string; label: string; value: string }[];
}

export interface BusinessEntityDto {
  entity_id: string;
  scorp: boolean;
  member_ids: string[];
  headline: { label: string; value: string }[];
  built: null | {
    clean: boolean;
    defects: { form_id: string; line_id: string; message: string }[];
    forms: BusinessFormDto[];
  };
}

export interface BusinessFilingDto {
  has_entities: boolean;
  error: string | null;
  entities: BusinessEntityDto[];
}

const ENTITY_HEADLINES: { suffix: string; label: (scorp: boolean) => string }[] = [
  { suffix: 'ordinary_income', label: (s) => `Ordinary business income (loss) — ${s ? '1120-S line 21' : '1065 line 22'}` },
  { suffix: 'k_total', label: () => 'Schedule K income reconciliation' },
  { suffix: 'il.base_income', label: (s) => `Illinois base income — ${s ? 'IL-1120-ST' : 'IL-1065'}` },
  { suffix: 'il.replacement_tax', label: () => 'Illinois replacement tax (1.5%)' },
];

/** Deterministic rebuild of every entity package from the current facts. */
export async function rebuildEntityPackages(userId: string, ws: string): Promise<EntityPackage[]> {
  const filing = await withUserClient(userId, (client) => filingContext(client, ws));
  if (!filing) throw new Error('complete Get Started first');
  const sourced = await confirmedSourced(userId, ws);
  const rel = releases();
  const derived = computeEntities({
    taxpayer_id: ws,
    tax_year: TAX_YEAR,
    ctx: filing,
    facts: sourced,
    fed_rules: rel.fedRules,
    il_rules: rel.ilRules,
  });
  return buildEntityPackages({
    tax_year: TAX_YEAR,
    facts: [...sourced, ...derived.computedFacts],
    release: rel.bizForms,
    pdf_templates: rel.pdfPlaceholderRelease,
    pdf_fill: { maps: rel.fieldMaps, templates: rel.pdfTemplates },
  });
}

export async function markPackagesBuilt(userId: string, ws: string): Promise<void> {
  await withUserClient(userId, (client) => writeSetting(client, ws, BUILT_FLAG, true));
}

export async function getBusinessFiling(userId: string, ws: string): Promise<BusinessFilingDto> {
  const filing = await withUserClient(userId, (client) => filingContext(client, ws));
  if (!filing) return { has_entities: false, error: null, entities: [] };
  const facts = await confirmedSourced(userId, ws);
  if (!facts.some((f) => f.concept.startsWith('entity.'))) {
    return { has_entities: false, error: null, entities: [] };
  }
  const rel = releases();
  let computed: Map<string, string>;
  try {
    const result = computeEntities({
      taxpayer_id: ws,
      tax_year: TAX_YEAR,
      ctx: filing,
      facts,
      fed_rules: rel.fedRules,
      il_rules: rel.ilRules,
    });
    computed = new Map(result.computedFacts.map((f) => [f.concept, f.value.toString()]));
  } catch (e) {
    return { has_entities: true, error: e instanceof Error ? e.message : String(e), entities: [] };
  }
  const wantBuilt = await withUserClient(userId, async (client) =>
    ((await readSetting(client, ws, BUILT_FLAG)) as boolean | undefined) === true);
  let packages: EntityPackage[] = [];
  if (wantBuilt) {
    try {
      packages = await rebuildEntityPackages(userId, ws);
    } catch {
      packages = [];
    }
  }
  const eids = [...new Set(
    facts
      .map((f) => /^entity\.([a-z0-9][a-z0-9_-]*)\./.exec(f.concept)?.[1])
      .filter((x): x is string => x !== undefined),
  )].sort();
  const builtByEntity = new Map(packages.map((p) => [p.entity_id, p]));
  const entities: BusinessEntityDto[] = eids.map((eid) => {
    const scorp = facts.some((f) => f.concept === `entity.${eid}.is_scorp` && !f.value.isZero());
    const memberIds = [...new Set(
      facts
        .map((f) => new RegExp(`^entity\\.${eid}\\.member\\.([a-z0-9][a-z0-9_-]*)\\.share$`).exec(f.concept)?.[1])
        .filter((x): x is string => x !== undefined),
    )].sort();
    const pkg = builtByEntity.get(eid);
    let built: BusinessEntityDto['built'] = null;
    if (pkg) {
      const defs = instantiateEntityForms(rel.bizForms, { eid, memberIds: pkg.member_ids, scorp: pkg.scorp });
      const labelOf = new Map(defs.flatMap((d) => d.lines.map((l) => [`${d.form_id}:${l.line_id}`, l.label] as const)));
      built = {
        clean: pkg.clean,
        defects: pkg.defects.map((d) => ({ form_id: d.form_id, line_id: d.line_id, message: d.message })),
        forms: pkg.instances.map((instance) => {
          const artifact = pkg.artifacts.find((a) => a.artifact_id === `pdf:${eid}:${instance.form_id}`);
          const memberSuffix = instance.form_id.split(':')[1];
          return {
            form_id: instance.form_id,
            jurisdiction: instance.jurisdiction,
            artifact_id: artifact?.artifact_id ?? '',
            member_id: memberSuffix ?? null,
            real_pdf: artifact?.content_type === 'application/pdf',
            lines: Object.entries(instance.values).map(([lineId, value]) => ({
              line_id: lineId,
              label: labelOf.get(`${instance.form_id}:${lineId}`) ?? lineId,
              value: value.toString(),
            })),
          };
        }),
      };
    }
    return {
      entity_id: eid,
      scorp,
      member_ids: memberIds,
      headline: ENTITY_HEADLINES.flatMap(({ suffix, label }) => {
        const v = computed.get(`entity.${eid}.${suffix}`);
        return v === undefined ? [] : [{ label: label(scorp), value: v }];
      }),
      built,
    };
  });
  return { has_entities: true, error: null, entities };
}
